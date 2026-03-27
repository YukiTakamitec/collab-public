#!/usr/bin/env node
/**
 * collab — Collaborator CLI
 *
 * Universal CLI matching the collab-canvas SKILL.md specification.
 * Auto-detects transport: Windows named pipe / WSL TCP / Unix socket.
 *
 * Exit codes: 0=success, 1=RPC error, 2=connection failure
 */

const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ── Platform detection ──

const isWin = process.platform === "win32";
const isWSL = process.platform === "linux" && (() => {
  try { return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); }
  catch { return false; }
})();

const PIPE = "\\\\.\\pipe\\collaborator-ipc";
const TCP_PORT = 7823;
const SOCKET_PATH = path.join(os.homedir(), ".collaborator", "ipc.sock");

// ── Transport ──

function getWindowsHostIP() {
  try {
    const { execSync } = require("child_process");
    const route = execSync("ip route show default 2>/dev/null", { encoding: "utf-8" });
    const match = route.match(/via\s+([\d.]+)/);
    if (match) return match[1];
  } catch {}
  return "172.23.0.1";
}

function connect() {
  if (isWin) return net.createConnection(PIPE);
  if (isWSL) return net.createConnection({ host: getWindowsHostIP(), port: TCP_PORT });
  // macOS/Linux: socket first, TCP fallback
  if (fs.existsSync(SOCKET_PATH)) return net.createConnection(SOCKET_PATH);
  return net.createConnection({ host: "127.0.0.1", port: TCP_PORT });
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      ...(params !== undefined ? { params } : {}),
    }) + "\n";

    const client = connect();
    client.on("connect", () => client.write(request));

    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          if (resp.error) reject(new Error(resp.error.message || "RPC error"));
          else resolve(resp.result);
        } catch { reject(new Error("Invalid JSON response")); }
        client.end();
      }
    });

    client.on("error", (err) => {
      const transport = isWin ? "named pipe" : isWSL ? `TCP ${getWindowsHostIP()}:${TCP_PORT}` : "socket";
      reject(new Error(
        `Cannot connect to Collaborator (${transport}). Is the app running? [${err.message}]`
      ));
    });

    client.setTimeout(10000, () => {
      client.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

// ── Path conversion (WSL → Windows) ──

function toNativePath(p) {
  if (!p) return p;
  const resolved = path.resolve(p);
  if (!isWSL) return resolved;
  const match = resolved.match(/^\/mnt\/([a-z])\/(.*)/);
  if (match) return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
  return resolved;
}

// ── Argument parsing ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseCoords(str) {
  if (!str) return null;
  const parts = str.split(",").map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  return parts;
}

function inferType(filePath) {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".graph.json")) return "graph";
  const ext = path.extname(lower).slice(1);
  if (["md", "txt", "mdx", "markdown"].includes(ext)) return "note";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return "code";
}

// ── Tile commands ──

async function tileList() {
  const result = await rpc("canvas.tileList");
  console.log(JSON.stringify(result, null, 2));
}

async function tileAdd(pos, flags) {
  let type = pos[0];
  const filePath = flags.file;

  if (!type && filePath) type = inferType(filePath);
  if (!type) {
    console.error("Usage: collab tile add <type> [--file <path>] [--pos x,y] [--size w,h]");
    process.exit(1);
  }

  const params = { type };
  if (filePath) params.filePath = toNativePath(filePath);
  if (flags.pos) {
    const c = parseCoords(flags.pos);
    if (!c) { console.error("Invalid --pos. Use: x,y"); process.exit(1); }
    params.position = { x: c[0], y: c[1] };
  }
  if (flags.size) {
    const c = parseCoords(flags.size);
    if (!c) { console.error("Invalid --size. Use: w,h"); process.exit(1); }
    params.size = { width: c[0], height: c[1] };
  }

  const result = await rpc("canvas.tileAdd", params);
  console.log(result && result.tileId ? result.tileId : JSON.stringify(result, null, 2));
}

async function tileRm(pos) {
  const tileId = pos[0];
  if (!tileId) { console.error("Usage: collab tile rm <id>"); process.exit(1); }
  await rpc("canvas.tileRemove", { tileId });
}

async function tileMove(pos, flags) {
  const tileId = pos[0];
  if (!tileId || !flags.pos) { console.error("Usage: collab tile move <id> --pos x,y"); process.exit(1); }
  const c = parseCoords(flags.pos);
  if (!c) { console.error("Invalid --pos. Use: x,y"); process.exit(1); }
  await rpc("canvas.tileMove", { tileId, position: { x: c[0], y: c[1] } });
}

async function tileResize(pos, flags) {
  const tileId = pos[0];
  if (!tileId || !flags.size) { console.error("Usage: collab tile resize <id> --size w,h"); process.exit(1); }
  const c = parseCoords(flags.size);
  if (!c) { console.error("Invalid --size. Use: w,h"); process.exit(1); }
  await rpc("canvas.tileResize", { tileId, size: { width: c[0], height: c[1] } });
}

