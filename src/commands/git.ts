import chalk from "chalk";
import type { LLMProvider } from "../providers/base.js";
import { GitAgent, type GitMode } from "../agents/git.js";
import type { AgentContext } from "../agents/base.js";
import type { EventBus } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import { GitUtils } from "../utils/git.js";
import { resolve } from "node:path";

export interface GitCommandOptions {
  mode: GitMode; provider: LLMProvider; model?: string; targetDir: string; dryRun?: boolean;
  json?: boolean; noStage?: boolean; messageOnly?: boolean; prompt?: string;
}

export async function runGitCommand(options: GitCommandOptions, eventBus: EventBus, container: ServiceContainer): Promise<boolean> {
  const target = resolve(options.targetDir);
  if (!GitUtils.isGitRepo(target)) { console.error(chalk.red(`Error: ${target} is not a git repository.`)); return false; }
  if (options.mode === "commit" && !options.noStage && !options.messageOnly && !options.dryRun) GitUtils.stageAll(target);
  const context: AgentContext = { provider: options.provider, model: options.model, targetDir: target, eventBus, container, dryRun: Boolean(options.dryRun) };
  const result = await new GitAgent().run({ prompt: options.prompt ?? options.mode, options: { mode: options.mode } }, context);
  if (!result.success) { console.error(chalk.red(`Git ${options.mode} failed:`), result.error); return false; }
  const text = String(result.result ?? "");
  if (options.json) console.log(JSON.stringify({ mode: options.mode, result: text }, null, 2)); else console.log(text);
  if (options.mode === "commit" && !options.dryRun && !options.messageOnly) {
    const message = text.trim().replace(/^```(?:text|markdown)?\s*|```$/g, "").trim();
    if (message) GitUtils.commit(target, message);
  }
  return true;
}
