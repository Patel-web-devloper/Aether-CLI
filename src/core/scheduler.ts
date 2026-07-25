/**
 * Task Scheduler — priority-based task queue with dependency resolution.
 * Manages concurrent execution, retries, and cancellation for Aether CLI tasks.
 */

import { eventBus } from "./events.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Task<T = unknown> {
  id: string;
  type: string;
  description?: string;
  priority: number;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  execute: () => Promise<T>;
  result?: T;
  error?: Error;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  maxRetries: number;
}

export interface TaskSchedulerOptions {
  maxConcurrent: number;
  defaultRetries: number;
  retryDelay: number;
}

const DEFAULT_OPTIONS: TaskSchedulerOptions = {
  maxConcurrent: 3,
  defaultRetries: 2,
  retryDelay: 1000,
};

// ── Scheduler ───────────────────────────────────────────────────────────────

export class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private running: Set<string> = new Set();
  private options: TaskSchedulerOptions;
  private cancelled: Set<string> = new Set();

  constructor(options?: Partial<TaskSchedulerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Add a task. Returns the generated task ID. */
  enqueue<T>(task: Omit<Task<T>, "id" | "status" | "createdAt" | "retryCount">): string {
    const id = crypto.randomUUID();
    const fullTask: Task<T> = {
      ...task,
      id,
      status: "pending",
      createdAt: Date.now(),
      retryCount: 0,
    };
    this.tasks.set(id, fullTask as Task);

    eventBus.emit({
      type: "task:queued",
      taskId: id,
      priority: task.priority,
    });

    return id;
  }

  /** Cancel a pending or running task. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === "pending" || task.status === "running") {
      this.cancelled.add(taskId);
      task.status = "cancelled";

      if (this.running.has(taskId)) {
        this.running.delete(taskId);
      }

      eventBus.emit({ type: "task:cancelled", taskId });
      return true;
    }
    return false;
  }

  /** Run all pending tasks, respecting concurrency and dependencies. */
  async runAll(): Promise<Map<string, { success: boolean; result?: unknown; error?: Error }>> {
    const results = new Map<string, { success: boolean; result?: unknown; error?: Error }>();

    while (this.hasWork()) {
      const batch = this.getNextBatch();
      if (batch.length === 0) {
        // No runnable tasks but work remains — check for deadlock
        if (this.detectDeadlock()) {
          const stuck = this.getStuckTaskIds();
          for (const id of stuck) {
            const task = this.tasks.get(id)!;
            task.status = "failed";
            task.error = new Error(`Deadlock: dependencies never completed. Needs: ${task.dependencies.filter(d => {
              const dep = this.tasks.get(d);
              return dep && dep.status !== "completed";
            }).join(", ")}`);
            results.set(id, { success: false, error: task.error });
          }
        }
        break;
      }

      const promises = batch.map(task => this.executeTask(task));
      const batchResults = await Promise.allSettled(promises);

      for (let i = 0; i < batch.length; i++) {
        const task = batch[i];
        const result = batchResults[i];
        if (result.status === "fulfilled") {
          results.set(task.id, { success: true, result: result.value });
        } else {
          results.set(task.id, { success: false, error: result.reason as Error });
        }
      }
    }

    return results;
  }

  private async executeTask(task: Task): Promise<unknown> {
    if (this.cancelled.has(task.id)) return;

    task.status = "running";
    task.startedAt = Date.now();
    this.running.add(task.id);

    eventBus.emit({ type: "task:started", taskId: task.id });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      if (this.cancelled.has(task.id)) return;

      try {
        const result = await task.execute();
        task.status = "completed";
        task.result = result;
        task.completedAt = Date.now();
        this.running.delete(task.id);

        eventBus.emit({ type: "task:completed", taskId: task.id, result });
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        task.retryCount = attempt;

        if (attempt < task.maxRetries) {
          await this.sleep(this.options.retryDelay * (attempt + 1));
        }
      }
    }

    task.status = "failed";
    task.error = lastError;
    task.completedAt = Date.now();
    this.running.delete(task.id);

    eventBus.emit({ type: "task:failed", taskId: task.id, error: lastError! });
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Get the next batch of runnable tasks (deps met, within concurrency limit). */
  private getNextBatch(): Task[] {
    const available = this.options.maxConcurrent - this.running.size;
    if (available <= 0) return [];

    // Sort by priority (lowest first), then creation time
    const pending = Array.from(this.tasks.values())
      .filter(t => t.status === "pending" && this.areDependenciesMet(t) && !this.cancelled.has(t.id))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

    return pending.slice(0, available);
  }

  private areDependenciesMet(task: Task): boolean {
    return task.dependencies.every(depId => {
      const dep = this.tasks.get(depId);
      return dep && dep.status === "completed";
    });
  }

  private hasWork(): boolean {
    return Array.from(this.tasks.values()).some(
      t => t.status === "pending" && !this.cancelled.has(t.id)
    );
  }

  private detectDeadlock(): boolean {
    const pending = Array.from(this.tasks.values()).filter(
      t => t.status === "pending" && !this.cancelled.has(t.id)
    );
    if (pending.length === 0) return false;

    return pending.every(t => {
      const deps = t.dependencies.map(d => this.tasks.get(d));
      return deps.some(d => d && (d.status === "failed" || d.status === "cancelled"));
    });
  }

  private getStuckTaskIds(): string[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === "pending" && !this.cancelled.has(t.id))
      .map(t => t.id);
  }

  /** Get a task by ID. */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all tasks. */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Build the dependency graph. */
  getDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const [id, task] of this.tasks) {
      graph.set(id, task.dependencies);
    }
    return graph;
  }

  /** Get scheduler stats. */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    maxConcurrent: number;
  } {
    const all = Array.from(this.tasks.values());
    return {
      total: all.length,
      pending: all.filter(t => t.status === "pending").length,
      running: this.running.size,
      completed: all.filter(t => t.status === "completed").length,
      failed: all.filter(t => t.status === "failed").length,
      cancelled: all.filter(t => t.status === "cancelled").length,
      maxConcurrent: this.options.maxConcurrent,
    };
  }

  /** Clear completed/failed/cancelled tasks to free memory. */
  clear(): void {
    for (const [id, task] of this.tasks) {
      if (task.status !== "pending" && task.status !== "running") {
        this.tasks.delete(id);
      }
    }
  }

  /** Reset the scheduler — clear everything. */
  reset(): void {
    this.tasks.clear();
    this.running.clear();
    this.cancelled.clear();
  }
}
