/**
 * Coder Agent — implementation specialist.
 *
 * Like GeneratorAgent but with a focused implementation system prompt:
 * follows existing patterns, handles edge cases, and adds error handling.
 * Produces files in the standard `### FILE:` format (shared parser).
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput, type GeneratedFile } from "./base.js";
import { parseResponse } from "./generator.js";
import type { ChatMessage } from "../providers/base.js";

export class CoderAgent extends Agent {
  readonly name = "coder";
  readonly description = "Implementation agent: writes production-ready code following existing patterns";
  readonly capabilities = ["code-generation", "implementation"];

  private readonly systemPrompt = `You are the Coder agent in Aether CLI, an implementation specialist.

You write production-ready code:
- Follow the project's existing patterns, style, and conventions.
- Handle edge cases: null/undefined inputs, empty collections, boundary values.
- Add error handling: validate inputs, fail loudly with clear messages, never swallow errors silently.
- Keep functions small and focused; name things clearly.
- Include necessary imports and type annotations.
- Do NOT refactor unrelated code. Do NOT add speculative abstractions.

Output format — output each file as:
### FILE: path/to/file.ext
\`\`\`language
<code>
\`\`\`

You may output MULTIPLE files. Do NOT wrap the response in explanatory text — output ONLY the file markers and code blocks.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    // Inject lightweight project context so the coder matches existing patterns.
    let projectContext = "";
    try {
      const ctx = await this.scanContext(context);
      projectContext = `Project tree:\n${ctx.fileTree}\nPrimary language: ${ctx.language}\nFramework: ${ctx.framework}`;
    } catch {
      projectContext = "(unable to scan project)";
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: `${projectContext}\n\nImplementation request:\n${input.prompt}` },
    ];
    const response = await this.chat(context, messages, { maxTokens: 8192, temperature: 0.3 });

    const parsed = parseResponse(response.content, context.targetDir, "auto");
    const files: GeneratedFile[] = parsed.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language,
      action: f.action,
    }));

    if (files.length === 0) {
      return {
        success: true,
        result: { note: "No ### FILE: markers found in the response.", raw: response.content },
        metadata: {
          agent: this.name,
          duration: 0,
          tokensUsed: response.usage?.totalTokens,
          modelUsed: response.model,
        },
      };
    }

    return {
      success: true,
      result: { fileCount: files.length },
      files,
      metadata: {
        agent: this.name,
        duration: 0,
        tokensUsed: response.usage?.totalTokens,
        modelUsed: response.model,
      },
    };
  }
}
