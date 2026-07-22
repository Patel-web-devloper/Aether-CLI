/**
 * Integration test for the generate pipeline.
 *
 * Uses a mock provider to verify the full flow:
 *   scanner → generator → parser → writer
 *
 * Run: bun run src/tests/generate.test.ts
 */

import { generateFromPrompt } from "../agents/generator.js";
import { writeFiles, formatResults } from "../utils/writer.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ProviderFeature, StreamCallbacks } from "../providers/base.js";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock provider that returns a controlled response ────────────────────

class MockProvider implements LLMProvider {
  readonly name = "Mock";
  readonly slug = "mock";
  private response: string;

  constructor(response: string) {
    this.response = response;
  }

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    return {
      content: this.response,
      model: "mock-model",
      finishReason: "stop",
    };
  }

  async streamChat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    callbacks?.onToken?.(this.response);
    callbacks?.onDone?.({
      content: this.response,
      model: "mock-model",
      finishReason: "stop",
    });
  }

  supportsFeature(_feature: ProviderFeature): boolean {
    return true;
  }

  async listModels(): Promise<string[]> {
    return ["mock-model"];
  }

  async initialize(): Promise<void> {
    // no-op
  }
}

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "aether-test-"));
}

// ── Tests ───────────────────────────────────────────────────────────────

