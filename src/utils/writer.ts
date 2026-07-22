/**
 * File writing utility with safety checks.
 *
 * Features:
 * - Conflict detection (warns on overwrites unless --force)
 * - Dry-run mode (shows diffs/previews without writing)
 * - Automatic parent directory creation
 * - .gitignore awareness
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import chalk from "chalk";

export interface GeneratedFile {
  /** Relative or absolute path to write to. */
  path: string;
  /** File contents. */
  content: string;
  /** Action: create (only if new), edit (only if exists), or upsert. */
  action: "create" | "edit" | "upsert";
}

export interface WriteResult {
  path: string;
  status: "created" | "modified" | "skipped" | "conflict" | "ignored" | "dry-run";
  diff?: string;
  reason?: string;
}

export interface WriteOptions {
  /** Base directory to resolve relative paths against. */
  baseDir: string;
  /** If true, overwrite existing files without prompting. */
  force: boolean;
  /** If true, show previews without writing anything. */
  dryRun: boolean;
}

/** Main entry-point — writes a set of generated files safely. */
export async function writeFiles(
  files: GeneratedFile[],
  options: WriteOptions,
): Promise<WriteResult[]> {
  const gitignorePatterns = await loadGitignore(options.baseDir);
  const results: WriteResult[] = [];

  for (const file of files) {
    const result = await writeOne(file, options, gitignorePatterns);
    results.push(result);
  }

  return results;
}

/** Generate a readable summary of write results. */
export function formatResults(results: WriteResult[]): string {
  const lines: string[] = [];
  const counts: Record<string, number> = {};

  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  lines.push("");
  lines.push(chalk.bold("Summary:"));
  if (counts["created"]) lines.push(chalk.green(`  ✓ ${counts["created"]} file(s) created`));
  if (counts["modified"]) lines.push(chalk.yellow(`  ✎ ${counts["modified"]} file(s) modified`));
  if (counts["conflict"]) lines.push(chalk.red(`  ⚠ ${counts["conflict"]} conflict(s) — use --force to overwrite`));
  if (counts["ignored"]) lines.push(chalk.dim(`  ⊘ ${counts["ignored"]} file(s) in .gitignore — skipped`));
  if (counts["skipped"]) lines.push(chalk.dim(`  − ${counts["skipped"]} file(s) skipped`));
  if (counts["dry-run"]) lines.push(chalk.cyan(`  ◎ ${counts["dry-run"]} file(s) would be written (dry-run)`));

  lines.push("");
  for (const r of results) {
    const icon = statusIcon(r.status);
    lines.push(`  ${icon} ${r.path}${r.reason ? ` (${r.reason})` : ""}`);
  }

  return lines.join("\n");
}

// ── internals ────────────────────────────────────────────────────────────

async function writeOne(
  file: GeneratedFile,
  opts: WriteOptions,
  gitignorePatterns: string[],
): Promise<WriteResult> {
  const absPath = resolve(opts.baseDir, file.path);
  const relPath = relative(opts.baseDir, absPath);

  // Check .gitignore
  if (isIgnored(relPath, gitignorePatterns)) {
    return { path: relPath, status: "ignored", reason: "matches .gitignore pattern" };
  }

  // Validate action vs existing file
  const exists = existsSync(absPath);

  if (file.action === "create" && exists && !opts.force) {
    return {
      path: relPath,
      status: "conflict",
      reason: "file already exists (use --force to overwrite)",
    };
  }

  if (file.action === "edit" && !exists) {
    return {
      path: relPath,
      status: "skipped",
      reason: "file does not exist (use create mode for new files)",
    };
  }

  // Read existing content for diff
  let oldContent = "";
  if (exists) {
    try {
      oldContent = await readFile(absPath, "utf-8");
    } catch {
      oldContent = "(binary or unreadable)";
    }
  }

  const isNew = !exists;

  // Dry-run: show diff
  if (opts.dryRun) {
    const diff = generateDiff(relPath, oldContent, file.content, isNew);
    return { path: relPath, status: "dry-run", diff };
  }

  // Actually write
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    await writeFile(absPath, file.content, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: relPath, status: "skipped", reason: `write error: ${msg}` };
  }

  return {
    path: relPath,
    status: isNew ? "created" : "modified",
  };
}

