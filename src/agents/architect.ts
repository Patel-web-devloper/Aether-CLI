/**
 * Architect Agent — high-level system design.
 *
 * Analyzes requirements, proposes architecture patterns, produces
 * text-based component diagrams, and evaluates tradeoffs. Focused purely
 * on design decisions — no code generation.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput } from "./base.js";
import type { ChatMessage } from "../providers/base.js";

export class ArchitectAgent extends Agent {
  readonly name = "architect";
  readonly description = "High-level system design: architecture patterns, component diagrams, tradeoffs";
  readonly capabilities = ["architecture", "system-design", "tradeoff-analysis"];

  private readonly systemPrompt = `You are the Architect agent in Aether CLI. You design high-level system architecture.

Your job:
- Analyze requirements and constraints (performance, scale, platform, team, cost).
- Propose 1-2 architecture patterns (layered, hexagonal, event-driven, microservices, etc.) with a clear recommendation.
- Produce a text-based component/sequence diagram using ASCII art (no image tools).
- Evaluate tradeoffs explicitly: pros/cons, complexity cost, when the recommendation breaks down.
- Identify key interfaces and data flows between components.
- Flag risks and unknowns that need decisions before implementation.

Output format (markdown):
# Architecture: <name>
## Requirements Analysis
## Proposed Architecture (with ASCII component diagram)
## Tradeoffs
## Key Interfaces & Data Flow
## Risks & Open Questions

Be concise but specific. Prefer boring, maintainable technology. Do NOT write code.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: input.prompt },
    ];
    const response = await this.chat(context, messages, { maxTokens: 4096, temperature: 0.3 });

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
