/**
 * Context manager — orchestrates indexer, chunker, history, and builder.
 *
 * Main entry point for agents. Provides lazy initialization, context building,
 * history management, and usage statistics.
 */

import { resolve, relative } from "node:path";
import { statSync } from "node:fs";
import type {
  FileIndex,
  FileIndexEntry,
  ContextChunk,
  HistoryMessage,
  HistorySession,
  ContextPayload,
  ContextBuildOptions,
  ContextManagerOptions,
} from "./types.js";

import { indexProject, invalidateCache, stopWatch } from "./indexer.js";
import { chunkFile, estimateTokens } from "./chunker.js";
import {
  createSession,
  loadSession,
  saveSession,
  getOrCreateSession,
  addMessage,
  addMessages,
  clearSession,
  getRecentMessages,
  listSessions,
  deleteSession,
} from "./history.js";
import { buildContext } from "./builder.js";

export type {
  FileIndex,
  FileIndexEntry,
  ContextChunk,
  HistoryMessage,
  HistorySession,
  ContextPayload,
  ContextBuildOptions,
  ContextManagerOptions,
};

export class ContextManager {
  private options: Required<ContextManagerOptions>;
  private _index: FileIndex | null = null;
  private _session: HistorySession | null = null;
  private _initialized = false;

  constructor(options: ContextManagerOptions) {
    this.options = {
      maxContextTokens: options.maxContextTokens ?? this._envInt("AETHER_MAX_CONTEXT_TOKENS", 128_000),
      maxHistoryTokens: options.maxHistoryTokens ?? this._envInt("AETHER_MAX_HISTORY_TOKENS", 32_000),
      maxHistoryMessages: options.maxHistoryMessages ?? this._envInt("AETHER_MAX_HISTORY_MESSAGES", 50),
      watch: options.watch ?? false,
      cwd: options.cwd,
    };
  }

  // ── initialization ─────────────────────────────────────────────────────

  /**
   * Ensure the manager is initialized. Called lazily on first use.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Index the project
    this._index = await indexProject(this.options.cwd, {
      watch: this.options.watch,
      onUpdate: (_idx, _changed) => {
        // Index updated in watch mode — no action needed, index is mutated
      },
    });

    // Load or create history session
    this._session = getOrCreateSession("default");

    this._initialized = true;
  }

  /**
   * Check if initialized, throw if not.
   */
  private async ensureInit(): Promise<void> {
    if (!this._initialized) await this.initialize();
  }

  // ── index access ───────────────────────────────────────────────────────

  get index(): FileIndex | null {
    return this._index;
  }

  /** Force re-index the project. */
  async reindex(): Promise<FileIndex> {
    invalidateCache(this.options.cwd);
    this._index = await indexProject(this.options.cwd, {
      force: true,
      watch: this.options.watch,
      onUpdate: (_idx, _changed) => { /* noop */ },
    });
    return this._index;
  }

  // ── context building ──────────────────────────────────────────────────

  /**
   * Build the optimal context payload for a prompt + target files.
   * This is the main entry point for agents.
   */
  async buildContextPayload(
    prompt: string,
    targetPath?: string,
    buildOpts?: ContextBuildOptions,
  ): Promise<ContextPayload> {
    await this.ensureInit();
    if (!this._index) throw new Error("Index not available");

    const opts: ContextBuildOptions = {
      maxTokens: buildOpts?.maxTokens ?? this.options.maxContextTokens,
      targetFiles: buildOpts?.targetFiles ?? [],
      includeHistory: buildOpts?.includeHistory ?? true,
      followImports: buildOpts?.followImports ?? true,
    };

    // If targetPath is provided, resolve it to relative paths
    if (targetPath) {
      const abs = resolve(this.options.cwd, targetPath);
      try {
        const st = statSync(abs);
        if (st.isFile()) {
          const relPath = relative(this.options.cwd, abs);
          // Put the target file first
          opts.targetFiles = [relPath, ...(opts.targetFiles ?? [])];
        }
      } catch {
        // target may not exist yet — ignore
      }
    }

    // Build the payload
    const payload = buildContext(prompt, this._index, opts);

    // Inject history
    if (opts.includeHistory && this._session) {
      const historyMessages = getRecentMessages(this._session, 20);
      const historyTokens = historyMessages.reduce((s, m) => s + m.tokenCount, 0);

      // Only include history if it fits within remaining budget
      if (payload.tokenCount + historyTokens <= (opts.maxTokens ?? this.options.maxContextTokens)) {
        payload.history = historyMessages;
        payload.tokenCount += historyTokens;
      } else {
        // Include fewer messages (newest first)
        const available = (opts.maxTokens ?? this.options.maxContextTokens) - payload.tokenCount;
        const limited: HistoryMessage[] = [];
        let used = 0;
        for (let i = historyMessages.length - 1; i >= 0; i--) {
          const m = historyMessages[i];
          if (used + m.tokenCount > available) break;
          limited.unshift(m);
          used += m.tokenCount;
        }
        payload.history = limited;
        payload.tokenCount += used;
      }
    }

    payload.tokenBudget = {
      used: payload.tokenCount,
      max: opts.maxTokens ?? this.options.maxContextTokens,
    };

    return payload;
  }

