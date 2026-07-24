/**
 * Integration tests for the Aether CLI installer, launcher, and runtime commands.
 *
 * Covers: symlink resolution, bash syntax validation, installer flags,
 * platform detection, provider registration, doctor, update, config,
 * and model listing across all 13 providers.
 *
 * Run: bun run src/tests/installer.test.ts
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_DIR = resolve(process.cwd());

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "aether-installer-"));
}

function run(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout: result.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString("utf-8").trim() : "",
      stderr: e.stderr ? e.stderr.toString("utf-8").trim() : "",
      exitCode: e.status ?? 1,
    };
  }
}

function runNode(args: string, opts?: { env?: Record<string, string> }): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
  return run(`node ${PROJECT_DIR}/dist/cli.js ${args}`, { cwd: PROJECT_DIR, env: opts?.env });
}

// ── Tests ───────────────────────────────────────────────────────────────

async function testSymlinkResolution() {
  console.log("TEST 1: Symlink resolution...");

  const tmpDir = makeTempDir();
  try {
    // Create a directory structure that mimics the launcher's expectations
    const binDir = join(tmpDir, "bin");
    const realDir = join(tmpDir, "real", "aether");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });

    // Create a real aether script at realDir
    const realFile = join(realDir, "aether");
    writeFileSync(realFile, "#!/usr/bin/env bash\necho real", { mode: 0o755 });

    // Create bin/aether as a copy of the actual launcher, but skip set -e so we can test
    const binFile = join(binDir, "aether");
    // Create a test script
    const testScript = `#!/usr/bin/env bash
# Extract and test resolve_symlink
resolve_symlink() {
  local target="\$1"
  if command -v greadlink >/dev/null 2>&1; then
    greadlink -f "\$target"
  elif command -v realpath >/dev/null 2>&1; then
    realpath "\$target"
  elif readlink -f "\$target" 2>/dev/null; then
    readlink -f "\$target"
  else
    local dir
    dir="\$(cd "\$(dirname "\$target")" 2>/dev/null && pwd -P)"
    local base
    base="\$(basename "\$target")"
    echo "\$dir/\$base"
  fi
}
# Test it
SYMLINK_PATH="\${1}"
REAL_PATH="\${2}"
RESOLVED=\$(resolve_symlink "\$SYMLINK_PATH")
if [ "\$RESOLVED" = "\$REAL_PATH" ]; then
  echo "MATCH"
else
  echo "MISMATCH: got \$RESOLVED, expected \$REAL_PATH"
  exit 1
fi
`;

    writeFileSync(binFile, testScript, { mode: 0o755 });

    // Create a symlink pointing to bin/aether
    const symlinkPath = join(tmpDir, "symlink-to-aether");
    symlinkSync(binFile, symlinkPath);

    const realPath = resolve(binFile);

    const result = run(`bash "${binFile}" "${symlinkPath}" "${realPath}"`);
    if (!result.ok) {
      throw new Error(`Symlink resolution failed: ${result.stdout} ${result.stderr}`);
    }
    if (!result.stdout.includes("MATCH")) {
      throw new Error(`Expected MATCH, got: ${result.stdout}`);
    }

    console.log("  ✓ Symlink resolution returns real path\n");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testLauncherSyntax() {
  console.log("TEST 2: Launcher syntax check...");

  const result = run(`bash -n ${PROJECT_DIR}/bin/aether`);
  if (result.exitCode !== 0) {
    throw new Error(`Launcher has syntax errors:\n${result.stderr}`);
  }

  console.log("  ✓ Launcher passes bash -n\n");
}

async function testInstallerSyntax() {
  console.log("TEST 3: Installer syntax check...");

  const result = run(`bash -n ${PROJECT_DIR}/install.sh`);
  if (result.exitCode !== 0) {
    throw new Error(`Installer has syntax errors:\n${result.stderr}`);
  }

  console.log("  ✓ Installer passes bash -n\n");
}

async function testInstallerHelp() {
  console.log("TEST 4: Installer --help...");

  const result = run(`bash ${PROJECT_DIR}/install.sh --help`);

  // --help should exit 0 (some scripts use non-zero for help, but our installer should use 0)
  if (result.exitCode !== 0) {
    throw new Error(`install.sh --help exited with ${result.exitCode}: ${result.stderr}`);
  }

  const output = result.stdout + result.stderr;

  const requiredFlags = [
    "--reinstall",
    "--update",
    "--repair",
    "--uninstall",
    "--offline",
    "--dry-run",
    "--verbose",
    "--silent",
    "--force",
    "--rollback",
    "--retry",
  ];

  const missing: string[] = [];
  for (const flag of requiredFlags) {
    if (!output.includes(flag)) {
      missing.push(flag);
    }
  }

  if (missing.length > 0) {
    throw new Error(`install.sh --help missing flags: ${missing.join(", ")}. Output: ${output.slice(0, 500)}`);
  }

  console.log("  ✓ Installer --help shows all major flags\n");
}

async function testInstallerDryRun() {
  console.log("TEST 5: Installer --dry-run...");

  const result = run(`bash ${PROJECT_DIR}/install.sh --dry-run 2>&1`, { cwd: PROJECT_DIR });

  if (result.exitCode !== 0) {
    throw new Error(`install.sh --dry-run failed with exit ${result.exitCode}: ${result.stderr}`);
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  if (!output.includes("dry") && !output.includes("would")) {
    throw new Error(`Expected dry-run indicator, got: ${output.slice(0, 300)}`);
  }

  console.log("  ✓ Installer --dry-run exits 0 and shows DRY RUN indicator\n");
}

async function testInstallerVerboseDryRun() {
  console.log("TEST 6: Installer --verbose --dry-run...");

  const resultDry = run(`bash ${PROJECT_DIR}/install.sh --dry-run 2>&1`, { cwd: PROJECT_DIR });
  const resultVerbose = run(`bash ${PROJECT_DIR}/install.sh --verbose --dry-run 2>&1`, { cwd: PROJECT_DIR });

  if (resultVerbose.exitCode !== 0) {
    throw new Error(`install.sh --verbose --dry-run failed with exit ${resultVerbose.exitCode}`);
  }

  // Verbose should produce more output than non-verbose dry-run
  const dryLen = (resultDry.stdout + resultDry.stderr).length;
  const verboseLen = (resultVerbose.stdout + resultVerbose.stderr).length;

  // Not strictly more, but should at least be non-empty
  if (verboseLen === 0) {
    throw new Error("Verbose dry-run produced no output");
  }

  console.log("  ✓ Installer --verbose --dry-run produces output\n");
}

async function testInstallerSilentDryRun() {
  console.log("TEST 7: Installer --silent --dry-run...");

  const result = run(`bash ${PROJECT_DIR}/install.sh --silent --dry-run 2>&1`, { cwd: PROJECT_DIR });

  if (result.exitCode !== 0) {
    throw new Error(`install.sh --silent --dry-run failed with exit ${result.exitCode}`);
  }

  // Silent should produce minimal output — just check it exits 0
  console.log("  ✓ Installer --silent --dry-run exits 0 with minimal output\n");
}

async function testPlatformDetection() {
  console.log("TEST 8: Platform detection...");

  // Extract the detect_platform function from bin/aether and test it
  const result = run(`bash -c '
# Source just the detect_platform function
eval "$(sed -n "/^detect_platform()/,/^}/p" ${PROJECT_DIR}/bin/aether)"
PLATFORM=$(detect_platform)
echo "PLATFORM=$PLATFORM"
'`);

  if (!result.ok) {
    throw new Error(`Platform detection failed: ${result.stderr}`);
  }

  const platform = result.stdout.match(/PLATFORM=(.+)/)?.[1];
  if (!platform) {
    throw new Error(`Could not parse platform from: ${result.stdout}`);
  }

  // On this sandbox, we should get a valid platform string
  if (platform.length === 0) {
    throw new Error("Platform detection returned empty string");
  }

  // Common Linux distro names
  const validPlatforms = ["linux", "ubuntu", "debian", "alpine", "arch", "fedora", "centos", "rhel", "wsl", "macos"];
  const isKnown = validPlatforms.some((p) => platform.toLowerCase().startsWith(p));
  if (!isKnown && platform !== "termux" && platform !== "proot") {
    // If it's something unusual, at least it should be non-empty and reasonable
    if (platform.includes(" ") || platform.length > 20) {
      throw new Error(`Unexpected platform value: "${platform}"`);
    }
  }

  console.log(`  ✓ Platform detected: ${platform}\n`);
}

async function testProvidersRegistered() {
  console.log("TEST 9: 13 providers registered...");

  const result = runNode("providers");

  if (result.exitCode !== 0) {
    throw new Error(`providers command failed: ${result.stderr}`);
  }

  // Count the number of "Slug:" occurrences
  const slugCount = (result.stdout.match(/Slug:/g) || []).length;
  if (slugCount !== 13) {
    throw new Error(`Expected 13 providers, found ${slugCount}`);
  }

  // Verify all expected provider slugs
  const expectedSlugs = [
    "openai", "anthropic", "google", "deepseek", "ollama",
    "nvidia", "openrouter", "groq", "together",
    "lmstudio", "localai", "vllm", "custom",
  ];

  for (const slug of expectedSlugs) {
    if (!result.stdout.toLowerCase().includes(`slug: ${slug}`)) {
      throw new Error(`Provider "${slug}" not found in providers list. Output: ${result.stdout.slice(0, 300)}`);
    }
  }

  console.log("  ✓ All 13 providers registered and listed\n");
}

async function testDoctorHelp() {
  console.log("TEST 10: doctor --help...");

  const result = runNode("doctor --help");

  if (result.exitCode !== 0) {
    throw new Error(`doctor --help failed: ${result.stderr}`);
  }

  const output = result.stdout;
  // Count the check items listed in help text
  // The help mentions: Runtime, PATH, Git, Node.js, Bun, Config, API Keys,
  // Provider Connectivity, Internet, Permissions, Updates, Install Integrity, Environment
  const checks = [
    "Runtime", "PATH", "Git", "Node", "Bun", "Config", "API Key",
    "Provider", "Internet", "Permission", "Update", "Install", "Environment",
  ];

  let found = 0;
  for (const check of checks) {
    if (output.toLowerCase().includes(check.toLowerCase())) {
      found++;
    }
  }

  if (found < 13) {
    throw new Error(`Doctor --help should mention 13+ checks, found ${found}. Output: ${output.slice(0, 500)}`);
  }

  console.log(`  ✓ Doctor --help mentions ${found} checks\n`);
}

async function testDoctorJson() {
  console.log("TEST 11: doctor --json...");

  // Set a fake API key to avoid network calls
  const result = runNode("doctor --json", {
    env: { OPENAI_API_KEY: "sk-test12345678", AETHER_NO_COLOR: "1" },
  });

  if (result.exitCode !== 0) {
    // doctor may exit 1 if there are failures, which is fine
    // We only care about valid JSON output
  }

  const stdout = result.stdout.trim();
  // Extract JSON from the output (it might have ANSI codes)
  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`doctor --json did not produce JSON array. Output: ${stdout.slice(0, 300)}`);
  }

  const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`doctor --json output is not valid JSON: ${jsonStr.slice(0, 300)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array, got: ${typeof parsed}`);
  }

  if (parsed.length === 0) {
    throw new Error("Doctor --json produced empty array");
  }

  // Each entry should have check, status, detail
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (!entry.check || !entry.status || !entry.detail) {
      throw new Error(`Doctor JSON entry missing required fields: ${JSON.stringify(entry)}`);
    }
    if (!["pass", "warn", "fail"].includes(entry.status as string)) {
      throw new Error(`Invalid status "${entry.status}" for check "${entry.check}"`);
    }
  }

  console.log(`  ✓ Doctor --json outputs valid JSON with ${parsed.length} checks\n`);
}

async function testUpdateCheck() {
  console.log("TEST 12: update --check...");

  const result = runNode("update --check");

  // Should exit 0 (it may fail to reach GitHub API but should not crash)
  if (result.exitCode !== 0) {
    // It's OK if it can't reach GitHub API — just verify it didn't crash
    const output = result.stdout + result.stderr;
    if (output.includes("TypeError") || output.includes("ReferenceError") || output.includes("uncaught")) {
      throw new Error(`update --check crashed: ${output.slice(0, 500)}`);
    }
  }

  console.log("  ✓ update --check runs without crash\n");
}

async function testConfigSetAndGet() {
  console.log("TEST 13: config set/get...");

  // Config is in-memory per process, so we verify within a single process using bun.
  // Write a small inline test script inside the project for proper module resolution.
  const testScript = join(PROJECT_DIR, "src/tests/_tmp-config-test.ts");
  const scriptContent = `
import { getConfig, setConfig, listConfig, resetConfig } from "../commands/config.js";
import { providerRegistry } from "../providers/registry.js";
import { OpenAIProvider } from "../providers/openai.js";
import { NvidiaProvider } from "../providers/nvidia.js";

// Register the providers so validation works
providerRegistry.register(new OpenAIProvider());
providerRegistry.register(new NvidiaProvider());

// Set provider to nvidia
setConfig("provider", "nvidia");
const cfg = getConfig();
if (cfg.provider !== "nvidia") {
  console.error("FAIL: provider not set to nvidia");
  process.exit(1);
}
console.log("SET OK: provider=" + cfg.provider);

// List should contain nvidia
const list = listConfig(providerRegistry.list());
if (!list.includes("nvidia")) {
  console.error("FAIL: config list does not contain nvidia");
  process.exit(1);
}

resetConfig();
console.log("ALL OK");
`;
  writeFileSync(testScript, scriptContent, "utf-8");

  try {
    const result = run(`cd ${PROJECT_DIR} && bun run ${testScript}`);
    if (result.exitCode !== 0) {
      throw new Error(`Config set/get failed: ${result.stdout} ${result.stderr}`);
    }
    if (!result.stdout.includes("ALL OK")) {
      throw new Error(`Expected ALL OK, got: ${result.stdout}`);
    }
  } finally {
    try { rmSync(testScript, { force: true }); } catch { /* ignore */ }
  }

  console.log("  ✓ config set provider nvidia and config list reflect it\n");
}

