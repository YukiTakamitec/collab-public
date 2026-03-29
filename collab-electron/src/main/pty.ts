import * as pty from "node-pty";
import * as os from "os";
import * as fs from "node:fs";
import * as crypto from "crypto";
import { type IDisposable } from "node-pty";
import {
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./tmux";

const isWin = process.platform === "win32";

// On Unix, tmux is used for session persistence. On Windows, we spawn
// shells directly via node-pty (no tmux).
let tmuxModule: typeof import("./tmux") | null = null;
if (!isWin) {
  tmuxModule = require("./tmux");
}

interface PtySession {
  pty: pty.IPty;
  shell: string;
  disposables: IDisposable[];
}

const sessions = new Map<string, PtySession>();

// Ring buffer for recent terminal output (per session)
const MAX_SCROLLBACK = 100_000; // characters
const scrollbackBuffers = new Map<string, string>();

function appendScrollback(sessionId: string, data: string): void {
  const existing = scrollbackBuffers.get(sessionId) || "";
  let combined = existing + data;
  if (combined.length > MAX_SCROLLBACK) {
    combined = combined.slice(combined.length - MAX_SCROLLBACK);
  }
  scrollbackBuffers.set(sessionId, combined);
}
let shuttingDown = false;

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

function getWebContents(): typeof import("electron").webContents | null {
  try {
    return require("electron").webContents;
  } catch {
    return null;
  }
}

function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (senderWebContentsId == null) return;
  const wc = getWebContents();
  if (!wc) return;
  const sender = wc.fromId(senderWebContentsId);
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const { BrowserWindow } = require("electron");
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function getDefaultShell(): string {
  if (isWin) {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function getShellArgs(): string[] {
  if (isWin) {
    const shell = getDefaultShell().toLowerCase();
    if (shell.includes("powershell") || shell.includes("pwsh")) {
      return ["-NoLogo"];
    }
    return [];
  }
  return [];
}

// ---------- Windows: direct node-pty ----------

function createSessionWin(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
  initialCommand?: string,
): { sessionId: string; shell: string } {
  const sessionId = crypto.randomBytes(8).toString("hex");
  const shell = getDefaultShell();
  const resolvedCwd = cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  const ptyProcess = pty.spawn(shell, getShellArgs(), {
    name: "xterm-256color",
    cols: c,
    rows: r,
    cwd: resolvedCwd,
    env: { ...process.env } as Record<string, string>,
  });

  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      appendScrollback(sessionId, data);
      sendToSender(
        senderWebContentsId,
        "pty:data",
        { sessionId, data },
      );
      scheduleForegroundCheck(sessionId);
    }),
  );

  disposables.push(
    ptyProcess.onExit(() => {
      if (shuttingDown) {
        sessions.delete(sessionId);
        return;
      }
      deleteSessionMeta(sessionId);
      sendToSender(
        senderWebContentsId,
        "pty:exit",
        { sessionId, exitCode: 0 },
      );
      sendToMainWindow("pty:exit", { sessionId, exitCode: 0 });
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, { pty: ptyProcess, shell, disposables });

  writeSessionMeta(sessionId, {
    shell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
  });

  // Send initial command after shell is ready
  if (initialCommand) {
    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s) {
        s.pty.write(initialCommand + "\r");
      }
    }, 1500);
  }

  return { sessionId, shell };
}

