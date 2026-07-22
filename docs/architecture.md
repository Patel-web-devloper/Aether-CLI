# Aether CLI — Architecture

## System Overview

Aether CLI follows a layered architecture: providers abstract LLM backends, agents orchestrate pipelines, and commands expose functionality through the CLI. The context management system sits beneath everything, feeding relevant code and history into every LLM call.

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (cli.ts)                          │
│   Commander.js entry point — parses flags, routes commands   │
└────────┬──────────┬──────────┬──────────┬───────────────────┘
         │          │          │          │
    ┌────▼───┐ ┌───▼────┐ ┌───▼───┐ ┌───▼────┐
    │generate│ │ review │ │ test  │ │ config │  ...setup, providers, env, context
    └────┬───┘ └───┬────┘ └───┬───┘ └────────┘
         │         │         │
    ┌────▼─────────▼─────────▼────┐
    │          AGENTS              │
    │  ┌───────────────────────┐  │
    │  │  GeneratorAgent       │  │   Scan project → Build context →
    │  │  ReviewerAgent        │  │   Call LLM → Parse response →
    │  │  TesterAgent          │  │   Write files / Display results
    │  └───────────────────────┘  │
    └────────┬────────────────────┘
             │
    ┌────────▼────────────────────┐
    │    PROVIDER INTERFACE        │
    │  ┌───────────────────────┐  │
    │  │  LLMProvider          │  │   chat() / streamChat()
    │  │  ┌─────────────────┐  │  │   initialize()
    │  │  │ OpenAI           │  │  │   listModels()
    │  │  │ Anthropic        │  │  │   supportsFeature()
    │  │  │ Google Gemini    │  │  │
    │  │  │ DeepSeek         │  │  │
    │  │  │ Ollama (local)   │  │  │
    │  │  └─────────────────┘  │  │
    │  └───────────────────────┘  │
    └────────┬────────────────────┘
             │
    ┌────────▼────────────────────┐
    │   CONTEXT MANAGEMENT         │
    │  ┌──────┐ ┌───────┐ ┌─────┐ │
    │  │Index │ │Chunker│ │Hist │ │   File index → Smart chunks →
    │  │      │ │       │ │     │ │   Conversation history →
    │  └──┬───┘ └───┬───┘ └──┬──┘ │   Context payload
    │     └─────────┼────────┘     │
    │         ┌─────▼─────┐        │
    │         │  Builder  │        │   Assembles final prompt
    │         └───────────┘        │   with token budget management
    └──────────────────────────────┘
```

---

## Provider Interface

The provider layer is the foundation of Aether's provider-agnostic design. Every LLM backend implements the `LLMProvider` interface defined in `src/providers/base.ts`.

### Interface

```ts
interface LLMProvider {
  readonly name: string;          // "OpenAI", "Google Gemini"
  readonly slug: string;          // "openai", "google"

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  streamChat(messages: ChatMessage[], options?: ChatOptions, callbacks?: StreamCallbacks): Promise<void>;
  initialize(): Promise<void>;
  listModels(): Promise<string[]>;
  supportsFeature(feature: ProviderFeature): boolean;
}
```

### Provider Registry

The `ProviderRegistry` (`src/providers/registry.ts`) is a singleton that manages all registered providers:

```ts
const registry = new ProviderRegistry();
registry.register(new OpenAIProvider());
registry.register(new OllamaProvider());

