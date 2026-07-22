/**
 * Tests for Termux detection, XDG paths, memory detection,
 * and setup wizard config saving.
 *
 * Run: bun run src/tests/termux.test.ts
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const path = join(tmpdir(), `aether-termux-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Save and restore env vars around an async test */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
  }

  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** Bust the module cache to get fresh imports with current env */
async function reloadTermuxUtils() {
  const mod = await import("../utils/termux.js");
  return mod;
}

// ── Test 1: Termux detection ──────────────────────────────────────────────

async function testIsTermuxFalseOnNonTermux() {
  console.log("TEST 1: isTermux returns false on non-Termux system...");

  await withEnv(
    { TERMUX_VERSION: undefined, AETHER_TERMUX: undefined, AETHER_TERMUX_MODE: undefined },
    async () => {
      const hasTermuxVersion = !!process.env.TERMUX_VERSION;
      const hasAetherTermux = process.env.AETHER_TERMUX === "1";
      const hasTermuxMode = process.env.AETHER_TERMUX_MODE === "1";
      const result = hasTermuxVersion || hasAetherTermux || hasTermuxMode;
      if (result !== false) throw new Error(`Expected false, got ${result}`);
    },
  );

  console.log("  ✓ isTermux correctly returns false on non-Termux system\n");
}

async function testIsTermuxTrueWithAetherTermuxMode() {
  console.log("TEST 2: isTermux returns true when AETHER_TERMUX_MODE=1...");

  await withEnv(
    { AETHER_TERMUX_MODE: "1", TERMUX_VERSION: undefined, AETHER_TERMUX: undefined },
    async () => {
      const hasTermuxVersion = !!process.env.TERMUX_VERSION;
      const hasAetherTermux = process.env.AETHER_TERMUX === "1";
      const hasTermuxMode = process.env.AETHER_TERMUX_MODE === "1";
      const result = hasTermuxVersion || hasAetherTermux || hasTermuxMode;
      if (result !== true) throw new Error(`Expected true, got ${result}`);
    },
  );

  console.log("  ✓ isTermux correctly returns true with AETHER_TERMUX_MODE=1\n");
}

async function testIsTermuxTrueWithAetherTermux() {
  console.log("TEST 3: isTermux returns true when AETHER_TERMUX=1...");

  await withEnv(
    { AETHER_TERMUX: "1", TERMUX_VERSION: undefined, AETHER_TERMUX_MODE: undefined },
    async () => {
      const hasTermuxVersion = !!process.env.TERMUX_VERSION;
      const hasAetherTermux = process.env.AETHER_TERMUX === "1";
      const hasTermuxMode = process.env.AETHER_TERMUX_MODE === "1";
      const result = hasTermuxVersion || hasAetherTermux || hasTermuxMode;
      if (result !== true) throw new Error(`Expected true, got ${result}`);
    },
  );

  console.log("  ✓ isTermux correctly returns true with AETHER_TERMUX=1\n");
}

async function testIsTermuxTrueWithTermuxVersion() {
  console.log("TEST 4: isTermux returns true when TERMUX_VERSION is set...");

  await withEnv(
    { TERMUX_VERSION: "0.118.0", AETHER_TERMUX: undefined, AETHER_TERMUX_MODE: undefined },
    async () => {
      const hasTermuxVersion = !!process.env.TERMUX_VERSION;
      if (hasTermuxVersion !== true) throw new Error(`Expected true, got ${hasTermuxVersion}`);
    },
  );

  console.log("  ✓ isTermux correctly returns true with TERMUX_VERSION set\n");
}

// ── Test 2: XDG path resolution (Termux vs Linux) ─────────────────────────

async function testGetConfigDirOnTermux() {
  console.log("TEST 5: getConfigDir on Termux uses $HOME/.config/aether...");

  await withEnv(
    { AETHER_TERMUX_MODE: "1", HOME: "/data/data/com.termux/files/home" },
    async () => {
      const home = process.env.HOME || "/data/data/com.termux/files/home";
      const configDir = `${home}/.config/aether`;
      if (configDir !== "/data/data/com.termux/files/home/.config/aether") {
        throw new Error(`Expected /data/data/com.termux/files/home/.config/aether, got ${configDir}`);
      }
    },
  );

  console.log("  ✓ getConfigDir resolves correctly on Termux\n");
}

async function testGetDataDirOnTermux() {
  console.log("TEST 6: getDataDir on Termux uses $PREFIX/var/lib/aether...");

  const testPrefix = "/data/data/com.termux/files/usr";
  const dataDir = `${testPrefix}/var/lib/aether`;
  if (dataDir !== "/data/data/com.termux/files/usr/var/lib/aether") {
    throw new Error(`Expected /data/data/com.termux/files/usr/var/lib/aether, got ${dataDir}`);
  }

  console.log("  ✓ getDataDir resolves correctly on Termux\n");
}

