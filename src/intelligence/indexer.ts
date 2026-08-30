/**
 * Code Intelligence — CodeIndexer.
 *
 * A lightweight, heuristic source-code indexer that parses a project into
 * symbols (functions, classes, methods, variables, exports, imports) and
 * references (which file uses which symbol). It is NOT a compiler-level
 * parser — it uses regex/string scanning to hit ~90% accuracy across JS/TS
 * (high) and Python (basic), with a generic fallback for other languages.
 *
 * Indexes are cached as JSON under `~/.aether-cli/intelligence/<projectHash>/`
 * and re-parsed incrementally (only files whose content changed).
 */

import { readdir, readFile, stat, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, extname, posix } from "node:path";

// ── types ────────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "export"
  | "import";

export interface Symbol {
  name: string;
  kind: SymbolKind;
  file: string; // relative path
  line: number;
  exported: boolean;
}

export interface Reference {
  fromFile: string;
  fromLine: number;
  toSymbol: string;
  toFile?: string; // resolved import target / defining file (when known)
}

export interface SymbolIndex {
  projectHash: string;
  rootDir: string;
  generatedAt: number;
  symbols: Symbol[];
  references: Reference[];
  /** file -> sha256 content hash, for incremental re-indexing. */
  fileStates: Record<string, string>;
}

/** Directories never indexed (deps, build output, vcs). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo",
  "__pycache__", ".venv", "venv", ".cache", ".vscode", ".idea", ".aether-cli",
  "vendor", "target", ".pytest_cache", ".mypy_cache",
]);

/** File extensions we index. */
const INDEXED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".rb", ".java", ".kt", ".swift", ".c", ".cpp", ".h",
  ".cs", ".php", ".sh",
]);

const MAX_FILE_BYTES = 500_000;

const JS_LIKE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// ── helpers ──────────────────────────────────────────────────────────────

function projectHash(rootDir: string): string {
  return createHash("sha256").update(resolve(rootDir)).digest("hex").slice(0, 16);
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function norm(path: string): string {
  return path.split("\\").join("/");
}

function languageOf(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".py") return "python";
  if (JS_LIKE.has(ext)) return "js";
  return "other";
}

// ── parsing ──────────────────────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "return", "new",
  "typeof", "instanceof", "in", "of", "void", "delete", "throw", "try",
  "catch", "finally", "await", "yield", "this", "super", "function", "class",
  "const", "let", "var", "import", "export", "from", "as", "async", "extends",
  "implements", "interface", "type", "enum", "namespace", "default", "static",
  "get", "set", "readonly", "public", "private", "protected",
]);

/**
 * Parse a block of text keeping only identifier tokens (strings & line
 * comments removed). Returns a list of { token, line } (1-based).
 */
function tokenize(content: string): Array<{ token: string; line: number }> {
  const tokens: Array<{ token: string; line: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // strip string literals (single/double/template)
    line = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, " ");
    // strip line comments (but not inside URLs — accept the approximation)
    line = line.replace(/\/\/.*$/, " ");
    // strip block comments spanning single line
    line = line.replace(/\/\*[\s\S]*?\*\//g, " ");
    const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      tokens.push({ token: m[0], line: i + 1 });
    }
  }
  return tokens;
}

/** Guess a `toFile` (relative) for a JS/TS import specifier from `file`. */
function resolveJsImport(rootDir: string, file: string, spec: string): string | undefined {
  spec = spec.trim();
  if (!spec.startsWith(".")) return undefined; // bare/alias/package import
  const base = posix.dirname(file);
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
  let joined = posix.normalize(posix.join(base, spec));
  if (joined.startsWith("../")) return undefined; // escapes project root
  if (joined === "." || joined === "..") return undefined;
  const candidates: string[] = [joined];
  for (const e of exts) candidates.push(joined + e);
  candidates.push(posix.join(joined, "index.ts"));
  candidates.push(posix.join(joined, "index.js"));
  for (const c of candidates) {
    if (c.includes("..")) continue;
    if (existsSync(resolve(rootDir, c))) return c;
  }
  return undefined;
}

/** Resolve a Python `from a.b import x` / `import a.b` to a relative file. */
function resolvePyImport(mod: string): string | undefined {
  const clean = mod.replace(/^\.+/, "").split(".").join("/");
  if (!clean) return undefined;
  return clean + ".py";
}

interface ParsedFile {
  symbols: Symbol[];
  refs: Reference[];
  /** name -> declaration lines, to avoid counting the declaration itself as a use. */
  declLines: Map<string, Set<number>>;
}