  // ── history management ─────────────────────────────────────────────────

  /**
   * Add a message to the current session's history.
   */
  async addToHistory(
    role: "system" | "user" | "assistant",
    content: string,
  ): Promise<void> {
    await this.ensureInit();
    if (!this._session) return;

    addMessage(this._session, role, content);
    saveSession(this._session);
  }

  /**
   * Add multiple messages at once.
   */
  async addMessagesToHistory(
    msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ): Promise<void> {
    await this.ensureInit();
    if (!this._session) return;

    addMessages(this._session, msgs);
    saveSession(this._session);
  }

  /**
   * Get recent history messages.
   */
  async getHistory(count?: number): Promise<HistoryMessage[]> {
    await this.ensureInit();
    if (!this._session) return [];
    return getRecentMessages(this._session, count);
  }

  /**
   * Clear the current session's history.
   */
  async clearHistory(): Promise<void> {
    await this.ensureInit();
    if (!this._session) return;
    clearSession(this._session);
    saveSession(this._session);
  }

  /**
   * List all saved history sessions.
   */
  listHistorySessions(): ReturnType<typeof listSessions> {
    return listSessions();
  }

  /**
   * Load a specific history session.
   */
  async loadHistorySession(sessionId: string): Promise<boolean> {
    const session = loadSession(sessionId);
    if (!session) return false;
    this._session = session;
    return true;
  }

  /**
   * Delete a history session.
   */
  deleteHistorySession(sessionId: string): boolean {
    return deleteSession(sessionId);
  }

  /**
   * Get the current session.
   */
  get session(): HistorySession | null {
    return this._session;
  }

  // ── chunking ───────────────────────────────────────────────────────────

  /**
   * Chunk a file directly. Used by agents for file-level chunking.
   */
  chunkFile(content: string, filePath: string): ContextChunk[] {
    return chunkFile(content, filePath);
  }

  // ── stats ─────────────────────────────────────────────────────────────

  /**
   * Get context usage statistics.
   */
  async getStats(): Promise<{
    filesIndexed: number;
    totalSizeBytes: number;
    chunkCount: number;
    tokensUsed: number;
    maxTokens: number;
    historyMessageCount: number;
    historyTokens: number;
    sessionId: string;
  }> {
    await this.ensureInit();

    const entries = this._index?.entries;
    let totalSizeBytes = 0;
    let chunkCount = 0;
    if (entries) {
      for (const e of entries.values()) {
        totalSizeBytes += e.size;
      }
      // Estimate chunk count: 1 per small file, more for large files
      for (const e of entries.values()) {
        const chunks = Math.max(1, Math.ceil(e.size / (4000 * 4)));
        chunkCount += chunks;
      }
    }

    return {
      filesIndexed: entries?.size ?? 0,
      totalSizeBytes,
      chunkCount,
      tokensUsed: this._session?.totalTokens ?? 0,
      maxTokens: this.options.maxContextTokens,
      historyMessageCount: this._session?.messageCount ?? 0,
      historyTokens: this._session?.totalTokens ?? 0,
      sessionId: this._session?.id ?? "none",
    };
  }

  // ── cleanup ────────────────────────────────────────────────────────────

  /**
   * Stop watching and cleanup.
   */
  async destroy(): Promise<void> {
    if (this._index) {
      stopWatch(this._index);
    }
    if (this._session) {
      saveSession(this._session);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private _envInt(name: string, defaultVal: number): number {
    if (typeof process === "undefined") return defaultVal;
    const val = process.env[name];
    if (!val) return defaultVal;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  }
}
