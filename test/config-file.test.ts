import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isConfigDisabled } from "../src/config-file.ts";
import { normalizeConfig } from "../src/config.ts";

describe("isConfigDisabled", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-footer-config-file-"));
    path = join(dir, "pi-footer.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is false when the config file does not exist", async () => {
    await expect(isConfigDisabled(path)).resolves.toBe(false);
  });

  it("is true only for an explicit enabled: false", async () => {
    await writeFile(path, JSON.stringify({ enabled: false }), "utf8");
    await expect(isConfigDisabled(path)).resolves.toBe(true);
  });

  it("rejects for an invalid config file, like loadConfig does", async () => {
    await writeFile(path, "{ not json", "utf8");
    await expect(isConfigDisabled(path)).rejects.toThrow("in JSON at position");
  });

  // isConfigDisabled deliberately re-implements normalizeConfig's enabled rule without
  // importing the widget registry. These tests fail if the two drift apart.
  it.each([
    ["enabled true", { enabled: true }],
    ["enabled false", { enabled: false }],
    ["missing enabled key", { preset: "default" }],
    ["non-boolean enabled", { enabled: "no" }],
    ["string file", "nope"],
    ["array file", [1, 2]],
    ["null file", null],
  ] as const)("agrees with normalizeConfig for %s", async (_label, raw) => {
    await writeFile(path, JSON.stringify(raw), "utf8");
    await expect(isConfigDisabled(path)).resolves.toBe(normalizeConfig(raw).enabled === false);
  });

  it("agrees with normalizeConfig for a missing file", async () => {
    await expect(isConfigDisabled(path)).resolves.toBe(
      normalizeConfig(undefined).enabled === false,
    );
  });
});
