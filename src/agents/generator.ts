/**
 * Generation Agent — the "brain" of `aether generate`.
 *
 * Takes a natural language prompt, scans the target project for context,
 * builds a rich system prompt, calls the LLM, and parses the response
 * into discrete files to write.
 */

import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { scanDirectory, type ProjectContext } from "../utils/scanner.js";
import { resolve, relative } from "node:path";
import type { ContextManager, ContextPayload } from "../context/manager.js";
import {
  Agent,
  type AgentInput,
  type AgentContext,
  type AgentOutput,
  type GeneratedFile,
} from "./base.js";

// ── public types ─────────────────────────────────────────────────────────

export type GeneratorMode = "create" | "edit" | "auto";

export interface GeneratorOutput {
  /** Relative file path. */
  path: string;
  /** Generated code content. */
  content: string;
  /** The language tag extracted from the code fence (e.g. "typescript"). */
  language: string;
  /** Intended action — derived from mode + whether the file existed. */
  action: "create" | "edit";
}

export interface GeneratorOptions {
  /** LLM provider instance (already initialised). */
  provider: LLMProvider;
  /** Model name to use. */
  model?: string;
  /** Generation mode. */
  mode: GeneratorMode;
  /** Directory to generate files into. */
  targetDir: string;
  /** Maximum tokens for the LLM response. */
  maxTokens?: number;
  /** Optional context manager for enhanced context building. */
  contextManager?: ContextManager;
}

