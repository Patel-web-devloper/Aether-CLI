/**
 * Memory-aware runner — detects available RAM and adapts behavior.
 *
 * Parses /proc/meminfo on Linux/Android, sysctl on macOS.
 * Sets the AETHER_LOW_MEMORY flag when available RAM is below threshold
 * so agents and chunkers can reduce their footprint.
 */

import os from "node:os";
import { readFileSync } from "node:fs";

// ── Constants ─────────────────────────────────────────────────────────────

/** Threshold in bytes — below this, we consider the device low-memory. */
const LOW_MEMORY_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GB

/** Key used in process.env to signal low-memory mode. */
export const LOW_MEMORY_ENV_KEY = "AETHER_LOW_MEMORY";

// ── Detection ─────────────────────────────────────────────────────────────

/**
 * Parse /proc/meminfo (Linux/Android) to get MemAvailable in bytes.
 * Returns undefined if the file can't be read or parsed.
 */
function parseProcMeminfo(): number | undefined {
  try {
    const contents = readFileSync("/proc/meminfo", "utf-8");
    const lines = contents.split("\n");

    // Prefer MemAvailable (present since Linux 3.14, Termux has it)
    for (const line of lines) {
      if (line.startsWith("MemAvailable:")) {
        const match = line.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (match) {
          return parseInt(match[1], 10) * 1024;
        }
      }
    }

    // Fallback: parse MemFree + Cached + Buffers
    let memFree = 0;
    let cached = 0;
    let buffers = 0;

    for (const line of lines) {
      if (line.startsWith("MemFree:")) {
        const m = line.match(/MemFree:\s+(\d+)\s+kB/);
        if (m) memFree = parseInt(m[1], 10) * 1024;
      } else if (line.startsWith("Cached:")) {
        const m = line.match(/Cached:\s+(\d+)\s+kB/);
        if (m) cached = parseInt(m[1], 10) * 1024;
      } else if (line.startsWith("Buffers:")) {
        const m = line.match(/Buffers:\s+(\d+)\s+kB/);
        if (m) buffers = parseInt(m[1], 10) * 1024;
      }
    }

    if (memFree > 0) {
      return memFree + cached + buffers;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse memory info on macOS using sysctl.
 * Returns available memory in bytes, or undefined.
 */
function parseMacMemory(): number | undefined {
  // On macOS we can use os.freemem() which is reasonably accurate
  // plus we can get total from os.totalmem() for context
  return os.freemem();
}

/**
 * Get available RAM on the device in bytes.
 * Uses /proc/meminfo on Linux/Android, sysctl on macOS.
 * Falls back to os.freemem() if native parsing fails.
 */
export function getAvailableMemory(): number {
  const platform = os.platform();

  if (platform === "linux" || platform === "android") {
    const parsed = parseProcMeminfo();
    if (parsed !== undefined) return parsed;
    return os.freemem();
  }

  if (platform === "darwin") {
    const parsed = parseMacMemory();
    if (parsed !== undefined) return parsed;
    return os.freemem();
  }

  // Other platforms: best-effort
  return os.freemem();
}

/**
 * Get total system memory in bytes.
 */
export function getTotalMemory(): number {
  return os.totalmem();
}

// ── Adaptation ────────────────────────────────────────────────────────────

/**
 * Check if the system is low on memory and set AETHER_LOW_MEMORY.
 * Called once at startup. Agents and chunkers can check this flag
 * to reduce chunk sizes, skip caching, or use cheaper models.
 *
 * If already set via env, respects that value.
 */
export function detectAndSetMemoryMode(): void {
  // If explicitly set, respect it
  if (process.env[LOW_MEMORY_ENV_KEY] !== undefined) return;

  const available = getAvailableMemory();

  if (available < LOW_MEMORY_THRESHOLD) {
    process.env[LOW_MEMORY_ENV_KEY] = "1";
  } else {
    process.env[LOW_MEMORY_ENV_KEY] = "0";
  }
}

/**
 * Check if the current session is running in low-memory mode.
 */
export function isLowMemoryMode(): boolean {
  return process.env[LOW_MEMORY_ENV_KEY] === "1";
}

/**
 * Get a human-readable memory summary.
 */
export function getMemorySummary(): Record<string, string | number | boolean> {
  const available = getAvailableMemory();
  const total = getTotalMemory();
  const used = total - available;

  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    totalGB: +(total / (1024 * 1024 * 1024)).toFixed(2),
    availableGB: +(available / (1024 * 1024 * 1024)).toFixed(2),
    isLowMemory: isLowMemoryMode(),
    thresholdGB: +(LOW_MEMORY_THRESHOLD / (1024 * 1024 * 1024)).toFixed(2),
  };
}

/**
 * Print a warning if running on a low-memory device.
 * Should be called during startup to alert the user.
 */
export function getLowMemoryWarning(): string | null {
  if (!isLowMemoryMode()) return null;

  const availGB = (getAvailableMemory() / (1024 * 1024 * 1024)).toFixed(1);

  return [
    `⚠️  Low memory detected: ${availGB} GB available.`,
    "   Consider using a local model (aether setup → Ollama)",
    "   or smaller cloud models to reduce resource usage.",
    "   Context windows and chunk sizes will be reduced.",
  ].join("\n");
}
