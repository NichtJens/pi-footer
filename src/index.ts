import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { EventWidgetValues, UPDATE_EVENT_WIDGET_EVENT } from "./event-widgets.ts";
import { isConfigDisabled } from "./config-file.ts";
import {
  EMPTY_EXTENSION_STATUSES,
  visibleExtensionStatusRowEntries,
} from "./extension-statuses.ts";
import { EMPTY_GIT_INFO, getGitInfo, hasEnabledGitWidgets, loadGitInfo } from "./git.ts";
import { collectSessionMetrics, collectTurnMetrics } from "./metrics.ts";
import {
  isRecord,
  STATUS_KEY,
  type GitInfo,
  type StatuslineConfig,
  type StatuslineData,
} from "./types.ts";
import type { WidgetStore } from "./widgets/store.ts";

import type * as FooterModulesModule from "./deferred.ts";

// The deferred part of the extension: every module that transitively imports the widget
// registry, re-exported through a single entry point.
type FooterModules = typeof FooterModulesModule;

// Populated together on the first footer render or /footer, so a non-undefined value is the
// single loaded-or-not check.
interface LoadedFooter {
  mod: FooterModules;
  config: StatuslineConfig;
  store: WidgetStore;
}

// Structural mirror of pi's footerData — collectStatuslineData only needs the branch getter.
interface FooterDataLike {
  getGitBranch(): string | null;
}