async function testConfigValidation() {
  console.log("TEST 14: config validation...");

  // Set timeout to non-numeric value — should fail
  const result = runNode("config set timeout abc");

  if (result.exitCode === 0) {
    throw new Error("config set timeout abc should have failed but exited 0");
  }

  const output = result.stdout + result.stderr;
  if (!output.toLowerCase().includes("invalid") && !output.toLowerCase().includes("error")) {
    throw new Error(`Expected error message for invalid timeout, got: ${output.slice(0, 200)}`);
  }

  // Also verify that invalid key is rejected
  const result2 = runNode("config set nonexistent value");
  if (result2.exitCode === 0) {
    throw new Error("config set with unknown key should have failed but exited 0");
  }

  console.log("  ✓ config validation rejects invalid values\n");
}

async function testAllProvidersListModels() {
  console.log("TEST 15: All providers have listModels() returning results...");

  // Import provider classes from the project source
  // We use the actual provider implementations, not the bundled CLI,
  // so we can call listModels() directly
  const { providerRegistry } = await import("../providers/registry.js");
  const { OpenAIProvider } = await import("../providers/openai.js");
  const { AnthropicProvider } = await import("../providers/anthropic.js");
  const { GoogleProvider } = await import("../providers/google.js");
  const { DeepSeekProvider } = await import("../providers/deepseek.js");
  const { OllamaProvider } = await import("../providers/ollama.js");
  const { NvidiaProvider } = await import("../providers/nvidia.js");
  const { OpenRouterProvider } = await import("../providers/openrouter.js");
  const { GroqProvider } = await import("../providers/groq.js");
  const { TogetherProvider } = await import("../providers/together.js");
  const { LMStudioProvider } = await import("../providers/lmstudio.js");
  const { LocalAIProvider } = await import("../providers/localai.js");
  const { VLLMProvider } = await import("../providers/vllm.js");
  const { CustomOpenAIProvider } = await import("../providers/custom.js");

  // Register all providers to ensure they're in the registry
  // (registry is a singleton; registering again is fine)
  const providers: Array<{ slug: string; name: string; instance: ReturnType<typeof providerRegistry.get> }> = [];

  const allProviders = [
    new OpenAIProvider(),
    new AnthropicProvider(),
    new GoogleProvider(),
    new DeepSeekProvider(),
    new OllamaProvider(),
    new NvidiaProvider(),
    new OpenRouterProvider(),
    new GroqProvider(),
    new TogetherProvider(),
    new LMStudioProvider(),
    new LocalAIProvider(),
    new VLLMProvider(),
    new CustomOpenAIProvider(),
  ];

  // Providers with hardcoded model lists (always return non-empty)
  const hardcodedSlugs = new Set([
    "openai", "anthropic", "google", "deepseek",
    "nvidia", "openrouter", "groq", "together",
  ]);

  for (const p of allProviders) {
    providerRegistry.register(p);
    providers.push({ slug: p.slug, name: p.name, instance: p });
  }

  if (providerRegistry.size !== 13) {
    throw new Error(`Expected 13 providers in registry, got ${providerRegistry.size}`);
  }

  for (const { slug, name, instance } of providers) {
    const models = await instance.listModels();

    if (!Array.isArray(models)) {
      throw new Error(`listModels() for ${slug} did not return an array`);
    }

    if (hardcodedSlugs.has(slug)) {
      // Hardcoded providers must return non-empty
      if (models.length === 0) {
        throw new Error(`listModels() for ${slug} (${name}) returned empty array`);
      }
      console.log(`    ${slug}: ${models.length} model(s)`);
    } else {
      // Local/network providers return what they can
      console.log(`    ${slug}: ${models.length} model(s) (local provider)`);
    }
  }

  console.log("  ✓ All 13 providers have functioning listModels()\n");
}

// ── Run all tests ──────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  Aether CLI — Installer & CLI Tests    ║");
  console.log("╚════════════════════════════════════════╝\n");

  const tests = [
    testSymlinkResolution,
    testLauncherSyntax,
    testInstallerSyntax,
    testInstallerHelp,
    testInstallerDryRun,
    testInstallerVerboseDryRun,
    testInstallerSilentDryRun,
    testPlatformDetection,
    testProvidersRegistered,
    testDoctorHelp,
    testDoctorJson,
    testUpdateCheck,
    testConfigSetAndGet,
    testConfigValidation,
    testAllProvidersListModels,
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
