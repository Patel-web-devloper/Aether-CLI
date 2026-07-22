/**
 * Auto-Fix utility for failing tests.
 *
 * When tests fail, feeds the failing test + source code back to the LLM
 * and asks for suggested fixes. Supports --fix flag to auto-apply.
 */

import type { LLMProvider, ChatMessage } from "../providers/base.js";
import type { TestFailure, TestRunResult } from "./runner.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import chalk from "chalk";

// ── public types ─────────────────────────────────────────────────────────

export interface FixOptions {
  /** LLM provider instance. */
  provider: LLMProvider;
  /** Model name. */
  model?: string;
  /** Project root directory. */
  cwd: string;
  /** Whether to auto-apply fixes. */
  apply: boolean;
  /** Whether to show diffs without applying. */
  dryRun: boolean;
  /** Max fix iterations. */
  maxIterations?: number;
}

export interface FixResult {
  /** Number of fixes generated. */
  fixesGenerated: number;
  /** Number of fixes applied. */
  fixesApplied: number;
  /** Number of fixes that failed to apply. */
  fixesFailed: number;
  /** Each individual fix detail. */
  details: FixDetail[];
}

export interface FixDetail {
  /** File path that was fixed. */
  file: string;
  /** Original test file content (before). */
  before: string;
  /** Fixed test file content (after). */
  after: string;
  /** Whether the fix was applied. */
  applied: boolean;
  /** Any error encountered. */
  error?: string;
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Attempt to fix failing tests by feeding failures back to the LLM.
 *
 * Returns a FixResult describing what was generated and applied.
 */
export async function autoFixTests(
  result: TestRunResult,
  options: FixOptions,
): Promise<FixResult> {
  if (result.failures.length === 0) {
    return { fixesGenerated: 0, fixesApplied: 0, fixesFailed: 0, details: [] };
  }

  const maxIter = options.maxIterations ?? 3;
  const allDetails: FixDetail[] = [];
  let fixesGenerated = 0;
  let fixesApplied = 0;
  let fixesFailed = 0;

  // Group failures by test file
  const byFile = groupFailuresByFile(result);

  for (const [testFile, failures] of byFile) {
    const absTestPath = resolve(options.cwd, testFile);

    if (!existsSync(absTestPath)) {
      allDetails.push({
        file: testFile,
        before: "",
        after: "",
        applied: false,
        error: `Test file not found: ${testFile}`,
      });
      fixesFailed++;
      continue;
    }

    // Read current test file content
    let testContent: string;
    try {
      testContent = await readFile(absTestPath, "utf-8");
    } catch {
      allDetails.push({
        file: testFile,
        before: "",
        after: "",
        applied: false,
        error: `Cannot read test file: ${testFile}`,
      });
      fixesFailed++;
      continue;
    }

    // Try to find the source file this test covers
    const sourceFile = inferSourceFile(testFile);
    const absSourcePath = resolve(options.cwd, sourceFile);
    let sourceContent = "";
    if (existsSync(absSourcePath)) {
      try {
        sourceContent = await readFile(absSourcePath, "utf-8");
      } catch {
        sourceContent = "// (unable to read source file)";
      }
    }

    // Build a prompt for the LLM
    const failureDescriptions = failures
      .map((f) => `- Test: ${f.name}\n  Error: ${f.message}`)
      .join("\n");

    const systemPrompt = buildFixPrompt(testFile, testContent, sourceFile, sourceContent, failureDescriptions);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Fix the failing tests. Output the full corrected test file content.",
      },
    ];

