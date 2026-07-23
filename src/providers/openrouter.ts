/**
 * OpenRouter provider implementation.
 *
 * OpenRouter is a unified API gateway that routes to multiple LLM providers.
 * Slug: "openrouter"
 * Base URL: https://openrouter.ai/api/v1
 * Env var: OPENROUTER_API_KEY
 * Features: all cloud features + can route to any model
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS = [
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4",
  "google/gemini-2.5-pro",
  "meta-llama/llama-4-maverick",
  "deepseek/deepseek-chat",
];

export class OpenRouterProvider implements LLMProvider {
  readonly name = "OpenRouter";
  readonly slug = "openrouter";

  private client: OpenAI | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY environment variable is not set. " +
          "Set it via: export OPENROUTER_API_KEY=...",
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "OpenRouter provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? OPENROUTER_MODELS[0];

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
      if (!choice) throw new Error("No response from OpenRouter.");

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
      throw wrapError("OpenRouter", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? OPENROUTER_MODELS[0];

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
      callbacks?.onError?.(wrapError("OpenRouter", err));
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return ["streaming", "vision", "tool_calls", "json_mode", "multilingual"].includes(feature);
  }

  async listModels(): Promise<string[]> {
    return [...OPENROUTER_MODELS];
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
