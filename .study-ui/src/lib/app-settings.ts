export const APP_SETTINGS_STORAGE_KEY = "study-ui-app-settings";

export const INTERFACE_SCALE_RANGE = { min: 80, max: 125, step: 5 } as const;
export const FONT_SIZE_SCALE_RANGE = { min: 90, max: 120, step: 5 } as const;
export const SIDEBAR_GLASS_INTENSITY_RANGE = { min: 80, max: 180, step: 5 } as const;
export const TITLEBAR_TOP_INSET_RANGE = { min: 0, max: 64, step: 1 } as const;

export type AppLanguage = "zh-CN" | "en-US";
export type AppFontFamily = "system" | "sans" | "serif" | "mono";
export type DebugLogType = "backend";
export type CopyImageMode = "ignore" | "placeholder" | "original";
export type CopyToolsMode = "ignore" | "summary" | "full";
export type CopyMessageMode = "summary" | "full";
export type CopyThinkingMode = "remove" | "keep";

export type AppSettings = {
  language: AppLanguage;
  interfaceScale: number;
  fontFamily: AppFontFamily;
  fontSizeScale: number;
  macosNativeFontSmoothing: boolean;
  sidebarGlassIntensity: number;
  titlebarTopInset: number;
  debugLoggingEnabled: boolean;
  logTypes: DebugLogType[];
  showMessageRequestBody: boolean;
  imageCopyMode: CopyImageMode;
  toolsCopyMode: CopyToolsMode;
  messageCopyMode: CopyMessageMode;
  thinkingCopyMode: CopyThinkingMode;
  persistDebugLogs: boolean;
  memoryRootFolder: string;
  autoCreateMemoryFolders: boolean;
  defaultMemoryCategory: string;
  memoryPrivacyMode: boolean;
  anonymousCrashReports: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const FONT_FAMILY_STACKS: Record<AppFontFamily, string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
  sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  serif: '"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", serif',
  mono: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: "zh-CN",
  interfaceScale: 100,
  fontFamily: "system",
  fontSizeScale: 100,
  macosNativeFontSmoothing: true,
  sidebarGlassIntensity: 100,
  titlebarTopInset: 0,
  debugLoggingEnabled: false,
  logTypes: ["backend"],
  showMessageRequestBody: false,
  imageCopyMode: "placeholder",
  toolsCopyMode: "summary",
  messageCopyMode: "full",
  thinkingCopyMode: "keep",
  persistDebugLogs: false,
  memoryRootFolder: "记忆",
  autoCreateMemoryFolders: true,
  defaultMemoryCategory: "通用",
  memoryPrivacyMode: false,
  anonymousCrashReports: false,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isLanguage(value: unknown): value is AppLanguage {
  return value === "zh-CN" || value === "en-US";
}

function isFontFamily(value: unknown): value is AppFontFamily {
  return value === "system" || value === "sans" || value === "serif" || value === "mono";
}

function isDebugLogType(value: unknown): value is DebugLogType {
  return value === "backend";
}

function isCopyImageMode(value: unknown): value is CopyImageMode {
  return value === "ignore" || value === "placeholder" || value === "original";
}

function isCopyToolsMode(value: unknown): value is CopyToolsMode {
  return value === "ignore" || value === "summary" || value === "full";
}

function isCopyMessageMode(value: unknown): value is CopyMessageMode {
  return value === "summary" || value === "full";
}

function isCopyThinkingMode(value: unknown): value is CopyThinkingMode {
  return value === "remove" || value === "keep";
}

function normalizeScale(value: unknown, range: { min: number; max: number; step: number }, fallback: number) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const snapped = Math.round(parsed / range.step) * range.step;
  return clamp(snapped, range.min, range.max);
}

export function getSidebarGlassAlphaShift(value: unknown) {
  const intensity = normalizeScale(
    value,
    SIDEBAR_GLASS_INTENSITY_RANGE,
    DEFAULT_APP_SETTINGS.sidebarGlassIntensity,
  );

  if (intensity === DEFAULT_APP_SETTINGS.sidebarGlassIntensity) {
    return 0;
  }

  if (intensity > DEFAULT_APP_SETTINGS.sidebarGlassIntensity) {
    if (intensity <= 140) {
      const ratio = (intensity - DEFAULT_APP_SETTINGS.sidebarGlassIntensity) / 40;
      return Number((-0.26 * ratio).toFixed(3));
    }

    const ratio = (intensity - 140) / (SIDEBAR_GLASS_INTENSITY_RANGE.max - 140);
    return Number((-0.26 - 0.08 * ratio).toFixed(3));
  }

  const ratio =
    (DEFAULT_APP_SETTINGS.sidebarGlassIntensity - intensity) /
    (DEFAULT_APP_SETTINGS.sidebarGlassIntensity - SIDEBAR_GLASS_INTENSITY_RANGE.min);

  return Number((0.12 * ratio).toFixed(3));
}

