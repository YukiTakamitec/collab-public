// src/main/sidecar/protocol.ts
import { join } from "node:path";
import { COLLAB_DIR } from "../paths";

export const SIDECAR_VERSION = 1;

export const SIDECAR_SOCKET_PATH = join(COLLAB_DIR, "pty-sidecar.sock");
export const SIDECAR_PID_PATH = join(COLLAB_DIR, "pty-sidecar.pid");
export const SESSION_SOCKET_DIR = join(COLLAB_DIR, "pty-sessions");

export function sessionSocketPath(sessionId: string): string {
  return join(SESSION_SOCKET_DIR, `${sessionId}.sock`);
}

// Ring buffer default: 8 MB per session
export const DEFAULT_RING_BUFFER_BYTES = 8 * 1024 * 1024;

// Idle timeout: 30 minutes with no sessions and no clients
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// JSON-RPC 2.0 types
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export function makeRequest(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): string {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  return JSON.stringify(msg) + "\n";
}

export function makeResponse(id: number, result: unknown): string {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return JSON.stringify(msg) + "\n";
}

export function makeError(
  id: number,
  code: number,
  message: string,
): string {
  const msg: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  return JSON.stringify(msg) + "\n";
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown>,
): string {
  const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
  return JSON.stringify(msg) + "\n";
}

// PID file format
export interface PidFileData {
  pid: number;
  token: string;
  version: number;
}

// session.create params/result
export interface SessionCreateParams {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface SessionCreateResult {
  sessionId: string;
  socketPath: string;
}

// session.reconnect params/result
export interface SessionReconnectParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface SessionReconnectResult {
  sessionId: string;
  socketPath: string;
}

// session.list result
export interface SessionInfo {
  sessionId: string;
  shell: string;
  cwd: string;
  pid: number;
  createdAt: string;
}

// sidecar.ping result
export interface PingResult {
  pid: number;
  uptime: number;
  version: number;
  token: string;
}
