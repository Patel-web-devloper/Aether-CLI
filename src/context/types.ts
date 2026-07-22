/**
 * Shared types for the context management system.
 */

/** A single indexed file entry. */
export interface FileIndexEntry {
  /** Relative path from project root. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Detected language (e.g. "TypeScript"). */
  language: string;
  /** Last modified timestamp (ms since epoch). */
  lastModified: number;
  /** Top-level symbol summary — function/class/export names. */
  symbols: string[];
}

/** The full file index. */
export interface FileIndex {
  /** Project root. */
  root: string;
  /** Hash of the project root path (used for caching). */
  projectHash: string;
  /** When the index was created. */
  indexedAt: number;
  /** All indexed entries, keyed by relative path. */
  entries: Map<string, FileIndexEntry>;
}

/** A chunk from a large file. */
export interface ContextChunk {
  /** Relative file path. */
  filePath: string;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
  /** The code content. */
  content: string;
  /** Estimated token count. */
  tokenCount: number;
  /** Symbol summary for this chunk (optional). */
  symbols?: string[];
}

/** A message in conversation history. */
export interface HistoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
  tokenCount: number;
}

/** A conversation session. */
export interface HistorySession {
  id: string;
  /** When the session was created. */
  createdAt: number;
  /** Last activity timestamp. */
  lastActiveAt: number;
  /** Model used for this session. */
  model: string;
  /** Messages in the session. */
  messages: HistoryMessage[];
  /** Accumulated stats. */
  messageCount: number;
  totalTokens: number;
}

/** The final context payload delivered to the LLM. */
export interface ContextPayload {
  /** System prompt enriched with project context. */
  systemPrompt: string;
  /** User message (original prompt). */
  userMessage: string;
  /** Relevant file chunks to inject. */
  chunks: ContextChunk[];
  /** Conversation history messages. */
  history: HistoryMessage[];
  /** Project config summary (package.json, etc.). */
  configSummary: string;
  /** Total estimated token count for the payload. */
  tokenCount: number;
  /** Token budget used / max. */
  tokenBudget: { used: number; max: number };
}

/** Options for context building. */
export interface ContextBuildOptions {
  /** Maximum context tokens (env: AETHER_MAX_CONTEXT_TOKENS, default: 128K). */
  maxTokens?: number;
  /** Specific files the user mentioned. */
  targetFiles?: string[];
  /** Whether to include conversation history. */
  includeHistory?: boolean;
  /** Whether to follow imports. */
  followImports?: boolean;
}

/** Options for the ContextManager. */
export interface ContextManagerOptions {
  /** Working directory / project root. */
  cwd: string;
  /** Max tokens for context building. */
  maxContextTokens?: number;
  /** Max history tokens (env: AETHER_MAX_HISTORY_TOKENS, default: 32K). */
  maxHistoryTokens?: number;
  /** Max messages in history (default: 50). */
  maxHistoryMessages?: number;
  /** Enable watch mode for live indexing. */
  watch?: boolean;
}
