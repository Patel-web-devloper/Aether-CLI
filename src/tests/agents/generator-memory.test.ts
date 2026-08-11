/**
 * Tests for Phase C — GeneratorAgent memory-awareness:
 *   1. GeneratorAgent searches MemoryStore summaries + decisions using prompt
 *      keywords, reads matched files, and injects them into the LLM prompt.
 *   2. No matches → falls back to scan-only generation (no memory section).
 *   3. MemoryStore not registered → graceful fallback, no throw.
 *   4. parseResponse accepts `### EDIT:` markers (with annotation line).
 *   5. MemoryAgent.enrichContext attaches memoryContext to the context.
 *
 * Run: bun run src/tests/agents/generator-memory.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import { MemoryStore } from "../../memory/store.js";
import { GeneratorAgent, parseResponse } from "../../agents/generator.js";
import { MemoryAgent } from "../../agents/memory.js";
import type { AgentContext, AgentOutput } from "../../agents/base.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ProviderFeature, StreamCallbacks } from "../../providers/base.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── Capturing mock provider ───────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  store: MemoryStore;
  container: ServiceContainer;
  provider: CapturingProvider;
  context: AgentContext;
}

/** Temp project dir with one source file + a MemoryStore registered in the container. */
function makeHarness(response: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aether-gen-memory-"));
  mkdirSync(join(dir, "src", "utils"), { recursive: true });
  writeFileSync(
    join(dir, "src", "utils", "format.ts"),
    'export function formatName(name: string): string {\n  return name.toUpperCase();\n}\n',
  );
  const store = new MemoryStore(join(dir, ".aether-cli", "memory"));
  const container = new ServiceContainer();
  container.register("memoryStore", store);
  const provider = new CapturingProvider(response);
  const eventBus = new EventBus();
  const context: AgentContext = {
    provider,
    model: "mock-model",
    targetDir: dir,
    eventBus,
    container,
    dryRun: false,
  };
  return { dir, store, container, provider, context };
}

const EDIT_RESPONSE = `### EDIT: src/utils/format.ts
\`\`\`typescript
export function formatName(name: string): string {
  return name.toLowerCase();
}
\`\`\``;

// ── Tests ─────────────────────────────────────────────────────────────────

