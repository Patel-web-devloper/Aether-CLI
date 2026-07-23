/**
 * Custom OpenAI-compatible provider implementation.
 *
 * Escape hatch for ANY OpenAI-compatible API endpoint.
 * Slug: "custom"
 * Env vars: CUSTOM_OPENAI_API_KEY, CUSTOM_OPENAI_BASE_URL
 * Base URL: from env or config
 * Models: from config or discoverable dynamically
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

export class CustomOpenAIProvider implements LLMProvider {
  readonly name = "Custom (OpenAI-Compatible)";
  readonly slug = "custom";

  private client: OpenAI | null = null;
  private baseUrl: string;
  private _initialized = false;

  constructor() {
    this.baseUrl = process.env.CUSTOM_OPENAI_BASE_URL ?? "http://localhost:8080/v1";
  }

  async initialize(): Promise<void> {
    const apiKey = process.env.CUSTOM_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "CUSTOM_OPENAI_API_KEY environment variable is not set. " +
          "Set it via: export CUSTOM_OPENAI_API_KEY=...",
      );
    }

    const baseUrl = process.env.CUSTOM_OPENAI_BASE_URL ?? this.baseUrl;

    try {
      this.client = new OpenAI({ apiKey, baseURL: baseUrl });
      this._initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to initialize Custom OpenAI provider at ${baseUrl}: ${msg}`,
      );
    }
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "Custom OpenAI provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? (await this.listModels())[0] ?? "default";

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
      if (!choice) throw new Error("No response from custom provider.");

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
      throw wrapError("Custom OpenAI", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? (await this.listModels())[0] ?? "default";

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
      callbacks?.onError?.(wrapError("Custom OpenAI", err));
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return ["streaming", "tool_calls", "json_mode", "multilingual"].includes(feature);
  }

  async listModels(): Promise<string[]> {
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
