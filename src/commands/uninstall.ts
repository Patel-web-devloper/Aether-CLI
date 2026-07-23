/**
 * Aether uninstall — remove Aether CLI from the system.
 *
 * Usage: aether uninstall [--keep-config] [--dry-run]
 */

import { existsSync, rmSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";

const INSTALL_DIR = resolve(import.meta.dirname ?? process.cwd(), "../..");

export interface UninstallOptions {
  keepConfig?: boolean;
  dryRun?: boolean;
}

interface RemovalItem {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  exists: boolean;
}

async function collectRemovalItems(options: UninstallOptions): Promise<RemovalItem[]> {
  const items: RemovalItem[] = [];

  // Symlink in /usr/local/bin
  const linkTarget = "/usr/local/bin/aether";
  items.push({
    path: linkTarget,
    type: "symlink",
    exists: (() => { try { statSync(linkTarget); return true; } catch { return false; } })(),
  });

  // Install directory
  items.push({
    path: INSTALL_DIR,
    type: "directory",
    exists: existsSync(INSTALL_DIR),
    size: getDirSize(INSTALL_DIR),
  });

  // Config dir
  if (!options.keepConfig) {
    const configDir = resolve(process.env.HOME ?? "/root", ".config/aether");
    items.push({
      path: configDir,
      type: "directory",
      exists: existsSync(configDir),
      size: getDirSize(configDir),
    });
  }

  // Cache dir
  const cacheDir = resolve(process.env.HOME ?? "/root", ".cache/aether");
  items.push({
    path: cacheDir,
    type: "directory",
    exists: existsSync(cacheDir),
    size: getDirSize(cacheDir),
  });

  // Data dir
  const dataDir = resolve(process.env.HOME ?? "/root", ".local/share/aether");
  items.push({
    path: dataDir,
    type: "directory",
    exists: existsSync(dataDir),
    size: getDirSize(dataDir),
  });

  return items;
}

function getDirSize(dir: string): number {
  try {
    let total = 0;

    function walk(d: string): void {
      try {
        for (const entry of readdirSync(d)) {
          const p = join(d, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else total += s.size;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if (existsSync(dir)) walk(dir);
    return total;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function confirmRemoval(items: RemovalItem[]): Promise<boolean> {
  // In non-interactive mode, just proceed
  if (!process.stdin.isTTY) return true;

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    rl.question(chalk.yellow("\nProceed with removal? [y/N] "), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export async function runUninstall(options: UninstallOptions): Promise<void> {
  console.log(chalk.blue("🗑  Aether CLI — Uninstall\n"));

  const items = await collectRemovalItems(options);

  // Print what will be removed
  console.log(chalk.gray("Items to be removed:\n"));

  let totalSize = 0;
  const existingItems = items.filter((i) => i.exists);

  if (existingItems.length === 0) {
    console.log(chalk.yellow("  No Aether CLI files found."));
    return;
  }

  for (const item of existingItems) {
    const icon = item.type === "symlink" ? "🔗" : "📁";
    const sizeStr = item.size ? ` (${formatSize(item.size)})` : "";
    console.log(`  ${icon} ${item.path}${sizeStr}`);
    totalSize += item.size ?? 0;
  }

  console.log(chalk.gray(`\n  Total: ${formatSize(totalSize)}`));

  if (options.keepConfig) {
    console.log(chalk.gray("  Config preserved (--keep-config)"));
  }

  if (options.dryRun) {
    console.log(chalk.yellow("\n[DRY RUN] No changes made.\n"));
    return;
  }

  // Confirm
  const ok = await confirmRemoval(existingItems);
  if (!ok) {
    console.log(chalk.gray("Cancelled."));
    return;
  }

  // Remove items
  let removed = 0;

  for (const item of existingItems) {
    try {
      if (item.type === "symlink" || item.type === "file") {
        unlinkSync(item.path);
        removed++;
        console.log(chalk.green(`  ✓ Removed ${item.path}`));
      } else {
        rmSync(item.path, { recursive: true, force: true });
        removed++;
        console.log(chalk.green(`  ✓ Removed ${item.path}`));
      }
    } catch (err: unknown) {
      console.log(chalk.yellow(`  ⚠ Could not remove ${item.path}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Also try to remove the bin/aether symlink to catch relative paths
  try {
    const altSymlink = "/usr/bin/aether";
    if (existsSync(altSymlink)) {
      unlinkSync(altSymlink);
    }
  } catch { /* ignore */ }

  console.log(`\n${"─".repeat(42)}`);
  console.log(`  Removed ${removed} of ${existingItems.length} items`);
  console.log(`${"─".repeat(42)}\n`);

  if (removed === existingItems.length) {
    console.log(chalk.green("✓ Aether CLI has been uninstalled.\n"));
  } else {
    console.log(chalk.yellow("⚠ Some items could not be removed. You may need sudo.\n"));
  }
}
