/**
 * Context command — manages project context (index, stats, history).
 *
 * Subcommands:
 *   aether context index   — force re-index the project
 *   aether context stats   — show index size, chunk count, token usage
 *   aether context history — list/view/clear conversation sessions
 */

import chalk from "chalk";
import ora from "ora";
import { ContextManager } from "../context/manager.js";

export interface ContextCommandOptions {
  /** Working directory. */
  cwd: string;
  /** Enable watch mode for live indexing. */
  watch?: boolean;
}

// ── index ─────────────────────────────────────────────────────────────────

export async function runContextIndex(options: ContextCommandOptions): Promise<void> {
  const mgr = new ContextManager({ cwd: options.cwd, watch: options.watch });

  const spinner = ora("Indexing project...").start();
  try {
    const index = await mgr.reindex();
    spinner.succeed(`Indexed ${index.entries.size} file(s)`);

    // Show quick summary
    let totalSize = 0;
    const langCounts = new Map<string, number>();
    for (const e of index.entries.values()) {
      totalSize += e.size;
      langCounts.set(e.language, (langCounts.get(e.language) ?? 0) + 1);
    }

    console.log(chalk.gray(`  Total size: ${formatBytes(totalSize)}`));
    console.log(chalk.gray(`  Languages: ${[...langCounts.entries()].map(([l, c]) => `${l} (${c})`).join(", ")}`));

    if (options.watch) {
      console.log(chalk.cyan("  Watch mode enabled — index will update on file changes"));
    }
  } catch (err: unknown) {
    spinner.fail("Indexing failed");
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── stats ─────────────────────────────────────────────────────────────────

export async function runContextStats(options: ContextCommandOptions): Promise<void> {
  const mgr = new ContextManager({ cwd: options.cwd });

  const spinner = ora("Loading context stats...").start();
  try {
    await mgr.initialize();
    const stats = await mgr.getStats();
    spinner.stop();

    console.log(chalk.blue("Context Stats"));
    console.log(chalk.gray(`  Project: ${options.cwd}`));
    console.log("");
    console.log(chalk.bold("Index:"));
    console.log(`  Files indexed: ${chalk.cyan(String(stats.filesIndexed))}`);
    console.log(`  Total size:    ${chalk.cyan(formatBytes(stats.totalSizeBytes))}`);
    console.log(`  Est. chunks:   ${chalk.cyan(String(stats.chunkCount))}`);
    console.log("");
    console.log(chalk.bold("Token Budget:"));
    console.log(`  Max context:   ${chalk.cyan(formatTokens(stats.maxTokens))}`);
    console.log(`  Used (history):${chalk.cyan(formatTokens(stats.tokensUsed))}`);
    console.log("");
    console.log(chalk.bold("History:"));
    console.log(`  Session ID:    ${chalk.dim(stats.sessionId)}`);
    console.log(`  Messages:      ${chalk.cyan(String(stats.historyMessageCount))}`);
    console.log(`  Total tokens:  ${chalk.cyan(formatTokens(stats.historyTokens))}`);

    await mgr.destroy();
  } catch (err: unknown) {
    spinner.fail("Failed to load stats");
    console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── history ────────────────────────────────────────────────────────────────

export async function runContextHistory(
  action: "list" | "view" | "clear",
  sessionId?: string,
): Promise<void> {
  const mgr = new ContextManager({ cwd: process.cwd() });

  switch (action) {
    case "list": {
      const sessions = mgr.listHistorySessions();
      if (sessions.length === 0) {
        console.log(chalk.yellow("No saved sessions found."));
        return;
      }

      console.log(chalk.blue("Conversation History"));
      console.log("");
      for (const s of sessions) {
        const date = new Date(s.lastActiveAt).toLocaleString();
        const age = formatAge(Date.now() - s.lastActiveAt);
        console.log(`  ${chalk.cyan(s.id.slice(0, 8))}... ${chalk.gray(date)} (${age})`);
        console.log(`    Model: ${s.model}, Messages: ${s.messageCount}, Tokens: ${formatTokens(s.totalTokens)}`);
      }
      break;
    }

    case "view": {
      if (!sessionId) {
        console.error(chalk.red("Error: --session <id> required for view"));
        process.exit(1);
      }

      const loaded = await mgr.loadHistorySession(sessionId);
      if (!loaded) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }

      const messages = await mgr.getHistory();
      console.log(chalk.blue(`Session: ${sessionId.slice(0, 12)}...`));
      console.log("");

      for (const msg of messages) {
        const roleColor = msg.role === "user" ? chalk.green :
                          msg.role === "assistant" ? chalk.cyan : chalk.yellow;
        const preview = msg.content.length > 200
          ? msg.content.slice(0, 200) + "..."
          : msg.content;
        console.log(roleColor(`[${msg.role}]`) + ` (${msg.tokenCount} tokens)`);
        console.log(chalk.dim(preview));
        console.log("");
      }
      break;
    }

    case "clear": {
      if (sessionId) {
        const deleted = mgr.deleteHistorySession(sessionId);
        if (deleted) {
          console.log(chalk.green(`✓ Session ${sessionId.slice(0, 12)}... deleted`));
        } else {
          console.error(chalk.red(`Session not found: ${sessionId}`));
          process.exit(1);
        }
      } else {
        // Clear all sessions
        const sessions = mgr.listHistorySessions();
        for (const s of sessions) {
          mgr.deleteHistorySession(s.id);
        }
        console.log(chalk.green(`✓ ${sessions.length} session(s) cleared`));
      }
      break;
    }

    default:
      console.error(chalk.red(`Unknown history action: ${action}`));
      process.exit(1);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
