/**
 * Review command — orchestrates the review agent, linter, and differ.
 *
 * Called from the CLI (cli.ts) with user-provided options.
 */

import chalk from "chalk";
import ora from "ora";
import type { LLMProvider } from "../providers/base.js";
import {
  reviewTarget,
  type ReviewResult,
  type ReviewOptions,
  type Severity,
} from "../agents/reviewer.js";
import { generateDiffs, formatDiffs, formatJson, type DiffResult } from "../utils/differ.js";
import { runLinter } from "../utils/linter.js";
import { resolve } from "node:path";

export interface ReviewCommandOptions {
  /** Target file or directory. */
  target: string;
  /** Initialised provider instance. */
  provider: LLMProvider;
  /** Optional model name. */
  model?: string;
  /** Output as JSON. */
  json: boolean;
  /** Auto-apply suggested fixes. */
  apply: boolean;
  /** Filter results to this severity and above. */
  severity?: string;
  /** Dry run (show what would happen without API calls). */
  dryRun: boolean;
}

export interface ReviewCommandResult {
  success: boolean;
  totalIssues: number;
  errors: number;
  warnings: number;
  infos: number;
  lintIssues: number;
  filesReviewed: number;
  fixesApplied: number;
}

/**
 * Run the full review pipeline:
 *   resolve target → scan context → run linter → call LLM → parse → diff → display
 */
export async function runReview(
  options: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const absTarget = resolve(options.target);

  // ── Header ────────────────────────────────────────────────────────────
  console.log(chalk.blue("🔍 Aether Review"));
  console.log(chalk.gray(`   Target: ${options.target}`));
  console.log(chalk.gray(`   Provider: ${options.provider.name}`));
  if (options.model) console.log(chalk.gray(`   Model: ${options.model}`));

  if (options.dryRun) {
    console.log(chalk.yellow("\n[DRY RUN] No API calls will be made."));
    console.log(chalk.gray(`   Would scan: ${absTarget}`));
    console.log(chalk.gray(`   Would run linter if available`));
    console.log(chalk.gray(`   Would call ${options.provider.name} for review`));
    const fakeResult: ReviewCommandResult = {
      success: true,
      totalIssues: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      lintIssues: 0,
      filesReviewed: 0,
      fixesApplied: 0,
    };
    return fakeResult;
  }

  // ── 1. Run linter first (deterministic, fast) ────────────────────────
  let lintResults: ReviewResult[] = [];
  let lintNote = "";

  try {
    const spinner = ora("Running linter...").start();
    const lintOutput = await runLinter({ projectRoot: absTarget });
    lintResults = lintOutput.results;
    lintNote = lintOutput.note;
    if (lintOutput.linterUsed) {
      spinner.succeed(
        `${lintOutput.linterName}: ${lintOutput.results.length} issue(s)`,
      );
    } else {
      spinner.info(lintOutput.note);
    }
  } catch {
    // Linter errors are non-fatal
    lintNote = "Linter check skipped due to an error.";
  }

  // ── 2. Run LLM review ─────────────────────────────────────────────────
  let reviewSpinner = ora("Reviewing code with LLM...").start();

  let reviewResults: ReviewResult[] = [];
  let filesReviewed = 0;
  let rawResponse = "";

  try {
    const severityFilter: Severity | undefined = options.severity
      ? (options.severity.toLowerCase() as Severity)
      : undefined;

    // Validate severity filter
    if (
      severityFilter &&
      !["error", "warning", "info"].includes(severityFilter)
    ) {
      reviewSpinner.fail("Invalid severity filter");
      console.error(
        chalk.red(`Invalid severity: "${options.severity}". Use error, warning, or info.`),
      );
      process.exit(1);
    }

    const reviewOpts: ReviewOptions = {
      provider: options.provider,
      model: options.model,
      target: absTarget,
      severity: severityFilter,
    };

    const result = await reviewTarget(reviewOpts);
    reviewResults = result.results;
    filesReviewed = result.filesReviewed;
    rawResponse = result.raw;

    reviewSpinner.succeed(
      `Review complete — ${filesReviewed} file(s), ${reviewResults.length} issue(s) from LLM`,
    );
  } catch (err: unknown) {
    reviewSpinner.fail("Review failed");
    console.error(
      chalk.red("Error:"),
      err instanceof Error ? err.message : String(err),
    );
    return {
      success: false,
      totalIssues: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      lintIssues: lintResults.length,
      filesReviewed: 0,
      fixesApplied: 0,
    };
  }

  // ── 3. Merge linter results ──────────────────────────────────────────
  // Deduplicate by file+line match to avoid showing the same issue twice
  const mergedResults = mergeResults(reviewResults, lintResults);

  // ── 4. Generate diffs for fixable issues ──────────────────────────────
  let diffs: DiffResult[] = [];
  if (options.apply || !options.json) {
    const diffSpinner = ora("Generating diffs...").start();
    try {
      diffs = await generateDiffs(mergedResults, {
        baseDir: resolve(options.target),
        apply: options.apply,
      });
      const appliedCount = diffs.filter((d) => d.applied).length;
      if (options.apply && appliedCount > 0) {
        diffSpinner.succeed(`Applied ${appliedCount} fix(es)`);
      } else if (options.apply) {
        diffSpinner.info("No auto-fixable issues to apply");
      } else {
        diffSpinner.stop();
      }
    } catch {
      diffSpinner.fail("Diff generation encountered an error");
    }
  }

  // ── 5. Display results ────────────────────────────────────────────────
  const counts = countBySeverity(mergedResults);

  if (options.json) {
    console.log(formatJson(mergedResults, diffs, filesReviewed));
  } else {
    console.log(formatReviewTable(mergedResults));
    console.log(formatSummary(counts, lintNote, filesReviewed));

    // Show diffs if there are any (and not applying)
    if (diffs.length > 0 && !options.apply) {
      console.log(formatDiffs(diffs));
    }
  }

  return {
    success: counts.error === 0,
    totalIssues: mergedResults.length,
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    lintIssues: lintResults.length,
    filesReviewed,
    fixesApplied: diffs.filter((d) => d.applied).length,
  };
}

