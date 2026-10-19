import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("disabled config", () => {
  // These tests must run before any test in this file triggers the deferred load: the
  // mocked registry module is instantiated at most once per file, so registryLoads.count
  // only detects a load that performs the file's first registry import.
  const disabledConfigPath = join(tmpdir(), "pi-footer-lazy-widgets-disabled.json");
  let previousConfigPath: string | undefined;

  beforeEach(async () => {
    previousConfigPath = process.env.PI_FOOTER_CONFIG;
    process.env.PI_FOOTER_CONFIG = disabledConfigPath;
    await writeFile(disabledConfigPath, JSON.stringify({ enabled: false }), "utf8");
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.PI_FOOTER_CONFIG;
    else process.env.PI_FOOTER_CONFIG = previousConfigPath;
  });

  it("does not start the deferred load and clears the footer on first render", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);
    await hooks.on.session_start!(undefined, ctx);

    const shell = footerFactoryFrom(ui, 0);
    shell(makeTui(), makeTheme(), makeFooterData()).render(100);

    // The footer is cleared and never replaced by a real footer, which only appears
    // after a successful deferred load.
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2));
    // The registry load is the only source of a later footer registration, and it is
    // asserted to have never started, so no grace-period wait can reveal more calls.
    expect(ui.setFooter.mock.calls[1]?.[0]).toBeUndefined();
    expect(ui.setFooter).toHaveBeenCalledTimes(2);
    expect(registryLoads.count).toBe(0);
  });

  it("still loads and renders when re-enabled via /footer", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);
    await hooks.on.session_start!(undefined, ctx);

    // Let the disabled-config shortcut clear the footer first.
    const shell = footerFactoryFrom(ui, 0);
    shell(makeTui(), makeTheme(), makeFooterData()).render(100);
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2));
    expect(ui.setFooter.mock.calls[1]?.[0]).toBeUndefined();

    await hooks.commands.footer!.handler("on", ctx);

    // No registryLoads assertion here: the mocked module is instantiated at most once
    // per file, so the counter only counts this test if it performs the file's first
    // registry import. The rendered lines already prove the deferred load happened.
    expect(ui.notify).toHaveBeenCalledWith("pi-footer enabled", "info");
    expect(ui.setFooter).toHaveBeenCalledTimes(3);
    const real = footerFactoryFrom(ui, 2);
    const lines = real(makeTui(), makeTheme(), makeFooterData()).render(100);
    expect(lines.length).toBeGreaterThan(0);

    // A later apply (e.g. model switch) must not hide the footer again.
    await hooks.on.model_select!(undefined, ctx);
    expect(ui.setFooter).toHaveBeenCalledTimes(4);
    expect(footerFactoryFrom(ui, 3)).toBeTypeOf("function");
  });

  it("loads and renders in a new session after the config is re-enabled on disk", async () => {
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);
    await hooks.on.session_start!(undefined, ctx);

    // First session: the disabled-config shortcut clears the footer.
    const shell = footerFactoryFrom(ui, 0);
    shell(makeTui(), makeTheme(), makeFooterData()).render(100);
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2));
    expect(ui.setFooter.mock.calls[1]?.[0]).toBeUndefined();

    // The user re-enables the footer by editing the config file.
    await writeFile(disabledConfigPath, JSON.stringify({ enabled: true }), "utf8");

    // Second session: the shell footer re-checks the file and starts the load.
    await hooks.on.session_start!(undefined, ctx);
    expect(ui.setFooter).toHaveBeenCalledTimes(3);
    expect(footerFactoryFrom(ui, 2)).toBeTypeOf("function");

    const secondShell = footerFactoryFrom(ui, 2);
    secondShell(makeTui(), makeTheme(), makeFooterData()).render(100);
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(4), { timeout: 5000 });
    const real = footerFactoryFrom(ui, 3);
    const lines = real(makeTui(), makeTheme(), makeFooterData()).render(100);
    expect(lines.length).toBeGreaterThan(0);
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

    // The deferred load imports the whole widget graph; give slow machines room.
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2), { timeout: 5000 });

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