async function testGeneratorUsesMemoryWhenSummariesMatch() {
  console.log("TEST 1: GeneratorAgent injects matched file content + decisions into prompt...");
  const h = makeHarness(EDIT_RESPONSE);
  try {
    // Summary contains "utility" and decision contains "formatting" — both are
    // keywords extracted from the prompt below, so both should match.
    await h.store.setFileSummary(h.dir, "src/utils/format.ts", "utility that formats user names to upper case");
    await h.store.addDecision(h.dir, "formatting helper", "prefer camelCase function names");

    const agent = new GeneratorAgent();
    const output = await agent.run(
      { prompt: "change formatName to lowercase in the formatting utility", options: { mode: "edit" } },
      h.context,
    );

    assert(output.success, `expected success, got ${output.error}`);
    const system = h.provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
    assert(system.includes("EXISTING FILES THAT NEED MODIFICATION"), "prompt should contain the memory edit section");
    assert(system.includes("These existing files need modification. Output EXACTLY which file, which lines, what to change."), "prompt should contain the exact instruction phrase");
    assert(system.includes("src/utils/format.ts"), "matched file path should be injected");
    assert(system.includes("name.toUpperCase()"), "matched file content should be injected");
    assert(system.includes("### EDIT: path/to/file.ts"), "prompt should guide the ### EDIT: output format");
    assert(system.includes("camelCase function names"), "matched decision should be injected");

    const files = output.files ?? [];
    assert(files.length === 1, `expected 1 parsed file, got ${files.length}`);
    assert(files[0].path === "src/utils/format.ts", `expected format.ts path, got ${files[0].path}`);
    assert(files[0].content.includes("toLowerCase()"), "parsed content should be the edited file");

    const result = output.result as { memoryMatches?: { files: number; decisions: number } | number };
    const matches = result.memoryMatches as { files: number; decisions: number };
    assert(matches.files === 1 && matches.decisions === 1, `expected 1 file + 1 decision match, got ${JSON.stringify(matches)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ memory search → file read → prompt injection → EDIT parse");
}

async function testGeneratorFallsBackWhenNothingMatches() {
  console.log("TEST 2: GeneratorAgent falls back to scan-only when memory has no matches...");
  const h = makeHarness(EDIT_RESPONSE);
  try {
    await h.store.setFileSummary(h.dir, "src/utils/format.ts", "formats user names to upper case");

    const agent = new GeneratorAgent();
    const output = await agent.run(
      { prompt: "create a brand new tic tac toe game", options: { mode: "create" } },
      h.context,
    );

    assert(output.success, `expected success, got ${output.error}`);
    const system = h.provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
    assert(!system.includes("EXISTING FILES THAT NEED MODIFICATION"), "no memory section expected when nothing matches");
    assert(!system.includes("These existing files need modification"), "no edit instruction expected");
    const result = output.result as { memoryMatches?: unknown };
    assert(result.memoryMatches === 0, `expected memoryMatches 0, got ${JSON.stringify(result.memoryMatches)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
  console.log("  ✓ scan-only fallback");
}

async function testGeneratorFallsBackWithoutMemoryStore() {
  console.log("TEST 3: GeneratorAgent does not throw when MemoryStore is not registered...");
  const dir = mkdtempSync(join(tmpdir(), "aether-gen-nomem-"));
  try {
    const provider = new CapturingProvider(EDIT_RESPONSE);
    const context: AgentContext = {
      provider,
      model: "mock-model",
      targetDir: dir,
      eventBus: new EventBus(),
      container: new ServiceContainer(), // no memoryStore registered
      dryRun: false,
    };
    const agent = new GeneratorAgent();
    const output = await agent.run({ prompt: "change formatName to lowercase", options: { mode: "edit" } }, context);
    assert(output.success, `expected success, got ${output.error}`);
    const system = provider.lastMessages.find((m) => m.role === "system")?.content ?? "";
    assert(!system.includes("EXISTING FILES THAT NEED MODIFICATION"), "no memory section expected without a store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ graceful fallback without memoryStore");
}

async function testParseResponseAcceptsEditMarkers() {
  console.log("TEST 4: parseResponse parses ### EDIT: markers (with annotation line)...");
  const raw = `### EDIT: src/a.ts
L12-20: replace upper-case with lower-case
\`\`\`typescript
export const a = "lower";
\`\`\``;
  const files = parseResponse(raw, "/tmp", "edit");
  assert(files.length === 1, `expected 1 file, got ${files.length}`);
  assert(files[0].path === "src/a.ts", `expected src/a.ts, got ${files[0].path}`);
  assert(files[0].action === "edit", `expected edit action, got ${files[0].action}`);
  assert(files[0].content.includes('"lower"'), "annotation line should not leak into content");
  console.log("  ✓ ### EDIT: parsed with action=edit");
}

async function testParseResponseStillAcceptsFileMarkers() {
  console.log("TEST 5: parseResponse still parses ### FILE: markers (no regression)...");
  const raw = `### FILE: src/b.ts
\`\`\`typescript
export const b = 1;
\`\`\``;
  const files = parseResponse(raw, "/tmp", "create");
  assert(files.length === 1, `expected 1 file, got ${files.length}`);
  assert(files[0].path === "src/b.ts", `expected src/b.ts, got ${files[0].path}`);
  console.log("  ✓ ### FILE: unchanged");
}

async function testMemoryAgentEnrichContextAttachesMemory() {
  console.log("TEST 6: MemoryAgent.enrichContext attaches memoryContext...");
  const dir = mkdtempSync(join(tmpdir(), "aether-enrich-"));
  try {
    const store = new MemoryStore(join(dir, ".aether-cli", "memory"));
    await store.setFileSummary(dir, "src/main.ts", "entry point of the app");
    await store.addDecision(dir, "logging", "use structured JSON logs");
    const container = new ServiceContainer();
    container.register("memoryStore", store);
    const context: AgentContext = {
      provider: new CapturingProvider(""),
      model: "mock-model",
      targetDir: dir,
      eventBus: new EventBus(),
      container,
      dryRun: false,
    };
    const agent = new MemoryAgent();
    const enriched = await agent.enrichContext(context);
    assert(enriched.memoryContext, "memoryContext should be attached");
    assert(enriched.memoryContext!.files.length === 1, `expected 1 file entry, got ${enriched.memoryContext!.files.length}`);
    assert(enriched.memoryContext!.files[0].path === "src/main.ts", "file path mismatch");
    assert(enriched.memoryContext!.files[0].summary === "entry point of the app", "summary mismatch");
    assert(enriched.memoryContext!.decisions.length === 1, "expected 1 decision");
    assert(enriched.memoryContext!.decisions[0].answer === "use structured JSON logs", "decision answer mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ memoryContext attached (files + decisions)");
}

async function testMemoryAgentEnrichContextWithoutStore() {
  console.log("TEST 7: MemoryAgent.enrichContext leaves context untouched without a store...");
  const dir = mkdtempSync(join(tmpdir(), "aether-enrich-nomem-"));
  try {
    const context: AgentContext = {
      provider: new CapturingProvider(""),
      model: "mock-model",
      targetDir: dir,
      eventBus: new EventBus(),
      container: new ServiceContainer(),
      dryRun: false,
    };
    const agent = new MemoryAgent();
    const enriched = await agent.enrichContext(context);
    assert(enriched.memoryContext === undefined, "memoryContext should stay undefined");
    assert(enriched.targetDir === dir, "context should otherwise be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ no-store enrichment is a no-op");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Generator Memory Tests     ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests: Array<() => Promise<void>> = [
    testGeneratorUsesMemoryWhenSummariesMatch,
    testGeneratorFallsBackWhenNothingMatches,
    testGeneratorFallsBackWithoutMemoryStore,
    testParseResponseAcceptsEditMarkers,
    testParseResponseStillAcceptsFileMarkers,
    testMemoryAgentEnrichContextAttachesMemory,
    testMemoryAgentEnrichContextWithoutStore,
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
