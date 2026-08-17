/**
 * Generation Agent — the "brain" of `aether generate`.
 *
 * Takes a natural language prompt, scans the target project for context,
 * builds a rich system prompt, calls the LLM, and parses the response
 * into discrete files to write.
 */

import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { scanDirectory, type ProjectContext } from "../utils/scanner.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { MemoryStore } from "../memory/store.js";
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

// ── diff patch types (edit mode) ──────────────────────────────────────────

/**
 * A single contiguous edit region inside a file. Line numbers are 1-based and
 * refer to the ORIGINAL file (before any hunks of this patch are applied).
 * `removed` holds the original lines being replaced (without the `-` prefix);
 * `added` holds the replacement lines (without the `+` prefix). When `removed`
 * is empty the hunk is a pure insertion before `startLine`.
 */
export interface PatchHunk {
  /** First changed line in the original file (1-based, inclusive). */
  startLine: number;
  /** Last changed line in the original file (1-based, inclusive). */
  endLine: number;
  /** Original lines removed by this hunk. */
  removed: string[];
  /** Replacement lines added by this hunk. */
  added: string[];
}

/** A parsed `### EDIT:` block: one file + one or more hunks. */
export interface FilePatch {
  /** Relative file path. */
  path: string;
  /** Hunks to apply, in order. Line numbers refer to the original file. */
  hunks: PatchHunk[];
}

/** Result of impact analysis after an edit. */
export interface ImpactAnalysis {
  /** Files the patch(es) modified. */
  changedFiles: string[];
  /** Other files (from memory summaries) that likely depend on the change. */
  affectedFiles: string[];
  /** Human-readable explanation of why the affected files were flagged. */
  rationale: string;
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
  /** Existing files (read from disk) that memory search matched — injected into the prompt as files to modify. */
  memoryFiles?: Array<{ path: string; content: string }>;
  /** Past decisions relevant to the prompt — injected into the prompt as extra context. */
  memoryDecisions?: Array<{ question: string; answer: string }>;
  /** MemoryStore used for impact analysis after applying edits. */
  memoryStore?: MemoryStore;
}

/** Memory matches found by GeneratorAgent before generation. */
export interface MemoryMatches {
  files: Array<{ path: string; content: string }>;
  decisions: Array<{ question: string; answer: string }>;
}

export interface GeneratorResult {
  /** Parsed files ready to write. */
  files: GeneratorOutput[];
  /** Raw LLM response (for debugging). */
  raw: string;
  /** Project context that was injected into the prompt. */
  context: ProjectContext;
  /** Diff patches parsed from the response (edit mode with `### EDIT:` hunks). */
  patches?: FilePatch[];
  /** Impact analysis — other files likely affected by the edits. */
  impact?: ImpactAnalysis;
  /** Non-fatal warnings (e.g. a patch that could not be applied). */
  warnings?: string[];
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

