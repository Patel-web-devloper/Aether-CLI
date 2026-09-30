/**
 * Tests for Phase E — CodeIndexer:
 *   1. extracts JS functions, classes, exports, imports
 *   2. extracts Python defs, classes, imports
 *   3. incoming refs resolve cross-file (who imports/uses a file's symbols)
 *   4. outgoing refs report what a file references
 *   5. findDefinition locates a symbol's definition (prefers current file)
 *   6. incremental re-index picks up changed files only
 *   7. getSymbols filters by file
 *   8. getReferences returns all references to a symbol
 *
 * Run: bun run src/tests/intelligence/indexer.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer } from "../../intelligence/indexer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cacheRoot = (tag: string) => join(tmpdir(), `aether-intel-cache-${tag}-${Date.now()}`);

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "aether-intel-proj-"));
  mkdirSync(join(dir, "src", "utils"), { recursive: true });
  mkdirSync(join(dir, "src", "ui"), { recursive: true });
  writeFileSync(join(dir, "src", "utils", "format.ts"),
    'export function formatName(name: string): string {\n  return name.toUpperCase();\n}\nexport const GREETING = "hi";\nclass Formatter { format(x: number) { return x; } }\n');
  writeFileSync(join(dir, "src", "utils", "math.ts"),
    'export function sumAll(numbers: number[]): number {\n  return numbers.reduce((a, b) => a + b, 0);\n}\n');
  writeFileSync(join(dir, "src", "ui", "display.ts"),
    'import { formatName } from "../utils/format";\nexport function render(x: string): string {\n  return formatName(x);\n}\n');
  writeFileSync(join(dir, "src", "main.ts"),
    'import { formatName } from "./utils/format";\nimport { sumAll } from "./utils/math";\nconsole.log(formatName("bob"), sumAll([1,2]));\n');
  return dir;
}

function makePyProject() {
  const dir = mkdtempSync(join(tmpdir(), "aether-intel-py-"));
  writeFileSync(join(dir, "app.py"),
    'def hello(name):\n    return "Hello " + name\n\nclass Greeter:\n    def greet(self):\n        return hello("world")\n');
  writeFileSync(join(dir, "other.py"),
    'from app import hello\nprint(hello("x"))\n');
  return dir;
}

async function testJsExtraction() {
  const dir = makeProject();
  const cache = cacheRoot("js");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const symbols = indexer.getSymbols("src/utils/format.ts");
    const names = symbols.map((s) => `${s.name}:${s.kind}`);
    assert(names.includes("formatName:function"), `formatName function missing: ${names}`);
    assert(names.includes("GREETING:variable"), `GREETING variable missing: ${names}`);
    assert(names.includes("Formatter:class"), `Formatter class missing: ${names}`);
    const fn = symbols.find((s) => s.name === "formatName");
    assert(fn?.exported === true, "formatName should be exported");
    assert(fn?.line === 1, `formatName line should be 1, got ${fn?.line}`);
    // import symbols present
    const imp = indexer.getSymbols("src/main.ts").filter((s) => s.kind === "import");
    assert(imp.length >= 2, `expected >= 2 imports in main.ts, got ${imp.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ JS functions/classes/variables/exports/imports extracted");
}

async function testPythonExtraction() {
  const dir = makePyProject();
  const cache = cacheRoot("py");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const py = indexer.getSymbols("app.py");
    const names = py.map((s) => `${s.name}:${s.kind}`);
    assert(names.includes("hello:function"), `hello missing: ${names}`);
    assert(names.includes("Greeter:class"), `Greeter missing: ${names}`);
    const hello = py.find((s) => s.name === "hello");
    assert(hello?.exported === true, "module-level def should be exported");
    const gri = py.find((s) => s.name === "greet");
    assert(gri?.kind === "function" && gri.exported === false, "method greet should be non-exported function");
    const imp = indexer.getSymbols("other.py").find((s) => s.kind === "import");
    assert(imp?.name === "hello", "expected import binding hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ Python defs/classes/imports extracted");
}

async function testIncomingRefs() {
  const dir = makeProject();
  const cache = cacheRoot("in");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const refs = indexer.getIncomingRefs("src/utils/format.ts");
    const fromFiles = [...new Set(refs.map((r) => r.fromFile))];
    assert(fromFiles.includes("src/main.ts"), `main.ts should reference format.ts: ${fromFiles}`);
    assert(fromFiles.includes("src/ui/display.ts"), `display.ts should reference format.ts: ${fromFiles}`);
    assert(!fromFiles.includes("src/utils/math.ts"), "math.ts should NOT reference format.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ incoming refs resolve cross-file");
}

async function testOutgoingRefs() {
  const dir = makeProject();
  const cache = cacheRoot("out");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const refs = indexer.getOutgoingRefs("src/main.ts");
    const toSymbols = [...new Set(refs.map((r) => r.toSymbol))];
    assert(toSymbols.includes("formatName"), `formatName missing: ${toSymbols}`);
    assert(toSymbols.includes("sumAll"), `sumAll missing: ${toSymbols}`);
    const sumRef = refs.find((r) => r.toSymbol === "sumAll");
    assert(sumRef?.toFile === "src/utils/math.ts", `sumAll should resolve to math.ts, got ${sumRef?.toFile}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ outgoing refs report what a file references");
}

async function testFindDefinition() {
  const dir = makeProject();
  const cache = cacheRoot("def");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const def = indexer.findDefinition("formatName", "src/main.ts");
    assert(def?.file === "src/utils/format.ts", `should resolve to format.ts, got ${def?.file}`);
    assert(def?.kind === "function", `kind should be function, got ${def?.kind}`);
    assert(def?.line === 1, `line should be 1, got ${def?.line}`);
    const missing = indexer.findDefinition("doesNotExist", "src/main.ts");
    assert(missing === null, "missing symbol should return null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ findDefinition locates a symbol's definition");
}

async function testIncrementalReindex() {
  const dir = makeProject();
  const cache = cacheRoot("incr");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const before = indexer.getAllSymbols().length;
    assert(before > 0, "expected symbols before reindex");

    // Modify main.ts to drop the sumAll usage, then re-index.
    writeFileSync(join(dir, "src", "main.ts"),
      'import { formatName } from "./utils/format";\nconsole.log(formatName("bob"));\n');
    await indexer.indexProject(dir);

    const refs = indexer.getReferences("sumAll");
    assert(refs.length === 0, `sumAll should have no refs after edit, got ${refs.length}`);
    const sumSym = indexer.getAllSymbols().find((s) => s.name === "sumAll" && s.file !== "src/main.ts");
    assert(sumSym?.exported === true, "sumAll definition should still be indexed");
    assert(indexer.getIncomingRefs("src/utils/math.ts").length === 0, "math.ts should now have no incoming refs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ incremental re-index updates refs after file change");
}

async function testGetSymbolsFiltersByFile() {
  const dir = makeProject();
  const cache = cacheRoot("filter");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const math = indexer.getSymbols("src/utils/math.ts");
    assert(math.length === 1, `expected just sumAll, got ${math.map((s) => s.name)}`);
    assert(math[0].name === "sumAll", `expected sumAll, got ${math[0].name}`);
    const all = indexer.getSymbols("");
    assert(all.length === indexer.getAllSymbols().length, "getSymbols('') should return all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ getSymbols filters by file / returns all");
}

async function testGetReferences() {
  const dir = makeProject();
  const cache = cacheRoot("getrefs");
  try {
    const indexer = new CodeIndexer(cache);
    await indexer.indexProject(dir);
    const refs = indexer.getReferences("formatName");
    const fromFiles = new Set(refs.map((r) => r.fromFile));
    assert(fromFiles.has("src/main.ts"), "main.ts should reference formatName");
    assert(fromFiles.has("src/ui/display.ts"), "display.ts should reference formatName");
    assert(refs.every((r) => r.toFile === "src/utils/format.ts"), "all formatName refs should target format.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  console.log("  ✓ getReferences returns all references to a symbol");
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Aether CLI — CodeIndexer Tests          ║");
  console.log("╚══════════════════════════════════════════╝\n");
  const tests: Array<() => Promise<void>> = [
    testJsExtraction,
    testPythonExtraction,
    testIncomingRefs,
    testOutgoingRefs,
    testFindDefinition,
    testIncrementalReindex,
    testGetSymbolsFiltersByFile,
    testGetReferences,
  ];
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err: unknown) {
      failed++;
      console.error(`  ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
