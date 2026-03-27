import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { COLLAB_DIR } from "./paths";
import { atomicWriteFileSync } from "./files";

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface AppConfig {
  workspaces: string[];
  active_workspace: number;
  window_state: WindowState | null;
  ui: Record<string, unknown>;
}

const DEFAULT_CONFIG: AppConfig = {
  workspaces: [],
  active_workspace: -1,
  window_state: null,
  ui: {},
};

function configPath(): string {
  return join(COLLAB_DIR, "config.json");
}

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    let workspaces: string[];
    let activeWorkspace: number;

    if (Array.isArray(parsed.workspaces)) {
      workspaces = (parsed.workspaces as unknown[]).filter(
        (p): p is string => typeof p === "string",
      );
      const rawIndex =
        typeof parsed.active_workspace === "number"
          ? parsed.active_workspace
          : -1;
      activeWorkspace = workspaces.length > 0
        ? Math.max(0, Math.min(rawIndex, workspaces.length - 1))
        : -1;
    } else if (
      typeof parsed.workspace_path === "string" &&
      parsed.workspace_path !== ""
    ) {
      workspaces = [parsed.workspace_path];
      activeWorkspace = 0;
    } else {
      workspaces = [];
      activeWorkspace = -1;
    }

    return {
      workspaces,
      active_workspace: activeWorkspace,
      window_state: (parsed.window_state as WindowState) ?? null,
      ui:
        parsed.ui && typeof parsed.ui === "object"
          ? (parsed.ui as Record<string, unknown>)
          : {},
    };
  } catch {
    return { ...DEFAULT_CONFIG, ui: {} };
  }
}

export function saveConfig(config: AppConfig): void {
  const filePath = configPath();
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(config, null, 2));
}

export function getPref(
  config: AppConfig,
  key: string,
): unknown {
  return config.ui[key] ?? null;
}

export function setPref(
  config: AppConfig,
  key: string,
  value: unknown,
): void {
  config.ui[key] = value;
  saveConfig(config);
}

export type TerminalMode = "tmux" | "sidecar" | "direct";

export function getTerminalMode(): TerminalMode {
  const config = loadConfig();
  const mode = getPref(config, "terminalMode");
  if (mode === "sidecar" || mode === "direct" || mode === "tmux") {
    return mode;
  }
  // Backward compat: directPty: true → "direct"
  if (getPref(config, "directPty") === true) {
    return "direct";
  }
  return "tmux";
}
