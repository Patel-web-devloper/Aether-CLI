/**
 * Test Runner — detects and executes the project's test runner.
 *
 * Supports: vitest, jest, bun test, mocha, node --test
 * Parses output to extract pass/fail counts, failures, and timing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import chalk from "chalk";

// ── public types ─────────────────────────────────────────────────────────

export type TestRunnerName = "vitest" | "jest" | "bun" | "mocha" | "node-test" | "unknown";

export interface TestRunOptions {
  /** Project root directory. */
  cwd: string;
  /** Specific test files or patterns to run (optional — runs all if empty). */
  files?: string[];
  /** Enable watch mode (passes --watch to runner). */
  watch?: boolean;
  /** Enable coverage (passes coverage flag to runner). */
  coverage?: boolean;
  /** Extra args to pass through to the runner. */
  extraArgs?: string[];
  /** Override detected runner. */
  runner?: TestRunnerName;
}

export interface TestFailure {
  /** Test name / description. */
  name: string;
  /** Error message. */
  message: string;
  /** File path, if extractable. */
  file?: string;
}

export interface TestRunResult {
  /** Whether all tests passed. */
  success: boolean;
  /** Total tests run. */
  total: number;
  /** Number passed. */
  passed: number;
  /** Number failed. */
  failed: number;
  /** Number skipped. */
  skipped: number;
  /** Execution time in ms. */
  durationMs: number;
  /** Detected runner. */
  runner: TestRunnerName;
  /** List of failures. */
  failures: TestFailure[];
  /** Raw stdout (for debugging). */
  rawStdout: string;
  /** Raw stderr. */
  rawStderr: string;
  /** Exit code from the test process. */
  exitCode: number;
}

// ── detection ─────────────────────────────────────────────────────────────

/**
 * Detect which test runner to use based on project config files.
 */
export function detectRunner(cwd: string): TestRunnerName {
  // Check config files
  if (existsSync(resolve(cwd, "vitest.config.ts")) || existsSync(resolve(cwd, "vitest.config.js"))) {
    return "vitest";
  }
  if (existsSync(resolve(cwd, "jest.config.ts")) || existsSync(resolve(cwd, "jest.config.js")) ||
      existsSync(resolve(cwd, "jest.config.json"))) {
    return "jest";
  }
  if (existsSync(resolve(cwd, ".mocharc.yml")) || existsSync(resolve(cwd, ".mocharc.json")) ||
      existsSync(resolve(cwd, ".mocharc.js"))) {
    return "mocha";
  }

  // Check package.json scripts
  try {
    const pkg = require(resolve(cwd, "package.json"));
    const scripts = pkg.scripts ?? {};
    const allScripts = Object.values(scripts).join(" ");
    if (allScripts.includes("vitest")) return "vitest";
    if (allScripts.includes("jest")) return "jest";
    if (allScripts.includes("mocha")) return "mocha";
    if (allScripts.includes("bun test")) return "bun";
    if (allScripts.includes("node --test")) return "node-test";

    // Check dependencies
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    if (deps.vitest) return "vitest";
    if (deps.jest) return "jest";
    if (deps.mocha) return "mocha";
  } catch {
    // no package.json — fall through
  }

  // Default to bun test (since Aether uses Bun)
  return "bun";
}

// ── execution ─────────────────────────────────────────────────────────────

/**
 * Run tests using the detected runner.
 */
