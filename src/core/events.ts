/**
 * Event Bus — lightweight typed event system for Aether CLI.
 * Uses Node.js EventEmitter internally, wraps with full type safety.
 *
 * Zero dependencies beyond Node.js built-in 'events'.
 * All agent, task, provider, memory, plugin, and system events flow through here.
 */

import { EventEmitter } from "node:events";

// ── Event type definitions ──────────────────────────────────────────────────

export type AgentLifecycleEvent =
  | { type: "agent:start"; agent: string; taskId: string; timestamp: number }
  | { type: "agent:done"; agent: string; taskId: string; result: unknown; duration: number }
  | { type: "agent:error"; agent: string; taskId: string; error: Error; duration: number }
  | { type: "agent:stream"; agent: string; taskId: string; token: string };

export type TaskLifecycleEvent =
  | { type: "task:queued"; taskId: string; priority: number }
  | { type: "task:started"; taskId: string }
  | { type: "task:completed"; taskId: string; result: unknown }
  | { type: "task:failed"; taskId: string; error: Error }
  | { type: "task:cancelled"; taskId: string };

export type SystemEvent =
  | { type: "provider:called"; provider: string; model: string; tokens: number; latency: number }
  | { type: "memory:updated"; key: string }
  | { type: "plugin:loaded"; name: string; version: string }
  | { type: "plugin:unloaded"; name: string }
  | { type: "system:startup"; duration: number }
  | { type: "system:shutdown" };

export type WorkflowLifecycleEvent =
  | { type: "workflow:start"; workflow: string; steps: string[]; timestamp: number }
  | { type: "workflow:step-start"; workflow: string; step: string; agent: string; timestamp: number }
  | { type: "workflow:step-done"; workflow: string; step: string; agent: string; status: "success" | "failed" | "skipped"; duration: number }
  | { type: "workflow:done"; workflow: string; success: boolean; duration: number };

export type AetherEvent = AgentLifecycleEvent | TaskLifecycleEvent | SystemEvent | WorkflowLifecycleEvent;

export type EventHandler<T extends AetherEvent> = (event: T) => void;

// ── EventBus class ──────────────────────────────────────────────────────────

export class EventBus {
  private emitter: EventEmitter;
  private handlers: Map<string, Set<EventHandler<AetherEvent>>> = new Map();

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100); // plenty for agent + task + system events
  }

  /** Subscribe to a typed event. Returns unsubscribe function. */
  on<T extends AetherEvent>(type: T["type"], handler: EventHandler<T>): () => void {
    const key = type as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as EventHandler<AetherEvent>);
    this.emitter.on(key, handler);

    return () => this.off(type, handler);
  }

  /** Remove a handler. */
  off<T extends AetherEvent>(type: T["type"], handler: EventHandler<T>): void {
    const key = type as string;
    const set = this.handlers.get(key);
    if (set) {
      set.delete(handler as EventHandler<AetherEvent>);
    }
    this.emitter.off(key, handler);
  }

  /** Emit a typed event. */
  emit<T extends AetherEvent>(event: T): void {
    this.emitter.emit(event.type as string, event);
  }

  /** Subscribe once — handler auto-removed after first call. */
  once<T extends AetherEvent>(type: T["type"], handler: EventHandler<T>): void {
    const wrapper = (event: AetherEvent) => {
      handler(event as T);
    };
    const key = type as string;
    this.emitter.once(key, wrapper);
  }

  /** Count listeners for an event type. */
  listenerCount(type: string): number {
    return this.emitter.listenerCount(type);
  }

  /** Remove all listeners (useful for tests). */
  removeAll(): void {
    this.emitter.removeAllListeners();
    this.handlers.clear();
  }
}

/** Singleton — the one event bus for the entire CLI. */
export const eventBus = new EventBus();
