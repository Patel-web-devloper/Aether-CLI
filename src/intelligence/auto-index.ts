/**
 * Auto-index hook — keeps the code-intelligence index fresh as agents work.
 *
 * Listens to `agent:done` events; when an agent writes files, those files are
 * incrementally re-indexed so impact analysis stays accurate. To avoid choking
 * on first load, the very first time a project is seen it only prints a hint to
 * run `aether intelligence index` rather than parsing the whole tree.
 */

import type { EventBus, AgentLifecycleEvent } from "../core/events.js";
import type { ServiceContainer } from "../core/container.js";
import type { CodeIndexer } from "./indexer.js";

/** Tracks which projects we've already hinted about (per module instance). */
const hinted = new Set<string>();

function resolveTarget(event: AgentLifecycleEvent & { type: "agent:done" }): string | undefined {
  const result = event.result as { metadata?: { targetDir?: string } } | undefined;
  return result?.metadata?.targetDir ?? process.cwd();
}

/**
 * Install the auto-index listeners. Returns true when the event bus accepted a
 * fresh (non-duplicate) hint for a project.
 */
export function setupAutoIndex(
  eventBus: EventBus,
  codeIndexer: CodeIndexer,
  _container: ServiceContainer,
): void {
  eventBus.on("agent:done", (event: AgentLifecycleEvent & { type: "agent:done" }) => {
    void (async () => {
      if (event.agent === "memory" || event.agent === "indexer") return;
      const result = event.result as
        | { files?: Array<{ path?: string }>; metadata?: { targetDir?: string } }
        | undefined;
      const files = result?.files;
      const targetDir = resolveTarget(event);
      if (!targetDir) return;

      // First sighting of a project: hint, don't full-scan.
      if (!hinted.has(targetDir)) {
        hinted.add(targetDir);
        if (!codeIndexer.hasIndex(targetDir)) {
          // Avoid printing mid-run noise when a fresh index already exists.
          console.log(
            "[aether] code intelligence not indexed — run `aether intelligence index` for accurate impact analysis",
          );
          return;
        }
      }

      if (!files?.length) return;
      const paths = files
        .map((f) => f.path)
        .filter((p): p is string => Boolean(p));
      if (paths.length === 0) return;
      await codeIndexer.updateFiles(targetDir, paths);
    })().catch(() => undefined);
  });
}
