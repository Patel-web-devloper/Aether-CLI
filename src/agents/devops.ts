/**
 * DevOps Agent — CI/CD and deployment configuration.
 *
 * Generates GitHub Actions workflows, Dockerfiles, docker-compose files,
 * deployment scripts, and environment configs.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput, type GeneratedFile } from "./base.js";
import { parseResponse } from "./generator.js";
import type { ChatMessage } from "../providers/base.js";

export class DevOpsAgent extends Agent {
  readonly name = "devops";
  readonly description = "CI/CD and deployment: GitHub Actions, Dockerfiles, docker-compose, deploy scripts";
  readonly capabilities = ["devops", "ci-cd", "docker", "deployment"];

  private readonly systemPrompt = `You are the DevOps agent in Aether CLI. You generate CI/CD and deployment configuration.

What you produce:
- GitHub Actions workflows (.github/workflows/*.yml): test, build, lint, publish, deploy.
- Dockerfiles (multi-stage where it helps; small images; non-root where possible).
- docker-compose files for local dev (services, volumes, healthchecks).
- Deployment scripts (shell) and environment templates (.env.example).
- Package manager / runtime config (bun, node, python, etc.) as needed.

Rules:
- Match the project's language and package manager (detect from the project context).
- Pin major/minor versions of actions and images; avoid "latest" where flaky.
- Include caching for dependencies and build artifacts.
- Never put real secrets in files — use secrets/env vars only.
- Keep configs minimal and readable; comment non-obvious choices.

Output format — for each file output:
### FILE: path/to/file
\`\`\`language
<content>
\`\`\`

You may output MULTIPLE files. Do NOT wrap the response in explanatory text — output ONLY the file markers and code blocks.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const project = await this.scanContext(context);
    const userPrompt =
      `Project: ${project.root}\n` +
      `Language: ${project.language}\n` +
      `Framework: ${project.framework}\n` +
      `Config files detected:\n${formatConfigNames(Object.keys(project.configFiles))}\n\n` +
      `DevOps request:\n${input.prompt}`;

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

function formatConfigNames(names: string[]): string {
  if (names.length === 0) return "  (none)";
  return names.map((n) => `  - ${n}`).join("\n");
}