// Later, in CLI handlers:
const provider = registry.get("openai");  // throws if unknown
await provider.initialize();
```

**Important:** Due to Bun's bundler behavior, `providerRegistry` must only be imported in `cli.ts`. Sub-commands receive the resolved provider *instance* rather than looking up the registry themselves. This avoids duplicate singleton instances in the bundled output.

### Features

Providers declare capabilities through the `supportsFeature()` method. Aether checks feature support before using advanced functionality:

| Feature | Checked by | Behavior when unsupported |
|---|---|---|
| `streaming` | All agents | Falls back to non-streaming `chat()` |
| `json_mode` | Reviewer, Tester | Uses markdown code fence parsing |
| `tool_calls` | (future) | — |
| `vision` | (future) | — |
| `local` | Setup wizard | Shows "runs locally" badge |
| `free` | Setup wizard | Skips API key prompt |

---

## Agent Pipeline

All three agents (generate, review, test) follow the same high-level pipeline:

```
1. SCAN ──► 2. BUILD CONTEXT ──► 3. CALL LLM ──► 4. PARSE ──► 5. WRITE / DISPLAY
```

### 1. Scan (`utils/scanner.ts`)

The scanner walks the target directory, collecting:

- **Project metadata**: `package.json`, `tsconfig.json`, detected framework
- **Source files**: All code files, their languages, sizes, and top-level symbols
- **Dependencies**: Import/export graph for context resolution
- **Test infrastructure**: Detected test runner, test file patterns

### 2. Build Context (`context/`)

The context management system enriches the LLM prompt with relevant project information:

- **File index** (`context/indexer.ts`): Crawls the project, builds a map of all source files with metadata and symbol summaries. Supports incremental updates and watch mode.
- **Smart chunker** (`context/chunker.ts`): Splits large files into semantic chunks (function boundaries, class definitions) with token counting. Respects AST structure when possible, falls back to line-based chunking.
- **History** (`context/history.ts`): Manages conversation sessions — create, load, append, clear. Persistent JSON storage in `~/.local/share/aether/history/`.
- **Builder** (`context/builder.ts`): Assembles the final context payload: system prompt + relevant chunks + conversation history + config summary, all within the token budget.

### 3. Call LLM

Each agent constructs a system prompt specific to its task:

- **Generator**: "You are a senior software engineer. Generate code based on the following specification..." Includes project style conventions, existing code patterns, and target file structure.
- **Reviewer**: "You are a code reviewer. Analyze the following code for bugs, security vulnerabilities, and style issues..." Includes file content and severity filters.
- **Tester**: "You are a test engineer. Write comprehensive tests for the following code..." Includes existing test patterns, detected framework, and coverage targets.

The agent calls `provider.chat()` (or `provider.streamChat()`) with the constructed messages.

### 4. Parse

Each agent parses the LLM response differently:

- **Generator**: Extracts code fence blocks (` ```ts ... ``` `) into file paths and contents. Parses the special `// file: path/to/file.ts` comment convention for multi-file output.
- **Reviewer**: Parses structured output into `ReviewResult` objects with file, line, severity, message, and suggested fix.
- **Tester**: Extracts test files (spec files) from code fences, then delegates to the detected test runner for execution.

### 5. Write / Display

- **Generator** (`utils/writer.ts`): Writes files to disk with safety checks — confirms before overwriting, shows diffs for edits, respects `--force` and `--dry-run`.
- **Reviewer**: Displays results in a formatted table (or JSON). With `--apply`, applies fixes using the differ (`utils/differ.ts`) and writer.
- **Tester** (`utils/runner.ts`, `utils/fixer.ts`): Runs the test suite via the detected test runner. With `--fix`, re-generates failing tests in a loop (up to 3 attempts) using the fixer.

---

## Context Management System

### Architecture

```
ContextManager (manager.ts)
    │
    ├── Indexer (indexer.ts)
    │   └── Crawls project directory → FileIndex (types.ts)
    │
    ├── Chunker (chunker.ts)
    │   └── Splits files → ContextChunk[] with token estimates
    │
    ├── History (history.ts)
    │   └── Manages sessions → HistorySession with messages
    │
    └── Builder (builder.ts)
        └── Assembles everything → ContextPayload
```

### Data Flow

1. **`ContextManager`** is created per-session with a working directory and options (max tokens, history limits, watch mode).
2. **`indexProject()`** crawls the directory, building a `FileIndex` of all source files with symbols.
3. When building context for a prompt, the **chunker** splits target files into `ContextChunk[]`, respecting token budgets.
4. The **builder** assembles the final `ContextPayload`: system prompt template + relevant chunks + recent history + project config summary — all trimmed to fit within `maxContextTokens`.
5. After the LLM responds, messages are appended to the **history session**, which prunes old messages to stay within `maxHistoryTokens`.

### Token Budgeting

Aether maintains two token budgets:

| Budget | Default | Env Var | Purpose |
|---|---|---|---|
| Context | 128,000 | `AETHER_MAX_CONTEXT_TOKENS` | Max tokens sent to LLM per request |
| History | 32,000 | `AETHER_MAX_HISTORY_TOKENS` | Max tokens retained in conversation history |

The builder prioritizes: system prompt → user message → relevant chunks → history (oldest pruned first).

---

## Low-Memory Mode (`utils/memory.ts`)

Aether detects available RAM via `/proc/meminfo` (Linux/Android) or `sysctl` (macOS). When below 2 GB:

- Sets `AETHER_LOW_MEMORY=true` in the process environment
- Reduces default chunk sizes (smaller context windows)
- Trims history more aggressively
- Uses simpler prompt templates (fewer examples)

This is critical for Termux on Android devices with limited RAM.

---

## Termux Integration (`utils/termux.ts`)

