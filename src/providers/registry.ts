import type { LLMProvider } from "./base.js";
import chalk from "chalk";

/**
 * Provider registry.
 *
 * Manages all registered LLM providers. The CLI uses this to resolve
 * `--provider openai` into the actual provider instance.
 *
 * Usage:
 *   registry.register(new OpenAIProvider());
 *   const provider = registry.get("openai");
 */
class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();

  /** Register a provider. */
  register(provider: LLMProvider): void {
    const slug = provider.slug.toLowerCase();
    if (this.providers.has(slug)) {
      console.warn(chalk.yellow(`Warning: Provider "${slug}" already registered. Overwriting.`));
    }
    this.providers.set(slug, provider);
  }

  /** Retrieve a provider by slug. Throws if not found. */
  get(slug: string): LLMProvider {
    const normalized = slug.toLowerCase();
    const provider = this.providers.get(normalized);
    if (!provider) {
      const available = this.list().join(", ");
      throw new Error(
        `Unknown provider "${slug}". Available providers: ${available || "(none registered)"}`,
      );
    }
    return provider;
  }

  /** Try to get a provider, returning undefined if not found. */
  tryGet(slug: string): LLMProvider | undefined {
    return this.providers.get(slug.toLowerCase());
  }

  /** List all registered provider slugs. */
  list(): string[] {
    return Array.from(this.providers.keys()).sort();
  }

  /** Check if a provider is registered. */
  has(slug: string): boolean {
    return this.providers.has(slug.toLowerCase());
  }

  /** Remove a provider. */
  unregister(slug: string): boolean {
    return this.providers.delete(slug.toLowerCase());
  }

  /** Get the number of registered providers. */
  get size(): number {
    return this.providers.size;
  }
}

/** Singleton registry instance. */
export const providerRegistry = new ProviderRegistry();
