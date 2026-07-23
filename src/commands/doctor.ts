/**
 * Aether doctor — diagnostic command.
 *
 * Checks runtime, PATH, git, node, bun, config, API keys,
 * provider connectivity, internet, permissions, updates,
 * install integrity, and environment — all with ✓ / ⚠ / ✗ status.
 *
 * Usage: aether doctor [--json] [--fix]
 */

import os from "node:os";
import { execSync } from "node:child_process";
import { existsSync, accessSync, constants, statSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerRegistry } from "../providers/registry.js";
import { getConfig } from "./config.js";
import { getConfigDir, getCacheDir, getDataDir, isTermux, isProot, getConfigPath } from "../utils/termux.js";
import { getMemorySummary } from "../utils/memory.js";

interface CheckResult {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fixable?: boolean;
  fix?: string;
}

interface CheckContext {
  all: CheckResult[];
  fixCount: number;
}

function ctx(): CheckContext {
  return { all: [], fixCount: 0 };
}

function push(c: CheckContext, r: CheckResult): void {
  c.all.push(r);
}

function pass(c: CheckContext, check: string, detail: string): void {
  push(c, { check, status: "pass", detail });
}

function warn(c: CheckContext, check: string, detail: string, fix?: string): void {
  push(c, { check, status: "warn", detail, fixable: !!fix, fix });
}

function fail(c: CheckContext, check: string, detail: string, fix?: string): void {
  push(c, { check, status: "fail", detail, fixable: !!fix, fix });
}

function icon(status: "pass" | "warn" | "fail"): string {
  switch (status) {
    case "pass": return "✓";
    case "warn": return "⚠";
    case "fail": return "✗";
  }
}

function tryExec(cmd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: true, output: out };
  } catch {
    return { ok: false, output: "" };
  }
}

function tryResolve(bin: string): string | null {
  const result = tryExec(`which ${bin} 2>/dev/null || command -v ${bin} 2>/dev/null || type ${bin} 2>/dev/null`);
  if (result.ok && result.output) return result.output.trim();
  return null;
}

function testWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    try {
      // Try creating a temp file
      const tmp = `${path}/.aether-write-test-${Date.now()}`;
      writeFileSync(tmp, "");
      unlinkSync(tmp);
      return true;
    } catch {
      return false;
    }
  }
}

async function testConnectivity(host: string): Promise<{ ok: boolean; latencyMs?: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(`https://${host}`, {
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    return { ok: resp.ok || resp.status < 500, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  }
}

// ── Check functions ──────────────────────────────────────────────────

async function checkRuntime(c: CheckContext): Promise<void> {
  const nodeVer = process.version;
  const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";
  pass(c, "Runtime", `${isBun ? "Bun" : "Node.js"} ${nodeVer}`);
}

async function checkPath(c: CheckContext): Promise<void> {
  const aetherPath = tryResolve("aether");
  if (aetherPath) {
    pass(c, "PATH", `aether found at ${aetherPath}`);
  } else {
    warn(c, "PATH", "aether is not in PATH — run `aether repair` or reinstall");
  }

  const binDir = "/usr/local/bin";
  if (testWrite(binDir)) {
    pass(c, "PATH (bin dir)", `${binDir} is writable`);
  } else {
    warn(c, "PATH (bin dir)", `${binDir} is not writable — install may need sudo`);
  }
}

async function checkGit(c: CheckContext): Promise<void> {
  const git = tryResolve("git");
  if (git) {
    const result = tryExec("git --version");
    pass(c, "Git", result.output || git);
  } else {
    warn(c, "Git", "git not found — install with `pkg install git` (Termux) or your system package manager");
  }
}

async function checkNode(c: CheckContext): Promise<void> {
  const result = tryExec("node --version");
  if (result.ok) {
    const npmResult = tryExec("npm --version");
    pass(c, "Node.js", `${result.output} (npm ${npmResult.output || "unknown"})`);
  } else {
    fail(c, "Node.js", "node not found");
  }
}

async function checkBun(c: CheckContext): Promise<void> {
  const result = tryExec("bun --version");
  if (result.ok) {
    pass(c, "Bun", result.output);
  } else if (isTermux()) {
    pass(c, "Bun", "not installed (optional on Termux — using Node.js)");
  } else {
    warn(c, "Bun", "not installed — recommended for best performance. Install: curl -fsSL https://bun.sh/install | bash");
  }
}

async function checkConfig(c: CheckContext): Promise<void> {
  const cfgPath = getConfigPath();
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      JSON.parse(raw);
      const cfg = getConfig();
      if (cfg.provider) {
        pass(c, "Config", `config.json exists, provider set to "${cfg.provider}"`);
      } else {
        warn(c, "Config", "config.json exists but no provider set", "aether config set provider openai");
      }
    } catch {
      fail(c, "Config", "config.json is not valid JSON", "aether repair");
    }
  } else {
    warn(c, "Config", "config.json not found — run `aether setup` to create it");
  }
}