function reconnectSessionWin(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  const existing = sessions.get(sessionId);
  if (!existing) {
    // Session no longer exists (Windows has no tmux persistence).
    // Create a fresh session instead.
    const meta = readSessionMeta(sessionId);
    deleteSessionMeta(sessionId);
    const fresh = createSessionWin(
      meta?.cwd, senderWebContentsId, cols, rows,
    );
    return {
      sessionId: fresh.sessionId,
      shell: fresh.shell,
      meta,
      scrollback: "",
    };
  }

  // Re-attach data listener to new sender
  for (const d of existing.disposables) d.dispose();
  const disposables: IDisposable[] = [];

  disposables.push(
    existing.pty.onData((data: string) => {
      appendScrollback(sessionId, data);
      sendToSender(
        senderWebContentsId,
        "pty:data",
        { sessionId, data },
      );
      scheduleForegroundCheck(sessionId);
    }),
  );

  disposables.push(
    existing.pty.onExit(() => {
      if (shuttingDown) {
        sessions.delete(sessionId);
        return;
      }
      deleteSessionMeta(sessionId);
      sendToSender(
        senderWebContentsId,
        "pty:exit",
        { sessionId, exitCode: 0 },
      );
      sendToMainWindow("pty:exit", { sessionId, exitCode: 0 });
      sessions.delete(sessionId);
    }),
  );

  existing.disposables = disposables;
  existing.pty.resize(cols, rows);

  const meta = readSessionMeta(sessionId);
  return {
    sessionId,
    shell: existing.shell,
    meta,
    scrollback: "",
  };
}

// ---------- Unix: tmux-backed (original logic) ----------

function utf8Env(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }
  if (tmuxModule) {
    const terminfoDir = tmuxModule.getTerminfoDir();
    if (terminfoDir) {
      env.TERMINFO = terminfoDir;
    }
  }
  return env;
}

function attachClient(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId?: number,
): pty.IPty {
  const tmux = tmuxModule!;
  const tmuxBin = tmux.getTmuxBin();
  const name = tmux.tmuxSessionName(sessionId);

  const ptyProcess = pty.spawn(
    tmuxBin,
    ["-L", tmux.getSocketName(), "-u", "attach-session", "-t", name],
    { name: "xterm-256color", cols, rows, env: utf8Env() },
  );

  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      appendScrollback(sessionId, data);
      sendToSender(
        senderWebContentsId,
        "pty:data",
        { sessionId, data },
      );
      scheduleForegroundCheck(sessionId);
    }),
  );

  disposables.push(
    ptyProcess.onExit(() => {
      if (shuttingDown) {
        sessions.delete(sessionId);
        return;
      }
      try {
        tmux.tmuxExec("has-session", "-t", name);
      } catch {
        deleteSessionMeta(sessionId);
        sendToSender(
          senderWebContentsId,
          "pty:exit",
          { sessionId, exitCode: 0 },
        );
        sendToMainWindow("pty:exit", { sessionId, exitCode: 0 });
      }
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, {
    pty: ptyProcess,
    shell: "",
    disposables,
  });

  return ptyProcess;
}

function createSessionUnix(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
): { sessionId: string; shell: string } {
  const tmux = tmuxModule!;
  const sessionId = crypto.randomBytes(8).toString("hex");
  const shell = process.env.SHELL || "/bin/zsh";
  const name = tmux.tmuxSessionName(sessionId);
  const resolvedCwd = cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  tmux.tmuxExec(
    "new-session", "-d",
    "-s", name,
    "-c", resolvedCwd,
    "-x", String(c),
    "-y", String(r),
  );

  tmux.tmuxExec(
    "set-environment", "-t", name,
    "COLLAB_PTY_SESSION_ID", sessionId,
  );
  tmux.tmuxExec(
    "set-environment", "-t", name,
    "SHELL", shell,
  );

  writeSessionMeta(sessionId, {
    shell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
  });

  attachClient(sessionId, c, r, senderWebContentsId);

  const session = sessions.get(sessionId)!;
  session.shell = shell;

  return { sessionId, shell };
}

function stripTrailingBlanks(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") {
    end--;
  }
  return lines.slice(0, end).join("\n");
}

