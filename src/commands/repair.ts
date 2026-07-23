/**
 * Aether repair — fix common issues.
 *
 * Rebuilds dist, reinstalls node_modules, fixes symlinks, repairs config.
 *
 * Usage: aether repair
 */

import { execSync } from "node:child_process";
import { existsSync, statSync, symlinkSync, unlinkSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import chalk from "chalk";

const INSTALL_DIR = resolve(import.meta.dirname ?? process.cwd(), "../..");
const DIST_PATH = resolve(INSTALL_DIR, "dist/cli.js");
const NODE_MODULES_PATH = resolve(INSTALL_DIR, "node_modules");
const BIN_PATH = resolve(INSTALL_DIR, "bin/aether");
const PACKAGE_JSON_PATH = resolve(INSTALL_DIR, "package.json");

export interface RepairOptions {
  // future flags
}

export async function runRepair(_options: RepairOptions = {}): Promise<void> {
  console.log(chalk.blue("🔧 Aether CLI — Repair"));
  console.log(chalk.gray(`   Install dir: ${INSTALL_DIR}\n`));

  let repairs = 0;

  // 1. Check dist
  if (!existsSync(DIST_PATH)) {
    console.log(chalk.yellow("  ⚠ dist/cli.js missing — rebuilding..."));
    try {
      execSync("bun run build", { cwd: INSTALL_DIR, stdio: "inherit", timeout: 60000 });
      repairs++;
      console.log(chalk.green("  ✓ dist rebuilt"));
    } catch {
      console.log(chalk.red("  ✗ Failed to rebuild. Try: cd aether-cli && bun run build"));
    }
  } else {
    const st = statSync(DIST_PATH);
    if (st.size < 1024) {
      console.log(chalk.yellow("  ⚠ dist/cli.js appears corrupt (too small) — rebuilding..."));
      try {
        execSync("bun run build", { cwd: INSTALL_DIR, stdio: "inherit", timeout: 60000 });
        repairs++;
        console.log(chalk.green("  ✓ dist rebuilt"));
      } catch {
        console.log(chalk.red("  ✗ Failed to rebuild"));
      }
    } else {
      console.log(chalk.green(`  ✓ dist/cli.js OK (${(st.size / 1024 / 1024).toFixed(1)} MB)`));
    }
  }

  // 2. Check node_modules
  if (!existsSync(NODE_MODULES_PATH)) {
    console.log(chalk.yellow("  ⚠ node_modules missing — reinstalling..."));
    try {
      execSync("bun install", { cwd: INSTALL_DIR, stdio: "inherit", timeout: 120000 });
      repairs++;
      console.log(chalk.green("  ✓ node_modules reinstalled"));
    } catch {
      try {
        execSync("npm install", { cwd: INSTALL_DIR, stdio: "inherit", timeout: 120000 });
        repairs++;
        console.log(chalk.green("  ✓ node_modules reinstalled (npm)"));
      } catch {
        console.log(chalk.red("  ✗ Failed to install. Try: cd aether-cli && bun install"));
      }
    }
  } else {
    console.log(chalk.green("  ✓ node_modules exists"));
  }

  // 3. Check symlink
  const linkTarget = "/usr/local/bin/aether";
  const linkExists = (() => {
    try {
      statSync(linkTarget);
      return true;
    } catch {
      return false;
    }
  })();

  if (!linkExists) {
    console.log(chalk.yellow(`  ⚠ ${linkTarget} symlink missing — creating...`));
    try {
      if (existsSync(linkTarget)) unlinkSync(linkTarget);
      symlinkSync(BIN_PATH, linkTarget);
      repairs++;
      console.log(chalk.green(`  ✓ symlink created: ${linkTarget} -> ${BIN_PATH}`));
    } catch {
      console.log(chalk.yellow("  ⚠ Could not create symlink — may need sudo. Run install.sh instead."));
    }
  } else {
    console.log(chalk.green(`  ✓ ${linkTarget} symlink exists`));
  }

  // 4. Check config
  const configPath = resolve(process.env.HOME ?? "/root", ".config/aether/config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      JSON.parse(raw);
      console.log(chalk.green("  ✓ config.json is valid"));
    } catch {
      console.log(chalk.yellow("  ⚠ config.json is corrupt — repairing..."));
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "" }, null, 2), "utf-8");
        repairs++;
        console.log(chalk.green("  ✓ config.json repaired (reset to defaults)"));
      } catch {
        console.log(chalk.red("  ✗ Could not repair config.json"));
      }
    }
  } else {
    console.log(chalk.yellow("  ⚠ config.json not found — creating default..."));
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "" }, null, 2), "utf-8");
      repairs++;
      console.log(chalk.green("  ✓ config.json created with defaults"));
    } catch {
      console.log(chalk.red("  ✗ Could not create config.json"));
    }
  }

  // 5. Check if package.json changed
  try {
    const lockStat = statSync(resolve(INSTALL_DIR, "bun.lock"));
    const pkgStat = statSync(PACKAGE_JSON_PATH);
    if (pkgStat.mtimeMs > lockStat.mtimeMs + 5000) {
      console.log(chalk.yellow("  ⚠ package.json modified after bun.lock — reinstalling dependencies..."));
      execSync("bun install", { cwd: INSTALL_DIR, stdio: "inherit", timeout: 120000 });
      repairs++;
      console.log(chalk.green("  ✓ dependencies reinstalled"));
    }
  } catch {
    // lock file issues — not critical
  }

  console.log(`\n${"─".repeat(42)}`);
  console.log(`  Repairs made: ${repairs}`);
  console.log(`${"─".repeat(42)}\n`);

  if (repairs > 0) {
    console.log(chalk.green("✓ Repair complete. Run `aether doctor` to verify.\n"));
  } else {
    console.log(chalk.green("✓ No repairs needed.\n"));
  }
}
