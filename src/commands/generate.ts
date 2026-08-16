/**
 * Generate command — orchestrates the generation agent + file writer.
 *
 * Called from the CLI (cli.ts) with user-provided options.
 */

import chalk from "chalk";
import type { LLMProvider } from "../providers/base.js";
import {
  generateFromPrompt,
  type GeneratorMode,
  type GeneratorOptions,
} from "../agents/generator.js";
import { writeFiles, formatResults, type WriteOptions } from "../utils/writer.js";
import { MemoryStore } from "../memory/store.js";
import { resolve } from "node:path";

export interface GenerateCommandOptions {
  /** Prompt text. */
  prompt: string;
  /** Initialised provider instance. */
  provider: LLMProvider;
  /** Optional model name. */
  model?: string;
  /** Generation mode. */
  mode: GeneratorMode;
  /** Target directory. */
  target: string;
  /** Overwrite existing files. */
  force: boolean;
  /** Show previews without writing. */
  dryRun: boolean;
}

export interface GenerateCommandResult {
  success: boolean;
  filesWritten: number;
  filesSkipped: number;
}

/**
 * Run the full generate pipeline:
 *   scan context → call LLM → parse → write files.
 *
 * The caller is responsible for initialising the provider.
 */
export async function runGenerate(
  options: GenerateCommandOptions,
): Promise<GenerateCommandResult> {
  const targetDir = resolve(options.target);
  const provider = options.provider;

  // Get default model if not specified
  let model = options.model;
  if (!model) {
    try {
      const models = await provider.listModels();
      model = models[0];
    } catch {
      // Some providers may not support listing — use undefined
    }
  }

  // ── 2. Call generator ─────────────────────────────────────────────────
  let genResult;
  try {
    const genOpts: GeneratorOptions = {
      provider,
      model,
      mode: options.mode,
      targetDir,
      // Default store — persisted project memory (no-op when empty).
      memoryStore: new MemoryStore(),
    };
    genResult = await generateFromPrompt(options.prompt, genOpts);
  } catch (err: unknown) {
    console.error(
      chalk.red("Generation error:"),
      err instanceof Error ? err.message : String(err),
    );
    return { success: false, filesWritten: 0, filesSkipped: 0 };
  }

  // Show what we detected
  console.log(chalk.dim(`  Language: ${genResult.context.language}`));
  console.log(chalk.dim(`  Framework: ${genResult.context.framework}`));
  console.log(chalk.dim(`  Files in project: ${genResult.context.files.length}`));

  // ── 3. Write files ────────────────────────────────────────────────────
  const writerOpts: WriteOptions = {
    baseDir: targetDir,
    force: options.force,
    dryRun: options.dryRun,
  };

  const results = await writeFiles(genResult.files, writerOpts);

  // ── 4. Print summary ──────────────────────────────────────────────────
  console.log(formatResults(results));

  // ── 4b. Edit mode: applied patches + impact analysis ──────────────────
  if (genResult.patches && genResult.patches.length > 0) {
    for (const patch of genResult.patches) {
      const first = patch.hunks[0]?.startLine;
      const last = patch.hunks[patch.hunks.length - 1]?.endLine;
      if (first !== undefined && last !== undefined) {
        console.log(chalk.green(`  ✓ Applied patch to ${patch.path} (lines ${first}-${last})`));
      } else {
        console.log(chalk.green(`  ✓ Applied patch to ${patch.path}`));
      }
    }
    const affected = genResult.impact?.affectedFiles ?? [];
    if (affected.length > 0) {
      console.log(chalk.cyan(`  Impact: ${affected.join(", ")}`));
    } else if (genResult.impact) {
      console.log(chalk.dim("  Impact: none detected"));
    }
  }
  for (const warning of genResult.warnings ?? []) {
    console.log(chalk.yellow(`  ⚠ ${warning}`));
  }

  // ── 5. If dry-run, also print diffs ────────────────────────────────────
  if (options.dryRun) {
    for (const r of results) {
      if (r.diff) console.log(r.diff);
    }
  }

  const written = results.filter(
    (r) => r.status === "created" || r.status === "modified",
  ).length;
  const skipped = results.filter(
    (r) => r.status === "conflict" || r.status === "skipped" || r.status === "ignored",
  ).length;

  return { success: written > 0, filesWritten: written, filesSkipped: skipped };
}
