import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { applyNativeWindowAppearance } from "@/lib/native-window";
import {
  shouldSyncNativeWindowBackgroundPreference,
  syncNativeWindowBackgroundPreference,
} from "@/lib/native-window-preference";
import {
  REDUCED_TRANSPARENCY_MEDIA_QUERY,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  WINDOW_BACKGROUND_STORAGE_KEY,
  getReducedTransparencyDatasetValue,
  getReducedTransparencySnapshot,
  getStoredThemePreference,
  getStoredWindowBackgroundPreference,
  getThemeDataset,
  normalizeThemePreference,
  normalizeWindowBackgroundPreference,
  resolveThemePreference,
  setStoredThemePreference,
  setStoredWindowBackgroundPreference,
  type ResolvedTheme,
  type ThemePreference,
  type WindowBackgroundPreference,
} from "@/lib/theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  windowBackgroundPreference: WindowBackgroundPreference;
  setThemePreference: (preference: ThemePreference) => void;
  setWindowBackgroundPreference: (preference: WindowBackgroundPreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialPreference(): ThemePreference {
  if (typeof document === "undefined") {
    return "system";
  }

  return normalizeThemePreference(document.documentElement.dataset.themePreference);
}

function getInitialWindowBackgroundPreference(): WindowBackgroundPreference {
  if (typeof document === "undefined") {
    return "translucent";
  }

  return normalizeWindowBackgroundPreference(document.documentElement.dataset.windowBackground);
}

function getSystemThemeSnapshot(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

function subscribeToSystemTheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const mediaQueryList = window.matchMedia(THEME_MEDIA_QUERY);
  const handleChange = () => {
    onStoreChange();
  };

  mediaQueryList.addEventListener("change", handleChange);

  return () => {
    mediaQueryList.removeEventListener("change", handleChange);
  };
}

function subscribeToReducedTransparency(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const mediaQueryList = window.matchMedia(REDUCED_TRANSPARENCY_MEDIA_QUERY);
  const handleChange = () => {
    onStoreChange();
  };

  mediaQueryList.addEventListener("change", handleChange);

  return () => {
    mediaQueryList.removeEventListener("change", handleChange);
  };
}

function applyTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
  windowBackgroundPreference: WindowBackgroundPreference,
  reducedTransparency: boolean,
) {
  const dataset = getThemeDataset(preference, systemTheme, windowBackgroundPreference);
  const root = document.documentElement;

  root.dataset.theme = dataset.theme;
  root.dataset.themePreference = dataset.themePreference;
  root.dataset.windowBackground = dataset.windowBackground;
  root.dataset.reducedTransparency = getReducedTransparencyDatasetValue(reducedTransparency);
  root.style.colorScheme = dataset.theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => getInitialPreference());
  const [windowBackgroundPreference, setWindowBackgroundPreference] =
    useState<WindowBackgroundPreference>(() => getInitialWindowBackgroundPreference());
  const lastSyncedNativeWindowBackgroundPreference = useRef<WindowBackgroundPreference | null>(null);
  const systemTheme = useSyncExternalStore<ResolvedTheme>(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    (): ResolvedTheme => "light",
  );
  const reducedTransparency = useSyncExternalStore(
    subscribeToReducedTransparency,
    getReducedTransparencySnapshot,
    () => false,
  );

  const resolvedTheme = useMemo(
    () => resolveThemePreference(preference, systemTheme),
    [preference, systemTheme],
  );

  useEffect(() => {
    const resolved = resolveThemePreference(preference, systemTheme);
    applyTheme(preference, systemTheme, windowBackgroundPreference, reducedTransparency);
    setStoredThemePreference(window.localStorage, preference);
    setStoredWindowBackgroundPreference(window.localStorage, windowBackgroundPreference);
    void applyNativeWindowAppearance({
      resolvedTheme: resolved,
      reducedTransparency,
      windowBackgroundPreference,
    }).catch((err: unknown) => {
      console.warn("[theme] native window appearance failed:", err);
    });
  }, [preference, systemTheme, reducedTransparency, windowBackgroundPreference]);

  useEffect(() => {
    if (
      !shouldSyncNativeWindowBackgroundPreference(
        lastSyncedNativeWindowBackgroundPreference.current,
        windowBackgroundPreference,
      )
    ) {
      lastSyncedNativeWindowBackgroundPreference.current = windowBackgroundPreference;
      return;
    }

    lastSyncedNativeWindowBackgroundPreference.current = windowBackgroundPreference;
    void syncNativeWindowBackgroundPreference(windowBackgroundPreference);
  }, [windowBackgroundPreference]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (
        event.key !== null &&
        event.key !== THEME_STORAGE_KEY &&
        event.key !== WINDOW_BACKGROUND_STORAGE_KEY
      ) {
        return;
      }

      setPreference(getStoredThemePreference(window.localStorage));
      setWindowBackgroundPreference(getStoredWindowBackgroundPreference(window.localStorage));
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      windowBackgroundPreference,
      setThemePreference: setPreference,
      setWindowBackgroundPreference,
    }),
    [preference, resolvedTheme, windowBackgroundPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}
