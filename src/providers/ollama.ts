/**
 * Ollama provider implementation.
 *
 * Ollama runs LLMs locally via an OpenAI-compatible API.
 * Slug: "ollama"
 * Default base URL: http://localhost:11434/v1
 * No API key required.
 * Features: local, free, streaming.
 */

import OpenAI from "openai";
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  StreamCallbacks,
  ProviderFeature,
} from "./base.js";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export class OllamaProvider implements LLMProvider {
  readonly name = "Ollama (Local)";
  readonly slug = "ollama";

  private client: OpenAI | null = null;
  private baseUrl: string;
  private _initialized = false;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
  }

  async initialize(): Promise<void> {
    const url = new URL("/api/tags", this.baseUrl.replace(/\/v1\/?$/, ""));

    let connected = false;
    try {
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        connected = true;
      }
    } catch {
      // Connection refused or timeout — Ollama server isn't running
    }

    if (connected) {
      this.client = new OpenAI({
        apiKey: "ollama", // Ollama doesn't need a real API key
        baseURL: this.baseUrl,
      });
      this._initialized = true;
    } else {
      // Don't throw — Ollama may not be running, that's fine
      // The user can still list models (returns empty) and will get
      // a clear error if they try to actually use it.
      console.warn(
        "Warning: Ollama server is not reachable at " +
          url.toString() +
          ". Start it with `ollama serve`.",
      );
      this._initialized = false;
    }
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "Ollama server is not running. Start it with `ollama serve` " +
          "and then call initialize() again, or check OLLAMA_BASE_URL.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? (await this.listModels())[0];

    if (!model) {
      throw new Error(
        "No Ollama models available. Pull a model first, e.g. `ollama pull llama3.2`.",
      );
    }

    try {
      const completion = await client.chat.completions.create({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        ...(options?.extra as Record<string, unknown>),
      });

      const choice = completion.choices[0];
      if (!choice) {
        throw new Error("No response from Ollama.");
      }

      return {
        content: choice.message.content ?? "",
        model: completion.model,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        finishReason: mapFinishReason(choice.finish_reason),
      };
    } catch (err: unknown) {
      throw wrapError("Ollama", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? (await this.listModels())[0];

    if (!model) {
      const error = new Error(
        "No Ollama models available. Pull a model first, e.g. `ollama pull llama3.2`.",
      );
      callbacks?.onError?.(error);
      return;
    }

    try {
      const stream = await client.chat.completions.create({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        stream: true,
        ...(options?.extra as Record<string, unknown>),
      });

      let fullContent = "";
      let finishReason: ChatResponse["finishReason"] = "stop";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          callbacks?.onToken?.(delta);
        }
        if (chunk.choices[0]?.finish_reason) {
          finishReason = mapFinishReason(chunk.choices[0].finish_reason);
        }
      }

      callbacks?.onDone?.({
        content: fullContent,
        model: model,
        finishReason,
      });
    } catch (err: unknown) {
      const error = wrapError("Ollama", err);
      callbacks?.onError?.(error);
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const supported: ProviderFeature[] = ["streaming", "local", "free"];
    return supported.includes(feature);
  }

  async listModels(): Promise<string[]> {
    // If not initialized yet or client isn't set, we can try to discover
    // models from the Ollama REST API directly
    if (!this._initialized) {
      try {
        const url = new URL("/api/tags", this.baseUrl.replace(/\/v1\/?$/, ""));
        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const data = (await response.json()) as {
            models?: Array<{ name: string }>;
          };
          return (data.models ?? []).map((m: { name: string }) => m.name);
        }
      } catch {
        // Server not reachable
      }
      return [];
    }

    // Use the OpenAI-compatible /models endpoint
    try {
      const client = this.ensureClient();
      const list = await client.models.list();
      return list.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}

function mapFinishReason(
  reason: string | null | undefined,
): ChatResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

function wrapError(provider: string, err: unknown): Error {
  if (err instanceof Error) {
    return new Error(`[${provider}] ${err.message}`);
  }
  return new Error(`[${provider}] Unknown error: ${String(err)}`);
}
