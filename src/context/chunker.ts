/**
 * Smart chunker — splits large files into semantic chunks.
 *
 * Uses regex-based function/class boundary detection for TS/JS (AST-aware)
 * and falls back to line-based chunking for unsupported languages.
 * Configurable max chunk size via AETHER_CHUNK_SIZE (default: 4000 tokens).
 */

import type { ContextChunk } from "./types.js";

// ── token estimation ───────────────────────────────────────────────────────

/**
 * Rough token estimation: ~4 characters per token (common heuristic).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── chunk size config ──────────────────────────────────────────────────────

function maxChunkTokens(): number {
  const env = typeof process !== "undefined" ? process.env.AETHER_CHUNK_SIZE : undefined;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 4000;
}

// ── chunking ───────────────────────────────────────────────────────────────

/**
 * Split source code into semantic chunks.
 *
 * For TypeScript/JavaScript: splits on function, class, interface, type,
 * and export boundaries. Falls back to line-based chunking if content is
 * too dense.
 *
 * For other languages: line-based chunking.
 */
export function chunkFile(
  content: string,
  filePath: string,
  language?: string,
): ContextChunk[] {
  const lang = language ?? detectLanguage(filePath);

  if (lang === "TypeScript" || lang === "JavaScript" ||
      lang === "TypeScript (React)" || lang === "JavaScript (React)") {
    return chunkTSJS(content, filePath);
  }

  if (lang === "Python") {
    return chunkPython(content, filePath);
  }

  // Fallback: line-based chunking
  return chunkByLines(content, filePath);
}

/**
 * Chunk TypeScript/JavaScript by function/class/export boundaries.
 */
function chunkTSJS(content: string, filePath: string): ContextChunk[] {
  const lines = content.split("\n");
  const maxTokens = maxChunkTokens();

  // Find semantic boundaries: lines starting with export, function, class, interface, type
  // Also the start of import blocks
  const boundaries = findTSJSBoundaries(lines);

  return buildChunks(lines, boundaries, filePath, maxTokens);
}

/**
 * Chunk Python by def/class boundaries.
 */
function chunkPython(content: string, filePath: string): ContextChunk[] {
  const lines = content.split("\n");
  const maxTokens = maxChunkTokens();

  const boundaries = findPythonBoundaries(lines);
  return buildChunks(lines, boundaries, filePath, maxTokens);
}

/**
 * Line-based chunking fallback.
 */
function chunkByLines(content: string, filePath: string): ContextChunk[] {
  const lines = content.split("\n");
  const maxTokens = maxChunkTokens();
  const chunks: ContextChunk[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokenAcc = 0;

    while (end < lines.length) {
      const lineTokens = estimateTokens(lines[end]) + 1; // +1 for newline
      if (tokenAcc + lineTokens > maxTokens && end > start) break;
      tokenAcc += lineTokens;
      end++;
    }

    if (end === start) end = start + 1; // ensure at least one line

    const chunkLines = lines.slice(start, end);
    const chunkContent = chunkLines.join("\n");
    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      content: chunkContent,
      tokenCount: estimateTokens(chunkContent),
    });

    start = end;
  }

  return chunks;
}

// ── boundary detection ─────────────────────────────────────────────────────

interface Boundary {
  lineIndex: number; // 0-based line index
  priority: number;  // higher = stronger boundary
  label?: string;
}

