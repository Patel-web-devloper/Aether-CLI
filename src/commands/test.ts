/**
 * Test command — orchestrates the test generation agent, runner, and fixer.
 *
 * Flow:
 *   1. Scan target → detect framework
 *   2. Generate tests (unless --run)
 *   3. Run tests
 *   4. If --fix and tests fail, attempt auto-fix loop (max 3 iterations)
 *   5. Report results
 */

import chalk from "chalk";
import ora from "ora";
import type { LLMProvider } from "../providers/base.js";
import {
  generateTests,
  type TesterOptions,
  type TestFramework,
} from "../agents/tester.js";
import { writeFiles, formatResults, type WriteOptions } from "../utils/writer.js";
import {
  runTests,
  detectRunner,
  formatTestResults,
  type TestRunnerName,
  type TestRunOptions,
} from "../utils/runner.js";
import {
  autoFixTests,
  formatFixSummary,
} from "../utils/fixer.js";
import { resolve, dirname, relative, extname, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { scanDirectory } from "../utils/scanner.js";

export interface TestCommandOptions {
  /** LLM provider instance (already initialised). */
  provider: LLMProvider;
  /** Optional model name. */
  model?: string;
  /** Target file or directory. */
  target: string;
  /** Override test framework. */
  framework?: string;
  /** Just run existing tests, don't generate new ones. */
  runOnly: boolean;
  /** Enable coverage collection. */
  coverage: boolean;
  /** Enable watch mode. */
  watch: boolean;
  /** Auto-fix failing tests. */
  fix: boolean;
  /** Show previews without writing or calling API. */
  dryRun: boolean;
  /** Specific test files to run (for --run mode without generation). */
  testFiles?: string[];
}

export interface TestCommandResult {
  success: boolean;
  testsGenerated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  fixesApplied: number;
}

/**
 * Run the full test pipeline.
 */
export async function runTestCommand(
  options: TestCommandOptions,
): Promise<TestCommandResult> {
  const targetAbs = resolve(options.target);
  const projectRoot = findProjectRootForTest(targetAbs);

  let testsGenerated = 0;
  let fixesApplied = 0;

  // ── Step 1: Generate tests (unless --run) ────────────────────────────
  if (!options.runOnly) {
    // Show header
    console.log(chalk.blue("🧪 Aether Test Generator"));
    console.log(chalk.gray(`   Target: ${options.target}`));

    if (options.dryRun) {
      console.log(chalk.yellow("\n[DRY RUN] No API calls or file writes."));

      // In dry-run mode, scan target and show what would happen without calling LLM
      try {
        let context;
        try {
          context = await scanDirectory(projectRoot);
        } catch {
          context = {
            root: projectRoot,
            fileTree: "(empty or new project)",
            language: "Unknown",
            framework: "None detected",
            configFiles: {},
            files: [],
          };
        }

        // Gather source files that would be tested
        const sourceFiles: string[] = [];
        const srcExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb"];

        if (existsSync(targetAbs)) {
          const st = statSync(targetAbs);
          if (st.isFile()) {
            const e = extname(targetAbs).toLowerCase();
            if (srcExts.includes(e) && !targetAbs.endsWith(".d.ts")) {
              sourceFiles.push(relative(context.root, targetAbs));
            }
          } else {
            const prefix = relative(context.root, targetAbs);
            const filePrefix = prefix === "" ? "" : prefix + "/";
            for (const f of context.files) {
              if (!f.startsWith(filePrefix)) continue;
              const base = basename(f);
              if (base.includes(".test.") || base.includes(".spec.")) continue;
              const e = extname(f).toLowerCase();
              if (srcExts.includes(e) && !f.endsWith(".d.ts")) {
                sourceFiles.push(f);
              }
            }
          }
        }

        // Detect framework
        let detectedFramework = "bun";
        const pkg = context.configFiles["package.json"] as Record<string, unknown> | undefined;
        const deps: Record<string, string> = {
          ...((pkg?.dependencies as Record<string, string>) ?? {}),
          ...((pkg?.devDependencies as Record<string, string>) ?? {}),
        };
        const depKeys = Object.keys(deps);
        if (depKeys.includes("vitest")) detectedFramework = "vitest";
        else if (depKeys.includes("jest")) detectedFramework = "jest";
        else if (depKeys.includes("mocha")) detectedFramework = "mocha";

        if (options.framework) detectedFramework = options.framework;

        const projectName =
          (pkg?.name as string) ?? basename(projectRoot);

        console.log(chalk.gray(`   Project: ${projectName}`));
        console.log(chalk.gray(`   Language: ${context.language}`));
        console.log(chalk.gray(`   Framework: ${detectedFramework}`));
        console.log("");

        if (sourceFiles.length === 0) {
          console.log(chalk.yellow("   No testable source files found at target."));
        } else {
          console.log(
            chalk.cyan(`Would generate tests for ${sourceFiles.length} source file(s):`),
          );
          for (const f of sourceFiles.slice(0, 20)) {
            const testPath = f.replace(extname(f), `.test${extname(f)}`);
            console.log(chalk.dim(`   - ${f} → ${testPath}`));
          }
          if (sourceFiles.length > 20) {
            console.log(chalk.dim(`   ... and ${sourceFiles.length - 20} more`));
          }
        }

        return {
          success: true,
          testsGenerated: sourceFiles.length,
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          fixesApplied: 0,
        };
      } catch (err) {
        console.error(
          chalk.red("Dry-run error:"),
          err instanceof Error ? err.message : String(err),
        );
        return {
          success: false,
          testsGenerated: 0,
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          fixesApplied: 0,
        };
      }
    }

    // ── Generation phase ────────────────────────────────────────────────
    const genSpinner = ora("Generating tests...").start();

    let genResult;
    try {
      genResult = await generateTests({
        provider: options.provider,
        model: options.model,
        target: options.target,
        framework: options.framework as TestFramework | undefined,
      });
    } catch (err) {
      genSpinner.fail("Test generation failed");
      console.error(
        chalk.red("Error:"),
        err instanceof Error ? err.message : String(err),
      );
      return {
        success: false,
        testsGenerated: 0,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        fixesApplied: 0,
      };
    }

    genSpinner.succeed(
      `Generated ${genResult.files.length} test file(s)`,
    );

    console.log(chalk.gray(`   Framework: ${genResult.framework}`));
    console.log(chalk.gray(`   Project: ${genResult.projectName}`));
    console.log(chalk.gray(`   Language: ${genResult.context.language}`));

    // ── Write test files ────────────────────────────────────────────────
    const writerOpts: WriteOptions = {
      baseDir: options.runOnly ? projectRoot : projectRoot,
      force: true, // always overwrite for test gen
      dryRun: false,
    };

    // Resolve test file paths relative to the project root
    const genFiles = genResult.files.map((f) => ({
      path: f.path,
      content: f.content,
      action: "upsert" as const,
    }));

    const writeResults = await writeFiles(genFiles, writerOpts);
    console.log(formatResults(writeResults));

    testsGenerated = writeResults.filter(
      (r) => r.status === "created" || r.status === "modified",
    ).length;
  }

  // ── Step 2: Run tests ────────────────────────────────────────────────

  // Detect runner
  let runner: TestRunnerName;
  try {
    runner = detectRunner(projectRoot);
  } catch {
    runner = "bun"; // default
  }

  console.log("");
  const runSpinner = ora(`Running tests (${runner})...`).start();

  let testResult;
  try {
    const runnerOpts: TestRunOptions = {
      cwd: projectRoot,
      files: options.testFiles,
      coverage: options.coverage,
      watch: options.watch,
      runner,
    };

    testResult = await runTests(runnerOpts);
  } catch (err) {
    runSpinner.fail("Test execution failed");
    console.error(
      chalk.red("Error:"),
      err instanceof Error ? err.message : String(err),
    );
    return {
      success: false,
      testsGenerated,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      fixesApplied,
    };
  }

  runSpinner.stop();
  console.log(formatTestResults(testResult));

  // ── Step 3: Auto-fix if enabled and tests failed ─────────────────────
  if (options.fix && testResult.failed > 0) {
    console.log(chalk.yellow("\n🔧 Attempting to auto-fix failing tests..."));

    // Try up to 3 fix-run iterations
    for (let iter = 1; iter <= 3; iter++) {
      const fixSpinner = ora(`Fix iteration ${iter}/3...`).start();

      let fixResult;
      try {
        fixResult = await autoFixTests(testResult, {
          provider: options.provider,
          model: options.model,
          cwd: projectRoot,
          apply: true,
          dryRun: false,
          maxIterations: 1,
        });
      } catch (err) {
        fixSpinner.fail(`Fix iteration ${iter} failed`);
        console.error(
          chalk.red("Fix error:"),
          err instanceof Error ? err.message : String(err),
        );
        break;
      }

      fixSpinner.stop();

      if (fixResult.fixesApplied === 0) {
        console.log(chalk.dim("  No fixes could be applied."));
        break;
      }

      fixesApplied += fixResult.fixesApplied;
      console.log(
        chalk.green(`  ✓ ${fixResult.fixesApplied} fix(es) applied`),
      );

      // Re-run tests
      const rerunSpinner = ora("Re-running tests...").start();
      try {
        testResult = await runTests({
          cwd: projectRoot,
          files: options.testFiles,
          coverage: options.coverage,
          watch: false,
          runner,
        });
      } catch {
        rerunSpinner.fail("Re-run failed");
        break;
      }
      rerunSpinner.stop();
      console.log(formatTestResults(testResult));

      if (testResult.failed === 0) {
        console.log(chalk.green("  ✓ All tests pass after fixes!"));
        break;
      }
    }

    console.log(formatFixSummary({
      fixesGenerated: fixesApplied,
      fixesApplied,
      fixesFailed: 0,
      details: [],
    }));
  }

  // ── Final report ─────────────────────────────────────────────────────
  console.log("");
  if (testResult.success) {
    console.log(chalk.green.bold("✓ All tests passed"));
  } else {
    console.log(
      chalk.red.bold(
        `✗ ${testResult.failed} test(s) failed`,
      ),
    );
  }

  return {
    success: testResult.success,
    testsGenerated,
    testsRun: testResult.total,
    testsPassed: testResult.passed,
    testsFailed: testResult.failed,
    fixesApplied,
  };
}

/**
 * Find the project root for test operations.
 */
function findProjectRootForTest(start: string): string {
  let dir = statSync(start).isDirectory() ? start : dirname(start);
  const markers = [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
  ];

  while (true) {
    for (const m of markers) {
      if (existsSync(resolve(dir, m))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return statSync(start).isDirectory() ? start : dirname(start);
}
