/**
 * Tests for the Agent base class — lifecycle hooks, event emission,
 * timing, error handling, and dry-run behavior.
 *
 * Run: bun test src/tests/agents/base.test.ts
 */

import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import {
  Agent,
  type AgentInput,
  type AgentContext,
  type AgentOutput,
} from "../../agents/base.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamCallbacks, ProviderFeature } from "../../providers/base.js";

// ── Mock provider that throws if actually called ─────────────────────────

class FailingProvider implements LLMProvider {
  readonly name = "Failing";
  readonly slug = "failing";
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    throw new Error("provider.chat should not be called");
  }
  async streamChat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
    _callbacks?: StreamCallbacks,
  ): Promise<void> {
    throw new Error("provider.streamChat should not be called");
  }
  supportsFeature(_feature: ProviderFeature): boolean {
    return true;
  }
  async listModels(): Promise<string[]> {
    return ["mock-model"];
  }
  async initialize(): Promise<void> {}
}

// ── Test agents ───────────────────────────────────────────────────────────

class RecordingAgent extends Agent {
  readonly name = "recording";
  readonly description = "Recording test agent";
  readonly capabilities = ["test"];
  calls: string[] = [];

  async beforeExecute(_input: AgentInput, _context: AgentContext): Promise<void> {
    this.calls.push("beforeExecute");
  }
  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);
    this.calls.push("execute");
    return {
      success: true,
      result: `echo: ${input.prompt}`,
      metadata: { agent: this.name, duration: 0 },
    };
  }
  async afterExecute(_output: AgentOutput, _context: AgentContext): Promise<void> {
    this.calls.push("afterExecute");
  }
}

class ThrowingAgent extends Agent {
  readonly name = "throwing";
  readonly description = "Throwing test agent";
  readonly capabilities = ["test"];
  onErrorCalls: number = 0;

  async execute(_input: AgentInput, _context: AgentContext): Promise<AgentOutput> {
    throw new Error("boom");
  }
  async onError(error: Error, _context: AgentContext): Promise<void> {
    this.onErrorCalls++;
    if (error.message !== "boom") {
      throw new Error("onError received the wrong error");
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeContext(partial?: Partial<AgentContext>): AgentContext {
  return {
    provider: new FailingProvider(),
    model: "mock-model",
    targetDir: process.cwd(),
    eventBus: new EventBus(),
    container: new ServiceContainer(),
    dryRun: false,
    ...partial,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testAgentRunEmitsLifecycleEvents() {
  console.log("TEST 1: agent:start and agent:done events are emitted...");
  const context = makeContext();
  const events: string[] = [];
  context.eventBus.on("agent:start", (e) => events.push(`start:${e.agent}`));
  context.eventBus.on("agent:done", (e) => events.push(`done:${e.agent}`));
  context.eventBus.on("agent:error", () => events.push("error"));

  const agent = new RecordingAgent();
  const output = await agent.run({ prompt: "hi" }, context);

  if (!output.success) throw new Error("expected success");
  if (events.length !== 2) throw new Error(`expected 2 events, got ${events.length}: ${events.join(", ")}`);
  if (events[0] !== "start:recording" || events[1] !== "done:recording") {
    throw new Error(`unexpected event order: ${events.join(", ")}`);
  }
  console.log("  ✓ lifecycle events emitted in order");
}

async function testAgentRunCallsLifecycleHooksInOrder() {
  console.log("TEST 2: beforeExecute → execute → afterExecute order...");
  const agent = new RecordingAgent();
  const output = await agent.run({ prompt: "hi" }, makeContext());
  if (!output.success) throw new Error("expected success");
  if (agent.calls.join(",") !== "beforeExecute,execute,afterExecute") {
    throw new Error(`unexpected hook order: ${agent.calls.join(",")}`);
  }
  console.log("  ✓ hooks called in order");
}

async function testAgentTracksDurationAndModel() {
  console.log("TEST 3: duration and model are tracked in metadata...");
  const agent = new RecordingAgent();
  const output = await agent.run({ prompt: "hi" }, makeContext());
  if (typeof output.metadata.duration !== "number" || output.metadata.duration < 0) {
    throw new Error(`bad duration: ${output.metadata.duration}`);
  }
  if (output.metadata.agent !== "recording") throw new Error("bad agent in metadata");
  if (output.metadata.modelUsed !== "mock-model") throw new Error("bad modelUsed");
  console.log("  ✓ metadata populated");
}

async function testAgentErrorEmitsErrorEventAndReturnsFailure() {
  console.log("TEST 4: thrown errors emit agent:error and return success=false...");
  const context = makeContext();
  let errorEvent: Error | undefined;
  context.eventBus.on("agent:error", (e) => {
    errorEvent = e.error;
  });

  const agent = new ThrowingAgent();
  const output = await agent.run({ prompt: "hi" }, context);

  if (output.success) throw new Error("expected failure output");
  if (output.error !== "boom") throw new Error(`unexpected error: ${output.error}`);
  if (!errorEvent || errorEvent.message !== "boom") throw new Error("agent:error not emitted with the error");
  if (agent.onErrorCalls !== 1) throw new Error("onError hook not called exactly once");
  console.log("  ✓ error path works (output + event + hook)");
}

async function testAgentDryRunNeverCallsProvider() {
  console.log("TEST 5: dry-run returns early without calling the provider...");
  const agent = new RecordingAgent();
  const output = await agent.run(
    { prompt: "hi" },
    makeContext({ dryRun: true }),
  );
  if (!output.success) throw new Error("dry-run should succeed");
  const result = output.result as { dryRun?: boolean };
  if (!result.dryRun) throw new Error("dry-run marker missing from result");
  if (agent.calls.includes("execute")) throw new Error("execute() ran during dry-run");
  console.log("  ✓ dry-run short-circuits before execute");
}

async function testAgentResultPassthrough() {
  console.log("TEST 6: execute() result passes through run()...");
  const agent = new RecordingAgent();
  const output = await agent.run({ prompt: "hello world" }, makeContext());
  if (output.result !== "echo: hello world") {
    throw new Error(`result not passed through: ${JSON.stringify(output.result)}`);
  }
  console.log("  ✓ result passthrough");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Agent Base Class Tests     ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests = [
    testAgentRunEmitsLifecycleEvents,
    testAgentRunCallsLifecycleHooksInOrder,
    testAgentTracksDurationAndModel,
    testAgentErrorEmitsErrorEventAndReturnsFailure,
    testAgentDryRunNeverCallsProvider,
    testAgentResultPassthrough,
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
