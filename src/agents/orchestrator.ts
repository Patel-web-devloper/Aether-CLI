/**
 * Orchestrator — runs multi-agent workflows.
 *
 * Chains specialized agents into named workflows (see workflows.ts):
 * 1. Creates a TaskScheduler task per workflow step, wired to the
 *    scheduler's dependency graph via `dependsOn`.
 * 2. Runs steps concurrently where dependencies allow (scheduler's
 *    maxConcurrent governs the ceiling).
 * 3. Passes outputs from earlier steps to later steps via `{{outputKey}}`
 *    / `{{stepName}}` template substitution.
 * 4. Evaluates step conditions (on-success / on-failure / always) using the
 *    actual outcomes of dependencies.
 * 5. Emits workflow-level events (workflow:start, workflow:step-start,
 *    workflow:step-done, workflow:done).
 *
 * Step tasks never throw at the scheduler level — failures and skips are
 * encoded in the task result so the scheduler's dependency resolution can
 * order steps without deadlocking on failed dependencies.
 */

import type { Agent, AgentInput, AgentContext, AgentOutput } from "./base.js";
import type { TaskScheduler } from "../core/scheduler.js";
import type { EventBus } from "../core/events.js";

// ── types ─────────────────────────────────────────────────────────────────

export type StepCondition = "on-success" | "on-failure" | "always";

