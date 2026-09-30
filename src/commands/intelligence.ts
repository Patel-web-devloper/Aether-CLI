/**
 * `aether intelligence` — code-intelligence commands.
 *
 * Wire into cli.ts via `program.addCommand(buildIntelligenceCommand(container))`.
 * Uses the registered CodeIndexer; never imports the providerRegistry singleton.
 */

import chalk from "chalk";
import { Command } from "commander";
import { resolve } from "node:path";
import type { ServiceContainer } from "../core/container.js";
import { CodeIndexer, type SymbolKind } from "../intelligence/indexer.js";
import { generateRepoMap } from "../intelligence/repo-map.js";

const VALID_KINDS = new Set(["function", "class", "method", "variable", "export", "import"]);

export function buildIntelligenceCommand(container: ServiceContainer): Command {
  const cmd = new Command("intelligence").description("Code intelligence: index code, search symbols & references");

  cmd
    .command("index")
    .description("Index the project (parse all source files into symbols/references)")
    .option("-t, --target <dir>", "Project root", process.cwd())
    .option("-c, --cache <dir>", "Override index cache directory")
    .action(async (options: { target: string; cache?: string }) => {
      try {
        const indexer = getIndexer(container, options.cache);
        const root = resolve(options.target);
        const spinner = "Indexing project…";
        console.log(chalk.cyan(spinner));
        const before = Date.now();
        const index = await indexer.indexProject(root);
        const ms = Date.now() - before;
        const symbolCount = index.symbols.length;
        const fileCount = new Set(index.symbols.map((s) => s.file)).size;
        console.log(chalk.green(`✓ Indexed ${fileCount} files, ${symbolCount} symbols, ${index.references.length} references (${ms}ms)`));
        console.log(chalk.gray(`  Project: ${root}`));
      } catch (err) {
        console.error(chalk.red("Index error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("symbols")
    .description("List symbols in a file, or all files when no file is given")
    .argument("[file]", "File to list symbols for")
    .option("-t, --target <dir>", "Project root", process.cwd())
    .option("-k, --kind <type>", "Filter by kind: function, class, method, variable, export, import")
    .option("-j, --json", "Output as JSON", false)
    .option("-c, --cache <dir>", "Override index cache directory")
    .action(async (file: string | undefined, options: { target: string; kind?: string; json: boolean; cache?: string }) => {
      const indexer = getIndexer(container, options.cache);
      const root = resolve(options.target);
      if (!indexer.hasIndex(root)) {
        console.error(chalk.yellow("Project not indexed yet. Run `aether intelligence index` first."));
        return;
      }
      if (options.kind && !VALID_KINDS.has(options.kind)) {
        console.error(chalk.red(`Invalid kind "${options.kind}". Valid: ${[...VALID_KINDS].join(", ")}`));
        process.exit(1);
      }
      const index = await indexer.getIndex(root);
      let symbols = file ? indexer.getSymbols(file) : index.symbols;
      if (options.kind) symbols = symbols.filter((s) => s.kind === (options.kind as SymbolKind));
      symbols = symbols.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

      if (options.json) {
        console.log(JSON.stringify(symbols, null, 2));
        return;
      }
      if (symbols.length === 0) {
        console.log(chalk.dim("No symbols found."));
        return;
      }
      for (const s of symbols) {
        const exported = s.exported ? chalk.green("export ") : "";
        console.log(`  ${chalk.cyan(s.file)}:${s.line}  ${exported}${chalk.bold(s.kind)} ${s.name}`);
      }
    });

  cmd
    .command("refs")
    .description("Find all references to a symbol")
    .argument("<symbol>", "Symbol name to search for")
    .option("-t, --target <dir>", "Project root", process.cwd())
    .option("-j, --json", "Output as JSON", false)
    .option("-c, --cache <dir>", "Override index cache directory")
    .action(async (symbol: string, options: { target: string; json: boolean; cache?: string }) => {
      const indexer = getIndexer(container, options.cache);
      const root = resolve(options.target);
      if (!indexer.hasIndex(root)) {
        console.error(chalk.yellow("Project not indexed yet. Run `aether intelligence index` first."));
        return;
      }
      await indexer.getIndex(root); // load into memory before querying
      const refs = indexer.getReferences(symbol);
      if (options.json) {
        console.log(JSON.stringify(refs, null, 2));
        return;
      }
      if (refs.length === 0) {
        console.log(chalk.dim(`No references to "${symbol}".`));
        return;
      }
      console.log(chalk.cyan(`References to ${symbol}:`));
      for (const r of refs) {
        console.log(`  ${chalk.cyan(r.fromFile)}:${r.fromLine}  → ${r.toSymbol}${r.toFile ? ` (in ${r.toFile})` : ""}`);
      }
    });

  cmd
    .command("map")
    .description("Print the repo map")
    .option("-t, --target <dir>", "Project root", process.cwd())
    .option("-d, --depth <n>", "Max directory depth", "5")
    .option("-c, --cache <dir>", "Override index cache directory")
    .action(async (options: { target: string; depth: string; cache?: string }) => {
      const indexer = getIndexer(container, options.cache);
      const root = resolve(options.target);
      if (!indexer.hasIndex(root)) {
        console.error(chalk.yellow("Project not indexed yet. Run `aether intelligence index` first."));
        return;
      }
      const depth = Math.max(0, parseInt(options.depth, 10) || 5);
      const index = await indexer.getIndex(root);
      console.log(generateRepoMap(index, root, depth));
    });

  return cmd;
}

function getIndexer(container: ServiceContainer, cacheOverride?: string): CodeIndexer {
  if (cacheOverride) return new CodeIndexer(resolve(cacheOverride));
  try {
    return container.get<CodeIndexer>("codeIndexer");
  } catch {
    // Fall back to a default on-disk indexer (cwd-scoped) so the command still works standalone.
    return new CodeIndexer();
  }
}
