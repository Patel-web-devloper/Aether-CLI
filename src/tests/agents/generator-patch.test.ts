/**
 * Tests for Phase C2 — GeneratorAgent diff-style editing + impact analysis:
 *   1. applyPatch replaces a simple hunk
 *   2. applyPatch handles multiple hunks (with line-shift offset)
 *   3. applyPatch recovers from off-by-one line numbers (search fallback)
 *   4. applyPatch returns null when removed lines cannot be found (graceful fallback)
 *   5. applyPatch handles pure insertions + preserves trailing newline
 *   6. parseEdits recognizes `### EDIT:` markers with `@@ line N-M @@` hunks
 *   7. parseResponse still recognizes `### FILE:` markers (no regression)
 *   8. edit-mode system prompt contains diff-format instructions
 *   9. analyzeImpact returns affected files from memory summaries (basename/symbol)
 *  10. generateFromPrompt applies a patch end-to-end and returns impact
 *  11. edit mode falls back to full-content `### EDIT:` when no hunks present
 *
 * Run: bun run src/tests/agents/generator-patch.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import { MemoryStore } from "../../memory/store.js";
import {
  GeneratorAgent,
  parseResponse,
  parseEdits,
  applyPatch,
  analyzeImpact,
  generateFromPrompt,
  type FilePatch,
  type PatchHunk,
} from "../../agents/generator.js";
import type { AgentContext } from "../../agents/base.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ProviderFeature, StreamCallbacks } from "../../providers/base.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── Capturing mock provider (same shape as generator-memory tests) ────────

class CapturingProvider implements LLMProvider {
  readonly name = "Capturing";
  readonly slug = "capturing";
  lastMessages: ChatMessage[] = [];
  private response: string;

  constructor(response: string) {
    this.response = response;
  }

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    this.lastMessages = messages;
    return { content: this.response, model: "mock-model", finishReason: "stop" };
  }
  async streamChat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    callbacks?.onToken?.(this.response);
    callbacks?.onDone?.({ content: this.response, model: "mock-model", finishReason: "stop" });
  }
  supportsFeature(_feature: ProviderFeature): boolean {
    return true;
  }
  async listModels(): Promise<string[]> {
    return ["mock-model"];
  }
  async initialize(): Promise<void> {}
}

function hunk(partial: Partial<PatchHunk> & { startLine: number; endLine: number }): PatchHunk {
  return { removed: [], added: [], ...partial };
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testApplyPatchSimpleHunk() {
  console.log("TEST 1: applyPatch replaces a simple hunk...");
  const patch: FilePatch = {
    path: "x.ts",
    hunks: [hunk({ startLine: 2, endLine: 2, removed: ["line2"], added: ["line2-updated"] })],
  };
  const result = applyPatch("line1\nline2\nline3", patch);
  assert(result === "line1\nline2-updated\nline3", `unexpected result: ${JSON.stringify(result)}`);
  console.log("  ✓ simple replacement");
}

async function testApplyPatchMultipleHunks() {
  console.log("TEST 2: applyPatch handles multiple hunks with line-shift offset...");
  const patch: FilePatch = {
    path: "x.ts",
    hunks: [
      hunk({ startLine: 2, endLine: 2, removed: ["two"], added: ["TWO", "TWO_B"] }),
      hunk({ startLine: 4, endLine: 4, removed: ["four"], added: ["FOUR"] }),
    ],
  };
  const result = applyPatch(["one", "two", "three", "four", "five", "six"].join("\n"), patch);
  const expected = ["one", "TWO", "TWO_B", "three", "FOUR", "five", "six"].join("\n");
  assert(result === expected, `unexpected result: ${JSON.stringify(result)}`);
  console.log("  ✓ two hunks applied, offset tracked");
}

async function testApplyPatchOffByOneRecovery() {
  console.log("TEST 3: applyPatch recovers from off-by-one line numbers (search fallback)...");
  const patch: FilePatch = {
    path: "x.ts",
    hunks: [hunk({ startLine: 2, endLine: 3, removed: ["c", "d"], added: ["X"] })],
  };
  const result = applyPatch("a\nb\nc\nd", patch);
  assert(result === "a\nb\nX", `expected search fallback to apply at found block: ${JSON.stringify(result)}`);
  console.log("  ✓ removed block located by search");
}

async function testApplyPatchFailsOnUnfindableRemoved() {
  console.log("TEST 4: applyPatch returns null when removed lines cannot be found...");
  const patch: FilePatch = {
    path: "x.ts",
    hunks: [hunk({ startLine: 1, endLine: 1, removed: ["zzz"], added: ["x"] })],
  };
  const result = applyPatch("a\nb\nc", patch);
  assert(result === null, `expected null, got ${JSON.stringify(result)}`);
  console.log("  ✓ graceful null fallback");
}

async function testApplyPatchInsertionAndTrailingNewline() {
  console.log("TEST 5: applyPatch handles pure insertion and preserves trailing newline...");
  const insert: FilePatch = {
    path: "x.ts",
    hunks: [hunk({ startLine: 2, endLine: 2, added: ["X"] })],
  };
  assert(applyPatch("a\nb", insert) === "a\nX\nb", "insertion before line 2 failed");
  const trailing: FilePatch = {
    path: "x.ts",
    hunks: [hunk({ startLine: 2, endLine: 2, removed: ["b"], added: ["B"] })],
  };
  assert(applyPatch("a\nb\n", trailing) === "a\nB\n", "trailing newline should be preserved");
  console.log("  ✓ insertion + trailing-newline fidelity");
}

async function testParseEditsRecognizesEditMarkers() {
  console.log("TEST 6: parseEdits recognizes ### EDIT: markers with @@ hunks...");
  const raw = `### EDIT: src/utils/format.ts
L12-20: replace upper-case with lower-case
@@ line 12-20 @@
-const a = 1;
+const a = 2;
-const b = 3;
+const b = 4;

### EDIT: src/main.ts
@@ line 1-1 @@
+import { formatName } from "./utils/format";

### EDIT: ../evil.ts
@@ line 1-1 @@
-bad
+bad2
`;
  const patches = parseEdits(raw);
  assert(patches.length === 2, `expected 2 patches, got ${patches.length}`);
  assert(patches[0].path === "src/utils/format.ts", `path mismatch: ${patches[0].path}`);
  assert(patches[0].hunks.length === 1, `expected 1 hunk, got ${patches[0].hunks.length}`);
  const h = patches[0].hunks[0];
  assert(h.startLine === 12 && h.endLine === 20, `hunk header mismatch: ${h.startLine}-${h.endLine}`);
  assert(h.removed.length === 2 && h.removed[0] === "const a = 1;" && h.removed[1] === "const b = 3;", "removed lines mismatch");
  assert(h.added.length === 2 && h.added[0] === "const a = 2;" && h.added[1] === "const b = 4;", "added lines mismatch");
  assert(patches[1].path === "src/main.ts", `second patch path mismatch: ${patches[1].path}`);
  assert(patches[1].hunks[0].added[0] === 'import { formatName } from "./utils/format";', "insertion hunk content mismatch");
  assert(!patches.some((p) => p.path.includes("..")), "path traversal must be rejected");
  console.log("  ✓ multi-block parse, hunk lines, annotation skipped, traversal rejected");
}

async function testParseResponseStillRecognizesFileMarkers() {
  console.log("TEST 7: parseResponse still parses ### FILE: markers (no regression)...");
  const raw = `### FILE: src/b.ts
\`\`\`typescript
export const b = 1;
\`\`\``;
  const files = parseResponse(raw, "/tmp", "create");
  assert(files.length === 1, `expected 1 file, got ${files.length}`);
  assert(files[0].path === "src/b.ts", `expected src/b.ts, got ${files[0].path}`);
  assert(files[0].action === "create", `expected create action, got ${files[0].action}`);
  console.log("  ✓ ### FILE: unchanged");
}

async function testEditModePromptContainsDiffInstructions() {
  console.log("TEST 8: edit-mode system prompt contains diff-format instructions...");
  const dir = mkdtempSync(join(tmpdir(), "aether-edit-prompt-"));
  try {
    const response = `### EDIT: src/utils/format.ts
\`\`\`typescript
export function formatName(name: string): string {
  return name.toLowerCase();
}
\`\`\``;
    const provider = new CapturingProvider(response);
    const context: AgentContext = {
      provider,
      model: "mock-model",
      targetDir: dir,
      eventBus: new EventBus(),
      container: new ServiceContainer(), // no memoryStore → base prompt
      dryRun: false,
    };
    const agent = new GeneratorAgent();
    const output = await agent.run(
      { prompt: "change formatName to lowercase", options: { mode: "edit" } },
      context,
    );
    assert(output.success, `expected success, got ${output.error}`);
    const system = provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
    assert(system.includes("@@ line N-M @@"), "edit prompt should document hunk headers");
    assert(system.includes("NEVER the full file content"), "edit prompt should forbid full-file output");
    assert(system.includes("### EDIT:"), "edit prompt should mention ### EDIT: markers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ diff instructions present in edit-mode prompt");
}

async function testImpactAnalysisReturnsAffectedFiles() {
  console.log("TEST 9: analyzeImpact returns affected files from memory summaries...");
  const dir = mkdtempSync(join(tmpdir(), "aether-impact-"));
  try {
    const store = new MemoryStore(join(dir, ".aether-cli", "memory"));
    await store.setFileSummary(dir, "src/utils/format.ts", "utility that formats user names to upper case");
    await store.setFileSummary(dir, "src/ui/display.ts", "renders formatName() output in the profile view");
    await store.setFileSummary(dir, "src/ui/total.ts", "shows sumAll totals in the summary card");
    await store.setFileSummary(dir, "src/config/settings.ts", "reads theme and locale preferences");

    const patches: FilePatch[] = [
      {
        path: "src/utils/format.ts",
        hunks: [hunk({ startLine: 1, endLine: 1, removed: ["export function formatName(name: string): string {"], added: ["export function formatName(name: string, lang: string): string {"] })],
      },
      {
        path: "src/utils/math.ts",
        hunks: [hunk({ startLine: 1, endLine: 1, added: ["export function sumAll(numbers: number[]): number {"] })],
      },
    ];

    const impact = await analyzeImpact(patches, dir, store);
    assert(impact.changedFiles.length === 2, `expected 2 changed files, got ${JSON.stringify(impact.changedFiles)}`);
    assert(impact.affectedFiles.includes("src/ui/display.ts"), "display.ts should be flagged via symbol formatName");
    assert(impact.affectedFiles.includes("src/ui/total.ts"), "total.ts should be flagged via symbol sumAll");
    assert(!impact.affectedFiles.includes("src/utils/format.ts"), "the changed file itself must not be flagged");
    assert(!impact.affectedFiles.includes("src/config/settings.ts"), "unrelated file must not be flagged");
    assert(impact.rationale.length > 0, "rationale should be non-empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ symbol/basename matching, self-exclusion, no false positives");
}

async function testGenerateFromPromptAppliesPatch() {
  console.log("TEST 10: generateFromPrompt applies a patch end-to-end and returns impact...");
  const dir = mkdtempSync(join(tmpdir(), "aether-gen-patch-"));
  try {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(
      join(dir, "src", "utils", "format.ts"),
      'export function formatName(name: string): string {\n  return name.toUpperCase();\n}\n',
    );

    const store = new MemoryStore(join(dir, ".aether-cli", "memory"));
    await store.setFileSummary(dir, "src/ui/display.ts", "renders formatName() output in the profile view");

    const response = `### EDIT: src/utils/format.ts
@@ line 1-1 @@
-export function formatName(name: string): string {
+export function formatName(name: string, lang: string): string {
@@ line 2-2 @@
-  return name.toUpperCase();
+  return name.toUpperCase();
`;
    const provider = new CapturingProvider(response);
    const result = await generateFromPrompt("make formatName locale-aware", {
      provider,
      model: "mock-model",
      mode: "edit",
      targetDir: dir,
      memoryStore: store,
    });

    assert(result.files.length === 1, `expected 1 file, got ${result.files.length}`);
    assert(result.files[0].path === "src/utils/format.ts", "path mismatch");
    assert(result.files[0].action === "edit", `expected edit action, got ${result.files[0].action}`);
    const expected = 'export function formatName(name: string, lang: string): string {\n  return name.toUpperCase();\n}\n';
    assert(result.files[0].content === expected, `content mismatch:\n${result.files[0].content}`);
    assert(result.patches?.length === 1, `expected 1 patch, got ${result.patches?.length}`);
    assert((result.warnings ?? []).length === 0, `expected no warnings, got ${JSON.stringify(result.warnings)}`);
    assert(result.impact?.affectedFiles.includes("src/ui/display.ts"), "impact should flag display.ts via symbol formatName");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ patch applied to disk content, impact reported");
}

async function testEditModeFallsBackToFullContent() {
  console.log("TEST 11: edit mode falls back to full-content ### EDIT: when no hunks present...");
  const dir = mkdtempSync(join(tmpdir(), "aether-edit-fallback-"));
  try {
    const response = `### EDIT: src/utils/format.ts
L1-3: switch to lower-case
\`\`\`typescript
export function formatName(name: string): string {
  return name.toLowerCase();
}
\`\`\``;
    const provider = new CapturingProvider(response);
    const result = await generateFromPrompt("change formatName to lowercase", {
      provider,
      model: "mock-model",
      mode: "edit",
      targetDir: dir,
    });
    assert(result.files.length === 1, `expected 1 file, got ${result.files.length}`);
    assert(result.files[0].content.includes("toLowerCase()"), "full-file content should be parsed as before");
    assert(result.files[0].action === "edit", `expected edit action, got ${result.files[0].action}`);
    assert(result.patches === undefined || result.patches.length === 0, "no diff patches expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ legacy full-content ### EDIT: still works");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Generator Diff/Impact Tests ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests: Array<() => Promise<void>> = [
    testApplyPatchSimpleHunk,
    testApplyPatchMultipleHunks,
    testApplyPatchOffByOneRecovery,
    testApplyPatchFailsOnUnfindableRemoved,
    testApplyPatchInsertionAndTrailingNewline,
    testParseEditsRecognizesEditMarkers,
    testParseResponseStillRecognizesFileMarkers,
    testEditModePromptContainsDiffInstructions,
    testImpactAnalysisReturnsAffectedFiles,
    testGenerateFromPromptAppliesPatch,
    testEditModeFallsBackToFullContent,
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
