import { readdir, readFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  cruise,
  type ICruiseOptions,
  type IResolveOptions,
} from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { createFileFilter, type FileFilter } from "./file-filter";
import { shouldIncludeEntryWithContent } from "./files";
import {
  buildPythonImportLinks,
  PYTHON_CODE_EXTENSIONS,
} from "./workspace-graph-python";

interface WorkspaceGraphNode {
  id: string;
  title: string;
  path: string;
  nodeType: "file" | "code";
  weight: number;
}

interface WorkspaceGraphLink {
  source: string;
  target: string;
  linkType: "wikilink" | "import";
}

interface WorkspaceGraphData {
  nodes: WorkspaceGraphNode[];
  links: WorkspaceGraphLink[];
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

const JS_TS_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
]);
const CODE_EXTENSIONS = new Set([
  ...Array.from(JS_TS_CODE_EXTENSIONS),
  ...Array.from(PYTHON_CODE_EXTENSIONS),
]);
const EXTRA_IMPORT_SCAN_EXTENSIONS = [".css", ".json"];
const CONFIG_NAME_PATTERN =
  /^(?:ts|js)config(?:\.[^.]+)*\.json$/;
const CRUISE_IGNORE_PATTERN =
  "(^|/)(node_modules|dist|build|out)/";
const CONFIG_SEARCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
]);
const CONFIG_NAME_PRIORITIES = new Map([
  ["tsconfig.web.json", 40],
  ["tsconfig.app.json", 30],
  ["tsconfig.node.json", 20],
  ["tsconfig.json", 10],
  ["jsconfig.json", 5],
]);

export interface CollectedFile {
  id: string;
  title: string;
  path: string;
  content: string | null;
  nodeType: "file" | "code";
  analysisType: "markdown" | "code" | null;
}

interface ConfigCandidate {
  configPath: string;
  configDir: string;
  parsed: ReturnType<typeof extractTSConfig>;
  score: number;
}

interface DependencyCruiserContext {
  alias: Record<string, string>;
  tsConfigFileName?: string;
  tsConfig?: ReturnType<typeof extractTSConfig>;
}

type DependencyCruiserResolveOptions =
  Partial<IResolveOptions> & {
    tsConfig?: string;
  };

