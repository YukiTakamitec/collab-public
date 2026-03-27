import { app } from "electron";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const isWin = process.platform === "win32";

const COLLAB_DIR = join(homedir(), ".collaborator");
const BIN_DIR = join(COLLAB_DIR, "bin");
const HINT_MARKER = join(COLLAB_DIR, "cli-path-hinted");

function getCliCjsSource(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "collab-cli.cjs");
  }
  return join(app.getAppPath(), "scripts", "collab-cli.cjs");
}

export function installCli(): void {
  const source = getCliCjsSource();
  if (!existsSync(source)) {
    console.warn("[cli-installer] CLI source not found:", source);
    return;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  // Copy the Node.js CLI script
  const cliDest = join(BIN_DIR, "collab-cli.cjs");
  copyFileSync(source, cliDest);

  if (isWin) {
    // Windows: .cmd wrapper for CMD / PowerShell
    writeFileSync(
      join(BIN_DIR, "collab.cmd"),
      `@echo off\r\nnode "%~dp0collab-cli.cjs" %*\r\n`,
      "utf-8",
    );

    // Shell wrapper for WSL / Git Bash (same directory, no extension)
    const shContent =
      '#!/bin/bash\n' +
      'exec node "$(cd "$(dirname "$0")" && pwd)/collab-cli.cjs" "$@"\n';
    writeFileSync(join(BIN_DIR, "collab"), shContent, "utf-8");
  } else {
    // macOS / Linux: install to ~/.local/bin
    const localBin = join(homedir(), ".local", "bin");
    mkdirSync(localBin, { recursive: true });

    const wrapperPath = join(localBin, "collab");
    const shContent =
      '#!/bin/bash\n' +
      `exec node "${cliDest}" "$@"\n`;
    writeFileSync(wrapperPath, shContent, "utf-8");
    chmodSync(wrapperPath, 0o755);
  }

  // PATH hint (once)
  if (!existsSync(HINT_MARKER)) {
    const pathEnv = process.env["PATH"] ?? "";
    const sep = isWin ? ";" : ":";
    const hintDir = isWin ? BIN_DIR : join(homedir(), ".local", "bin");

    if (!pathEnv.split(sep).includes(hintDir)) {
      const instruction = isWin
        ? `  Windows:  set PATH=%PATH%;${BIN_DIR}\n  WSL:      export PATH="/mnt/c/Users/${require("node:os").userInfo().username}/.collaborator/bin:$PATH"`
        : `  export PATH="${hintDir}:$PATH"`;
      console.log(
        `[cli-installer] collab CLI installed to ${BIN_DIR}\n` +
        `Add to PATH:\n${instruction}`,
      );
      writeFileSync(HINT_MARKER, "", "utf-8");
    }
  }
}
