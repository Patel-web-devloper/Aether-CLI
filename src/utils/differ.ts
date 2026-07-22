/**
 * Diff generator for review results.
 *
 * Given a ReviewResult with a suggested fix, generates a unified diff.
 * Supports --apply to auto-apply fixes and --json for machine-readable output.
 */

import type { ReviewResult } from "../agents/reviewer.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";

export interface DiffResult {
  file: string;
  line: number;
  before: string;
  after: string;
  applied: boolean;
  error?: string;
}

export interface ApplyOptions {
  /** Base directory to resolve file paths against. */
  baseDir: string;
  /** If true, actually apply the fix to the files. */
  apply: boolean;
  /** If true, ask for confirmation before applying. */
  confirm?: boolean;
}

/**
 * Generate diffs for a set of review results that have suggested fixes.
 */
export async function generateDiffs(
  results: ReviewResult[],
  options: ApplyOptions,
): Promise<DiffResult[]> {
  const diffs: DiffResult[] = [];

  // Group results by file to apply all fixes to each file once
  const byFile = new Map<string, ReviewResult[]>();
  for (const r of results) {
    if (!r.fix) continue;
    const existing = byFile.get(r.file) ?? [];
    existing.push(r);
    byFile.set(r.file, existing);
  }

  for (const [relPath, fileResults] of byFile) {
    const absPath = resolve(options.baseDir, relPath);

    // Read the current file content
    let originalContent: string;
    try {
      originalContent = await readFile(absPath, "utf-8");
    } catch {
      for (const r of fileResults) {
        diffs.push({
          file: relPath,
          line: r.line,
          before: "",
          after: r.fix ?? "",
          applied: false,
          error: `Cannot read file: ${relPath}`,
        });
      }
      continue;
    }

    // For now, generate before/after snippets per result
    // A full unified diff engine would be more sophisticated; this provides
    // context around the target line.
    for (const r of fileResults) {
      const lines = originalContent.split("\n");
      const lineIdx = r.line - 1; // 0-based

      // Get context: 3 lines before and after the target
      const ctxStart = Math.max(0, lineIdx - 3);
      const ctxEnd = Math.min(lines.length, lineIdx + 4);

      let before = "";
      for (let i = ctxStart; i < ctxEnd; i++) {
        const marker = i === lineIdx ? "> " : "  ";
        const num = String(i + 1).padStart(4, " ");
        before += `${marker}${num} | ${lines[i]}\n`;
      }

      let after = before;
      if (r.fix) {
        // Try to generate an after by replacing the target line
        const afterLines = [...lines];
        afterLines[lineIdx] = r.fix.replace(/^[\+\-]\s*/, ""); // strip diff markers

        after = "";
        for (let i = ctxStart; i < ctxEnd; i++) {
          const marker = i === lineIdx ? "> " : "  ";
          const num = String(i + 1).padStart(4, " ");
          after += `${marker}${num} | ${afterLines[i]}\n`;
        }
      }

      diffs.push({
        file: relPath,
        line: r.line,
        before,
        after,
        applied: false,
      });
    }

    // Apply fixes if requested
    if (options.apply) {
      const applied = await applyFixesToFile(absPath, originalContent, fileResults);
      for (const d of diffs.filter((d) => d.file === relPath)) {
        if (applied) {
          d.applied = true;
        } else {
          d.error = d.error ?? "Failed to apply fix";
        }
      }
    }
  }

  return diffs;
}

/**
 * Apply fixes to a single file. Sorts by line number descending so earlier
 * fixes don't shift later line numbers.
 */
async function applyFixesToFile(
  absPath: string,
  originalContent: string,
  results: ReviewResult[],
): Promise<boolean> {
  // Sort descending so we can apply from bottom to top
  const sorted = [...results].sort((a, b) => b.line - a.line);

  let content = originalContent;
  let changed = false;

  for (const r of sorted) {
    if (!r.fix) continue;

    const lines = content.split("\n");
    const lineIdx = r.line - 1;

    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    // Check if the fix looks like a line replacement or an insertion
    const fix = r.fix.trim();

    if (fix.startsWith("+ ")) {
      // Insert new line(s) after the target
      const insertLines = fix
        .split("\n")
        .map((l) => l.replace(/^\+\s*/, ""));
      lines.splice(lineIdx + 1, 0, ...insertLines);
    } else if (fix.startsWith("- ")) {
      // Remove the target line
      lines.splice(lineIdx, 1);
    } else if (fix.includes("\n")) {
      // Multi-line replacement — replace the target line with all fix lines
      const fixLines = fix
        .split("\n")
        .map((l) => l.replace(/^[\+\-]\s*/, ""));
      lines.splice(lineIdx, 1, ...fixLines);
    } else {
      // Simple replacement
      lines[lineIdx] = fix;
    }

    content = lines.join("\n");
    changed = true;
  }

  if (changed) {
    try {
      await writeFile(absPath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Format diffs for terminal display.
 */
export function formatDiffs(diffs: DiffResult[]): string {
  if (diffs.length === 0) return chalk.dim("  (no auto-fixable issues)");

  const lines: string[] = [];
  let currentFile = "";

  for (const d of diffs) {
    if (d.file !== currentFile) {
      if (currentFile) lines.push("");
      lines.push(chalk.cyan(`\n📁 ${d.file}`));
      currentFile = d.file;
    }

    const statusIcon = d.applied
      ? chalk.green("  ✓ applied")
      : d.error
        ? chalk.red(`  ✗ ${d.error}`)
        : chalk.yellow("  • preview");

    lines.push(statusIcon + chalk.dim(`  (line ${d.line})`));

    if (d.before && d.before !== d.after) {
      lines.push(chalk.dim("    ── before ──"));
      for (const l of d.before.split("\n").filter(Boolean)) {
        if (l.startsWith("> ")) {
          lines.push(chalk.red(`    ${l}`));
        } else {
          lines.push(chalk.dim(`    ${l}`));
        }
      }
      lines.push(chalk.dim("    ── after ──"));
      for (const l of d.after.split("\n").filter(Boolean)) {
        if (l.startsWith("> ")) {
          lines.push(chalk.green(`    ${l}`));
        } else {
          lines.push(chalk.dim(`    ${l}`));
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Output results as machine-readable JSON.
 */
export function formatJson(
  results: ReviewResult[],
  diffs: DiffResult[],
  filesReviewed: number,
): string {
  return JSON.stringify(
    {
      filesReviewed,
      totalIssues: results.length,
      bySeverity: {
        error: results.filter((r) => r.severity === "error").length,
        warning: results.filter((r) => r.severity === "warning").length,
        info: results.filter((r) => r.severity === "info").length,
      },
      results: results.map((r) => ({
        file: r.file,
        line: r.line,
        severity: r.severity,
        category: r.category,
        message: r.message,
        fix: r.fix ?? null,
      })),
      diffs: diffs.map((d) => ({
        file: d.file,
        line: d.line,
        applied: d.applied,
        error: d.error ?? null,
      })),
    },
    null,
    2,
  );
}