function reconnectSessionUnix(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  const tmux = tmuxModule!;
  const name = tmux.tmuxSessionName(sessionId);

  try {
    tmux.tmuxExec("has-session", "-t", name);
  } catch {
    deleteSessionMeta(sessionId);
    throw new Error(`tmux session ${name} not found`);
  }

  let scrollback = "";
  try {
    const raw = tmux.tmuxExec(
      "capture-pane", "-t", name,
      "-p", "-e", "-S", "-200000",
    );
    scrollback = stripTrailingBlanks(raw);
  } catch {
    // Proceed without scrollback
  }

  attachClient(sessionId, cols, rows, senderWebContentsId);

  try {
    tmux.tmuxExec(
      "resize-window", "-t", name,
      "-x", String(cols), "-y", String(rows),
    );
  } catch {
    // Non-fatal
  }

  const meta = readSessionMeta(sessionId);
  const session = sessions.get(sessionId)!;
  session.shell =
    meta?.shell || process.env.SHELL || "/bin/zsh";

  return { sessionId, shell: session.shell, meta, scrollback };
}

// ---------- Public API (platform-dispatching) ----------

export function createSession(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
  initialCommand?: string,
): { sessionId: string; shell: string } {
  if (isWin) {
    return createSessionWin(cwd, senderWebContentsId, cols, rows, initialCommand);
  }
  return createSessionUnix(cwd, senderWebContentsId, cols, rows);
}

export function reconnectSession(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  if (isWin) {
    return reconnectSessionWin(
      sessionId, cols, rows, senderWebContentsId,
    );
  }
  return reconnectSessionUnix(
    sessionId, cols, rows, senderWebContentsId,
  );
}

export function writeToSession(
  sessionId: string,
  data: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.write(data);
}

export function sendRawKeys(
  sessionId: string,
  data: string,
): void {
  if (isWin) {
    // No tmux on Windows — write directly
    writeToSession(sessionId, data);
    return;
  }
  const tmux = tmuxModule!;
  const name = tmux.tmuxSessionName(sessionId);
  tmux.tmuxExec("send-keys", "-l", "-t", name, data);
}

export function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.resize(cols, rows);

  if (!isWin && tmuxModule) {
    const name = tmuxModule.tmuxSessionName(sessionId);
    try {
      tmuxModule.tmuxExec(
        "resize-window", "-t", name,
        "-x", String(cols), "-y", String(rows),
      );
    } catch {
      // Non-fatal
    }
  }
}

export function readSession(
  sessionId: string,
  lines: number = 50,
): string {
  const buf = scrollbackBuffers.get(sessionId) || "";
  if (!buf) return "";
  const allLines = buf.split("\n");
  return allLines.slice(-lines).join("\n");
}

export function killSession(sessionId: string): void {
  clearForegroundCache(sessionId);
  scrollbackBuffers.delete(sessionId);
  const session = sessions.get(sessionId);
  if (session) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(sessionId);
  }

  if (!isWin && tmuxModule) {
    const name = tmuxModule.tmuxSessionName(sessionId);
    try {
      tmuxModule.tmuxExec("kill-session", "-t", name);
    } catch {
      // Session may already be dead
    }
  }

  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

export function killAll(): void {
  shuttingDown = true;
  for (const [id, session] of sessions) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(id);
  }
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (sessions.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const [id, session] of sessions) {
    pending.push(
      new Promise<void>((resolve) => {
        session.pty.onExit(() => resolve());
      }),
    );
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(id);
  }

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, KILL_ALL_TIMEOUT_MS),
  );

  return Promise.race([
    Promise.all(pending).then(() => {}),
    timeout,
  ]);
}

