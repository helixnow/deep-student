import { detectDesktopPlatform, type DesktopPlatform } from "./app-shell.ts";
import type { ResolvedTheme, WindowBackgroundPreference } from "./theme.ts";

type NativeWindowColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

type NativeWindowEffectPreset =
  | "macos-window-background"
  | "macos-content-background"
  | "macos-sidebar"
  | "windows-mica"
  | "windows-tabbed"
  | "windows-blur";

type NativeWindowEffectSettings = {
  state?: "followsWindowActiveState";
  radius?: number;
  color?: NativeWindowColor;
};

type NativeWindowAppearance = {
  backgroundColor: NativeWindowColor;
  effectPresets: NativeWindowEffectPreset[];
  effectSettings: NativeWindowEffectSettings | null;
  fallbackBackgroundColor: NativeWindowColor;
};

type NativeWindowHandle = {
  clearEffects: () => Promise<void>;
  setBackgroundColor: (color: NativeWindowColor) => Promise<void>;
  setEffects: (effects: { effects: string[]; state?: string; radius?: number; color?: NativeWindowColor }) => Promise<void>;
};

type NativeWindowRuntime = {
  effectMap: {
    macosWindowBackground: string;
    macosContentBackground: string;
    macosSidebar: string;
    windowsBlur: string;
    windowsMica: string;
    windowsTabbed: string;
  };
  window: NativeWindowHandle;
};

type ApplyNativeWindowAppearanceInput = {
  platform?: DesktopPlatform;
  reducedTransparency?: boolean;
  resolvedTheme: ResolvedTheme;
  windowBackgroundPreference: WindowBackgroundPreference;
};

type ApplyNativeWindowAppearanceDependencies = {
  getRuntime?: () => Promise<NativeWindowRuntime | null>;
};

const LIGHT_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 249,
  green: 249,
  blue: 249,
  alpha: 255,
};

const DARK_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 24,
  green: 24,
  blue: 24,
  alpha: 255,
};

const LIGHT_TRANSLUCENT_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 249,
  green: 249,
  blue: 249,
  alpha: 214,
};

const DARK_TRANSLUCENT_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 24,
  green: 24,
  blue: 24,
  alpha: 156,
};
const LIGHT_CLEAR_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 249,
  green: 249,
  blue: 249,
  alpha: 0,
};
const DARK_CLEAR_WINDOW_BACKGROUND: NativeWindowColor = {
  red: 24,
  green: 24,
  blue: 24,
  alpha: 0,
};

let nativeWindowRuntimePromise: Promise<NativeWindowRuntime | null> | null = null;

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getCurrentDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") {
    return "other";
  }

  return detectDesktopPlatform({
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  });
}

async function loadNativeWindowRuntime(): Promise<NativeWindowRuntime | null> {
  if (!hasTauriRuntime()) {
    return null;
  }

  const windowModule = await import("@tauri-apps/api/window");

  return {
    effectMap: {
      macosWindowBackground: windowModule.Effect.WindowBackground,
      macosContentBackground: windowModule.Effect.ContentBackground,
      macosSidebar: windowModule.Effect.Sidebar,
      windowsBlur: windowModule.Effect.Blur,
      windowsMica: windowModule.Effect.Mica,
      windowsTabbed: windowModule.Effect.Tabbed,
    },
    window: windowModule.getCurrentWindow() as unknown as NativeWindowHandle,
  };
}

function getNativeWindowRuntime() {
  nativeWindowRuntimePromise ??= loadNativeWindowRuntime();
  return nativeWindowRuntimePromise;
}

function getEffectToken(runtime: NativeWindowRuntime, effectPreset: NativeWindowEffectPreset) {
  if (effectPreset === "macos-window-background") {
    return runtime.effectMap.macosWindowBackground;
  }

  if (effectPreset === "macos-content-background") {
    return runtime.effectMap.macosContentBackground;
  }

  if (effectPreset === "macos-sidebar") {
    return runtime.effectMap.macosSidebar;
  }

  if (effectPreset === "windows-mica") {
    return runtime.effectMap.windowsMica;
  }

  if (effectPreset === "windows-tabbed") {
    return runtime.effectMap.windowsTabbed;
  }

  return runtime.effectMap.windowsBlur;
}

