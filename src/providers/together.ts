/**
 * Together AI provider implementation.
 *
 * Together AI offers fast inference via an OpenAI-compatible API.
 * Slug: "together"
 * Base URL: https://api.together.xyz/v1
 * Env var: TOGETHER_API_KEY
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

const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
const TOGETHER_MODELS = [
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
  "mistralai/Mixtral-8x7B-Instruct-v0.1",
];

export class TogetherProvider implements LLMProvider {
  readonly name = "Together AI";
  readonly slug = "together";

  private client: OpenAI | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.TOGETHER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TOGETHER_API_KEY environment variable is not set. " +
          "Set it via: export TOGETHER_API_KEY=...",
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: TOGETHER_BASE_URL });
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "Together AI provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? TOGETHER_MODELS[0];

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
      if (!choice) throw new Error("No response from Together AI.");

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
      throw wrapError("Together AI", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? TOGETHER_MODELS[0];

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
      callbacks?.onError?.(wrapError("Together AI", err));
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return ["streaming", "tool_calls", "json_mode", "multilingual"].includes(feature);
  }

  async listModels(): Promise<string[]> {
    return [...TOGETHER_MODELS];
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
