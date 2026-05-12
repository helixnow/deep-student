export const THEME_STORAGE_KEY = "study-ui-theme";
export const WINDOW_BACKGROUND_STORAGE_KEY = "study-ui-window-background";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
export const REDUCED_TRANSPARENCY_MEDIA_QUERY = "(prefers-reduced-transparency: reduce)";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type WindowBackgroundPreference = "translucent" | "opaque";

type ThemeDataset = {
  theme: ResolvedTheme;
  themePreference: ThemePreference;
  windowBackground: WindowBackgroundPreference;
};

type ThemeStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type MediaQueryTarget = Pick<Window, "matchMedia">;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function isWindowBackgroundPreference(value: unknown): value is WindowBackgroundPreference {
  return value === "translucent" || value === "opaque";
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : "system";
}

export function normalizeWindowBackgroundPreference(
  value: unknown,
): WindowBackgroundPreference {
  return isWindowBackgroundPreference(value) ? value : "translucent";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

export function getReducedTransparencySnapshot(
  target: MediaQueryTarget | null | undefined =
    typeof window !== "undefined" ? window : undefined,
) {
  if (!target || typeof target.matchMedia !== "function") {
    return false;
  }

  return target.matchMedia(REDUCED_TRANSPARENCY_MEDIA_QUERY).matches;
}

export function getReducedTransparencyDatasetValue(prefersReducedTransparency: boolean) {
  return prefersReducedTransparency ? "reduce" : "no-preference";
}

export function getThemeDataset(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
  windowBackground: WindowBackgroundPreference = "translucent",
): ThemeDataset {
  return {
    theme: resolveThemePreference(preference, systemTheme),
    themePreference: preference,
    windowBackground,
  };
}

export function getStoredThemePreference(
  storage?: ThemeStorage | null,
  storageKey = THEME_STORAGE_KEY,
): ThemePreference {
  if (!storage) {
    return "system";
  }

  try {
    return normalizeThemePreference(storage.getItem(storageKey));
  } catch {
    return "system";
  }
}

export function getStoredWindowBackgroundPreference(
  storage?: ThemeStorage | null,
  storageKey = WINDOW_BACKGROUND_STORAGE_KEY,
): WindowBackgroundPreference {
  if (!storage) {
    return "translucent";
  }

  try {
    return normalizeWindowBackgroundPreference(storage.getItem(storageKey));
  } catch {
    return "translucent";
  }
}

export function setStoredThemePreference(
  storage: ThemeStorage | null | undefined,
  preference: ThemePreference,
  storageKey = THEME_STORAGE_KEY,
) {
  if (!storage) {
    return;
  }

  try {
    if (preference === "system") {
      storage.removeItem(storageKey);
      return;
    }

    storage.setItem(storageKey, preference);
  } catch {
    return;
  }
}

export function setStoredWindowBackgroundPreference(
  storage: ThemeStorage | null | undefined,
  preference: WindowBackgroundPreference,
  storageKey = WINDOW_BACKGROUND_STORAGE_KEY,
) {
  if (!storage) {
    return;
  }

  try {
    if (preference === "translucent") {
      storage.removeItem(storageKey);
      return;
    }

    storage.setItem(storageKey, preference);
  } catch {
    return;
  }
}

export function createThemeBootScript(
  themeStorageKey = THEME_STORAGE_KEY,
  windowBackgroundStorageKey = WINDOW_BACKGROUND_STORAGE_KEY,
) {
  const serializedThemeStorageKey = JSON.stringify(themeStorageKey);
  const serializedWindowBackgroundStorageKey = JSON.stringify(windowBackgroundStorageKey);
  const serializedMediaQuery = JSON.stringify(THEME_MEDIA_QUERY);
  const serializedReducedTransparencyMediaQuery = JSON.stringify(
    REDUCED_TRANSPARENCY_MEDIA_QUERY,
  );

  return `(() => {
  const root = document.documentElement;
  let preference = "system";
  let windowBackground = "translucent";

  try {
    const storedPreference = localStorage.getItem(${serializedThemeStorageKey});
    if (storedPreference === "light" || storedPreference === "dark" || storedPreference === "system") {
      preference = storedPreference;
    }

    const storedWindowBackground = localStorage.getItem(${serializedWindowBackgroundStorageKey});
    if (storedWindowBackground === "translucent" || storedWindowBackground === "opaque") {
      windowBackground = storedWindowBackground;
    }
  } catch {}

  const prefersDark = window.matchMedia(${serializedMediaQuery}).matches;
  const prefersReducedTransparency = typeof window.matchMedia === "function"
    && window.matchMedia(${serializedReducedTransparencyMediaQuery}).matches;
  const resolvedTheme = preference === "system" ? (prefersDark ? "dark" : "light") : preference;

  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.dataset.windowBackground = windowBackground;
  root.dataset.reducedTransparency = prefersReducedTransparency ? "reduce" : "no-preference";
  root.style.colorScheme = resolvedTheme;
})();`;
}
