// The extension's deferred entry point. Everything re-exported here transitively imports the
// widget registry — and with it every widget implementation module — so this file must stay
// out of the eager import graph: load it on first footer render or on /footer, never at
// startup.
export {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  isPreset,
  loadConfig,
  saveConfig,
} from "./config.ts";
export { renderStatuslines } from "./render.ts";
export { WidgetStore } from "./widgets/store.ts";