function collectDeclaration(
  symbols: Symbol[],
  declLines: Map<string, Set<number>>,
  file: string,
  line: number,
  name: string,
  kind: SymbolKind,
  exported: boolean,
): void {
  if (!name) return;
  symbols.push({ name, kind, file, line, exported });
  if (!declLines.has(name)) declLines.set(name, new Set());
  declLines.get(name)!.add(line);
}

/**
 * Parse JavaScript/TypeScript into symbols + references.
 * The import/reference pass resolves `toFile` where possible; a usage pass
 * additionally records references via global symbol-name matching.
 */
function parseJsTs(file: string, content: string, exportedNames: Map<string, string>, rootDir: string): ParsedFile {
  const symbols: Symbol[] = [];
  const refs: Reference[] = [];
  const declLines = new Map<string, Set<number>>();
  const lines = content.split("\n");

  // ── imports ──
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("import{")) continue;
    // import "path"
    let m = trimmed.match(/^import\s+["']([^"']+)["']/);
    if (m) {
      // side-effect import, no binding
      continue;
    }
    // namespace: import * as ns from "x"
    m = trimmed.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/);
    if (m) {
      const name = m[1];
      collectDeclaration(symbols, declLines, file, lineNo, name, "import", false);
      refs.push({ fromFile: file, fromLine: lineNo, toSymbol: name });
      continue;
    }
    // named/destructured + default: import X, { a, b as c } from "x" | import { a, b } from "x" | import X from "x"
    const specM = trimmed.match(/^import\s+(.+)\s+from\s+["']([^"']+)["']/);
    if (specM) {
      const target = resolveJsImport(rootDir, file, specM[2]);
      const localNames = extractImportBindings(specM[1]);
      for (const n of localNames) {
        collectDeclaration(symbols, declLines, file, lineNo, n, "import", false);
        refs.push({ fromFile: file, fromLine: lineNo, toSymbol: n, toFile: target });
      }
    }
  }

  // ── declarations ──
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("import")) continue;

    let exported = false;
    let decl = trimmed;
    if (decl.startsWith("export ")) {
      exported = true;
      decl = decl.slice("export ".length).trim();
    } else if (decl.startsWith("export{")) {
      // export { A, B as C }   — re-export/expose existing names
      const em = decl.match(/^export\{\s*([^}]+)\s*\}/);
      if (em) {
        for (const part of em[1].split(",")) {
          const raw = part.trim();
          if (!raw) continue;
          const nm = raw.split(/\s+as\s+/)[0].trim();
          collectDeclaration(symbols, declLines, file, lineNo, nm, "export", true);
        }
      }
      continue;
    }

    // export default function/class NAME? OR `export default <expr>`
    let name: string | undefined;
    let kind: SymbolKind = "function";

    let fm = decl.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (fm) { name = fm[1]; kind = "function"; }
    else if ((fm = decl.match(/^class\s+([A-Za-z_$][\w$]*)/))) { name = fm[1]; kind = "class"; }
    else if ((fm = decl.match(/^interface\s+([A-Za-z_$][\w$]*)/))) { name = fm[1]; kind = "class"; }
    else if ((fm = decl.match(/^(?:async\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/))) { name = fm[1]; kind = "variable"; }
    else if ((fm = decl.match(/^(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) { name = fm[1]; kind = "variable"; }
    else if ((fm = decl.match(/^(?:type)\s+([A-Za-z_$][\w$]*)/))) { name = fm[1]; kind = "export"; }
    else if ((fm = decl.match(/^(?:enum)\s+([A-Za-z_$][\w$]*)/))) { name = fm[1]; kind = "class"; }
    else if ((fm = decl.match(/^(?:default)\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/))) { name = fm[1]; kind = fm[0].includes("class") ? "class" : "function"; }
    else if (decl.startsWith("default ")) { name = "default"; kind = "export"; }

    // method detection (indented `name(args) {` inside class/object)
    if (!name && /^\s{2,}/.test(line) && !exported) {
      const mm = trimmed.match(/^([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
      if (mm && !JS_KEYWORDS.has(mm[1])) { name = mm[1]; kind = "method"; }
    }

    if (name) {
      collectDeclaration(symbols, declLines, file, lineNo, name, kind, exported);
    }
  }

  // ── usage references (cross-file + intra-file) ──
  const localByLine: Map<string, Set<number>> = new Map();
  for (const s of symbols) {
    const d = declLines.get(s.name);
    if (d) localByLine.set(s.name, d);
  }
  for (const { token, line } of tokenize(content)) {
    if (JS_KEYWORDS.has(token)) continue;
    // cross-file: token is an exported symbol defined elsewhere
    const defFile = exportedNames.get(token);
    if (defFile && defFile !== file) {
      const dl = localByLine.get(token);
      if (dl && dl.has(line)) continue; // it's a declared use, skip
      refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: defFile });
      continue;
    }
    // intra-file: token is a local symbol used on a different line
    const dl = localByLine.get(token);
    if (dl && dl.size > 0) {
      if (dl.has(line)) continue;
      refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: file });
    }
  }

  return { symbols, refs, declLines };
}

/**
 * Parse Python into symbols + references.
 */
function parsePython(file: string, content: string, exportedNames: Map<string, string>): ParsedFile {
  const symbols: Symbol[] = [];
  const refs: Reference[] = [];
  const declLines = new Map<string, Set<number>>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.replace(/^[ \t]+/, "").length;
    const topLevel = indent === 0;

    // import / from ... import
    let m = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
    if (m) {
      const target = resolvePyImport(m[1]);
      const names = m[2].split(",").map((s) => s.split(/\s+as\s+/)[0].trim()).filter(Boolean);
      for (const n of names) {
        collectDeclaration(symbols, declLines, file, lineNo, n, "import", topLevel);
        refs.push({ fromFile: file, fromLine: lineNo, toSymbol: n, toFile: target });
      }
      continue;
    }
    m = trimmed.match(/^import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(",")) {
        const spec = part.trim();
        const name = spec.split(".")[0].split(/\s+as\s+/)[0];
        if (!name) continue;
        collectDeclaration(symbols, declLines, file, lineNo, name, "import", topLevel);
        refs.push({ fromFile: file, fromLine: lineNo, toSymbol: name, toFile: resolvePyImport(spec) });
      }
      continue;
    }

    // def / class
    m = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    if (m) { collectDeclaration(symbols, declLines, file, lineNo, m[1], "function", topLevel); continue; }
    m = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (m) { collectDeclaration(symbols, declLines, file, lineNo, m[1], "class", topLevel); continue; }
    // module-level assignment is a variable
    m = trimmed.match(/^([A-Za-z_]\w*)\s*=/);
    if (m && topLevel) { collectDeclaration(symbols, declLines, file, lineNo, m[1], "variable", true); }
  }

  // usage pass
  for (const { token, line } of tokenize(content)) {
    if (token.startsWith("_") && token.length === 1) continue;
    const dl = declLines.get(token);
    if (dl) { if (!dl.has(line)) refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: file }); continue; }
    const defFile = exportedNames.get(token);
    if (defFile && defFile !== file) {
      refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: defFile });
    }
  }

  return { symbols, refs, declLines };
}