function findTSJSBoundaries(lines: string[]): Boundary[] {
  const boundaries: Boundary[] = [];

  // Always include start
  boundaries.push({ lineIndex: 0, priority: 100, label: "start" });

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      if (trimmed.startsWith("/**") || trimmed.startsWith(" * ") || trimmed.startsWith(" *\n")) {
        // JSDoc — weaker boundary
        boundaries.push({ lineIndex: i, priority: 20, label: "jsdoc" });
      }
      continue;
    }

    let priority = 0;
    let label = "";

    // Export declarations (strong boundaries)
    if (/^export\s+(const|let|var|function|class|interface|type|enum|default|abstract)/.test(trimmed)) {
      priority = 90;
      label = "export";
    }
    // Class declarations
    else if (/^(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(trimmed)) {
      priority = 85;
      label = "class";
    }
    // Function declarations
    else if (/^(?:export\s+)?(?:async\s+)?function\s+\w+/.test(trimmed)) {
      priority = 80;
      label = "function";
    }
    // Interface/type declarations
    else if (/^(?:export\s+)?(?:interface|type)\s+\w+/.test(trimmed)) {
      priority = 70;
      label = "interface";
    }
    // Const with arrow function (likely a named function)
    else if (/^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/.test(trimmed)) {
      priority = 75;
      label = "arrow";
    }
    // describe/it/test blocks (test files)
    else if (/^(?:describe|it|test)\s*\(/.test(trimmed)) {
      priority = 65;
      label = "test";
    }
    // Import blocks (group them)
    else if (/^import\s/.test(trimmed) && i === 0) {
      priority = 10;
      label = "import";
    }

    if (priority > 0) {
      boundaries.push({ lineIndex: i, priority, label });
    }
  }

  // Sort by line index
  boundaries.sort((a, b) => a.lineIndex - b.lineIndex);

  return boundaries;
}

function findPythonBoundaries(lines: string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  boundaries.push({ lineIndex: 0, priority: 100, label: "start" });

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^class\s+\w+/.test(trimmed)) {
      boundaries.push({ lineIndex: i, priority: 85, label: "class" });
    } else if (/^(?:async\s+)?def\s+\w+/.test(trimmed)) {
      boundaries.push({ lineIndex: i, priority: 80, label: "function" });
    }
  }

  boundaries.sort((a, b) => a.lineIndex - b.lineIndex);
  return boundaries;
}

// ── chunk builder ──────────────────────────────────────────────────────────

function buildChunks(
  lines: string[],
  boundaries: Boundary[],
  filePath: string,
  maxTokens: number,
): ContextChunk[] {
  const chunks: ContextChunk[] = [];

  // Group lines from each boundary to the next
  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b].lineIndex;
    const endIdx = b + 1 < boundaries.length
      ? boundaries[b + 1].lineIndex
      : lines.length;

    const chunkLines = lines.slice(startIdx, endIdx);
    const chunkContent = chunkLines.join("\n");
    const chunkTokens = estimateTokens(chunkContent);

    // If chunk is within budget, keep it as is
    if (chunkTokens <= maxTokens) {
      chunks.push({
        filePath,
        startLine: startIdx + 1,
        endLine: endIdx,
        content: chunkContent,
        tokenCount: chunkTokens,
        symbols: [boundaries[b].label ?? "block"],
      });
      continue;
    }

    // Oversized chunk — sub-split by lines
    let subStart = startIdx;
    while (subStart < endIdx) {
      let subEnd = subStart;
      let subTokens = 0;

      while (subEnd < endIdx) {
        const lineTokens = estimateTokens(lines[subEnd]) + 1;
        if (subTokens + lineTokens > maxTokens && subEnd > subStart) break;
        subTokens += lineTokens;
        subEnd++;
      }

      if (subEnd === subStart) subEnd = subStart + 1;

      const subLines = lines.slice(subStart, subEnd);
      const subContent = subLines.join("\n");
      chunks.push({
        filePath,
        startLine: subStart + 1,
        endLine: subEnd,
        content: subContent,
        tokenCount: estimateTokens(subContent),
      });

      subStart = subEnd;
    }
  }

  return chunks;
}

// ── helpers ────────────────────────────────────────────────────────────────

const LANG_MAP: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript (React)",
  ".js": "JavaScript", ".jsx": "JavaScript (React)",
  ".py": "Python", ".rs": "Rust", ".go": "Go",
  ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin",
  ".swift": "Swift", ".c": "C", ".cpp": "C++",
  ".css": "CSS", ".html": "HTML",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
  ".md": "Markdown", ".sh": "Shell",
};

function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return LANG_MAP[ext] ?? (ext ? ext.slice(1).toUpperCase() : "Unknown");
}

/**
 * Check if a file is chunkable (source code, not data/config).
 */
export function isChunkable(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const chunkable = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go",
    ".rb", ".java", ".kt", ".swift", ".c", ".cpp", ".h",
    ".css", ".scss", ".less", ".html",
  ]);
  return chunkable.has(ext);
}

/**
 * Return whether a file is considered "small" (below chunk threshold).
 */
export function isSmallFile(content: string): boolean {
  return estimateTokens(content) <= maxChunkTokens();
}
