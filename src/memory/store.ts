import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface Decision { question: string; answer: string; timestamp: number }
export interface TaskEntry { taskId: string; type: string; outcome: string; timestamp: number }

/** Small, human-readable JSON persistence layer for project and global memory. */
export class MemoryStore {
  readonly basePath: string;
  constructor(basePath = join(process.env.HOME || process.env.USERPROFILE || ".", ".aether-cli", "memory")) {
    this.basePath = resolve(basePath);
  }
  private projectDir(root: string) { return join(this.basePath, "project", createHash("sha256").update(resolve(root)).digest("hex")); }
  private async load<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
  }
  private async save(file: string, value: unknown): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  }
  async getFileSummary(root: string, filePath: string): Promise<string | null> {
    const files = await this.getProjectFiles(root); return files[filePath] ?? files[filePath.replace(/\\/g, "/")] ?? null;
  }
  async setFileSummary(root: string, filePath: string, summary: string): Promise<void> {
    const files = await this.getProjectFiles(root); files[filePath.replace(/\\/g, "/")] = summary;
    await this.save(join(this.projectDir(root), "files.json"), files);
  }
  async getProjectFiles(root: string): Promise<Record<string, string>> { return this.load(join(this.projectDir(root), "files.json"), {}); }
  async setProjectFiles(root: string, files: Record<string, string>): Promise<void> { await this.save(join(this.projectDir(root), "files.json"), files); }
  async getDecisions(root: string): Promise<Decision[]> { return this.load(join(this.projectDir(root), "decisions.json"), []); }
  async addDecision(root: string, question: string, answer: string): Promise<void> {
    const values = await this.getDecisions(root); values.push({ question, answer, timestamp: Date.now() });
    await this.save(join(this.projectDir(root), "decisions.json"), values);
  }
  async getTaskHistory(root: string): Promise<TaskEntry[]> { return this.load(join(this.projectDir(root), "tasks.json"), []); }
  async addTaskEntry(root: string, taskId: string, type: string, outcome: string): Promise<void> {
    const values = await this.getTaskHistory(root); values.push({ taskId, type, outcome, timestamp: Date.now() });
    await this.save(join(this.projectDir(root), "tasks.json"), values);
  }
  async clearProject(root: string): Promise<void> { await rm(this.projectDir(root), { recursive: true, force: true }); }
  async clearAll(): Promise<void> { await rm(this.basePath, { recursive: true, force: true }); }
}
