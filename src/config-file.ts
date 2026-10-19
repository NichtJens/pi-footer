// Lightweight config file access. This module must not import the widget registry (directly
// or transitively): index.ts reads the enabled flag from here to decide whether the deferred
// widget load may start at all, so everything imported here stays on the startup path.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_ENV = "PI_FOOTER_CONFIG";
const DEFAULT_CONFIG_PATH = join(getAgentDir(), "extensions", "pi-footer.json");

export function getConfigPath(): string {
  return process.env[CONFIG_ENV] ?? DEFAULT_CONFIG_PATH;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// Parsed config file, or undefined when the file does not exist. Other read/parse errors
// (e.g. invalid JSON) are rethrown, matching loadConfig.
export async function readConfigFile(path = getConfigPath()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Mirrors normalizeConfig: only an explicit boolean `enabled: false` disables the footer;
// a missing file or one without a boolean `enabled` normalizes to the enabled default.
export async function isConfigDisabled(path = getConfigPath()): Promise<boolean> {
  const raw = await readConfigFile(path);
  if (typeof raw !== "object" || raw === null) return false;
  return (raw as { enabled?: unknown }).enabled === false;
}