  // ── 2b. Inject memory-aware edit context (matched files + decisions) ──
  if (
    (options.memoryFiles && options.memoryFiles.length > 0) ||
    (options.memoryDecisions && options.memoryDecisions.length > 0)
  ) {
    systemPrompt = appendMemoryContext(systemPrompt, options.memoryFiles ?? [], options.memoryDecisions ?? []);
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
  const warnings: string[] = [];
  let files: GeneratorOutput[] = [];
  let patches: FilePatch[] | undefined;
  let impact: ImpactAnalysis | undefined;

  if (options.mode === "edit") {
    // Edit mode prefers diff patches: `### EDIT:` + `@@ line N-M @@` hunks.
    patches = parseEdits(rawContent);
    if (patches.length > 0) {
      const applied = await applyEdits(patches, options.targetDir);
      warnings.push(...applied.warnings);
      if (applied.files.length > 0) {
        files = applied.files;
        impact = await analyzeImpact(patches, options.targetDir, options.memoryStore);
      } else {
        // All hunks failed to apply — fall back to full-content parsing.
        patches = undefined;
        files = parseResponse(rawContent, options.targetDir, options.mode);
      }
    } else {
      // No `@@` hunks — the model emitted full files (legacy `### EDIT:` / `### FILE:`).
      files = parseResponse(rawContent, options.targetDir, options.mode);
    }
  } else {
    files = parseResponse(rawContent, options.targetDir, options.mode);
  }

  if (files.length === 0) {
    throw new Error(
      "Could not parse any files from the response. " +
        "The model should use `### FILE: path/to/file` followed by a code block (create mode) " +
        "or `### EDIT: path/to/file` with `@@ line N-M @@` diff hunks (edit mode).",
    );
  }

  return { files, raw: rawContent, context, patches, impact, warnings };
}

// ── system prompt builder ────────────────────────────────────────────────

function buildSystemPrompt(context: ProjectContext, mode: GeneratorMode): string {
  const modeInstructions: Record<GeneratorMode, string> = {
    create: "ONLY create new files. Do not modify existing files.",
    edit: "ONLY modify existing files shown in the project tree. Do not create new files.",
    auto: "Create new files OR modify existing files as needed to best satisfy the request.",
  };

  const editFormatInstructions = diffFormatInstructions(mode);

  return `You are Aether, an AI coding agent. Generate code based on the user's request.

Project context:
${context.fileTree}

Primary language: ${context.language}
Framework: ${context.framework}

Configuration files detected:
${formatConfigFiles(context.configFiles)}

Mode: ${mode} — ${modeInstructions[mode]}

Output format instructions:
${editFormatInstructions}
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
  sections.push(diffFormatInstructions(mode));
  sections.push("- You may output MULTIPLE files in a single response");
  sections.push("- Keep code concise, well-commented, and production-ready");
  sections.push("- Use the project's existing patterns and conventions");
  sections.push("- Include all necessary imports and dependencies");
  sections.push("- Do NOT wrap the response in explanatory text — output ONLY the file markers and code blocks");
  sections.push("");

  sections.push("Now, respond to the user's request:");

  return sections.join("\n");
}

/**
 * Output-format instructions for the given mode. In edit mode the model is
 * told to emit ONLY diff patches (`### EDIT:` + `@@ line N-M @@` + `-`/`+`
 * lines) — never the full file content. Create/auto keep the full-file
 * `### FILE:` format.
 */
function diffFormatInstructions(mode: GeneratorMode): string {
  if (mode !== "edit") {
    return "- Output each file as: ### FILE: path/to/file.ext\n- Immediately followed by a code fence with the language tag: ```language";
  }
  return `- Edit mode: output ONLY the changed lines as a diff patch — NEVER the full file content
- For each file you modify output: ### EDIT: path/to/file.ext
- Immediately followed by a hunk header: @@ line N-M @@  (N = first changed line, M = last changed line, 1-based, inclusive, from the file on disk)
- Then output ONLY the changed lines: prefix removed lines with \`-\` and added lines with \`+\`
- You may output MULTIPLE hunks per file — give each hunk its own @@ header; line numbers always refer to the ORIGINAL file
- Preserve all unrelated lines — do not repeat them in the patch

Example (edit mode):
### EDIT: src/utils/math.ts
@@ line 3-5 @@
-export function sum(numbers: number[]): number {
+export function sum(numbers: readonly number[]): number {
-  return numbers.reduce((a, b) => a + b, 0);
+  return numbers.reduce((a, b) => a + b, 0) * 2;
`;
}

/**
 * Append memory-aware edit instructions to a system prompt when MemoryStore
 * search found existing files (and/or decisions) relevant to the prompt.
 * The model is told which files need modification, shown their full content,
 * and asked to emit `### EDIT:` markers with precise line-level changes.
 */
function appendMemoryContext(
  base: string,
  files: Array<{ path: string; content: string }>,
  decisions: Array<{ question: string; answer: string }>,
): string {
  const sections: string[] = [base, ""];
  if (files.length > 0) {
    sections.push("EXISTING FILES THAT NEED MODIFICATION:");
    for (const f of files) {
      sections.push(`─── ${f.path} ───`);
      sections.push(f.content);
      sections.push("");
    }
  }
  if (decisions.length > 0) {
    sections.push("RELEVANT PAST DECISIONS (from project memory):");
    for (const d of decisions) sections.push(`- ${d.question} → ${d.answer}`);
    sections.push("");
  }
  sections.push("These existing files need modification. Output EXACTLY which file, which lines, what to change.");
  sections.push("- For each modified file output: ### EDIT: path/to/file.ts");
  sections.push("- Immediately followed by a hunk header: @@ line N-M @@  (N = first changed line, M = last changed line, 1-based, inclusive, from the file shown above)");
  sections.push("- Then output ONLY the changed lines: prefix removed lines with `-` and added lines with `+`");
  sections.push("- You may output MULTIPLE hunks per file — give each hunk its own @@ header; line numbers always refer to the ORIGINAL file shown above");
  sections.push("- NEVER output the full file content — output ONLY the changed lines");
  sections.push("- Preserve the same file path as shown above");
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

  // Match: ### FILE: path/to/file.ext OR ### EDIT: path/to/file.ext
  // followed by an optional annotation line (e.g. "L12-20: ...") and then a
  // fenced code block: ```lang\n...\n```
  const filePattern = /###\s+(?:FILE|EDIT):\s*(\S+)\s*\n(?:[^\n`]*\n)?\s*```(\w*)\s*\n([\s\S]*?)```/g;

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

/** Guess a language tag from a file path's extension (for diff-only edits). */
function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const reverse: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python",
    rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
    c: "c", cpp: "cpp", css: "css", html: "html", json: "json", yaml: "yaml",
    yml: "yaml", md: "markdown", sh: "shell", bash: "bash", sql: "sql",
    graphql: "graphql", toml: "toml", txt: "text",
  };
  return reverse[ext] ?? "text";
}

