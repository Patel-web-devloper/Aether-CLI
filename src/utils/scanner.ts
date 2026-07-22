/**
 * Project context scanner.
 *
 * Walks a directory tree, builds a lightweight summary of the project
 * (file tree, detected language, framework, config files) that the
 * generation agent injects into its system prompt.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";

/** MIME-looking set of extensions we recognise. */
const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (React)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (React)",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".h": "C/C++ Header",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".md": "Markdown",
  ".sh": "Shell",
  ".bash": "Bash",
  ".toml": "TOML",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  "coverage",
  ".cache",
]);

const MAX_TREE_DEPTH = 5;
const MAX_TREE_ENTRIES = 200;

export interface ProjectContext {
  /** Absolute path of the scanned root. */
  root: string;
  /** Human-readable file tree (abbreviated for deep / large projects). */
  fileTree: string;
  /** Best-guess primary language detected from file extensions. */
  language: string;
  /** Best-guess framework (e.g. "React", "Express", "None detected"). */
  framework: string;
  /** Parsed contents of notable config files. */
  configFiles: Record<string, unknown>;
  /** Raw list of all discovered non-ignored file paths (relative). */
  files: string[];
}

/** Lightweight scan of a directory — suitable for building context for LLM prompts. */
export async function scanDirectory(targetPath: string): Promise<ProjectContext> {
  const root = targetPath;
  const files: string[] = [];

  // Walk the tree
  await walk(root, root, files, 0);

  // Detect language: count extensions across discovered files
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }

  // Prioritise source-code extensions over config/markup
  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb", ".java", ".kt", ".swift", ".c", ".cpp"];
  const sorted = [...counts.entries()].sort((a, b) => {
    const aIsSource = sourceExts.includes(a[0]);
    const bIsSource = sourceExts.includes(b[0]);
    if (aIsSource !== bIsSource) return aIsSource ? -1 : 1;
    return b[1] - a[1]; // higher count first
  });
  const primaryExt = sorted[0]?.[0] ?? "";
  const language = LANGUAGE_MAP[primaryExt] ?? (primaryExt ? primaryExt.slice(1).toUpperCase() : "Unknown");

  // Build abbreviated tree string
  const fileTree = buildTreeString(root, files);

  // Read config files
  const configFiles: Record<string, unknown> = {};
  const configNames = [
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "Gemfile",
    "pyproject.toml",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
  ];

  for (const name of configNames) {
    const fullPath = join(root, name);
    try {
      const raw = await readFile(fullPath, "utf-8");
      // For JSON files, parse them
      if (name.endsWith(".json")) {
        try {
          configFiles[name] = JSON.parse(raw);
        } catch {
          configFiles[name] = "(invalid JSON)";
        }
      } else {
        // For non-JSON, store first 1500 chars as summary
        configFiles[name] = raw.slice(0, 1500) + (raw.length > 1500 ? "\n... (truncated)" : "");
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  // Detect framework
  const framework = detectFramework(configFiles, files);

  return { root, fileTree, language, framework, configFiles, files };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function walk(
  root: string,
  dir: string,
  files: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_TREE_DEPTH) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission error — skip
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;

    const full = join(dir, entry.name);
    const rel = relative(root, full);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, full, files, depth + 1);
    } else if (entry.isFile()) {
      if (files.length >= MAX_TREE_ENTRIES) return;
      files.push(rel);
    }
  }
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx === -1) return "";
  return path.slice(idx).toLowerCase();
}

function buildTreeString(root: string, files: string[]): string {
  // Build a simple directory tree view
  const tree = new Map<string, string[]>();

  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    const name = f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f;
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(name);
  }

  const lines: string[] = [];
  const rootName = basename(root) || root;
  lines.push(`${rootName}/`);

  const dirs = [...tree.keys()].sort();
  const maxShow = 60; // cap total lines in tree
  let shown = 0;

  for (const dir of dirs) {
    if (shown >= maxShow) {
      lines.push(`  ... (${files.length - shown} more files)`);
      break;
    }
    const names = tree.get(dir)!;
    if (dir === ".") {
      for (const n of names.slice(0, 10)) {
        lines.push(`  ${n}`);
        shown++;
      }
    } else {
      const parts = dir.split("/");
      const indent = "  ".repeat(parts.length);
      lines.push(`${indent.slice(0, -2)}${parts[parts.length - 1]}/`);
      for (const n of names.slice(0, 5)) {
        lines.push(`${indent}${n}`);
        shown++;
      }
    }
    if (names.length > (dir === "." ? 10 : 5)) {
      lines.push(`${"  ".repeat(dir === "." ? 1 : dir.split("/").length + 1)}... (${names.length - (dir === "." ? 10 : 5)} more files in this dir)`);
    }
  }

  return lines.join("\n");
}

function detectFramework(
  configFiles: Record<string, unknown>,
  files: string[],
): string {
  const pkg = configFiles["package.json"] as Record<string, unknown> | undefined;
  const deps: Record<string, string> = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };

  const depKeys = Object.keys(deps);

  const checks: Array<[string, string[]]> = [
    ["Next.js", ["next"]],
    ["React", ["react"]],
    ["Vue", ["vue"]],
    ["Svelte", ["svelte"]],
    ["Express", ["express"]],
    ["Fastify", ["fastify"]],
    ["NestJS", ["@nestjs/core"]],
    ["Angular", ["@angular/core"]],
    ["Astro", ["astro"]],
    ["Remix", ["@remix-run/react"]],
    ["TanStack Start", ["@tanstack/react-start"]],
    ["Vite", ["vite"]],
    ["Webpack", ["webpack"]],
    ["Gatsby", ["gatsby"]],
  ];

  for (const [fw, keys] of checks) {
    if (keys.some((k) => depKeys.includes(k))) return fw;
  }

  // Check for other ecosystems
  if (configFiles["Cargo.toml"]) return "Rust (Cargo)";
  if (configFiles["go.mod"]) return "Go";
  if (configFiles["requirements.txt"] || configFiles["pyproject.toml"]) return "Python";
  if (configFiles["Gemfile"]) return "Ruby";

  return "None detected";
}
