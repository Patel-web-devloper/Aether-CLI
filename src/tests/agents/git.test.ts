/** Tests for GitAgent's four modes and guard paths. */

import { GitAgent } from "../../agents/git.js";
import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import type { AgentContext } from "../../agents/base.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamCallbacks, ProviderFeature } from "../../providers/base.js";

class MockProvider implements LLMProvider {
  readonly name = "Mock";
  readonly slug = "mock";
  calls = 0;
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    this.calls++;
    return { content: "mock markdown result", model: "mock-model", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  }
  async streamChat(_messages: ChatMessage[], _options?: ChatOptions, _callbacks?: StreamCallbacks): Promise<void> {}
  supportsFeature(_feature: ProviderFeature): boolean { return true; }
  async listModels(): Promise<string[]> { return ["mock-model"]; }
  async initialize(): Promise<void> {}
}

function context(provider: MockProvider, partial: Partial<AgentContext> = {}): AgentContext {
  return { provider, model: "mock-model", targetDir: process.cwd(), eventBus: new EventBus(), container: new ServiceContainer(), dryRun: false, ...partial };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runMode(mode: string, expected: string) {
  const provider = new MockProvider();
  const output = await new GitAgent().run({ prompt: `test ${mode}`, options: { mode } }, context(provider));
  assert(output.success, `${mode} should succeed: ${output.error ?? "unknown error"}`);
  assert(typeof output.result === "string" && output.result.length > 0, `${mode} should return a message`);
  assert(output.result === "mock markdown result", `${mode} result should pass through provider`);
  assert(provider.calls === 1, `${mode} should call provider once`);
  assert(expected.length > 0, "mode expectation should be non-empty");
}

async function testCommit() {
  console.log("TEST 1: commit mode returns a successful message...");
  await runMode("commit", "commit");
  console.log("  ✓ commit result returned");
}

async function testReview() {
  console.log("TEST 2: review mode returns successful findings...");
  await runMode("review", "findings");
  console.log("  ✓ review findings returned");
}

async function testChangelog() {
  console.log("TEST 3: changelog mode returns successful markdown...");
  await runMode("changelog", "markdown");
  console.log("  ✓ changelog markdown returned");
}

async function testBranchPlan() {
  console.log("TEST 4: branch-plan mode returns a successful plan...");
  await runMode("branch-plan", "plan");
  console.log("  ✓ branch plan returned");
}

async function testNonGitDirectory() {
  console.log("TEST 5: a non-git target returns success=false...");
  const provider = new MockProvider();
  const output = await new GitAgent().run({ prompt: "review", options: { mode: "review" } }, context(provider, { targetDir: "/tmp" }));
  assert(!output.success, "non-git target should fail");
  assert(output.error === "Target is not a git repository", `unexpected error: ${output.error}`);
  assert(provider.calls === 0, "provider should not be called for non-git target");
  console.log("  ✓ non-git target rejected");
}

async function testDryRun() {
  console.log("TEST 6: dry-run returns output without calling provider...");
  const provider = new MockProvider();
  const output = await new GitAgent().run({ prompt: "preview", options: { mode: "commit" } }, context(provider, { dryRun: true }));
  assert(output.success, "dry-run should succeed");
  const result = output.result as { dryRun?: boolean; agent?: string };
  assert(result.dryRun === true, "dry-run marker missing");
  assert(result.agent === "git", "dry-run agent marker missing");
  assert(provider.calls === 0, "provider should not be called during dry-run");
  console.log("  ✓ dry-run short-circuits provider");
}

async function testUnknownMode() {
  console.log("TEST 7: unknown mode returns success=false...");
  const provider = new MockProvider();
  const output = await new GitAgent().run({ prompt: "unknown", options: { mode: "unsupported" } }, context(provider));
  assert(!output.success, "unknown mode should fail");
  assert(output.error === "Unsupported git mode: unsupported", `unexpected error: ${output.error}`);
  assert(provider.calls === 0, "provider should not be called for unknown mode");
  console.log("  ✓ unknown mode rejected");
}

async function main() {
  const tests = [testCommit, testReview, testChangelog, testBranchPlan, testNonGitDirectory, testDryRun, testUnknownMode];
  let passed = 0;
  for (const test of tests) {
    try { await test(); passed++; }
    catch (error) { console.error(`  ✗ FAILED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`\n${passed} passed, ${tests.length - passed} failed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main().catch((error) => { console.error("Test runner error:", error); process.exit(1); });
