#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");

// ── Extracted functions (self-contained copies from collab-cli.cjs) ──

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

function inferType(filePath) {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".graph.json")) return "graph";
  const ext = path.extname(lower).slice(1);
  if (["md", "txt", "mdx", "markdown"].includes(ext)) return "note";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return "code";
}

function toWSLPath(winPath) {
  if (!winPath) return winPath;
  const m = winPath.match(/^([A-Za-z]):\\(.*)/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  return winPath;
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ═══════════════════════════════════════════
// parseArgs tests
// ═══════════════════════════════════════════
console.log("\n-- parseArgs --");

test("no arguments returns empty positional and flags", () => {
  const r = parseArgs(["node", "cli.js"]);
  assert.deepStrictEqual(r, { positional: [], flags: {} });
});

test("positional arguments only", () => {
  const r = parseArgs(["node", "cli.js", "tile", "add", "code"]);
  assert.deepStrictEqual(r.positional, ["tile", "add", "code"]);
  assert.deepStrictEqual(r.flags, {});
});

test("flag with value", () => {
  const r = parseArgs(["node", "cli.js", "--file", "foo.js"]);
  assert.deepStrictEqual(r.positional, []);
  assert.deepStrictEqual(r.flags, { file: "foo.js" });
});

test("boolean flag (no value)", () => {
  const r = parseArgs(["node", "cli.js", "--help"]);
  assert.deepStrictEqual(r.flags, { help: true });
});

test("boolean flag followed by another flag", () => {
  const r = parseArgs(["node", "cli.js", "--verbose", "--file", "x.ts"]);
  assert.strictEqual(r.flags.verbose, true);
  assert.strictEqual(r.flags.file, "x.ts");
});

test("mixed positional and flags", () => {
  const r = parseArgs(["node", "cli.js", "tile", "add", "code", "--file", "/tmp/a.js", "--pos", "10,20"]);
  assert.deepStrictEqual(r.positional, ["tile", "add", "code"]);
  assert.strictEqual(r.flags.file, "/tmp/a.js");
  assert.strictEqual(r.flags.pos, "10,20");
});

test("flag at end without value is boolean", () => {
  const r = parseArgs(["node", "cli.js", "ping", "--json"]);
  assert.deepStrictEqual(r.positional, ["ping"]);
  assert.strictEqual(r.flags.json, true);
});

test("multiple boolean flags", () => {
  const r = parseArgs(["node", "cli.js", "--alpha", "--beta", "--gamma"]);
  assert.deepStrictEqual(r.flags, { alpha: true, beta: true, gamma: true });
});

test("positional after flag-value pair", () => {
  const r = parseArgs(["node", "cli.js", "--cwd", "/tmp", "orchestrate"]);
  assert.deepStrictEqual(r.positional, ["orchestrate"]);
  assert.strictEqual(r.flags.cwd, "/tmp");
});

// ═══════════════════════════════════════════
// inferType tests
// ═══════════════════════════════════════════
console.log("\n-- inferType --");

test("null/undefined returns null", () => {
  assert.strictEqual(inferType(null), null);
  assert.strictEqual(inferType(undefined), null);
  assert.strictEqual(inferType(""), null);
});

test("markdown files return note", () => {
  assert.strictEqual(inferType("README.md"), "note");
  assert.strictEqual(inferType("notes.txt"), "note");
  assert.strictEqual(inferType("page.mdx"), "note");
  assert.strictEqual(inferType("doc.markdown"), "note");
});

test("image files return image", () => {
  assert.strictEqual(inferType("photo.png"), "image");
  assert.strictEqual(inferType("banner.jpg"), "image");
  assert.strictEqual(inferType("icon.jpeg"), "image");
  assert.strictEqual(inferType("anim.gif"), "image");
  assert.strictEqual(inferType("logo.svg"), "image");
  assert.strictEqual(inferType("hero.webp"), "image");
});

test("graph.json returns graph", () => {
  assert.strictEqual(inferType("flow.graph.json"), "graph");
  assert.strictEqual(inferType("my-diagram.GRAPH.JSON"), "graph");
});

test("code files return code (default)", () => {
  assert.strictEqual(inferType("main.js"), "code");
  assert.strictEqual(inferType("app.tsx"), "code");
  assert.strictEqual(inferType("lib.py"), "code");
  assert.strictEqual(inferType("Makefile"), "code");
});

test("case-insensitive extension matching", () => {
  assert.strictEqual(inferType("IMAGE.PNG"), "image");
  assert.strictEqual(inferType("README.MD"), "note");
  assert.strictEqual(inferType("FILE.TXT"), "note");
});

test(".json (not .graph.json) returns code", () => {
  assert.strictEqual(inferType("package.json"), "code");
  assert.strictEqual(inferType("data.json"), "code");
});

test("graph.json takes priority over .json code", () => {
  assert.strictEqual(inferType("x.graph.json"), "graph");
});

// ═══════════════════════════════════════════
// toWSLPath tests
// ═══════════════════════════════════════════
console.log("\n-- toWSLPath --");

test("null/undefined returns as-is", () => {
  assert.strictEqual(toWSLPath(null), null);
  assert.strictEqual(toWSLPath(undefined), undefined);
  assert.strictEqual(toWSLPath(""), "");
});

test("C:\\ drive path converts correctly", () => {
  assert.strictEqual(toWSLPath("C:\\Users\\me\\file.txt"), "/mnt/c/Users/me/file.txt");
});

test("D:\\ drive path converts correctly", () => {
  assert.strictEqual(toWSLPath("D:\\Projects\\app"), "/mnt/d/Projects/app");
});

test("lowercase drive letter converts correctly", () => {
  assert.strictEqual(toWSLPath("c:\\temp\\test"), "/mnt/c/temp/test");
});

test("drive root only", () => {
  assert.strictEqual(toWSLPath("E:\\"), "/mnt/e/");
});

test("nested backslashes all converted to forward slashes", () => {
  assert.strictEqual(toWSLPath("C:\\a\\b\\c\\d\\e.js"), "/mnt/c/a/b/c/d/e.js");
});

test("already a Unix/WSL path passes through unchanged", () => {
  assert.strictEqual(toWSLPath("/mnt/c/Users/me"), "/mnt/c/Users/me");
  assert.strictEqual(toWSLPath("/home/user/file"), "/home/user/file");
});

test("non-path string passes through unchanged", () => {
  assert.strictEqual(toWSLPath("just-a-string"), "just-a-string");
});

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════
console.log(`\n-- Summary: ${passed} passed, ${failed} failed --\n`);
process.exit(failed > 0 ? 1 : 0);