// ── diff patch engine (edit mode) ─────────────────────────────────────────

const EDIT_BLOCK_RE = /###\s+EDIT:\s*(\S+)\s*\n([\s\S]*?)(?=###\s+(?:FILE|EDIT):|$)/g;
const HUNK_RE = /@@\s*line\s*(\d+)\s*-\s*(\d+)\s*@@\s*\n([\s\S]*?)(?=@@\s*line|$)/g;

/**
 * Parse `### EDIT:` blocks that contain `@@ line N-M @@` diff hunks into
 * `FilePatch` structures. A `### EDIT:` block WITHOUT hunks (e.g. full-file
 * output) is intentionally ignored here — it falls back to `parseResponse`.
 */
export function parseEdits(raw: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");

  let block;
  while ((block = EDIT_BLOCK_RE.exec(normalized)) !== null) {
    const rawPath = block[1].trim();
    const body = block[2];

    let cleanPath = rawPath.replace(/^\.\//, "");
    if (cleanPath.startsWith("/") || cleanPath.includes("..")) continue;

    const hunks: PatchHunk[] = [];
    let hunkMatch;
    HUNK_RE.lastIndex = 0;
    while ((hunkMatch = HUNK_RE.exec(body)) !== null) {
      const startLine = Number(hunkMatch[1]);
      const endLine = Number(hunkMatch[2]);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        continue; // malformed header — skip this hunk
      }
      const removed: string[] = [];
      const added: string[] = [];
      for (const line of hunkMatch[3].split("\n")) {
        if (line.startsWith("+") && !line.startsWith("++")) added.push(line.slice(1));
        else if (line.startsWith("-") && !line.startsWith("--")) removed.push(line.slice(1));
        // bare lines (context) and `@@` leftovers are ignored
      }
      if (removed.length === 0 && added.length === 0) continue; // empty hunk
      hunks.push({ startLine, endLine, removed, added });
    }

    if (hunks.length > 0) patches.push({ path: cleanPath, hunks });
  }

  return patches;
}

/**
 * Apply a patch to the original file content. Returns the full patched
 * content, or `null` when a hunk cannot be matched (caller keeps the original
 * and warns). Multiple hunks are applied in order; their line numbers refer to
 * the ORIGINAL file, so an internal offset tracks the accumulated shift.
 */