    // Call provider
    let fixContent: string;
    try {
      const response = await options.provider.chat(messages, {
        model: options.model,
        maxTokens: 8192,
        temperature: 0.2,
      });
      fixContent = response.content;
    } catch (err) {
      allDetails.push({
        file: testFile,
        before: testContent,
        after: "",
        applied: false,
        error: `Provider call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      fixesFailed++;
      continue;
    }

    // Extract code from response (strip markdown fences if present)
    const extracted = extractCode(fixContent);

    if (!extracted || extracted.trim().length === 0) {
      allDetails.push({
        file: testFile,
        before: testContent,
        after: fixContent,
        applied: false,
        error: "Provider returned empty fix content",
      });
      fixesFailed++;
      continue;
    }

    fixesGenerated++;
    const detail: FixDetail = {
      file: testFile,
      before: testContent,
      after: extracted,
      applied: false,
    };

    // Show diff
    if (options.dryRun || !options.apply) {
      console.log(formatFixDiff(detail));
    }

    // Apply fix
    if (options.apply) {
      try {
        mkdirSync(dirname(absTestPath), { recursive: true });
        await writeFile(absTestPath, extracted, "utf-8");
        detail.applied = true;
        fixesApplied++;
      } catch (err) {
        detail.error = `Write failed: ${err instanceof Error ? err.message : String(err)}`;
        fixesFailed++;
      }
    }

    allDetails.push(detail);
  }

  return { fixesGenerated, fixesApplied, fixesFailed, details: allDetails };
}

// ── helpers ──────────────────────────────────────────────────────────────

function groupFailuresByFile(
  result: TestRunResult,
): Map<string, TestFailure[]> {
  const map = new Map<string, TestFailure[]>();

  for (const f of result.failures) {
    // Try to extract file from failure metadata
    let file = f.file;

    // If no explicit file, try to find from raw output
    if (!file) {
      file = findFileInOutput(result.rawStdout, f.name);
    }

    // Fallback: use "unknown.test.ts"
    if (!file) file = "unknown.test.ts";

    const existing = map.get(file) ?? [];
    existing.push(f);
    map.set(file, existing);
  }

  return map;
}

function findFileInOutput(rawStdout: string, testName: string): string | undefined {
  // Look for file references near the test name in stdout
  const lines = rawStdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(testName)) {
      // Scan nearby lines for a file reference
      for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 3); j++) {
        const match = lines[j].match(/([\w\/.-]+\.(test|spec)\.(ts|js|tsx|jsx))/);
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

function inferSourceFile(testFile: string): string {
  return testFile
    .replace(/\.(test|spec)\./, ".")
    .replace(/__tests__\//, "")
    .replace(/\/test\//, "/");
}

function buildFixPrompt(
  testFile: string,
  testContent: string,
  sourceFile: string,
  sourceContent: string,
  failureDescriptions: string,
): string {
  return `You are Aether, a testing expert. The following test file has failing tests. Fix them.

Test file: ${testFile}
Source file: ${sourceFile}

Source code:
\`\`\`typescript
${sourceContent || "// (no source file found)"}
\`\`\`

Current test file:
\`\`\`typescript
${testContent}
\`\`\`

Failing tests:
${failureDescriptions}

Instructions:
- Fix the failing tests by correcting assertions, mocks, imports, or test logic
- Do NOT change the behavior of the source code — fix the tests to match the actual source behavior
- Maintain the existing test patterns, framework imports, and naming conventions
- If a test is fundamentally wrong (testing the wrong thing), rewrite it correctly
- If an import path is wrong, fix it
- If a mock is incorrect, correct it
- Output the COMPLETE corrected test file, including all passing tests
- Output ONLY the test file code in a code fence — no explanatory text

\`\`\`typescript
(full corrected test file here)
\`\`\``.trim();
}

function extractCode(response: string): string {
  // Try to extract code from markdown fence
  const fenceMatch = response.match(/```(?:typescript|ts|js|javascript)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // If no fence, return the raw response (strip any leading/trailing markdown)
  const cleaned = response.replace(/^```[\w]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  return cleaned.trim();
}

// ── diff display ─────────────────────────────────────────────────────────

function formatFixDiff(detail: FixDetail): string {
  const lines: string[] = [];
  lines.push(chalk.cyan(`\n─── Fix for ${detail.file} ───`));

  if (detail.error) {
    lines.push(chalk.red(`  Error: ${detail.error}`));
    return lines.join("\n");
  }

  if (detail.before === detail.after) {
    lines.push(chalk.dim("  (no changes)"));
    return lines.join("\n");
  }

  const beforeLines = detail.before.split("\n");
  const afterLines = detail.after.split("\n");
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  let changes = 0;
  const maxShow = 40;

  for (let i = 0; i < maxLen && changes < maxShow; i++) {
    const oldLine = beforeLines[i];
    const newLine = afterLines[i];
    if (oldLine !== newLine) {
      changes++;
      if (oldLine !== undefined) lines.push(chalk.red(`  - ${oldLine}`));
      if (newLine !== undefined) lines.push(chalk.green(`  + ${newLine}`));
    }
  }

  if (changes >= maxShow) {
    lines.push(chalk.dim(`  ... (${changes - maxShow} more changed lines)`));
  }
  if (changes === 0) {
    lines.push(chalk.dim("  (no line-level changes detected)"));
  }

  return lines.join("\n");
}

/**
 * Format a summary of fix results.
 */
export function formatFixSummary(result: FixResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Fix Summary:"));

  if (result.fixesGenerated === 0) {
    lines.push(chalk.dim("  No fixes needed — all tests passed."));
    return lines.join("\n");
  }

  if (result.fixesApplied > 0) {
    lines.push(chalk.green(`  ✓ ${result.fixesApplied} fix(es) applied`));
  }
  if (result.fixesGenerated - result.fixesApplied > 0) {
    lines.push(chalk.yellow(`  ◎ ${result.fixesGenerated - result.fixesApplied} fix(es) shown (use --fix to apply)`));
  }
  if (result.fixesFailed > 0) {
    lines.push(chalk.red(`  ✗ ${result.fixesFailed} fix(es) failed`));
    for (const d of result.details) {
      if (d.error) {
        lines.push(chalk.red(`    - ${d.file}: ${d.error}`));
      }
    }
  }

  return lines.join("\n");
}
