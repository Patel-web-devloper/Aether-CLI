/**
 * File indexer — recursively indexes a project directory.
 *
 * Builds a lightweight FileIndex with per-file metadata and symbol summaries.
 * Respects .gitignore, skips binary files and known ignore directories.
 * Supports caching to ~/.cache/aether/index/{project_hash}.json for instant reload.
 * Optional watch mode via fs.watch keeps the index live.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, basename, extname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import type { FileIndex, FileIndexEntry } from "./types.js";

// ── constants ──────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".next", "__pycache__", ".venv", "venv", ".turbo", ".cache",
]);

const BINARY_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3",
]);

const LANG_MAP: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript (React)",
  ".js": "JavaScript", ".jsx": "JavaScript (React)",
  ".py": "Python", ".rs": "Rust", ".go": "Go",
  ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin",
  ".swift": "Swift", ".c": "C", ".cpp": "C++", ".h": "C/C++",
  ".css": "CSS", ".scss": "SCSS", ".less": "Less",
  ".html": "HTML", ".vue": "Vue", ".svelte": "Svelte",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
  ".md": "Markdown", ".sh": "Shell", ".bash": "Bash",
  ".toml": "TOML", ".sql": "SQL", ".graphql": "GraphQL",
};

const MAX_FILE_SIZE = 500_000; // 500 KB — skip larger files for indexing

// ── symbol extraction ──────────────────────────────────────────────────────

/**
 * Extract top-level symbol names from source code using simple regex.
 * Detects: function declarations, class declarations, exports, arrow functions, methods.
 */
function extractSymbols(content: string, language: string): string[] {
  const symbols: string[] = [];

  if (language === "TypeScript" || language === "JavaScript" ||
      language === "TypeScript (React)" || language === "JavaScript (React)") {
    // export const/let/var/function/class/interface/type
    const exportPattern = /^export\s+(?:const|let|var|function|class|interface|type|enum|default\s+(?:function|class))\s+(\w+)/gm;
    let m: RegExpExecArray | null;
    while ((m = exportPattern.exec(content)) !== null) {
      symbols.push(`export ${m[1]}`);
    }

    // Top-level function declarations (not inside other blocks)
    const funcPattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!symbols.includes(`export ${name}`)) {
        symbols.push(name);
      }
    }

    // Class declarations
    const classPattern = /^(?:export\s+)?class\s+(\w+)/gm;
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!symbols.includes(`export ${name}`)) {
        symbols.push(name);
      }
    }

    // Arrow functions assigned to const
    const arrowPattern = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;
    while ((m = arrowPattern.exec(content)) !== null) {
      const name = m[1];
      if (!symbols.some(s => s.includes(name))) {
        symbols.push(name);
      }
    }

    // Interface/type declarations
    const typePattern = /^(?:export\s+)?(?:interface|type)\s+(\w+)/gm;
    while ((m = typePattern.exec(content)) !== null) {
      const name = m[1];
      if (!symbols.includes(`export ${name}`)) {
        symbols.push(name);
      }
    }
  } else if (language === "Python") {
    const pyFuncPattern = /^def\s+(\w+)/gm;
    let pm: RegExpExecArray | null;
    while ((pm = pyFuncPattern.exec(content)) !== null) {
      symbols.push(pm[1]);
    }
    const pyClassPattern = /^class\s+(\w+)/gm;
    while ((pm = pyClassPattern.exec(content)) !== null) {
      symbols.push(pm[1]);
    }
  } else if (language === "Rust") {
    const rustPattern = /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod)\s+(\w+)/gm;
    let rm: RegExpExecArray | null;
    while ((rm = rustPattern.exec(content)) !== null) {
      symbols.push(rm[1]);
    }
  }

  // Limit symbols to 50 per file
  return symbols.slice(0, 50);
}

// ── gitignore ──────────────────────────────────────────────────────────────

interface GitignoreRule {
  pattern: string;
  negate: boolean;
  regex: RegExp;
}

function loadGitignore(dir: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const path = join(dir, ".gitignore");
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const negate = trimmed.startsWith("!");
      let pattern = negate ? trimmed.slice(1) : trimmed;

      // Strip leading / for root anchoring (we simulate this)
      if (pattern.startsWith("/")) pattern = pattern.slice(1);

      // Convert to regex
      let regexStr = "";
      let i = 0;
      while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "*" && pattern[i + 1] === "*") {
          if (pattern[i + 2] === "/") {
            regexStr += "(.*/)?";
            i += 3;
            continue;
          }
          regexStr += ".*";
          i += 2;
          continue;
        }
        if (ch === "*") { regexStr += "[^/]*"; i++; continue; }
        if (ch === "?") { regexStr += "[^/]"; i++; continue; }
        if (".()[]{}+|^$\\".includes(ch)) regexStr += "\\" + ch;
        else regexStr += ch;
        i++;
      }

      // Also match if pattern appears anywhere in path (for non-root-anchored)
      try {
        rules.push({ pattern: trimmed, negate, regex: new RegExp("(^|/)" + regexStr + "(/|$)") });
      } catch {
        // fallback: simple includes check
        rules.push({
          pattern: trimmed,
          negate,
          regex: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        });
      }
    }
  } catch {
    // No .gitignore
  }
  return rules;
}

