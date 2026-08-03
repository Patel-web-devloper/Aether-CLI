/**
 * Workflow command — runs multi-agent workflows via the Orchestrator.
 *
 * Called from cli.ts with a fully-initialised provider. Per the Aether
 * bundling convention this module never resolves providers itself — the
 * caller (cli.ts) owns the provider registry.
 */

import chalk from "chalk";
import type { LLMProvider } from "../providers/base.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import { loadAllWorkflows } from "../agents/workflows.js";
import type { AgentContext } from "../agents/base.js";
import type { EventBus } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import { resolve } from "node:path";

export interface WorkflowCommandOptions {
  workflowName?: string;
  prompt?: string;
  provider: LLMProvider;
  model?: string;
  targetDir: string;
  dryRun: boolean;
  json: boolean;
  list: boolean;
  orchestrator: Orchestrator;
  eventBus: EventBus;
  container: ServiceContainer;
}

export async function runWorkflowCommand(options: WorkflowCommandOptions): Promise<boolean> {
  const workflows = loadAllWorkflows();

  // ── --list: print available workflows ──────────────────────────────────
  if (options.list) {
    console.log(chalk.blue("\nAvailable workflows:"));
    for (const wf of workflows) {
      console.log(`  ${chalk.cyan(wf.name.padEnd(16))} ${chalk.dim(wf.description)}`);
      console.log(chalk.dim(`      steps: ${wf.steps.map((s) => s.agent).join(" → ")}`));
    }
    console.log("");
    return true;
  }

  // ── Validate args ──────────────────────────────────────────────────────
  if (!options.workflowName) {
    console.error(chalk.red("Error: workflow name required (see `aether workflow --list`)."));
    return false;
  }
  const workflow = workflows.find((w) => w.name === options.workflowName);
  if (!workflow) {
    console.error(
      chalk.red(`Unknown workflow "${options.workflowName}".`),
      chalk.gray(`Available: ${workflows.map((w) => w.name).join(", ")}`),
    );
    return false;
  }
  if (!options.prompt || options.prompt.trim() === "") {
    console.error(chalk.red("Error: a prompt is required (e.g. `aether workflow quick-build \"add a sum util\"`)."));
    return false;
  }

  // ── Header ─────────────────────────────────────────────────────────────
  const targetDir = resolve(options.targetDir);
  const context: AgentContext = {
    provider: options.provider,
    model: options.model,
    targetDir,
    eventBus: options.eventBus,
    container: options.container,
    dryRun: options.dryRun,
  };

  console.log(chalk.blue(`⚙️  Aether Workflow: ${workflow.name}`));
  console.log(chalk.gray(`   ${workflow.description}`));
  console.log(chalk.gray(`   Target: ${targetDir}`));
  console.log(chalk.gray(`   Provider: ${options.provider.name}`));
  if (options.model) console.log(chalk.gray(`   Model: ${options.model}`));
  console.log(chalk.gray(`   Steps: ${workflow.steps.map((s) => s.agent).join(" → ")}`));
  if (options.dryRun) {
    console.log(chalk.yellow("\n[DRY RUN] Steps are previewed — no LLM calls are made."));
  }
  console.log("");

  // ── Run ────────────────────────────────────────────────────────────────
  const result = await options.orchestrator.run(workflow, context, options.prompt);

  // ── Output ─────────────────────────────────────────────────────────────
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.success;
  }

  for (const step of result.steps) {
    const icon =
      step.status === "success"
        ? chalk.green("✓")
        : step.status === "skipped"
          ? chalk.yellow("⏭")
          : chalk.red("✗");
    const detail =
      step.status === "success"
        ? chalk.gray(` (${step.duration}ms)`)
        : step.status === "skipped"
          ? chalk.yellow(` (${step.error ?? "skipped"})`)
          : "";
    console.log(`  ${icon} ${chalk.bold(step.step)} ${chalk.dim(`[${step.agent}]`)}${detail}`);
    if (step.status === "failed" && step.error) {
      console.log(chalk.red(`      ${step.error}`));
    }
  }

  console.log("");
  const failed = result.steps.filter((s) => s.status === "failed").length;
  if (result.success) {
    console.log(chalk.green(`✅ Workflow "${workflow.name}" completed in ${result.duration}ms`));
  } else {
    console.log(
      chalk.red(`❌ Workflow "${workflow.name}" finished with ${failed} failed step(s) in ${result.duration}ms`),
    );
  }
  return result.success;
}
