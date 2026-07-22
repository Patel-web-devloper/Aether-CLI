/**
 * Interactive setup wizard for Aether CLI.
 *
 * Walks the user through provider configuration,
 * API key entry, and saves settings to ~/.config/aether/config.json.
 *
 * Usage: aether setup
 */

import * as readline from "node:readline";
import chalk from "chalk";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { getConfigPath, getConfigDir, ensureDirs } from "../utils/termux.js";
import { isLowMemoryMode } from "../utils/memory.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface AetherConfig {
  version: number;
  providers: Record<string, ProviderConfig>;
  defaults: {
    provider: string;
    model: string;
  };
}

interface ProviderMeta {
  slug: string;
  name: string;
  envVar: string;
  description: string;
  isLocal: boolean;
  requiresKey: boolean;
  defaultModel: string;
}

// ── Provider definitions ──────────────────────────────────────────────────

const PROVIDERS: ProviderMeta[] = [
  {
    slug: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    description: "GPT-4o, GPT-4o-mini — best all-around",
    isLocal: false,
    requiresKey: true,
    defaultModel: "gpt-4o",
  },
  {
    slug: "anthropic",
    name: "Anthropic Claude",
    envVar: "ANTHROPIC_API_KEY",
    description: "Claude Sonnet 4 — excellent for large codebases",
    isLocal: false,
    requiresKey: true,
    defaultModel: "claude-sonnet-4-20250514",
  },
  {
    slug: "google",
    name: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    description: "Gemini 2.5 Flash/Pro — fast, generous free tier",
    isLocal: false,
    requiresKey: true,
    defaultModel: "gemini-2.5-flash",
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    description: "DeepSeek V3/R1 — cost-effective, strong at code",
    isLocal: false,
    requiresKey: true,
    defaultModel: "deepseek-chat",
  },
  {
    slug: "ollama",
    name: "Ollama (Local)",
    envVar: "OLLAMA_BASE_URL",
    description: "Run models locally — offline, no API cost",
    isLocal: true,
    requiresKey: false,
    defaultModel: "codellama",
  },
];

// ── Config persistence ────────────────────────────────────────────────────

export function loadConfig(): AetherConfig {
  try {
    if (existsSync(getConfigPath())) {
      const raw = readFileSync(getConfigPath(), "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // corrupted config, start fresh
  }
  return createDefaultConfig();
}

function createDefaultConfig(): AetherConfig {
  return {
    version: 1,
    providers: {},
    defaults: {
      provider: "openai",
      model: "",
    },
  };
}

export function saveConfig(config: AetherConfig): void {
  ensureDirs();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// ── Interactive setup ─────────────────────────────────────────────────────

export async function runSetup(options: { nonInteractive?: boolean } = {}): Promise<void> {
  console.log(chalk.blue.bold("\n⚡ Aether CLI — Setup Wizard\n"));

  // Show low-memory warning
  if (isLowMemoryMode()) {
    console.log(chalk.yellow("⚠️  Low memory detected — local models or smaller cloud models are recommended.\n"));
  }

  // Load existing config if any
  const config = loadConfig();
  const existingProviders = Object.keys(config.providers);

  if (existingProviders.length > 0 && !options.nonInteractive) {
    console.log(chalk.gray("Existing configuration found:"));
    for (const slug of existingProviders) {
      const p = config.providers[slug];
      console.log(chalk.gray(`  ${slug}: ${p.enabled ? chalk.green("enabled") : chalk.dim("disabled")}`));
    }
    console.log("");
  }

  if (options.nonInteractive) {
    // Non-interactive mode: just print what's configured
    printChecklist(config);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const maskedQuestion = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      // Use stderr for prompt so stdout stays clean
      process.stderr.write(prompt);
      const onData = (char: Buffer) => {
        const ch = char.toString();
        if (ch === "\r" || ch === "\n") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stderr.write("\n");
          resolve(input);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stderr.write("\n");
          rl.close();
          process.exit(0);
        }
        if (ch === "\u007f") {
          // backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stderr.write("\b \b");
          }
          return;
        }
        input += ch;
        process.stderr.write("*");
      };

      let input = "";

      if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(true);
      }
      process.stdin.on("data", onData);
    });

  console.log(chalk.cyan("Which providers would you like to configure?\n"));

  // List providers with numbers
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    const already = config.providers[p.slug]?.enabled;
    const marker = already ? chalk.green("✓") : " ";
    const badge = p.isLocal ? chalk.magenta("[local]") : chalk.yellow("[cloud]");
    console.log(`  ${marker} ${chalk.white.bold(`${i + 1}.`)} ${chalk.cyan(p.name)} ${badge}`);
    console.log(`     ${chalk.gray(p.description)}`);
  }

  console.log("");
  console.log(chalk.gray("Enter numbers separated by commas (e.g. 1,3,5), or 'all' for all providers."));
  console.log(chalk.gray("Press Enter to skip provider config."));

  const choice = await question(chalk.white("\n> "));

  let selectedIndices: number[] = [];

  if (choice.toLowerCase().trim() === "all") {
    selectedIndices = PROVIDERS.map((_, i) => i + 1);
  } else if (choice.trim()) {
    selectedIndices = choice
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= PROVIDERS.length);
  }

  if (selectedIndices.length === 0) {
    console.log(chalk.gray("\nNo providers selected. Configuration saved with defaults.\n"));
    saveConfig(config);
    rl.close();
    printChecklist(config);
    return;
  }

  // Configure each selected provider
  for (const idx of selectedIndices) {
    const p = PROVIDERS[idx - 1];
    console.log(chalk.blue(`\n── ${p.name} ──`));
    console.log(chalk.gray(`   ${p.description}`));

    // Enable the provider
    config.providers[p.slug] = config.providers[p.slug] || {
      enabled: true,
      model: p.defaultModel,
    };
    config.providers[p.slug].enabled = true;

    // Ask for model (or accept default)
    if (!p.isLocal) {
      const modelPrompt = chalk.white(`   Model [${p.defaultModel}]: `);
      const modelAnswer = await question(modelPrompt);
      if (modelAnswer.trim()) {
        config.providers[p.slug].model = modelAnswer.trim();
      } else {
        config.providers[p.slug].model = p.defaultModel;
      }
    } else {
      config.providers[p.slug].model = p.defaultModel;
    }

    // Ask for API key if needed
    if (p.requiresKey) {
      // Check if already in env
      const envValue = process.env[p.envVar];
      if (envValue) {
        const masked = envValue.length > 8
          ? `${envValue.substring(0, 4)}...${envValue.substring(envValue.length - 4)}`
          : "set (short)";
        console.log(chalk.gray(`   ${p.envVar}: ${chalk.green(masked)} (from environment)`));
      } else {
        const keyPrompt = chalk.white(`   ${p.envVar}: `);
        const keyAnswer = await maskedQuestion(keyPrompt);
        if (keyAnswer.trim()) {
          config.providers[p.slug].apiKey = keyAnswer.trim();
        } else {
          console.log(chalk.yellow(`   ⚠ No key provided — ${p.name} will need ${p.envVar} set in environment.`));
        }
      }
    }

    // Ask for base URL (Ollama only)
    if (p.isLocal) {
      const urlPrompt = chalk.white(`   Ollama URL [http://localhost:11434/v1]: `);
      const urlAnswer = await question(urlPrompt);
      if (urlAnswer.trim()) {
        config.providers[p.slug].baseUrl = urlAnswer.trim();
      } else {
        config.providers[p.slug].baseUrl = "http://localhost:11434/v1";
      }
    }
  }

  // Ask for default provider
  const enabledSlugs = Object.entries(config.providers)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);

  if (enabledSlugs.length > 0) {
    console.log(chalk.blue("\n── Default Provider ──"));
    const currentDefault = config.defaults.provider;
    const defaultMsg = currentDefault && enabledSlugs.includes(currentDefault)
      ? ` [${currentDefault}]`
      : enabledSlugs.length === 1
        ? ` [${enabledSlugs[0]}]`
        : "";
    const defaultPrompt = chalk.white(`   Default provider${defaultMsg}: `);
    const defaultAnswer = await question(defaultPrompt);

    if (defaultAnswer.trim() && enabledSlugs.includes(defaultAnswer.trim().toLowerCase())) {
      config.defaults.provider = defaultAnswer.trim().toLowerCase();
    } else if (defaultAnswer.trim()) {
      console.log(chalk.yellow(`   "${defaultAnswer.trim()}" is not configured. Using first enabled provider.`));
      config.defaults.provider = enabledSlugs[0];
    } else if (!config.defaults.provider || !enabledSlugs.includes(config.defaults.provider)) {
      config.defaults.provider = enabledSlugs[0];
    }
  }

  rl.close();

  // Save config
  saveConfig(config);
  console.log(chalk.green(`\n✓ Configuration saved to ${getConfigPath()}\n`));

  // Set API keys in current process env (for immediate use)
  for (const [slug, pConfig] of Object.entries(config.providers)) {
    if (pConfig.apiKey) {
      const meta = PROVIDERS.find((m) => m.slug === slug);
      if (meta && meta.envVar) {
        process.env[meta.envVar] = pConfig.apiKey;
      }
    }
  }

  // Print checklist
  printChecklist(config);
}

