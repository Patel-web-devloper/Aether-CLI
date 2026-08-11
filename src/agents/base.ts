/**
 * Agent Base Class — shared lifecycle for all Aether agents.
 *
 * Every agent (generator, reviewer, tester, architect, planner, coder,
 * security, docs, devops, release) extends this class. The base handles
 * lifecycle hooks, timing, and event emission via the EventBus.
 *
 * The base class intentionally does NOT call the LLM itself — each agent
 * owns its prompting and provider calls (the protected `chat` helper just
 * standardises error wrapping and dry-run safety).
 */

import type { LLMProvider, ChatMessage, ChatResponse, ChatOptions } from "../providers/base.js";
import type { EventBus } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import { scanDirectory, type ProjectContext } from "../utils/scanner.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── shared types ──────────────────────────────────────────────────────────

/** A generated file ready to be written. */
export interface GeneratedFile {
  path: string;
  content: string;
  language?: string;
  action?: "create" | "edit";
}

/** A structured review/audit finding. */
export interface ReviewIssue {
  file: string;
  line: number;
  severity: string;
  category: string;
  message: string;
  fix?: string;
}

/** Input handed to an agent. */
export interface AgentInput {
  prompt: string;
  files?: string[];
  options?: Record<string, unknown>;
}

/** Project memory attached to the context by MemoryAgent.enrichContext. */
export interface MemoryContext {
  files: Array<{ path: string; summary: string }>;
  decisions: Array<{ question: string; answer: string; timestamp: number }>;
}

/** Execution context shared by every agent in a run. */
export interface AgentContext {
  provider: LLMProvider;
  model?: string;
  targetDir: string;
  eventBus: EventBus;
  container: ServiceContainer;
  dryRun: boolean;
  /** Project memory injected by MemoryAgent.enrichContext (when available). */
  memoryContext?: MemoryContext;
}

/** Output produced by an agent. */
export interface AgentOutput {
  success: boolean;
  result?: unknown;
  files?: GeneratedFile[];
  issues?: ReviewIssue[];
  error?: string;
  metadata: {
    agent: string;
    duration: number;
    tokensUsed?: number;
    modelUsed?: string;
    /** Project root this agent ran against (used by auto-memory persistence). */
    targetDir?: string;
  };
}

// ── base class ────────────────────────────────────────────────────────────

export abstract class Agent {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly capabilities: string[];

  /** Core agent logic — implemented by each subclass. Call `run()`, never this directly. */
  abstract execute(input: AgentInput, context: AgentContext): Promise<AgentOutput>;

  // ── Optional lifecycle hooks (subclasses override) ─────────────────────
  beforeExecute?(input: AgentInput, context: AgentContext): Promise<void>;
  /** Optional context enrichment hook, called immediately before execute. */
  enrichContext?(context: AgentContext): Promise<AgentContext>;
  afterExecute?(output: AgentOutput, context: AgentContext): Promise<void>;
  onError?(error: Error, context: AgentContext): Promise<void>;

  /**
   * Run the agent with the full lifecycle:
   *   beforeExecute → execute → afterExecute
   * Emits agent:start / agent:done / agent:error and tracks duration.
   */
  async run(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    const taskId = crypto.randomUUID();
    const startedAt = Date.now();

    context.eventBus.emit({
      type: "agent:start",
      agent: this.name,
      taskId,
      timestamp: startedAt,
    });

    try {
      if (this.beforeExecute) {
        await this.beforeExecute(input, context);
      }
      if (this.enrichContext) {
        context = await this.enrichContext(context);
      }

      const output = await this.execute(input, context);
      const duration = Date.now() - startedAt;

      output.metadata = {
        agent: this.name,
        duration,
        tokensUsed: output.metadata.tokensUsed,
        modelUsed: output.metadata.modelUsed ?? context.model,
        targetDir: context.targetDir,
      };

      if (this.afterExecute) {
        await this.afterExecute(output, context);
      }

      context.eventBus.emit({
        type: "agent:done",
        agent: this.name,
        taskId,
        result: output,
        duration,
      });

      return output;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const duration = Date.now() - startedAt;

      if (this.onError) {
        try {
          await this.onError(error, context);
        } catch {
          // a failing error-hook must never mask the original error
        }
      }

      context.eventBus.emit({
        type: "agent:error",
        agent: this.name,
        taskId,
        error,
        duration,
      });

      return {
        success: false,
        error: error.message,
        metadata: { agent: this.name, duration, modelUsed: context.model, targetDir: context.targetDir },
      };
    }
  }

  // ── shared helpers (used by subclasses) ────────────────────────────────

  /** Standard single-shot LLM call with uniform error wrapping. */
  protected async chat(
    context: AgentContext,
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<ChatResponse> {
    const chatOptions: ChatOptions = {
      model: context.model,
      maxTokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.3,
    };
    try {
      return await context.provider.chat(messages, chatOptions);
    } catch (err: unknown) {
      throw new Error(
        `${this.name} agent: provider call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Early-return output used by agents in dry-run mode (no LLM call). */
  protected dryRunOutput(input: AgentInput, context: AgentContext): AgentOutput {
    return {
      success: true,
      result: {
        dryRun: true,
        agent: this.name,
        prompt: input.prompt,
        files: input.files ?? [],
      },
      metadata: { agent: this.name, duration: 0, modelUsed: context.model },
    };
  }

  /** Scan the target directory for lightweight project context. */
  protected async scanContext(context: AgentContext): Promise<ProjectContext> {
    try {
      return await scanDirectory(context.targetDir);
    } catch {
      return {
        root: context.targetDir,
        fileTree: "(empty or new project)",
        language: "Unknown",
        framework: "None detected",
        configFiles: {},
        files: [],
      };
    }
  }

  /** Read files (relative to targetDir) for prompt context, with size caps. */
  protected async readFiles(
    context: AgentContext,
    files: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    const result: Array<{ path: string; content: string }> = [];
    const MAX_PER_FILE = 30_000;
    const MAX_TOTAL = 200_000;
    let total = 0;

    for (const f of files) {
      if (total >= MAX_TOTAL) break;
      const abs = resolve(context.targetDir, f);
      try {
        const raw = await readFile(abs, "utf-8");
        const content =
          raw.length > MAX_PER_FILE
            ? raw.slice(0, MAX_PER_FILE) + "\n// ... (truncated)"
            : raw;
        result.push({ path: f, content });
        total += content.length;
      } catch {
        // skip unreadable files
      }
    }
    return result;
  }

  /** Format read files for inclusion in a prompt. */
  protected formatFilesForPrompt(files: Array<{ path: string; content: string }>): string {
    return files.map((f) => `─── ${f.path} ───\n${f.content}`).join("\n\n");
  }
}