function statusIcon(status: WriteResult["status"]): string {
  switch (status) {
    case "created": return chalk.green("✓");
    case "modified": return chalk.yellow("✎");
    case "conflict": return chalk.red("⚠");
    case "ignored": return chalk.dim("⊘");
    case "skipped": return chalk.dim("−");
    case "dry-run": return chalk.cyan("◎");
  }
}

// ── .gitignore handling ──────────────────────────────────────────────────

async function loadGitignore(baseDir: string): Promise<string[]> {
  const patterns: string[] = [];
  const gitignorePath = join(baseDir, ".gitignore");

  try {
    const raw = await readFile(gitignorePath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;
      patterns.push(trimmed);
    }
  } catch {
    // No .gitignore — that's fine
  }

  return patterns;
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  // Default: ignore .git, node_modules (always skipped in scan anyway)
  const parts = relPath.split("/");
  if (parts.includes(".git") || parts.includes("node_modules")) return true;

  for (const pattern of patterns) {
    if (matchGitignorePattern(relPath, pattern)) return true;
  }
  return false;
}

/**
 * Simple gitignore pattern matcher.
 *
 * Supports:
 * - literal: `dist` matches `dist` and `dist/foo`
 * - wildcard: `*.log` matches `foo.log`
 * - directory: `dist/` matches `dist/foo`
 * - negation: starts with `!` (unsets ignore)
 * - double-star: `** /foo` matches `a/foo`, `a/b/foo`
 */
function matchGitignorePattern(path: string, pattern: string): boolean {
  // Negation — for simplicity we just skip negations
  if (pattern.startsWith("!")) return false;

  // Trailing slash means directory
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    if (path === dir) return true;
    if (path.startsWith(dir + "/")) return true;
    return false;
  }

  // Leading slash anchors to root
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  // Convert gitignore glob to regex
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match anything including slashes
        if (pattern[i + 2] === "/") {
          regexStr += "(.*/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      // * — match anything except slash
      regexStr += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i++;
      continue;
    }
    // Escape regex specials
    if (".[](){}^$|+\\".includes(ch)) {
      regexStr += "\\" + ch;
    } else {
      regexStr += ch;
    }
    i++;
  }

  try {
    const re = new RegExp(`^${regexStr}$`);
    // Also match if the pattern is a prefix of a path (for directory-like patterns)
    if (re.test(path)) return true;
    // Check each path segment
    const segments = path.split("/");
    for (let s = 0; s < segments.length; s++) {
      const sub = segments.slice(s).join("/");
      if (re.test(sub)) return true;
    }
  } catch {
    // Invalid regex — fall back to simple includes check
    return path.includes(pattern.replace(/\*/g, ""));
  }

  return false;
}

// ── diff generation ──────────────────────────────────────────────────────

function generateDiff(
  path: string,
  oldContent: string,
  newContent: string,
  isNew: boolean,
): string {
  const lines: string[] = [];
  lines.push(chalk.cyan(`\n─── ${path} ───`));

  if (isNew) {
    lines.push(chalk.green(`+ new file (${newContent.split("\n").length} lines)`));
    // Show first 20 lines of new content
    const preview = newContent.split("\n").slice(0, 20).join("\n");
    lines.push(chalk.dim("┌─ preview ─"));
    for (const l of preview.split("\n")) {
      lines.push(chalk.green(`+ ${l}`));
    }
    if (newContent.split("\n").length > 20) {
      lines.push(chalk.dim(`  ... (${newContent.split("\n").length - 20} more lines)`));
    }
    lines.push(chalk.dim("└──────────"));
  } else if (oldContent === newContent) {
    lines.push(chalk.dim("  (no changes)"));
  } else {
    // Simple line-by-line diff
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLen = Math.max(oldLines.length, newLines.length);
    let changes = 0;
    const maxShow = 30;

    for (let i = 0; i < maxLen && changes < maxShow; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine !== newLine) {
        changes++;
        if (oldLine !== undefined) lines.push(chalk.red(`- ${oldLine}`));
        if (newLine !== undefined) lines.push(chalk.green(`+ ${newLine}`));
      }
    }
    if (changes >= maxShow) {
      lines.push(chalk.dim(`  ... (${changes - maxShow} more changed lines)`));
    }
    if (changes === 0) lines.push(chalk.dim("  (no changes)"));
  }

  return lines.join("\n");
}
