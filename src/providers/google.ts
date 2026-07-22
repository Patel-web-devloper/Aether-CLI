/**
 * Google Gemini provider implementation.
 *
 * Uses the official `@google/generative-ai` package.
 * Slug: "google"
 * Env var: GEMINI_API_KEY
 */

import {
  GoogleGenerativeAI,
  type Content,
  type Part,
} from "@google/generative-ai";
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  StreamCallbacks,
  ProviderFeature,
} from "./base.js";

const GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

export class GoogleProvider implements LLMProvider {
  readonly name = "Google Gemini";
  readonly slug = "google";

  private genAI: GoogleGenerativeAI | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY environment variable is not set. " +
          "Set it via: export GEMINI_API_KEY=...",
      );
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  private ensureClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      throw new Error(
        "Google provider is not initialized. Call initialize() first.",
      );
    }
    return this.genAI;
  }

  /**
   * Convert our ChatMessage format to Gemini's Content format.
   * Gemini uses "user" and "model" roles (no "system").
   * System messages are prepended to the first user message.
   */
  private toGeminiContent(messages: ChatMessage[]): {
    contents: Content[];
    systemInstruction?: string;
  } {
    const systemParts: string[] = [];
    const contents: Content[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "system") {
        systemParts.push(msg.content);
        continue;
      }

      // If this is the first user message and we have system parts, prepend them
      const parts: Part[] = [{ text: msg.content }];
      if (
        msg.role === "user" &&
        contents.length === 0 &&
        systemParts.length > 0
      ) {
        parts.unshift({ text: `[System Instructions]\n${systemParts.join("\n")}\n[/System Instructions]\n\n` });
      }

      const role = msg.role === "assistant" ? "model" : "user";
      contents.push({ role, parts });
    }

    // Fallback: if no user message absorbed the system prompt, use it as systemInstruction
    if (systemParts.length > 0 && contents.length === 0) {
      return {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        systemInstruction: systemParts.join("\n"),
      };
    }

    return {
      contents,
      systemInstruction: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    };
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const genAI = this.ensureClient();
    const modelName = options?.model ?? GEMINI_MODELS[0];

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: options?.maxTokens,
          temperature: options?.temperature,
          topP: options?.topP,
          stopSequences: options?.stopSequences,
        },
      });

      const { contents, systemInstruction } = this.toGeminiContent(messages);

      const result = await model.generateContent({
        contents,
        systemInstruction,
      });

      const response = result.response;
      const text = response.text();

      return {
        content: text,
        model: modelName,
        usage: response.usageMetadata
          ? {
              promptTokens: response.usageMetadata.promptTokenCount,
              completionTokens: response.usageMetadata.candidatesTokenCount,
              totalTokens: response.usageMetadata.totalTokenCount,
            }
          : undefined,
        finishReason: mapFinishReason(response.candidates?.[0]?.finishReason),
      };
    } catch (err: unknown) {
      throw wrapError("Google Gemini", err);
    }
  }

  async streamChat(
    messages: ChatMessage[],
    options?: ChatOptions,
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    const genAI = this.ensureClient();
    const modelName = options?.model ?? GEMINI_MODELS[0];

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: options?.maxTokens,
          temperature: options?.temperature,
          topP: options?.topP,
          stopSequences: options?.stopSequences,
        },
      });

      const { contents, systemInstruction } = this.toGeminiContent(messages);

      const result = await model.generateContentStream({
        contents,
        systemInstruction,
      });

      let fullContent = "";
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullContent += text;
          callbacks?.onToken?.(text);
        }
      }

      const response = await result.response;
      callbacks?.onDone?.({
        content: fullContent,
        model: modelName,
        usage: response.usageMetadata
          ? {
              promptTokens: response.usageMetadata.promptTokenCount,
              completionTokens: response.usageMetadata.candidatesTokenCount,
              totalTokens: response.usageMetadata.totalTokenCount,
            }
          : undefined,
        finishReason: mapFinishReason(
          response.candidates?.[0]?.finishReason,
        ),
      });
    } catch (err: unknown) {
      const error = wrapError("Google Gemini", err);
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
    return [...GEMINI_MODELS];
  }
}

function mapFinishReason(
  reason: string | undefined,
): ChatResponse["finishReason"] {
  if (!reason) return "stop";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content_filter";
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