export async function buildWorkspaceGraph(
  workspacePath: string,
  filter: FileFilter | null = null,
): Promise<WorkspaceGraphData> {
  const activeFilter =
    filter ?? createFileFilter();
  const files = await collectFiles(
    workspacePath,
    workspacePath,
    activeFilter,
  );

  const mdFiles = files.filter(
    (
      f,
    ): f is CollectedFile & {
      analysisType: "markdown";
      content: string;
    } => f.analysisType === "markdown" && f.content !== null,
  );
  const codeFiles = files.filter(
    (
      f,
    ): f is CollectedFile & {
      analysisType: "code";
    } => f.analysisType === "code",
  );

  const nodes: WorkspaceGraphNode[] = files.map((f) => ({
    id: f.id,
    title: f.title,
    path: f.path,
    nodeType: f.nodeType,
    weight: f.content?.length ?? 0,
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const links: WorkspaceGraphLink[] = [];
  const seenLinks = new Set<string>();

  function addLink(
    source: string,
    target: string,
    linkType: "wikilink" | "import",
  ): void {
    if (!nodeIds.has(target)) return;
    if (target === source) return;
    const key = `${source}->${target}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ source, target, linkType });
  }

  // Wikilinks from markdown files
  const stemToId = new Map<string, string>();
  const ambiguousStems = new Set<string>();
  for (const file of mdFiles) {
    const stem = basename(file.id, extname(file.id));
    if (stemToId.has(stem)) {
      ambiguousStems.add(stem);
    } else {
      stemToId.set(stem, file.id);
    }
  }

  for (const file of mdFiles) {
    const matches = file.content.matchAll(WIKILINK_PATTERN);
    for (const match of matches) {
      const rawTarget = match[1];
      if (!rawTarget) continue;
      const target = rawTarget.trim();
      const targetId = stemToId.get(target);
      if (!targetId || ambiguousStems.has(target)) continue;
      addLink(file.id, targetId, "wikilink");
    }
  }

  // Imports from code files
  let importLinks: Array<{ source: string; target: string }> =
    [];
  try {
    importLinks = await buildCodeImportLinks(
      codeFiles,
      workspacePath,
      nodeIds,
    );
  } catch (error) {
    console.warn(
      "Failed to build code import links:",
      error,
    );
  }

  for (const link of importLinks) {
    addLink(link.source, link.target, "import");
  }

  return { nodes, links };
}

async function collectFiles(
  dirPath: string,
  rootPath: string,
  filter: FileFilter,
): Promise<CollectedFile[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: CollectedFile[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);
    const relPath = relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      if (!(await shouldIncludeEntryWithContent(dirPath, entry, filter, rootPath))) {
        continue;
      }
      const children = await collectFiles(fullPath, rootPath, filter);
      results.push(...children);
      continue;
    }

    if (!(await shouldIncludeEntryWithContent(dirPath, entry, filter, rootPath))) {
      continue;
    }

    const ext = extname(entry.name);
    const isMarkdown = ext === ".md";
    const isCode = CODE_EXTENSIONS.has(ext);
    const analysisType = isMarkdown
      ? ("markdown" as const)
      : isCode
        ? ("code" as const)
        : null;

    let title = entry.name;
    let content: string | null = null;

    if (isMarkdown) {
      try {
        content = await readFile(fullPath, "utf-8");
        const titleMatch = content.match(
          /^---\n[\s\S]*?title:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/,
        );
        if (titleMatch?.[1]) {
          title = titleMatch[1];
        }
      } catch {
        // Keep the node but skip title/link extraction if the file isn't UTF-8 readable.
      }
    }

    results.push({
      id: relPath,
      title,
      path: fullPath,
      content,
      nodeType: isCode ? "code" : "file",
      analysisType,
    });
  }

  return results;
}

async function buildCodeImportLinks(
  codeFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
  workspacePath: string,
  nodeIds: Set<string>,
): Promise<Array<{ source: string; target: string }>> {
  if (codeFiles.length === 0) {
    return [];
  }

  const jsTsFiles = codeFiles.filter((file) =>
    JS_TS_CODE_EXTENSIONS.has(
      extname(file.path),
    ),
  );
  const pythonFiles = codeFiles.filter((file) =>
    PYTHON_CODE_EXTENSIONS.has(
      extname(file.path),
    ),
  );

  const results = await Promise.allSettled([
    buildJavaScriptTypeScriptImportLinks(
      jsTsFiles,
      workspacePath,
      nodeIds,
    ),
    buildPythonImportLinks(
      pythonFiles,
      workspacePath,
      nodeIds,
    ),
  ]);

  const links: Array<{
    source: string;
    target: string;
  }> = [];
  const [jsTsResult, pythonResult] = results;

  if (jsTsResult?.status === "fulfilled") {
    links.push(...jsTsResult.value);
  } else if (jsTsResult) {
    console.warn(
      "Failed to build JS/TS import links:",
      jsTsResult.reason,
    );
  }

  if (pythonResult?.status === "fulfilled") {
    links.push(...pythonResult.value);
  } else if (pythonResult) {
    console.warn(
      "Failed to build Python import links:",
      pythonResult.reason,
    );
  }

  return links;
}

async function buildJavaScriptTypeScriptImportLinks(
  codeFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
  workspacePath: string,
  nodeIds: Set<string>,
): Promise<Array<{ source: string; target: string }>> {
  if (codeFiles.length === 0) {
    return [];
  }

  const links: Array<{
    source: string;
    target: string;
  }> = [];
  const seenLinks = new Set<string>();
  const codeIds = new Set(
    codeFiles.map((file) => file.id),
  );
  const groups =
    await groupCodeFilesByCruiserContext(
      codeFiles,
      workspacePath,
    );

  for (const group of groups) {
    const cruiseOptions: ICruiseOptions = {
      baseDir: workspacePath,
      doNotFollow: CRUISE_IGNORE_PATTERN,
      exclude: CRUISE_IGNORE_PATTERN,
      tsPreCompilationDeps: true,
      extraExtensionsToScan:
        EXTRA_IMPORT_SCAN_EXTENSIONS,
    };
    if (group.context.tsConfigFileName) {
      cruiseOptions.tsConfig = {
        fileName: group.context.tsConfigFileName,
      };
    }

    const resolveOptions: DependencyCruiserResolveOptions = {
      extensions: [
        ...Array.from(CODE_EXTENSIONS),
        ...EXTRA_IMPORT_SCAN_EXTENSIONS,
      ],
      conditionNames: [
        "import",
        "module",
        "require",
        "default",
        "node",
        "browser",
      ],
      exportsFields: ["exports"],
      mainFields: ["module", "main"],
    };
    if (group.context.tsConfigFileName) {
      resolveOptions.tsConfig =
        group.context.tsConfigFileName;
    }
    if (
      Object.keys(group.context.alias).length > 0
    ) {
      resolveOptions.alias = group.context.alias;
    }

    const reporterOutput = await cruise(
      group.files.map((file) => file.id),
      cruiseOptions,
      resolveOptions,
      group.context.tsConfig
        ? {
            tsConfig: group.context.tsConfig,
          }
        : undefined,
    );

    const cruiseResult = reporterOutput.output;
    if (typeof cruiseResult === "string") {
      continue;
    }

    for (const module of cruiseResult.modules) {
      const source = normalizeCruiserPath(
        module.source,
        workspacePath,
      );
      if (!source) {
        continue;
      }
      if (!codeIds.has(source)) {
        continue;
      }

      for (const dependency of module.dependencies) {
        if (dependency.couldNotResolve) {
          continue;
        }

        const target = normalizeCruiserPath(
          dependency.resolved,
          workspacePath,
        );
        if (
          !target ||
          !nodeIds.has(target) ||
          target === source
        ) {
          continue;
        }

        const key = `${source}->${target}`;
        if (seenLinks.has(key)) {
          continue;
        }
        seenLinks.add(key);
        links.push({ source, target });
      }
    }
  }

  return links;
}

async function groupCodeFilesByCruiserContext(
  codeFiles: Array<
    CollectedFile & {
      analysisType: "code";
    }
  >,
  workspacePath: string,
): Promise<
  Array<{
    context: DependencyCruiserContext;
    files: Array<
      CollectedFile & {
        analysisType: "code";
      }
    >;
  }>
> {
  const candidates =
    await listConfigCandidates(workspacePath);
  const groups = new Map<
    string,
    {
      context: DependencyCruiserContext;
      files: Array<
        CollectedFile & {
          analysisType: "code";
        }
      >;
    }
  >();

  for (const file of codeFiles) {
    const context = getDependencyCruiserContext(
      file.path,
      candidates,
    );
    const key =
      context.tsConfigFileName ?? "__default__";
    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
      continue;
    }
    groups.set(key, {
      context,
      files: [file],
    });
  }

  return Array.from(groups.values());
}

async function listConfigCandidates(
  workspacePath: string,
): Promise<ConfigCandidate[]> {
  const configPaths =
    await listTypeScriptConfigPaths(workspacePath);

  return configPaths
    .map((configPath) => {
      try {
        const parsed = extractTSConfig(configPath);
        return {
          configPath,
          configDir: dirname(configPath),
          parsed,
          score: scoreConfigCandidate(
            configPath,
            parsed,
          ),
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        candidate,
      ): candidate is ConfigCandidate =>
        candidate !== null,
    )
    .sort(compareConfigCandidates);
}

function getDependencyCruiserContext(
  filePath: string,
  candidates: ConfigCandidate[],
): DependencyCruiserContext {
  const relevantCandidates = candidates.filter(
    (candidate) =>
      isPathWithinDirectory(
        filePath,
        candidate.configDir,
      ),
  );
  const bestCandidate =
    relevantCandidates[0] ?? candidates[0];

  if (!bestCandidate) {
    return { alias: {} };
  }

  const alias: Record<string, string> = {};
  for (const candidate of relevantCandidates) {
    for (const [from, to] of extractAliasEntries(
      candidate.configPath,
      candidate.parsed,
    )) {
      if (!(from in alias)) {
        alias[from] = to;
      }
    }
  }

  return {
    alias,
    tsConfigFileName:
      bestCandidate.configPath,
    tsConfig: bestCandidate.parsed,
  };
}

async function listTypeScriptConfigPaths(
  workspacePath: string,
): Promise<string[]> {
  const configPaths: string[] = [];

  await collectTypeScriptConfigPaths(
    workspacePath,
    configPaths,
  );

  return configPaths;
}

async function collectTypeScriptConfigPaths(
  dirPath: string,
  configPaths: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, {
      withFileTypes: true,
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (
        CONFIG_SEARCH_IGNORED_DIRS.has(
          entry.name,
        )
      ) {
        continue;
      }
      await collectTypeScriptConfigPaths(
        fullPath,
        configPaths,
      );
      continue;
    }

    if (
      entry.isFile() &&
      CONFIG_NAME_PATTERN.test(entry.name)
    ) {
      configPaths.push(fullPath);
    }
  }
}

function scoreConfigCandidate(
  configPath: string,
  parsed: ReturnType<typeof extractTSConfig>,
): number {
  const fileName = basename(configPath);
  const pathCount = Object.keys(
    parsed.options.paths ?? {},
  ).length;

  return (
    (CONFIG_NAME_PRIORITIES.get(fileName) ?? 0) +
    pathCount * 100 +
    (parsed.options.jsx !== undefined ? 10 : 0) +
    (parsed.options.baseUrl !== undefined ? 5 : 0)
  );
}

function extractAliasEntries(
  configPath: string,
  parsed: ReturnType<typeof extractTSConfig>,
): Array<[string, string]> {
  const paths = parsed.options.paths;
  if (!paths) {
    return [];
  }

  const configDir = dirname(configPath);
  const baseUrl =
    typeof parsed.options.baseUrl === "string"
      ? resolve(configDir, parsed.options.baseUrl)
      : configDir;

  return Object.entries(paths)
    .map(([key, values]) => {
      if (
        key.includes("*") ||
        values.length !== 1
      ) {
        return null;
      }

      const firstValue = values[0];
      if (
        !firstValue ||
        firstValue.includes("*")
      ) {
        return null;
      }

      return [
        key,
        resolve(
          baseUrl,
          firstValue,
        ),
      ] as [string, string];
    })
    .filter(
      (
        entry,
      ): entry is [string, string] => entry !== null,
    );
}

function compareConfigCandidates(
  a: ConfigCandidate,
  b: ConfigCandidate,
): number {
  return (
    b.score - a.score ||
    b.configDir.length - a.configDir.length
  );
}

export function isPathWithinDirectory(
  filePath: string,
  dirPath: string,
): boolean {
  const relPath = relative(dirPath, filePath);

  return (
    relPath === "" ||
    (!relPath.startsWith("..") &&
      !isAbsolute(relPath))
  );
}

function normalizeCruiserPath(
  value: string | undefined,
  workspacePath?: string,
): string | null {
  if (!value) {
    return null;
  }

  let normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (workspacePath) {
    const resolvedPath = resolve(
      workspacePath,
      normalized,
    );
    const relativePath = relative(
      workspacePath,
      resolvedPath,
    ).replaceAll("\\", "/");
    if (
      relativePath !== "" &&
      !relativePath.startsWith("../") &&
      !isAbsolute(relativePath)
    ) {
      normalized = relativePath;
    }
  }

  return normalized.length > 0 ? normalized : null;
}
