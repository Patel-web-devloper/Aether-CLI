/**
 * Abstract provider interface for all LLM backends.
 *
 * Each provider (OpenAI, Anthropic, Google, Ollama, etc.) implements this interface.
 * This keeps the CLI provider-agnostic — swap backends with a flag.
 */

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options passed to chat/streamChat calls. */
export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  // Provider-specific passthrough
  extra?: Record<string, unknown>;
}

/** Response from a completed chat call. */
export interface ChatResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls";
}

/** Callbacks for streaming chat responses. */
export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onDone?: (response: ChatResponse) => void;
  onError?: (error: Error) => void;
}

/**
 * Features a provider may or may not support.
 * The CLI can check before using advanced functionality.
 */
export type ProviderFeature =
  | "streaming"
  | "vision"
  | "tool_calls"
  | "json_mode"
  | "multilingual"
  | "local" // runs locally (no network needed)
  | "free"; // no API key / billing required

/**
 * The LLMProvider interface.
 * Every model backend must implement this.
 */
export interface LLMProvider {
  /** Human-readable name, e.g. "OpenAI", "Google Gemini". */
  readonly name: string;

  /** Short slug used on the CLI, e.g. "openai", "google". */
  readonly slug: string;

  /** Send a chat completion and get back the full response. */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a chat completion, calling callbacks as tokens arrive. */
  streamChat(messages: ChatMessage[], options?: ChatOptions, callbacks?: StreamCallbacks): Promise<void>;

  /** Check whether this provider supports a given feature. */
  supportsFeature(feature: ProviderFeature): boolean;

  /** List available models for this provider. */
  listModels(): Promise<string[]>;

  /**
   * Initialize the provider (validate API keys, check connectivity).
   * Called once when the provider is first registered or used.
   */
  initialize(): Promise<void>;
}