export default async function statuslineExtension(pi: ExtensionAPI): Promise<void> {
  // The widget registry (and everything that imports it: config normalization, the widget
  // store, and the renderer) loads on first footer render or /footer, keeping the widget
  // modules off pi's startup import path.
  let loaded: LoadedFooter | undefined;
  let loadPromise: Promise<void> | undefined;
  // Session-level latch: "the config file said disabled at first render" — NOT a live
  // "the config is disabled" flag. Set by the cheap enabled-flag pre-check when the
  // config is disabled (so the deferred load is skipped entirely and the footer stays
  // cleared); reset on session_start so a config re-enabled in a new session is
  // picked up. apply() may only honor it while the widgets have not yet loaded (`!loaded &&
  // disabled`): if a later enable (/footer on, config change) triggers the deferred load,
  // dropping the not-yet-loaded guard would keep hiding the already-loaded footer.
  let disabled = false;
  // A failed deferred load notifies the user once per session; later retries stay silent
  // because the footer reappearing is the recovery signal.
  let loadFailureNotified = false;
  const eventWidgets = new EventWidgetValues();
  let liveTextVerbosity: string | undefined;
  let renderCurrentFooter: (() => void) | undefined;
  let getExtensionStatuses = (): ReadonlyMap<string, string> => EMPTY_EXTENSION_STATUSES;

  function loadDeferred(): Promise<void> {
    loadPromise ??= (async () => {
      const mod = await import("./deferred.ts");
      const cfg = await mod.loadConfig();
      loaded = { mod, config: cfg, store: mod.WidgetStore.fromConfig(cfg) };
    })();
    const attempt = loadPromise;
    // Re-throw the failure while clearing the cached promise so a later render tick
    // or /footer retries the load instead of staying broken for the rest of the session.
    return attempt.catch((error: unknown) => {
      if (loadPromise === attempt) loadPromise = undefined;
      throw error;
    });
  }

  function formatLoadError(error: unknown): string {
    return `pi-footer: ${error instanceof Error ? error.message : String(error)}`;
  }

  function notifyLoadFailure(
    error: unknown,
    ctx: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (loadFailureNotified) return;
    loadFailureNotified = true;
    ctx.ui.notify(formatLoadError(error), "error");
  }

  function clearFooter(ctx: ExtensionContext | ExtensionCommandContext): void {
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  // Decide enabled/disabled before importing anything: a disabled session must cost
  // nothing, so the widget modules are never loaded if the config says disabled.
  // Otherwise start the deferred load; the real footer replaces the shell when it finishes.
  async function startShellBoot(
    ctx: ExtensionContext | ExtensionCommandContext,
    tui: { requestRender(): void },
  ): Promise<void> {
    if (await isConfigDisabled()) {
      disabled = true;
    } else {
      // A failed load rejects before apply, so the shell stays for a render tick to retry.
      await loadDeferred();
    }
    apply(ctx);
    tui.requestRender();
  }

  function registerShellFooter(ctx: ExtensionContext | ExtensionCommandContext): void {
    let boot: Promise<void> | undefined;
    ctx.ui.setFooter((tui) => ({
      dispose(): void {},
      invalidate(): void {},
      render(): string[] {
        // While the load is failed, boot is cleared by the catch below, so each render
        // tick retries until it succeeds and the real footer replaces this shell.
        boot ??= startShellBoot(ctx, tui).catch((error: unknown) => {
          boot = undefined;
          notifyLoadFailure(error, ctx);
        });
        return [];
      },
    }));
  }

  function apply(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      clearFooter(ctx);
      return;
    }
    // See the latch declaration above: the not-yet-loaded guard is what lets a later
    // enable of the footer take effect without waiting for a new session.
    if (!loaded && disabled) {
      clearFooter(ctx);
      return;
    }
    const state = loaded;
    if (!state) {
      registerShellFooter(ctx);
      return;
    }
    if (!state.config.enabled) {
      clearFooter(ctx);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "pi-footer"));
    ctx.ui.setFooter((tui, theme, footerData) => {
      getExtensionStatuses = () => footerData.getExtensionStatuses();
      renderCurrentFooter = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose(): void {
          unsubscribeBranch();
          if (renderCurrentFooter) renderCurrentFooter = undefined;
          getExtensionStatuses = () => EMPTY_EXTENSION_STATUSES;
        },
        invalidate(): void {},
        render(width: number): string[] {
          const data = collectStatuslineData(ctx, pi, footerData, eventWidgets.values, {
            config: state.config,
            requestRender: () => tui.requestRender(),
            textVerbosity: liveTextVerbosity,
          });
          const lines = state.mod.renderStatuslines(state.store, data, width, {
            getExtensionStatuses,
            theme,
            requestRender: () => tui.requestRender(),
          });
          if (lines.length === 0) return [];

          const statuses = visibleExtensionStatusRowEntries(
            footerData.getExtensionStatuses(),
            state.config.extensionStatusRow.hiddenKeys,
            STATUS_KEY,
          ).map((entry) => entry.value);
          const renderedLines = lines.map((line) => truncateToWidth(line, width, "…"));
          if (statuses.length === 0) return renderedLines;
          return [
            ...renderedLines,
            truncateToWidth(theme.fg("dim", statuses.join(" ")), width, "…"),
          ];
        },
      };
    });
  }

  function replaceConfig(state: LoadedFooter, next: StatuslineConfig): void {
    loaded = {
      mod: state.mod,
      config: next,
      store: state.mod.WidgetStore.fromConfig(next),
    };
  }

  async function setConfig(
    state: LoadedFooter,
    next: StatuslineConfig,
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> {
    replaceConfig(state, next);
    await state.mod.saveConfig(next);
    apply(ctx);
  }

  pi.events.on(UPDATE_EVENT_WIDGET_EVENT, (payload: unknown) => {
    const changed = eventWidgets.update(payload);
    if (changed) renderCurrentFooter?.();
  });

  // pi has no verbosity accessor; capture the real value from the actual provider
  // request payload. Passive — the footer picks it up on its next render rather than
  // forcing one. Only the openai-codex-responses payload carries text.verbosity.
  //
  // Handlers run in extension load order and the payload is chained forward, so we
  // observe it as of our own position in that chain (we return undefined and never
  // mutate it). A custom provider that bakes verbosity into the body is always seen;
  // a later-loaded extension that rewrites text.verbosity in its own
  // before_provider_request handler is the one case we'd miss.
  pi.on("before_provider_request", (event) => {
    const verbosity = readTextVerbosity(event.payload);
    if (verbosity !== undefined) liveTextVerbosity = verbosity;
  });

  pi.registerCommand("footer", {
    description: "Configure the pi statusline/footer",
    handler: async (args, ctx) => {
      try {
        await loadDeferred();
      } catch (error: unknown) {
        // An explicit /footer invocation always gets feedback about the failed load,
        // even when a render-tick failure already notified this session.
        ctx.ui.notify(formatLoadError(error), "error");
        return;
      }
      const state = loaded;
      if (!state) return;

      const handled = await handleArgs(args, ctx, state, (next) => setConfig(state, next, ctx));
      if (handled) return;

      const previewData = collectStatuslineData(
        ctx,
        pi,
        {
          getGitBranch: () => "main",
        },
        eventWidgets.values,
        {
          collectGit: true,
          git: await loadGitInfo(pi, ctx.cwd, "main"),
          textVerbosity: liveTextVerbosity,
        },
      );
      // The config UI screen tree is imported on demand so the extension's startup
      // import graph stays small; arg commands above never reach this point.
      const { openStatuslineConfigUi } = await import("./ui.ts");
      const result = await openStatuslineConfigUi(
        ctx,
        state.config,
        previewData,
        (updated) => {
          replaceConfig(state, updated);
          apply(ctx);
        },
        (updated) => setConfig(state, updated, ctx),
        getExtensionStatuses,
      );
      replaceConfig(state, result.config);
      apply(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    loadFailureNotified = false;
    disabled = false;
    // Before the first footer render the config loads on first render. If the load is
    // already in flight, wait for it so the reload below is not skipped; a failed load
    // just leaves the shell footer in place for a render tick to retry.
    if (loadPromise && !loaded) await loadDeferred().catch(() => {});
    const state = loaded;
    if (state) replaceConfig(state, await state.mod.loadConfig());
    apply(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    // A new model selection invalidates the captured verbosity; fall back to the
    // provider default until the next request reveals the real value.
    liveTextVerbosity = undefined;
    apply(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearFooter(ctx);
  });
}

function collectStatuslineData(
  ctx: ExtensionContext | ExtensionCommandContext,
  pi: ExtensionAPI,
  footerData: FooterDataLike,
  eventWidgets: ReadonlyMap<string, string>,
  options: {
    config?: StatuslineConfig;
    collectGit?: boolean;
    requestRender?: () => void;
    git?: GitInfo;
    textVerbosity?: string | undefined;
  } = {},
): StatuslineData {
  const contextUsage = ctx.getContextUsage();
  const collectGit =
    options.collectGit ?? (options.config ? hasEnabledGitWidgets(options.config) : true);
  return {
    model: ctx.model?.id,
    provider: ctx.model?.provider,
    sessionName: pi.getSessionName(),
    sessionId: ctx.sessionManager.getSessionId(),
    thinkingLevel: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
    textVerbosity: getTextVerbosity(ctx.model, options.textVerbosity),
    git:
      options.git ??
      (collectGit
        ? getGitInfo(pi, ctx.cwd, footerData.getGitBranch(), options.requestRender ?? (() => {}))
        : EMPTY_GIT_INFO),
    cwd: ctx.cwd,
    activeToolCount: pi.getActiveTools().length,
    usingSubscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
    contextTokens: contextUsage?.tokens ?? undefined,
    contextMaxTokens: contextUsage?.contextWindow,
    metrics: collectSessionMetrics(ctx.sessionManager.getBranch()),
    turnMetrics: collectTurnMetrics(ctx.sessionManager.getEntries()),
    eventWidgets,
  };
}

async function handleArgs(
  args: string,
  ctx: ExtensionCommandContext,
  state: LoadedFooter,
  setConfig: (config: StatuslineConfig) => Promise<void>,
): Promise<boolean> {
  const [command, value] = args.trim().split(/\s+/, 2);
  if (!command) return false;

  if (command === "on" || command === "enable") {
    await setConfig({ ...state.config, enabled: true });
    ctx.ui.notify("pi-footer enabled", "info");
    return true;
  }
  if (command === "off" || command === "disable") {
    await setConfig({ ...state.config, enabled: false });
    ctx.ui.notify("pi-footer disabled", "info");
    return true;
  }
  if (command === "reset") {
    await setConfig(state.mod.cloneConfig(state.mod.DEFAULT_CONFIG));
    ctx.ui.notify("pi-footer reset to defaults", "info");
    return true;
  }
  if (command === "preset" && state.mod.isPreset(value)) {
    await setConfig(state.mod.configWithPreset(state.config, value));
    ctx.ui.notify(`pi-footer preset: ${value}`, "info");
    return true;
  }

  ctx.ui.notify(
    "Usage: /footer [on|off|reset|preset compact|default|powerline|powerline-bright|powerline-blocks|powerline-mono|git-heavy|pi-footer|demo|demo-standard]",
    "warning",
  );
  return true;
}

function getTextVerbosity(
  model: ExtensionContext["model"],
  liveVerbosity: string | undefined,
): string | undefined {
  // pi exposes text verbosity only through the OpenAI Codex Responses provider.
  if (!model || model.api !== "openai-codex-responses") return undefined;
  // Prefer the value captured from the real request payload; before the first
  // request (or just after a model switch) fall back to the provider default.
  return liveVerbosity ?? "low";
}

function readTextVerbosity(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const text = payload.text;
  if (!isRecord(text)) return undefined;
  return typeof text.verbosity === "string" ? text.verbosity : undefined;
}
