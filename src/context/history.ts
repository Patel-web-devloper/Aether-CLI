/**
 * Conversation history — rolling, token-aware, file-persisted.
 *
 * - Maintains last N messages (default: 50)
 * - Token-aware pruning when history exceeds AETHER_MAX_HISTORY_TOKENS (default: 32K)
 * - Save/load from ~/.local/share/aether/history/{session_id}.json
 * - Support for listing, loading, clearing sessions
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HistorySession, HistoryMessage } from "./types.js";
import { estimateTokens } from "./chunker.js";

// ── config ─────────────────────────────────────────────────────────────────

function historyDir(): string {
  const dir = join(homedir(), ".local", "share", "aether", "history");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function maxHistoryMessages(): number {
  const env = typeof process !== "undefined" ? process.env.AETHER_MAX_HISTORY_MESSAGES : undefined;
  if (env) {
    const p = parseInt(env, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  return 50;
}

function maxHistoryTokens(): number {
  const env = typeof process !== "undefined" ? process.env.AETHER_MAX_HISTORY_TOKENS : undefined;
  if (env) {
    const p = parseInt(env, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  return 32_000;
}

// ── session management ─────────────────────────────────────────────────────

/**
 * Create a new history session.
 */
export function createSession(model: string = "unknown"): HistorySession {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    model,
    messages: [],
    messageCount: 0,
    totalTokens: 0,
  };
}

/**
 * Load a session from disk. Returns null if not found.
 */
export function loadSession(sessionId: string): HistorySession | null {
  const path = join(historyDir(), `${sessionId}.json`);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as HistorySession;
  } catch {
    return null;
  }
}

/**
 * Save a session to disk.
 */
export function saveSession(session: HistorySession): void {
  const dir = historyDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session.id}.json`);
  writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
}

/**
 * Delete a session from disk.
 */
export function deleteSession(sessionId: string): boolean {
  const path = join(historyDir(), `${sessionId}.json`);
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all saved sessions.
 */
export function listSessions(): Array<{
  id: string;
  createdAt: number;
  lastActiveAt: number;
  model: string;
  messageCount: number;
  totalTokens: number;
}> {
  const dir = historyDir();
  if (!existsSync(dir)) return [];

  const sessions: Array<{
    id: string;
    createdAt: number;
    lastActiveAt: number;
    model: string;
    messageCount: number;
    totalTokens: number;
  }> = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const session = JSON.parse(raw) as HistorySession;
        sessions.push({
          id: session.id,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          model: session.model,
          messageCount: session.messageCount,
          totalTokens: session.totalTokens,
        });
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // Read error
  }

  // Sort by last active, newest first
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return sessions;
}

/**
 * Get the most recent session, or create one.
 */
export function getOrCreateSession(model: string = "unknown"): HistorySession {
  const sessions = listSessions();
  if (sessions.length > 0) {
    const loaded = loadSession(sessions[0].id);
    if (loaded) return loaded;
  }
  return createSession(model);
}

// ── message management ─────────────────────────────────────────────────────

/**
 * Add a message to a session. Handles pruning automatically.
 */
export function addMessage(
  session: HistorySession,
  role: "system" | "user" | "assistant",
  content: string,
): HistoryMessage {
  const msg: HistoryMessage = {
    role,
    content,
    timestamp: Date.now(),
    tokenCount: estimateTokens(content),
  };

  session.messages.push(msg);
  session.messageCount = session.messages.length;
  session.totalTokens += msg.tokenCount;
  session.lastActiveAt = Date.now();

  // Prune if needed
  prune(session);

  return msg;
}

/**
 * Add a batch of messages at once (prunes once at end).
 */
export function addMessages(
  session: HistorySession,
  msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): void {
  for (const m of msgs) {
    session.messages.push({
      role: m.role,
      content: m.content,
      timestamp: Date.now(),
      tokenCount: estimateTokens(m.content),
    });
  }
  session.messageCount = session.messages.length;
  session.totalTokens = session.messages.reduce((sum, m) => sum + m.tokenCount, 0);
  session.lastActiveAt = Date.now();
  prune(session);
}

/**
 * Clear all messages from a session.
 */
export function clearSession(session: HistorySession): void {
  session.messages = [];
  session.messageCount = 0;
  session.totalTokens = 0;
  session.lastActiveAt = Date.now();
}

/**
 * Get recent messages, optionally limited by count.
 */
export function getRecentMessages(session: HistorySession, count?: number): HistoryMessage[] {
  if (count && count > 0) {
    return session.messages.slice(-count);
  }
  return [...session.messages];
}

/**
 * Get the system prompt from the session (first system message, if any).
 */
export function getSystemPrompt(session: HistorySession): string | null {
  const sysMsg = session.messages.find((m) => m.role === "system");
  return sysMsg?.content ?? null;
}

// ── pruning ────────────────────────────────────────────────────────────────

/**
 * Prune the session to fit within token and message limits.
 * Removes oldest messages first, but preserves the first system message.
 */
export function prune(session: HistorySession): void {
  const maxMsgs = maxHistoryMessages();
  const maxTokens = maxHistoryTokens();

  let messages = session.messages;

  // 1. Trim by message count
  if (messages.length > maxMsgs) {
    const systemIdx = messages.findIndex((m) => m.role === "system");
    // Keep system message at position 0, trim oldest non-system from front
    const toRemove = messages.length - maxMsgs;
    if (systemIdx >= 0 && systemIdx < toRemove) {
      // System message would be removed — keep it, remove extra from after it
      const keepSystem = [messages[systemIdx]];
      const rest = messages.slice(systemIdx + 1);
      const trimFromRest = toRemove - systemIdx;
      messages = [...keepSystem, ...rest.slice(trimFromRest)];
    } else {
      messages = messages.slice(toRemove);
    }
  }

  // 2. Trim by token count
  let totalTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);
  while (totalTokens > maxTokens && messages.length > 1) {
    // Remove oldest non-system message
    const systemIdx = messages.findIndex((m) => m.role === "system");
    if (systemIdx === 0) {
      // Remove the message at index 1 (after system)
      if (messages.length > 1) {
        totalTokens -= messages[1].tokenCount;
        messages = [messages[0], ...messages.slice(2)];
      } else {
        break;
      }
    } else {
      // No system message — remove the first message
      totalTokens -= messages[0].tokenCount;
      messages = messages.slice(1);
    }
  }

  session.messages = messages;
  session.messageCount = messages.length;
  session.totalTokens = totalTokens;
  session.lastActiveAt = Date.now();
}

/**
 * Estimate total token count for a list of HistoryMessages.
 */
export function totalHistoryTokens(messages: HistoryMessage[]): number {
  return messages.reduce((sum, m) => sum + m.tokenCount, 0);
}
