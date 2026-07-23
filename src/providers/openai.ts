/**
 * OpenAI provider implementation.
 *
 * Uses the official `openai` npm package.
 * Supports ALL OpenAI-compatible endpoints via configurable baseUrl.
 * Slug: "openai"
 * Env var: OPENAI_API_KEY
 * Optional env: OPENAI_BASE_URL, OPENAI_ORG_ID
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

const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"];

export interface OpenAIOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  timeout?: number;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "OpenAI";
  readonly slug = "openai";

  private client: OpenAI | null = null;
  private options: OpenAIOptions;

  constructor(options?: OpenAIOptions) {
    this.options = options ?? {};
  }

  async initialize(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is not set. " +
          "Set it via: export OPENAI_API_KEY=sk-...",
      );
    }

    const baseURL = this.options.baseUrl ?? process.env.OPENAI_BASE_URL;
    const organization = this.options.organization ?? process.env.OPENAI_ORG_ID;
    const defaultHeaders = this.options.headers;
    const timeout = this.options.timeout ?? (process.env.OPENAI_TIMEOUT ? parseInt(process.env.OPENAI_TIMEOUT, 10) : undefined);

    const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey,
    };

    if (baseURL) clientOpts.baseURL = baseURL;
    if (organization) clientOpts.organization = organization;
    if (defaultHeaders) clientOpts.defaultHeaders = defaultHeaders;
    if (timeout) clientOpts.timeout = timeout;

    this.client = new OpenAI(clientOpts);
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      throw new Error(
        "OpenAI provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? "gpt-4o";

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
        throw new Error("No response from OpenAI.");
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
      throw wrapError("OpenAI", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? "gpt-4o";

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
      const error = wrapError("OpenAI", err);
      callbacks?.onError?.(error);
    }
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const supported: ProviderFeature[] = [
      "streaming",
      "vision",
      "tool_calls",
      "json_mode",
      "multilingual",
    ];
    return supported.includes(feature);
  }

  async listModels(): Promise<string[]> {
    return [...OPENAI_MODELS];
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
