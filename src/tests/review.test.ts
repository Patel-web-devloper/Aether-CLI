/**
 * Integration tests for the review pipeline.
 *
 * Uses a mock provider to verify the full flow:
 *   scanner → reviewer → parser → differ → display
 *
 * Run: bun test src/tests/review.test.ts
 *   or: bun run src/tests/review.test.ts
 */

import { reviewTarget, filterBySeverity, type ReviewResult, type Severity } from "../agents/reviewer.js";
import { generateDiffs, formatJson, type DiffResult } from "../utils/differ.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ProviderFeature, StreamCallbacks } from "../providers/base.js";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock provider ────────────────────────────────────────────────────────

class MockProvider implements LLMProvider {
  readonly name = "Mock";
  readonly slug = "mock";
  private response: string;

  constructor(response: string) {
    this.response = response;
  }

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    return {
      content: this.response,
      model: "mock-model",
      finishReason: "stop",
    };
  }

  async streamChat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    callbacks?.onToken?.(this.response);
    callbacks?.onDone?.({
      content: this.response,
      model: "mock-model",
      finishReason: "stop",
    });
  }

  supportsFeature(_feature: ProviderFeature): boolean {
    return true;
  }

  async listModels(): Promise<string[]> {
    return ["mock-model"];
  }

  async initialize(): Promise<void> {
    // no-op
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "aether-review-"));
}

function makeProject(
  tmpDir: string,
  files: Array<{ path: string; content: string }>,
): void {
  for (const f of files) {
    const fullPath = join(tmpDir, f.path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, f.content, "utf-8");
  }
}

// ── Standard mock responses ──────────────────────────────────────────────

const mockResponseWithIssues = `### ISSUE: src/utils.ts:15
Severity: error
Category: security
Message: Possible SQL injection in query construction — use parameterized queries
Fix: Replace string concatenation with parameterized query: \`db.query("SELECT * FROM users WHERE id = $1", [userId])\`

### ISSUE: src/utils.ts:42
Severity: warning
Category: unused
Message: Variable 'tempResult' is assigned but never used
Fix: - const tempResult = processData(input);

### ISSUE: src/index.ts:10
Severity: warning
Category: style
Message: Use const instead of let for variable 'counter' — it is never reassigned
Fix: const counter = 0;

### ISSUE: src/index.ts:25
Severity: info
Category: performance
Message: Array.map inside a loop could be hoisted for better performance
Fix: Hoist the map callback to avoid recreating it on each iteration`;

const mockResponseNoIssues = `### NO_ISSUES

The code looks clean — no significant issues found. Good job!`;

const mockResponseEmpty = "";

// ── Tests ────────────────────────────────────────────────────────────────

