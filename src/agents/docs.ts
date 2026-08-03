/**
 * Docs Agent — documentation generation.
 *
 * Reads code and produces README sections, API docs, JSDoc/TSDoc comments,
 * architecture docs, and changelogs. Outputs markdown, optionally as files.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput, type GeneratedFile } from "./base.js";
import { parseResponse } from "./generator.js";
import type { ChatMessage } from "../providers/base.js";

const MAX_FILES = 20;

export class DocsAgent extends Agent {
  readonly name = "docs";
  readonly description = "Documentation generation: READMEs, API docs, JSDoc/TSDoc, architecture docs";
  readonly capabilities = ["documentation", "markdown", "api-docs"];

  private readonly systemPrompt = `You are the Docs agent in Aether CLI, a technical documentation writer.

Write clear, accurate documentation:
- README sections (overview, install, usage, API reference, examples).
- API docs describing exported functions/classes with signatures and parameter/return docs.
- JSDoc/TSDoc comments for non-trivial functions.
- Architecture docs explaining how components fit together.
- Changelog entries in Keep-a-Changelog style.

Style rules:
- Match the project's existing tone and level of detail.
- Document behavior and edge cases, not just signatures.
- Do NOT invent APIs that don't exist in the code.
- Prefer concise markdown with code examples where helpful.

Output format — for each doc file output:
### FILE: path/to/doc.md
\`\`\`markdown
<content>
\`\`\`

You may output MULTIPLE files. If a single response is more appropriate, plain markdown
(no file markers) is acceptable — it will be returned as the agent result.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const project = await this.scanContext(context);
    const targets = input.files && input.files.length > 0
      ? input.files
      : project.files.slice(0, MAX_FILES);
    const fileContents = await this.readFiles(context, targets);

    const userPrompt =
      `Project: ${project.root}\n` +
      `Language: ${project.language}\n\n` +
      (fileContents.length > 0
        ? `Source files:\n${this.formatFilesForPrompt(fileContents)}\n\n`
        : "(no source files read)\n\n") +
      `Documentation request:\n${input.prompt}`;

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.chat(context, messages, { maxTokens: 8192, temperature: 0.3 });

    const parsed = parseResponse(response.content, context.targetDir, "create");
    const files: GeneratedFile[] = parsed.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language,
      action: "create",
    }));

    return {
      success: true,
      result: files.length > 0 ? { fileCount: files.length } : response.content,
      files: files.length > 0 ? files : undefined,
      metadata: {
        agent: this.name,
        duration: 0,
        tokensUsed: response.usage?.totalTokens,
        modelUsed: response.model,
      },
    };
  }
}
