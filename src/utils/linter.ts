/**
 * Lint integration for the review command.
 *
 * If ESLint or Biome is available in the project, runs it and merges
 * deterministic lint results with the LLM-based review.
 * Falls back gracefully if no linter is present.
 */

import type { ReviewResult } from "../agents/reviewer.js";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LintOptions {
  /** Project root directory. */
  projectRoot: string;
  /** Specific files to lint (if empty, lints the whole project). */
  files?: string[];
}

/** Result from linting a project. */
export interface LintResults {
  /** Merged review results from linter output. */
  results: ReviewResult[];
  /** Whether a linter was found and used. */
  linterUsed: boolean;
  /** Name of the linter used (or null). */
  linterName: string | null;
  /** Human-readable note about what happened. */
  note: string;
}

/**
 * Detect and run an available linter, merging its results into ReviewResult format.
 */
export async function runLinter(options: LintOptions): Promise<LintResults> {
  const root = resolve(options.projectRoot);

  // ── Check for Biome ──────────────────────────────────────────────────
  const biomeConfig = findConfig(root, ["biome.json", "biome.jsonc"]);
  const biomeAvailable = await isCommandAvailable("biome");

  if (biomeConfig && biomeAvailable) {
    return runBiome(root, options.files);
  }

  // ── Check for ESLint ─────────────────────────────────────────────────
  const eslintConfig = findConfig(root, [
    ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml",
    ".eslintrc.json", ".eslintrc", "eslint.config.js", "eslint.config.mjs",
    "eslint.config.cjs", "eslint.config.ts",
  ]);
  const eslintAvailable = await isCommandAvailable("eslint");

  if (eslintConfig && eslintAvailable) {
    return runESLint(root, options.files);
  }

  // ── No linter found ──────────────────────────────────────────────────
  // Check if they're installed locally
  const localBiome = join(root, "node_modules", ".bin", "biome");
  const localEslint = join(root, "node_modules", ".bin", "eslint");

  if (existsSync(localBiome)) {
    return runLocalBiome(root, localBiome, options.files);
  }
  if (existsSync(localEslint)) {
    return runLocalESLint(root, localEslint, options.files);
  }

  return {
    results: [],
    linterUsed: false,
    linterName: null,
    note: "No linter (ESLint or Biome) detected in this project. Install one to combine deterministic linting with LLM review.",
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function findConfig(root: string, names: string[]): string | null {
  for (const name of names) {
    const full = join(root, name);
    if (existsSync(full)) return full;
  }
  return null;
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

// ── Biome integration ────────────────────────────────────────────────────

async function runBiome(
  root: string,
  files?: string[],
): Promise<LintResults> {
  const args = ["lint", "--formatter=json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(root);
  }

  try {
    const { stdout } = await execFileAsync("biome", args, {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    const results = parseBiomeOutput(stdout, root);
    return {
      results,
      linterUsed: true,
      linterName: "Biome",
      note: `Biome found ${results.length} issue(s).`,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    // Biome exits with code 1 when lint issues are found — that's expected
    if (execErr.stdout) {
      const results = parseBiomeOutput(execErr.stdout, root);
      return {
        results,
        linterUsed: true,
        linterName: "Biome",
        note: `Biome found ${results.length} issue(s).`,
      };
    }
    return {
      results: [],
      linterUsed: true,
      linterName: "Biome",
      note: `Biome ran but produced no parseable output: ${execErr.stderr ?? "unknown error"}`,
    };
  }
}

async function runLocalBiome(
  root: string,
  binPath: string,
  files?: string[],
): Promise<LintResults> {
  const args = ["lint", "--formatter=json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(root);
  }

  try {
    const { stdout } = await execFileAsync(binPath, args, {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    const results = parseBiomeOutput(stdout, root);
    return {
      results,
      linterUsed: true,
      linterName: "Biome (local)",
      note: `Biome found ${results.length} issue(s).`,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) {
      const results = parseBiomeOutput(execErr.stdout, root);
      return {
        results,
        linterUsed: true,
        linterName: "Biome (local)",
        note: `Biome found ${results.length} issue(s).`,
      };
    }
    return {
      results: [],
      linterUsed: true,
      linterName: "Biome (local)",
      note: `Biome ran but produced no parseable output.`,
    };
  }
}

function parseBiomeOutput(stdout: string, root: string): ReviewResult[] {
  const results: ReviewResult[] = [];
  try {
    const json = JSON.parse(stdout);
    const diagnostics = json?.diagnostics ?? [];

    for (const diag of diagnostics) {
      if (!diag || !diag.location) continue;

      const file = diag.location.path ?? diag.filePath ?? "";
      if (!file) continue;

      // Make path relative
      let relPath = file;
      if (file.startsWith(root)) {
        relPath = file.slice(root.length).replace(/^\//, "");
      }

      const line = diag.location.line ?? diag.location.startLine ?? 1;
      const severity = mapBiomeSeverity(diag.severity);
      const category = mapBiomeCategory(diag.category, diag.rule);
      const message = diag.content?.message ?? diag.message ?? diag.title ?? "Lint issue";
      const fix = diag.content?.suggestion ?? undefined;

      results.push({
        file: relPath,
        line: typeof line === "number" ? line : 1,
        severity,
        category,
        message: `[biome] ${message}`,
        fix,
      });
    }
  } catch {
    // JSON parse failed — not much we can do
  }
  return results;
}

function mapBiomeSeverity(sev: string): ReviewResult["severity"] {
  switch (sev?.toLowerCase()) {
    case "error":
    case "fatal":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

function mapBiomeCategory(cat: string, rule?: string): ReviewResult["category"] {
  const lower = (cat ?? rule ?? "").toLowerCase();
  if (lower.includes("security") || lower.includes("no-eval")) return "security";
  if (lower.includes("correctness") || lower.includes("bug")) return "bug";
  if (lower.includes("performance") || lower.includes("complexity")) return "performance";
  if (lower.includes("style") || lower.includes("format")) return "style";
  if (lower.includes("type") || lower.includes("ts")) return "typesafety";
  if (lower.includes("unused") || lower.includes("no-unused")) return "unused";
  return "style";
}

// ── ESLint integration ────────────────────────────────────────────────────

async function runESLint(
  root: string,
  files?: string[],
): Promise<LintResults> {
  const args = ["--format=json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(".");
  }

  try {
    const { stdout } = await execFileAsync("eslint", args, {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    const results = parseESLintOutput(stdout);
    return {
      results,
      linterUsed: true,
      linterName: "ESLint",
      note: `ESLint found ${results.length} issue(s).`,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) {
      const results = parseESLintOutput(execErr.stdout);
      return {
        results,
        linterUsed: true,
        linterName: "ESLint",
        note: `ESLint found ${results.length} issue(s).`,
      };
    }
    return {
      results: [],
      linterUsed: true,
      linterName: "ESLint",
      note: `ESLint ran but produced no parseable output.`,
    };
  }
}

async function runLocalESLint(
  root: string,
  binPath: string,
  files?: string[],
): Promise<LintResults> {
  const args = ["--format=json"];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(".");
  }

  try {
    const { stdout } = await execFileAsync(binPath, args, {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    const results = parseESLintOutput(stdout);
    return {
      results,
      linterUsed: true,
      linterName: "ESLint (local)",
      note: `ESLint found ${results.length} issue(s).`,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) {
      const results = parseESLintOutput(execErr.stdout);
      return {
        results,
        linterUsed: true,
        linterName: "ESLint (local)",
        note: `ESLint found ${results.length} issue(s).`,
      };
    }
    return {
      results: [],
      linterUsed: true,
      linterName: "ESLint (local)",
      note: `ESLint ran but produced no parseable output.`,
    };
  }
}

function parseESLintOutput(stdout: string): ReviewResult[] {
  const results: ReviewResult[] = [];
  try {
    const json = JSON.parse(stdout);

    // ESLint JSON format is an array of file results
    const files = Array.isArray(json) ? json : [json];

    for (const fileResult of files) {
      const filePath = fileResult.filePath ?? "";
      const messages = fileResult.messages ?? [];

      for (const msg of messages) {
        results.push({
          file: filePath,
          line: msg.line ?? 1,
          severity: mapESLintSeverity(msg.severity),
          category: mapESLintCategory(msg.ruleId),
          message: `[eslint] ${msg.message} (${msg.ruleId ?? "unknown"})`,
          fix: msg.fix?.text ?? msg.suggestions?.[0]?.desc ?? undefined,
        });
      }
    }
  } catch {
    // JSON parse failed
  }
  return results;
}

function mapESLintSeverity(sev: number): ReviewResult["severity"] {
  // ESLint: 0 = off, 1 = warning, 2 = error
  if (sev >= 2) return "error";
  if (sev === 1) return "warning";
  return "info";
}

function mapESLintCategory(ruleId: string | null): ReviewResult["category"] {
  if (!ruleId) return "style";
  const lower = ruleId.toLowerCase();
  if (lower.includes("security") || lower.includes("no-eval") || lower.includes("no-implied-eval")) return "security";
  if (lower.includes("no-unused") || lower.includes("no-undef")) return "unused";
  if (lower.includes("prefer-") || lower.includes("no-var")) return "performance";
  if (lower.includes("@typescript")) return "typesafety";
  return "style";
}