export interface GeneratorResult {
  /** Parsed files ready to write. */
  files: GeneratorOutput[];
  /** Raw LLM response (for debugging). */
  raw: string;
  /** Project context that was injected into the prompt. */
  context: ProjectContext;
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Generate code files from a natural-language prompt.
 *
 * 1. Scans the target directory for project context.
 * 2. Builds a system prompt describing the project.
 * 3. Calls the LLM provider.
 * 4. Parses the response to extract file markers + code blocks.
 */
export async function generateFromPrompt(
  prompt: string,
  options: GeneratorOptions,
): Promise<GeneratorResult> {
  // ── 1. Scan project / build context ────────────────────────────────────
  let context: ProjectContext;
  let contextPayload: ContextPayload | null = null;

  try {
    context = await scanDirectory(options.targetDir);
  } catch {
    // If the directory doesn't exist yet or is empty, create a minimal context
    context = {
      root: options.targetDir,
      fileTree: "(empty or new project)",
      language: "Unknown",
      framework: "None detected",
      configFiles: {},
      files: [],
    };
  }

  // ── 1b. Use context manager if available for richer context ──────────
  if (options.contextManager) {
    try {
      contextPayload = await options.contextManager.buildContextPayload(prompt, options.targetDir);
    } catch {
      // Fall back to basic scanning
    }
  }

  // ── 2. Build system prompt ───────────────────────────────────────────
  let systemPrompt: string;
  if (contextPayload) {
    systemPrompt = buildSystemPromptFromPayload(contextPayload, options.mode);
  } else {
    systemPrompt = buildSystemPrompt(context, options.mode);
  }

  // ── 3. Call provider ─────────────────────────────────────────────────
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  let response;
  try {
    response = await options.provider.chat(messages, {
      model: options.model,
      maxTokens: options.maxTokens ?? 8192,
      temperature: 0.3,
    });
  } catch (err) {
    throw new Error(
      `Provider call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawContent = response.content;

  if (!rawContent || rawContent.trim().length === 0) {
    throw new Error("Provider returned an empty response.");
  }

  // ── 4. Parse response ────────────────────────────────────────────────
  const files = parseResponse(rawContent, options.targetDir, options.mode);
  if (files.length === 0) {
    throw new Error(
      "Could not parse any files from the response. " +
        "The model should use `### FILE: path/to/file` followed by a code block.",
    );
  }

  return { files, raw: rawContent, context };
}

// ── system prompt builder ────────────────────────────────────────────────

function buildSystemPrompt(context: ProjectContext, mode: GeneratorMode): string {
  const modeInstructions: Record<GeneratorMode, string> = {
    create: "ONLY create new files. Do not modify existing files.",
    edit: "ONLY modify existing files shown in the project tree. Do not create new files.",
    auto: "Create new files OR modify existing files as needed to best satisfy the request.",
  };

  return `You are Aether, an AI coding agent. Generate code based on the user's request.

Project context:
${context.fileTree}

Primary language: ${context.language}
Framework: ${context.framework}

Configuration files detected:
${formatConfigFiles(context.configFiles)}

Mode: ${mode} — ${modeInstructions[mode]}

Output format instructions:
- Output each file as: ### FILE: path/to/file.ext
- Immediately followed by a code fence with the language tag: \`\`\`language
- You may output MULTIPLE files in a single response
- Keep code concise, well-commented, and production-ready
- Use the project's existing patterns and conventions
- Include all necessary imports and dependencies
- Do NOT wrap the response in explanatory text — output ONLY the file markers and code blocks
- File paths should be relative to the project root

Example output:
### FILE: src/utils/math.ts
\`\`\`typescript
/**
 * Returns the sum of all numbers in an array.
 */
export function sum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}
\`\`\`

### FILE: src/utils/math.test.ts
\`\`\`typescript
import { sum } from "./math";

test("sum adds numbers", () => {
  expect(sum([1, 2, 3])).toBe(6);
});
\`\`\`

Now, respond to the user's request:`.trim();
}

/**
 * Build a richer system prompt using the context payload from ContextManager.
 */
function buildSystemPromptFromPayload(payload: ContextPayload, mode: GeneratorMode): string {
  const modeInstructions: Record<GeneratorMode, string> = {
    create: "ONLY create new files. Do not modify existing files.",
    edit: "ONLY modify existing files shown in the context. Do not create new files.",
    auto: "Create new files OR modify existing files as needed to best satisfy the request.",
  };

  const sections: string[] = [];
  sections.push("You are Aether, an AI coding agent. Generate code based on the user's request.");
  sections.push("");
  sections.push(`Mode: ${mode} — ${modeInstructions[mode]}`);
  sections.push(`Token budget: ${payload.tokenBudget.used}/${payload.tokenBudget.max} tokens`);
  sections.push("");

  // Inject configuration summary
  if (payload.configSummary && payload.configSummary !== "  (no config files detected)") {
    sections.push("Configuration files:");
    sections.push(payload.configSummary);
    sections.push("");
  }

  // Inject relevant chunks
  if (payload.chunks.length > 0) {
    sections.push("Relevant project files:");
    for (const chunk of payload.chunks) {
      sections.push(`─── ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ───`);
      sections.push(chunk.content);
      sections.push("");
    }
  }

  sections.push("Output format instructions:");
  sections.push("- Output each file as: ### FILE: path/to/file.ext");
  sections.push("- Immediately followed by a code fence with the language tag");
  sections.push("- You may output MULTIPLE files in a single response");
  sections.push("- Keep code concise, well-commented, and production-ready");
  sections.push("- Use the project's existing patterns and conventions");
  sections.push("- Include all necessary imports and dependencies");
  sections.push("- Do NOT wrap the response in explanatory text — output ONLY the file markers and code blocks");
  sections.push("");

  sections.push("Now, respond to the user's request:");

  return sections.join("\n");
}

function formatConfigFiles(cfgs: Record<string, unknown>): string {
  const keys = Object.keys(cfgs);
  if (keys.length === 0) return "  (none)";

  const lines: string[] = [];
  for (const key of keys) {
    const val = cfgs[key];
    if (typeof val === "object" && val !== null) {
      // For package.json, extract name, version, type
      const pkg = val as Record<string, unknown>;
      const info: string[] = [];
      if (pkg.name) info.push(`name: ${pkg.name}`);
      if (pkg.version) info.push(`version: ${pkg.version}`);
      if (pkg.type) info.push(`type: ${pkg.type}`);
      lines.push(`  ${key}: ${info.join(", ") || "(present)"}`);
    } else {
      const s = String(val);
      lines.push(`  ${key}: ${s.length > 120 ? s.slice(0, 120) + "..." : s}`);
    }
  }
  return lines.join("\n");
}

// ── response parser ──────────────────────────────────────────────────────

/**
 * Parse the LLM response looking for `### FILE: path` markers followed by
 * fenced code blocks. Exported so other code-producing agents (coder, docs,
 * devops) can reuse the same parsing logic.
 */
export function parseResponse(
  raw: string,
  targetDir: string,
  mode: GeneratorMode,
): GeneratorOutput[] {
  const files: GeneratorOutput[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");

  // Match: ### FILE: path/to/file.ext (with optional whitespace)
  // followed by a fenced code block: ```lang\n...\n```
  const filePattern = /###\s+FILE:\s*(\S+)\s*\n\s*```(\w*)\s*\n([\s\S]*?)```/g;

  let match;
  while ((match = filePattern.exec(normalized)) !== null) {
    const rawPath = match[1].trim();
    const language = match[2] || "text";
    const content = match[3];

    // Normalise path — strip leading ./ and resolve relative
    let cleanPath = rawPath.replace(/^\.\//, "");
    // Reject absolute paths and path traversal
    if (cleanPath.startsWith("/") || cleanPath.includes("..")) {
      continue;
    }

    // Determine action based on mode
    const resolved = resolve(targetDir, cleanPath);
    let action: "create" | "edit" = "create";
    if (mode === "edit") action = "edit";
    // For "auto", the writer will check existence and decide — but here we
    // default to "create" and the writer handles conflicts.

    files.push({
      path: cleanPath,
      content: content,
      language,
      action,
    });
  }

  // Fallback: if no ### FILE: markers found, try to find bare code fences
  if (files.length === 0) {
    const bareFence = /```(\w*)\s*\n([\s\S]*?)```/g;
    let bareMatch;
    let idx = 0;
    while ((bareMatch = bareFence.exec(normalized)) !== null) {
      const lang = bareMatch[1] || "text";
      const content = bareMatch[2];
      // Guess a filename from the language
      const ext = langToExt(lang);
      files.push({
        path: `generated${idx > 0 ? `-${idx}` : ""}.${ext}`,
        content,
        language: lang,
        action: "create",
      });
      idx++;
    }
  }

  return files;
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts",
    ts: "ts",
    tsx: "tsx",
    javascript: "js",
    js: "js",
    jsx: "jsx",
    python: "py",
    py: "py",
    rust: "rs",
    go: "go",
    ruby: "rb",
    java: "java",
    kotlin: "kt",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    css: "css",
    html: "html",
    json: "json",
    yaml: "yaml",
    markdown: "md",
    shell: "sh",
    bash: "sh",
    sql: "sql",
    graphql: "graphql",
    toml: "toml",
    text: "txt",
  };
  return map[lang.toLowerCase()] ?? "txt";
}

// ── GeneratorAgent (agent-class wrapper) ──────────────────────────────────

/**
 * Agent-class wrapper around `generateFromPrompt`, used by the workflow
 * orchestrator. The standalone `generateFromPrompt` function is preserved
 * for the `aether generate` command and backward compatibility.
 */
export class GeneratorAgent extends Agent {
  readonly name = "generator";
  readonly description = "Generate code files from a natural-language prompt";
  readonly capabilities = ["code-generation"];

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const mode = (input.options?.mode as GeneratorMode | undefined) ?? "auto";
    const result = await generateFromPrompt(input.prompt, {
      provider: context.provider,
      model: context.model,
      mode,
      targetDir: context.targetDir,
      maxTokens: input.options?.maxTokens as number | undefined,
    });

    const files: GeneratedFile[] = result.files.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language,
      action: f.action,
    }));

    return {
      success: true,
      result: { fileCount: files.length },
      files,
      metadata: { agent: this.name, duration: 0, modelUsed: context.model },
    };
  }
}