/**
 * Generic parser for other languages (Go, Rust, Ruby, Java, C, ...).
 */
function parseOther(file: string, content: string, exportedNames: Map<string, string>): ParsedFile {
  const symbols: Symbol[] = [];
  const refs: Reference[] = [];
  const declLines = new Map<string, Set<number>>();
  const lines = content.split("\n");
  const ext = extname(file);

  const patterns: Array<{ re: RegExp; kind: SymbolKind }> = [
    // Go
    { re: /^func\s+\([^)]*\)\s+([A-Z]\w*)/, kind: "function" },
    { re: /^func\s+([A-Z]\w*)/, kind: "function" },
    { re: /^type\s+([A-Z]\w*)/, kind: "class" },
    // Rust
    { re: /^(?:pub\s+)?fn\s+(\w+)/, kind: "function" },
    { re: /^(?:pub\s+)?struct\s+(\w+)/, kind: "class" },
    { re: /^(?:pub\s+)?enum\s+(\w+)/, kind: "class" },
    // Ruby
    { re: /^(?:def\s+self\.)?def\s+(\w+)/, kind: "function" },
    { re: /^class\s+(\w+)/, kind: "class" },
    { re: /^module\s+(\w+)/, kind: "class" },
    // Java / C# / C / C++
    { re: /^\s*(?:public|private|protected|static|final|abstract|native|synchronized|virtual|override|const|unsigned|inline|extern)?\s*(?:class|interface)\s+(\w+)/, kind: "class" },
    { re: /^\s*(?:public|private|protected|static|final|synchronized|virtual|override)?\s*(?:[\w<>[\],. ]+)\s+(\w+)\s*\([^)]*\)\s*\{/, kind: "function" },
    { re: /^\w+\s+(\w+)\s*\([^)]*\)\s*\{/, kind: "function" },
    // PHP
    { re: /^(?:public|private|protected)\s+function\s+(\w+)/, kind: "method" },
    { re: /^function\s+(\w+)/, kind: "function" },
    // Shell
    { re: /^([a-zA-Z_]\w*)\s*\(\)\s*\{/, kind: "function" },
  ];

  const wanted = ext === ".py" ? [] : patterns;
  void wanted;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (/^\S/.test(line) === false && ext === ".sh") { /* shell funcs typically top-level */ }
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const exported = ext === ".go" || (ext === ".rs" && line.includes("pub")) ||
          (ext === ".java" && /(public|protected)/.test(line));
        collectDeclaration(symbols, declLines, file, lineNo, m[1], p.kind, exported);
        break; // one match per line is enough
      }
    }
  }

  for (const { token, line } of tokenize(content)) {
    const dl = declLines.get(token);
    if (dl) { if (!dl.has(line)) refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: file }); continue; }
    const defFile = exportedNames.get(token);
    if (defFile && defFile !== file) refs.push({ fromFile: file, fromLine: line, toSymbol: token, toFile: defFile });
  }

  return { symbols, refs, declLines };
}

