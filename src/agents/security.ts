/**
 * Security Agent — security audit specialist.
 *
 * Scans code for OWASP Top 10 vulnerabilities, injection risks, auth issues,
 * data exposure, and dependency CVEs. More specialized than the ReviewerAgent:
 * every finding is treated as a security concern first.
 */

import { Agent, type AgentInput, type AgentContext, type AgentOutput, type ReviewIssue } from "./base.js";
import { parseReviewResponse } from "./reviewer.js";
import type { ChatMessage } from "../providers/base.js";

const MAX_FILES = 30;

export class SecurityAgent extends Agent {
  readonly name = "security";
  readonly description = "Security audit: OWASP Top 10, injection, auth, data exposure, dependency CVEs";
  readonly capabilities = ["security-audit", "owasp", "vulnerability-scanning"];

  private readonly systemPrompt = `You are the Security agent in Aether CLI, a dedicated security auditor.

Analyze the provided code for:
- OWASP Top 10: injection (SQL/command/NoSQL), broken auth, sensitive data exposure, XXE, broken access control, security misconfig, XSS, insecure deserialization, vulnerable components, insufficient logging.
- Hardcoded secrets, credentials, or API keys.
- Unsafe deserialization, unsafe eval/exec, path traversal.
- Missing input validation, missing rate limiting, weak crypto.
- Outdated/deprecated packages with known CVEs (based on what you can see in config files).

For EACH issue output EXACTLY this format:
### ISSUE: {file}:{line}
Severity: error|warning|info
Category: security|bug|performance|style|typesafety|unused
Message: (clear description of the vulnerability and its impact)
Fix: (concrete remediation or code suggestion)

If the code looks secure, respond with "### NO_ISSUES"

Rules:
- Use the EXACT file path as shown.
- Line numbers must be integers.
- Prefer severity "error" for exploitable vulnerabilities, "warning" for risky patterns, "info" for hardening suggestions.
- Be specific: name the vulnerable function/variable and the attack vector.
- Do NOT include explanatory text outside the issue format.`;

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    // Determine files to scan: explicit input.files, else the scanned project.
    const project = await this.scanContext(context);
    const targets = input.files && input.files.length > 0
      ? input.files
      : project.files.slice(0, MAX_FILES);

    const fileContents = await this.readFiles(context, targets);
    if (fileContents.length === 0) {
      throw new Error("Security agent: no readable files found to audit.");
    }

    const userPrompt =
      `Project: ${project.root}\n` +
      `Language: ${project.language}\n\n` +
      this.formatFilesForPrompt(fileContents);

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.chat(context, messages, { maxTokens: 8192, temperature: 0.1 });

    const issues: ReviewIssue[] = parseReviewResponse(response.content).map((r) => ({
      file: r.file,
      line: r.line,
      severity: r.severity,
      category: r.category,
      message: r.message,
      fix: r.fix,
    }));

    return {
      success: true,
      result: { filesScanned: fileContents.length, issueCount: issues.length },
      issues,
      metadata: {
        agent: this.name,
        duration: 0,
        tokensUsed: response.usage?.totalTokens,
        modelUsed: response.model,
      },
    };
  }
}