async function testSingleFileGeneration() {
  console.log("TEST 1: Single file generation...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: src/hello.ts
\`\`\`typescript
/**
 * Returns a hello world greeting.
 */
export function hello(): string {
  return "Hello, world!";
}
\`\`\``;

    const provider = new MockProvider(mockResponse);

    const result = await generateFromPrompt("Create a hello world function", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    // Verify parsing
    if (result.files.length !== 1) {
      throw new Error(`Expected 1 file, got ${result.files.length}`);
    }

    const file = result.files[0];
    if (file.path !== "src/hello.ts") {
      throw new Error(`Expected path "src/hello.ts", got "${file.path}"`);
    }

    if (!file.content.includes("export function hello")) {
      throw new Error(`Expected hello function in content, got: ${file.content.slice(0, 50)}`);
    }

    // Write files
    const writeResults = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    const created = writeResults.filter((r) => r.status === "created");
    if (created.length !== 1) {
      throw new Error(`Expected 1 created file, got ${created.length}: ${JSON.stringify(writeResults)}`);
    }

    // Verify file on disk
    const written = readFileSync(join(tmpDir, "src/hello.ts"), "utf-8");
    if (!written.includes("Hello, world!")) {
      throw new Error(`File content mismatch: ${written.slice(0, 50)}`);
    }

    console.log("  ✓ Single file generated and written correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMultipleFileGeneration() {
  console.log("TEST 2: Multiple file generation...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: src/math.ts
\`\`\`typescript
export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
\`\`\`

### FILE: src/math.test.ts
\`\`\`typescript
import { sum } from "./math";

test("sum works", () => {
  expect(sum([1, 2, 3])).toBe(6);
});
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Create math utilities with tests", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    if (result.files.length !== 2) {
      throw new Error(`Expected 2 files, got ${result.files.length}`);
    }

    // Write files
    const writeResults = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    const created = writeResults.filter((r) => r.status === "created");
    if (created.length !== 2) {
      throw new Error(`Expected 2 created, got ${created.length}`);
    }

    // Check both files exist
    if (!existsSync(join(tmpDir, "src/math.ts"))) throw new Error("src/math.ts missing");
    if (!existsSync(join(tmpDir, "src/math.test.ts"))) throw new Error("src/math.test.ts missing");

    console.log("  ✓ Multiple files generated and written correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testDryRunShowsDiff() {
  console.log("TEST 3: Dry-run shows diffs without writing...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: app.ts
\`\`\`typescript
console.log("hello");
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Create app", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    // Dry-run write
    const writeResults = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: true,
    });

    const dryRuns = writeResults.filter((r) => r.status === "dry-run");
    if (dryRuns.length !== 1) {
      throw new Error(`Expected 1 dry-run entry, got ${dryRuns.length}`);
    }

    if (!dryRuns[0].diff) {
      throw new Error("Expected diff content in dry-run result");
    }

    // Verify file was NOT written
    if (existsSync(join(tmpDir, "app.ts"))) {
      throw new Error("app.ts should NOT exist after dry-run");
    }

    console.log("  ✓ Dry-run shows diff, no files written\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testConflictDetection() {
  console.log("TEST 4: Conflict detection...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: existing.ts
\`\`\`typescript
export const x = 2;
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Create existing.ts", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    // Write once
    await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    // Try to write again without --force
    const writeResults2 = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    const conflicts = writeResults2.filter((r) => r.status === "conflict");
    if (conflicts.length !== 1) {
      throw new Error(`Expected 1 conflict, got ${conflicts.length}: ${JSON.stringify(writeResults2)}`);
    }

    // Now with --force
    const writeResults3 = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: true,
      dryRun: false,
    });

    const modified = writeResults3.filter((r) => r.status === "modified");
    if (modified.length !== 1) {
      throw new Error(`Expected 1 modified with force, got ${modified.length}: ${JSON.stringify(writeResults3)}`);
    }

    console.log("  ✓ Conflict detection and force overwrite work\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testEmptyResponseHandling() {
  console.log("TEST 5: Empty response handling...");

  const tmpDir = makeTempDir();

  try {
    const provider = new MockProvider("");

    try {
      await generateFromPrompt("anything", {
        provider,
        mode: "create",
        targetDir: tmpDir,
      });
      throw new Error("Expected error for empty response");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("empty")) {
        throw new Error(`Expected "empty" in error, got: ${msg}`);
      }
    }

    console.log("  ✓ Empty response throws proper error\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testEditModeSkipsNewFiles() {
  console.log("TEST 6: Edit mode skips non-existent files...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: nonexistent.ts
\`\`\`typescript
export const y = 3;
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Edit nonexistent file", {
      provider,
      mode: "edit",
      targetDir: tmpDir,
    });

    const writeResults = await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    const skipped = writeResults.filter((r) => r.status === "skipped");
    if (skipped.length !== 1) {
      throw new Error(`Expected 1 skipped, got ${skipped.length}`);
    }

    console.log("  ✓ Edit mode skips non-existent files\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testParentDirectoryCreation() {
  console.log("TEST 7: Parent directories are auto-created...");

  const tmpDir = makeTempDir();

  try {
    const mockResponse = `### FILE: deeply/nested/path/file.ts
\`\`\`typescript
export const deep = true;
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Create deeply nested file", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    await writeFiles(result.files, {
      baseDir: tmpDir,
      force: false,
      dryRun: false,
    });

    const fullPath = join(tmpDir, "deeply/nested/path/file.ts");
    if (!existsSync(fullPath)) {
      throw new Error(`File not created at ${fullPath}`);
    }

    const content = readFileSync(fullPath, "utf-8");
    if (!content.includes("export const deep")) {
      throw new Error("Content mismatch");
    }

    console.log("  ✓ Parent directories auto-created\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testProjectContextDetection() {
  console.log("TEST 8: Project context is detected...");

  const tmpDir = makeTempDir();

  try {
    // Create a mini project
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), 'console.log("test");');
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      dependencies: { react: "^19.0.0" },
    }));

    const mockResponse = `### FILE: src/extra.ts
\`\`\`typescript
export const extra = true;
\`\`\``;

    const provider = new MockProvider(mockResponse);
    const result = await generateFromPrompt("Add extra file", {
      provider,
      mode: "create",
      targetDir: tmpDir,
    });

    // Check context
    if (result.context.language !== "TypeScript") {
      throw new Error(`Expected TypeScript, got: ${result.context.language}`);
    }
    if (result.context.framework !== "React") {
      throw new Error(`Expected React framework, got: ${result.context.framework}`);
    }
    if (!result.context.fileTree.includes("src/")) {
      throw new Error(`Expected src/ in file tree, got: ${result.context.fileTree}`);
    }

    console.log("  ✓ Project context detection works\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Run all tests ───────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Aether CLI — Generate Pipeline Tests ║");
  console.log("╚══════════════════════════════════════╝\n");

  const tests = [
    testSingleFileGeneration,
    testMultipleFileGeneration,
    testDryRunShowsDiff,
    testConflictDetection,
    testEmptyResponseHandling,
    testEditModeSkipsNewFiles,
    testParentDirectoryCreation,
    testProjectContextDetection,
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
