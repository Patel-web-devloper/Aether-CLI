#!/usr/bin/env bun
/**
 * Aether CLI — main entry point.
 *
 * A lightweight, multi-model CLI AI coding agent for Termux on Android.
 * Provider-agnostic: works with OpenAI, Anthropic, Google, Ollama, DeepSeek and more.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync } from "node:fs";

import { getConfig, setConfig, listConfig, resetConfig } from "./commands/config.js";
import { getEnvInfo } from "./utils/termux.js";
import { providerRegistry } from "./providers/registry.js";
import { runGenerate } from "./commands/generate.js";
import { runReview } from "./commands/review.js";
import { runTestCommand } from "./commands/test.js";
import { runContextIndex, runContextStats, runContextHistory } from "./commands/context.js";
import { runSetup, runSetupCheck } from "./commands/setup.js";
import { detectAndSetMemoryMode, getMemorySummary, getLowMemoryWarning } from "./utils/memory.js";
import type { GeneratorMode } from "./agents/generator.js";

import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleProvider } from "./providers/google.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { OllamaProvider } from "./providers/ollama.js";

// ── Register all providers ────────────────────────────────────────────
providerRegistry.register(new OpenAIProvider());
providerRegistry.register(new AnthropicProvider());
providerRegistry.register(new GoogleProvider());
providerRegistry.register(new DeepSeekProvider());
providerRegistry.register(new OllamaProvider());

// ── Detect memory mode early ──────────────────────────────────────────
detectAndSetMemoryMode();

const program = new Command();

// ── Top-level metadata ──────────────────────────────────────────────
program
  .name("aether")
  .description(chalk.cyan("Aether CLI — AI coding agent for your terminal"))
  .version("0.1.0")
  .addHelpText(
    "after",
    `
${chalk.dim("Examples:")}
  ${chalk.white("$ aether generate \"Create a TypeScript utility\" --provider openai")}
  ${chalk.white("$ aether review ./src --provider anthropic --model claude-sonnet-4-20250514")}
  ${chalk.white("$ aether test ./src/utils.ts --dry-run")}
  ${chalk.white("$ aether config set provider openai")}
  ${chalk.white("$ aether providers")}
  ${chalk.white("$ aether env")}
`,
  );

// ── generate ────────────────────────────────────────────────────────
program
  .command("generate")
  .description("Generate code from a prompt")
  .argument("[prompt]", "The prompt describing what code to generate (omit to read from stdin or --file)")
  .option("-p, --provider <name>", "LLM provider to use", getConfig().provider || "openai")
  .option("-m, --model <name>", "Model name for the provider")
  .option("--mode <mode>", "Generation mode: create (new only), edit (existing only), auto (decide)", "auto")
  .option("-f, --force", "Overwrite existing files without prompting", false)
  .option("-t, --target <dir>", "Target directory for generated files", process.cwd())
  .option("--file <path>", "Read prompt from a file instead of argument")
  .option("-d, --dry-run", "Show what would be created without writing files", false)
  .addHelpText(
    "after",
    `\n${chalk.dim("Examples:")}
  ${chalk.white("$ aether generate \"Create a hello world TypeScript file\" --dry-run")}
  ${chalk.white("$ aether generate \"Add input validation to src/api.ts\" --mode edit")}
  ${chalk.white("$ aether generate --file ./prompt.txt --target /tmp/out")}
  ${chalk.white("$ echo \"Write a sum utility\" | aether generate")}`,
  )
  .action(async (promptArg: string | undefined, options: {
    provider: string;
    model?: string;
    mode: string;
    force: boolean;
    target: string;
    file?: string;
    dryRun: boolean;
  }) => {
    // ── Resolve prompt from argument, --file, or stdin ──────────────────
    let prompt: string | undefined = promptArg;

    if (options.file) {
      try {
        prompt = readFileSync(options.file, "utf-8").trim();
      } catch (err: unknown) {
        console.error(
          chalk.red("Error reading file:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    }

    // Read from stdin if no prompt argument and no --file
    if (!prompt || prompt === "") {
      // Check if stdin has data (piped input)
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.from(chunk));
        }
        prompt = Buffer.concat(chunks).toString("utf-8").trim();
      }
    }

    if (!prompt || prompt === "") {
      console.error(chalk.red("Error: No prompt provided. Provide a prompt argument, use --file, or pipe input."));
      process.exit(1);
    }

    // ── Validate mode ───────────────────────────────────────────────────
    const validModes: GeneratorMode[] = ["create", "edit", "auto"];
    const mode = options.mode as GeneratorMode;
    if (!validModes.includes(mode)) {
      console.error(
        chalk.red(`Invalid mode: "${options.mode}". Valid modes: ${validModes.join(", ")}`),
      );
      process.exit(1);
    }

    // ── Header ──────────────────────────────────────────────────────────
    console.log(chalk.blue("⚡ Aether Generate"));
    console.log(chalk.gray(`   Provider: ${options.provider}`));
    if (options.model) console.log(chalk.gray(`   Model: ${options.model}`));
    console.log(chalk.gray(`   Mode: ${mode}`));
    console.log(chalk.gray(`   Target: ${options.target}`));
    console.log(chalk.gray(`   Prompt: ${prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt}`));

    if (options.dryRun) {
      console.log(chalk.yellow("\n[DRY RUN] No files will be written."));
    }

    // ── Run generation ──────────────────────────────────────────────────
    const spinner = ora("Generating code...").start();

    try {
      // Init provider from slug
      let provider;
      try {
        provider = providerRegistry.get(options.provider);
        await provider.initialize();
      } catch (err: unknown) {
        spinner.fail("Provider initialization failed");
        console.error(
          chalk.red("Provider error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      const result = await runGenerate({
        prompt,
        provider,
        model: options.model,
        mode,
        target: options.target,
        force: options.force,
        dryRun: options.dryRun,
      });

      spinner.stop();

      if (!result.success) {
        process.exit(1);
      }
    } catch (err: unknown) {
      spinner.fail("Generation failed");
      console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── review ──────────────────────────────────────────────────────────
program
  .command("review")
  .description("Review code for bugs, security issues, and improvements")
  .argument("<target>", "File or directory to review")
  .option("-p, --provider <name>", "LLM provider to use", getConfig().provider || "openai")
  .option("-m, --model <name>", "Model name for the provider")
  .option("--json", "Output results as machine-readable JSON", false)
  .option("--apply", "Auto-apply suggested fixes (with confirmation)", false)
  .option("--severity <level>", "Filter results: error, warning, info (default: show all)")
  .option("-d, --dry-run", "Show what would happen without calling the API", false)
  .addHelpText(
    "after",
    `\n${chalk.dim("Examples:")}
  ${chalk.white("$ aether review ./src")}
  ${chalk.white("$ aether review ./src --provider anthropic --model claude-sonnet-4-20250514")}
  ${chalk.white("$ aether review ./src/utils.ts --severity error")}
  ${chalk.white("$ aether review . --json")}
  ${chalk.white("$ aether review ./src --apply --dry-run")}`,
  )
  .action(async (target: string, options: {
    provider: string;
    model?: string;
    json: boolean;
    apply: boolean;
    severity?: string;
    dryRun: boolean;
  }) => {
    // ── Validate severity ────────────────────────────────────────────
    if (options.severity && !["error", "warning", "info"].includes(options.severity.toLowerCase())) {
      console.error(
        chalk.red(`Invalid severity: "${options.severity}". Valid values: error, warning, info`),
      );
      process.exit(1);
    }

    // ── Dry-run: skip provider init ────────────────────────────────
    if (options.dryRun) {
      const result = await runReview({
        target,
        provider: providerRegistry.get(options.provider), // not initialised, but dryRun won't call it
        model: options.model,
        json: options.json,
        apply: options.apply,
        severity: options.severity,
        dryRun: true,
      });
      return;
    }

    // ── Get and init provider ────────────────────────────────────────
    let provider;
    try {
      provider = providerRegistry.get(options.provider);
      await provider.initialize();
    } catch (err: unknown) {
      console.error(
        chalk.red("Provider error:"),
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }

    // ── Run review ───────────────────────────────────────────────────
    const result = await runReview({
      target,
      provider,
      model: options.model,
      json: options.json,
      apply: options.apply,
      severity: options.severity,
      dryRun: options.dryRun,
    });

    if (!result.success) {
      process.exit(1);
    }
  });

// ── test ────────────────────────────────────────────────────────────
program
  .command("test")
  .description("Generate and run tests for code")
  .argument("<target>", "File or directory to generate tests for")
  .option("-p, --provider <name>", "LLM provider to use", getConfig().provider || "openai")
  .option("-m, --model <name>", "Model name for the provider")
  .option("--framework <name>", "Test framework override: vitest, jest, bun, mocha, node-test")
  .option("--coverage", "Collect test coverage", false)
  .option("--watch", "Run tests in watch mode", false)
  .option("--fix", "Auto-fix failing tests using LLM", false)
  .option("-d, --dry-run", "Show what would happen without calling the API or writing files", false)
  .option("--run", "Only run existing tests (skip generation)", false)
  .option("--files <paths...>", "Specific test files to run (with --run)")
  .addHelpText(
    "after",
    `\n${chalk.dim("Examples:")}
  ${chalk.white("$ aether test ./src --dry-run")}
  ${chalk.white("$ aether test ./src/utils.ts --provider openai")}
  ${chalk.white("$ aether test ./src --coverage")}
  ${chalk.white("$ aether test ./src --fix")}
  ${chalk.white("$ aether test ./src --run --coverage")}
  ${chalk.white("$ aether test ./src --run --files src/foo.test.ts src/bar.test.ts")}`,
  )
  .action(async (target: string, options: {
    provider: string;
    model?: string;
    framework?: string;
    coverage: boolean;
    watch: boolean;
    fix: boolean;
    dryRun: boolean;
    run: boolean;
    files?: string[];
  }) => {
    // ── Header ──────────────────────────────────────────────────────────
    console.log(chalk.blue("🧪 Aether Test"));

    // ── Dry-run: skip provider init, just scan and report ─────────────
    if (options.dryRun) {
      const result = await runTestCommand({
        provider: providerRegistry.get(options.provider), // not initialised, dryRun won't call it
        model: options.model,
        target,
        framework: options.framework,
        runOnly: options.run,
        coverage: options.coverage,
        watch: options.watch,
        fix: options.fix,
        dryRun: true,
        testFiles: options.files,
      });
      if (!result.success) process.exit(1);
      return;
    }

    // ── Get and init provider ────────────────────────────────────────
    let provider;
    try {
      provider = providerRegistry.get(options.provider);
      await provider.initialize();
    } catch (err: unknown) {
      console.error(
        chalk.red("Provider error:"),
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }

    // ── Get default model ────────────────────────────────────────────
    let model = options.model;
    if (!model) {
      try {
        const models = await provider.listModels();
        model = models[0];
      } catch {
        // use undefined
      }
    }

    // ── Run test pipeline ────────────────────────────────────────────
    const result = await runTestCommand({
      provider,
      model,
      target,
      framework: options.framework,
      runOnly: options.run,
      coverage: options.coverage,
      watch: options.watch,
      fix: options.fix,
      dryRun: false,
      testFiles: options.files,
    });

    if (!result.success) {
      process.exit(1);
    }
  });

// ── config ──────────────────────────────────────────────────────────
const configCmd = program
  .command("config")
  .description("View and manage Aether configuration");

configCmd
  .command("list")
  .description("Show current configuration")
  .action(() => {
    console.log(listConfig(providerRegistry.list()));
  });

configCmd
  .command("get")
  .description("Get a config value")
  .argument("<key>", "Config key (provider, model)")
  .action((key: string) => {
    const cfg = getConfig();
    if (key in cfg) {
      console.log(`${key}: ${cfg[key as keyof typeof cfg] || "(not set)"}`);
    } else {
      console.error(chalk.red(`Unknown config key: ${key}`));
      process.exit(1);
    }
  });

configCmd
  .command("set")
  .description("Set a config value")
  .argument("<key>", "Config key (provider, model)")
  .argument("<value>", "Value to set")
  .action((key: string, value: string) => {
    const validKeys = ["provider", "model"];
    if (!validKeys.includes(key)) {
      console.error(chalk.red(`Unknown config key: ${key}. Valid: ${validKeys.join(", ")}`));
      process.exit(1);
    }
    setConfig(key as "provider" | "model", value);
    console.log(chalk.green(`✓ ${key} set to ${value}`));
  });

configCmd
  .command("reset")
  .description("Reset configuration to defaults")
  .action(() => {
    resetConfig();
    console.log(chalk.green("✓ Configuration reset to defaults"));
  });

// ── providers ───────────────────────────────────────────────────────
program
  .command("providers")
  .description("List registered LLM providers")
  .action(() => {
    const slugs = providerRegistry.list();

    if (slugs.length === 0) {
      console.log(chalk.yellow("No providers registered."));
      return;
    }

    console.log(chalk.blue("Registered providers:"));
    for (const slug of slugs) {
      const provider = providerRegistry.get(slug);
      console.log("");
      console.log(`  ${chalk.cyan(provider.name)}`);
      console.log(`    Slug: ${chalk.green(slug)}`);
      const features = (["streaming", "vision", "tool_calls", "json_mode", "multilingual", "local", "free"] as const)
        .filter((f) => provider.supportsFeature(f));
      console.log(`    Features: ${features.join(", ") || "(none)"}`);
    }
  });

// ── setup ───────────────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard for configuring providers and API keys")
  .option("--check", "Show current configuration without interactive prompts")
  .addHelpText(
    "after",
    `\n${chalk.dim("Examples:")}
  ${chalk.white("$ aether setup")}
  ${chalk.white("$ aether setup --check")}`,
  )
  .action(async (options: { check?: boolean }) => {
    if (options.check) {
      await runSetupCheck();
    } else {
      await runSetup();
    }
  });

// ── env (debug command) ─────────────────────────────────────────────
program
  .command("env")
  .description("Show environment info (for debugging)")
  .action(async () => {
    const info = getEnvInfo();
    console.log(chalk.blue("Environment Info:"));
    for (const [key, value] of Object.entries(info)) {
      console.log(`  ${chalk.gray(key.padEnd(14))} ${String(value)}`);
    }

    console.log("");
    console.log(chalk.blue("Memory:"));
    const mem = getMemorySummary();
    for (const [key, value] of Object.entries(mem)) {
      console.log(`  ${chalk.gray(key.padEnd(14))} ${String(value)}`);
    }

    // Show low memory warning if applicable
    const lowMemWarn = getLowMemoryWarning();
    if (lowMemWarn) {
      console.log("");
      console.log(chalk.yellow(lowMemWarn));
    }

    console.log("");
    console.log(chalk.blue("Provider API Key Status:"));

    const envVarMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GEMINI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      ollama: "OLLAMA_BASE_URL",
    };

    for (const slug of providerRegistry.list()) {
      const envVar = envVarMap[slug];
      if (!envVar) continue;

      const value = process.env[envVar];
      let status: string;
      if (slug === "ollama") {
        status = value
          ? chalk.green(`set (${value})`)
          : chalk.dim("using default (http://localhost:11434/v1)");
      } else {
        if (value) {
          const masked = value.length > 8
            ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
            : "set (short)";
          status = chalk.green(`set (${masked})`);
        } else {
          status = chalk.red("not set");
        }
      }

      const provider = providerRegistry.get(slug);
      console.log(`  ${chalk.cyan(provider.name.padEnd(20))} ${envVar}=${status}`);
    }
  });

// ── context ──────────────────────────────────────────────────────────
const contextCmd = program
  .command("context")
  .description("Manage project context, indexing, and history");

contextCmd
  .command("index")
  .description("Force re-index the project directory")
  .option("--watch", "Enable live index updates on file changes", false)
  .action(async (options: { watch: boolean }) => {
    await runContextIndex({ cwd: process.cwd(), watch: options.watch });
  });

contextCmd
  .command("stats")
  .description("Show index size, chunk count, token usage")
  .action(async () => {
    await runContextStats({ cwd: process.cwd() });
  });

contextCmd
  .command("history")
  .description("Manage conversation history sessions")
  .option("--list", "List all saved sessions")
  .option("--view", "View a session (requires --session)")
  .option("--clear", "Clear a session or all sessions")
  .option("--session <id>", "Session ID for view/clear")
  .action(async (options: { list?: boolean; view?: boolean; clear?: boolean; session?: string }) => {
    if (options.list) {
      await runContextHistory("list");
    } else if (options.view) {
      await runContextHistory("view", options.session);
    } else if (options.clear) {
      await runContextHistory("clear", options.session);
    } else {
      // Default: list sessions
      await runContextHistory("list");
    }
  });

// ── Parse ───────────────────────────────────────────────────────────
// If no command is given, show help.
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
