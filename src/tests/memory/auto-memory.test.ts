/**
 * Tests for setupAutoMemory — EventBus hooks that best-effort persist agent
 * results and task outcomes into a MemoryStore without ever blocking the
 * caller. Each test uses its own temp directory and EventBus instance.
 *
 * Run: bun run src/tests/memory/auto-memory.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import { MemoryStore } from "../../memory/store.js";
import { setupAutoMemory } from "../../memory/auto-memory.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Harness {
  bus: EventBus;
  store: MemoryStore;
  dir: string;
}

/** Fresh EventBus + MemoryStore (temp dir) wired up with auto-memory. */
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aether-memory-auto-"));
  const bus = new EventBus();
  const store = new MemoryStore(join(dir, ".aether-cli", "memory"));
  setupAutoMemory(bus, store, new ServiceContainer());
  return { bus, store, dir };
}

/** Poll until cond() is truthy or timeout elapses (handlers are async). */
async function waitFor(cond: () => Promise<boolean> | boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeout) throw new Error("timed out waiting for async memory handler");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Give fire-and-forget handlers a chance to (incorrectly) write. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

async function testAgentDonePersistsFileSummaries() {
  console.log("TEST 1: agent:done with files persists summaries...");
  const h = makeHarness();
  try {
    h.bus.emit({
      type: "agent:done",
      agent: "coder",
      taskId: "t1",
      duration: 10,
      result: {
        files: [
          { path: "src/a.ts", summary: "module a" },
          { path: "src/b.ts", content: "no summary provided" },
        ],
      },
    });
    await waitFor(async () => Object.keys(await h.store.getProjectFiles(process.cwd())).length === 2);

    const files = await h.store.getProjectFiles(process.cwd());
    assert(files["src/a.ts"] === "module a", `expected explicit summary, got ${files["src/a.ts"]}`);
    assert(files["src/b.ts"] === "Modified by coder", `expected default summary, got ${files["src/b.ts"]}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ summaries stored (explicit + default)");
}

async function testAgentDoneWithoutFilesWritesNothing() {
  console.log("TEST 2: agent:done without files writes nothing...");
  const h = makeHarness();
  try {
    h.bus.emit({ type: "agent:done", agent: "coder", taskId: "t2", duration: 5, result: {} });
    h.bus.emit({ type: "agent:done", agent: "coder", taskId: "t3", duration: 5, result: { files: [] } });
    await settle();

    const files = await h.store.getProjectFiles(process.cwd());
    assert(Object.keys(files).length === 0, `expected no files, got ${JSON.stringify(files)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ missing/empty files array skipped");
}

async function testTaskCompletedPersistsEntry() {
  console.log("TEST 3: task:completed persists a task entry...");
  const h = makeHarness();
  try {
    h.bus.emit({ type: "task:completed", taskId: "task-1", result: "all tests passed" });
    await waitFor(async () => (await h.store.getTaskHistory(process.cwd())).length === 1);

    const tasks = await h.store.getTaskHistory(process.cwd());
    assert(tasks[0].taskId === "task-1", `expected taskId task-1, got ${tasks[0].taskId}`);
    assert(tasks[0].type === "task", `expected type 'task', got ${tasks[0].type}`);
    assert(tasks[0].outcome === "all tests passed", `expected string outcome, got ${tasks[0].outcome}`);
    assert(typeof tasks[0].timestamp === "number", "timestamp should be a number");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ task entry persisted with outcome");
}

async function testTaskCompletedStringifiesObjectResult() {
  console.log("TEST 4: task:completed stringifies non-string results...");
  const h = makeHarness();
  try {
    const result = { status: "ok", tests: 3 };
    h.bus.emit({ type: "task:completed", taskId: "task-2", result });
    await waitFor(async () => (await h.store.getTaskHistory(process.cwd())).length === 1);

    const tasks = await h.store.getTaskHistory(process.cwd());
    assert(tasks[0].outcome === JSON.stringify(result), `expected JSON outcome, got ${tasks[0].outcome}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ object result serialized");
}

async function testMemoryAgentEventsSkipped() {
  console.log("TEST 5: agent:done from the memory agent is skipped...");
  const h = makeHarness();
  try {
    h.bus.emit({
      type: "agent:done",
      agent: "memory",
      taskId: "t4",
      duration: 5,
      result: { files: [{ path: "mem.json", summary: "should not be stored" }] },
    });
    await settle();

    const files = await h.store.getProjectFiles(process.cwd());
    assert(Object.keys(files).length === 0, `memory agent files should be skipped, got ${JSON.stringify(files)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ memory agent results ignored");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Auto-Memory Tests          ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests = [
    testAgentDonePersistsFileSummaries,
    testAgentDoneWithoutFilesWritesNothing,
    testTaskCompletedPersistsEntry,
    testTaskCompletedStringifiesObjectResult,
    testMemoryAgentEventsSkipped,
  ];
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err: unknown) {
      failed++;
      console.error(`  ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
