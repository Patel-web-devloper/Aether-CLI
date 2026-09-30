/**
 * Tests for Phase E — Repo Map:
 *   1. groups symbols under their file/directory
 *   2. respects max depth (collapses deep directories)
 *   3. handles an empty project gracefully
 *   4. only lists meaningful symbols (functions/classes/methods/exports,
 *      not raw imports/variables) alongside each file
 *
 * Run: bun run src/tests/intelligence/repo-map.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../../intelligence/indexer.js";
import { generateRepoMap } from "../../intelligence/repo-map.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testMapGroupsFiles() {
  const dir = mkdtempSync(join(tmpdir(), "aether-map-"));
  const cache = join(tmpdir(), `aether-map-cache-${Date.now()}`);
  try {
    mkdirSync(join(dir, "src", "agents"), { recursive: true });
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(join(dir, "src", "agents", "generator.ts"),
      'export function generateFromPrompt(p: string): string { return p; }\nexport class GeneratorAgent {}\n');
    writeFileSync(join(dir, "src", "core", "events.ts"),
      'export class EventBus {}');
    const indexer = new CodeIndexer(cache);
    const idx = await indexer.indexProject(dir);
    const map = generateRepoMap(idx, dir);
    assert(map.includes("agents/"), `agents dir missing:\n${map}`);
    assert(map.includes("generator.ts → GeneratorAgent, generateFromPrompt"), `generator grouping wrong:\n${map}`);
    assert(map.includes("events.ts → EventBus"), `events grouping wrong:\n${map}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ map groups symbols under file/directory");
}

async function testMapDepthLimit() {
  const dir = mkdtempSync(join(tmpdir(), "aether-map-depth-"));
  const cache = join(tmpdir(), `aether-map-depth-cache-${Date.now()}`);
  try {
    mkdirSync(join(dir, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "d", "deep.ts"), "export function deepFn() {}");
    const indexer = new CodeIndexer(cache);
    const idx = await indexer.indexProject(dir);
    const shallow = generateRepoMap(idx, dir, 2);
    assert(shallow.includes("below max depth"), `deep dirs should be collapsed:\n${shallow}`);
    const deep = generateRepoMap(idx, dir, 10);
    assert(deep.includes("deep.ts → deepFn"), `deep file should appear at high depth:\n${deep}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ map respects depth limit");
}

async function testMapEmptyProject() {
  const dir = mkdtempSync(join(tmpdir(), "aether-map-empty-"));
  const cache = join(tmpdir(), `aether-map-empty-cache-${Date.now()}`);
  try {
    const indexer = new CodeIndexer(cache);
    const idx = await indexer.indexProject(dir);
    const map = generateRepoMap(idx, dir);
    assert(map.trim() === "", `empty project should produce empty map, got: ${JSON.stringify(map)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ map handles empty project");
}

async function testMapSymbolGrouping() {
  const dir = mkdtempSync(join(tmpdir(), "aether-map-sym-"));
  const cache = join(tmpdir(), `aether-map-sym-cache-${Date.now()}`);
  try {
    writeFileSync(join(dir, "util.ts"),
      'export function publicFn() {}\nconst internalVar = 1;\nimport os from "node:os";\nexport class Widget {}\n');
    const indexer = new CodeIndexer(cache);
    const idx = await indexer.indexProject(dir);
    const map = generateRepoMap(idx, dir);
    assert(map.includes("publicFn") && map.includes("Widget"), `should show publicFn and Widget:\n${map}`);
    assert(!map.includes("internalVar"), `internal variable should be hidden from map:\n${map}`);
    assert(!map.includes("os"), `bare import should be hidden from map:\n${map}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ map lists functions/classes but omits vars/imports");
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Repo Map Tests             ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests: Array<() => Promise<void>> = [
    testMapGroupsFiles,
    testMapDepthLimit,
    testMapEmptyProject,
    testMapSymbolGrouping,
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
