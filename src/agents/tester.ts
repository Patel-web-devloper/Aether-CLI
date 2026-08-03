/**
 * Testing Agent — the "brain" of `aether test`.
 *
 * Takes a target path (file or directory), scans the project for context,
 * detects the test framework in use, builds a system prompt, calls the LLM,
 * and parses the response into discrete test files.
 */

import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { scanDirectory, type ProjectContext } from "../utils/scanner.js";
import { resolve, relative, dirname, basename, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ContextManager, ContextPayload } from "../context/manager.js";
import {
  Agent,
  type AgentInput,
  type AgentContext,
  type AgentOutput,
  type GeneratedFile,
} from "./base.js";

// ── public types ─────────────────────────────────────────────────────────

export type TestFramework = "vitest" | "jest" | "bun" | "mocha" | "node-test" | "unknown";

export interface TestFile {
  /** Relative file path for the test file. */
  path: string;
  /** Generated test code. */
  content: string;
  /** Language of the test code. */
  language: string;
  /** The source file this test covers, if known. */
  sourceFile?: string;
}

export interface TesterOptions {
  /** LLM provider instance (already initialised). */
  provider: LLMProvider;
  /** Model name to use. */
  model?: string;
  /** Target file or directory. */
  target: string;
  /** Override test framework detection. */
  framework?: TestFramework;
  /** Maximum tokens for the LLM response. */
  maxTokens?: number;
  /** Optional context manager for enhanced context building. */
  contextManager?: ContextManager;
}

export interface TesterResult {
  /** Parsed test files ready to write. */
  files: TestFile[];
  /** Raw LLM response (for debugging). */
  raw: string;
  /** Detected project context. */
  context: ProjectContext;
  /** Detected test framework. */
  framework: TestFramework;
  /** Test pattern detected (e.g. describe/it, test/expect). */
  testPattern: string;
  /** Project name. */
  projectName: string;
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Generate tests for a target file or directory.
 *
 * 1. Scans the target directory for project context.
 * 2. Gathers source files needing tests.
 * 3. Detects the test framework and test patterns.
 * 4. Builds a system prompt and calls the LLM.
 * 5. Parses the response into test files.
 */
export async function generateTests(
  options: TesterOptions,
): Promise<TesterResult> {
  const targetAbs = resolve(options.target);

  if (!existsSync(targetAbs)) {
    throw new Error(`Target not found: ${options.target}`);
  }

  // ── 1. Determine project root & scan ─────────────────────────────────
  const projectRoot = findProjectRoot(targetAbs);
  let context: ProjectContext;
  try {
    context = await scanDirectory(projectRoot);
  } catch {
    context = {
      root: projectRoot,
      fileTree: "(empty or new project)",
      language: "Unknown",
      framework: "None detected",
      configFiles: {},
      files: [],
    };
  }

  const projectName =
    (context.configFiles["package.json"] as Record<string, unknown>)?.name as string
    ?? basename(projectRoot);

  // ── 2. Gather source files to test ───────────────────────────────────
  const sourceFiles = gatherSourceFiles(targetAbs, context);
  if (sourceFiles.length === 0) {
    throw new Error("No testable source files found at the target.");
  }

  // ── 3. Detect test framework & pattern ────────────────────────────────
  // If explicitly provided, use it; otherwise detect from project + files
  const framework: TestFramework =
    options.framework ?? detectFramework(context, sourceFiles);

  const testPattern = frameworkPattern(framework);

  // ── 4. Read source file contents ──────────────────────────────────────
  const fileContents = await readSourceFiles(sourceFiles, projectRoot);

  // ── 5. Build system prompt ────────────────────────────────────────────
  let systemPrompt: string;
  let contextPayload: ContextPayload | null = null;

  // Try context manager for richer context
  if (options.contextManager) {
    try {
      contextPayload = await options.contextManager.buildContextPayload(
        "Generate comprehensive tests for this code",
        options.target,
      );
    } catch {
      // Fall back to basic
    }
  }

  if (contextPayload) {
    systemPrompt = buildTestSystemPromptFromPayload({
      projectName,
      language: context.language,
      framework,
      testPattern,
      payload: contextPayload,
    });
  } else {
    systemPrompt = buildTestSystemPrompt({
      projectName,
      language: context.language,
      framework,
      testPattern,
      fileContents,
    });
  }

  // ── 6. Call provider ──────────────────────────────────────────────────
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Generate comprehensive tests for the code above. Output test files using the ### FILE: format.`,
    },
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

  // ── 7. Parse response into test files ─────────────────────────────────
  const files = parseTestResponse(rawContent, sourceFiles, projectRoot);

  if (files.length === 0) {
    throw new Error(
      "Could not parse any test files from the response. " +
        "The model should use `### FILE: path/to/file.test.ts` followed by a code block.",
    );
  }

  return { files, raw: rawContent, context, framework, testPattern, projectName };
}

// ── source file gathering ─────────────────────────────────────────────────

