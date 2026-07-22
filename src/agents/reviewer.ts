/**
 * Review Agent — the "brain" of `aether review`.
 *
 * Takes a target path (file or directory), scans for context, builds a
 * review-specific system prompt, calls the LLM, and parses the response
 * into structured ReviewResults.
 */

import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { scanDirectory, type ProjectContext } from "../utils/scanner.js";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, basename, extname } from "node:path";
import type { ContextManager, ContextPayload } from "../context/manager.js";

// ── public types ─────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";
export type Category = "security" | "bug" | "performance" | "style" | "typesafety" | "unused";

export interface ReviewResult {
  /** Relative file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Issue severity. */
  severity: Severity;
  /** Issue category. */
  category: Category;
  /** Human-readable description. */
  message: string;
  /** Suggested code fix (optional). */
  fix?: string;
  /** Before text from diff (optional, populated by differ). */
  before?: string;
  /** After text from diff (optional, populated by differ). */
  after?: string;
}

export interface ReviewOptions {
  /** Initialised provider instance. */
  provider: LLMProvider;
  /** Optional model name. */
  model?: string;
  /** File or directory to review. */
  target: string;
  /** Filter results to this severity. */
  severity?: Severity;
  /** Max tokens for the LLM response. */
  maxTokens?: number;
  /** Optional context manager for enhanced context building. */
  contextManager?: ContextManager;
}

export interface ReviewAgentResult {
  /** Parsed review results. */
  results: ReviewResult[];
  /** Raw LLM response (for debugging). */
  raw: string;
  /** Project context that was injected into the prompt. */
  context: ProjectContext;
  /** Number of files actually reviewed. */
  filesReviewed: number;
}

// ── file extension → language map ────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (React)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (React)",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".h": "C/C++ Header",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".md": "Markdown",
  ".sh": "Shell",
  ".bash": "Bash",
  ".toml": "TOML",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

/** Extensions worth reviewing — source code, not data/config files. */
const REVIEWABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb",
  ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".css", ".scss", ".less", ".html", ".vue", ".svelte",
  ".sql", ".graphql", ".sh", ".bash", ".zsh",
]);

const MAX_FILES = 30;
const MAX_FILE_SIZE = 50_000; // 50 KB per file
const MAX_TOTAL_SIZE = 200_000; // 200 KB total content for prompt

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Review a file or directory.
 *
 * 1. Determines if target is a file or directory.
 * 2. Scans for project context.
 * 3. Reads source files (filtered by extension and size).
 * 4. Builds a review system prompt.
 * 5. Calls the LLM provider.
 * 6. Parses the response into structured ReviewResults.
 */
