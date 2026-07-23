/**
 * Aether update — check for and install newer versions.
 *
 * Usage: aether update [--check] [--force]
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import chalk from "chalk";

const CURRENT_VERSION = "0.1.0";
const REPO_OWNER = "Patel-web-devloper";
const REPO_NAME = "Aether-CLI";

interface ReleaseInfo {
  tag: string;
  version: string;
  body: string;
  publishedAt: string;
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "Accept": "application/vnd.github.v3+json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      assets?: Array<{ browser_download_url: string; name: string }>;
    };

    return {
      tag: data.tag_name ?? "unknown",
      version: (data.tag_name ?? "").replace(/^v/, ""),
      body: data.body ?? "",
      publishedAt: data.published_at ?? "",
    };
  } catch {
    return null;
  }
}

function compareVersions(current: string, latest: string): number {
  const curr = current.split(".").map(Number);
  const lat = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(curr.length, lat.length); i++) {
    const c = curr[i] ?? 0;
    const l = lat[i] ?? 0;
    if (c > l) return 1;
    if (c < l) return -1;
  }
  return 0;
}

async function downloadAndInstall(release: ReleaseInfo): Promise<boolean> {
  // Try to use the install script as the canonical way to update
  try {
    console.log(chalk.cyan(`\nDownloading Aether CLI v${release.version}...`));

    // Download the install script
    const installUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh`;
    const res = await fetch(installUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(chalk.red(`Failed to download install script (HTTP ${res.status})`));
      return false;
    }

    const script = await res.text();

    // Run the install script with bash
    console.log(chalk.cyan("Running installer..."));
    try {
      execSync("bash", {
        input: script,
        stdio: "inherit",
        timeout: 120000,
        env: { ...process.env, AETHER_VERSION: release.version },
      });
      return true;
    } catch {
      console.error(chalk.red("Install script failed."));
      return false;
    }
  } catch (err: unknown) {
    console.error(
      chalk.red("Download failed:"),
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

export interface UpdateOptions {
  check?: boolean;
  force?: boolean;
}

export async function runUpdate(options: UpdateOptions): Promise<void> {
  console.log(chalk.blue("⬆  Aether CLI — Update"));
  console.log(chalk.gray(`   Current version: v${CURRENT_VERSION}`));

  // Fetch latest release
  console.log(chalk.gray("   Checking for updates..."));
  const release = await fetchLatestRelease();

  if (!release) {
    console.log(chalk.yellow("\n⚠  Could not check for updates — network or API issue."));
    console.log(chalk.gray(`   Check manually: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`));
    return;
  }

  console.log(chalk.gray(`   Latest version:  v${release.version}`));

  const cmp = options.force ? -1 : compareVersions(CURRENT_VERSION, release.version);

  if (cmp >= 0 && !options.force) {
    console.log(chalk.green(`\n✓  Aether CLI is up to date (v${CURRENT_VERSION})`));

    // Show changelog if --check
    if (options.check && release.body) {
      console.log(chalk.cyan("\nLatest release notes:"));
      const lines = release.body.split("\n").slice(0, 15);
      for (const line of lines) {
        console.log(`   ${chalk.gray(line)}`);
      }
      if (release.body.split("\n").length > 15) {
        console.log(chalk.gray(`   ... (${release.body.split("\n").length - 15} more lines)`));
      }
    }
    return;
  }

  // New version available
  if (cmp < 0) {
    console.log(chalk.yellow(`\n⬆  New version available: v${release.version} (current: v${CURRENT_VERSION})`));

    if (release.body) {
      console.log(chalk.cyan("\nWhat's new:"));
      const lines = release.body.split("\n").slice(0, 20);
      for (const line of lines) {
        console.log(`   ${chalk.gray(line)}`);
      }
      if (release.body.split("\n").length > 20) {
        console.log(chalk.gray(`   ... (${release.body.split("\n").length - 20} more lines)`));
      }
    }
  }

  if (options.check) {
    console.log(chalk.gray("\nUse `aether update` to install the update."));
    return;
  }

  // Install the update
  console.log("");
  const ok = await downloadAndInstall(release);
  if (ok) {
    console.log(chalk.green(`\n✓  Updated to v${release.version}. Run 'aether --version' to verify.`));
  } else {
    console.log(chalk.red(`\n✗  Update failed. Try manual install: curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh | bash`));
    process.exit(1);
  }
}
