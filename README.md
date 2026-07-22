# ⚡ Aether CLI

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Bun](https://img.shields.io/badge/runtime-bun-%23FBF0DF)
![Platform](https://img.shields.io/badge/platform-Termux%20%7C%20Linux%20%7C%20macOS-lightgrey)

**A lightweight, multi-model CLI AI coding agent — built for Termux on Android.**

Generate, review, and test code through any LLM provider. Provider-agnostic. Offline-ready. All from your terminal.

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/aether-cli/aether-cli/main/install.sh | bash
```

<details>
<summary>Or install manually</summary>

```bash
git clone https://github.com/Patel-web-devloper/aether-cli.git
cd aether-cli
bun install
bun run build
sudo ln -s "$(pwd)/dist/cli.js" /usr/local/bin/aether
```
</details>

**Requirements:** [Bun](https://bun.sh) ≥ 1.2 (Node.js ≥ 20 as fallback).

---

## Quick Start

Three commands to go from zero to productive:

```bash
# 1. Set up your LLM provider
aether setup

# 2. Generate code from a prompt
aether generate "Create a TypeScript REST API endpoint for user management" --provider openai

# 3. Review the generated code for issues
aether review ./src --severity warning --json
```

---

## Features

| | |
|---|---|
| **🔌 Provider-agnostic** | Swap between OpenAI, Anthropic, Google Gemini, DeepSeek, and local Ollama models with a single flag. No vendor lock-in. |
| **📁 Large context** | Smart file indexing, AST-aware chunking, and context budgeting handle repositories of any size — up to 128K token context windows. |
| **📱 Termux-optimized** | Detects Termux/Android automatically. Low-memory mode (< 2 GB RAM). Proot-aware. Config paths respect Termux conventions. |
| **🧪 Full test pipeline** | Generates, runs, and auto-fixes test suites. Detects your test runner (vitest, jest, bun, mocha, node-test). |
| **🔍 Code review agent** | Reviews code for bugs, security issues, and style problems. Filter by severity. Output as JSON for CI/CD pipelines. |
| **💬 Conversation history** | Persistent session history. Resume conversations. Track context across commands. |
| **⚡ Lightweight** | Bun runtime. Minimal dependencies. Fast startup. 1.2 MB binary. |
| **🤖 CI/CD friendly** | JSON output. Dry-run mode. Non-interactive setup. Config via environment variables. |

---

## Command Reference

### `aether generate`

Generate code from a natural language prompt.

```bash
# Basic generation
aether generate "Create a hello world TypeScript file" --dry-run

# Target a specific directory
aether generate "Build a React component" --target ./src/components

# Edit existing files (mode: create | edit | auto)
aether generate "Add input validation to src/api.ts" --mode edit

# Read prompt from a file
aether generate --file ./prompt.txt --provider anthropic

# Pipe prompt from stdin
echo "Write a sum utility" | aether generate

# Force overwrite existing files
aether generate "Rebuild the auth module" --force
```

| Option | Short | Description | Default |
|---|---|---|---|
| `--provider <name>` | `-p` | LLM provider | `openai` |
| `--model <name>` | `-m` | Model name | Provider default |
| `--mode <mode>` | | `create`, `edit`, or `auto` | `auto` |
| `--target <dir>` | `-t` | Output directory | `cwd` |
| `--file <path>` | | Read prompt from file | — |
| `--force` | `-f` | Overwrite without prompting | `false` |
| `--dry-run` | `-d` | Preview without writing files | `false` |

---

### `aether review`

Review code for bugs, security issues, and improvements.

```bash
# Review a directory
aether review ./src

# Review a single file with severity filtering
aether review ./src/utils.ts --severity error

# JSON output (machine-readable)
aether review . --json

# Auto-apply suggested fixes
aether review ./src --apply

# Dry-run to preview what would be reviewed
aether review ./src --apply --dry-run
```

| Option | Short | Description | Default |
|---|---|---|---|
| `--provider <name>` | `-p` | LLM provider | `openai` |
| `--model <name>` | `-m` | Model name | Provider default |
| `--json` | | Machine-readable JSON output | `false` |
| `--apply` | | Auto-apply suggested fixes | `false` |
| `--severity <level>` | | Filter: `error`, `warning`, `info` | Show all |
| `--dry-run` | `-d` | Preview without API calls | `false` |

---

### `aether test`

Generate, run, and auto-fix tests.

```bash
# Generate and run tests for a file
aether test ./src/utils.ts --provider openai

# Generate tests with coverage
aether test ./src --coverage

# Auto-fix failing tests (re-generate until they pass)
aether test ./src --fix

# Only run existing tests (skip generation)
aether test ./src --run --coverage

# Run specific test files
aether test ./src --run --files src/foo.test.ts src/bar.test.ts

# Preview the test plan without calling the API
aether test ./src --dry-run
```

| Option | Short | Description | Default |
|---|---|---|---|
| `--provider <name>` | `-p` | LLM provider | `openai` |
| `--model <name>` | `-m` | Model name | Provider default |
| `--framework <name>` | | Override test framework | Auto-detect |
| `--coverage` | | Collect coverage | `false` |
| `--watch` | | Watch mode | `false` |
| `--fix` | | Auto-fix failing tests | `false` |
| `--dry-run` | `-d` | Preview without API calls | `false` |
| `--run` | | Run only (skip generation) | `false` |
| `--files <paths>` | | Specific test files with `--run` | — |

---

### `aether context`

Manage project context, indexing, and conversation history.

```bash
# Show index stats (size, chunk count, token usage)
aether context stats

# Force re-index the project
aether context index

# Watch for live index updates
aether context index --watch

# List conversation history sessions
aether context history --list

# View a specific session
aether context history --view --session <id>

# Clear all sessions
aether context history --clear
```

---

### `aether config`

View and manage configuration.

```bash
# Show current configuration
aether config list

# Get a specific value
aether config get provider

# Set default provider
aether config set provider anthropic

# Set default model
aether config set model claude-sonnet-4-20250514

# Reset to defaults
aether config reset
```

---

### `aether providers`

List all registered LLM providers and their capabilities.

```bash
aether providers
```

Example output:
```
Registered providers:

  OpenAI
    Slug: openai
    Features: streaming, vision, tool_calls, json_mode, multilingual

  Anthropic Claude
    Slug: anthropic
    Features: streaming, vision, tool_calls, json_mode, multilingual

  Google Gemini
    Slug: google
    Features: streaming, vision, tool_calls, json_mode, multilingual

  DeepSeek
    Slug: deepseek
    Features: streaming, tool_calls, json_mode, multilingual

  Ollama (Local)
    Slug: ollama
    Features: streaming, json_mode, local, free
```

---

### `aether setup`

Interactive setup wizard for configuring providers and API keys.

```bash
# Full interactive setup
aether setup

# Show configuration status without prompts (CI-friendly)
aether setup --check
```

---

### `aether env`

Show environment info for debugging.

```bash
aether env
```

Displays runtime details, memory status, and API key configuration status.

---

## Supported Providers

| Provider | Slug | API Key Env Var | Local? | Features |
|---|---|---|---|---|
| **OpenAI** | `openai` | `OPENAI_API_KEY` | No | Streaming, Vision, Tool calls, JSON mode |
| **Anthropic Claude** | `anthropic` | `ANTHROPIC_API_KEY` | No | Streaming, Vision, Tool calls, JSON mode |
| **Google Gemini** | `google` | `GEMINI_API_KEY` | No | Streaming, Vision, Tool calls, JSON mode |
| **DeepSeek** | `deepseek` | `DEEPSEEK_API_KEY` | No | Streaming, Tool calls, JSON mode |
| **Ollama** | `ollama` | `OLLAMA_BASE_URL` (optional) | ✅ Yes | Streaming, JSON mode, Free |

### Provider Auto-Detection

Aether auto-detects available providers by checking for API keys in your environment:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."
export DEEPSEEK_API_KEY="..."

# Ollama uses http://localhost:11434/v1 by default
export OLLAMA_BASE_URL="http://192.168.1.50:11434/v1"  # optional
```

Run `aether env` to see which providers are ready.

---

## Configuration Guide

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `GEMINI_API_KEY` | Google Gemini API key | — |
| `DEEPSEEK_API_KEY` | DeepSeek API key | — |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://localhost:11434/v1` |
| `AETHER_MAX_CONTEXT_TOKENS` | Max context tokens | `131072` (128K) |
| `AETHER_MAX_HISTORY_TOKENS` | Max history tokens | `32768` (32K) |
| `AETHER_MAX_HISTORY_MESSAGES` | Max history messages | `50` |
| `AETHER_LOW_MEMORY` | Force low-memory mode | Auto-detected |
| `AETHER_TERMUX` | Force Termux mode | Auto-detected |
| `XDG_CONFIG_HOME` | Config directory | `~/.config` |
| `XDG_DATA_HOME` | Data directory | `~/.local/share` |

### Config File

Aether stores persistent configuration in `~/.config/aether/config.json`:

```json
{
  "version": 1,
  "providers": {
    "openai": {
      "enabled": true,
      "model": "gpt-4o"
    },
    "ollama": {
      "enabled": true,
      "model": "codellama:13b"
    }
  },
  "defaults": {
    "provider": "openai",
    "model": "gpt-4o"
  }
}
```

Set defaults without editing the file:

```bash
aether config set provider openai
aether config set model gpt-4o
```

### Setup Wizard

The easiest way to configure Aether:

```bash
aether setup
```

Walk through provider configuration, enter API keys, and set defaults — all interactively.

---

## Termux on Android

Aether is designed to run as a first-class citizen on Android via [Termux](https://termux.dev/).

### Installation on Android

```bash
# Install Termux from F-Droid (recommended)
# Then in Termux:
pkg install tur-repo
pkg install bun

# Install Aether
curl -fsSL https://raw.githubusercontent.com/aether-cli/aether-cli/main/install.sh | bash
```

### Ollama for Offline Coding

For a fully offline experience, run [Ollama](https://ollama.com) in Termux:

```bash
# In Termux
pkg install ollama

# Pull a coding model
ollama pull codellama:13b
ollama pull deepseek-coder:6.7b

# Use it with Aether
aether generate "Create a Python web scraper" --provider ollama --model codellama:13b
```

### Termux Optimizations

- **Low memory detection**: Automatically enables reduced chunk sizes and compact prompts when < 2 GB RAM is available.
- **Proot-aware**: Detects `proot-distro` environments and adjusts paths accordingly.
- **Config paths**: Uses `$PREFIX/var/lib/aether` for data on Termux (respects Android filesystem conventions).
- **No heavy dependencies**: No Electron, no GUI frameworks. Text-only, terminal-native.

### Recommended Models for Termux

| Model | Size | Best For |
|---|---|---|
| `codellama:7b` | ~4 GB | General coding, fast responses |
| `codellama:13b` | ~8 GB | Complex generation, better quality |
| `deepseek-coder:6.7b` | ~4 GB | Strong at code generation |
| `phi3:mini` | ~2 GB | Lightweight, low-RAM devices |

---

## Contributing

### Adding a New Provider

Providers are the core extensibility mechanism. To add a new one:

1. **Create the provider class** in `src/providers/<slug>.ts`:

```ts
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, ProviderFeature } from "./base.js";

export class MyProvider implements LLMProvider {
  readonly name = "My Provider";
  readonly slug = "myprovider";

  async initialize(): Promise<void> {
    // Validate API key, check connectivity
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    // Call your provider's API
  }

  async streamChat(messages: ChatMessage[], options?: ChatOptions, callbacks?: StreamCallbacks): Promise<void> {
    // Stream tokens to callbacks.onToken
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return ["streaming", "json_mode"].includes(feature);
  }

  async listModels(): Promise<string[]> {
    return ["model-v1", "model-v2"];
  }
}
```

2. **Register it** in `src/cli.ts`:

```ts
import { MyProvider } from "./providers/myprovider.js";
providerRegistry.register(new MyProvider());
```

3. **Add docs** — update the providers table in this README.

### Provider Interface

All providers implement the `LLMProvider` interface (`src/providers/base.ts`):

| Method | Description |
|---|---|
| `chat(messages, options)` | Send a chat completion, return full response |
| `streamChat(messages, options, callbacks)` | Stream tokens via `onToken` callback |
| `initialize()` | Validate credentials, check connectivity |
| `listModels()` | Return available model names |
| `supportsFeature(f)` | Declare feature support (streaming, vision, etc.) |

### Supported Features

Providers declare which features they support. Aether checks before using advanced functionality:

| Feature | Description |
|---|---|
| `streaming` | Token-by-token streaming |
| `vision` | Image input support |
| `tool_calls` | Function/tool calling |
| `json_mode` | Structured JSON output |
| `multilingual` | Non-English language support |
| `local` | Runs locally, no network needed |
| `free` | No API key or billing required |

### Test Conventions

Tests live in `src/tests/` and use a mock provider — no API keys needed:

```bash
# Run all test suites
bun run src/tests/generate.test.ts   # 8 tests — code generation pipeline
bun run src/tests/review.test.ts     # 9 tests — code review pipeline
bun run src/tests/test.test.ts       # 10 tests — test generation/runner
bun run src/tests/termux.test.ts     # 17 tests — Termux detection & config
```

All tests use `bun run` with a manual test harness (not `bun test`).

### Project Structure

```
src/
├── cli.ts              # Entry point, commander.js command definitions
├── providers/          # LLM provider implementations
│   ├── base.ts         # LLMProvider interface + types
│   ├── registry.ts     # ProviderRegistry singleton
│   ├── openai.ts       # OpenAI provider
│   ├── anthropic.ts    # Anthropic Claude provider
│   ├── google.ts       # Google Gemini provider
│   ├── deepseek.ts     # DeepSeek provider
│   └── ollama.ts       # Ollama local provider
├── agents/             # Agent pipelines (generate, review, test)
│   ├── generator.ts    # Code generation agent
│   ├── reviewer.ts     # Code review agent
│   └── tester.ts       # Test generation + execution agent
├── commands/           # Command implementations
│   ├── config.ts       # Config get/set/list/reset
│   ├── context.ts      # Context index/stats/history
│   ├── generate.ts     # Generate command handler
│   ├── review.ts       # Review command handler
│   ├── setup.ts        # Interactive setup wizard
│   └── test.ts         # Test command handler
├── context/            # Context management system
│   ├── types.ts        # Shared types
│   ├── indexer.ts      # File indexing
│   ├── chunker.ts      # Smart code chunking
│   ├── builder.ts      # Context payload builder
│   ├── history.ts      # Conversation history persistence
│   └── manager.ts      # ContextManager orchestrator
├── utils/              # Shared utilities
│   ├── scanner.ts      # Project structure scanner
│   ├── writer.ts       # Safe file writer with diff
│   ├── differ.ts       # Diff generation
│   ├── runner.ts       # Test runner detection & execution
│   ├── fixer.ts        # Auto-fix failing tests
│   ├── linter.ts       # Code linting support
│   ├── memory.ts       # Low-memory detection
│   └── termux.ts       # Termux environment detection
└── tests/              # Test suites
```

---

## License

MIT © Aether CLI Contributors

See [LICENSE](./LICENSE) for full details.
