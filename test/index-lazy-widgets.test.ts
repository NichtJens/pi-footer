import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Counts how many times the widget registry module is instantiated. A static (eager) import by
// index.ts's startup graph instantiates it as soon as index.ts loads; a deferred load only
// instantiates it when the footer first renders or /footer runs.
const registryLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/widgets/registry.ts", async (importOriginal) => {
  registryLoads.count += 1;
  return (await importOriginal()) as object;
});

interface FooterCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface Hooks {
  on: Record<string, (...args: unknown[]) => unknown>;
  commands: Record<string, FooterCommand>;
}

function makePiApi(hooks: Hooks): ExtensionAPI {
  return {
    events: { on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>() },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      hooks.on[event] = handler;
    },
    registerCommand: (name: string, command: FooterCommand) => {
      hooks.commands[name] = command;
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

interface Ui {
  setFooter: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
  theme: { fg: (style: string, text: string) => string };
}

function makeUi(): Ui {
  return {
    setFooter: vi.fn<(factory: FooterFactory | undefined) => void>(),
    notify: vi.fn<(message: string, kind: "info" | "warning" | "error") => void>(),
    setStatus: vi.fn<(key: string, value: string | undefined) => void>(),
    custom: vi.fn<() => Promise<unknown>>(),
    theme: { fg: (_style: string, text: string) => text },
  };
}

function makeCtx(ui: Ui): ExtensionCommandContext {
  return {
    hasUI: true,
    cwd: process.cwd(),
    model: undefined,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [],
      getEntries: () => [],
    },
    ui,
  } as unknown as ExtensionCommandContext;
}

function makeTui() {
  return { requestRender: vi.fn<() => void>() };
}

function makeTheme() {
  return { fg: (_style: string, text: string) => text };
}

function makeFooterData() {
  return {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map<string, string>(),
    onBranchChange: () => () => {},
  };
}

type FooterFactory = (
  tui: ReturnType<typeof makeTui>,
  theme: ReturnType<typeof makeTheme>,
  footerData: ReturnType<typeof makeFooterData>,
) => { dispose(): void; invalidate(): void; render(width: number): string[] };

function footerFactoryFrom(ui: Ui, index: number): FooterFactory {
  return ui.setFooter.mock.calls[index]?.[0] as FooterFactory;
}

async function freshExtension() {
  vi.resetModules();
  registryLoads.count = 0;
  const { default: statuslineExtension } = await import("../src/index.ts");
  const hooks: Hooks = { on: {}, commands: {} };
  await statuslineExtension(makePiApi(hooks));
  return hooks;
}

beforeAll(() => {
  // Keep the config writes out of the real agent dir.
  process.env.PI_FOOTER_CONFIG = join(tmpdir(), "pi-footer-lazy-widgets-test.json");
});

describe("startup import graph", () => {
  it("factory + session_start do not instantiate the widget registry", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);

    await hooks.on.session_start!(undefined, ctx);

    expect(registryLoads.count).toBe(0);
    // A footer is registered so the first TUI frame can trigger the deferred load.
    expect(ui.setFooter).toHaveBeenCalledTimes(1);
    expect(ui.setFooter.mock.calls[0]?.[0]).toBeTypeOf("function");
  });
});

describe("first footer render", () => {
  it("renders empty once, loads the registry, then renders the full footer", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);
    await hooks.on.session_start!(undefined, ctx);

    const shell = footerFactoryFrom(ui, 0);
    const first = shell(makeTui(), makeTheme(), makeFooterData());
    expect(first.render(100)).toEqual([]);

    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2));

    const real = footerFactoryFrom(ui, 1);
    const footer = real(makeTui(), makeTheme(), makeFooterData());
    const lines = footer.render(100);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("no-model");
  });
});

describe("/footer arg command", () => {
  it("loads the registry on demand and saves the config", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);

    await hooks.commands.footer!.handler("on", ctx);

    expect(ui.notify).toHaveBeenCalledWith("pi-footer enabled", "info");
    const saved = JSON.parse(await readFile(process.env.PI_FOOTER_CONFIG!, "utf8"));
    expect(saved.enabled).toBe(true);
    expect(Array.isArray(saved.lines)).toBe(true);
  });
});