async function testSingleFileReview() {
  console.log("TEST 1: Single file review with issues...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/utils.ts",
        content: `
// Utility functions
function buildQuery(userId: string): string {
  return "SELECT * FROM users WHERE id = '" + userId + "'";
}

function processData(input: unknown): string {
  const tempResult = String(input);
  return String(input);
}

export { buildQuery, processData };
`.trim(),
      },
    ]);

    const provider = new MockProvider(mockResponseWithIssues);

    const result = await reviewTarget({
      provider,
      target: join(tmpDir, "src/utils.ts"),
    });

    // Should have parsed issues (at minimum the ones referencing src/utils.ts)
    if (result.filesReviewed !== 1) {
      throw new Error(`Expected 1 file reviewed, got ${result.filesReviewed}`);
    }

    // The mock response mentions src/utils.ts and src/index.ts
    // The parser should catch issues for the file that exists
    const utilsIssues = result.results.filter((r) => r.file === "src/utils.ts");
    if (utilsIssues.length === 0) {
      throw new Error(`Expected issues for src/utils.ts, got none. Raw: ${result.raw.slice(0, 200)}`);
    }

    // Check issue structure
    const firstIssue = result.results[0];
    if (!firstIssue.file) throw new Error("Issue missing file path");
    if (!firstIssue.message) throw new Error("Issue missing message");
    if (!["error", "warning", "info"].includes(firstIssue.severity)) {
      throw new Error(`Invalid severity: ${firstIssue.severity}`);
    }
    if (!["security", "bug", "performance", "style", "typesafety", "unused"].includes(firstIssue.category)) {
      throw new Error(`Invalid category: ${firstIssue.category}`);
    }

    console.log(`  ✓ Found ${result.results.length} issue(s) in single file\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testDirectoryReview() {
  console.log("TEST 2: Directory review...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/utils.ts",
        content: "export const x = 1;\n",
      },
      {
        path: "src/index.ts",
        content: "let counter = 0;\nconsole.log(counter);\n",
      },
    ]);

    const provider = new MockProvider(mockResponseWithIssues);

    const result = await reviewTarget({
      provider,
      target: join(tmpDir, "src"),
    });

    if (result.filesReviewed < 1) {
      throw new Error(`Expected at least 1 file reviewed, got ${result.filesReviewed}`);
    }

    // Results should have been parsed from the mock response
    if (result.results.length === 0) {
      throw new Error(`Expected issues from directory review. Raw: ${result.raw.slice(0, 200)}`);
    }

    console.log(`  ✓ Found ${result.results.length} issue(s) across ${result.filesReviewed} file(s)\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testEmptyReview() {
  console.log("TEST 3: Empty review (no issues found)...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/clean.ts",
        content: "export const hello = 'world';\n",
      },
    ]);

    const provider = new MockProvider(mockResponseNoIssues);

    const result = await reviewTarget({
      provider,
      target: join(tmpDir, "src/clean.ts"),
    });

    if (result.results.length !== 0) {
      throw new Error(`Expected 0 issues for clean code, got ${result.results.length}`);
    }

    if (result.filesReviewed !== 1) {
      throw new Error(`Expected 1 file reviewed, got ${result.filesReviewed}`);
    }

    console.log("  ✓ Clean code returns no issues\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testEmptyProviderResponse() {
  console.log("TEST 4: Empty provider response handling...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/file.ts",
        content: "const x = 1;\n",
      },
    ]);

    const provider = new MockProvider(mockResponseEmpty);

    const result = await reviewTarget({
      provider,
      target: join(tmpDir, "src/file.ts"),
    });

    // Should not crash — just return empty results
    if (result.results.length !== 0) {
      throw new Error(`Expected 0 issues for empty response, got ${result.results.length}`);
    }

    console.log("  ✓ Empty provider response handled gracefully\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testSeverityFiltering() {
  console.log("TEST 5: Severity filtering...");

  // Create mock results directly
  const results: ReviewResult[] = [
    { file: "a.ts", line: 1, severity: "error", category: "security", message: "error 1" },
    { file: "a.ts", line: 2, severity: "warning", category: "style", message: "warning 1" },
    { file: "a.ts", line: 3, severity: "info", category: "performance", message: "info 1" },
    { file: "b.ts", line: 1, severity: "error", category: "bug", message: "error 2" },
    { file: "b.ts", line: 5, severity: "warning", category: "unused", message: "warning 2" },
  ];

    // Filter to only errors
    const errorsOnly = filterBySeverity(results, "error");
    if (errorsOnly.length !== 2) {
      throw new Error(`Expected 2 errors, got ${errorsOnly.length}`);
    }
    if (!errorsOnly.every((r) => r.severity === "error")) {
      throw new Error("Filtered result contains non-error items");
    }

    // Filter to errors + warnings
    const warnAndAbove = filterBySeverity(results, "warning");
    if (warnAndAbove.length !== 4) {
      throw new Error(`Expected 4 items (errors + warnings), got ${warnAndAbove.length}`);
    }

    // Filter to all
    const all = filterBySeverity(results, "info");
    if (all.length !== 5) {
      throw new Error(`Expected all 5 items, got ${all.length}`);
    }

    console.log("  ✓ Severity filtering works correctly\n");
}

