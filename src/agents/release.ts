/**
 * Release Agent — release management.
 *
 * Reads git history to summarize changes, then generates version bumps,
 * changelogs, release notes, and tag/publish instructions.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput } from "./base.js";
import { execFileSync } from "node:child_process";
import type { ChatMessage } from "../providers/base.js";

const MAX_COMMITS = 40;

export class ReleaseAgent extends Agent {
  readonly name = "release";
  readonly description = "Release management: changelogs from git history, release notes, version bumps, tag instructions";
  readonly capabilities = ["release-management", "changelog", "git"];

  private readonly systemPrompt = `You are the Release agent in Aether CLI. You prepare software releases.

Your job:
- Summarize changes since the last release from the git history provided.
- Propose a semantic-version bump (major/minor/patch) with justification.
- Write a changelog entry in Keep-a-Changelog format (Added/Changed/Fixed/Removed).
- Write concise release notes (user-facing, no internal jargon).
- Give exact tag and publish instructions (git tag, git push, npm/pypi/cargo publish as applicable).

Output format (markdown):
# Release Notes — v<proposed version>
## Version Bump & Justification
## Changelog
## Release Notes
## Tag & Publish Instructions

Use the git history verbatim as the source of truth — never invent commits.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const gitLog = this.readGitLog(context.targetDir);
    const gitStatus = this.readGitStatus(context.targetDir);

    const userPrompt =
      `Git history (last ${MAX_COMMITS} commits):\n${gitLog || "(not a git repository — no history available)"}\n\n` +
      (gitStatus ? `Working tree status:\n${gitStatus}\n\n` : "") +
      `Release request:\n${input.prompt}`;

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.chat(context, messages, { maxTokens: 4096, temperature: 0.2 });

    return {
      success: true,
      result: response.content,
      metadata: {
        agent: this.name,
        duration: 0,
        tokensUsed: response.usage?.totalTokens,
        modelUsed: response.model,
      },
    };
  }

  private readGitLog(cwd: string): string {
    try {
      return execFileSync(
        "git",
        ["log", `--max-count=${MAX_COMMITS}`, "--pretty=format:%h %ad %s", "--date=short"],
        { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return "";
    }
  }

  private readGitStatus(cwd: string): string {
    try {
      return execFileSync(
        "git",
        ["status", "--short"],
        { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return "";
    }
  }
}