function extractImportBindings(head: string): string[] {
  const out: string[] = [];
  // default binding can start with an identifier before `{`
  const brace = head.match(/\{([^}]*)\}/);
  if (brace) {
    for (const part of brace[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      out.push(p.split(/\s+as\s+/)[0].trim());
    }
  }
  // default binding (identifier not inside braces, before `{` or alone)
  const stripped = head.replace(/\{[^}]*\}/, "").trim();
  if (stripped) {
    const first = stripped.split(/[,\s]+/).find((s) => s && s !== "default");
    if (first) out.unshift(first);
  }
  return out;
}

// ── CodeIndexer ──────────────────────────────────────────────────────────

export class CodeIndexer {
  readonly basePath: string;
  private index: SymbolIndex = this.emptyIndex("", "");

  constructor(basePath = join(process.env.HOME || process.env.USERPROFILE || ".", ".aether-cli", "intelligence")) {
    this.basePath = resolve(basePath);
  }

  private emptyIndex(rootDir: string, hash: string): SymbolIndex {
    return { projectHash: hash, rootDir, generatedAt: 0, symbols: [], references: [], fileStates: {} };
  }

  private projectDir(rootDir: string): string {
    return join(this.basePath, projectHash(rootDir));
  }
  private indexPath(rootDir: string): string {
    return join(this.projectDir(rootDir), "index.json");
  }

  /** Does a cached index exist on disk for this project? */
  hasIndex(rootDir: string): boolean {
    return existsSync(this.indexPath(rootDir));
  }

  /**
   * Return the symbol index for a project, loading it from cache when the
   * in-memory index corresponds to a different project.
   */
  async getIndex(rootDir: string): Promise<SymbolIndex> {
    if (this.index.rootDir !== resolve(rootDir)) {
      await this.load(rootDir);
    }
    return this.index;
  }

  /** The currently loaded in-memory index. */
  getLoadedIndex(): SymbolIndex {
    return this.index;
  }

  /** Load the cached index for a project into memory (no-op if none). */
  async load(rootDir: string): Promise<boolean> {
    try {
      const raw = await readFile(this.indexPath(rootDir), "utf8");
      this.index = JSON.parse(raw) as SymbolIndex;
      return true;
    } catch {
      return false;
    }
  }

  /** Full or incremental index of a project directory. */
  async indexProject(rootDir: string): Promise<SymbolIndex> {
    resolve(rootDir);
    const hash = projectHash(rootDir);
    const hadCache = await this.load(rootDir);

    if (!hadCache || this.index.rootDir !== resolve(rootDir)) {
      this.index = this.emptyIndex(resolve(rootDir), hash);
    }

    const files = await this.collectFiles(rootDir);
    const changed: string[] = [];
    const removed: string[] = [];

    for (const rel of files) {
      const abs = resolve(rootDir, rel);
      let content: string;
      let digest: string;
      try {
        const st = await stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        content = await readFile(abs, "utf8");
        digest = sha(content);
      } catch {
        continue;
      }
      if (this.index.fileStates[rel] === digest) continue; // unchanged
      changed.push(rel);
      this.index.fileStates[rel] = digest;
    }

    for (const rel of Object.keys(this.index.fileStates)) {
      if (!files.includes(rel)) removed.push(rel);
    }

    if (changed.length === 0 && removed.length === 0) {
      // nothing to do — still persist the (possibly fresh empty) index
      await this.save(rootDir);
      return this.index;
    }

    for (const rel of removed) delete this.index.fileStates[rel];

    // Two-phase parse so cross-file usage references resolve correctly even
    // when file contents change. Phase A collects every symbol (exported map);
    // Phase B recomputes references against the complete exported map.
    const EMPTY = new Map<string, string>();
    const finalSymbols: Symbol[] = [];
    const exportedNames = new Map<string, string>();
    for (const rel of files) {
      const parsed = await this.parseFile(rootDir, rel, EMPTY);
      if (!parsed) continue;
      finalSymbols.push(...parsed.symbols);
    }
    for (const s of finalSymbols) if (s.exported) exportedNames.set(s.name, s.file);

    const finalRefs: Reference[] = [];
    for (const rel of files) {
      const parsed = await this.parseFile(rootDir, rel, exportedNames);
      if (!parsed) continue;
      finalRefs.push(...parsed.refs);
    }

    this.index.symbols = finalSymbols;
    this.index.references = finalRefs;
    this.index.generatedAt = Date.now();
    await this.save(rootDir);
    return this.index;
  }