function isGitignored(relPath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relPath) || rule.regex.test("/" + relPath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

// ── cache management ───────────────────────────────────────────────────────

function getCacheDir(): string {
  const dir = join(homedir(), ".cache", "aether", "index");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function projectHash(root: string): string {
  return createHash("md5").update(root).digest("hex").slice(0, 12);
}

function cachePath(root: string): string {
  return join(getCacheDir(), `${projectHash(root)}.json`);
}

function loadCache(root: string): FileIndex | null {
  const p = cachePath(root);
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    // Reconstruct Map from serialized entries
    const entries = new Map<string, FileIndexEntry>(Object.entries(data._entries ?? {}));
    return {
      root: data.root,
      projectHash: data.projectHash,
      indexedAt: data.indexedAt,
      entries,
    };
  } catch {
    return null;
  }
}

function saveCache(index: FileIndex): void {
  const p = cachePath(index.root);
  const serialized: Record<string, unknown> = {
    root: index.root,
    projectHash: index.projectHash,
    indexedAt: index.indexedAt,
    _entries: Object.fromEntries(index.entries),
  };
  writeFileSync(p, JSON.stringify(serialized, null, 2), "utf-8");
}

// ── indexer ────────────────────────────────────────────────────────────────

export interface IndexerOptions {
  /** Skip cache and force a full re-index. */
  force?: boolean;
  /** Enable watch mode via fs.watch. */
  watch?: boolean;
  /** Callback when index changes (for watch mode). */
  onUpdate?: (index: FileIndex, changed: string) => void;
}

/**
 * Index a project directory. Returns a FileIndex.
 * Uses cached index if available and `force` is false.
 */
export async function indexProject(
  root: string,
  options: IndexerOptions = {},
): Promise<FileIndex> {
  // Try cache first
  if (!options.force) {
    const cached = loadCache(root);
    if (cached) return cached;
  }

  const hash = projectHash(root);
  const entries = new Map<string, FileIndexEntry>();
  const gitignoreRules = loadGitignore(root);

  await walk(root, root, entries, gitignoreRules);

  const index: FileIndex = {
    root,
    projectHash: hash,
    indexedAt: Date.now(),
    entries,
  };

  // Save cache
  saveCache(index);

  // Start watch if requested
  if (options.watch) {
    startWatch(root, index, options.onUpdate);
  }

  return index;
}

/**
 * Invalidate cache for a project root.
 */
export function invalidateCache(root: string): void {
  const p = cachePath(root);
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(p);
  } catch {
    // Already removed
  }
}

// ── walk ───────────────────────────────────────────────────────────────────

async function walk(
  root: string,
  dir: string,
  entries: Map<string, FileIndexEntry>,
  gitignoreRules: GitignoreRule[],
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission error
  }

  for (const entry of dirents) {
    // Skip hidden files/ dirs (except .gitignore which we already loaded)
    if (entry.name.startsWith(".")) continue;

    const full = join(dir, entry.name);
    const rel = relative(root, full);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (isGitignored(rel + "/", gitignoreRules)) continue;
      await walk(root, full, entries, gitignoreRules);
    } else if (entry.isFile()) {
      if (isGitignored(rel, gitignoreRules)) continue;

      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;

      try {
        const st = await stat(full);
        if (st.size > MAX_FILE_SIZE) continue; // skip huge files for indexing

        const language = LANG_MAP[ext] ?? (ext.slice(1).toUpperCase() || "Unknown");
        let symbols: string[] = [];

        // Extract symbols for known source code extensions
        const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb", ".java", ".kt"];
        if (sourceExts.includes(ext) && st.size < 200_000) {
          try {
            const content = await readFile(full, "utf-8");
            symbols = extractSymbols(content, language);
          } catch {
            // Can't read — skip symbols
          }
        }

        entries.set(rel, {
          path: rel,
          size: st.size,
          language,
          lastModified: st.mtimeMs,
          symbols,
        });
      } catch {
        // Can't stat — skip
      }
    }
  }
}

// ── watch mode ─────────────────────────────────────────────────────────────

function startWatch(
  root: string,
  index: FileIndex,
  onUpdate?: (index: FileIndex, changed: string) => void,
): void {
  try {
    const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const rel = relative(root, filename);
      if (!rel) return;

      // Simple: just invalidate and notify
      invalidateCache(root);

      if (onUpdate) {
        // Re-index affected file
        const full = join(root, rel);
        try {
          const st = statSync(full);
          const ext = extname(rel).toLowerCase();
          if (st.isFile() && !BINARY_EXTS.has(ext) && st.size <= MAX_FILE_SIZE) {
            const language = LANG_MAP[ext] ?? (ext.slice(1).toUpperCase() || "Unknown");
            let symbols: string[] = [];
            const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb", ".java", ".kt"];
            if (sourceExts.includes(ext) && st.size < 200_000) {
              try {
                const content = readFileSync(full, "utf-8");
                symbols = extractSymbols(content, language);
              } catch { /* skip */ }
            }
            index.entries.set(rel, {
              path: rel, size: st.size, language,
              lastModified: st.mtimeMs, symbols,
            });
          }
        } catch {
          // File deleted — remove from index
          index.entries.delete(rel);
        }
        index.indexedAt = Date.now();
        onUpdate(index, rel);
      }
    });

    // Keep reference to prevent GC
    process.on("exit", () => watcher.close());
    (index as Record<string, unknown>)._watcher = watcher;
  } catch {
    // watch not supported (e.g., some filesystems)
  }
}

/**
 * Stop watching an index.
 */
export function stopWatch(index: FileIndex): void {
  const watcher = (index as Record<string, unknown>)._watcher;
  if (watcher && typeof (watcher as { close: () => void }).close === "function") {
    (watcher as { close: () => void }).close();
  }
}