export interface WorkflowStep {
  /** Optional step name — defaults to `step-<index>`. Referenced by dependsOn. */
  name?: string;
  /** Agent name to invoke (must be registered in the agents map). */
  agent: string;
  /** Prompt or template. `{{key}}` placeholders are replaced with prior step outputs. */
  input: string;
  /** Step names this step depends on. */
  dependsOn?: string[];
  /** Run condition: on-success (default) | on-failure | always. */
  condition?: StepCondition;
  /** Save this step's output under an extra key for template references. */
  outputKey?: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface WorkflowStepResult {
  step: string;
  agent: string;
  status: "success" | "failed" | "skipped";
  output?: AgentOutput;
  error?: string;
  duration: number;
}

export interface WorkflowResult {
  name: string;
  success: boolean;
  startedAt: number;
  completedAt: number;
  duration: number;
  steps: WorkflowStepResult[];
  /** All step outputs, keyed by step name and outputKey (includes failures). */
  outputs: Record<string, AgentOutput>;
}

interface StepTaskResult {
  status: "success" | "failed" | "skipped";
  output?: AgentOutput;
  error?: string;
}

// ── orchestrator ──────────────────────────────────────────────────────────

export class Orchestrator {
  constructor(
    private readonly agents: Map<string, Agent>,
    private readonly scheduler: TaskScheduler,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Run a named workflow.
   * @param prompt Optional raw prompt — seeded as `{{prompt}}` for templates.
   */
  async run(
    workflow: WorkflowDefinition,
    context: AgentContext,
    prompt?: string,
  ): Promise<WorkflowResult> {
    const startedAt = Date.now();
    const outputs: Record<string, AgentOutput> = {};
    if (prompt !== undefined) {
      outputs.prompt = {
        success: true,
        result: prompt,
        metadata: { agent: "workflow", duration: 0 },
      };
    }

    const stepNames: string[] = workflow.steps.map((s, i) => s.name ?? `step-${i}`);
    this.eventBus.emit({
      type: "workflow:start",
      workflow: workflow.name,
      steps: stepNames,
      timestamp: startedAt,
    });

    this.scheduler.reset();

    // Pass 1 — enqueue a task per step (dependencies patched in pass 2).
    const taskIds = new Map<string, string>(); // step name → task id
    workflow.steps.forEach((step, index) => {
      const stepName = step.name ?? `step-${index}`;
      const taskId = this.scheduler.enqueue<StepTaskResult>({
        type: `workflow:${workflow.name}:${stepName}`,
        priority: index + 1,
        dependencies: [],
        maxRetries: 0,
        execute: () => this.runStep(workflow, step, stepName, context, outputs),
      });
      taskIds.set(stepName, taskId);
    });

    // Pass 2 — wire dependencies into the scheduler's dependency graph.
    workflow.steps.forEach((step, index) => {
      const stepName = step.name ?? `step-${index}`;
      const task = this.scheduler.getTask(taskIds.get(stepName)!);
      task!.dependencies = (step.dependsOn ?? [])
        .map((d) => taskIds.get(d))
        .filter((id): id is string => Boolean(id));
    });

    const schedulerResults = await this.scheduler.runAll();

    // Assemble results in declared workflow order.
    const results: WorkflowStepResult[] = workflow.steps.map((step, index) => {
      const stepName = stepNames[index];
      const taskId = taskIds.get(stepName)!;
      const sched = schedulerResults.get(taskId);
      const task = this.scheduler.getTask(taskId);

      let stepResult: StepTaskResult;
      if (sched?.success && task?.result) {
        stepResult = task.result as StepTaskResult;
      } else {
        stepResult = {
          status: "failed",
          error: sched?.error?.message ?? "Step task failed without a result.",
        };
      }

      return {
        step: stepName,
        agent: step.agent,
        status: stepResult.status,
        output: stepResult.output,
        error: stepResult.error,
        duration: task ? (task.completedAt ?? startedAt) - (task.startedAt ?? startedAt) : 0,
      };
    });

    const completedAt = Date.now();
    const workflowResult: WorkflowResult = {
      name: workflow.name,
      success: results.every((r) => r.status !== "failed"),
      startedAt,
      completedAt,
      duration: completedAt - startedAt,
      steps: results,
      outputs,
    };

    this.eventBus.emit({
      type: "workflow:done",
      workflow: workflow.name,
      success: workflowResult.success,
      duration: workflowResult.duration,
    });

    return workflowResult;
  }

  /** Execute a single workflow step (never throws). */
  private async runStep(
    workflow: WorkflowDefinition,
    step: WorkflowStep,
    stepName: string,
    context: AgentContext,
    outputs: Record<string, AgentOutput>,
  ): Promise<StepTaskResult> {
    const startedAt = Date.now();
    const depNames = step.dependsOn ?? [];
    const depOutputs = depNames.map((d) => outputs[d]).filter((o): o is AgentOutput => Boolean(o));

    // ── Condition evaluation ────────────────────────────────────────────
    const condition: StepCondition = step.condition ?? "on-success";
    const anyDepNotSuccess = depOutputs.some((o) => !o.success);
    let skippedReason: string | null = null;

    if (condition === "on-success" && anyDepNotSuccess) {
      skippedReason = `Skipped: dependency ${depNames.find((d) => outputs[d] && !outputs[d].success)} did not succeed.`;
    } else if (condition === "on-failure" && !anyDepNotSuccess) {
      skippedReason = "Skipped: no failing dependency (on-failure condition not met).";
    }

    if (skippedReason) {
      const skipOutput: AgentOutput = {
        success: false,
        result: { skipped: true, reason: skippedReason },
        error: skippedReason,
        metadata: { agent: step.agent, duration: 0 },
      };
      outputs[stepName] = skipOutput;
      this.eventBus.emit({
        type: "workflow:step-done",
        workflow: workflow.name,
        step: stepName,
        agent: step.agent,
        status: "skipped",
        duration: 0,
      });
      return { status: "skipped", output: skipOutput, error: skippedReason };
    }

    const agent = this.agents.get(step.agent);
    if (!agent) {
      const error = `Unknown agent "${step.agent}". Registered: ${[...this.agents.keys()].join(", ")}`;
      const failOutput: AgentOutput = {
        success: false,
        error,
        metadata: { agent: step.agent, duration: 0 },
      };
      outputs[stepName] = failOutput;
      this.eventBus.emit({
        type: "workflow:step-done",
        workflow: workflow.name,
        step: stepName,
        agent: step.agent,
        status: "failed",
        duration: 0,
      });
      return { status: "failed", output: failOutput, error };
    }

    // ── Run the agent ───────────────────────────────────────────────────
    const renderedInput = renderTemplate(step.input, outputs);
    this.eventBus.emit({
      type: "workflow:step-start",
      workflow: workflow.name,
      step: stepName,
      agent: step.agent,
      timestamp: startedAt,
    });

    const input: AgentInput = {
      prompt: renderedInput,
      options: { workflow: workflow.name, step: stepName },
    };

    let output: AgentOutput;
    try {
      output = await agent.run(input, context);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed: StepTaskResult = { status: "failed", error };
      this.eventBus.emit({
        type: "workflow:step-done",
        workflow: workflow.name,
        step: stepName,
        agent: step.agent,
        status: "failed",
        duration: Date.now() - startedAt,
      });
      return failed;
    }

    const status = output.success ? "success" : "failed";
    outputs[stepName] = output;
    if (step.outputKey) outputs[step.outputKey] = output;

    this.eventBus.emit({
      type: "workflow:step-done",
      workflow: workflow.name,
      step: stepName,
      agent: step.agent,
      status,
      duration: Date.now() - startedAt,
    });

    return { status, output, error: output.error };
  }
}

// ── template rendering ────────────────────────────────────────────────────

/**
 * Replace `{{key}}` placeholders with the formatted output of the step
 * whose name or outputKey equals `key`. Unknown keys are left untouched.
 */
export function renderTemplate(template: string, outputs: Record<string, AgentOutput>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    const out = outputs[key];
    if (!out) return match;
    return formatOutputForPrompt(out);
  });
}

function formatOutputForPrompt(out: AgentOutput): string {
  if (!out.success) {
    return out.error ? `(step did not succeed: ${out.error})` : "(step did not succeed)";
  }
  if (typeof out.result === "string" && out.result.trim().length > 0) {
    return out.result;
  }
  if (out.files && out.files.length > 0) {
    return `Generated files:\n${out.files.map((f) => `- ${f.path}`).join("\n")}`;
  }
  if (out.issues && out.issues.length > 0) {
    return (
      `Issues found (${out.issues.length}):\n` +
      out.issues
        .map((i) => `- ${i.file}:${i.line} [${i.severity}] ${i.message}`)
        .join("\n")
    );
  }
  if (out.result !== undefined) {
    try {
      return JSON.stringify(out.result, null, 2);
    } catch {
      return String(out.result);
    }
  }
  return "(no output)";
}