// ── display formatting ──────────────────────────────────────────────────

function formatReviewTable(results: ReviewResult[]): string {
  if (results.length === 0) {
    return chalk.green("\n✓ No issues found!\n");
  }

  const lines: string[] = [];
  let currentFile = "";

  for (const r of results) {
    if (r.file !== currentFile) {
      if (currentFile) lines.push("");
      lines.push(chalk.cyan(`\n📁 ${r.file}`));
      currentFile = r.file;
    }

    const icon = severityIcon(r.severity);
    const cat = chalk.dim(`[${r.category}]`);
    lines.push(
      `  ${icon} L${String(r.line).padStart(4, " ")} ${cat} ${r.message}`,
    );

    if (r.fix) {
      const fixPreview =
        r.fix.length > 80 ? r.fix.slice(0, 80) + "..." : r.fix;
      lines.push(chalk.dim(`      fix: ${fixPreview}`));
    }
  }

  return lines.join("\n");
}

function severityIcon(severity: Severity): string {
  switch (severity) {
    case "error":
      return chalk.red("✗");
    case "warning":
      return chalk.yellow("⚠");
    case "info":
      return chalk.blue("ℹ");
  }
}

function formatSummary(
  counts: { error: number; warning: number; info: number },
  lintNote: string,
  filesReviewed: number,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Summary:"));
  lines.push(
    `  ${filesReviewed} file(s) reviewed, ${counts.error + counts.warning + counts.info} issue(s) ` +
      `(${chalk.red(`${counts.error} errors`)}, ${chalk.yellow(`${counts.warning} warnings`)}, ${chalk.blue(`${counts.info} info`)})`,
  );

  if (lintNote) {
    lines.push(chalk.dim(`  ${lintNote}`));
  }

  return lines.join("\n");
}

function countBySeverity(results: ReviewResult[]) {
  return {
    error: results.filter((r) => r.severity === "error").length,
    warning: results.filter((r) => r.severity === "warning").length,
    info: results.filter((r) => r.severity === "info").length,
  };
}

// ── result merging ──────────────────────────────────────────────────────

/**
 * Merge LLM review results and linter results, deduplicating by file+line.
 * If both sources flag the same line, prefer the linter result (deterministic).
 */
function mergeResults(
  llm: ReviewResult[],
  lint: ReviewResult[],
): ReviewResult[] {
  const seen = new Set<string>();
  const merged: ReviewResult[] = [];

  // Linter results first (deterministic, more reliable)
  for (const r of lint) {
    const key = `${r.file}:${r.line}:${r.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }

  // Then LLM results (skip if already covered by linter at same file+line)
  for (const r of llm) {
    const key = `${r.file}:${r.line}:${r.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }

  // Sort by file, then line
  merged.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  return merged;
}