export async function reviewTarget(
  options: ReviewOptions,
): Promise<ReviewAgentResult> {
  const absTarget = resolve(options.target);

  // ── 1. Determine target type ──────────────────────────────────────────
  let targetStat;
  try {
    targetStat = await stat(absTarget);
  } catch {
    throw new Error(`Target not found: ${options.target}`);
  }

  const isDirectory = targetStat.isDirectory();

  // ── 2. Scan project context ───────────────────────────────────────────
  const contextRoot = isDirectory ? absTarget : resolve(absTarget, "..");
  let context: ProjectContext;
  try {
    context = await scanDirectory(contextRoot);
  } catch {
    context = {
      root: contextRoot,
      fileTree: "(empty or new project)",
      language: "Unknown",
      framework: "None detected",
      configFiles: {},
      files: [],
    };
  }

  // ── 3. Collect file contents ──────────────────────────────────────────
  const filesToReview: string[] = [];

  if (isDirectory) {
    // Use the scanner's file list filtered by reviewable extensions
    const reviewable = context.files.filter((f) => {
      const ext = extname(f).toLowerCase();
      return REVIEWABLE_EXTS.has(ext);
    });
    filesToReview.push(...reviewable.slice(0, MAX_FILES));
  } else {
    const relPath = relative(context.root, absTarget);
    filesToReview.push(relPath);
  }

  if (filesToReview.length === 0) {
    throw new Error(
      "No reviewable files found. " +
        "Supported extensions: " +
        [...REVIEWABLE_EXTS].join(", "),
    );
  }

  // Read file contents (with size limits)
  const fileContents: Array<{ path: string; content: string; language: string }> = [];
  let totalBytes = 0;

  for (const relPath of filesToReview) {
    if (totalBytes >= MAX_TOTAL_SIZE) break;

    const absPath = resolve(context.root, relPath);
    try {
      const raw = await readFile(absPath, "utf-8");
      const trimmed =
        raw.length > MAX_FILE_SIZE
          ? raw.slice(0, MAX_FILE_SIZE) +
            `\n\n// ... (truncated ${raw.length - MAX_FILE_SIZE} bytes)`
          : raw;

      const ext = extname(relPath).toLowerCase();
      const language = LANGUAGE_MAP[ext] ?? (ext.slice(1).toUpperCase() || "Unknown");

      fileContents.push({ path: relPath, content: trimmed, language });
      totalBytes += Buffer.byteLength(trimmed, "utf-8");
    } catch {
      // Skip unreadable files
    }
  }

  if (fileContents.length === 0) {
    throw new Error("Could not read any files for review.");
  }

  // ── 4. Build system prompt ────────────────────────────────────────────
  const projectName = basename(context.root);
  const primaryLang = context.language;

  let systemPrompt: string;
  let contextPayload: ContextPayload | null = null;

  // Try context manager for richer context
  if (options.contextManager) {
    try {
      contextPayload = await options.contextManager.buildContextPayload(
        "Review this code for bugs, security issues, and improvements",
        options.target,
      );
    } catch {
      // Fall back to basic
    }
  }

  if (contextPayload) {
    systemPrompt = buildReviewPromptFromPayload(contextPayload, projectName, primaryLang);
  } else {
    systemPrompt = buildReviewPrompt(projectName, primaryLang, fileContents);
  }

  // ── 5. Call provider ──────────────────────────────────────────────────
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please review the ${fileContents.length} file(s) shown above. Focus on actionable issues — bugs, security problems, and clear improvements. Skip nitpicky style opinions.`,
    },
  ];

  let response;
  try {
    response = await options.provider.chat(messages, {
      model: options.model,
      maxTokens: options.maxTokens ?? 8192,
      temperature: 0.1, // low temp for review consistency
    });
  } catch (err: unknown) {
    throw new Error(
      `Provider call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawContent = response.content;
  if (!rawContent || rawContent.trim().length === 0) {
    return {
      results: [],
      raw: "",
      context,
      filesReviewed: fileContents.length,
    };
  }

  // ── 6. Parse response ─────────────────────────────────────────────────
  const results = parseReviewResponse(rawContent);

  // Filter by severity if requested
  const filtered = options.severity
    ? filterBySeverity(results, options.severity)
    : results;

  return {
    results: filtered,
    raw: rawContent,
    context,
    filesReviewed: fileContents.length,
  };
}

// ── system prompt builder ────────────────────────────────────────────────

function buildReviewPrompt(
  projectName: string,
  language: string,
  files: Array<{ path: string; content: string; language: string }>,
): string {
  let prompt = `You are Aether, a senior code reviewer. Analyze the following code and identify issues.

Project: ${projectName}
Language: ${language}

`;

  // Append each file's content
  for (const file of files) {
    prompt += `─── ${file.path} (${file.language}) ───\n`;
    prompt += file.content;
    prompt += "\n\n";
  }

  prompt += `For each issue found, output EXACTLY in this format:
### ISSUE: {file}:{line}
Severity: error|warning|info
Category: security|bug|performance|style|typesafety|unused
Message: (clear description)
Fix: (code suggestion or diff)

If the code looks good, respond with "### NO_ISSUES"

Important:
- Use the EXACT file path as shown above (e.g., "src/utils/parser.ts")
- Line numbers must be integers
- Be specific in messages — mention exact variable names, function names, etc.
- Suggest concrete fixes, not vague advice
- If you're unsure about an issue, use severity "info"
- Do NOT include explanatory text outside the issue format`;

  return prompt;
}

/**
 * Build a review prompt using the context payload from ContextManager.
 */
function buildReviewPromptFromPayload(
  payload: ContextPayload,
  projectName: string,
  language: string,
): string {
  const sections: string[] = [];

  sections.push("You are Aether, a senior code reviewer. Analyze the following code and identify issues.");
  sections.push("");
  sections.push(`Project: ${projectName}`);
  sections.push(`Language: ${language}`);
  sections.push(`Token budget: ${payload.tokenBudget.used}/${payload.tokenBudget.max} tokens`);
  sections.push("");

  // Inject chunks
  if (payload.chunks.length > 0) {
    for (const chunk of payload.chunks) {
      sections.push(`─── ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ───`);
      sections.push(chunk.content);
      sections.push("");
    }
  } else {
    sections.push("(No files available for review)");
    sections.push("");
  }

  sections.push(`For each issue found, output EXACTLY in this format:
### ISSUE: {file}:{line}
Severity: error|warning|info
Category: security|bug|performance|style|typesafety|unused
Message: (clear description)
Fix: (code suggestion or diff)

If the code looks good, respond with "### NO_ISSUES"

Important:
- Use the EXACT file path as shown above (e.g., "src/utils/parser.ts")
- Line numbers must be integers
- Be specific in messages — mention exact variable names, function names, etc.
- Suggest concrete fixes, not vague advice
- If you're unsure about an issue, use severity "info"
- Do NOT include explanatory text outside the issue format`);

  return sections.join("\n");
}

