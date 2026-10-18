import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cloneConfig, DEFAULT_CONFIG } from "../src/config.ts";
import type { ConfigUiResult } from "../src/ui/config-lifecycle.ts";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Vitest keeps mock module results across resetModules, so the factory below runs at most
// once per file. The counter is reset per test; a static import of the UI entry by index.ts
// instantiates it as soon as index.ts loads, a dynamic import only when the config UI is
// opened. The arg-command tests must stay ahead of the no-args test so a regression to a
// static import is caught by them.
const uiLoad = vi.hoisted(() => ({
  instantiations: 0,
  open: vi.fn<() => Promise<ConfigUiResult>>(),
}));
vi.mock("../src/ui.ts", () => {
  uiLoad.instantiations += 1;
  return {
    openStatuslineConfigUi: uiLoad.open,
    StatuslineConfigScreen: class {},
  };
});

interface FooterCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function makePiApi(commands: Record<string, FooterCommand>): ExtensionAPI {
  return {
    events: { on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>() },
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    registerCommand: (name: string, command: FooterCommand) => {
      commands[name] = command;
    },
    getSessionName: () => null,
    getThinkingLevel: () => undefined,
    getActiveTools: () => [],
    // Every git probe fails, so git widgets render empty.
    exec: vi.fn<() => Promise<{ stdout: string; code: number; killed: boolean }>>(async () => ({
      stdout: "",
      code: 1,
      killed: false,
    })),
  } as unknown as ExtensionAPI;
}

function makeCtx(): { ctx: ExtensionCommandContext; notify: ReturnType<typeof makeNotify> } {
  const notify = makeNotify();
  return {
    ctx: {
      hasUI: true,
      cwd: process.cwd(),
      model: undefined,
      getContextUsage: () => undefined,
      sessionManager: {
        getSessionId: () => "test-session",
        getBranch: () => [],
        getEntries: () => [],
      },
      ui: {
        notify,
        setStatus: vi.fn<(key: string, value: string | undefined) => void>(),
        setFooter: vi.fn<() => void>(),
        custom: vi.fn<() => Promise<unknown>>(),
        theme: { fg: (_style: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext,
    notify,
  };
}

function makeNotify() {
  return vi.fn<(message: string, kind: "info" | "warning" | "error") => void>();
}

async function runFooter(
  args: string,
): Promise<{ commands: Record<string, FooterCommand>; notify: ReturnType<typeof makeNotify> }> {
  uiLoad.instantiations = 0;
  uiLoad.open.mockReset();
  uiLoad.open.mockResolvedValue({ config: cloneConfig(DEFAULT_CONFIG), saved: false });
  vi.resetModules();

  const { default: statuslineExtension } = await import("../src/index.ts");
  const commands: Record<string, FooterCommand> = {};
  await statuslineExtension(makePiApi(commands));
  expect(commands.footer).toBeDefined();

  const { ctx, notify } = makeCtx();
  await commands.footer!.handler(args, ctx);
  return { commands, notify };
}

beforeAll(() => {
  // Keep the arg commands' saveConfig writes out of the real agent dir.
  process.env.PI_FOOTER_CONFIG = join(tmpdir(), "pi-footer-lazy-ui-test.json");
});

describe("/footer arg commands", () => {
  it.each(["on", "off", "reset", "preset default"])(
    "%s does not load the config UI module",
    async (args) => {
      await runFooter(args);
      expect(uiLoad.instantiations).toBe(0);
      expect(uiLoad.open).not.toHaveBeenCalled();
    },
  );

  it("on notifies as before", async () => {
    const { notify } = await runFooter("on");
    expect(notify).toHaveBeenCalledWith("pi-footer enabled", "info");
  });
});

describe("/footer with no args", () => {
  it("loads the config UI module and opens the UI", async () => {
    await runFooter("");
    expect(uiLoad.instantiations).toBeGreaterThan(0);
    expect(uiLoad.open).toHaveBeenCalledTimes(1);
  });
});
