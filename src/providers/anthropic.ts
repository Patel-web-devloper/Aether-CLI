/**
 * Anthropic Claude provider implementation.
 *
 * Uses the official `@anthropic-ai/sdk` package.
 * Slug: "anthropic"
 * Env var: ANTHROPIC_API_KEY
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  StreamCallbacks,
  ProviderFeature,
} from "./base.js";

const ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-haiku-3.5",
];

export class AnthropicProvider implements LLMProvider {
  readonly name = "Anthropic Claude";
  readonly slug = "anthropic";

  private client: Anthropic | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is not set. " +
          "Set it via: export ANTHROPIC_API_KEY=sk-ant-...",
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  private ensureClient(): Anthropic {
    if (!this.client) {
      throw new Error(
        "Anthropic provider is not initialized. Call initialize() first.",
      );
    }
    return this.client;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const client = this.ensureClient();
    const model = options?.model ?? ANTHROPIC_MODELS[0];

    try {
      const systemMessages = messages.filter((m) => m.role === "system");
      const userAssistantMessages = messages.filter(
        (m) => m.role !== "system",
      );

      const systemPrompt =
        systemMessages.length > 0
          ? systemMessages.map((m) => m.content).join("\n")
          : undefined;

      const completion = await client.messages.create({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature,
        top_p: options?.topP,
        system: systemPrompt,
        messages: userAssistantMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        stop_sequences: options?.stopSequences,
        ...(options?.extra as Record<string, unknown>),
      });

      const textContent = completion.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        content: textContent,
        model: completion.model,
        usage: {
          promptTokens: completion.usage.input_tokens,
          completionTokens: completion.usage.output_tokens,
          totalTokens:
            completion.usage.input_tokens + completion.usage.output_tokens,
        },
        finishReason: mapStopReason(completion.stop_reason),
      };
    } catch (err: unknown) {
      throw wrapError("Anthropic", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const client = this.ensureClient();
    const model = options?.model ?? ANTHROPIC_MODELS[0];

    try {
      const systemMessages = messages.filter((m) => m.role === "system");
      const userAssistantMessages = messages.filter(
        (m) => m.role !== "system",
      );

      const systemPrompt =
        systemMessages.length > 0
          ? systemMessages.map((m) => m.content).join("\n")
          : undefined;

      const stream = await client.messages.stream({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature,
        top_p: options?.topP,
        system: systemPrompt,
        messages: userAssistantMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        stop_sequences: options?.stopSequences,
        ...(options?.extra as Record<string, unknown>),
      });

      stream.on("text", (text: string) => {
        callbacks?.onToken?.(text);
      });

      const finalMessage = await stream.finalMessage();

      const textContent = finalMessage.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      callbacks?.onDone?.({
        content: textContent,
        model: finalMessage.model,
        usage: {
          promptTokens: finalMessage.usage.input_tokens,
          completionTokens: finalMessage.usage.output_tokens,
          totalTokens:
            finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
        },
        finishReason: mapStopReason(finalMessage.stop_reason),
      });
    } catch (err: unknown) {
      const error = wrapError("Anthropic", err);
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
    return [...ANTHROPIC_MODELS];
  }
}

function mapStopReason(
  reason: string | null,
): ChatResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
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
