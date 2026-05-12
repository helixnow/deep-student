import { invoke } from "@tauri-apps/api/core";

import type { WindowBackgroundPreference } from "./theme.ts";

type SyncNativeWindowBackgroundPreferenceDependencies = {
  hasTauriRuntime?: () => boolean;
  invoke?: (command: string, payload: { preference: WindowBackgroundPreference }) => Promise<unknown>;
};

function defaultHasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function shouldSyncNativeWindowBackgroundPreference(
  previousPreference: WindowBackgroundPreference | null,
  nextPreference: WindowBackgroundPreference,
) {
  return previousPreference !== null && previousPreference !== nextPreference;
}

export async function syncNativeWindowBackgroundPreference(
  preference: WindowBackgroundPreference,
  dependencies: SyncNativeWindowBackgroundPreferenceDependencies = {},
) {
  const hasTauriRuntime = dependencies.hasTauriRuntime ?? defaultHasTauriRuntime;

  if (!hasTauriRuntime()) {
    return "skipped" as const;
  }

  try {
    await (dependencies.invoke ?? invoke)("set_window_background_preference", { preference });
  } catch (err: unknown) {
    console.warn("[native-window] background preference sync failed:", err);
    return "skipped" as const;
  }

  return "synced" as const;
}
