import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Simulates a failed deferred load: while `failLoad` is set, the mock factory for the
// deferred entry point rejects, so the extension's `import("./deferred.ts")` rejects.
// Vitest caches a mock factory's successful result across resetModules, so flipping the
// state re-registers the factory to force a fresh evaluation on the next import.
const { failLoad, deferredLoadAttempts, deferredLoadMock } = vi.hoisted(() => {
  const failLoad = { current: false };
  // Counts mock factory evaluations so tests can await a specific load attempt before
  // asserting on its outcome.
  const deferredLoadAttempts = { count: 0 };
  const deferredLoadMock = async (importOriginal: () => Promise<unknown>) => {
    deferredLoadAttempts.count += 1;
    if (failLoad.current) throw new Error("simulated deferred load failure");
    return await importOriginal();
  };
  return { failLoad, deferredLoadAttempts, deferredLoadMock };
});
vi.mock("../src/deferred.ts", deferredLoadMock);

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
  deferredLoadAttempts.count = 0;
  const { default: statuslineExtension } = await import("../src/index.ts");
  const hooks: Hooks = { on: {}, commands: {} };
  await statuslineExtension(makePiApi(hooks));
  return hooks;
}

// Points the extension at a fresh (nonexistent) config file and returns its path.
function freshConfigPath(name: string): string {
  const path = join(tmpdir(), name);
  process.env.PI_FOOTER_CONFIG = path;
  return path;
}

// Sets the deferred load to fail or recover. The doMock+resetModules pair makes sure the
// mock factory is re-evaluated on the next import regardless of any cached result.
function setDeferredLoadFailure(fail: boolean): void {
  failLoad.current = fail;
  vi.doMock("../src/deferred.ts", deferredLoadMock);
  vi.resetModules();
}

beforeAll(() => {
  // Keep the config writes out of the real agent dir.
  process.env.PI_FOOTER_CONFIG = join(tmpdir(), "pi-footer-deferred-failure-test.json");
});

describe("failed deferred load", () => {
  it("notifies once, retries silently on later render ticks, and recovers", async () => {
    setDeferredLoadFailure(true);
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);
    await hooks.on.session_start!(undefined, ctx);

    const shell = footerFactoryFrom(ui, 0);
    const footer = shell(makeTui(), makeTheme(), makeFooterData());
    expect(footer.render(100)).toEqual([]);

    // The first failed load notifies the user exactly once.
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledTimes(1));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-footer:"), "error");

    // A later render tick retries the load; the retry failure stays silent. The
    // attempt counter waits for the retry to actually run and settle, so the silence
    // below is asserted against a failed retry, not an unsettled one.
    footer.render(100);
    await vi.waitFor(() => expect(deferredLoadAttempts.count).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.notify).toHaveBeenCalledTimes(1);

    // Once the load can succeed, the next render tick recovers: it triggers a fresh
    // import attempt, the real footer is registered, and it renders without restarting pi.
    setDeferredLoadFailure(false);
    footer.render(100);
    await vi.waitFor(() => expect(deferredLoadAttempts.count).toBe(3));
    await vi.waitFor(() => expect(ui.setFooter).toHaveBeenCalledTimes(2));
    expect(ui.notify).toHaveBeenCalledTimes(1);

    const real = footerFactoryFrom(ui, 1);
    const lines = real(makeTui(), makeTheme(), makeFooterData()).render(100);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("no-model");
  });

  it("/footer arg commands fail cleanly while the load is failed, and work after recovery", async () => {
    setDeferredLoadFailure(true);
    const configPath = freshConfigPath("pi-footer-deferred-failure-cmd.json");
    // A previous run's recovery phase may have saved this file already.
    await unlink(configPath).catch(() => {});
    const hooks = await freshExtension();
    const ui = makeUi();
    const ctx = makeCtx(ui);

    await hooks.commands.footer!.handler("on", ctx);
    // The command reports the failure instead of hanging or swallowing it.
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-footer:"), "error");
    // ...and does not apply or save the config.
    await expect(readFile(configPath, "utf8")).rejects.toThrow("ENOENT");

    setDeferredLoadFailure(false);
    await hooks.commands.footer!.handler("on", ctx);
    expect(ui.notify).toHaveBeenCalledWith("pi-footer enabled", "info");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.enabled).toBe(true);
  });
});
