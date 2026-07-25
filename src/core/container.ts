/**
 * Service Container — minimal typed dependency injection for Aether CLI.
 *
 * NOT a full DI framework. Just a typed registry that supports:
 * - Singleton instances (register)
 * - Lazy factories (registerFactory — created on first get)
 * - All core services registered here, accessed by any module
 */

export type ServiceFactory<T> = (container: ServiceContainer) => T;

export class ServiceContainer {
  private services: Map<string, unknown> = new Map();
  private factories: Map<string, ServiceFactory<unknown>> = new Map();

  /** Register a pre-created singleton instance. */
  register<T>(name: string, instance: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered.`);
    }
    this.services.set(name, instance);
  }

  /** Register a lazy factory. Instance created on first get(). */
  registerFactory<T>(name: string, factory: ServiceFactory<T>): void {
    if (this.factories.has(name) || this.services.has(name)) {
      throw new Error(`Service or factory "${name}" is already registered.`);
    }
    this.factories.set(name, factory as ServiceFactory<unknown>);
  }

  /** Get a service. Creates from factory if not yet instantiated. */
  get<T>(name: string): T {
    // Already instantiated?
    if (this.services.has(name)) {
      return this.services.get(name) as T;
    }

    // Has a factory? Create and cache
    if (this.factories.has(name)) {
      const factory = this.factories.get(name)!;
      const instance = factory(this);
      this.services.set(name, instance);
      return instance as T;
    }

    throw new Error(
      `Service "${name}" not found. Registered services: ${this.list().join(", ") || "(none)"}`,
    );
  }

  /** Check if a service exists (instantiated OR factory). */
  has(name: string): boolean {
    return this.services.has(name) || this.factories.has(name);
  }

  /** Remove a service and its factory. */
  remove(name: string): void {
    this.services.delete(name);
    this.factories.delete(name);
  }

  /** List all registered service and factory names. */
  list(): string[] {
    const names = new Set<string>();
    for (const k of this.services.keys()) names.add(k);
    for (const k of this.factories.keys()) names.add(k);
    return Array.from(names).sort();
  }

  /** Remove all services and factories (useful for tests). */
  reset(): void {
    this.services.clear();
    this.factories.clear();
  }
}

/** Singleton container — all Aether services live here. */
export const container = new ServiceContainer();
