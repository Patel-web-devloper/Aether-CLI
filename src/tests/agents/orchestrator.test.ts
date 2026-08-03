/**
 * Tests for the Orchestrator — pipeline execution, dependency resolution,
 * conditional steps, template substitution, workflow events, and presets.
 *
 * Run: bun test src/tests/agents/orchestrator.test.ts
 */

import { EventBus } from "../../core/events.js";
import { ServiceContainer } from "../../core/container.js";
import { TaskScheduler } from "../../core/scheduler.js";
import {
  Agent,
  type AgentInput,
  type AgentContext,
  type AgentOutput,
} from "../../agents/base.js";
import {
  Orchestrator,
  type WorkflowDefinition,
} from "../../agents/orchestrator.js";
import { builtinWorkflows, createDefaultAgents } from "../../agents/workflows.js";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamCallbacks, ProviderFeature } from "../../providers/base.js";

// ── Mock provider (never actually called by echo/fail agents) ─────────────

class MockProvider implements LLMProvider {
  readonly name = "Mock";
  readonly slug = "mock";
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    throw new Error("provider.chat should not be called by these tests");
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

const executionLog: string[] = [];

class EchoAgent extends Agent {
  readonly description = "Echo test agent";
  readonly capabilities = ["test"];
  constructor(readonly name: string, private readonly tag: string) {
    super();
  }
  async execute(input: AgentInput, _context: AgentContext): Promise<AgentOutput> {
    executionLog.push(this.name);
    return {
      success: true,
      result: `[${this.tag}] ${input.prompt}`,
      metadata: { agent: this.name, duration: 0 },
    };
  }
}

class FailAgent extends Agent {
  readonly name = "fail";
  readonly description = "Always fails";
  readonly capabilities = ["test"];
  async execute(_input: AgentInput, _context: AgentContext): Promise<AgentOutput> {
    executionLog.push(this.name);
    throw new Error("intentional failure");
  }
}

class SlowAgent extends Agent {
  readonly name = "slow";
  readonly description = "Slow test agent (for concurrency checks)";
  readonly capabilities = ["test"];
  active = 0;
  maxActive = 0;
  async execute(_input: AgentInput, _context: AgentContext): Promise<AgentOutput> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    // Yield to the microtask queue WITHOUT a timer: under `bun test`, a timer
    // registered inside a microtask chain does not keep the test subprocess
    // alive (bun test considers the file idle and kills it). A microtask
    // yield deterministically lets a concurrently-scheduled sibling step run
    // its increment before either decrements.
    await Promise.resolve();
    this.active--;
    return { success: true, result: "slow done", metadata: { agent: this.name, duration: 0 } };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeContext(partial?: Partial<AgentContext>): AgentContext {
  return {
    provider: new MockProvider(),
    model: "mock-model",
    targetDir: process.cwd(),
    eventBus: new EventBus(),
    container: new ServiceContainer(),
    dryRun: false,
    ...partial,
  };
}

function makeOrchestrator(
  agents: Map<string, Agent>,
  bus: EventBus,
  maxConcurrent = 2,
): Orchestrator {
  const scheduler = new TaskScheduler({ maxConcurrent, defaultRetries: 0, retryDelay: 0 });
  return new Orchestrator(agents, scheduler, bus);
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testSequentialChainWithTemplateSubstitution() {
  console.log("TEST 1: sequential chain passes outputs via templates...");
  executionLog.length = 0;
  const bus = new EventBus();
  const agents = new Map<string, Agent>([
    ["a", new EchoAgent("a", "A")],
    ["b", new EchoAgent("b", "B")],
    ["c", new EchoAgent("c", "C")],
  ]);
  const orchestrator = makeOrchestrator(agents, bus);

  const workflow: WorkflowDefinition = {
    name: "chain",
    description: "chained steps",
    steps: [
      { name: "a", agent: "a", input: "start {{prompt}}", outputKey: "outA" },
      { name: "b", agent: "b", input: "next {{outA}}", dependsOn: ["a"] },
      { name: "c", agent: "c", input: "final {{b}}", dependsOn: ["b"] },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "hello");

  if (!result.success) throw new Error("workflow should succeed");
  if (result.steps.length !== 3) throw new Error("expected 3 step results");
  if (!result.steps.every((s) => s.status === "success")) {
    throw new Error(`not all steps succeeded: ${JSON.stringify(result.steps.map((s) => s.status))}`);
  }
  // b's input must contain a's output (template {{outA}})
  const bOut = result.outputs["b"]?.result as string;
  if (!bOut.includes("[A]")) throw new Error(`b did not receive a's output: ${bOut}`);
  const cOut = result.outputs["c"]?.result as string;
  if (!cOut.includes("[B]")) throw new Error(`c did not receive b's output via step name: ${cOut}`);
  console.log("  ✓ chain + output flow via outputKey and step name");
}

async function testDependencyOrdering() {
  console.log("TEST 2: dependsOn enforces execution order...");
  executionLog.length = 0;
  const bus = new EventBus();
  const agents = new Map<string, Agent>([
    ["first", new EchoAgent("first", "1")],
    ["second", new EchoAgent("second", "2")],
  ]);
  const orchestrator = makeOrchestrator(agents, bus);

  const workflow: WorkflowDefinition = {
    name: "ordered",
    description: "ordering",
    steps: [
      { name: "second", agent: "second", input: "dep {{first}}", dependsOn: ["first"] },
      { name: "first", agent: "first", input: "start" },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (!result.success) throw new Error("expected success");
  if (executionLog.join(",") !== "first,second") {
    throw new Error(`wrong order: ${executionLog.join(",")}`);
  }
  console.log("  ✓ dependency ordering enforced despite declaration order");
}

async function testIndependentStepsRunConcurrently() {
  console.log("TEST 3: independent steps run concurrently...");
  const bus = new EventBus();
  const slow = new SlowAgent();
  const agents = new Map<string, Agent>([
    ["slow1", slow],
    ["slow2", slow],
  ]);
  // NOTE: both steps share the same agent instance, so maxActive tracks overlap
  const orchestrator = makeOrchestrator(agents, bus, 2);

  const workflow: WorkflowDefinition = {
    name: "parallel",
    description: "parallel",
    steps: [
      { name: "s1", agent: "slow1", input: "one" },
      { name: "s2", agent: "slow2", input: "two" },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (!result.success) throw new Error("expected success");
  if (slow.maxActive < 2) {
    throw new Error(`steps did not overlap (maxActive=${slow.maxActive})`);
  }
  console.log("  ✓ both steps ran in the same window");
}

async function testOnSuccessStepSkippedAfterFailure() {
  console.log("TEST 4: on-success step is skipped when a dependency fails...");
  executionLog.length = 0;
  const bus = new EventBus();
  const agents = new Map<string, Agent>([
    ["fail", new FailAgent()],
    ["child", new EchoAgent("child", "C")],
  ]);
  const orchestrator = makeOrchestrator(agents, bus);

  const workflow: WorkflowDefinition = {
    name: "skip",
    description: "skip on failure",
    steps: [
      { name: "fail", agent: "fail", input: "boom" },
      { name: "child", agent: "child", input: "{{fail}}", dependsOn: ["fail"] },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (result.success) throw new Error("workflow should NOT succeed");
  if (result.steps[0].status !== "failed") throw new Error("fail step should be failed");
  if (result.steps[1].status !== "skipped") throw new Error("child should be skipped");
  if (executionLog.includes("child")) throw new Error("child agent should not have run");
  console.log("  ✓ dependent step skipped after failure");
}

async function testOnFailureStepRunsWhenDepFails() {
  console.log("TEST 5: on-failure step runs exactly when a dependency fails...");
  executionLog.length = 0;
  const bus = new EventBus();
  const agents = new Map<string, Agent>([
    ["fail", new FailAgent()],
    ["recover", new EchoAgent("recover", "R")],
  ]);
  const orchestrator = makeOrchestrator(agents, bus);

  const workflow: WorkflowDefinition = {
    name: "failure-handler",
    description: "on-failure handler",
    steps: [
      { name: "fail", agent: "fail", input: "boom" },
      { name: "recover", agent: "recover", input: "handle {{fail}}", dependsOn: ["fail"], condition: "on-failure" },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (result.steps[1].status !== "success") {
    throw new Error(`on-failure step should have run: ${result.steps[1].status}`);
  }
  const recoverOut = result.outputs["recover"]?.result as string;
  if (!recoverOut.includes("did not succeed")) {
    throw new Error(`on-failure step did not see failure context: ${recoverOut}`);
  }

  // Negative case: with a successful dep, on-failure must be skipped.
  executionLog.length = 0;
  const agents2 = new Map<string, Agent>([
    ["ok", new EchoAgent("ok", "O")],
    ["recover", new EchoAgent("recover", "R")],
  ]);
  const orchestrator2 = makeOrchestrator(agents2, bus);
  const workflow2: WorkflowDefinition = {
    name: "failure-handler2",
    description: "on-failure skipped when dep succeeds",
    steps: [
      { name: "ok", agent: "ok", input: "fine" },
      { name: "recover", agent: "recover", input: "{{ok}}", dependsOn: ["ok"], condition: "on-failure" },
    ],
  };
  const result2 = await orchestrator2.run(workflow2, makeContext({ eventBus: bus }), "x");
  if (result2.steps[1].status !== "skipped") {
    throw new Error(`on-failure step should be skipped when dep succeeds: ${result2.steps[1].status}`);
  }
  console.log("  ✓ on-failure runs on failure, skips on success");
}

async function testAlwaysStepRunsAfterFailure() {
  console.log("TEST 6: always-condition step runs even after a failure...");
  executionLog.length = 0;
  const bus = new EventBus();
  const agents = new Map<string, Agent>([
    ["fail", new FailAgent()],
    ["release", new EchoAgent("release", "REL")],
  ]);
  const orchestrator = makeOrchestrator(agents, bus);

  const workflow: WorkflowDefinition = {
    name: "always",
    description: "always runs",
    steps: [
      { name: "fail", agent: "fail", input: "boom" },
      { name: "release", agent: "release", input: "release anyway", dependsOn: ["fail"], condition: "always" },
    ],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (result.steps[1].status !== "success") {
    throw new Error(`always step should have run: ${result.steps[1].status}`);
  }
  console.log("  ✓ always step ran after failure");
}

async function testUnknownAgentFailsStep() {
  console.log("TEST 7: unknown agent marks the step failed...");
  const bus = new EventBus();
  const orchestrator = makeOrchestrator(new Map(), bus);

  const workflow: WorkflowDefinition = {
    name: "unknown",
    description: "unknown agent",
    steps: [{ name: "s1", agent: "does-not-exist", input: "x" }],
  };

  const result = await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (result.steps[0].status !== "failed") throw new Error("step should be failed");
  if (!result.steps[0].error?.includes("does-not-exist")) {
    throw new Error(`error should mention the agent: ${result.steps[0].error}`);
  }
  console.log("  ✓ unknown agent handled gracefully");
}

async function testWorkflowEventsEmitted() {
  console.log("TEST 8: workflow:start and workflow:done events are emitted...");
  const bus = new EventBus();
  const events: string[] = [];
  bus.on("workflow:start", (e) => events.push(`start:${e.workflow}`));
  bus.on("workflow:done", (e) => events.push(`done:${e.workflow}:${e.success}`));

  const agents = new Map<string, Agent>([["a", new EchoAgent("a", "A")]]);
  const orchestrator = makeOrchestrator(agents, bus);
  const workflow: WorkflowDefinition = {
    name: "events",
    description: "events",
    steps: [{ name: "a", agent: "a", input: "hi" }],
  };

  await orchestrator.run(workflow, makeContext({ eventBus: bus }), "x");
  if (events.join(",") !== "start:events,done:events:true") {
    throw new Error(`unexpected events: ${events.join(",")}`);
  }
  console.log("  ✓ workflow lifecycle events emitted");
}

async function testPromptSeededIntoTemplates() {
  console.log("TEST 9: the raw prompt is available as {{prompt}}...");
  const bus = new EventBus();
  const agents = new Map<string, Agent>([["a", new EchoAgent("a", "A")]]);
  const orchestrator = makeOrchestrator(agents, bus);
  const workflow: WorkflowDefinition = {
    name: "prompt-seed",
    description: "prompt seed",
    steps: [{ name: "a", agent: "a", input: "task: {{prompt}}" }],
  };

  const result = await orchestrator.run(
    workflow,
    makeContext({ eventBus: bus }),
    "build a todo app",
  );
  const out = result.outputs["a"]?.result as string;
  if (!out.includes("build a todo app")) {
    throw new Error(`prompt not substituted: ${out}`);
  }
  console.log("  ✓ {{prompt}} substituted");
}

async function testBuiltinWorkflowsAreValid() {
  console.log("TEST 10: all preset workflows reference registered agents...");
  const agents = createDefaultAgents();
  if (agents.size !== 10) {
    throw new Error(`expected 10 default agents, got ${agents.size}`);
  }
  const required = [
    "generator", "reviewer", "tester", "architect", "planner",
    "coder", "security", "docs", "devops", "release",
  ];
  for (const name of required) {
    if (!agents.has(name)) throw new Error(`missing default agent: ${name}`);
  }

  if (builtinWorkflows.length !== 5) {
    throw new Error(`expected 5 preset workflows, got ${builtinWorkflows.length}`);
  }
  const names = new Set(builtinWorkflows.map((w) => w.name));
  for (const expected of ["full-cycle", "quick-build", "security-audit", "docs-only", "release-prep"]) {
    if (!names.has(expected)) throw new Error(`missing preset workflow: ${expected}`);
  }

  // Every step's agent must be registered, and dependsOn must reference known steps.
  for (const wf of builtinWorkflows) {
    const stepNames = new Set(wf.steps.map((s, i) => s.name ?? `step-${i}`));
    for (const step of wf.steps) {
      if (!agents.has(step.agent)) {
        throw new Error(`workflow ${wf.name}: unknown agent ${step.agent}`);
      }
      for (const dep of step.dependsOn ?? []) {
        if (!stepNames.has(dep)) {
          throw new Error(`workflow ${wf.name}: step ${step.name} depends on unknown step ${dep}`);
        }
      }
    }
  }
  console.log("  ✓ presets valid (agents + dependencies)");
}

// ── Run all tests ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — Orchestrator Tests         ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests = [
    testSequentialChainWithTemplateSubstitution,
    testDependencyOrdering,
    testIndependentStepsRunConcurrently,
    testOnSuccessStepSkippedAfterFailure,
    testOnFailureStepRunsWhenDepFails,
    testAlwaysStepRunsAfterFailure,
    testUnknownAgentFailsStep,
    testWorkflowEventsEmitted,
    testPromptSeededIntoTemplates,
    testBuiltinWorkflowsAreValid,
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
