/** Tests for GitUtils using the Aether CLI repository itself. */

import { GitUtils } from "../../utils/git.js";

const repo = process.cwd();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testIsGitRepoForProject() {
  console.log("TEST 1: isGitRepo returns true for the project directory...");
  assert(GitUtils.isGitRepo(repo), "project directory should be a git repository");
  console.log("  ✓ project is detected as a git repository");
}

async function testIsGitRepoForTmp() {
  console.log("TEST 2: isGitRepo returns false for /tmp...");
  assert(!GitUtils.isGitRepo("/tmp"), "/tmp should not be detected as a git repository");
  console.log("  ✓ /tmp is rejected");
}

async function testGetLog() {
  console.log("TEST 3: getLog returns non-empty formatted history...");
  const log = GitUtils.getLog(repo, 5);
  assert(log.length > 0, "git log should not be empty");
  assert(/^\S+ \d{4}-\d{2}-\d{2} .+/m.test(log), `unexpected log format: ${log}`);
  console.log("  ✓ log has hash, date, and subject");
}

async function testGetStatus() {
  console.log("TEST 4: getStatus returns a string...");
  const status = GitUtils.getStatus(repo);
  assert(typeof status === "string", "status should be a string");
  console.log("  ✓ status returned");
}

async function testGetBranchesIncludesMain() {
  console.log("TEST 5: getBranches includes main...");
  const branches = GitUtils.getBranches(repo);
  assert(Array.isArray(branches), "branches should be an array");
  assert(branches.includes("main"), `main branch missing: ${branches.join(", ")}`);
  console.log("  ✓ main branch found");
}

async function testGetCurrentBranch() {
  console.log("TEST 6: getCurrentBranch returns a truthy string...");
  const branch = GitUtils.getCurrentBranch(repo);
  assert(typeof branch === "string" && branch.length > 0, "current branch should be truthy");
  console.log(`  ✓ current branch is ${branch}`);
}

async function testHasUncommittedChanges() {
  console.log("TEST 7: hasUncommittedChanges returns a boolean...");
  const changes = GitUtils.hasUncommittedChanges(repo);
  assert(typeof changes === "boolean", "hasUncommittedChanges should return boolean");
  console.log(`  ✓ returned boolean (${changes})`);
}

async function main() {
  const tests = [testIsGitRepoForProject, testIsGitRepoForTmp, testGetLog, testGetStatus, testGetBranchesIncludesMain, testGetCurrentBranch, testHasUncommittedChanges];
  let passed = 0;
  for (const test of tests) {
    try { await test(); passed++; }
    catch (error) { console.error(`  ✗ FAILED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`\n${passed} passed, ${tests.length - passed} failed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main().catch((error) => { console.error("Test runner error:", error); process.exit(1); });
