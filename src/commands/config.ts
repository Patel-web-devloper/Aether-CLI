export interface ConfigData {
  provider: string;
  model: string;
}

// In-memory config store (will be persisted later)
let config: ConfigData = {
  provider: "openai",
  model: "",
};

export function getConfig(): ConfigData {
  return { ...config };
}

export function setConfig(key: keyof ConfigData, value: string): ConfigData {
  config[key] = value;
  return { ...config };
}

export function resetConfig(): ConfigData {
  config = { provider: "openai", model: "" };
  return { ...config };
}

export function listConfig(providerSlugs: string[]): string {
  const lines: string[] = [];
  lines.push("Current configuration:");
  lines.push(`  provider: ${config.provider || "(not set)"}`);
  lines.push(`  model: ${config.model || "(default)"}`);
  lines.push("");
  lines.push("Available providers:");
  for (const name of providerSlugs) {
    lines.push(`  - ${name}`);
  }
  return lines.join("\n");
}
