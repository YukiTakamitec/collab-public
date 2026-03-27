#!/usr/bin/env node
/**
 * Collaborator MCP Server
 *
 * Exposes Collaborator's terminal orchestration and canvas management
 * as MCP tools, allowing Claude to autonomously control terminals.
 *
 * Transport: stdio (JSON-RPC 2.0 over stdin/stdout)
 * Connection: Windows named pipe \\.\pipe\collaborator-ipc
 */

const net = require("net");
const readline = require("readline");

const PIPE = "\\\\.\\pipe\\collaborator-ipc";
const TCP_PORT = 7823;
const SERVER_NAME = "collaborator";
const SERVER_VERSION = "1.0.0";

// Detect if running under WSL (Linux but with Windows interop)
const isWSL = process.platform === "linux";

// Get Windows host IP from WSL (gateway of default route)
function getWindowsHostIP() {
  try {
    const { execSync } = require("child_process");
    const route = execSync("ip route show default 2>/dev/null", { encoding: "utf-8" });
    const match = route.match(/via\s+([\d.]+)/);
    if (match) return match[1];
  } catch {}
  return "172.23.0.1"; // fallback
}

const TCP_HOST = isWSL ? getWindowsHostIP() : "127.0.0.1";

// ── Collaborator RPC helper ──

function connectToCollaborator() {
  if (isWSL) {
    // WSL: use TCP since named pipes aren't accessible from Linux
    return net.createConnection({ host: TCP_HOST, port: TCP_PORT });
  }
  // Windows: use named pipe
  return net.createConnection(PIPE);
}

function collabRpc(method, params) {
  return new Promise((resolve, reject) => {
    const request =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params ? { params } : {}),
      }) + "\n";

    const client = connectToCollaborator();
    client.on("connect", () => client.write(request));
    let buf = "";

    client.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          if (resp.error) {
            reject(new Error(resp.error.message || "RPC error"));
          } else {
            resolve(resp.result);
          }
        } catch (e) {
          reject(new Error("Invalid JSON response"));
        }
        client.end();
      }
    });

    client.on("error", (err) => {
      const transport = isWSL ? `TCP ${TCP_HOST}:${TCP_PORT}` : `pipe ${PIPE}`;
      reject(
        new Error(
          `Cannot connect to Collaborator via ${transport} (${err.message}). Is the app running?`
        )
      );
    });

    client.setTimeout(10000, () => {
      client.destroy();
      reject(new Error("Collaborator RPC timeout"));
    });
  });
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: "collab_pty_list",
    description:
      "List all active terminal sessions in Collaborator with their tile mappings. Returns sessionId, foreground process, and tileId for each terminal.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "collab_pty_write",
    description:
      'Send keystrokes or a command to a specific terminal session. Use \\r\\n at the end to execute. Example: "dir\\r\\n" sends the dir command and presses Enter.',
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The terminal session ID (from collab_pty_list)",
        },
        data: {
          type: "string",
          description:
            'The text/command to send. Append \\r\\n to execute. Example: "npm install\\r\\n"',
        },
      },
      required: ["sessionId", "data"],
    },
  },
  {
    name: "collab_pty_create",
    description:
      "Create a new terminal session (PTY) without a canvas tile. Returns the new sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Working directory for the new terminal (optional, defaults to user home)",
        },
      },
      required: [],
    },
  },
  {
    name: "collab_pty_kill",
    description: "Kill/terminate a terminal session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The terminal session ID to kill",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "collab_tile_list",
    description:
      "List all tiles on the Collaborator canvas. Returns id, type, position, size, and ptySessionId for terminal tiles.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "collab_tile_add",
    description:
      'Add a new tile to the canvas. Supports types: "term" (terminal), "note", "code", "graph".',
    inputSchema: {
      type: "object",
      properties: {
        tileType: {
          type: "string",
          enum: ["term", "note", "code", "graph"],
          description: "Type of tile to create",
        },
        filePath: {
          type: "string",
          description: "File path for note/code tiles (optional)",
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          description: "Canvas position (optional, auto-placed if omitted)",
        },
      },
      required: ["tileType"],
    },
  },
  {
    name: "collab_tile_remove",
    description: "Remove a tile from the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        tileId: {
          type: "string",
          description: "The tile ID to remove",
        },
      },
      required: ["tileId"],
    },
  },
  {
    name: "collab_pty_read",
    description:
      "Read recent output from a terminal session. Returns the last N lines of terminal output. Useful to check command results.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The terminal session ID",
        },
        lines: {
          type: "number",
          description: "Number of recent lines to read (default: 50)",
        },
      },
      required: ["sessionId"],
    },
  },
];

// ── Tool handlers ──

// LLMs often send escape sequences as literal text (e.g. "\\r\\n" instead of CR+LF).
// Unescape them so the terminal receives actual control characters.
function unescapeData(s) {
  if (!s) return s;
  return s
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, "\\");
}

async function handleToolCall(name, args) {
  switch (name) {
    case "collab_pty_list": {
      const result = await collabRpc("pty.list");
      return JSON.stringify(result, null, 2);
    }

    case "collab_pty_write": {
      const result = await collabRpc("pty.write", {
        sessionId: args.sessionId,
        data: unescapeData(args.data),
      });
      return JSON.stringify(result);
    }

    case "collab_pty_create": {
      const result = await collabRpc("pty.create", {
        cwd: args.cwd,
      });
      return JSON.stringify(result, null, 2);
    }

    case "collab_pty_kill": {
      const result = await collabRpc("pty.kill", {
        sessionId: args.sessionId,
      });
      return JSON.stringify(result);
    }

    case "collab_tile_list": {
      const result = await collabRpc("canvas.tileList");
      return JSON.stringify(result, null, 2);
    }

    case "collab_tile_add": {
      const params = { tileType: args.tileType };
      if (args.filePath) params.filePath = args.filePath;
      if (args.position) params.position = args.position;
      const result = await collabRpc("canvas.tileAdd", params);
      return JSON.stringify(result, null, 2);
    }

    case "collab_tile_remove": {
      const result = await collabRpc("canvas.tileRemove", {
        tileId: args.tileId,
      });
      return JSON.stringify(result);
    }

    case "collab_pty_read": {
      const result = await collabRpc("pty.read", {
        sessionId: args.sessionId,
        lines: args.lines || 50,
      });
      // Strip ANSI escape codes for cleaner LLM consumption
      if (result && result.output) {
        result.output = result.output
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[>=]/g, "")
          .replace(/[\x00-\x08\x0e-\x1f]/g, "");
      }
      return JSON.stringify(result, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Protocol (stdio JSON-RPC 2.0) ──

let initialized = false;

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id, code, message) {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(msg + "\n");
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(msg + "\n");
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      initialized = true;
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      break;
    }

    case "notifications/initialized": {
      // Client acknowledged initialization — no response needed
      break;
    }

    case "tools/list": {
      sendResponse(id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const toolName = params.name;
      const toolArgs = params.arguments || {};
      try {
        const text = await handleToolCall(toolName, toolArgs);
        sendResponse(id, {
          content: [{ type: "text", text }],
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }

    case "ping": {
      sendResponse(id, {});
      break;
    }

    default: {
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    }
  }
}

// ── Main: read JSON-RPC messages from stdin ──

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleMessage(msg).catch((err) => {
      if (msg.id !== undefined) {
        sendError(msg.id, -32603, err.message);
      }
    });
  } catch {
    // Ignore parse errors on stdin
  }
});

rl.on("close", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
