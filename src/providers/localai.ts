/**
 * LocalAI provider implementation.
 *
 * LocalAI is a free, open-source alternative to OpenAI, runs locally.
 * Slug: "localai"
 * Default base URL: http://localhost:8080/v1
 * Env var: LOCALAI_API_KEY (optional)
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

const DEFAULT_BASE_URL = "http://localhost:8080/v1";

export class LocalAIProvider implements LLMProvider {
  readonly name = "LocalAI";
  readonly slug = "localai";

  private client: OpenAI | null = null;
  private baseUrl: string;
  private _initialized = false;

  constructor() {
    this.baseUrl = process.env.LOCALAI_BASE_URL ?? DEFAULT_BASE_URL;
  }

  async initialize(): Promise<void> {
    const url = new URL("/v1/models", this.baseUrl);

    let connected = false;
    try {
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) connected = true;
    } catch {
      // Connection refused or timeout — LocalAI isn't running
    }

    if (connected) {
      const apiKey = process.env.LOCALAI_API_KEY ?? "localai";
      this.client = new OpenAI({ apiKey, baseURL: this.baseUrl });
      this._initialized = true;
    } else {
      console.warn(
        "Warning: LocalAI server is not reachable at " +
          url.toString() +
          ". Start it with `local-ai run`.",
      );
      this._initialized = false;
    }
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "LocalAI is not running. Start it with `local-ai run` " +
          "and then call initialize() again.",
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
        "No LocalAI models available. Load a model in LocalAI first.",
      );
    }

    try {
      const completion = await client.chat.completions.create({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        ...(options?.extra as Record<string, unknown>),
      });

      const choice = completion.choices[0];
      if (!choice) throw new Error("No response from LocalAI.");

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
      throw wrapError("LocalAI", err);
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
      callbacks?.onError?.(
        new Error("No LocalAI models available. Load a model in LocalAI first."),
      );
      return;
    }

    try {
      const stream = await client.chat.completions.create({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
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

      callbacks?.onDone?.({ content: fullContent, model, finishReason });
    } catch (err: unknown) {
      callbacks?.onError?.(wrapError("LocalAI", err));
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return ["streaming", "local", "free"].includes(feature);
  }

  async listModels(): Promise<string[]> {
    if (!this._initialized) {
      try {
        const url = new URL("/v1/models", this.baseUrl);
        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const data = (await response.json()) as {
            data?: Array<{ id: string }>;
          };
          return (data.data ?? []).map((m) => m.id);
        }
      } catch {
        // Server not reachable
      }
      return [];
    }

    try {
      const client = this.ensureClient();
      const list = await client.models.list();
      return list.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}

function mapFinishReason(reason: string | null | undefined): ChatResponse["finishReason"] {
  switch (reason) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    case "tool_calls": return "tool_calls";
    default: return "stop";
  }
}

function wrapError(provider: string, err: unknown): Error {
  if (err instanceof Error) return new Error(`[${provider}] ${err.message}`);
  return new Error(`[${provider}] Unknown error: ${String(err)}`);
}