export async function runTests(options: TestRunOptions): Promise<TestRunResult> {
  const runner = options.runner ?? detectRunner(options.cwd);

  const cmd = runnerCommand(runner);
  const args = buildRunnerArgs(runner, options);

  const startTime = Date.now();

  const result = await executeCommand(cmd, args, options.cwd, options.watch);

  const durationMs = Date.now() - startTime;

  // Parse output based on runner
  const parsed = parseRunnerOutput(runner, result.stdout, result.stderr);

  return {
    ...parsed,
    durationMs,
    runner,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function runnerCommand(runner: TestRunnerName): string {
  switch (runner) {
    case "bun": return "bun";
    case "node-test": return "node";
    default: return "npx";
  }
}

function buildRunnerArgs(runner: TestRunnerName, options: TestRunOptions): string[] {
  const args: string[] = [];

  switch (runner) {
    case "bun":
      args.push("test");
      if (options.coverage) args.push("--coverage");
      if (options.watch) args.push("--watch");
      break;
    case "vitest":
      args.push("vitest", "run");
      if (options.coverage) args.push("--coverage");
      if (options.watch) args.push("--watch");
      break;
    case "jest":
      args.push("jest");
      if (options.coverage) args.push("--coverage");
      if (options.watch) args.push("--watch");
      break;
    case "mocha":
      args.push("mocha");
      if (options.watch) args.push("--watch");
      // mocha coverage is handled by nyc, not a direct flag
      if (options.coverage) {
        // Use nyc if available
        args.unshift("nyc", "mocha");
        args.shift(); // remove initial mocha
        args.unshift("nyc");
        return ["nyc", "mocha", ...args.slice(1)];
      }
      break;
    case "node-test":
      args.push("--test");
      if (options.coverage) {
        // Node 22+ supports --experimental-test-coverage
        args.push("--experimental-test-coverage");
      }
      if (options.watch) args.push("--watch");
      break;
  }

  // Add test files if specified
  if (options.files && options.files.length > 0) {
    args.push(...options.files);
  }

  // Extra passthrough args
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  return args;
}

interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function executeCommand(
  cmd: string,
  args: string[],
  cwd: string,
  watch: boolean,
): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (watch) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (watch) {
        process.stderr.write(text);
      }
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn test runner: ${err.message}`));
    });

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        stdout,
        stderr: stderr + "\n[Test runner timed out after 5 minutes]",
        exitCode: 124,
      });
    }, 300_000);

    child.on("close", () => clearTimeout(timeout));
  });
}

// ── output parsing ────────────────────────────────────────────────────────

function parseRunnerOutput(
  runner: TestRunnerName,
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  switch (runner) {
    case "bun": return parseBunOutput(stdout, stderr);
    case "vitest": return parseVitestOutput(stdout, stderr);
    case "jest": return parseJestOutput(stdout, stderr);
    case "mocha": return parseMochaOutput(stdout, stderr);
    case "node-test": return parseNodeTestOutput(stdout, stderr);
    default: return parseGenericOutput(stdout, stderr);
  }
}

function parseBunOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  // Bun output: "✓ test name" / "✗ test name"
  // Summary: "3 pass" / "0 fail" / "5 tests"
  const combined = stdout + "\n" + stderr;

  const passMatch = combined.match(/(\d+)\s+pass/);
  const failMatch = combined.match(/(\d+)\s+fail/);
  const skipMatch = combined.match(/(\d+)\s+skip/);
  const totalMatch = combined.match(/(\d+)\s+tests/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed + skipped;

  const failures = extractBunFailures(combined);

  return { success: failed === 0, total, passed, failed, skipped, failures };
}

function extractBunFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const lines = output.split("\n");

  let inFailure = false;
  let currentName = "";
  let currentMsg = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Bun failure starts with ✗
    if (line.trimStart().startsWith("✗ ")) {
      if (inFailure && currentName) {
        failures.push({ name: currentName, message: currentMsg.trim() || "(no details)" });
      }
      currentName = line.trimStart().slice(2).trim();
      currentMsg = "";
      inFailure = true;
    } else if (inFailure && line.trimStart().startsWith("error:")) {
      currentMsg += line.trim() + "\n";
      // Also capture the next few lines as error context
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        currentMsg += lines[j].trim() + "\n";
      }
    }
  }

  if (inFailure && currentName) {
    failures.push({ name: currentName, message: currentMsg.trim() || "(no details)" });
  }

  return failures;
}

function parseVitestOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  const combined = stdout + "\n" + stderr;

  // Vitest output: "Tests  3 passed (5)" or "Tests  2 failed | 3 passed (5)"
  const testsMatch =
    combined.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(?:(\d+)\s+passed)?\s*\((\d+)\)/) ??
    combined.match(/(\d+)\s+tests?\s+passed/i) ??
    combined.match(/(\d+)\s+passed/i);

  let passed = 0, failed = 0, total = 0;

  if (testsMatch) {
    failed = testsMatch[1] ? parseInt(testsMatch[1], 10) : 0;
    passed = testsMatch[2] ? parseInt(testsMatch[2], 10) : parseInt(testsMatch[1] ?? "0", 10);
    total = testsMatch[3] ? parseInt(testsMatch[3], 10) : passed + failed;
  }

  // Also try the alternate format: "Snapshots:  0 total\n Time:  1.2s\n Ran all test suites."
  const numFailedMatch = combined.match(/(\d+)\s+failed/);
  if (numFailedMatch && failed === 0) {
    failed = parseInt(numFailedMatch[1], 10);
  }

  const failures = extractVitestFailures(combined);

  return { success: failed === 0, total: total || passed + failed, passed, failed, skipped: 0, failures };
}

function extractVitestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Vitest failure lines: " ❯ src/file.test.ts (3 tests | 1 failed)"
    // or "   × test name"
    const failMatch = line.match(/^\s*[×✕x]\s+(.+)/);
    if (failMatch) {
      const name = failMatch[1].trim();
      let msg = "";
      // Collect subsequent error lines
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith("✓") || next.startsWith("×") || next.startsWith("✕") || next.startsWith("❯")) break;
        msg += next + "\n";
      }
      // Try to get the file from context lines above
      let file: string | undefined;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const fileMatch = lines[j].match(/❯\s+(.+\.test\.\w+)/);
        if (fileMatch) {
          file = fileMatch[1].trim();
          break;
        }
      }
      failures.push({ name, message: msg.trim() || "(no details)", file });
    }
  }

  return failures;
}

function parseJestOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  const combined = stdout + "\n" + stderr;

  // Jest: "Tests: 3 passed, 5 total" or "Tests: 1 failed, 2 passed, 3 total"
  const testsMatch = combined.match(/Tests?:\s*(.+)/i);
  let passed = 0, failed = 0, total = 0;

  if (testsMatch) {
    const parts = testsMatch[1];
    const passMatch = parts.match(/(\d+)\s+passed/);
    const failMatch = parts.match(/(\d+)\s+failed/);
    const totalMatch = parts.match(/(\d+)\s+total/);

    passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;
  }

  const failures = extractJestFailures(combined);

  return { success: failed === 0, total, passed, failed, skipped: 0, failures };
}

function extractJestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Jest failures: "  ● test name"
    const failMatch = line.match(/^\s*[●•]\s+(.+)/);
    if (failMatch) {
      const name = failMatch[1].trim();
      let msg = "";
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const next = lines[j].trim();
        if (next.startsWith("●") || next.startsWith("✓") || next.startsWith("Tests:")) break;
        msg += next + "\n";
      }
      failures.push({ name, message: msg.trim() || "(no details)" });
    }
  }

  return failures;
}

function parseMochaOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  const combined = stdout + "\n" + stderr;

  // Mocha: "5 passing (20ms)" / "2 failing"
  const passMatch = combined.match(/(\d+)\s+passing/);
  const failMatch = combined.match(/(\d+)\s+failing/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const total = passed + failed;

  const failures = extractMochaFailures(combined);

  return { success: failed === 0, total, passed, failed, skipped: 0, failures };
}

function extractMochaFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  // Mocha: "  1) test name"
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s+\d+\)\s+(.+)/);
    if (match) {
      const name = match[1].trim();
      let msg = "";
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const next = lines[j].trim();
        if (!next || /^\d+\)/.test(next) || /^\d+\s+passing/.test(next)) break;
        msg += next + "\n";
      }
      failures.push({ name, message: msg.trim() || "(no details)" });
    }
  }

  return failures;
}

function parseNodeTestOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  const combined = stdout + "\n" + stderr;

  // node --test: "# tests 5" / "# pass 3" / "# fail 2"
  const totalMatch = combined.match(/#\s+tests\s+(\d+)/);
  const passMatch = combined.match(/#\s+pass\s+(\d+)/);
  const failMatch = combined.match(/#\s+fail\s+(\d+)/);

  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

  const failures = extractNodeTestFailures(combined);

  return { success: failed === 0, total, passed, failed, skipped: 0, failures };
}

function extractNodeTestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  // node --test: "✗ test name" with "  error:"
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*[✗]\s+(.+)/);
    if (match) {
      const name = match[1].trim();
      let msg = "";
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith("✗") || next.startsWith("✓")) break;
        msg += next + "\n";
      }
      failures.push({ name, message: msg.trim() || "(no details)" });
    }
  }

  return failures;
}

function parseGenericOutput(
  stdout: string,
  stderr: string,
): Pick<TestRunResult, "success" | "total" | "passed" | "failed" | "skipped" | "failures"> {
  // Fallback: assume exit code handled externally
  return { success: true, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
}

// ── display formatting ────────────────────────────────────────────────────

/**
 * Format test run results for terminal display.
 */
export function formatTestResults(result: TestRunResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("Test Results"));
  lines.push(chalk.gray(`  Runner: ${result.runner}`));
  lines.push(chalk.gray(`  Duration: ${result.durationMs}ms`));
  lines.push("");

  // Summary line
  const parts: string[] = [];
  if (result.passed > 0) parts.push(chalk.green(`${result.passed} passed`));
  if (result.failed > 0) parts.push(chalk.red(`${result.failed} failed`));
  if (result.skipped > 0) parts.push(chalk.yellow(`${result.skipped} skipped`));
  parts.push(chalk.gray(`${result.total} total`));
  lines.push(`  ${parts.join("  ")}`);

  // All-pass message
  if (result.success && result.total > 0) {
    lines.push("");
    lines.push(chalk.green("  ✓ All tests passed!"));
  }

  // Failures
  if (result.failures.length > 0) {
    lines.push("");
    lines.push(chalk.red.bold("  Failures:"));
    for (const f of result.failures) {
      lines.push(chalk.red(`    ✗ ${f.name}`));
      if (f.file) lines.push(chalk.dim(`      in ${f.file}`));
      if (f.message && f.message !== "(no details)") {
        const msgLines = f.message.split("\n").slice(0, 3);
        for (const ml of msgLines) {
          lines.push(chalk.dim(`      ${ml}`));
        }
        if (f.message.split("\n").length > 3) {
          lines.push(chalk.dim(`      ... (truncated)`));
        }
      }
    }
  }

  lines.push("");

  // Coverage hint
  if (result.rawStdout.includes("coverage") || result.rawStdout.includes("Coverage")) {
    lines.push(chalk.cyan("  ℹ Coverage report generated."));
    lines.push("");
  }

  return lines.join("\n");
}
