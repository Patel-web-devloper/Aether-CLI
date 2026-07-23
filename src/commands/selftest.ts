/**
 * Aether self-test — run the test suite programmatically.
 *
 * Runs all 67 existing tests and reports summary.
 *
 * Usage: aether self-test [--suite <name>]
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import chalk from "chalk";

const INSTALL_DIR = resolve(import.meta.dirname ?? process.cwd(), "../..");
const SRC_DIR = resolve(INSTALL_DIR, "src");

const TEST_SUITES: Record<string, { file: string; label: string; count: number }> = {
  generate: { file: "src/tests/generate.test.ts", label: "Generate Pipeline", count: 8 },
  review: { file: "src/tests/review.test.ts", label: "Review Pipeline", count: 9 },
  test: { file: "src/tests/test.test.ts", label: "Test Pipeline", count: 10 },
  context: { file: "src/tests/context.test.ts", label: "Context System", count: 23 },
  termux: { file: "src/tests/termux.test.ts", label: "Termux Detection", count: 17 },
};

export interface SelfTestOptions {
  suite?: string;
}

interface SuiteResult {
  name: string;
  label: string;
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  output?: string;
}

function runSuite(name: string, info: { file: string; label: string; count: number }): SuiteResult {
  const filePath = resolve(INSTALL_DIR, info.file);

  try {
    const result = execSync(`bun run ${filePath}`, {
      cwd: INSTALL_DIR,
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse output: look for "X passed, Y failed" or "all tests passed"
    let passed = info.count;
    let failed = 0;
    let ok = true;

    const lines = result.split("\n");
    for (const line of lines) {
      const match = line.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        passed = parseInt(match[1], 10);
        failed = parseInt(match[2], 10);
        ok = failed === 0;
        break;
      }
      // Also check for bun:test style output
      const bunMatch = line.match(/(\d+)\s+pass/);
      if (bunMatch) {
        const failMatch = line.match(/(\d+)\s+fail/);
        passed = parseInt(bunMatch[1], 10);
        failed = failMatch ? parseInt(failMatch[1], 10) : 0;
        ok = failed === 0;
      }
    }

    return {
      name,
      label: info.label,
      passed,
      failed,
      total: passed + failed,
      ok,
      output: result.slice(-500), // last 500 chars usually have the summary
    };
  } catch (err: unknown) {
    // Test failure (non-zero exit) — parse stderr/stdout
    const output = err instanceof Error && "stdout" in (err as Record<string, unknown>)
      ? ((err as Record<string, unknown>).stdout as string) ?? ""
      : "";
    const stderr = err instanceof Error && "stderr" in (err as Record<string, unknown>)
      ? ((err as Record<string, unknown>).stderr as string) ?? ""
      : "";

    const combined = output + stderr;
    let passed = 0;
    let failed = info.count;

    for (const line of combined.split("\n")) {
      const match = line.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        passed = parseInt(match[1], 10);
        failed = parseInt(match[2], 10);
        break;
      }
    }

    return {
      name,
      label: info.label,
      passed,
      failed,
      total: passed + failed || info.count,
      ok: failed === 0,
      output: combined.slice(-500),
    };
  }
}

export async function runSelfTest(options: SelfTestOptions): Promise<void> {
  console.log(chalk.blue("🧪 Aether CLI — Self-Test\n"));

  // Filter suites
  let suites = Object.entries(TEST_SUITES);
  if (options.suite) {
    const key = options.suite.toLowerCase();
    if (!TEST_SUITES[key]) {
      console.error(chalk.red(`Unknown test suite: "${options.suite}"`));
      console.error(chalk.gray(`Available: ${Object.keys(TEST_SUITES).join(", ")}`));
      process.exit(1);
    }
    suites = [[key, TEST_SUITES[key]]];
  }

  const results: SuiteResult[] = [];

  for (const [name, info] of suites) {
    console.log(chalk.gray(`  Running ${info.label} tests (${info.count} tests)...`));
    const result = runSuite(name, info);

    const icon = result.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${result.label}: ${result.passed} passed, ${result.failed} failed\n`);

    if (!result.ok && result.output) {
      // Show failure hints (last line of output)
      const lines = result.output.trim().split("\n");
      const lastLines = lines.slice(-3);
      for (const line of lastLines) {
        if (line.trim()) console.log(`    ${chalk.gray(line.trim())}`);
      }
      console.log("");
    }

    results.push(result);
  }

  // Summary
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const total = totalPassed + totalFailed;
  const allOk = results.every((r) => r.ok);

  console.log(`${"─".repeat(42)}`);
  console.log(`  Total: ${totalPassed} passed, ${totalFailed} failed, ${total} total`);
  console.log(`${"─".repeat(42)}\n`);

  if (allOk) {
    console.log(chalk.green("✓ All tests passed.\n"));
  } else {
    console.log(chalk.red(`✗ ${totalFailed} test(s) failed.\n`));
    process.exit(1);
  }
}