  /** Re-index specific files (used by auto-index on agent:done). */
  async updateFiles(rootDir: string, files: string[]): Promise<void> {
    resolve(rootDir);
    await this.load(rootDir);
    if (this.index.rootDir && this.index.rootDir !== resolve(rootDir)) {
      this.index = this.emptyIndex(resolve(rootDir), projectHash(rootDir));
    }
    if (!this.index.rootDir) this.index.rootDir = resolve(rootDir);
    let touched = false;
    for (const rel of files) {
      const abs = resolve(rootDir, rel);
      try {
        const content = await readFile(abs, "utf8");
        const digest = sha(content);
        if (this.index.fileStates[rel] === digest) continue;
        this.index.fileStates[rel] = digest;
        touched = true;
      } catch {
        // file no longer exists — drop from index
        if (this.index.fileStates[rel] !== undefined) { delete this.index.fileStates[rel]; touched = true; }
      }
    }
    if (!touched) return;
    await this.indexProject(rootDir);
  }

  private async parseFile(rootDir: string, rel: string, exportedNames: Map<string, string>): Promise<ParsedFile | null> {
    let content: string;
    try {
      content = await readFile(resolve(rootDir, rel), "utf8");
    } catch { return null; }
    const ext = extname(rel).toLowerCase();
    if (!INDEXED_EXTS.has(ext)) return null;

    const lang = languageOf(rel);
    if (lang === "js") return parseJsTs(norm(rel), content, exportedNames, rootDir);
    if (lang === "python") return parsePython(norm(rel), content, exportedNames);
    return parseOther(norm(rel), content, exportedNames);
  }

  private async collectFiles(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    const stack = [""];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const abs = resolve(rootDir, dir);
      let entries;
      try { entries = await readdir(abs, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const rel = posix.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          stack.push(rel);
        } else if (entry.isFile()) {
          if (INDEXED_EXTS.has(extname(entry.name).toLowerCase())) out.push(rel);
        }
      }
    }
    return out.sort();
  }

  private async save(rootDir: string): Promise<void> {
    await mkdir(this.projectDir(rootDir), { recursive: true });
    await writeFile(this.indexPath(rootDir), JSON.stringify(this.index, null, 2) + "\n", "utf8");
  }

  /** Delete the on-disk index for a project. */
  async clear(rootDir: string): Promise<void> {
    await rm(this.projectDir(rootDir), { recursive: true, force: true });
  }

  // ── query API ──────────────────────────────────────────────────────────

  private symbolsInFile(file: string): Symbol[] {
    return this.index.symbols.filter((s) => s.file === file);
  }

  getSymbols(file: string): Symbol[] {
    if (file) return this.symbolsInFile(file);
    return this.index.symbols;
  }

  getAllSymbols(): Symbol[] {
    return this.index.symbols;
  }

  getReferences(symbolName: string): Reference[] {
    return this.index.references.filter((r) => r.toSymbol === symbolName);
  }

  /** Who references stuff in this file? */
  getIncomingRefs(file: string): Reference[] {
    const f = norm(file);
    return this.index.references.filter((r) => r.toFile === f || r.toFile === f.replace(/\.[^.]+$/, ""));
  }

  /** What this file references. */
  getOutgoingRefs(file: string): Reference[] {
    const f = norm(file);
    return this.index.references.filter((r) => r.fromFile === f);
  }

  /** Find the definition of a symbol, preferring one in `currentFile`. */
  findDefinition(symbolName: string, currentFile: string): Symbol | null {
    const defs = this.index.symbols.filter(
      (s) => s.name === symbolName && s.kind !== "import" && s.kind !== "variable",
    );
    if (defs.length === 0) return null;
    const local = defs.find((s) => s.file === currentFile);
    return local ?? defs[0];
  }
}
