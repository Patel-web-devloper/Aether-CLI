import { execFileSync } from "node:child_process";

const run = (cwd: string, args: string[]): string => {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

export class GitUtils {
  static getLog(cwd: string, maxCount = 40, format = "%h %ad %s"): string { return run(cwd, ["log", `--max-count=${maxCount}`, `--pretty=format:${format}`, "--date=short"]); }
  static getStatus(cwd: string): string { return run(cwd, ["status", "--short"]); }
  static getDiff(cwd: string, staged = false): string { return run(cwd, ["diff", ...(staged ? ["--cached"] : [])]); }
  static getBranches(cwd: string): string[] { const out = run(cwd, ["branch", "--format=%(refname:short)"]); return out ? out.split("\n").filter(Boolean) : []; }
  static getCurrentBranch(cwd: string): string { return run(cwd, ["branch", "--show-current"]); }
  static getStagedFiles(cwd: string): string[] { const out = run(cwd, ["diff", "--cached", "--name-only"]); return out ? out.split("\n").filter(Boolean) : []; }
  static stageAll(cwd: string): void { run(cwd, ["add", "-A"]); }
  static commit(cwd: string, message: string): void { run(cwd, ["commit", "-m", message]); }
  static getCommitsBetween(cwd: string, from: string, to: string): string { return run(cwd, ["log", `${from}..${to}`, "--pretty=format:%h %ad %s", "--date=short"]); }
  static createBranch(cwd: string, name: string): void { run(cwd, ["checkout", "-b", name]); }
  static hasUncommittedChanges(cwd: string): boolean { return Boolean(run(cwd, ["status", "--porcelain"])); }
  static isGitRepo(cwd: string): boolean { return Boolean(run(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true"); }
}

export const getLog = GitUtils.getLog;
export const getStatus = GitUtils.getStatus;
export const getDiff = GitUtils.getDiff;
export const getBranches = GitUtils.getBranches;
export const getCurrentBranch = GitUtils.getCurrentBranch;
export const getStagedFiles = GitUtils.getStagedFiles;
export const stageAll = GitUtils.stageAll;
export const commit = GitUtils.commit;
export const getCommitsBetween = GitUtils.getCommitsBetween;
export const createBranch = GitUtils.createBranch;
export const hasUncommittedChanges = GitUtils.hasUncommittedChanges;
export const isGitRepo = GitUtils.isGitRepo;