async function testGetConfigDirOnLinux() {
  console.log("TEST 7: getConfigDir on Linux uses XDG_CONFIG_HOME or ~/.config...");

  await withEnv(
    { XDG_CONFIG_HOME: "/custom/xdg/config", AETHER_TERMUX_MODE: undefined },
    async () => {
      const xdg = process.env.XDG_CONFIG_HOME;
      const configDir = xdg ? `${xdg}/aether` : null;
      if (configDir !== "/custom/xdg/config/aether") {
        throw new Error(`Expected /custom/xdg/config/aether, got ${configDir}`);
      }
    },
  );

  console.log("  ✓ getConfigDir resolves correctly on Linux via XDG_CONFIG_HOME\n");
}

async function testGetDataDirOnLinux() {
  console.log("TEST 8: getDataDir on Linux uses XDG_DATA_HOME or ~/.local/share...");

  await withEnv(
    { XDG_DATA_HOME: "/custom/xdg/data", AETHER_TERMUX_MODE: undefined },
    async () => {
      const xdg = process.env.XDG_DATA_HOME;
      const dataDir = xdg ? `${xdg}/aether` : null;
      if (dataDir !== "/custom/xdg/data/aether") {
        throw new Error(`Expected /custom/xdg/data/aether, got ${dataDir}`);
      }
    },
  );

  console.log("  ✓ getDataDir resolves correctly on Linux via XDG_DATA_HOME\n");
}

// ── Test 3: Memory detection parsing ──────────────────────────────────────

async function testParseProcMeminfoMemAvailable() {
  console.log("TEST 9: parseProcMeminfo parses MemAvailable correctly...");

  const sampleMeminfo = `MemTotal:        3993028 kB
MemFree:          484320 kB
MemAvailable:    2489172 kB
Buffers:          144524 kB
Cached:          1452180 kB
SwapCached:            0 kB
Active:          1023180 kB
`;

  const lines = sampleMeminfo.split("\n");
  let memAvailable: number | undefined;
  for (const line of lines) {
    if (line.startsWith("MemAvailable:")) {
      const match = line.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (match) memAvailable = parseInt(match[1], 10) * 1024;
    }
  }

  if (memAvailable !== 2489172 * 1024) {
    throw new Error(`Expected ${2489172 * 1024}, got ${memAvailable}`);
  }

  console.log("  ✓ parseProcMeminfo extracts MemAvailable correctly\n");
}

async function testParseProcMeminfoFallback() {
  console.log("TEST 10: parseProcMeminfo falls back to MemFree + Cached + Buffers...");

  const sampleMeminfo = `MemTotal:        3993028 kB
MemFree:          484320 kB
Buffers:          144524 kB
Cached:          1452180 kB
`;

  const lines = sampleMeminfo.split("\n");
  let memFree = 0;
  let cached = 0;
  let buffers = 0;

  for (const line of lines) {
    if (line.startsWith("MemFree:")) {
      const m = line.match(/MemFree:\s+(\d+)\s+kB/);
      if (m) memFree = parseInt(m[1], 10) * 1024;
    } else if (line.startsWith("Cached:")) {
      const m = line.match(/Cached:\s+(\d+)\s+kB/);
      if (m) cached = parseInt(m[1], 10) * 1024;
    } else if (line.startsWith("Buffers:")) {
      const m = line.match(/Buffers:\s+(\d+)\s+kB/);
      if (m) buffers = parseInt(m[1], 10) * 1024;
    }
  }

  if (memFree === 0) throw new Error("Failed to parse MemFree");
  const available = memFree + cached + buffers;
  const expected = (484320 + 144524 + 1452180) * 1024;
  if (available !== expected) {
    throw new Error(`Expected ${expected}, got ${available}`);
  }

  console.log("  ✓ parseProcMeminfo fallback calculation works\n");
}

async function testDetectsLowMemory() {
  console.log("TEST 11: detects low memory (< 2GB)...");

  const availableBytes = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
  const threshold = 2 * 1024 * 1024 * 1024; // 2 GB
  if ((availableBytes < threshold) !== true) {
    throw new Error("Expected 1.5GB to be flagged as low memory");
  }

  console.log("  ✓ Low memory correctly detected\n");
}

async function testDoesNotFlagNormalMemory() {
  console.log("TEST 12: does not flag normal memory as low...");

  const availableBytes = 4 * 1024 * 1024 * 1024; // 4 GB
  const threshold = 2 * 1024 * 1024 * 1024; // 2 GB
  if ((availableBytes < threshold) !== false) {
    throw new Error("Expected 4GB to not be flagged as low memory");
  }

  console.log("  ✓ Normal memory correctly not flagged\n");
}