export function applyPatch(originalContent: string, patch: FilePatch): string | null {
  let lines = originalContent.replace(/\r\n/g, "\n").split("\n");
  let offset = 0;

  for (const hunk of patch.hunks) {
    // Sanity-check the hunk header.
    if (
      !Number.isInteger(hunk.startLine) ||
      !Number.isInteger(hunk.endLine) ||
      hunk.startLine < 1 ||
      hunk.endLine < hunk.startLine
    ) {
      return null;
    }

    let start = hunk.startLine - 1 + offset;
    let end = hunk.endLine + offset; // exclusive end (endLine is 1-based inclusive)

    if (hunk.removed.length > 0) {
      const actual = lines.slice(start, end);
      if (!arraysEqual(actual, hunk.removed)) {
        // Line numbers may be slightly off — search for the removed block.
        const found = indexOfBlock(lines, hunk.removed);
        if (found === -1) return null;
        start = found;
        end = found + hunk.removed.length;
      }
    } else {
      // Pure insertion before startLine.
      if (start < 0) return null;
      start = Math.min(start, lines.length);
      end = start;
    }

    lines = [...lines.slice(0, start), ...hunk.added, ...lines.slice(end)];
    offset += hunk.added.length - hunk.removed.length;
  }

  return lines.join("\n");
}

/** Read each patch's target file from disk, apply it, and produce full-file GeneratorOutputs. */
async function applyEdits(
  patches: FilePatch[],
  targetDir: string,
): Promise<{ files: GeneratorOutput[]; warnings: string[] }> {
  const files: GeneratorOutput[] = [];
  const warnings: string[] = [];

  for (const patch of patches) {
    const abs = resolve(targetDir, patch.path);
    let original: string;
    try {
      original = await readFile(abs, "utf-8");
    } catch {
      warnings.push(`patch for ${patch.path} skipped: file not found on disk — keeping original`);
      continue;
    }

    const patched = applyPatch(original, patch);
    if (patched === null) {
      warnings.push(`patch for ${patch.path} could not be applied (hunk mismatch) — keeping original`);
      continue;
    }

    files.push({
      path: patch.path,
      content: patched,
      language: langFromPath(patch.path),
      action: "edit",
    });
  }

  return { files, warnings };
}

/**
 * Impact analysis — after applying a patch, search MemoryStore file summaries
 * for other files that likely depend on the changed file. Matches on the
 * changed file's basename, its stem, and symbols (exported/declared names)
 * found in the patch's added lines.
 */
export async function analyzeImpact(
  patches: FilePatch[],
  targetDir: string,
  store?: MemoryStore,
): Promise<ImpactAnalysis> {
  const changedFiles = patches.map((p) => p.path);
  if (!store) {
    return {
      changedFiles,
      affectedFiles: [],
      rationale: "no MemoryStore available — impact analysis skipped",
    };
  }

  const summaries: Record<string, string> = {};
  try {
    Object.assign(summaries, await store.getProjectFiles(targetDir));
  } catch {
    return {
      changedFiles,
      affectedFiles: [],
      rationale: "could not read project memory summaries — impact analysis skipped",
    };
  }

  const flagged = new Map<string, string[]>();
  const addFlag = (path: string, reason: string) => {
    if (changedFiles.includes(path)) return;
    flagged.set(path, [...(flagged.get(path) ?? []), reason]);
  };

  for (const patch of patches) {
    const base = basename(patch.path);
    const stem = base.replace(/\.[^.]+$/, "");
    const symbols = extractSymbols(patch.hunks.flatMap((h) => h.added));

    for (const [path, summary] of Object.entries(summaries)) {
      if (path === patch.path) continue;
      const haystack = `${path} ${summary}`.toLowerCase();
      if (matchWord(haystack, base.toLowerCase())) {
        addFlag(path, `mentions ${base}`);
      } else if (matchWord(haystack, stem.toLowerCase())) {
        addFlag(path, `mentions ${stem}`);
      }
      for (const symbol of symbols) {
        if (matchWord(haystack, symbol.toLowerCase())) {
          addFlag(path, `references symbol ${symbol}`);
        }
      }
    }
  }

  const affectedFiles = [...flagged.keys()];
  const rationale =
    affectedFiles.length === 0
      ? "no other files in project memory reference the changed file(s)"
      : `${affectedFiles.length} file(s) in project memory reference the changed file(s) (${[...new Set([...flagged.values()].flat())].join(", ")})`;

  return { changedFiles, affectedFiles, rationale };
}

