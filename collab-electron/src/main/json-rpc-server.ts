import { createServer, type Server, type Socket } from "node:net";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COLLAB_DIR } from "./paths";

const isWin = process.platform === "win32";
// On Windows, use a named pipe; on Unix, use a domain socket.
const SOCKET_PATH = isWin
  ? "\\\\.\\pipe\\collaborator-ipc"
  : join(COLLAB_DIR, "ipc.sock");
// Write the breadcrumb to the base directory (~/.collaborator/)
// so the hook script can discover the socket regardless of
// whether the app is running in dev or prod mode.
const BASE_DIR = join(homedir(), ".collaborator");
const SOCKET_PATH_FILE = join(BASE_DIR, "socket-path");

type MethodHandler = (
  params: unknown,
) => unknown | Promise<unknown>;

interface MethodEntry {
  handler: MethodHandler;
  description: string;
  params?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const methods = new Map<string, MethodEntry>();

function discoverMethods(): {
  name: string;
  description: string;
  params?: Record<string, string>;
}[] {
  return [...methods.entries()].map(([name, entry]) => ({
    name,
    description: entry.description,
    ...(entry.params ? { params: entry.params } : {}),
  }));
}
const TCP_PORT = 7823; // TCP listener for WSL/cross-platform access
let server: Server | null = null;
let tcpServer: Server | null = null;
const connections = new Set<Socket>();

function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    rec.jsonrpc === "2.0" &&
    (typeof rec.id === "number" || typeof rec.id === "string") &&
    typeof rec.method === "string"
  );
}

function makeErrorResponse(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(
  raw: string,
): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return makeErrorResponse(null, -32700, "Parse error");
  }

  if (!isJsonRpcRequest(parsed)) {
    return makeErrorResponse(null, -32600, "Invalid request");
  }

  const entry = methods.get(parsed.method);
  const handler = entry?.handler;
  if (!handler) {
    return makeErrorResponse(
      parsed.id,
      -32601,
      `Method not found: ${parsed.method}`,
    );
  }

  try {
    const result = await handler(parsed.params);
    return { jsonrpc: "2.0", id: parsed.id, result };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return makeErrorResponse(parsed.id, -32000, message);
  }
}

function handleConnection(socket: Socket): void {
  connections.add(socket);
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        void handleMessage(line).then((response) => {
          if (response && !socket.destroyed) {
            socket.write(JSON.stringify(response) + "\n");
          }
        });
      }

      newlineIdx = buffer.indexOf("\n");
    }
  });

  socket.on("close", () => {
    connections.delete(socket);
  });

  socket.on("error", (err) => {
    console.error("[json-rpc] Socket error:", err.message);
    connections.delete(socket);
  });
}

function cleanupStaleSocket(): void {
  // Named pipes on Windows are managed by the OS; no file to unlink.
  if (isWin) return;
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // Socket file already gone
    }
  }
}

export function registerMethod(
  method: string,
  handler: MethodHandler,
  meta?: { description?: string; params?: Record<string, string> },
): void {
  methods.set(method, {
    handler,
    description: meta?.description ?? "",
    params: meta?.params,
  });
}

export function startJsonRpcServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(COLLAB_DIR, { recursive: true });
    cleanupStaleSocket();

    server = createServer(handleConnection);

    server.on("error", (err) => {
      console.error("[json-rpc] Server error:", err.message);
      reject(err);
    });

    registerMethod(
      "rpc.discover",
      () => ({ methods: discoverMethods() }),
      { description: "List all available RPC methods" },
    );

    server.listen(SOCKET_PATH, () => {
      writeFileSync(SOCKET_PATH_FILE, SOCKET_PATH, "utf-8");
      console.log(
        `[json-rpc] Listening on ${SOCKET_PATH}`,
      );

      // Also start TCP listener for WSL access
      tcpServer = createServer(handleConnection);
      tcpServer.on("error", (err) => {
        console.warn(
          `[json-rpc] TCP server on port ${TCP_PORT} failed:`,
          err.message,
        );
        // Non-fatal — named pipe still works
      });
      tcpServer.listen(TCP_PORT, "0.0.0.0", () => {
        console.log(
          `[json-rpc] TCP listening on 127.0.0.1:${TCP_PORT}`,
        );
      });

      resolve();
    });
  });
}

export function stopJsonRpcServer(): void {
  for (const socket of connections) {
    socket.destroy();
  }
  connections.clear();

  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
  }

  if (server) {
    server.close();
    server = null;
  }

  cleanupStaleSocket();

  try {
    unlinkSync(SOCKET_PATH_FILE);
  } catch {
    // File already gone
  }
}
