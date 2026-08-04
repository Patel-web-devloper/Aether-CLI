import { Agent, type AgentInput, type AgentContext, type AgentOutput } from "./base.js";
import type { ChatMessage } from "../providers/base.js";
import { GitUtils } from "../utils/git.js";

export type GitMode = "commit" | "review" | "changelog" | "branch-plan";

export class GitAgent extends Agent {
  readonly name = "git";
  readonly description = "Git intelligence: commit messages, PR review, changelogs, branch planning";
  readonly capabilities = ["git", "commit-messages", "pr-review", "changelog", "branch-planning"];

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    const mode = (input.options?.mode ?? "review") as GitMode;
    if (!GitUtils.isGitRepo(context.targetDir)) return { success: false, error: "Target is not a git repository", metadata: { agent: this.name, duration: 0 } };
    if (context.dryRun) return this.dryRunOutput(input, context);
    let source = "";
    let system: string;
    switch (mode) {
      case "commit":
        source = GitUtils.getDiff(context.targetDir, true);
        system = "You generate concise conventional commit messages. Return only the commit message, no quotes or markdown.";
        break;
      case "review":
        source = `${GitUtils.getDiff(context.targetDir, true)}\n${GitUtils.getDiff(context.targetDir)}`;
        system = "You are a meticulous pull request reviewer. Identify bugs, security issues, regressions and improvements. Return structured markdown with Summary, Findings (severity/file/line/reason), and Suggestions. If clean, say so.";
        break;
      case "changelog":
        source = GitUtils.getLog(context.targetDir, 100);
        system = "You write Keep-a-Changelog markdown. Group the supplied commits under Added, Changed, Fixed, Removed where appropriate. Do not invent changes.";
        break;
      case "branch-plan":
        source = `Current: ${GitUtils.getCurrentBranch(context.targetDir)}\nBranches: ${GitUtils.getBranches(context.targetDir).join(", ")}\nRecent history:\n${GitUtils.getLog(context.targetDir, 60)}`;
        system = "You are a git release strategist. Analyze branches and history, flag stale branches, and suggest a safe merge strategy. Return a clear markdown plan.";
        break;
      default: return { success: false, error: `Unsupported git mode: ${mode}`, metadata: { agent: this.name, duration: 0 } };
    }
    const response = await this.chat(context, [{ role: "system", content: system }, { role: "user", content: `${input.prompt || mode}\n\nGit data:\n${source || "(no data)"}` } as ChatMessage]);
    return { success: true, result: response.content, metadata: { agent: this.name, duration: 0, tokensUsed: response.usage?.totalTokens, modelUsed: response.model } };
  }
}
