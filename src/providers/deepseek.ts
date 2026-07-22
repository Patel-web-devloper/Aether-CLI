/**
 * DeepSeek provider implementation.
 *
 * DeepSeek offers an OpenAI-compatible API.
 * Slug: "deepseek"
 * Base URL: https://api.deepseek.com/v1
 * Env var: DEEPSEEK_API_KEY
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

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner"];

export class DeepSeekProvider implements LLMProvider {
  readonly name = "DeepSeek";
  readonly slug = "deepseek";

  private client: OpenAI | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY environment variable is not set. " +
          "Set it via: export DEEPSEEK_API_KEY=sk-...",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "DeepSeek provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? "deepseek-chat";

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
        throw new Error("No response from DeepSeek.");
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
      throw wrapError("DeepSeek", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? "deepseek-chat";

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
      const error = wrapError("DeepSeek", err);
      callbacks?.onError?.(error);
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const supported: ProviderFeature[] = [
      "streaming",
      "tool_calls",
      "json_mode",
      "multilingual",
    ];
    return supported.includes(feature);
  }

  async listModels(): Promise<string[]> {
    return [...DEEPSEEK_MODELS];
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