async function checkApiKeys(c: CheckContext): Promise<void> {
  const envVarMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    ollama: "OLLAMA_BASE_URL",
    nvidia: "NVIDIA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    together: "TOGETHER_API_KEY",
    localai: "LOCALAI_API_KEY",
    custom: "CUSTOM_OPENAI_API_KEY",
  };

  let found = 0;
  let missing = 0;

  for (const [slug, envVar] of Object.entries(envVarMap)) {
    const value = process.env[envVar];
    const provider = providerRegistry.tryGet(slug);
    if (!provider) continue;

    // Local providers don't need API keys
    if (slug === "ollama" || slug === "lmstudio" || slug === "localai" || slug === "vllm") {
      // These are local, API key is optional
      continue;
    }

    if (value) {
      found++;
    } else {
      missing++;
    }
  }

  if (missing === 0 && found > 0) {
    pass(c, "API Keys", `${found} provider(s) have keys configured`);
  } else if (found > 0) {
    warn(c, "API Keys", `${found} set, ${missing} missing`);
  } else {
    warn(c, "API Keys", "no API keys found in environment — run `aether setup` to configure");
  }

  // Detail: list which providers have keys
  const hasKeys: string[] = [];
  const missingKeys: string[] = [];
  for (const [slug, envVar] of Object.entries(envVarMap)) {
    const provider = providerRegistry.tryGet(slug);
    if (!provider) continue;
    if (slug === "ollama" || slug === "lmstudio" || slug === "localai" || slug === "vllm") continue;

    if (process.env[envVar]) {
      const val = process.env[envVar]!;
      const masked = val.length > 8 ? `${val.substring(0, 4)}...${val.substring(val.length - 4)}` : "(set)";
      hasKeys.push(`${provider.name}: ${masked}`);
    } else {
      missingKeys.push(provider.name);
    }
  }

  if (hasKeys.length > 0) {
    pass(c, "API Keys (detail)", hasKeys.join(", "));
  }
  if (missingKeys.length > 0) {
    warn(c, "API Keys (missing)", missingKeys.join(", "));
  }
}

async function checkProviderConnectivity(c: CheckContext): Promise<void> {
  // Only check providers that have keys set
  const envVarMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    together: "TOGETHER_API_KEY",
  };

  const reachable: string[] = [];
  const unreachable: string[] = [];

  for (const [slug, envVar] of Object.entries(envVarMap)) {
    if (!process.env[envVar]) continue;
    const provider = providerRegistry.tryGet(slug);
    if (!provider) continue;

    try {
      await provider.initialize();
      reachable.push(provider.name);
    } catch {
      unreachable.push(`${provider.name} (${envVar} set but init failed)`);
    }
  }

  if (reachable.length > 0) {
    pass(c, "Provider Init", `${reachable.length} reachable: ${reachable.join(", ")}`);
  } else {
    warn(c, "Provider Init", "no cloud providers could be initialized");
  }
  if (unreachable.length > 0) {
    warn(c, "Provider Init", `unreachable: ${unreachable.join(", ")}`);
  }
}

async function checkInternet(c: CheckContext): Promise<void> {
  const result = await testConnectivity("github.com");
  if (result.ok) {
    pass(c, "Internet", `github.com reachable (${result.latencyMs}ms)`);
  } else {
    fail(c, "Internet", "cannot reach github.com — check network connection");
  }
}

async function checkPermissions(c: CheckContext): Promise<void> {
  const configDir = getConfigDir();
  const cacheDir = getCacheDir();
  const dataDir = getDataDir();

  // Ensure dirs exist
  try {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // ignore
  }

  const writeConfig = testWrite(configDir);
  const writeCache = testWrite(cacheDir);
  const writeData = testWrite(dataDir);

  if (writeConfig && writeCache && writeData) {
    pass(c, "Permissions", "config, cache, and data dirs are writable");
  } else {
    const issues: string[] = [];
    if (!writeConfig) issues.push("config dir");
    if (!writeCache) issues.push("cache dir");
    if (!writeData) issues.push("data dir");
    fail(c, "Permissions", `cannot write to: ${issues.join(", ")}`);
  }
}

