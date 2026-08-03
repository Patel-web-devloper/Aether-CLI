/**
 * Preset workflows and default agent registry for the Aether orchestrator.
 *
 * Workflows reference agents by name; `createDefaultAgents()` wires all ten
 * agents (generator, reviewer, tester + seven specialized agents) into a
 * Map the Orchestrator can resolve. Users can add custom workflows via
 * `~/.config/aether/workflows.json`.
 */

import type { Agent } from "./base.js";
import type { WorkflowDefinition } from "./orchestrator.js";
import { GeneratorAgent } from "./generator.js";
import { ReviewerAgent } from "./reviewer.js";
import { TesterAgent } from "./tester.js";
import { ArchitectAgent } from "./architect.js";
import { PlannerAgent } from "./planner.js";
import { CoderAgent } from "./coder.js";
import { SecurityAgent } from "./security.js";
import { DocsAgent } from "./docs.js";
import { DevOpsAgent } from "./devops.js";
import { ReleaseAgent } from "./release.js";
import { getConfigDir } from "../utils/termux.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── default agent registry ────────────────────────────────────────────────

/** Build the standard agent map used by workflows. */
export function createDefaultAgents(): Map<string, Agent> {
  const agents: Agent[] = [
    new GeneratorAgent(),
    new ReviewerAgent(),
    new TesterAgent(),
    new ArchitectAgent(),
    new PlannerAgent(),
    new CoderAgent(),
    new SecurityAgent(),
    new DocsAgent(),
    new DevOpsAgent(),
    new ReleaseAgent(),
  ];
  return new Map(agents.map((a) => [a.name, a]));
}

// ── preset workflows ──────────────────────────────────────────────────────

export const builtinWorkflows: WorkflowDefinition[] = [
  {
    name: "full-cycle",
    description: "architect → planner → coder → reviewer + security → tester → docs → release",
    steps: [
      {
        name: "architect",
        agent: "architect",
        input:
          "Design the system architecture for the following request. Produce a text-based component diagram and evaluate tradeoffs.\n\nRequest:\n{{prompt}}",
        outputKey: "architecture",
      },
      {
        name: "planner",
        agent: "planner",
        input:
          "Break the following feature request into implementable tasks with estimates, dependencies, and acceptance criteria.\n\nArchitecture:\n{{architecture}}\n\nOriginal request:\n{{prompt}}",
        dependsOn: ["architect"],
        outputKey: "plan",
      },
      {
        name: "coder",
        agent: "coder",
        input:
          "Implement the following plan. Follow existing project patterns, handle edge cases, and add error handling.\n\nPlan:\n{{plan}}\n\nOriginal request:\n{{prompt}}",
        dependsOn: ["planner"],
        outputKey: "code",
      },
      {
        name: "reviewer",
        agent: "reviewer",
        input:
          "Review the generated code for bugs, security issues, and improvements.\n\nGenerated files:\n{{code}}",
        dependsOn: ["coder"],
        outputKey: "review",
      },
      {
        name: "security",
        agent: "security",
        input:
          "Perform a security audit on the generated code. Check for OWASP Top 10 vulnerabilities, injection risks, auth issues, and data exposure.\n\nGenerated files:\n{{code}}",
        dependsOn: ["coder"],
        outputKey: "securityReport",
      },
      {
        name: "tester",
        agent: "tester",
        input: "Generate tests for the implemented code.\n\nCode:\n{{code}}",
        dependsOn: ["reviewer", "security"],
        outputKey: "tests",
      },
      {
        name: "docs",
        agent: "docs",
        input: "Write documentation for the implemented feature.\n\nCode:\n{{code}}",
        dependsOn: ["tester"],
        outputKey: "docs",
      },
      {
        name: "release",
        agent: "release",
        input:
          "Prepare a release for this feature: version bump suggestion, changelog from git history, release notes, and tag/publish instructions.\n\nContext:\n{{docs}}",
        dependsOn: ["docs"],
        condition: "always",
        outputKey: "release",
      },
    ],
  },
  {
    name: "quick-build",
    description: "planner → coder → tester (fast feedback loop)",
    steps: [
      {
        name: "planner",
        agent: "planner",
        input: "Break the following request into implementable tasks:\n\n{{prompt}}",
        outputKey: "plan",
      },
      {
        name: "coder",
        agent: "coder",
        input: "Implement the following plan:\n\n{{plan}}\n\nRequest:\n{{prompt}}",
        dependsOn: ["planner"],
        outputKey: "code",
      },
      {
        name: "tester",
        agent: "tester",
        input: "Generate tests for the implemented code:\n\n{{code}}",
        dependsOn: ["coder"],
        outputKey: "tests",
      },
    ],
  },
  {
    name: "security-audit",
    description: "parallel code review + security scan",
    steps: [
      {
        name: "reviewer",
        agent: "reviewer",
        input: "Review the code for bugs and improvements:\n\n{{prompt}}",
        outputKey: "review",
      },
      {
        name: "security",
        agent: "security",
        input: "Perform a security audit (OWASP Top 10, injection, auth, data exposure):\n\n{{prompt}}",
        outputKey: "securityReport",
      },
    ],
  },
  {
    name: "docs-only",
    description: "generate documentation only",
    steps: [
      {
        name: "docs",
        agent: "docs",
        input: "Write documentation for the project:\n\n{{prompt}}",
        outputKey: "docs",
      },
    ],
  },
  {
    name: "release-prep",
    description: "reviewer → tester → docs → release",
    steps: [
      {
        name: "reviewer",
        agent: "reviewer",
        input: "Review the code before release:\n\n{{prompt}}",
        outputKey: "review",
      },
      {
        name: "tester",
        agent: "tester",
        input: "Generate tests for the code:\n\n{{prompt}}\n\nReview findings:\n{{review}}",
        dependsOn: ["reviewer"],
        outputKey: "tests",
      },
      {
        name: "docs",
        agent: "docs",
        input: "Write documentation for the release:\n\n{{prompt}}",
        dependsOn: ["tester"],
        outputKey: "docs",
      },
      {
        name: "release",
        agent: "release",
        input:
          "Prepare the release: version bump, changelog from git history, release notes, tag and publish instructions.\n\n{{prompt}}",
        dependsOn: ["docs"],
        condition: "always",
        outputKey: "release",
      },
    ],
  },
];

// ── custom workflows from config ──────────────────────────────────────────

/**
 * Load user-defined workflows from `<configDir>/workflows.json`.
 * Expected shape: `[{ "name": string, "description": string, "steps": [...] }]`
 * Invalid entries are skipped. Custom names override builtins.
 */
export function loadCustomWorkflows(): WorkflowDefinition[] {
  const configDir = getConfigDir();
  const file = join(configDir, "workflows.json");
  if (!existsSync(file)) return [];

  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isValidWorkflow);
  } catch {
    return [];
  }
}

/** All workflows available to the CLI: custom first (override), then builtins. */
export function loadAllWorkflows(): WorkflowDefinition[] {
  return [...loadCustomWorkflows(), ...builtinWorkflows];
}

function isValidWorkflow(value: unknown): value is WorkflowDefinition {
  if (typeof value !== "object" || value === null) return false;
  const wf = value as Partial<WorkflowDefinition>;
  if (typeof wf.name !== "string" || typeof wf.description !== "string") return false;
  if (!Array.isArray(wf.steps)) return false;
  return wf.steps.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as { agent?: unknown }).agent === "string" &&
      typeof (s as { input?: unknown }).input === "string",
  );
}
