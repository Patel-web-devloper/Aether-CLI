/**
 * Tests for MemoryStore — project-scoped JSON persistence for file summaries,
 * decisions, and task history. Each test runs against its own temp directory
 * to avoid cross-test pollution.
 *
 * Run: bun run src/tests/memory/store.test.ts
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../memory/store.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface TempStore {
  store: MemoryStore;
  dir: string;
}

/** Create a MemoryStore backed by a fresh temp directory. */
function makeStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "aether-memory-store-"));
  return { store: new MemoryStore(join(dir, ".aether-cli", "memory")), dir };
}

async function testSetAndGetFileSummary() {
  console.log("TEST 1: setFileSummary stores and getFileSummary retrieves...");
  const ctx = makeStore();
  try {
    await ctx.store.setFileSummary("/proj/a", "src/main.ts", "entry point");
    const summary = await ctx.store.getFileSummary("/proj/a", "src/main.ts");
    assert(summary === "entry point", `expected stored summary, got ${summary}`);

    const missing = await ctx.store.getFileSummary("/proj/a", "nope.ts");
    assert(missing === null, "unknown file should return null");

    // Windows-style separators are normalized to forward slashes
    await ctx.store.setFileSummary("/proj/a", "src\\win.ts", "windows path");
    const normalized = await ctx.store.getFileSummary("/proj/a", "src/win.ts");
    assert(normalized === "windows path", `expected normalized lookup, got ${normalized}`);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ round-trip, null for missing, and path normalization");
}

async function testGetProjectFiles() {
  console.log("TEST 2: getProjectFiles returns all stored summaries...");
  const ctx = makeStore();
  try {
    await ctx.store.setFileSummary("/proj/a", "a.ts", "one");
    await ctx.store.setFileSummary("/proj/a", "b.ts", "two");
    await ctx.store.setFileSummary("/proj/a", "c.ts", "three");

    const files = await ctx.store.getProjectFiles("/proj/a");
    assert(Object.keys(files).length === 3, `expected 3 files, got ${Object.keys(files).length}`);
    assert(files["a.ts"] === "one" && files["b.ts"] === "two" && files["c.ts"] === "three", "summary values mismatch");

    const none = await ctx.store.getProjectFiles("/unknown");
    assert(Object.keys(none).length === 0, "unknown project should have no files");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ all summaries returned; unknown project is empty");
}

async function testAddDecisionAndGetDecisions() {
  console.log("TEST 3: addDecision records timestamped decisions...");
  const ctx = makeStore();
  try {
    const before = Date.now();
    await ctx.store.addDecision("/proj/a", "q1", "a1");
    await ctx.store.addDecision("/proj/a", "q2", "a2");

    const decisions = await ctx.store.getDecisions("/proj/a");
    assert(decisions.length === 2, `expected 2 decisions, got ${decisions.length}`);
    assert(decisions[0].question === "q1" && decisions[0].answer === "a1", "first decision mismatch");
    assert(decisions[1].question === "q2" && decisions[1].answer === "a2", "second decision mismatch");
    for (const d of decisions) {
      assert(typeof d.timestamp === "number", "timestamp should be a number");
      assert(d.timestamp >= before && d.timestamp <= Date.now(), "timestamp out of range");
    }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ decisions persisted with timestamps");
}

async function testAddTaskEntryAndGetTaskHistory() {
  console.log("TEST 4: addTaskEntry records timestamped task entries...");
  const ctx = makeStore();
  try {
    const before = Date.now();
    await ctx.store.addTaskEntry("/proj/a", "task-1", "generate", "ok");
    await ctx.store.addTaskEntry("/proj/a", "task-2", "review", "issues found");

    const tasks = await ctx.store.getTaskHistory("/proj/a");
    assert(tasks.length === 2, `expected 2 tasks, got ${tasks.length}`);
    assert(tasks[0].taskId === "task-1" && tasks[0].type === "generate" && tasks[0].outcome === "ok", "first task mismatch");
    assert(tasks[1].taskId === "task-2" && tasks[1].type === "review" && tasks[1].outcome === "issues found", "second task mismatch");
    for (const t of tasks) {
      assert(typeof t.timestamp === "number", "timestamp should be a number");
      assert(t.timestamp >= before && t.timestamp <= Date.now(), "timestamp out of range");
    }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ task entries persisted with timestamps");
}

async function testProjectIsolation() {
  console.log("TEST 5: different project roots have separate storage...");
  const ctx = makeStore();
  try {
    await ctx.store.setFileSummary("/proj/one", "file.ts", "summary-one");
    await ctx.store.addDecision("/proj/two", "q", "a");
    await ctx.store.addTaskEntry("/proj/two", "t", "review", "ok");

    const filesOne = await ctx.store.getProjectFiles("/proj/one");
    const filesTwo = await ctx.store.getProjectFiles("/proj/two");
    assert(filesOne["file.ts"] === "summary-one", "project one summary missing");
    assert(Object.keys(filesTwo).length === 0, "project two should have no file summaries");

    const decisionsOne = await ctx.store.getDecisions("/proj/one");
    const decisionsTwo = await ctx.store.getDecisions("/proj/two");
    assert(decisionsOne.length === 0, "project one should have no decisions");
    assert(decisionsTwo.length === 1 && decisionsTwo[0].answer === "a", "project two decision missing");

    const tasksOne = await ctx.store.getTaskHistory("/proj/one");
    const tasksTwo = await ctx.store.getTaskHistory("/proj/two");
    assert(tasksOne.length === 0, "project one should have no tasks");
    assert(tasksTwo.length === 1 && tasksTwo[0].taskId === "t", "project two task missing");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ projects are isolated across all data types");
}

async function testClearProject() {
  console.log("TEST 6: clearProject removes one project, keeps others intact...");
  const ctx = makeStore();
  try {
    await ctx.store.setFileSummary("/proj/one", "f.ts", "s1");
    await ctx.store.addDecision("/proj/one", "q", "a");
    await ctx.store.setFileSummary("/proj/two", "g.ts", "s2");
    await ctx.store.addTaskEntry("/proj/two", "t", "test", "ok");

    await ctx.store.clearProject("/proj/one");

    const filesOne = await ctx.store.getProjectFiles("/proj/one");
    const decisionsOne = await ctx.store.getDecisions("/proj/one");
    assert(Object.keys(filesOne).length === 0, "cleared project should have no files");
    assert(decisionsOne.length === 0, "cleared project should have no decisions");

    const filesTwo = await ctx.store.getProjectFiles("/proj/two");
    const tasksTwo = await ctx.store.getTaskHistory("/proj/two");
    assert(filesTwo["g.ts"] === "s2", "other project's files should remain");
    assert(tasksTwo.length === 1, "other project's tasks should remain");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ clearProject scoped to the target project");
}

async function testClearAll() {
  console.log("TEST 7: clearAll removes everything...");
  const ctx = makeStore();
  try {
    await ctx.store.setFileSummary("/proj/one", "f.ts", "s1");
    await ctx.store.addDecision("/proj/two", "q", "a");
    await ctx.store.addTaskEntry("/proj/three", "t", "test", "ok");

    await ctx.store.clearAll();

    assert(Object.keys(await ctx.store.getProjectFiles("/proj/one")).length === 0, "project one files remain");
    assert((await ctx.store.getDecisions("/proj/two")).length === 0, "project two decisions remain");
    assert((await ctx.store.getTaskHistory("/proj/three")).length === 0, "project three tasks remain");

    let baseExists = true;
    try {
      statSync(ctx.store.basePath);
    } catch {
      baseExists = false;
    }
    assert(!baseExists, "base memory directory should be removed");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  console.log("  ✓ clearAll removes the entire store");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — MemoryStore Tests          ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests = [
    testSetAndGetFileSummary,
    testGetProjectFiles,
    testAddDecisionAndGetDecisions,
    testAddTaskEntryAndGetTaskHistory,
    testProjectIsolation,
    testClearProject,
    testClearAll,
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