async function checkUpdates(c: CheckContext): Promise<void> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/Patel-web-devloper/Aether-CLI/releases/latest",
      { signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      const latest = data.tag_name?.replace(/^v/, "") ?? "unknown";
      const current = "0.1.0";
      if (latest !== "unknown" && latest !== current) {
        warn(c, "Updates", `new version ${latest} available (current: ${current}) — run \`aether update\``);
      } else {
        pass(c, "Updates", `up to date (v${current})`);
      }
    } else {
      warn(c, "Updates", "could not check for updates (GitHub API unreachable)");
    }
  } catch {
    warn(c, "Updates", "network error checking for updates");
  }
}

async function checkInstallIntegrity(c: CheckContext): Promise<void> {
  const installDir = resolve(process.cwd(), ".."); // heuristic
  const distPath = resolve(process.cwd(), "dist/cli.js");
  const binPath = resolve(process.cwd(), "bin/aether");

  if (existsSync(distPath)) {
    const stat = statSync(distPath);
    pass(c, "Install Integrity", `dist/cli.js exists (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    fail(c, "Install Integrity", "dist/cli.js missing — run `aether repair` to rebuild");
  }

  if (existsSync(binPath)) {
    pass(c, "Install Integrity", "bin/aether symlink exists");
  } else {
    warn(c, "Install Integrity", "bin/aether not found — run install.sh or `aether repair`");
  }
}

async function checkEnv(c: CheckContext): Promise<void> {
  const mem = getMemorySummary();
  const platform = os.platform();
  const arch = os.arch();

  pass(c, "Platform", `${platform} / ${arch}`);
  pass(c, "Termux", isTermux() ? "yes" : "no");
  pass(c, "Proot", isProot() ? "yes" : "no");
  pass(c, "Memory", `${mem.availableGB}GB available / ${mem.totalGB}GB total${mem.isLowMemory ? " (low memory mode)" : ""}`);
}

// ── Fix logic ────────────────────────────────────────────────────────

async function autoFix(c: CheckContext): Promise<void> {
  // Rebuild dist if missing
  const distPath = resolve(process.cwd(), "dist/cli.js");
  if (!existsSync(distPath)) {
    console.log("  Fix: rebuilding dist...");
    try {
      execSync("bun run build", { cwd: process.cwd(), stdio: "inherit", timeout: 60000 });
      c.fixCount++;
    } catch {
      console.log("  ⚠ rebuild failed — try manually: bun run build");
    }
  }
}

// ── Main entry ───────────────────────────────────────────────────────

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const c = ctx();

  await checkRuntime(c);
  await checkPath(c);
  await checkGit(c);
  await checkNode(c);
  await checkBun(c);
  await checkConfig(c);
  await checkApiKeys(c);
  await checkProviderConnectivity(c);
  await checkInternet(c);
  await checkPermissions(c);
  await checkUpdates(c);
  await checkInstallIntegrity(c);
  await checkEnv(c);

  if (options.fix) {
    await autoFix(c);
  }

  if (options.json) {
    const out = c.all.map((r) => ({
      check: r.check,
      status: r.status,
      detail: r.detail,
      fixable: r.fixable,
      fix: r.fix,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human-readable output
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       Aether CLI — Doctor            ║");
  console.log("╚══════════════════════════════════════╝\n");

  for (const r of c.all) {
    const prefix = icon(r.status);
    const colorFn =
      r.status === "pass" ? "\x1b[32m" :
      r.status === "warn" ? "\x1b[33m" :
      "\x1b[31m";
    console.log(`${colorFn}  ${prefix}\x1b[0m ${r.check}`);
    console.log(`      ${r.detail}`);
    if (r.fix) {
      console.log(`      \x1b[36mFix:\x1b[0m ${r.fix}`);
    }
  }

  const passCount = c.all.filter((r) => r.status === "pass").length;
  const warnCount = c.all.filter((r) => r.status === "warn").length;
  const failCount = c.all.filter((r) => r.status === "fail").length;

  console.log(`\n${"─".repeat(42)}`);
  console.log(`  ✓ ${passCount} passed  ⚠ ${warnCount} warnings  ✗ ${failCount} failures`);
  console.log(`${"─".repeat(42)}\n`);

  if (options.fix && c.fixCount > 0) {
    console.log(`  Fixed ${c.fixCount} issue(s)\n`);
  }

  if (failCount > 0) {
    process.exitCode = 1;
  }
}