// ── Viewport commands ──

async function viewportGet() {
  const result = await rpc("canvas.viewportGet");
  console.log(JSON.stringify(result, null, 2));
}

async function viewportSet(flags) {
  const params = {};
  if (flags.pan) {
    const c = parseCoords(flags.pan);
    if (!c) { console.error("Invalid --pan. Use: x,y"); process.exit(1); }
    params.x = c[0]; params.y = c[1];
  }
  if (flags.zoom) {
    params.zoom = parseFloat(flags.zoom);
    if (isNaN(params.zoom)) { console.error("Invalid --zoom"); process.exit(1); }
  }
  await rpc("canvas.viewportSet", params);
}

// ── PTY commands ──

async function ptyList() {
  const result = await rpc("pty.list");
  if (result && result.sessions) {
    result.sessions.forEach((s, i) => {
      const fg = s.foreground || "?";
      const tile = s.tileId || "no-tile";
      console.log(`  [${i + 1}] ${s.sessionId}  ${tile}  (${fg})`);
    });
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function ptyCreate(flags) {
  const params = {};
  if (flags.cwd) params.cwd = toNativePath(flags.cwd);
  const result = await rpc("pty.create", params);
  console.log(result && result.sessionId ? result.sessionId : JSON.stringify(result, null, 2));
}

function unescapeData(s) {
  return s
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, "\\");
}

async function ptyWrite(pos) {
  const sessionId = pos[0];
  const raw = pos.slice(1).join(" ");
  if (!sessionId || !raw) { console.error("Usage: collab pty write <sessionId> <data>"); process.exit(1); }
  await rpc("pty.write", { sessionId, data: unescapeData(raw) });
}

async function ptyRead(pos, flags) {
  const sessionId = pos[0];
  if (!sessionId) { console.error("Usage: collab pty read <sessionId> [--lines n]"); process.exit(1); }
  const lines = flags.lines ? parseInt(flags.lines) : 50;
  const result = await rpc("pty.read", { sessionId, lines });
  if (result && result.output !== undefined) {
    const clean = result.output
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[>=]/g, "")
      .replace(/[\x00-\x08\x0e-\x1f]/g, "");
    console.log(clean);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function ptyKill(pos) {
  const sessionId = pos[0];
  if (!sessionId) { console.error("Usage: collab pty kill <sessionId>"); process.exit(1); }
  await rpc("pty.kill", { sessionId });
}

// ── Help ──

function printHelp() {
  console.log(`collab - Collaborator CLI

Usage: collab <command> [args] [--flags]

Canvas tiles:
  tile list                                         List all tiles
  tile add <type> [--file p] [--pos x,y] [--size w,h]  Add a tile
  tile rm <id>                                      Remove a tile
  tile move <id> --pos x,y                          Move a tile
  tile resize <id> --size w,h                       Resize a tile

Viewport:
  viewport                                          Get viewport state
  viewport set [--pan x,y] [--zoom level]           Set viewport

Terminal sessions:
  pty list                                          List sessions
  pty create [--cwd path]                           Create session
  pty write <sid> <data>                            Write to session
  pty read <sid> [--lines n]                        Read output
  pty kill <sid>                                    Kill session

Other:
  ping                                              Health check
  help                                              Show this help

Tile types: term, note, code, image, graph
Exit codes: 0 = success, 1 = RPC error, 2 = connection failure`);
}

// ── Main ──

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  const group = positional[0];
  const cmd = positional[1];

  if (!group || group === "help" || flags.help) { printHelp(); return; }

  try {
    switch (group) {
      case "tile":
        switch (cmd) {
          case "list":   return await tileList();
          case "add":    return await tileAdd(positional.slice(2), flags);
          case "rm":     return await tileRm(positional.slice(2));
          case "move":   return await tileMove(positional.slice(2), flags);
          case "resize": return await tileResize(positional.slice(2), flags);
          default:
            console.error(cmd ? `Unknown tile command: ${cmd}` : "Missing tile subcommand");
            console.error("Available: list, add, rm, move, resize");
            process.exit(1);
        }
        break;
      case "viewport":
        if (cmd === "set") return await viewportSet(flags);
        return await viewportGet();
      case "pty":
        switch (cmd) {
          case "list":   return await ptyList();
          case "create": return await ptyCreate(flags);
          case "write":  return await ptyWrite(positional.slice(2));
          case "read":   return await ptyRead(positional.slice(2), flags);
          case "kill":   return await ptyKill(positional.slice(2));
          default:
            console.error(cmd ? `Unknown pty command: ${cmd}` : "Missing pty subcommand");
            console.error("Available: list, create, write, read, kill");
            process.exit(1);
        }
        break;
      case "ping":
        console.log(JSON.stringify(await rpc("ping")));
        break;
      default:
        console.error(`Unknown command: ${group}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    const isConn = /connect|timeout|ECONNREFUSED|ENOENT|EPIPE/i.test(err.message);
    process.exit(isConn ? 2 : 1);
  }
}

main();
