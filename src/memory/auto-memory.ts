import type { EventBus, AgentLifecycleEvent, TaskLifecycleEvent } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import { MemoryStore } from "./store.js";

/** Installs best-effort persistence listeners; handlers never disrupt agent work. */
export function setupAutoMemory(eventBus: EventBus, memoryStore: MemoryStore, _container: ServiceContainer): void {
  eventBus.on("agent:done", (event: AgentLifecycleEvent & { type: "agent:done" }) => {
    void (async () => {
      if (event.agent === "memory") return;
      const result = event.result as {
        files?: Array<{ path?: string; content?: string; summary?: string }>;
        metadata?: { targetDir?: string };
      } | undefined;
      const files = result?.files;
      if (!files?.length) return;
      // AgentOutput metadata carries the project root the agent ran against
      // (populated by Agent.run()); fall back to cwd for manually-emitted events.
      const targetDir = result?.metadata?.targetDir ?? process.cwd();
      for (const file of files) if (file.path) await memoryStore.setFileSummary(targetDir, file.path, file.summary ?? `Modified by ${event.agent}`);
    })().catch(() => undefined);
  });
  eventBus.on("task:completed", (event: TaskLifecycleEvent & { type: "task:completed" }) => {
    // Task events carry no targetDir — persist under cwd (documented limitation).
    void memoryStore.addTaskEntry(process.cwd(), event.taskId, "task", typeof event.result === "string" ? event.result : JSON.stringify(event.result)).catch(() => undefined);
  });
}