function gatherSourceFiles(
  targetAbs: string,
  context: ProjectContext,
): string[] {
  const stat = statSync(targetAbs);

  if (stat.isFile()) {
    // Single file — check if it's a testable source file
    if (isSourceFile(targetAbs)) {
      return [relative(context.root, targetAbs)];
    }
    return [];
  }

  // Directory — filter context.files for source files under the target
  const targetRel = relative(context.root, targetAbs);
  const prefix = targetRel === "" ? "" : targetRel + "/";

  return context.files.filter((f) => {
    if (!f.startsWith(prefix)) return false;
    if (isTestFile(f)) return false;
    return isSourceFile(f);
  });
}

function isSourceFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb", ".java", ".kt"];
  return sourceExts.includes(ext) && !path.endsWith(".d.ts");
}

function isTestFile(path: string): boolean {
  const base = basename(path);
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.includes("_test.") ||
    path.includes("__tests__/") ||
    path.includes("/test/")
  );
}

// ── framework detection ────────────────────────────────────────────────────

function detectFramework(
  context: ProjectContext,
  sourceFiles: string[],
): TestFramework {
  const pkg = context.configFiles["package.json"] as Record<string, unknown> | undefined;
  const deps: Record<string, string> = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };
  const depKeys = Object.keys(deps);

  // Check package.json
  if (depKeys.includes("vitest")) return "vitest";
  if (depKeys.includes("jest")) return "jest";
  if (depKeys.includes("mocha")) return "mocha";

  // Check for bun test config / usage
  if (depKeys.includes("bun-types") || existsSync(resolve(context.root, "bunfig.toml"))) {
    return "bun";
  }

  // Check existing test files for patterns
  for (const sf of sourceFiles) {
    const testFile = inferTestPath(sf);
    const absPath = resolve(context.root, testFile);
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, "utf-8");
        if (content.includes("from \"vitest\"") || content.includes("import { describe, it, expect } from \"vitest\"")) return "vitest";
        if (content.includes("@jest/globals") || content.includes("jest.")) return "jest";
        if (content.includes("describe(") && content.includes("it(") && !content.includes("jest")) {
          if (content.includes("require(")) return "mocha";
        }
        if (content.includes("import { describe, it, expect } from \"bun:test\"")) return "bun";
        if (content.includes("import { describe, it } from \"node:test\"")) return "node-test";
      } catch {
        // unreadable — skip
      }
    }
  }

  // Check for vitest config files
  if (existsSync(resolve(context.root, "vitest.config.ts")) || existsSync(resolve(context.root, "vitest.config.js"))) {
    return "vitest";
  }
  if (existsSync(resolve(context.root, "jest.config.ts")) || existsSync(resolve(context.root, "jest.config.js"))) {
    return "jest";
  }

  // Default to bun (since Aether uses Bun)
  return "bun";
}

function frameworkPattern(framework: TestFramework): string {
  switch (framework) {
    case "vitest":
      return "describe/it/expect or test/expect (vitest globals or imports from 'vitest')";
    case "jest":
      return "describe/it/expect or test/expect (jest globals or @jest/globals)";
    case "bun":
      return "describe/it/expect using imports from 'bun:test'";
    case "mocha":
      return "describe/it with require-style imports and chai assertions";
    case "node-test":
      return "describe/it using imports from 'node:test' and 'node:assert'";
    case "unknown":
      return "describe/it/expect (choose the most appropriate pattern)";
  }
}

// ── path inference ────────────────────────────────────────────────────────

function inferTestPath(sourceFile: string): string {
  const ext = extname(sourceFile);
  const base = basename(sourceFile, ext);
  const dir = dirname(sourceFile);

  // Common patterns:
  //   src/utils.ts → src/utils.test.ts OR src/__tests__/utils.test.ts
  return `${dir === "." ? "" : dir + "/"}${base}.test${ext}`;
}

// ── file reading ──────────────────────────────────────────────────────────

async function readSourceFiles(
  sourceFiles: string[],
  root: string,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  const maxFiles = 15; // cap to avoid overwhelming the context window
  const maxSizePerFile = 3000; // chars per file

  for (const f of sourceFiles.slice(0, maxFiles)) {
    try {
      const full = resolve(root, f);
      const raw = await readFile(full, "utf-8");
      contents[f] = raw.length > maxSizePerFile
        ? raw.slice(0, maxSizePerFile) + `\n// ... (${raw.length - maxSizePerFile} more chars truncated)`
        : raw;
    } catch {
      contents[f] = "// (unable to read file)";
    }
  }

  if (sourceFiles.length > maxFiles) {
    contents["(note)"] =
      `(${sourceFiles.length - maxFiles} additional files omitted — focus tests on the files shown)`;
  }

  return contents;
}

// ── project root detection ─────────────────────────────────────────────────

