import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { registerMethod } from "./json-rpc-server";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 10_000;

let shellWindow: BrowserWindow | null = null;

function sendToShell(
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!shellWindow || shellWindow.isDestroyed()) {
    return Promise.reject(new Error("Shell window not available"));
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`canvas RPC timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });

    shellWindow!.webContents.send("canvas:rpc-request", {
      requestId,
      method,
      params,
    });
  });
}

export function registerCanvasRpc(win: BrowserWindow): void {
  shellWindow = win;

  ipcMain.on(
    "canvas:rpc-response",
    (_event, response: {
      requestId: string;
      result?: unknown;
      error?: { code: number; message: string };
    }) => {
      const entry = pending.get(response.requestId);
      if (!entry) return;

      pending.delete(response.requestId);
      clearTimeout(entry.timer);

      if (response.error) {
        entry.reject(new Error(response.error.message));
      } else {
        entry.resolve(response.result);
      }
    },
  );

  registerMethod(
    "canvas.tileList",
    (params) => sendToShell("tileList", params),
    {
      description: "List all canvas tiles with positions",
      params: {},
    },
  );

  registerMethod(
    "canvas.tileAdd",
    (params) => sendToShell("tileAdd", params),
    {
      description: "Create a new tile on the canvas",
      params: {
        type: "Tile type: note, code, image, graph, term (alias: tileType)",
        filePath: "(optional) Absolute path to file",
        folderPath: "(optional) Absolute path to folder",
        position: "(optional) {x, y} canvas coordinates",
        size: "(optional) {width, height} in pixels",
      },
    },
  );

  registerMethod(
    "canvas.tileRemove",
    (params) => sendToShell("tileRemove", params),
    {
      description: "Remove a tile from the canvas",
      params: { tileId: "ID of the tile to remove" },
    },
  );

  registerMethod(
    "canvas.tileMove",
    (params) => sendToShell("tileMove", params),
    {
      description: "Move a tile to a new position",
      params: {
        tileId: "ID of the tile to move",
        position: "{x, y} canvas coordinates",
      },
    },
  );

  registerMethod(
    "canvas.tileResize",
    (params) => sendToShell("tileResize", params),
    {
      description: "Resize a tile",
      params: {
        tileId: "ID of the tile to resize",
        size: "{width, height} in pixels",
      },
    },
  );

  registerMethod(
    "canvas.viewportGet",
    (params) => sendToShell("viewportGet", params),
    {
      description: "Get current canvas viewport (pan and zoom)",
      params: {},
    },
  );

  registerMethod(
    "canvas.viewportSet",
    (params) => sendToShell("viewportSet", params),
    {
      description: "Set canvas viewport pan and zoom",
      params: {
        x: "Viewport x offset",
        y: "Viewport y offset",
        zoom: "Zoom level (1 = 100%)",
      },
    },
  );
}
