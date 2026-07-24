# Aether CLI — Providers

Aether CLI supports 13 LLM providers. Every provider implements the `LLMProvider` interface and can be used with any command via `--provider <slug>`.

---

## Provider Table

| # | Provider | Slug | API Key Env Var | Cloud / Local | Base URL |
|---|---|---|---|---|---|
| 1 | **OpenAI** | `openai` | `OPENAI_API_KEY` | Cloud | `https://api.openai.com/v1` |
| 2 | **Anthropic Claude** | `anthropic` | `ANTHROPIC_API_KEY` | Cloud | `https://api.anthropic.com/v1` |
| 3 | **Google Gemini** | `google` | `GEMINI_API_KEY` | Cloud | `https://generativelanguage.googleapis.com/v1beta` |
| 4 | **DeepSeek** | `deepseek` | `DEEPSEEK_API_KEY` | Cloud | `https://api.deepseek.com/v1` |
| 5 | **Ollama** | `ollama` | `OLLAMA_BASE_URL` (optional) | Local | `http://localhost:11434/v1` |
| 6 | **NVIDIA NIM** | `nvidia` | `NVIDIA_API_KEY` | Cloud | `https://integrate.api.nvidia.com/v1` |
| 7 | **OpenRouter** | `openrouter` | `OPENROUTER_API_KEY` | Cloud | `https://openrouter.ai/api/v1` |
| 8 | **Groq** | `groq` | `GROQ_API_KEY` | Cloud | `https://api.groq.com/openai/v1` |
| 9 | **Together AI** | `together` | `TOGETHER_API_KEY` | Cloud | `https://api.together.xyz/v1` |
| 10 | **LM Studio** | `lmstudio` | — | Local | `http://localhost:1234/v1` |
| 11 | **LocalAI** | `localai` | `LOCALAI_API_KEY` (optional) | Local | `http://localhost:8080/v1` |
| 12 | **vLLM** | `vllm` | — | Local | `http://localhost:8000/v1` |
| 13 | **Custom OpenAI** | `custom` | `CUSTOM_OPENAI_API_KEY` | Cloud | `OPENAI_BASE_URL` or user-configured |

---

## Features by Provider

| Feature | OpenAI | Anthropic | Gemini | DeepSeek | Ollama | NVIDIA | OpenRouter | Groq | Together | LM Studio | LocalAI | vLLM | Custom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Streaming | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Vision | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — |
| Tool Calls | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| JSON Mode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Multilingual | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — | — | — |
| Local | — | — | — | — | ✓ | — | — | — | — | ✓ | ✓ | ✓ | — |
| Free | — | — | — | — | ✓ | — | — | — | — | ✓ | ✓ | ✓ | — |

---

## Configuration

### Setting a Default Provider

```bash
# Via config command
aether config set provider openai

# Via setup wizard
aether setup
```

### Per-Command Provider Selection

```bash
aether generate "..." --provider anthropic --model claude-sonnet-4-20250514
aether review ./src --provider deepseek
aether test ./src --provider groq
```

### API Key Configuration

Set API keys as environment variables before running Aether:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."
export DEEPSEEK_API_KEY="..."
export NVIDIA_API_KEY="..."
export OPENROUTER_API_KEY="..."
export GROQ_API_KEY="..."
export TOGETHER_API_KEY="..."
export CUSTOM_OPENAI_API_KEY="..."
```

For local providers, API keys are optional:
- **Ollama**: Set `OLLAMA_BASE_URL` to point to a remote instance (default: `http://localhost:11434/v1`)
- **LM Studio**: No key required (default: `http://localhost:1234/v1`)
- **LocalAI**: Optional `LOCALAI_API_KEY` for authenticated instances
- **vLLM**: No key required (default: `http://localhost:8000/v1`)

### Custom Base URLs

Override the base URL for any provider:

```bash
aether config set baseUrl "https://my-proxy.example.com/v1"
```

The `custom` provider reads from `OPENAI_BASE_URL` (or `CUSTOM_OPENAI_BASE_URL`) and `CUSTOM_OPENAI_API_KEY`:

```bash
export OPENAI_BASE_URL="https://my-openai-compatible-api.example.com/v1"
export CUSTOM_OPENAI_API_KEY="sk-..."
aether generate "..." --provider custom
```

---

## Adding a Custom Provider

To add a new provider to Aether CLI:

### 1. Create the Provider Class

Create `src/providers/<slug>.ts`:

```typescript
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ProviderFeature,
  StreamCallbacks,
} from "./base.js";

export class MyProvider implements LLMProvider {
  readonly name = "My Provider";
  readonly slug = "myprovider";

  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.MY_API_KEY ?? "";
    this.baseUrl = process.env.MY_BASE_URL ?? "https://api.myprovider.com/v1";
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("MY_API_KEY environment variable is not set");
    }
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model ?? "default-model",
        messages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: options?.model ?? "default-model",
      finishReason: "stop",
    };
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    // Implement streaming if supported
    // Call callbacks?.onToken(token) for each chunk
    // Call callbacks?.onDone(response) at the end
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const supported: ProviderFeature[] = ["streaming", "json_mode"];
    return supported.includes(feature);
  }

  async listModels(): Promise<string[]> {
    return ["model-v1", "model-v2", "model-v3"];
  }
}
```

### 2. Register in `src/cli.ts`

```typescript
import { MyProvider } from "./providers/myprovider.js";

// Add after existing provider registrations
providerRegistry.register(new MyProvider());
```

### 3. Update Documentation

- Add the provider to the table in this file
- Update the features matrix
- Add the env var to the `env` command's `envVarMap` in `src/cli.ts`
- Update the doctor command's `envVarMap` in `src/commands/doctor.ts`

### 4. Add Tests

Create a test file or add to existing tests:

```typescript
const provider = new MyProvider();
const models = await provider.listModels();
if (models.length === 0) throw new Error("Provider has no models");
```

---

## Provider Interface Reference

All providers implement the `LLMProvider` interface defined in `src/providers/base.ts`:

```typescript
interface LLMProvider {
  readonly name: string;
  readonly slug: string;

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void>;
  initialize(): Promise<void>;
  listModels(): Promise<string[]>;
  supportsFeature(feature: ProviderFeature): boolean;
}
```

### ChatMessage

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
```

### ChatOptions

```typescript
interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}
```

### ChatResponse

```typescript
interface ChatResponse {
  content: string;
  model: string;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls";
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}
```

### StreamCallbacks

```typescript
interface StreamCallbacks {
  onToken?: (token: string) => void;
  onDone?: (response: ChatResponse) => void;
  onError?: (error: Error) => void;
}
```

### ProviderFeature

```typescript
type ProviderFeature =
  | "streaming"
  | "vision"
  | "tool_calls"
  | "json_mode"
  | "multilingual"
  | "local"
  | "free";
```