export function destroyAll(): void {
  killAll();
  if (!isWin && tmuxModule) {
    try {
      tmuxModule.tmuxExec("kill-server");
    } catch {
      // Server may not be running
    }
  }
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

export function discoverSessions(): DiscoveredSession[] {
  if (isWin) {
    // On Windows, return currently active in-memory sessions
    const result: DiscoveredSession[] = [];
    for (const [sessionId] of sessions) {
      const meta = readSessionMeta(sessionId);
      if (meta) {
        result.push({ sessionId, meta });
      }
    }
    return result;
  }

  // Unix: cross-reference tmux sessions with metadata files
  const tmux = tmuxModule!;
  let tmuxNames: string[];
  try {
    const raw = tmux.tmuxExec(
      "list-sessions", "-F", "#{session_name}",
    );
    tmuxNames = raw.split("\n").filter(Boolean);
  } catch {
    tmuxNames = [];
  }

  const tmuxSet = new Set(tmuxNames);
  const result: DiscoveredSession[] = [];

  let metaFiles: string[];
  try {
    metaFiles = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"));
  } catch {
    metaFiles = [];
  }

  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const name = tmux.tmuxSessionName(sessionId);

    if (tmuxSet.has(name)) {
      const meta = readSessionMeta(sessionId);
      if (meta) {
        result.push({ sessionId, meta });
      }
      tmuxSet.delete(name);
    } else {
      deleteSessionMeta(sessionId);
    }
  }

  for (const orphan of tmuxSet) {
    if (orphan.startsWith("collab-")) {
      try {
        tmux.tmuxExec("kill-session", "-t", orphan);
      } catch {
        // Already dead
      }
    }
  }

  return result;
}

export function getForegroundProcess(
  sessionId: string,
): string | null {
  if (isWin) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    // On Windows, return the shell name as we can't easily introspect
    const shellName = session.shell.split(/[/\\]/).pop() || session.shell;
    return shellName;
  }
  const tmux = tmuxModule!;
  const name = tmux.tmuxSessionName(sessionId);
  try {
    return tmux.tmuxExec(
      "display-message", "-t", name,
      "-p", "#{pane_current_command}",
    );
  } catch {
    return null;
  }
}

const lastForeground = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STATUS_DEBOUNCE_MS = 500;

export function scheduleForegroundCheck(sessionId: string): void {
  const existing = statusTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  statusTimers.set(
    sessionId,
    setTimeout(() => {
      statusTimers.delete(sessionId);
      const fg = getForegroundProcess(sessionId);
      if (fg == null) return;

      const prev = lastForeground.get(sessionId);
      if (fg === prev) return;

      lastForeground.set(sessionId, fg);
      sendToMainWindow("pty:status-changed", {
        sessionId,
        foreground: fg,
      });
    }, STATUS_DEBOUNCE_MS),
  );
}

export function clearForegroundCache(sessionId: string): void {
  lastForeground.delete(sessionId);
  const timer = statusTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(sessionId);
  }
}

function getAttachedSessionNames(): Set<string> {
  if (isWin || !tmuxModule) return new Set();
  try {
    const raw = tmuxModule.tmuxExec(
      "list-sessions", "-F",
      "#{session_name}:#{session_attached}",
    );
    const attached = new Set<string>();
    for (const line of raw.split("\n").filter(Boolean)) {
      const sep = line.lastIndexOf(":");
      const name = line.slice(0, sep);
      const count = parseInt(line.slice(sep + 1), 10);
      if (count > 0) attached.add(name);
    }
    return attached;
  } catch {
    return new Set();
  }
}

export function cleanDetachedSessions(
  activeSessionIds: string[],
): void {
  if (isWin) {
    // On Windows, clean up sessions not in the active list
    const active = new Set(activeSessionIds);
    for (const [sessionId] of sessions) {
      if (!active.has(sessionId)) {
        killSession(sessionId);
      }
    }
    return;
  }

  const tmux = tmuxModule!;
  const active = new Set(activeSessionIds);
  const attached = getAttachedSessionNames();
  const discovered = discoverSessions();

  for (const { sessionId } of discovered) {
    if (active.has(sessionId)) continue;
    if (attached.has(tmux.tmuxSessionName(sessionId))) continue;
    killSession(sessionId);
  }
}

export function verifyTmuxAvailable(): void {
  if (isWin) {
    // tmux not needed on Windows
    return;
  }
  tmuxModule!.tmuxExec("-V");
}

// Stubs for sidecar functions (macOS-only, no-op on Windows)
export async function ensureSidecar(): Promise<void> {}
export async function shutdownSidecarIfIdle(): Promise<void> {}
