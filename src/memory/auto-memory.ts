import type { EventBus, AgentLifecycleEvent, TaskLifecycleEvent } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import { MemoryStore } from "./store.js";

/** Installs best-effort persistence listeners; handlers never disrupt agent work. */
export function setupAutoMemory(eventBus: EventBus, memoryStore: MemoryStore, _container: ServiceContainer): void {
  eventBus.on("agent:done", (event: AgentLifecycleEvent & { type: "agent:done" }) => {
    void (async () => {
      if (event.agent === "memory") return;
      const result = event.result as { files?: Array<{ path?: string; content?: string; summary?: string }> } | undefined;
      const files = result?.files;
      if (!files?.length) return;
      // Agent results do not carry targetDir; generated file paths are recorded under cwd.
      for (const file of files) if (file.path) await memoryStore.setFileSummary(process.cwd(), file.path, file.summary ?? `Modified by ${event.agent}`);
    })().catch(() => undefined);
  });
  eventBus.on("task:completed", (event: TaskLifecycleEvent & { type: "task:completed" }) => {
    void memoryStore.addTaskEntry(process.cwd(), event.taskId, "task", typeof event.result === "string" ? event.result : JSON.stringify(event.result)).catch(() => undefined);
  });
}