/** Extract exported/declared identifiers from added lines for impact matching. */
function extractSymbols(addedLines: string[]): string[] {
  const text = addedLines.join("\n");
  const names = new Set<string>();
  const declRe = /(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(text)) !== null) names.add(m[1]);
  const exportRe = /export\s*\{([^}]+)\}/g;
  while ((m = exportRe.exec(text)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return [...names].filter((n) => n.length >= 3);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Word-boundary match for impact heuristics (avoids "format" matching "formats"). */
function matchWord(haystack: string, word: string): boolean {
  if (word.length < 3) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
  return new RegExp(`(?:^|[^a-z0-9_])${esc}(?:[^a-z0-9_]|$)`).test(haystack);
}

/** First index where `block` appears as a contiguous sub-array of `lines`, or -1. */
function indexOfBlock(lines: string[], block: string[]): number {
  if (block.length === 0) return 0;
  outer: for (let i = 0; i <= lines.length - block.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) continue outer;
    }
    return i;
  }
  return -1;
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
    // Memory-aware: find existing files + past decisions relevant to the prompt
    // so edits target real code instead of guessing from a scan tree alone.
    const memory = await this.findMemoryMatches(input.prompt, context);
    const memoryStore = this.getMemoryStore(context);
    const result = await generateFromPrompt(input.prompt, {
      provider: context.provider,
      model: context.model,
      mode,
      targetDir: context.targetDir,
      maxTokens: input.options?.maxTokens as number | undefined,
      memoryFiles: memory?.files,
      memoryDecisions: memory?.decisions,
      memoryStore,
    });

    const files: GeneratedFile[] = result.files.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language,
      action: f.action,
    }));

    return {
      success: true,
      result: {
        fileCount: files.length,
        memoryMatches: memory ? { files: memory.files.length, decisions: memory.decisions.length } : 0,
        patches: result.patches ? result.patches.map((p) => p.path) : [],
        impact: result.impact,
        warnings: result.warnings ?? [],
      },
      files,
      metadata: { agent: this.name, duration: 0, modelUsed: context.model },
    };
  }

  /** Fetch the registered MemoryStore (for impact analysis), if any. */
  private getMemoryStore(context: AgentContext): MemoryStore | undefined {
    try {
      return context.container.get<MemoryStore>("memoryStore");
    } catch {
      return undefined;
    }
  }

  /**
   * Search project memory (file summaries + decisions) for entries relevant to
   * the prompt, then read the matched files from disk. Returns null when the
   * MemoryStore is unavailable, no keywords can be extracted, or nothing matches —
   * in which case the caller falls back to scan-only generation.
   */
  private async findMemoryMatches(
    prompt: string,
    context: AgentContext,
  ): Promise<MemoryMatches | null> {
    try {
      const store = context.container.get<MemoryStore>("memoryStore");
      const keywords = extractKeywords(prompt);
      if (keywords.length === 0) return null;

      const [entries, decisions] = await Promise.all([
        store.getProjectFiles(context.targetDir),
        store.getDecisions(context.targetDir),
      ]);

      const matchedPaths = Object.entries(entries)
        .filter(([path, summary]) => {
          const haystack = `${path} ${summary}`.toLowerCase();
          return keywords.some((keyword) => haystack.includes(keyword));
        })
        .map(([path]) => path);

      const matchedDecisions = decisions.filter((d) => {
        const haystack = `${d.question} ${d.answer}`.toLowerCase();
        return keywords.some((keyword) => haystack.includes(keyword));
      });

      if (matchedPaths.length === 0 && matchedDecisions.length === 0) return null;

      const files = await this.readFiles(context, matchedPaths);
      return { files, decisions: matchedDecisions };
    } catch {
      // No MemoryStore registered or the lookup failed — never block generation.
      return null;
    }
  }
}

// ── memory keyword helpers ────────────────────────────────────────────────

/** Words too common to be useful for matching file summaries. */
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "already", "also", "another", "anyone",
  "anything", "around", "before", "being", "below", "between", "change", "could",
  "create", "doing", "down", "during", "each", "every", "first", "from", "generate",
  "have", "having", "into", "just", "like", "make", "more", "most", "much", "must",
  "need", "never", "only", "other", "over", "please", "project", "should", "some",
  "still", "such", "than", "that", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "under", "until", "very", "want", "well", "were",
  "what", "when", "where", "which", "while", "will", "with", "would", "your",
  "file", "files", "code", "codes", "user", "users", "using", "used", "work", "works",
]);

/** Split a prompt into lowercase keywords (>= 4 chars, no stopwords). */
function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}
