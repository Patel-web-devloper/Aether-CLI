/**
 * Context builder — assembles the optimal context payload for an LLM call.
 *
 * Priority-based inclusion:
 *   1. User prompt (always)
 *   2. Directly targeted files (user specified)
 *   3. Imported/referenced files (follow imports)
 *   4. Project config files (package.json, tsconfig, etc.)
 *   5. Recent conversation history
 *   6. Relevant chunks from the index (keyword match against prompt)
 *
 * Respects AETHER_MAX_CONTEXT_TOKENS (default: 128K) per provider.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import type { FileIndex, FileIndexEntry, ContextChunk, HistoryMessage, ContextPayload, ContextBuildOptions } from "./types.js";
import { chunkFile, isSmallFile, estimateTokens } from "./chunker.js";

// ── config ─────────────────────────────────────────────────────────────────

function maxContextTokens(): number {
  const env = typeof process !== "undefined" ? process.env.AETHER_MAX_CONTEXT_TOKENS : undefined;
  if (env) {
    const p = parseInt(env, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  return 128_000;
}

// ── main entry ─────────────────────────────────────────────────────────────

/**
 * Build a context payload from a user prompt and project index.
 */
export function buildContext(
  prompt: string,
  index: FileIndex,
  options: ContextBuildOptions = {},
): ContextPayload {
  const budget = options.maxTokens ?? maxContextTokens();
  let usedTokens = 0;

  // ── 1. User prompt (always included) ────────────────────────────────
  const promptTokens = estimateTokens(prompt);
  usedTokens += promptTokens;

  const remaining = () => budget - usedTokens;

  // ── 2. Targeted files ───────────────────────────────────────────────
  const targetChunks: ContextChunk[] = [];
  if (options.targetFiles && options.targetFiles.length > 0) {
    for (const tf of options.targetFiles) {
      if (remaining() <= 0) break;
      const chunks = readAndChunk(tf, index.root, remaining());
      targetChunks.push(...chunks);
      usedTokens += chunks.reduce((s, c) => s + c.tokenCount, 0);
    }
  }

  // ── 3. Follow imports (simple) ──────────────────────────────────────
  const importChunks: ContextChunk[] = [];
  if (options.followImports !== false && options.targetFiles) {
    for (const tf of options.targetFiles) {
      if (remaining() <= 0) break;
      const imports = resolveImports(tf, index);
      for (const imp of imports) {
        if (remaining() <= 0) break;
        const chunks = readAndChunk(imp, index.root, remaining());
        importChunks.push(...chunks);
        usedTokens += chunks.reduce((s, c) => s + c.tokenCount, 0);
      }
    }
  }

  // ── 4. Config files ─────────────────────────────────────────────────
  const configSummary = buildConfigSummary(index);

  // ── 5. History ──────────────────────────────────────────────────────
  let history: HistoryMessage[] = [];
  if (options.includeHistory !== false) {
    // History is passed in separately — see ContextManager
    // This is filled by the manager
  }

  // ── 6. Relevant chunks from index (keyword match) ───────────────────
  const allChunks: ContextChunk[] = [];
  if (remaining() > 500) {
    const relevantChunks = findRelevantChunks(prompt, index, remaining());

    // Deduplicate: skip files already included via target or imports
    const alreadyIncluded = new Set<string>();
    for (const c of [...targetChunks, ...importChunks]) {
      alreadyIncluded.add(c.filePath);
    }

    for (const rc of relevantChunks) {
      if (alreadyIncluded.has(rc.filePath)) continue;
      if (remaining() <= 0) break;
      allChunks.push(rc);
      usedTokens += rc.tokenCount;
    }
  }

  // ── Build system prompt ─────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    index.root,
    targetChunks,
    importChunks,
    allChunks,
    configSummary,
  );
  const systemTokens = estimateTokens(systemPrompt);
  usedTokens += systemTokens;

  // Truncate system prompt if needed
  let finalSystemPrompt = systemPrompt;
  if (usedTokens > budget) {
    const excess = usedTokens - budget;
    const truncateAt = Math.max(500, systemPrompt.length - excess * 4);
    finalSystemPrompt = systemPrompt.slice(0, truncateAt) + "\n\n... (context truncated to fit token budget)";
    usedTokens = budget;
  }

  return {
    systemPrompt: finalSystemPrompt,
    userMessage: prompt,
    chunks: [...targetChunks, ...importChunks, ...allChunks],
    history,
    configSummary,
    tokenCount: usedTokens,
    tokenBudget: { used: usedTokens, max: budget },
  };
}

// ── file reading + chunking ────────────────────────────────────────────────

function readAndChunk(
  relPath: string,
  root: string,
  tokenBudget: number,
): ContextChunk[] {
  const fullPath = resolve(root, relPath);
  try {
    const content = readFileSync(fullPath, "utf-8");

    if (isSmallFile(content)) {
      return [{
        filePath: relPath,
        startLine: 1,
        endLine: content.split("\n").length,
        content,
        tokenCount: estimateTokens(content),
      }];
    }

    const chunks = chunkFile(content, relPath);
    // Take only what fits
    const result: ContextChunk[] = [];
    let used = 0;
    for (const c of chunks) {
      if (used + c.tokenCount > tokenBudget) break;
      result.push(c);
      used += c.tokenCount;
    }
    return result;
  } catch {
    return [];
  }
}

// ── import resolution ──────────────────────────────────────────────────────

