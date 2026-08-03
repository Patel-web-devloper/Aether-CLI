/**
 * Planner Agent — task decomposition.
 *
 * Breaks features into implementable tasks with estimates, dependencies,
 * and acceptance criteria. Pure planning — NO code generation.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput } from "./base.js";
import type { ChatMessage } from "../providers/base.js";

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  estimate: string;
  dependencies: string[];
  acceptanceCriteria: string[];
}

export class PlannerAgent extends Agent {
  readonly name = "planner";
  readonly description = "Task decomposition: breaks features into implementable tasks with estimates and acceptance criteria";
  readonly capabilities = ["task-planning", "decomposition", "estimation"];

  private readonly systemPrompt = `You are the Planner agent in Aether CLI. You decompose feature requests into implementable tasks.

Rules:
- Break the work into small, independently implementable tasks (each should be doable in one sitting).
- Order tasks by dependency (prerequisite tasks first).
- Assign time estimates in hours.
- Write concrete acceptance criteria that can be verified (no vague "works correctly").
- Identify risks and unknowns that could change the plan.

Output EXACTLY this format — one block per task:

### TASK: <id> — <short title>
Estimate: <N>h
Depends on: <task-id, task-id, or none>
Description: <2-4 sentences on what to implement and how>
Acceptance criteria:
- <verifiable criterion>
- <verifiable criterion>

After the task blocks, add a short "## Plan Summary" section with total estimate and suggested implementation order.

Do NOT write any code. Do NOT add anything outside the format above.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: input.prompt },
    ];
    const response = await this.chat(context, messages, { maxTokens: 4096, temperature: 0.2 });

    return {
      success: true,
      result: response.content,
      metadata: {
        agent: this.name,
        duration: 0,
        tokensUsed: response.usage?.totalTokens,
        modelUsed: response.model,
      },
    };
  }
}