// ── response parser ──────────────────────────────────────────────────────

function parseReviewResponse(raw: string): ReviewResult[] {
  const normalized = raw.replace(/\r\n/g, "\n");

  // Check for no-issues marker
  if (/###\s*NO_ISSUES/i.test(normalized)) {
    return [];
  }

  const results: ReviewResult[] = [];

  // Match each issue block: ### ISSUE: file:line
  // followed by Severity:, Category:, Message:, Fix: lines
  const issuePattern =
    /###\s+ISSUE:\s*(\S+?):(\d+)\s*\n\s*Severity:\s*(error|warning|info)\s*\n\s*Category:\s*(security|bug|performance|style|typesafety|unused)\s*\n\s*Message:\s*(.+?)\s*\n(?:\s*Fix:\s*(.+?)\s*\n)?(?=###\s+ISSUE:|###\s+NO_ISSUES|$)/gis;

  let match;
  while ((match = issuePattern.exec(normalized)) !== null) {
    const file = match[1].trim();
    const line = parseInt(match[2], 10);
    const severity = match[3].toLowerCase() as Severity;
    const category = match[4].toLowerCase() as Category;
    const message = match[5].trim();
    const fix = match[6]?.trim() || undefined;

    if (isNaN(line) || line < 1) continue;

    results.push({ file, line, severity, category, message, fix });
  }

  // Fallback: try looser matching if structured parsing yielded nothing
  if (results.length === 0) {
    const loosePattern =
      /###\s+ISSUE:\s*(\S+?):(\d+)[\s\S]*?Severity:\s*(error|warning|info)[\s\S]*?Category:\s*(\S+)[\s\S]*?Message:\s*(.+?)(?:\n|$)/gi;

    while ((match = loosePattern.exec(normalized)) !== null) {
      const file = match[1].trim();
      const line = parseInt(match[2], 10);
      const severity = match[3].toLowerCase() as Severity;
      const category = normalizeCategory(match[4]);
      const message = match[5].trim();

      if (isNaN(line) || line < 1) continue;

      results.push({ file, line, severity, category, message });
    }
  }

  // Last-resort fallback: if still empty but the response has content,
  // try to extract any line that looks like a finding
  if (results.length === 0 && normalized.trim().length > 0) {
    // Check if there's content that doesn't match NO_ISSUES
    const lines = normalized.split("\n");
    let currentFile = "";

    for (const line of lines) {
      const fileMatch = line.match(/^#+\s*(?:ISSUE|File):\s*(\S+)/i);
      if (fileMatch) {
        currentFile = fileMatch[1].trim();
        continue;
      }

      // Look for "Line X:" or ":X:" patterns
      const lineMatch = line.match(/(?:Line\s*|:)(\d+)/i);
      if (lineMatch && currentFile) {
        const lineNum = parseInt(lineMatch[1], 10);
        if (!isNaN(lineNum) && lineNum > 0) {
          results.push({
            file: currentFile,
            line: lineNum,
            severity: "info",
            category: "style",
            message: line.replace(/^[#\-\s]*/, "").trim().slice(0, 200),
          });
        }
      }
    }
  }

  return results;
}

function normalizeCategory(raw: string): Category {
  const lower = raw.trim().toLowerCase();
  const valid: Category[] = [
    "security", "bug", "performance", "style", "typesafety", "unused",
  ];
  if (valid.includes(lower as Category)) return lower as Category;

  // Fuzzy matching
  if (lower.includes("secur")) return "security";
  if (lower.includes("bug") || lower.includes("logic")) return "bug";
  if (lower.includes("perform") || lower.includes("slow")) return "performance";
  if (lower.includes("type")) return "typesafety";
  if (lower.includes("unused") || lower.includes("dead")) return "unused";
  return "style";
}

// ── severity filter ──────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Filter results to only those at or above a given severity level.
 * e.g., `--severity error` returns ONLY errors;
 * `--severity warning` returns errors AND warnings.
 */
export function filterBySeverity(
  results: ReviewResult[],
  minSeverity: Severity,
): ReviewResult[] {
  const minOrder = SEVERITY_ORDER[minSeverity];
  return results.filter((r) => SEVERITY_ORDER[r.severity] <= minOrder);
}
