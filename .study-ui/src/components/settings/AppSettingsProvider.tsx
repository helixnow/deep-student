import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  getFontFamilyStack,
  getSidebarGlassAlphaShift,
  getStoredAppSettings,
  setStoredAppSettings,
  type AppSettings,
  type DebugLogType,
} from "@/lib/app-settings";
import { detectDesktopPlatform } from "@/lib/app-shell";

type AppSettingsContextValue = {
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
  resetInterfaceScale: () => void;
  resetFontFamily: () => void;
  resetFontSizeScale: () => void;
  toggleLogType: (logType: DebugLogType) => void;
};

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

function getInitialSettings() {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  return getStoredAppSettings(window.localStorage);
}

function applyAppSettingsToDocument(settings: AppSettings) {
  const root = document.documentElement;
  const sidebarGlassAlphaShift = getSidebarGlassAlphaShift(settings.sidebarGlassIntensity);
  const desktopPlatform = detectDesktopPlatform({
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  });
  const fontSmoothing =
    desktopPlatform !== "macos"
      ? "system-default"
      : settings.macosNativeFontSmoothing
        ? "macos-native"
        : "macos-grayscale";

  root.lang = settings.language;
  root.dataset.fontSmoothing = fontSmoothing;
  root.style.setProperty("--app-interface-scale", `${settings.interfaceScale / 100}`);
  root.style.setProperty("--app-font-scale", `${settings.fontSizeScale / 100}`);
  root.style.setProperty("--app-font-family", getFontFamilyStack(settings.fontFamily));
  root.style.setProperty("--app-sidebar-glass-alpha-shift", `${sidebarGlassAlphaShift}`);
}

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => getInitialSettings());

  useEffect(() => {
    applyAppSettingsToDocument(settings);
    setStoredAppSettings(window.localStorage, settings);
  }, [settings]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== null && event.key !== APP_SETTINGS_STORAGE_KEY) {
        return;
      }

      setSettings(getStoredAppSettings(window.localStorage));
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const value = useMemo<AppSettingsContextValue>(
    () => ({
      settings,
      updateSetting: (key, nextValue) => {
        setSettings((currentSettings) => ({
          ...currentSettings,
          [key]: nextValue,
        }));
      },
      resetInterfaceScale: () => {
        setSettings((currentSettings) => ({
          ...currentSettings,
          interfaceScale: DEFAULT_APP_SETTINGS.interfaceScale,
        }));
      },
      resetFontFamily: () => {
        setSettings((currentSettings) => ({
          ...currentSettings,
          fontFamily: DEFAULT_APP_SETTINGS.fontFamily,
        }));
      },
      resetFontSizeScale: () => {
        setSettings((currentSettings) => ({
          ...currentSettings,
          fontSizeScale: DEFAULT_APP_SETTINGS.fontSizeScale,
        }));
      },
      toggleLogType: (logType) => {
        setSettings((currentSettings) => {
          const hasLogType = currentSettings.logTypes.includes(logType);
          const nextLogTypes = hasLogType
            ? currentSettings.logTypes.filter((value) => value !== logType)
            : [...currentSettings.logTypes, logType];

          return {
            ...currentSettings,
            logTypes: nextLogTypes.length > 0 ? nextLogTypes : currentSettings.logTypes,
          };
        });
      },
    }),
    [settings],
  );

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);

  if (!context) {
    throw new Error("useAppSettings must be used within AppSettingsProvider");
  }

  return context;
}
