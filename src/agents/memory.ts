import { Agent, type AgentInput, type AgentContext, type AgentOutput } from "./base.js";
import { MemoryStore } from "../memory/store.js";
import { scanDirectory } from "../utils/scanner.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatMessage } from "../providers/base.js";

export class MemoryAgent extends Agent {
  readonly name = "memory";
  readonly description = "Project memory: remembers file purposes, architecture decisions, and task outcomes";
  readonly capabilities = ["memory", "project-context", "file-summarization"];
  private store(context: AgentContext) { return context.container.get<MemoryStore>("memoryStore"); }

  async enrichContext(context: AgentContext): Promise<AgentContext> {
    return context;
  }
  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    const mode = String(input.options?.mode ?? "index");
    const store = this.store(context);
    if (mode === "forget") { await store.clearProject(context.targetDir); return this.out(input, true, "Project memory cleared", context); }
    if (mode === "decide") {
      const question = String(input.options?.question ?? input.prompt);
      const answer = String(input.options?.answer ?? "");
      await store.addDecision(context.targetDir, question, answer);
      return this.out(input, true, { question, answer }, context);
    }
    if (mode === "recall") {
      const query = String(input.options?.query ?? input.prompt).toLowerCase();
      const files = await store.getProjectFiles(context.targetDir); const decisions = await store.getDecisions(context.targetDir);
      const matches = Object.entries(files).filter(([k,v]) => `${k} ${v}`.toLowerCase().includes(query)).map(([path, summary]) => ({ path, summary }));
      const decisionMatches = decisions.filter(d => `${d.question} ${d.answer}`.toLowerCase().includes(query));
      return this.out(input, true, { files: matches, decisions: decisionMatches }, context);
    }
    if (mode !== "index") throw new Error(`Unknown memory mode: ${mode}`);
    const project = await scanDirectory(context.targetDir);
    const source = project.files.filter(f => /\.(ts|tsx|js|jsx|py|rs|go|rb|java|kt|swift|c|cpp|h|css|scss|html|vue|svelte|sh)$/.test(f));
    const summaries: Record<string, string> = {};
    if (source.length && !context.dryRun) {
      const contents: string[] = [];
      for (const file of source) { try { contents.push(`FILE: ${file}\n${(await readFile(resolve(context.targetDir, file), "utf8")).slice(0, 4000)}`); } catch {} }
      const response = await this.chat(context, [{ role: "system", content: "Summarize each listed source file in exactly one concise line. Return one line per FILE using `path: summary`." }, { role: "user", content: contents.join("\n\n").slice(0, 100000) }], { maxTokens: Math.min(4096, source.length * 50) });
      for (const line of response.content.split("\n")) { const m = line.match(/^(.+?):\s+(.+)$/); if (m && source.includes(m[1].trim())) summaries[m[1].trim()] = m[2].trim(); }
    }
    for (const file of source) if (!summaries[file]) summaries[file] = `Source file (${file.split(".").pop() ?? "unknown"})`; 
    await store.setProjectFiles(context.targetDir, { ...(await store.getProjectFiles(context.targetDir)), ...summaries });
    return this.out(input, true, { indexed: Object.keys(summaries).length }, context);
  }
  private out(input: AgentInput, success: boolean, result: unknown, context: AgentContext): AgentOutput { return { success, result, metadata: { agent: this.name, duration: 0, modelUsed: context.model } }; }
}
