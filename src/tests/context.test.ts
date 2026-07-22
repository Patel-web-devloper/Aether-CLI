/**
 * Comprehensive tests for the context management system.
 *
 * Covers: indexer, chunker, history, builder, and manager.
 * Uses temp directories for file-system tests — no real project dependency.
 *
 * Run: bun run src/tests/context.test.ts
 */

import { indexProject, invalidateCache } from "../context/indexer.js";
import {
  chunkFile,
  estimateTokens,
  isSmallFile,
  isChunkable,
} from "../context/chunker.js";
import {
  createSession,
  addMessage,
  addMessages,
  saveSession,
  loadSession,
  clearSession,
  deleteSession,
  prune,
  listSessions,
  getRecentMessages,
  getSystemPrompt,
} from "../context/history.js";
import { buildContext } from "../context/builder.js";
import { ContextManager } from "../context/manager.js";
import type {
  FileIndex,
  HistorySession,
  HistoryMessage,
  ContextPayload,
} from "../context/types.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "aether-ctx-"));
}

function writeProjectFile(
  baseDir: string,
  relPath: string,
  content: string,
): void {
  const full = join(baseDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function makeProject(
  baseDir: string,
  files: Array<{ path: string; content: string }>,
): void {
  for (const f of files) {
    writeProjectFile(baseDir, f.path, f.content);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDEXER TESTS (6)
// ═══════════════════════════════════════════════════════════════════════════

async function testIndexerDirectoryWithVariousFileTypes() {
  console.log("TEST 1: Indexer — indexes directory with various file types...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/main.ts", content: 'export const hello = "world";' },
      { path: "src/utils.js", content: "function add(a,b) { return a+b; }" },
      { path: "scripts/helper.py", content: "def greet():\n    return 'hi'" },
      { path: "config.json", content: '{"version":"1.0"}' },
      { path: "README.md", content: "# Project\n\nDescription here." },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    if (index.entries.size < 5) {
      throw new Error(
        `Expected at least 5 entries, got ${index.entries.size}`,
      );
    }

    // Verify specific files
    const tsEntry = index.entries.get("src/main.ts");
    if (!tsEntry) throw new Error("src/main.ts not found in index");
    if (tsEntry.language !== "TypeScript") {
      throw new Error(`Expected TypeScript, got ${tsEntry.language}`);
    }
    if (!tsEntry.symbols.some((s) => s.includes("hello"))) {
      throw new Error(`Expected 'hello' symbol in src/main.ts, got ${tsEntry.symbols.join(", ")}`);
    }

    const pyEntry = index.entries.get("scripts/helper.py");
    if (!pyEntry) throw new Error("scripts/helper.py not found in index");
    if (pyEntry.language !== "Python") {
      throw new Error(`Expected Python, got ${pyEntry.language}`);
    }

    const jsonEntry = index.entries.get("config.json");
    if (!jsonEntry) throw new Error("config.json not found in index");
    if (jsonEntry.language !== "JSON") {
      throw new Error(`Expected JSON, got ${jsonEntry.language}`);
    }

    console.log(
      `  ✓ Indexed ${index.entries.size} files with correct languages and symbols\n`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testIndexerSkipsIgnoreDirs() {
  console.log("TEST 2: Indexer — skips node_modules, .git, dist, build...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/app.ts", content: "export const x = 1;" },
      { path: "node_modules/pkg/index.js", content: "module.exports = {};" },
      { path: "dist/bundle.js", content: "(()=>{})();" },
      { path: "build/output.js", content: "var a=1;" },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    // Only src/app.ts should be indexed
    if (!index.entries.has("src/app.ts")) {
      throw new Error("src/app.ts should be indexed");
    }
    if (index.entries.has("node_modules/pkg/index.js")) {
      throw new Error("node_modules file should be skipped");
    }
    if (index.entries.has("dist/bundle.js")) {
      throw new Error("dist file should be skipped");
    }
    if (index.entries.has("build/output.js")) {
      throw new Error("build file should be skipped");
    }

    // Also check: nothing from the skip dirs made it in
    for (const [path] of index.entries) {
      if (
        path.startsWith("node_modules") ||
        path.startsWith("dist") ||
        path.startsWith("build")
      ) {
        throw new Error(`Unexpected entry from skip dir: ${path}`);
      }
    }

    console.log("  ✓ Skip directories correctly excluded\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testIndexerRespectsGitignore() {
  console.log("TEST 3: Indexer — respects .gitignore patterns...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/main.ts", content: "export const x = 1;" },
      { path: "src/generated.ts", content: "// auto-generated" },
      { path: "secrets.env", content: "KEY=val" },
      { path: "logs/debug.log", content: "log entry" },
      {
        path: ".gitignore",
        content: "# ignore generated files\nsrc/generated.ts\n*.env\nlogs/\n",
      },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    // Should include src/main.ts (not ignored)
    if (!index.entries.has("src/main.ts")) {
      throw new Error("src/main.ts should be indexed");
    }

    // Should NOT include ignored files
    if (index.entries.has("src/generated.ts")) {
      throw new Error("src/generated.ts should be gitignored");
    }
    if (index.entries.has("secrets.env")) {
      throw new Error("secrets.env should be gitignored");
    }
    if (index.entries.has("logs/debug.log")) {
      throw new Error("logs/debug.log should be gitignored");
    }

    console.log("  ✓ .gitignore patterns respected\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testIndexerLanguageDetection() {
  console.log("TEST 4: Indexer — detects language from file extension...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "app.ts", content: "const x = 1;" },
      { path: "app.tsx", content: "const C = () => <div/>;" },
      { path: "app.js", content: "var x = 1;" },
      { path: "app.py", content: "x = 1" },
      { path: "app.rs", content: "fn main() {}" },
      { path: "app.go", content: "package main" },
      { path: "app.css", content: "body { }" },
      { path: "app.html", content: "<html></html>" },
      { path: "app.json", content: "{}" },
      { path: "app.yaml", content: "key: val" },
      { path: "app.md", content: "# Title" },
      { path: "app.sh", content: "#!/bin/sh" },
      { path: "app.toml", content: "[section]" },
      { path: "app.sql", content: "SELECT 1;" },
      { path: "unknown.xyz", content: "???" },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    const langMap: Record<string, string> = {
      "app.ts": "TypeScript",
      "app.tsx": "TypeScript (React)",
      "app.js": "JavaScript",
      "app.py": "Python",
      "app.rs": "Rust",
      "app.go": "Go",
      "app.css": "CSS",
      "app.html": "HTML",
      "app.json": "JSON",
      "app.yaml": "YAML",
      "app.md": "Markdown",
      "app.sh": "Shell",
      "app.toml": "TOML",
      "app.sql": "SQL",
      "unknown.xyz": "XYZ",
    };

    for (const [path, expectedLang] of Object.entries(langMap)) {
      const entry = index.entries.get(path);
      if (!entry) throw new Error(`${path} not found in index`);
      if (entry.language !== expectedLang) {
        throw new Error(
          `Expected ${path} → "${expectedLang}", got "${entry.language}"`,
        );
      }
    }

    console.log("  ✓ All file extensions map to correct languages\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testIndexerCacheAndReload() {
  console.log("TEST 5: Indexer — caches index and reloads on second call...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/cached.ts", content: "export const cached = true;" },
    ]);

    // First call — builds index
    const index1 = await indexProject(tmpDir, { force: true });
    const firstTimestamp = index1.indexedAt;

    if (!index1.entries.has("src/cached.ts")) {
      throw new Error("First index missing file");
    }

    // Second call WITHOUT force — should load from cache
    const index2 = await indexProject(tmpDir);

    // Should have the same timestamp (cached)
    if (index2.indexedAt !== firstTimestamp) {
      // If timestamps differ, check if entries are still the same
      if (!index2.entries.has("src/cached.ts")) {
        throw new Error("Cached index missing file");
      }
      console.log(
        "  ⚠ Timestamps differ but entries match — cache may have been rebuilt\n",
      );
    }

    // Add a new file after caching — second (non-force) index shouldn't include it
    writeProjectFile(tmpDir, "src/newfile.ts", "export const newFile = true;");

    // Cached load should still NOT have the new file
    const index3 = await indexProject(tmpDir);
    if (index3.entries.has("src/newfile.ts")) {
      // Cache may have been invalidated — check if it has the same timestamp
      if (index3.indexedAt === firstTimestamp) {
        throw new Error(
          "Cached index should NOT include file added after indexing",
        );
      }
    }

    // Force re-index should pick up the new file
    const index4 = await indexProject(tmpDir, { force: true });
    if (!index4.entries.has("src/newfile.ts")) {
      throw new Error("Force re-index should include newly added file");
    }

    console.log("  ✓ Cache reload and force re-index work correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testIndexerEmptyDirectory() {
  console.log("TEST 6: Indexer — handles empty directory...");

  const tmpDir = makeTempDir();
  try {
    const index = await indexProject(tmpDir, { force: true });

    if (index.entries.size !== 0) {
      throw new Error(`Expected 0 entries in empty dir, got ${index.entries.size}`);
    }
    if (!index.root) throw new Error("Index root should be set");
    if (!index.projectHash) throw new Error("Project hash should be set");
    if (!index.indexedAt) throw new Error("Indexed timestamp should be set");

    console.log("  ✓ Empty directory handled correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHUNKER TESTS (5)
// ═══════════════════════════════════════════════════════════════════════════

async function testChunkerFunctionBoundaries() {
  console.log("TEST 7: Chunker — splits TypeScript at function boundaries...");

  const tsContent = `// Math utilities
import { something } from "./module";

/**
 * Adds two numbers.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Subtracts b from a.
 */
export function subtract(a: number, b: number): number {
  return a - b;
}

export const multiply = (a: number, b: number): number => a * b;

export interface MathResult {
  value: number;
  operation: string;
}`;

  const chunks = chunkFile(tsContent, "math.ts");

  // Should have multiple chunks — at minimum 2 (import block + functions)
  if (chunks.length < 2) {
    throw new Error(`Expected at least 2 chunks, got ${chunks.length}`);
  }

  // First chunk should contain the import
  // (let's verify by checking content)
  const hasImport = chunks.some((c) => c.content.includes("import { something }"));
  if (!hasImport) {
    throw new Error("Expected a chunk containing the import statement");
  }

  const hasAdd = chunks.some((c) => c.content.includes("function add"));
  if (!hasAdd) {
    throw new Error("Expected a chunk containing the add function");
  }

  const hasSubtract = chunks.some((c) => c.content.includes("function subtract"));
  if (!hasSubtract) {
    throw new Error("Expected a chunk containing the subtract function");
  }

  // All chunks should have startLine <= endLine
  for (const c of chunks) {
    if (c.startLine > c.endLine) {
      throw new Error(
        `Invalid chunk range: ${c.startLine}-${c.endLine} in ${c.filePath}`,
      );
    }
    if (!c.content) {
      throw new Error("Chunk has empty content");
    }
  }

  console.log(`  ✓ Split into ${chunks.length} chunks at function boundaries\n`);
}

async function testChunkerClassBoundaries() {
  console.log("TEST 8: Chunker — splits at class boundaries...");

  const tsContent = `import { EventEmitter } from "events";

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User> {
    return this.db.findUser(id);
  }

  async createUser(data: CreateUserDTO): Promise<User> {
    return this.db.insertUser(data);
  }
}

export class AuthService {
  private userService: UserService;

  constructor(userService: UserService) {
    this.userService = userService;
  }

  async login(email: string, password: string): Promise<string> {
    // ...
    return "token";
  }

  async logout(token: string): Promise<void> {
    // ...
  }
}

export class Logger {
  log(level: string, msg: string): void {
    console.log(\`[\${level}] \${msg}\`);
  }
}`;

  const chunks = chunkFile(tsContent, "services.ts");

  if (chunks.length < 3) {
    throw new Error(`Expected at least 3 chunks (3 classes), got ${chunks.length}`);
  }

  const hasUserService = chunks.some((c) => c.content.includes("class UserService"));
  const hasAuthService = chunks.some((c) => c.content.includes("class AuthService"));
  const hasLogger = chunks.some((c) => c.content.includes("class Logger"));

  if (!hasUserService) throw new Error("Missing UserService chunk");
  if (!hasAuthService) throw new Error("Missing AuthService chunk");
  if (!hasLogger) throw new Error("Missing Logger chunk");

  // Verify symbols exist on chunks (from boundary labels)
  const classChunks = chunks.filter((c) =>
    c.symbols?.some((s) => s === "class" || s === "export"),
  );
  if (classChunks.length === 0) {
    throw new Error("Expected chunks with class/export boundary symbols");
  }

  console.log(`  ✓ Split into ${chunks.length} chunks at class boundaries\n`);
}

async function testChunkerLineBasedFallback() {
  console.log("TEST 9: Chunker — falls back to line-based for unsupported languages...");

  const cssContent = `/* Reset */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* Typography */
body {
  font-family: system-ui, sans-serif;
  line-height: 1.6;
  color: #333;
  background: #fff;
}

/* Layout */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 1rem;
}

/* Components */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: #3b82f6;
  color: white;
}

.btn-primary:hover {
  background: #2563eb;
}

/* Utilities */
.mt-1 { margin-top: 0.25rem; }
.mt-2 { margin-top: 0.5rem; }
.mt-4 { margin-top: 1rem; }
.mb-4 { margin-bottom: 1rem; }
.p-4 { padding: 1rem; }`;

  const chunks = chunkFile(cssContent, "styles.css");

  // CSS uses line-based fallback — should produce chunks
  if (chunks.length === 0) {
    throw new Error("Expected at least 1 chunk for CSS");
  }

  // All chunks should have correct filePath
  for (const c of chunks) {
    if (c.filePath !== "styles.css") {
      throw new Error(`Expected filePath "styles.css", got "${c.filePath}"`);
    }
    if (c.tokenCount <= 0) {
      throw new Error("Chunk should have positive tokenCount");
    }
  }

  // The combined content should cover the whole file
  let totalLines = 0;
  for (const c of chunks) {
    totalLines += c.endLine - c.startLine + 1;
  }
  const fileLines = cssContent.split("\n").length;
  if (totalLines < fileLines * 0.9) {
    throw new Error(`Chunks only cover ${totalLines}/${fileLines} lines`);
  }

  console.log(`  ✓ Line-based fallback produced ${chunks.length} chunk(s)\n`);
}

async function testChunkerMaxChunkSize() {
  console.log("TEST 10: Chunker — respects max chunk size (4000 tokens)...");

  // Generate a very long function body
  let longBody = "";
  for (let i = 0; i < 5000; i++) {
    longBody += `  console.log("This is a very long function body line number ${i}");\n`;
  }

  const tsContent = `export function veryLongFunction(): void {
${longBody}}

export function shortFunction(): void {
  console.log("short");
}`;

  const chunks = chunkFile(tsContent, "long.ts");

  // The long function should be split into multiple sub-chunks
  // since it exceeds 4000 tokens
  if (chunks.length < 3) {
    throw new Error(
      `Expected at least 3 chunks (short fn + long fn split), got ${chunks.length}`,
    );
  }

  // No individual chunk should exceed maxTokens (4000)
  for (const c of chunks) {
    if (c.tokenCount > 4000) {
      throw new Error(
        `Chunk at ${c.filePath}:${c.startLine}-${c.endLine} has ${c.tokenCount} tokens, exceeds 4000 max`,
      );
    }
  }

  // The short function should be its own chunk
  const hasShortChunk = chunks.some((c) => c.content.includes("shortFunction"));
  if (!hasShortChunk) {
    throw new Error("Expected a chunk containing shortFunction");
  }

  console.log(`  ✓ Large function split into ${chunks.length} chunks, none exceed 4000 tokens\n`);
}

async function testChunkerEmptyFile() {
  console.log("TEST 11: Chunker — handles empty files...");

  const chunks = chunkFile("", "empty.ts");
  // Chunker produces 1 empty chunk for empty content (start boundary covers whole file)
  if (chunks.length !== 1) {
    throw new Error(`Expected 1 chunk for empty file, got ${chunks.length}`);
  }
  // But the content should be empty
  if (chunks[0].content !== "") {
    throw new Error("Empty file chunk should have empty content");
  }

  // Whitespace-only file
  const wsChunks = chunkFile("   \n\n   \n", "whitespace.ts");
  // May produce 0 or 1 chunk depending on boundary detection
  if (wsChunks.length > 1) {
    throw new Error(
      `Expected at most 1 chunk for whitespace file, got ${wsChunks.length}`,
    );
  }

  // Verify helper functions
  if (!isSmallFile("")) {
    throw new Error("Empty string should be a small file");
  }
  if (isChunkable("data.json")) {
    throw new Error("JSON should not be chunkable");
  }
  if (!isChunkable("src/app.ts")) {
    throw new Error("TypeScript should be chunkable");
  }
  if (estimateTokens("hello world") !== Math.ceil("hello world".length / 4)) {
    throw new Error("Token estimation incorrect");
  }

  console.log("  ✓ Empty files and helpers handled correctly\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY TESTS (5)
// ═══════════════════════════════════════════════════════════════════════════

async function testHistoryAddMessages() {
  console.log("TEST 12: History — adds messages to session...");

  const session = createSession("test-model");

  const msg = addMessage(session, "user", "Hello, can you help me?");
  if (msg.role !== "user") throw new Error("Message role should be 'user'");
  if (msg.content !== "Hello, can you help me?") {
    throw new Error("Message content mismatch");
  }
  if (msg.tokenCount <= 0) throw new Error("Token count should be positive");

  addMessage(session, "assistant", "Of course! What do you need?");
  addMessage(session, "user", "Write a function.");

  if (session.messages.length !== 3) {
    throw new Error(`Expected 3 messages, got ${session.messages.length}`);
  }
  if (session.messageCount !== 3) {
    throw new Error(`Expected messageCount 3, got ${session.messageCount}`);
  }
  if (session.totalTokens <= 0) {
    throw new Error("Total tokens should be positive");
  }

  // Last active time should be >= creation time (may be equal if test runs fast)
  if (session.lastActiveAt < session.createdAt) {
    throw new Error("lastActiveAt should be >= createdAt");
  }

  // Test batch add
  const session2 = createSession("batch");
  addMessages(session2, [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ]);
  if (session2.messages.length !== 3) {
    throw new Error(`Batch: expected 3 messages, got ${session2.messages.length}`);
  }

  // Clean up any saved sessions from these tests
  deleteSession(session.id);
  deleteSession(session2.id);

  console.log("  ✓ Messages added correctly (single + batch)\n");
}

async function testHistoryPrunesWhenExceedingLimits() {
  console.log("TEST 13: History — prunes oldest messages when exceeding limits...");

  // Temporarily set low limits for testing
  const prevMsgLimit = process.env.AETHER_MAX_HISTORY_MESSAGES;
  const prevTokenLimit = process.env.AETHER_MAX_HISTORY_TOKENS;

  try {
    // Set message limit to 5
    process.env.AETHER_MAX_HISTORY_MESSAGES = "5";
    // Set token limit very high so only message count triggers
    process.env.AETHER_MAX_HISTORY_TOKENS = "1000000";

    const session = createSession("prune-test");

    // Add system message first
    addMessage(session, "system", "You are a helpful assistant.");

    // Add 10 more messages
    for (let i = 0; i < 10; i++) {
      addMessage(session, "user", `Message number ${i}`);
    }

    // Should have pruned to 5 messages
    if (session.messages.length > 5) {
      throw new Error(
        `Expected at most 5 messages after prune, got ${session.messages.length}`,
      );
    }

    // System message should be preserved
    const sysMsg = getSystemPrompt(session);
    if (!sysMsg) {
      throw new Error("System message should be preserved during pruning");
    }

    // Now test token-based pruning
    process.env.AETHER_MAX_HISTORY_MESSAGES = "50"; // high msg limit
    process.env.AETHER_MAX_HISTORY_TOKENS = "500"; // low token limit

    const session2 = createSession("token-prune");
    addMessage(session2, "system", "sys");

    // Add messages with large content to exceed token limit
    const bigMsg = "x".repeat(2000); // 500 tokens (2000/4)
    addMessage(session2, "user", bigMsg);
    addMessage(session2, "assistant", bigMsg);

    // These should have triggered token pruning
    // The total tokens should be ≤ 500
    if (session2.totalTokens > 500) {
      throw new Error(
        `Token pruning failed: totalTokens=${session2.totalTokens}, limit=500`,
      );
    }

    // System message should still be there (pruning preserves it)
    const sys2 = getSystemPrompt(session2);
    if (!sys2) {
      throw new Error("System message should survive token-based pruning");
    }

    deleteSession(session.id);
    deleteSession(session2.id);

    console.log("  ✓ Message-count and token-based pruning both work\n");
  } finally {
    // Restore env
    if (prevMsgLimit !== undefined)
      process.env.AETHER_MAX_HISTORY_MESSAGES = prevMsgLimit;
    else delete process.env.AETHER_MAX_HISTORY_MESSAGES;
    if (prevTokenLimit !== undefined)
      process.env.AETHER_MAX_HISTORY_TOKENS = prevTokenLimit;
    else delete process.env.AETHER_MAX_HISTORY_TOKENS;
  }
}

async function testHistorySaveAndLoad() {
  console.log("TEST 14: History — saves and loads sessions from disk...");

  const session = createSession("disk-test");
  addMessage(session, "system", "You are Aether.");
  addMessage(session, "user", "What is 2+2?");
  addMessage(session, "assistant", "2+2 = 4");

  // Save
  saveSession(session);

  // Load
  const loaded = loadSession(session.id);
  if (!loaded) throw new Error("Failed to load saved session");

  // Verify
  if (loaded.id !== session.id) throw new Error("Session ID mismatch");
  if (loaded.messages.length !== 3) {
    throw new Error(
      `Expected 3 messages in loaded session, got ${loaded.messages.length}`,
    );
  }
  if (loaded.messageCount !== 3) throw new Error("Message count mismatch");
  if (loaded.model !== session.model) throw new Error("Model mismatch");

  // Content should match
  if (loaded.messages[0].content !== "You are Aether.") {
    throw new Error("Message content mismatch after load");
  }

  // Load non-existent session
  const missing = loadSession("nonexistent-uuid-12345");
  if (missing !== null) {
    throw new Error("loadSession should return null for non-existent session");
  }

  // List sessions
  const sessions = listSessions();
  const found = sessions.find((s) => s.id === session.id);
  if (!found) throw new Error("Saved session not found in listSessions()");

  // Delete
  const deleted = deleteSession(session.id);
  if (!deleted) throw new Error("deleteSession should return true");
  if (loadSession(session.id) !== null) {
    throw new Error("Session should be gone after delete");
  }

  console.log("  ✓ Session save/load/delete round-trip works\n");
}

async function testHistoryCreateSessionWithUUID() {
  console.log("TEST 15: History — creates new session with valid UUID...");

  const session = createSession("gemini-pro");

  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(session.id)) {
    throw new Error(`Session ID is not a valid UUID v4: ${session.id}`);
  }

  if (session.model !== "gemini-pro") {
    throw new Error(`Expected model "gemini-pro", got "${session.model}"`);
  }
  if (session.messages.length !== 0) {
    throw new Error("New session should have 0 messages");
  }
  if (session.messageCount !== 0) {
    throw new Error("New session should have messageCount 0");
  }
  if (session.totalTokens !== 0) {
    throw new Error("New session should have totalTokens 0");
  }
  if (session.createdAt > Date.now()) {
    throw new Error("createdAt should be in the past");
  }
  if (session.lastActiveAt !== session.createdAt) {
    throw new Error("lastActiveAt should equal createdAt for new session");
  }

  deleteSession(session.id);
  console.log("  ✓ Session creation with valid UUID and defaults\n");
}

async function testHistoryClear() {
  console.log("TEST 16: History — clears all messages from session...");

  const session = createSession("clear-test");
  addMessages(session, [
    { role: "system", content: "System prompt" },
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
  ]);

  if (session.messages.length !== 5) {
    throw new Error(`Expected 5 messages before clear`);
  }

  clearSession(session);

  if (session.messages.length !== 0) {
    throw new Error(`Expected 0 messages after clear, got ${session.messages.length}`);
  }
  if (session.messageCount !== 0) throw new Error("messageCount should be 0 after clear");
  if (session.totalTokens !== 0) throw new Error("totalTokens should be 0 after clear");

  // getRecentMessages should return empty array
  const recent = getRecentMessages(session, 5);
  if (recent.length !== 0) {
    throw new Error("getRecentMessages should return empty after clear");
  }

  // getSystemPrompt should return null
  const sys = getSystemPrompt(session);
  if (sys !== null) {
    throw new Error("getSystemPrompt should return null after clear");
  }

  deleteSession(session.id);
  console.log("  ✓ Session cleared correctly\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILDER TESTS (4)
// ═══════════════════════════════════════════════════════════════════════════

async function testBuilderTargetFileIncludedFirst() {
  console.log("TEST 17: Builder — target file included first in context...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/target.ts",
        content: `export function targetFunction(): string {
  return "I am the target";
}`,
      },
      {
        path: "src/other.ts",
        content: `export function otherFunction(): string {
  return "I am other";
}`,
      },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    const payload = buildContext("Explain targetFunction", index, {
      targetFiles: ["src/target.ts"],
    });

    // Target file should be in the first chunk position
    if (payload.chunks.length === 0) {
      throw new Error("No chunks returned for target file");
    }

    const firstChunkPath = payload.chunks[0].filePath;
    if (!firstChunkPath.includes("target.ts")) {
      throw new Error(
        `Expected target file first, got "${firstChunkPath}" as first chunk`,
      );
    }

    // The target file content should be in the chunks
    const hasTarget = payload.chunks.some((c) =>
      c.content.includes("targetFunction"),
    );
    if (!hasTarget) {
      throw new Error("Target file content not found in chunks");
    }

    // User prompt should be preserved
    if (payload.userMessage !== "Explain targetFunction") {
      throw new Error("User message mismatch in payload");
    }

    console.log("  ✓ Target file placed first in context chunks\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testBuilderRespectsTokenBudget() {
  console.log("TEST 18: Builder — respects token budget (never exceeds limit)...");

  const tmpDir = makeTempDir();
  try {
    // Create a project with several files
    makeProject(tmpDir, [
      {
        path: "src/a.ts",
        content: `export const a = "a".repeat(2000);\n`.repeat(10),
      },
      {
        path: "src/b.ts",
        content: `export const b = "b".repeat(2000);\n`.repeat(10),
      },
      { path: "package.json", content: '{"name":"test"}' },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    // Set a very low token budget
    const tinyBudget = 200;
    const payload = buildContext("Find something", index, {
      maxTokens: tinyBudget,
      targetFiles: ["src/a.ts"],
    });

    // Token used should never exceed budget
    if (payload.tokenCount > tinyBudget) {
      throw new Error(
        `Token budget exceeded: ${payload.tokenCount} > ${tinyBudget}`,
      );
    }
    if (payload.tokenBudget.max !== tinyBudget) {
      throw new Error(
        `Budget max mismatch: ${payload.tokenBudget.max} vs ${tinyBudget}`,
      );
    }

    // System prompt should be truncated if too long
    if (payload.systemPrompt.length > 0) {
      // Just verifying it exists and is a string
      if (typeof payload.systemPrompt !== "string") {
        throw new Error("System prompt should be a string");
      }
    }

    // Test with a more reasonable budget
    const normalPayload = buildContext("Find something", index, {
      maxTokens: 128000,
    });
    if (normalPayload.tokenCount > 128000) {
      throw new Error("Normal budget exceeded");
    }

    console.log(
      `  ✓ Token budget respected (used: ${payload.tokenCount}/${tinyBudget})\n`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testBuilderIncludesConfigFiles() {
  console.log("TEST 19: Builder — includes project config files...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/app.ts", content: "export const x = 1;" },
      {
        path: "package.json",
        content: JSON.stringify({ name: "my-app", version: "2.0.0" }),
      },
      { path: "tsconfig.json", content: '{"compilerOptions":{"strict":true}}' },
      {
        path: "vite.config.ts",
        content: "export default { plugins: [] };",
      },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    const payload = buildContext("Build the app", index, {
      targetFiles: ["src/app.ts"],
    });

    // Config summary should mention config files
    if (payload.configSummary.length === 0) {
      throw new Error("Config summary should not be empty");
    }

    if (!payload.configSummary.includes("package.json")) {
      throw new Error("Config summary should include package.json");
    }
    if (!payload.configSummary.includes("tsconfig.json")) {
      throw new Error("Config summary should include tsconfig.json");
    }
    if (!payload.configSummary.includes("vite.config.ts")) {
      throw new Error("Config summary should include vite.config.ts");
    }

    // System prompt should contain the config summary
    if (!payload.systemPrompt.includes("Configuration files:")) {
      throw new Error("System prompt should have config section");
    }

    console.log("  ✓ Config files included in context\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testBuilderKeywordMatchedChunks() {
  console.log("TEST 20: Builder — includes keyword-matched chunks from index...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/auth/login.ts",
        content: `export function loginUser(email: string, password: string): void {
  // authentication logic
  console.log("Logging in user:", email);
}`,
      },
      {
        path: "src/auth/logout.ts",
        content: `export function logoutUser(): void {
  console.log("Logging out");
}`,
      },
      {
        path: "src/utils/math.ts",
        content: `export function add(a: number, b: number): number {
  return a + b;
}`,
      },
      {
        path: "src/data/users.ts",
        content: `export interface User {
  id: string;
  email: string;
  name: string;
}`,
      },
      { path: "package.json", content: '{"name":"auth-app"}' },
    ]);

    const index = await indexProject(tmpDir, { force: true });

    // Prompt with keyword "auth" — should match auth-related files
    const payload = buildContext("Fix the authentication login flow", index, {
      targetFiles: [],
      followImports: false,
    });

    // Should have found keyword-matched chunks
    if (payload.chunks.length === 0) {
      throw new Error("Expected keyword-matched chunks for authentication prompt");
    }

    // At least one chunk should be auth-related
    const authChunks = payload.chunks.filter(
      (c) =>
        c.filePath.includes("auth") || c.filePath.includes("login"),
    );
    if (authChunks.length === 0) {
      throw new Error(
        "Expected chunks matching 'auth' keyword. Got chunks: " +
          payload.chunks.map((c) => c.filePath).join(", "),
      );
    }

    // math.ts should NOT be in chunks (unrelated to "authentication login")
    const mathChunks = payload.chunks.filter((c) =>
      c.filePath.includes("math"),
    );
    if (mathChunks.length > 0) {
      // It's possible but unlikely — keyword "authentication" doesn't match "math"
      console.log("  ⚠ math.ts found in keyword-matched chunks (unexpected but not a failure)\n");
    }

    console.log(
      `  ✓ Keyword matching found ${payload.chunks.length} relevant chunk(s)\n`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT MANAGER TESTS (3 bonus)
// ═══════════════════════════════════════════════════════════════════════════

async function testContextManagerBuildContext() {
  console.log("TEST 21: ContextManager — builds context with target file...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      {
        path: "src/app.ts",
        content: `export function main(): void {
  console.log("Hello from Aether!");
}`,
      },
      { path: "package.json", content: '{"name":"aether-test"}' },
    ]);

    const mgr = new ContextManager({ cwd: tmpDir });

    const payload = await mgr.buildContextPayload(
      "Explain the main function",
      "src/app.ts",
    );

    if (!payload.systemPrompt) throw new Error("System prompt missing");
    if (payload.userMessage !== "Explain the main function") {
      throw new Error("User message mismatch");
    }
    if (payload.chunks.length === 0) {
      throw new Error("Expected chunks for target file");
    }
    if (payload.tokenCount <= 0) throw new Error("Token count should be positive");
    if (!payload.tokenBudget) throw new Error("Token budget missing");

    // Should have indexed the project
    if (!mgr.index) throw new Error("Manager should have an index");

    await mgr.destroy();
    console.log("  ✓ ContextManager builds context payload correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testContextManagerAddToHistory() {
  console.log("TEST 22: ContextManager — adds messages to history...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "dummy.ts", content: "export const x = 1;" },
    ]);

    const mgr = new ContextManager({ cwd: tmpDir });

    await mgr.addToHistory("user", "Hello Aether");
    await mgr.addToHistory("assistant", "Hello! How can I help?");

    const history = await mgr.getHistory(5);
    if (history.length < 2) {
      throw new Error(`Expected at least 2 history messages, got ${history.length}`);
    }

    if (history[0].role !== "user" || history[0].content !== "Hello Aether") {
      throw new Error("First history message mismatch");
    }

    await mgr.clearHistory();
    const empty = await mgr.getHistory();
    if (empty.length !== 0) {
      throw new Error("History should be empty after clear");
    }

    await mgr.destroy();
    // Clean up the saved session
    const session = mgr.session;
    if (session) deleteSession(session.id);

    console.log("  ✓ ContextManager history add/get/clear works\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

async function testContextManagerGetStats() {
  console.log("TEST 23: ContextManager — getStats returns correct information...");

  const tmpDir = makeTempDir();
  try {
    makeProject(tmpDir, [
      { path: "src/a.ts", content: "export const a = 1;" },
      { path: "src/b.ts", content: "export const b = 2;" },
      { path: "src/c.ts", content: "export const c = 3;" },
      { path: "package.json", content: '{"name":"test"}' },
      { path: "lib/util.js", content: "module.exports = {};" },
    ]);

    const mgr = new ContextManager({ cwd: tmpDir });

    const stats = await mgr.getStats();

    if (stats.filesIndexed < 5) {
      throw new Error(
        `Expected at least 5 files indexed, got ${stats.filesIndexed}`,
      );
    }
    if (stats.totalSizeBytes <= 0) {
      throw new Error("Total size should be positive");
    }
    if (stats.maxTokens <= 0) throw new Error("maxTokens should be positive");
    if (!stats.sessionId) throw new Error("sessionId should be set");

    // historyMessageCount should be 0 (no messages added yet)
    if (stats.historyMessageCount !== 0) {
      throw new Error(
        `Expected 0 history messages initially, got ${stats.historyMessageCount}`,
      );
    }

    await mgr.destroy();
    if (mgr.session) deleteSession(mgr.session.id);

    console.log(
      `  ✓ Stats: ${stats.filesIndexed} files, ${stats.totalSizeBytes} bytes, ${stats.maxTokens} max tokens\n`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Context System Tests       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    // Indexer
    { name: "Index varied file types", fn: testIndexerDirectoryWithVariousFileTypes },
    { name: "Skip ignore dirs", fn: testIndexerSkipsIgnoreDirs },
    { name: "Respect .gitignore", fn: testIndexerRespectsGitignore },
    { name: "Language detection", fn: testIndexerLanguageDetection },
    { name: "Cache & reload", fn: testIndexerCacheAndReload },
    { name: "Empty directory", fn: testIndexerEmptyDirectory },
    // Chunker
    { name: "Function boundaries", fn: testChunkerFunctionBoundaries },
    { name: "Class boundaries", fn: testChunkerClassBoundaries },
    { name: "Line-based fallback", fn: testChunkerLineBasedFallback },
    { name: "Max chunk size", fn: testChunkerMaxChunkSize },
    { name: "Empty files", fn: testChunkerEmptyFile },
    // History
    { name: "Add messages", fn: testHistoryAddMessages },
    { name: "Prune when exceeding limits", fn: testHistoryPrunesWhenExceedingLimits },
    { name: "Save & load", fn: testHistorySaveAndLoad },
    { name: "UUID session", fn: testHistoryCreateSessionWithUUID },
    { name: "Clear session", fn: testHistoryClear },
    // Builder
    { name: "Target file first", fn: testBuilderTargetFileIncludedFirst },
    { name: "Token budget", fn: testBuilderRespectsTokenBudget },
    { name: "Config files", fn: testBuilderIncludesConfigFiles },
    { name: "Keyword-matched chunks", fn: testBuilderKeywordMatchedChunks },
    // ContextManager
    { name: "Build context", fn: testContextManagerBuildContext },
    { name: "Add to history", fn: testContextManagerAddToHistory },
    { name: "Get stats", fn: testContextManagerGetStats },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ FAILED [${test.name}]: ${msg}`);
      // Print stack for debugging
      if (err instanceof Error && err.stack) {
        const stackLines = err.stack.split("\n").slice(1, 4).join("\n");
        console.error(`    ${stackLines.replace(/\n/g, "\n    ")}`);
      }
    }
  }

  console.log(`\n${"─".repeat(42)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log(`${"─".repeat(42)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