async function clearEffectsAndRestoreFallback(
  runtime: NativeWindowRuntime,
  fallbackBackgroundColor: NativeWindowColor,
) {
  try {
    await runtime.window.clearEffects();
  } catch (error) {
    void error;
  }

  try {
    await runtime.window.setBackgroundColor(fallbackBackgroundColor);
  } catch (error) {
    void error;
  }
}

export function getNativeWindowAppearance(input: {
  platform: DesktopPlatform;
  reducedTransparency?: boolean;
  resolvedTheme: ResolvedTheme;
  windowBackgroundPreference: WindowBackgroundPreference;
}): NativeWindowAppearance {
  const opaqueBackgroundColor =
    input.resolvedTheme === "dark" ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
  const clearBackgroundColor =
    input.resolvedTheme === "dark" ? DARK_CLEAR_WINDOW_BACKGROUND : LIGHT_CLEAR_WINDOW_BACKGROUND;
  const translucentBackgroundColor =
    input.resolvedTheme === "dark"
      ? DARK_TRANSLUCENT_WINDOW_BACKGROUND
      : LIGHT_TRANSLUCENT_WINDOW_BACKGROUND;
  const reducedTransparency = input.reducedTransparency ?? false;

  if (input.windowBackgroundPreference === "opaque") {
    return {
      backgroundColor: opaqueBackgroundColor,
      effectPresets: [],
      effectSettings: null,
      fallbackBackgroundColor: opaqueBackgroundColor,
    };
  }

  if (input.platform === "macos") {
    if (reducedTransparency) {
      return {
        backgroundColor: opaqueBackgroundColor,
        effectPresets: [],
        effectSettings: null,
        fallbackBackgroundColor: opaqueBackgroundColor,
      };
    }

    return {
      backgroundColor: clearBackgroundColor,
      effectPresets: ["macos-window-background"],
      effectSettings: {
        state: "followsWindowActiveState",
      },
      fallbackBackgroundColor: opaqueBackgroundColor,
    };
  }

  if (input.platform === "windows") {
    return {
      backgroundColor: translucentBackgroundColor,
      effectPresets: ["windows-mica", "windows-blur"],
      effectSettings: {
        color: translucentBackgroundColor,
      },
      fallbackBackgroundColor: opaqueBackgroundColor,
    };
  }

  return {
    backgroundColor: opaqueBackgroundColor,
    effectPresets: [],
    effectSettings: null,
    fallbackBackgroundColor: opaqueBackgroundColor,
  };
}

export async function applyNativeWindowAppearance(
  input: ApplyNativeWindowAppearanceInput,
  dependencies: ApplyNativeWindowAppearanceDependencies = {},
) {
  const platform = input.platform ?? getCurrentDesktopPlatform();
  const appearance = getNativeWindowAppearance({
    platform,
    reducedTransparency: input.reducedTransparency,
    resolvedTheme: input.resolvedTheme,
    windowBackgroundPreference: input.windowBackgroundPreference,
  });

  let runtime: NativeWindowRuntime | null = null;

  try {
    runtime = await (dependencies.getRuntime ?? getNativeWindowRuntime)();
  } catch {
    return "skipped" as const;
  }

  if (!runtime) {
    return "skipped" as const;
  }

  try {
    await runtime.window.setBackgroundColor(appearance.backgroundColor);
  } catch {
    return "skipped" as const;
  }

  const shouldReturnFallback =
    input.windowBackgroundPreference === "translucent" && appearance.effectPresets.length === 0;

  if (appearance.effectPresets.length === 0) {
    try {
      await runtime.window.clearEffects();
    } catch {
      return shouldReturnFallback ? ("fallback" as const) : ("applied" as const);
    }

    return shouldReturnFallback ? ("fallback" as const) : ("applied" as const);
  }

  for (const effectPreset of appearance.effectPresets) {
    try {
      await runtime.window.setEffects({
        effects: [getEffectToken(runtime, effectPreset)],
        ...(appearance.effectSettings ?? {}),
      });
      return "applied" as const;
    } catch {
      continue;
    }
  }

  await clearEffectsAndRestoreFallback(runtime, appearance.fallbackBackgroundColor);

  return "fallback" as const;
}
