/**
 * Repo Map — generate a structured text map of a project from a SymbolIndex.
 *
 * Used in prompts for context and by `aether context` / `aether intelligence map`.
 */

import type { SymbolIndex, SymbolKind } from "./indexer.js";

/** Kinds shown inline next to a file (imports/variables are noise). */
const VISIBLE_KINDS: ReadonlySet<SymbolKind> = new Set(["function", "class", "method", "export"]);

interface DirNode {
  name: string;
  dirs: Map<string, DirNode>;
  files: string[]; // basenames
}

function collectSymbolNames(index: SymbolIndex, file: string): string[] {
  const names = new Map<string, string>(); // name -> kind (first wins)
  for (const s of index.symbols) {
    if (s.file !== file) continue;
    if (!VISIBLE_KINDS.has(s.kind)) continue;
    if (!names.has(s.name)) names.set(s.name, s.kind);
  }
  return Array.from(names.keys()).sort();
}

function buildTree(index: SymbolIndex, rootDir: string): DirNode {
  const root: DirNode = { name: "", dirs: new Map(), files: [] };
  const relRoot = rootDir.replace(/[\\/]+$/, "");
  for (const s of index.symbols) {
    let file = s.file;
    if (rootDir && file.startsWith(relRoot + "/")) file = file.slice(relRoot.length + 1);
    const parts = file.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const filename = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);
    let node = root;
    for (const d of dirs) {
      if (!node.dirs.has(d)) node.dirs.set(d, { name: d, dirs: new Map(), files: [] });
      node = node.dirs.get(d)!;
    }
    if (!node.files.includes(filename)) node.files.push(filename);
  }
  for (const node of visitAll(root)) node.files.sort();
  return root;
}

function* visitAll(node: DirNode): Generator<DirNode> {
  yield node;
  for (const child of node.dirs.values()) yield* visitAll(child);
}

function render(
  node: DirNode,
  index: SymbolIndex,
  maxDepth: number,
  lines: string[],
  path = "",
): void {
  const indent = "  ".repeat(path === "" ? 0 : path.split("/").length);
  if (node.name) lines.push(`${indent}${node.name}/`);
  for (const filename of node.files) {
    const full = path ? `${path}/${filename}` : filename;
    const symbols = collectSymbolNames(index, full);
    const suffix = symbols.length > 0 ? ` → ${symbols.join(", ")}` : "";
    lines.push(`${indent}  ${filename}${suffix}`);
  }
  const depth = path === "" ? 0 : path.split("/").length;
  if (depth >= maxDepth) {
    if (node.dirs.size > 0) {
      const count = node.dirs.size;
      lines.push(`${indent}  ... (${count} subdirector${count === 1 ? "y" : "ies"} below max depth)`);
    }
    return;
  }
  const dirs = Array.from(node.dirs.keys()).sort().map((d) => node.dirs.get(d)!);
  for (const child of dirs) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    render(child, index, maxDepth, lines, childPath);
  }
}

/**
 * Generate a structured text repo map. Directories are grouped; each file lists
 * its exported functions/classes/methods. `maxDepth` limits directory nesting.
 */
export function generateRepoMap(
  index: SymbolIndex,
  _rootDir: string,
  maxDepth = 5,
): string {
  const root = buildTree(index, _rootDir);
  const lines: string[] = [];
  render(root, index, maxDepth, lines);
  return lines.join("\n");
}