function printChecklist(config: AetherConfig): void {
  console.log(chalk.blue.bold("Configuration Checklist:\n"));

  for (const p of PROVIDERS) {
    const pc = config.providers[p.slug];
    const enabled = pc?.enabled;
    const hasKey = pc?.apiKey || process.env[p.envVar];
    const hasModel = pc?.model;

    let status: string;
    if (!enabled) {
      status = chalk.gray("○ Not configured");
    } else if (p.requiresKey && !hasKey) {
      status = chalk.yellow("◐ Enabled, no API key");
    } else {
      status = chalk.green("● Ready");
    }

    const modelStr = hasModel ? chalk.gray(`(${hasModel})`) : "";
    console.log(`  ${status} ${chalk.cyan(p.name)} ${modelStr}`);
  }

  console.log(chalk.gray(`\n  Default: ${config.defaults.provider || "(not set)"}`));
  console.log(chalk.gray(`  Config:  ${getConfigPath()}`));
  console.log("");

  // If Ollama is configured, show hint
  if (config.providers.ollama?.enabled) {
    console.log(chalk.magenta("💡 Tip: Ollama is great for offline use on Android."));
    console.log(chalk.magenta(`   Install Ollama in Termux: pkg install ollama && ollama serve`));
    console.log(chalk.magenta(`   Then pull a model: ollama pull ${config.providers.ollama.model || "codellama"}`));
    console.log("");
  }

  // Show env var exports
  const cloudWithKeys = PROVIDERS.filter(
    (p) => config.providers[p.slug]?.apiKey && !p.isLocal,
  );

  if (cloudWithKeys.length > 0) {
    console.log(chalk.cyan("API keys saved. To use in your shell, add to ~/.bashrc or ~/.zshrc:"));
    for (const p of cloudWithKeys) {
      const pc = config.providers[p.slug];
      if (pc.apiKey) {
        console.log(chalk.gray(`  export ${p.envVar}="${pc.apiKey.substring(0, 4)}..."`));
      }
    }
    console.log("");
  }
}

/**
 * Quick non-interactive setup check — shows what's configured.
 */
export async function runSetupCheck(): Promise<void> {
  const config = loadConfig();
  printChecklist(config);
}
