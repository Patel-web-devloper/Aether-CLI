/**
 * Termux environment detection and helpers.
 *
 * Termux is a terminal emulator and Linux environment for Android.
 * It has a different filesystem layout and limited package availability.
 * These utilities help the CLI adapt.
 *
 * Path conventions:
 *   - $PREFIX:       /data/data/com.termux/files/usr   (Termux root)
 *   - $HOME:         /data/data/com.termux/files/home   (Termux home)
 *   - Config:        $HOME/.config/aether               (XDG-compatible)
 *   - Data:          $PREFIX/var/lib/aether              (persistent app data)
 *   - Cache:         $HOME/.cache/aether                 (volatile cache)
 */

import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Detection ─────────────────────────────────────────────────────────────

/** Check if running inside Termux. */
export function isTermux(): boolean {
  // AETHER_TERMUX_MODE forces Termux paths even on non-Termux (useful for testing)
  if (process.env.AETHER_TERMUX_MODE === "1") return true;

  return (
    process.env.AETHER_TERMUX === "1" ||
    !!process.env.TERMUX_VERSION ||
    isTermuxPath()
  );
}

/** Check if the Termux data directory exists. */
function isTermuxPath(): boolean {
  try {
    return existsSync("/data/data/com.termux/files/usr");
  } catch {
    return false;
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────

/**
 * Get the Termux prefix ($PREFIX).
 * In Termux this is /data/data/com.termux/files/usr.
 * Falls back to /data/data/com.termux/files/usr even if not running
 * in Termux (useful for testing with AETHER_TERMUX_MODE).
 */
export function getTermuxPrefix(): string {
  return process.env.PREFIX || "/data/data/com.termux/files/usr";
}

/** Get the Termux home directory ($HOME). */
export function getTermuxHome(): string {
  if (isTermux()) {
    // In Termux, $HOME should already be set correctly, but we provide a fallback
    return process.env.HOME || "/data/data/com.termux/files/home";
  }
  return os.homedir();
}

/** Get the appropriate config directory. */
export function getConfigDir(): string {
  if (isTermux()) {
    return `${getTermuxHome()}/.config/aether`;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return `${xdg}/aether`;
  return `${os.homedir()}/.config/aether`;
}

/** Get the appropriate cache directory. */
export function getCacheDir(): string {
  if (isTermux()) {
    return `${getTermuxHome()}/.cache/aether`;
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return `${xdg}/aether`;
  return `${os.homedir()}/.cache/aether`;
}

/**
 * Get the appropriate data directory.
 *
 * On Termux we use $PREFIX/var/lib/aether for persistent application data
 * (consistent with FHS conventions and Termux package practices).
 * On regular Linux we follow XDG_DATA_HOME.
 */
export function getDataDir(): string {
  if (isTermux()) {
    return `${getTermuxPrefix()}/var/lib/aether`;
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return `${xdg}/aether`;
  return `${os.homedir()}/.local/share/aether`;
}

/** Get the config file path. */
export function getConfigPath(): string {
  return `${getConfigDir()}/config.json`;
}

// ── Directory helpers ─────────────────────────────────────────────────────

/**
 * Ensure all required Aether directories exist.
 * Creates config dir, cache dir, and data dir if they don't exist.
 */
export function ensureDirs(): void {
  const dirs = [getConfigDir(), getCacheDir(), getDataDir()];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore errors — directories may already exist or we may not have perms
    }
  }
}

// ── Proot detection ───────────────────────────────────────────────────────

/**
 * Check if running under proot (common in Termux setups).
 * proot is used to run Linux distributions within Termux
 * and can affect filesystem behavior.
 */
export function isProot(): boolean {
  // Check common proot indicators
  if (process.env.PROOT_TMP_DIR) return true;
  if (process.env.PROOT_RAW_BIND) return true;

  // Check for /proc/ish (iSH) — similar pseudo-chroot
  try {
    if (existsSync("/proc/ish")) return true;
  } catch {
    // ignore
  }

  // When running under proot, /proc/1/root is typically not /
  try {
    const { readlinkSync } = require("node:fs");
    const root = readlinkSync("/proc/1/root");
    if (root && root !== "/") return true;
  } catch {
    // ignore
  }

  return false;
}

// ── Env info ──────────────────────────────────────────────────────────────

/** Print environment info for debugging. */
export function getEnvInfo(): Record<string, string | boolean | number> {
  return {
    isTermux: isTermux(),
    isProot: isProot(),
    home: getTermuxHome(),
    configDir: getConfigDir(),
    cacheDir: getCacheDir(),
    dataDir: getDataDir(),
    prefix: isTermux() ? getTermuxPrefix() : "(not termux)",
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    termuxVersion: process.env.TERMUX_VERSION || "(not set)",
  };
}