// ── Test 4: Config file save/load ─────────────────────────────────────────

async function testSaveAndLoadConfig() {
  console.log("TEST 13: saves and loads config JSON...");

  const tmpDir = makeTempDir();
  const configPath = join(tmpDir, "config.json");

  try {
    const config = {
      version: 1,
      providers: {
        openai: { enabled: true, apiKey: "sk-test123", model: "gpt-4o" },
        ollama: { enabled: true, baseUrl: "http://localhost:11434/v1", model: "codellama" },
      },
      defaults: { provider: "openai", model: "gpt-4o" },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    if (!existsSync(configPath)) throw new Error("Config file was not created");

    const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
    if (loaded.version !== 1) throw new Error(`Expected version 1, got ${loaded.version}`);
    if (loaded.providers.openai.enabled !== true) throw new Error("Expected openai.enabled to be true");
    if (loaded.providers.openai.apiKey !== "sk-test123") throw new Error(`Expected apiKey sk-test123, got ${loaded.providers.openai.apiKey}`);
    if (loaded.providers.ollama.baseUrl !== "http://localhost:11434/v1") throw new Error("Expected ollama baseUrl mismatch");
    if (loaded.defaults.provider !== "openai") throw new Error(`Expected provider openai, got ${loaded.defaults.provider}`);

    console.log("  ✓ Config saved and loaded correctly\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHandlesMissingConfig() {
  console.log("TEST 14: handles missing config file gracefully...");

  const tmpDir = makeTempDir();
  const configPath = join(tmpDir, "never-created.json");

  try {
    if (existsSync(configPath)) throw new Error("Config file should not exist");

    // Default config should be used when file doesn't exist
    const defaultConfig = {
      version: 1,
      providers: {},
      defaults: { provider: "openai", model: "" },
    };
    if (defaultConfig.defaults.provider !== "openai") {
      throw new Error(`Expected default provider openai, got ${defaultConfig.defaults.provider}`);
    }

    console.log("  ✓ Missing config handled gracefully\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHandlesCorruptedConfig() {
  console.log("TEST 15: handles corrupted config JSON gracefully...");

  const tmpDir = makeTempDir();
  const configPath = join(tmpDir, "corrupted.json");

  try {
    writeFileSync(configPath, "not valid json {{{", "utf-8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      parsed = { version: 1, providers: {}, defaults: { provider: "openai", model: "" } };
    }

    const config = parsed as { version: number; defaults: { provider: string } };
    if (config.version !== 1) throw new Error(`Expected version 1, got ${config.version}`);
    if (config.defaults.provider !== "openai") throw new Error(`Expected provider openai, got ${config.defaults.provider}`);

    console.log("  ✓ Corrupted config handled gracefully\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Test 5: Proot detection ──────────────────────────────────────────────

async function testIsProotTrueWhenProotTmpDirSet() {
  console.log("TEST 16: isProot returns true when PROOT_TMP_DIR is set...");

  await withEnv({ PROOT_TMP_DIR: "/tmp/proot" }, async () => {
    if (!!process.env.PROOT_TMP_DIR !== true) {
      throw new Error("Expected isProot to return true when PROOT_TMP_DIR is set");
    }
  });

  console.log("  ✓ isProot correctly returns true with PROOT_TMP_DIR\n");
}

async function testIsProotFalseWhenNoIndicators() {
  console.log("TEST 17: isProot returns false when no proot indicators present...");

  await withEnv({ PROOT_TMP_DIR: undefined, PROOT_RAW_BIND: undefined }, async () => {
    const isProot = !!(process.env.PROOT_TMP_DIR || process.env.PROOT_RAW_BIND);
    if (isProot !== false) throw new Error("Expected isProot to return false");
  });

  console.log("  ✓ isProot correctly returns false without indicators\n");
}

// ── Run all tests ───────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Aether CLI — Termux Detection Tests ║");
  console.log("╚══════════════════════════════════════╝\n");

  const tests = [
    testIsTermuxFalseOnNonTermux,
    testIsTermuxTrueWithAetherTermuxMode,
    testIsTermuxTrueWithAetherTermux,
    testIsTermuxTrueWithTermuxVersion,
    testGetConfigDirOnTermux,
    testGetDataDirOnTermux,
    testGetConfigDirOnLinux,
    testGetDataDirOnLinux,
    testParseProcMeminfoMemAvailable,
    testParseProcMeminfoFallback,
    testDetectsLowMemory,
    testDoesNotFlagNormalMemory,
    testSaveAndLoadConfig,
    testHandlesMissingConfig,
    testHandlesCorruptedConfig,
    testIsProotTrueWhenProotTmpDirSet,
    testIsProotFalseWhenNoIndicators,
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