```ts
// Detection
isTermux(): boolean       // Checks AETHER_TERMUX, TERMUX_VERSION, PREFIX
isProot(): boolean        // Checks PROOT_TMP_DIR

// Path resolution
getConfigDir(): string    // Termux: $HOME/.config/aether, Linux: XDG_CONFIG_HOME
getDataDir(): string      // Termux: $PREFIX/var/lib/aether, Linux: XDG_DATA_HOME
getCacheDir(): string     // Termux: $PREFIX/tmp/aether, Linux: XDG_CACHE_HOME

// Config persistence
loadConfig(): AetherConfig
saveConfig(config): void
```

---

## File Structure Reference

```
aether-cli/
├── bin/
│   └── aether               # Shell wrapper that invokes dist/cli.js via bun/node
├── dist/
│   └── cli.js               # Bundled output (241 modules, ~1.26 MB)
├── docs/
│   ├── architecture.md      # This file
│   └── examples/            # Example workflows
├── src/
│   ├── cli.ts               # Main entry — commander.js, provider registration
│   ├── agents/
│   │   ├── generator.ts     # GeneratorAgent — prompt → files
│   │   ├── reviewer.ts      # ReviewerAgent — code → findings
│   │   └── tester.ts        # TesterAgent — code → test files → run → fix
│   ├── commands/
│   │   ├── config.ts        # In-memory config store (get/set/list/reset)
│   │   ├── context.ts       # Context index/stats/history handlers
│   │   ├── generate.ts      # Generate command → GeneratorAgent
│   │   ├── review.ts        # Review command → ReviewerAgent
│   │   ├── setup.ts         # Interactive setup wizard
│   │   └── test.ts          # Test command → TesterAgent
│   ├── context/
│   │   ├── types.ts         # FileIndex, ContextChunk, HistorySession, etc.
│   │   ├── indexer.ts       # Project file indexer
│   │   ├── chunker.ts       # Smart code chunker with token estimation
│   │   ├── builder.ts       # Context payload assembler
│   │   ├── history.ts       # Session-based conversation history
│   │   └── manager.ts       # ContextManager orchestrator
│   ├── providers/
│   │   ├── base.ts          # LLMProvider interface, ChatMessage, ChatResponse
│   │   ├── registry.ts      # ProviderRegistry singleton
│   │   ├── openai.ts        # OpenAI (GPT-4o, GPT-4, etc.)
│   │   ├── anthropic.ts     # Anthropic Claude (Sonnet, Opus, etc.)
│   │   ├── google.ts        # Google Gemini (Flash, Pro, etc.)
│   │   ├── deepseek.ts      # DeepSeek (V3, R1, etc.)
│   │   └── ollama.ts        # Ollama local models
│   ├── utils/
│   │   ├── scanner.ts       # Project structure scanner
│   │   ├── writer.ts        # Safe file writer with diff previews
│   │   ├── differ.ts        # Unified diff generation
│   │   ├── runner.ts        # Test runner detection & execution
│   │   ├── fixer.ts         # Auto-fix loop for failing tests
│   │   ├── linter.ts        # Code linting integration
│   │   ├── memory.ts        # Available RAM detection, low-memory mode
│   │   └── termux.ts        # Termux/proot detection, config paths
│   └── tests/
│       ├── generate.test.ts # Generator pipeline tests (8)
│       ├── review.test.ts   # Reviewer pipeline tests (9)
│       ├── test.test.ts     # Tester pipeline tests (10)
│       └── termux.test.ts   # Termux + config tests (17)
├── install.sh               # One-command installer (curl | bash)
├── package.json
├── tsconfig.json
├── bun.lock
└── README.md
```

---

## Design Decisions

### Why Bun?

Bun provides fast startup (critical for CLI tools), native TypeScript support without a compile step during development, and a bundler that produces a single-file Node.js-compatible output. This matters especially on Termux where startup latency is noticeable.

### Why Commander.js?

Lightweight, well-maintained, no UI framework dependency. Commander.js provides argument parsing, help text generation, and subcommand routing without pulling in React or other heavy dependencies. The CLI is text-only by design — no Ink, no TUI frameworks.

### Why a Custom Provider Layer (not Vercel AI SDK)?

The Vercel AI SDK is powerful but adds ~50+ transitive dependencies. Aether's provider interface is ~85 lines of TypeScript — the same abstraction at a fraction of the size. Each provider implementation is ~200-300 lines of straightforward API client code.

### Why `bun run` for Tests (not `bun test`)?

The test suites use a custom manual harness that gives full control over mocking, setup/teardown, and output formatting. `bun test` is used internally by some suites, but the termux tests require environment manipulation that's easier with the manual harness.