function normalizeTitlebarTopInset(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_APP_SETTINGS.titlebarTopInset;
  }

  return clamp(Math.round(parsed), TITLEBAR_TOP_INSET_RANGE.min, TITLEBAR_TOP_INSET_RANGE.max);
}

function normalizeLogTypes(value: unknown): DebugLogType[] {
  if (!Array.isArray(value)) {
    return DEFAULT_APP_SETTINGS.logTypes;
  }

  const nextValue = Array.from(new Set(value.filter(isDebugLogType)));
  return nextValue.length > 0 ? nextValue : DEFAULT_APP_SETTINGS.logTypes;
}

function toBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function toStringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_APP_SETTINGS;
  }

  const input = value as Partial<AppSettings>;

  return {
    language: isLanguage(input.language) ? input.language : DEFAULT_APP_SETTINGS.language,
    interfaceScale: normalizeScale(
      input.interfaceScale,
      INTERFACE_SCALE_RANGE,
      DEFAULT_APP_SETTINGS.interfaceScale,
    ),
    fontFamily: isFontFamily(input.fontFamily) ? input.fontFamily : DEFAULT_APP_SETTINGS.fontFamily,
    fontSizeScale: normalizeScale(
      input.fontSizeScale,
      FONT_SIZE_SCALE_RANGE,
      DEFAULT_APP_SETTINGS.fontSizeScale,
    ),
    macosNativeFontSmoothing: toBoolean(
      input.macosNativeFontSmoothing,
      DEFAULT_APP_SETTINGS.macosNativeFontSmoothing,
    ),
    sidebarGlassIntensity: normalizeScale(
      input.sidebarGlassIntensity,
      SIDEBAR_GLASS_INTENSITY_RANGE,
      DEFAULT_APP_SETTINGS.sidebarGlassIntensity,
    ),
    titlebarTopInset: normalizeTitlebarTopInset(input.titlebarTopInset),
    debugLoggingEnabled: toBoolean(input.debugLoggingEnabled, DEFAULT_APP_SETTINGS.debugLoggingEnabled),
    logTypes: normalizeLogTypes(input.logTypes),
    showMessageRequestBody: toBoolean(
      input.showMessageRequestBody,
      DEFAULT_APP_SETTINGS.showMessageRequestBody,
    ),
    imageCopyMode: isCopyImageMode(input.imageCopyMode)
      ? input.imageCopyMode
      : DEFAULT_APP_SETTINGS.imageCopyMode,
    toolsCopyMode: isCopyToolsMode(input.toolsCopyMode)
      ? input.toolsCopyMode
      : DEFAULT_APP_SETTINGS.toolsCopyMode,
    messageCopyMode: isCopyMessageMode(input.messageCopyMode)
      ? input.messageCopyMode
      : DEFAULT_APP_SETTINGS.messageCopyMode,
    thinkingCopyMode: isCopyThinkingMode(input.thinkingCopyMode)
      ? input.thinkingCopyMode
      : DEFAULT_APP_SETTINGS.thinkingCopyMode,
    persistDebugLogs: toBoolean(input.persistDebugLogs, DEFAULT_APP_SETTINGS.persistDebugLogs),
    memoryRootFolder: toStringValue(input.memoryRootFolder, DEFAULT_APP_SETTINGS.memoryRootFolder),
    autoCreateMemoryFolders: toBoolean(
      input.autoCreateMemoryFolders,
      DEFAULT_APP_SETTINGS.autoCreateMemoryFolders,
    ),
    defaultMemoryCategory: toStringValue(
      input.defaultMemoryCategory,
      DEFAULT_APP_SETTINGS.defaultMemoryCategory,
    ),
    memoryPrivacyMode: toBoolean(input.memoryPrivacyMode, DEFAULT_APP_SETTINGS.memoryPrivacyMode),
    anonymousCrashReports: toBoolean(
      input.anonymousCrashReports,
      DEFAULT_APP_SETTINGS.anonymousCrashReports,
    ),
  };
}

export function getStoredAppSettings(
  storage?: StorageLike | null,
  storageKey = APP_SETTINGS_STORAGE_KEY,
) {
  if (!storage) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const rawValue = storage.getItem(storageKey);

    if (!rawValue) {
      return DEFAULT_APP_SETTINGS;
    }

    return normalizeAppSettings(JSON.parse(rawValue));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function setStoredAppSettings(
  storage: StorageLike | null | undefined,
  settings: AppSettings,
  storageKey = APP_SETTINGS_STORAGE_KEY,
) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    return;
  }
}

export function getFontFamilyStack(fontFamily: AppFontFamily) {
  return FONT_FAMILY_STACKS[fontFamily];
}
