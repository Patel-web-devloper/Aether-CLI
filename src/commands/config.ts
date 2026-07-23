export interface ConfigData {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  proxy?: string;
  organization?: string;
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
  // Validation
  switch (key) {
    case "timeout": {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        throw new Error(`Invalid timeout "${value}": must be a positive integer`);
      }
      config.timeout = num;
      break;
    }
    case "baseUrl": {
      try {
        new URL(value);
      } catch {
        throw new Error(`Invalid baseUrl "${value}": must be a valid URL`);
      }
      config.baseUrl = value;
      break;
    }
    default: {
      (config as Record<string, unknown>)[key] = value;
      break;
    }
  }
  return { ...config };
}

export function setConfigRaw(key: keyof ConfigData, value: unknown): ConfigData {
  (config as Record<string, unknown>)[key] = value;
  return { ...config };
}

export function resetConfig(): ConfigData {
  config = { provider: "openai", model: "" };
  return { ...config };
}

export function listConfig(providerSlugs: string[]): string {
  const lines: string[] = [];
  lines.push("Current configuration:");
  lines.push(`  provider:     ${config.provider || "(not set)"}`);
  lines.push(`  model:        ${config.model || "(default)"}`);
  lines.push(`  apiKey:       ${config.apiKey ? "(set)" : "(not set)"}`);
  lines.push(`  baseUrl:      ${config.baseUrl || "(not set)"}`);
  lines.push(`  timeout:      ${config.timeout ? `${config.timeout}ms` : "(not set)"}`);
  lines.push(`  proxy:        ${config.proxy || "(not set)"}`);
  lines.push(`  organization: ${config.organization || "(not set)"}`);
  lines.push("");
  lines.push("Available providers:");
  for (const name of providerSlugs) {
    lines.push(`  - ${name}`);
  }
  return lines.join("\n");
}