async function testJsonOutput() {
  console.log("TEST 6: JSON output format...");

  const results: ReviewResult[] = [
    {
      file: "src/app.ts",
      line: 10,
      severity: "error",
      category: "security",
      message: "Hardcoded secret detected",
      fix: "Use environment variable",
    },
  ];
  const diffs: DiffResult[] = [
    {
      file: "src/app.ts",
      line: 10,
      before: "const key = 'sk-12345';",
      after: "const key = process.env.API_KEY;",
      applied: false,
    },
  ];

  const json = formatJson(results, diffs, 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("JSON output is not valid JSON");
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.filesReviewed !== 1) throw new Error("Wrong filesReviewed in JSON");
  if (obj.totalIssues !== 1) throw new Error("Wrong totalIssues in JSON");
  if ((obj.bySeverity as Record<string, number>)?.error !== 1) throw new Error("Wrong error count in JSON");

  const resultArr = obj.results as Array<Record<string, unknown>>;
  if (resultArr[0].file !== "src/app.ts") throw new Error("Wrong file in JSON results");
  if (resultArr[0].severity !== "error") throw new Error("Wrong severity in JSON results");

  console.log("  ✓ JSON output is valid and well-structured\n");
}

async function testDiffGeneration() {
  console.log("TEST 7: Diff generation from review results...");

  const tmpDir = makeTempDir();
  try {
    const fileContent = [
      "// Line 1",
      "const API_KEY = 'sk-1234567890'; // Line 2 — hardcoded secret",
      "// Line 3",
      "function doStuff(): void {",
      "  console.log(API_KEY); // Line 5",
      "}",
      "// Line 7",
    ].join("\n");

    makeProject(tmpDir, [{ path: "src/secrets.ts", content: fileContent }]);

    const results: ReviewResult[] = [
      {
        file: "src/secrets.ts",
        line: 2,
        severity: "error",
        category: "security",
        message: "Hardcoded API key",
        fix: "const API_KEY = process.env.API_KEY || '';",
      },
    ];

    const diffs = await generateDiffs(results, {
      baseDir: tmpDir,
      apply: false,
    });

    if (diffs.length !== 1) {
      throw new Error(`Expected 1 diff, got ${diffs.length}`);
    }

    const diff = diffs[0];
    if (diff.applied) throw new Error("Diff should not be applied without --apply");
    if (!diff.before) throw new Error("Diff missing before content");
    if (!diff.after) throw new Error("Diff missing after content");
    if (!diff.before.includes("sk-1234567890")) throw new Error("Diff before missing original content");

    // Now test with --apply
    const diffsApply = await generateDiffs(results, {
      baseDir: tmpDir,
      apply: true,
    });

    if (!diffsApply[0].applied) throw new Error("Diff should be applied");

    // Check file was actually modified
    const modified = readFileSync(join(tmpDir, "src/secrets.ts"), "utf-8");
    if (modified.includes("sk-1234567890")) {
      throw new Error("File still contains hardcoded secret after apply");
    }
    if (!modified.includes("process.env.API_KEY")) {
      throw new Error("File doesn't contain the fix after apply");
    }

    console.log("  ✓ Diff generation and apply work correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testTargetNotFound() {
  console.log("TEST 8: Target not found error handling...");

  const provider = new MockProvider(mockResponseNoIssues);

  try {
    await reviewTarget({
      provider,
      target: "/nonexistent/path/that/does/not/exist.ts",
    });
    throw new Error("Expected error for missing target");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not found")) {
      throw new Error(`Expected "not found" in error, got: ${msg}`);
    }
  }

  console.log("  ✓ Missing target throws proper error\n");
}

async function testNoReviewableFiles() {
  console.log("TEST 9: No reviewable files error handling...");

  const tmpDir = makeTempDir();
  try {
    // Create a directory with only non-reviewable files
    makeProject(tmpDir, [
      { path: "config.json", content: '{"key": "value"}' },
      { path: "README.md", content: "# Hello" },
    ]);

    const provider = new MockProvider(mockResponseNoIssues);

    try {
      await reviewTarget({
        provider,
        target: tmpDir,
      });
      throw new Error("Expected error for no reviewable files");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No reviewable files")) {
        throw new Error(`Expected "No reviewable files", got: ${msg}`);
      }
    }

    console.log("  ✓ No reviewable files throws proper error\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Run all tests ───────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  Aether CLI — Review Pipeline Tests    ║");
  console.log("╚════════════════════════════════════════╝\n");

  const tests = [
    testSingleFileReview,
    testDirectoryReview,
    testEmptyReview,
    testEmptyProviderResponse,
    testSeverityFiltering,
    testJsonOutput,
    testDiffGeneration,
    testTargetNotFound,
    testNoReviewableFiles,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err: unknown) {
      failed++;
      console.error(`  ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