function findProjectRoot(start: string): string {
  let dir = statSync(start).isDirectory() ? start : dirname(start);
  const markers = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];

  while (true) {
    for (const m of markers) {
      if (existsSync(resolve(dir, m))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return statSync(start).isDirectory() ? start : dirname(start);
}

// ── system prompt builder ──────────────────────────────────────────────────

function buildTestSystemPrompt(params: {
  projectName: string;
  language: string;
  framework: TestFramework;
  testPattern: string;
  fileContents: Record<string, string>;
}): string {
  const fileList = Object.keys(params.fileContents)
    .filter((k) => k !== "(note)")
    .map((f) => `  - ${f}`)
    .join("\n");

  const sourceBlocks = Object.entries(params.fileContents)
    .map(([path, content]) => {
      if (path === "(note)") return content;
      const lang = extname(path).slice(1) || "typescript";
      return `### ${path}\n\`\`\`${lang}\n${content}\n\`\`\``;
    })
    .join("\n\n");

  return `You are Aether, a testing expert. Generate comprehensive tests for the following code.

Project: ${params.projectName}
Language: ${params.language}
Test framework: ${params.framework}
Test pattern: ${params.testPattern}

Source files to test:
${fileList}

Source code:
${sourceBlocks}

Generate tests that cover:
- Happy path scenarios (the primary expected behavior)
- Edge cases (null, undefined, empty inputs, boundary values)
- Error handling paths (invalid inputs, thrown exceptions)
- Async behavior where applicable (promise resolution/rejection)

Output format:
For each test file, output:
### FILE: path/to/file.test.ts
\`\`\`typescript
(test code here)
\`\`\`

Guidelines:
- Match the project's existing import style and assertion patterns
- Place test files alongside source files (e.g., src/utils.ts → src/utils.test.ts)
- Include all necessary imports, mocks, and test setup
- Use the detected framework's conventions (${params.framework})
- Aim for high coverage — focus on branches, not just lines
- Write clear, descriptive test names
- Group related tests with describe blocks
- Do NOT wrap the response in explanatory text — output ONLY the ### FILE: markers and code blocks`.trim();
}

// ── response parser ────────────────────────────────────────────────────────

function parseTestResponse(
  raw: string,
  sourceFiles: string[],
  root: string,
): TestFile[] {
  const files: TestFile[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");

  const filePattern = /###\s+FILE:\s*(\S+)\s*\n\s*```(\w*)\s*\n([\s\S]*?)```/g;

  let match;
  while ((match = filePattern.exec(normalized)) !== null) {
    const rawPath = match[1].trim();
    const language = match[2] || "text";
    const content = match[3];

    let cleanPath = rawPath.replace(/^\.\//, "");
    if (cleanPath.startsWith("/") || cleanPath.includes("..")) continue;

    // Try to map to a source file
    const sourceFile = findMatchingSource(cleanPath, sourceFiles);

    files.push({
      path: cleanPath,
      content,
      language,
      sourceFile,
    });
  }

  // Fallback: if no ### FILE: markers, try bare code fences
  if (files.length === 0) {
    const bareFence = /```(\w*)\s*\n([\s\S]*?)```/g;
    let bareMatch;
    let idx = 0;
    while ((bareMatch = bareFence.exec(normalized)) !== null) {
      const lang = bareMatch[1] || "typescript";
      const content = bareMatch[2];
      const ext = langToExt(lang);
      const testFile = sourceFiles[idx] ? inferTestPath(sourceFiles[idx]) : `generated-test-${idx}.${ext}`;
      files.push({
        path: testFile,
        content,
        language: lang,
        sourceFile: sourceFiles[idx] ?? undefined,
      });
      idx++;
    }
  }

  return files;
}

function findMatchingSource(testPath: string, sourceFiles: string[]): string | undefined {
  const testBase = basename(testPath).replace(/\.(test|spec)\./, ".");
  for (const sf of sourceFiles) {
    if (basename(sf) === testBase) return sf;
  }
  return undefined;
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts", ts: "ts", tsx: "tsx",
    javascript: "js", js: "js", jsx: "jsx",
    python: "py", py: "py",
  };
  return map[lang.toLowerCase()] ?? "ts";
}

// ── TesterAgent (agent-class wrapper) ─────────────────────────────────────

/**
 * Agent-class wrapper around `generateTests`, used by the workflow
 * orchestrator. The standalone `generateTests` function is preserved for
 * the `aether test` command and backward compatibility.
 */
export class TesterAgent extends Agent {
  readonly name = "tester";
  readonly description = "Generate tests for code";
  readonly capabilities = ["test-generation"];

  async execute(input: AgentInput, context: AgentContext): Promise<AgentOutput> {
    if (context.dryRun) return this.dryRunOutput(input, context);

    const target = input.files?.[0] ?? context.targetDir;
    const result = await generateTests({
      provider: context.provider,
      model: context.model,
      target,
      framework: input.options?.framework as TestFramework | undefined,
      maxTokens: input.options?.maxTokens as number | undefined,
    });

    const files: GeneratedFile[] = result.files.map((f) => ({
      path: f.path,
      content: f.content,
      language: f.language,
    }));

    return {
      success: true,
      result: {
        framework: result.framework,
        testPattern: result.testPattern,
        fileCount: files.length,
      },
      files,
      metadata: { agent: this.name, duration: 0, modelUsed: context.model },
    };
  }
}