function resolveImports(targetFile: string, index: FileIndex): string[] {
  const fullPath = resolve(index.root, targetFile);
  if (!existsSync(fullPath)) return [];

  try {
    const content = readFileSync(fullPath, "utf-8");
    const imports: string[] = [];
    const dir = dirname(targetFile);

    // Match: import ... from './path' or import ... from '../path'
    // and: require('./path')
    const importPattern = /(?:import|require)\s*\(?["']([^"']+)["']\)?/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        // Relative import
        const resolved = resolveRelative(dir, spec);
        if (resolved && index.entries.has(resolved)) {
          imports.push(resolved);
        } else if (resolved) {
          // Try with extensions
          for (const ext of [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"]) {
            const withExt = resolved + ext;
            if (index.entries.has(withExt)) {
              imports.push(withExt);
              break;
            }
          }
        }
      }
    }
    return imports;
  } catch {
    return [];
  }
}

function resolveRelative(fromDir: string, spec: string): string | null {
  // Normalize the spec relative to fromDir
  const parts = fromDir ? fromDir.split("/") : [];
  const specParts = spec.split("/");

  for (const sp of specParts) {
    if (sp === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (sp !== ".") {
      parts.push(sp);
    }
  }

  return parts.join("/");
}

// ── config summary ─────────────────────────────────────────────────────────

function buildConfigSummary(index: FileIndex): string {
  const configFiles = ["package.json", "tsconfig.json", "jsconfig.json",
    ".eslintrc.json", ".prettierrc", "vite.config.ts", "vitest.config.ts"];

  const lines: string[] = [];
  for (const cf of configFiles) {
    const entry = index.entries.get(cf);
    if (entry) {
      lines.push(`  - ${cf} (${entry.size} bytes)`);
    }
  }

  if (lines.length === 0) {
    return "  (no config files detected)";
  }
  return lines.join("\n");
}

// ── system prompt builder ──────────────────────────────────────────────────

function buildSystemPrompt(
  root: string,
  targetChunks: ContextChunk[],
  importChunks: ContextChunk[],
  relevantChunks: ContextChunk[],
  configSummary: string,
): string {
  const sections: string[] = [];

  sections.push(`You are Aether, an AI coding agent.`);
  sections.push(`Project root: ${root}`);
  sections.push("");

  // Config
  sections.push(`Configuration files:`);
  sections.push(configSummary);
  sections.push("");

  // Targeted files
  if (targetChunks.length > 0) {
    sections.push(`Targeted files:`);
    for (const c of targetChunks) {
      sections.push(formatChunk(c, "  "));
    }
    sections.push("");
  }

  // Imported files
  if (importChunks.length > 0) {
    sections.push(`Imported dependencies:`);
    for (const c of importChunks) {
      sections.push(formatChunk(c, "  "));
    }
    sections.push("");
  }

  // Relevant context
  if (relevantChunks.length > 0) {
    sections.push(`Relevant context:`);
    for (const c of relevantChunks) {
      sections.push(formatChunk(c, "  "));
    }
    sections.push("");
  }

  sections.push(`Respond to the user's request using the context above.`);

  return sections.join("\n");
}

function formatChunk(chunk: ContextChunk, indent: string): string {
  const header = `${indent}─── ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.tokenCount} tokens) ───`;
  return header + "\n" + chunk.content;
}

// ── keyword relevance ──────────────────────────────────────────────────────

/**
 * Find chunks from the index that are relevant to a prompt via keyword matching.
 */
function findRelevantChunks(
  prompt: string,
  index: FileIndex,
  tokenBudget: number,
): ContextChunk[] {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return [];

  // Score each file by keyword match against path + symbols
  const scored: Array<{ entry: FileIndexEntry; score: number }> = [];
  for (const entry of index.entries.values()) {
    let score = 0;

    // Match against path
    const pathLower = entry.path.toLowerCase();
    for (const kw of keywords) {
      if (pathLower.includes(kw)) score += 10;
    }

    // Match against symbols
    for (const sym of entry.symbols) {
      const symLower = sym.toLowerCase();
      for (const kw of keywords) {
        if (symLower.includes(kw)) score += 5;
      }
    }

    // Match against language
    const langLower = entry.language.toLowerCase();
    for (const kw of keywords) {
      if (langLower.includes(kw)) score += 2;
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top files that fit within budget
  const chunks: ContextChunk[] = [];
  let used = 0;

  // Prefer small files; large files get chunked
  for (const { entry } of scored) {
    if (used >= tokenBudget) break;

    const remaining = tokenBudget - used;
    const fullPath = resolve(index.root, entry.path);
    try {
      const content = readFileSync(fullPath, "utf-8");
      if (isSmallFile(content)) {
        const tok = estimateTokens(content);
        if (used + tok <= tokenBudget) {
          chunks.push({
            filePath: entry.path,
            startLine: 1,
            endLine: content.split("\n").length,
            content,
            tokenCount: tok,
            symbols: entry.symbols,
          });
          used += tok;
        }
      } else {
        // Chunk and take first chunk(s) that fit
        const fileChunks = chunkFile(content, entry.path);
        for (const fc of fileChunks) {
          if (used + fc.tokenCount > tokenBudget) break;
          fc.symbols = entry.symbols;
          chunks.push(fc);
          used += fc.tokenCount;
        }
      }
    } catch {
      // Can't read — skip
    }
  }

  return chunks;
}

function extractKeywords(prompt: string): string[] {
  // Extract meaningful words (3+ chars, not common stop words)
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "have", "are",
    "was", "not", "but", "you", "all", "can", "had", "her", "his", "has",
    "our", "out", "did", "get", "got", "how", "its", "may", "who", "why",
    "yet", "any", "been", "does", "into", "just", "much", "such", "than",
    "then", "very", "will", "also", "each", "like", "make", "more", "most",
    "over", "some", "take", "what", "when",
  ]);

  const words = prompt.toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  // Deduplicate
  return [...new Set(words)].slice(0, 30);
}
