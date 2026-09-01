/**
 * WorkbenchSettingsSection — 学习桌面（Workbench）实验设置区（P10）
 *
 * 设计文档：docs/dev/learning-os-workbench-design.md §3.3 / §6.5
 * 全部设置走现有 get_setting / save_setting invoke 模式。
 *
 * 事件契约（P11 / P4 消费）：
 * - 总开关变化：workbenchBus.setEnabled(v) + CustomEvent 'workbench:mode-changed' { enabled }
 * - 其余设置变化：CustomEvent 'workbench:settings-changed' { key, value }
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { CircleNotch, Image as ImageIcon } from '@phosphor-icons/react';

import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect } from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
// 刻意深路径导入：workbench 公共出口（index.ts）聚合了 chat/系统应用等重量级
// re-export，settings 页只需要 bus / 材质 / 壁纸预设三个轻量模块，
// 走 index 会把整条 chat store 链拖进 settings bundle（见 P10 进度文件遗留项）。
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { setMaterialTier, type MaterialTierSetting } from '@/features/workbench/core/materialTier';
import { WALLPAPER_PRESETS, DEFAULT_WALLPAPER, type WallpaperConfig } from '@/features/workbench/components/WallpaperLayer';
import {
  parseTitleBarDoubleClickAction,
  type TitleBarDoubleClickAction,
} from '@/features/workbench/components/titleBarBehaviorStore';
import { AgentCapabilitySummary } from '@/features/workbench/components/AgentControlCenter';
import {
  persistBrowserNetworkModeSelection,
  type BrowserNetworkMode,
} from './browserNetworkModePersistence';
import { OPEN_WALLPAPER_MANAGER_EVENT } from '@/features/workbench/components/WallpaperManagerDialog';
import { importWallpaperToLibrary } from './wallpaperLibrary';
import { resolveWorkbenchModeEnabled } from './workbenchMode';
import { isWorkbenchDiagnosticsRequested } from '@/features/workbench/core/workbenchDiagnosticsGate';

export type PerformanceProfile = 'quality' | 'balanced' | 'performance' | 'custom';

export const WORKBENCH_SETTING_KEYS = {
  mode: 'desktop.workbenchMode',
  performanceProfile: 'desktop.workbenchPerformanceProfile',
  materialTier: 'desktop.workbenchMaterialTier',
  wallpaper: 'desktop.workbenchWallpaper',
  tileMargins: 'desktop.workbenchTileMargins',
  dockSize: 'desktop.workbenchDockSize',
  dockAutohide: 'desktop.workbenchDockAutohide',
  /**
   * 下次启动是否恢复上次桌面窗口布局（默认关：冷启动更快）。
   * 快照仍会后台保存；关闭时仅跳过启动 hydrate。
   */
  restoreSession: 'desktop.workbenchRestoreSession',
  /** 菜单栏自动隐藏（StatusBar 自读；见 menuBarAutohideStore） */
  menuBarAutohide: 'desktop.workbenchMenuBarAutohide',
  /** 双击标题栏行为（WindowTitleBar 自读；见 titleBarBehaviorStore） */
  titleBarDoubleClick: 'desktop.workbenchTitleBarDoubleClick',
  devPanel: 'desktop.workbenchDevPanel',
  /** 内置浏览器子闸（受 workbenchMode 父闸约束） */
  browserEnabled: 'desktop.workbenchBrowserEnabled',
  browserNetworkMode: 'desktop.workbenchBrowserNetworkMode',
  browserAgentControl: 'desktop.workbenchBrowserAgentControl',
  browserCdpWindows: 'desktop.workbenchBrowserCdpWindows',
  /** ACR 双闸设置面（R1-17）：off | background | follow */
  agentControl: 'desktop.workbenchAgentControl',
  /** ACR 演出节奏（R1-17）：fast | normal | demo */
  agentPacing: 'desktop.workbenchAgentPacing',
} as const;

export type { BrowserNetworkMode } from './browserNetworkModePersistence';

/** ACR 桌面操控档（DESIGN §6） */
export type WorkbenchAgentControl = 'off' | 'background' | 'follow';

/** ACR 演出节奏档（DESIGN §4.3） */
export type WorkbenchAgentPacing = 'fast' | 'normal' | 'demo';

/** 性能预设 → 材质 */
export const PERFORMANCE_PROFILE_PRESETS: Record<
  Exclude<PerformanceProfile, 'custom'>,
  { materialTier: MaterialTierSetting }
> = {
  quality: { materialTier: 'full' },
  balanced: { materialTier: 'reduced' },
  performance: { materialTier: 'minimal' },
};

export type WallpaperSetting = WallpaperConfig;

export interface TileMarginsSetting {
  enabled: boolean;
  px: number;
}

const DEFAULT_TILE_MARGINS: TileMarginsSetting = { enabled: true, px: 8 };
const TILE_MARGIN_MIN = 0;
const TILE_MARGIN_MAX = 32;
export const DOCK_SIZE_MIN = 75;
export const DOCK_SIZE_MAX = 125;
export const DOCK_SIZE_DEFAULT = 100;
const PRESET_IDS = WALLPAPER_PRESETS.map((preset) => preset.id);

function dispatchSettingsChanged(key: string, value: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent('workbench:settings-changed', { detail: { key, value } }));
  } catch {
    // noop
  }
}

async function closeBrowserForDisabledGate(): Promise<void> {
  try {
    await tauriInvoke('browser_close', {});
  } catch (error) {
    // Browser may be unavailable or already closed; the persisted gate remains authoritative.
    console.warn('[WorkbenchSettings] browser gate cleanup failed:', getErrorMessage(error));
  }
}

function parseJsonSetting<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...fallback, ...(parsed as Partial<T>) };
  } catch {
    // 坏数据回退默认值
  }
  return fallback;
}

function parseProfile(raw: unknown): PerformanceProfile {
  const v = String(raw ?? '');
  if (v === 'quality' || v === 'balanced' || v === 'performance' || v === 'custom') return v;
  return 'custom';
}

function parseMaterialTier(raw: unknown): MaterialTierSetting {
  const tier = String(raw ?? '');
  return tier === 'full' || tier === 'reduced' || tier === 'minimal' ? tier : 'auto';
}

function parseBrowserNetworkMode(raw: unknown): BrowserNetworkMode {
  return String(raw ?? '') === 'full' ? 'full' : 'local_whitelist';
}

function parseAgentControl(raw: unknown): WorkbenchAgentControl {
  const v = String(raw ?? '').trim();
  if (!v) return 'follow'; // 未设置 = 开箱默认跟随
  if (v === 'off' || v === 'background' || v === 'follow') return v;
  return 'off';
}

function parseAgentPacing(raw: unknown): WorkbenchAgentPacing {
  const v = String(raw ?? '');
  if (v === 'fast' || v === 'normal' || v === 'demo') return v;
  return 'normal';
}

export function parseDockSize(raw: unknown): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return DOCK_SIZE_DEFAULT;
  return Math.max(DOCK_SIZE_MIN, Math.min(DOCK_SIZE_MAX, value));
}

export interface WorkbenchSettingsSectionProps {
  className?: string;
}

export const WorkbenchSettingsSection: React.FC<WorkbenchSettingsSectionProps> = ({ className }) => {
  const { t } = useTranslation(['workbench', 'settings']);

  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState(true);
  const [performanceProfile, setPerformanceProfile] = useState<PerformanceProfile>('custom');
  const [materialTier, setMaterialTierState] = useState<MaterialTierSetting>('auto');
  const [wallpaper, setWallpaper] = useState<WallpaperSetting>(DEFAULT_WALLPAPER);
  const [wallpaperImportPending, setWallpaperImportPending] = useState(false);
  const wallpaperImportPendingRef = useRef(false);
  const [tileMargins, setTileMargins] = useState<TileMarginsSetting>(DEFAULT_TILE_MARGINS);
  const [dockSize, setDockSize] = useState(DOCK_SIZE_DEFAULT);
  const [dockAutohide, setDockAutohide] = useState(false);
  const [restoreSession, setRestoreSession] = useState(false);
  const [menuBarAutohide, setMenuBarAutohide] = useState(false);
  const [titleBarDoubleClick, setTitleBarDoubleClick] = useState<TitleBarDoubleClickAction>('zoom');
  const [devPanel, setDevPanel] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserNetworkMode, setBrowserNetworkMode] = useState<BrowserNetworkMode>('local_whitelist');
  const [browserNetworkModeSaving, setBrowserNetworkModeSaving] = useState(false);
  const [browserAgentControl, setBrowserAgentControl] = useState(false);
  const [browserCdpWindows, setBrowserCdpWindows] = useState(false);
  const [browserAdvancedOpen, setBrowserAdvancedOpen] = useState(false);
  const [browserFullNetworkConfirmOpen, setBrowserFullNetworkConfirmOpen] = useState(false);
  const [agentControl, setAgentControl] = useState<WorkbenchAgentControl>('follow');
  const [agentPacing, setAgentPacing] = useState<WorkbenchAgentPacing>('normal');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const read = (key: string) =>
        (tauriInvoke('get_setting', { key }) as Promise<string | null>).catch(() => null);
      const [
        modeResult,
        profileVal,
        tierVal,
        wallpaperVal,
        marginsVal,
        dockSizeVal,
        autohideVal,
        restoreSessionVal,
        menuBarAutohideVal,
        titleBarDoubleClickVal,
        devPanelVal,
        browserEnabledVal,
        browserNetworkModeVal,
        browserAgentControlVal,
        browserCdpWindowsVal,
        agentControlVal,
        agentPacingVal,
      ] = await Promise.all([
        resolveWorkbenchModeEnabled(),
        read(WORKBENCH_SETTING_KEYS.performanceProfile),
        read(WORKBENCH_SETTING_KEYS.materialTier),
        read(WORKBENCH_SETTING_KEYS.wallpaper),
        read(WORKBENCH_SETTING_KEYS.tileMargins),
        read(WORKBENCH_SETTING_KEYS.dockSize),
        read(WORKBENCH_SETTING_KEYS.dockAutohide),
        read(WORKBENCH_SETTING_KEYS.restoreSession),
        read(WORKBENCH_SETTING_KEYS.menuBarAutohide),
        read(WORKBENCH_SETTING_KEYS.titleBarDoubleClick),
        read(WORKBENCH_SETTING_KEYS.devPanel),
        read(WORKBENCH_SETTING_KEYS.browserEnabled),
        read(WORKBENCH_SETTING_KEYS.browserNetworkMode),
        read(WORKBENCH_SETTING_KEYS.browserAgentControl),
        read(WORKBENCH_SETTING_KEYS.browserCdpWindows),
        read(WORKBENCH_SETTING_KEYS.agentControl),
        read(WORKBENCH_SETTING_KEYS.agentPacing),
      ]);
      if (cancelled) return;
      setMode(modeResult.enabled);
      setPerformanceProfile(parseProfile(profileVal));
      setMaterialTierState(parseMaterialTier(tierVal));
      const wp = parseJsonSetting<WallpaperSetting>(wallpaperVal, DEFAULT_WALLPAPER);
      setWallpaper(wp);
      setTileMargins(parseJsonSetting<TileMarginsSetting>(marginsVal, DEFAULT_TILE_MARGINS));
      setDockSize(parseDockSize(dockSizeVal));
      setDockAutohide(String(autohideVal ?? '') === 'true');
      setRestoreSession(String(restoreSessionVal ?? '') === 'true');
      setMenuBarAutohide(String(menuBarAutohideVal ?? '') === 'true');
      setTitleBarDoubleClick(parseTitleBarDoubleClickAction(titleBarDoubleClickVal));
      setDevPanel(String(devPanelVal ?? '') === 'true');
      setBrowserEnabled(String(browserEnabledVal ?? '') === 'true');
      setBrowserNetworkMode(parseBrowserNetworkMode(browserNetworkModeVal));
      setBrowserAgentControl(String(browserAgentControlVal ?? '') === 'true');
      setBrowserCdpWindows(String(browserCdpWindowsVal ?? '') === 'true');
      setAgentControl(parseAgentControl(agentControlVal));
      setAgentPacing(parseAgentPacing(agentPacingVal));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (key: string, rawValue: string, parsedValue: unknown): Promise<boolean> => {
      try {
        await tauriInvoke('save_setting', { key, value: rawValue });
        dispatchSettingsChanged(key, parsedValue);
        return true;
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
        return false;
      }
    },
    [],
  );

  const markCustomIfNeeded = useCallback(() => {
    setPerformanceProfile((prev) => {
      if (prev === 'custom') return prev;
      void persist(WORKBENCH_SETTING_KEYS.performanceProfile, 'custom', 'custom');
      return 'custom';
    });
  }, [persist]);

  const handleModeChange = useCallback(
    async (enabled: boolean) => {
      setMode(enabled);
      const ok = await persist(WORKBENCH_SETTING_KEYS.mode, String(enabled), enabled);
      if (!ok) {
        setMode(!enabled);
        return;
      }
      if (!enabled) await closeBrowserForDisabledGate();
      workbenchBus.setEnabled(enabled);
      try {
        dispatchAppEvent(APP_EVENTS.WORKBENCH_MODE_CHANGED, { enabled });
      } catch {
        // noop
      }
    },
    [persist],
  );

  const applyMaterialTier = useCallback(
    (next: MaterialTierSetting) => {
      setMaterialTierState(next);
      setMaterialTier(next);
      void persist(WORKBENCH_SETTING_KEYS.materialTier, next, next);
    },
    [persist],
  );

  const handleProfileChange = useCallback(
    (next: PerformanceProfile) => {
      setPerformanceProfile(next);
      void persist(WORKBENCH_SETTING_KEYS.performanceProfile, next, next);
      if (next === 'custom') return;
      const preset = PERFORMANCE_PROFILE_PRESETS[next];
      applyMaterialTier(preset.materialTier);
    },
    [applyMaterialTier, persist],
  );

  const handleTierChange = useCallback(
    (next: MaterialTierSetting) => {
      markCustomIfNeeded();
      applyMaterialTier(next);
    },
    [applyMaterialTier, markCustomIfNeeded],
  );

  const saveWallpaper = useCallback(
    (next: WallpaperSetting) => {
      setWallpaper(next);
      void persist(WORKBENCH_SETTING_KEYS.wallpaper, JSON.stringify(next), next);
    },
    [persist],
  );

  const chooseCustomWallpaper = useCallback(async () => {
    if (!loaded || wallpaperImportPendingRef.current) return;
    wallpaperImportPendingRef.current = true;
    setWallpaperImportPending(true);
    try {
      const result = await importWallpaperToLibrary({
        pickerTitle: t('workbench:settings.wallpaper.selectTitle', '选择壁纸图片'),
      });

      if (result.status === 'success') {
        const next: WallpaperSetting = { kind: 'image', value: result.entry.path };
        setWallpaper(next);
        await persist(WORKBENCH_SETTING_KEYS.wallpaper, JSON.stringify(next), next);
      } else if (result.status === 'limit-exceeded') {
        showGlobalNotification(
          'warning',
          t('workbench:settings.wallpaper.limitReached', {
            limit: result.limit,
            defaultValue: '壁纸库已满（{{limit}} 张），请先删除部分壁纸',
          }),
        );
      } else if (result.status === 'error') {
        showGlobalNotification('error', getErrorMessage(result.error));
      }
    } finally {
      wallpaperImportPendingRef.current = false;
      setWallpaperImportPending(false);
    }
  }, [loaded, persist, t]);

  const saveTileMargins = useCallback(
    (next: TileMarginsSetting) => {
      setTileMargins(next);
      void persist(WORKBENCH_SETTING_KEYS.tileMargins, JSON.stringify(next), next);
    },
    [persist],
  );

  const presetOptions = WALLPAPER_PRESETS.map((preset) => ({
    value: preset.id,
    label: t(preset.nameKey, preset.id),
  }));

  const browserControlsDisabled = !mode;
  const browserEnabledDescription = browserControlsDisabled
    ? t('workbench:settings.browserEnabled.needWorkbench')
    : t('workbench:settings.browserEnabled.desc');

  const saveBrowserNetworkMode = useCallback(
    async (next: BrowserNetworkMode) => {
      if (browserNetworkModeSaving || next === browserNetworkMode) return;
      const previous = browserNetworkMode;
      setBrowserNetworkModeSaving(true);
      try {
        await persistBrowserNetworkModeSelection({
          previous,
          next,
          apply: setBrowserNetworkMode,
          persist: (mode) => persist(WORKBENCH_SETTING_KEYS.browserNetworkMode, mode, mode),
        });
      } finally {
        setBrowserNetworkModeSaving(false);
      }
    },
    [browserNetworkMode, browserNetworkModeSaving, persist],
  );

  const handleBrowserNetworkModeChange = useCallback(
    (next: BrowserNetworkMode) => {
      if (!loaded || browserControlsDisabled || browserNetworkModeSaving) return;
      if (next === 'full' && browserNetworkMode !== 'full') {
        setBrowserFullNetworkConfirmOpen(true);
        return;
      }
      setBrowserFullNetworkConfirmOpen(false);
      void saveBrowserNetworkMode(next);
    },
    [
      browserControlsDisabled,
      browserNetworkMode,
      browserNetworkModeSaving,
      loaded,
      saveBrowserNetworkMode,
    ],
  );

  const confirmBrowserFullNetworkMode = useCallback(() => {
    setBrowserFullNetworkConfirmOpen(false);
    void saveBrowserNetworkMode('full');
  }, [saveBrowserNetworkMode]);

  return (
    <SettingsGroup
      title={t('workbench:settings.sectionTitle')}
      description={t('workbench:settings.sectionDesc')}
      className={className}
    >
      <SwitchRow
        title={t('workbench:settings.mode.title')}
        description={t('workbench:settings.mode.desc')}
        checked={mode}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          void handleModeChange(next);
        }}
      />

      <SettingRow
        title={t('workbench:settings.performanceProfile.title')}
        description={t('workbench:settings.performanceProfile.desc')}
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.performanceProfile.title')}
          value={performanceProfile}
          onValueChange={(next) => {
            if (!loaded) return;
            handleProfileChange(next as PerformanceProfile);
          }}
            options={[
            {
              value: 'quality',
              label: t('workbench:settings.performanceProfile.quality'),
            },
            {
              value: 'balanced',
              label: t('workbench:settings.performanceProfile.balanced'),
            },
            {
              value: 'performance',
              label: t('workbench:settings.performanceProfile.performance'),
            },
            {
              value: 'custom',
              label: t('workbench:settings.performanceProfile.custom'),
            },
          ]}
        />
      </SettingRow>

      <SettingRow
        title={t('workbench:settings.materialTier.title')}
        description={t('workbench:settings.materialTier.desc')}
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.materialTier.title')}
          value={materialTier}
          onValueChange={(next) => {
            if (!loaded) return;
            handleTierChange(next as MaterialTierSetting);
          }}
            options={[
            { value: 'auto', label: t('workbench:settings.materialTier.auto') },
            { value: 'full', label: t('workbench:settings.materialTier.full') },
            { value: 'reduced', label: t('workbench:settings.materialTier.reduced') },
            { value: 'minimal', label: t('workbench:settings.materialTier.minimal') },
          ]}
        />
      </SettingRow>

      <SettingRow
        title={t('workbench:settings.wallpaper.title')}
        description={t('workbench:settings.wallpaper.desc')}
        className="items-center"
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl
            ariaLabel={t('workbench:settings.wallpaper.title')}
            value={wallpaper.kind}
            onValueChange={(kind) => {
              if (!loaded || wallpaperImportPending) return;
              if (kind === 'theme') {
                const value = PRESET_IDS.includes(wallpaper.value)
                  ? wallpaper.value
                  : DEFAULT_WALLPAPER.value;
                saveWallpaper({ kind: 'theme', value });
              } else {
                void chooseCustomWallpaper();
              }
            }}
            options={[
              { value: 'theme', label: t('workbench:settings.wallpaper.kindTheme') },
              { value: 'image', label: t('workbench:settings.wallpaper.kindImage') },
            ]}
          />
          {wallpaper.kind === 'theme' && !wallpaperImportPending ? (
            <AppSelect
              value={PRESET_IDS.includes(wallpaper.value) ? wallpaper.value : DEFAULT_WALLPAPER.value}
              onValueChange={(value) => {
                if (!loaded) return;
                saveWallpaper({ kind: 'theme', value });
              }}
              options={presetOptions}
              variant="outline"
              className="bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
              width={100}
            />
          ) : (
            <DsButton
              type="button"
              variant="outline"
              size="sm"
              disabled={!loaded || wallpaperImportPending}
              aria-busy={wallpaperImportPending}
              onClick={() => void chooseCustomWallpaper()}
              className="h-8 gap-1.5 text-xs"
            >
              {wallpaperImportPending ? (
                <CircleNotch size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <ImageIcon size={14} aria-hidden="true" />
              )}
              {wallpaperImportPending
                ? t('workbench:settings.wallpaper.importing', '正在导入…')
                : t('workbench:settings.wallpaper.changeImage', '更换图片')}
            </DsButton>
          )}
          <DsButton
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                window.dispatchEvent(new CustomEvent(OPEN_WALLPAPER_MANAGER_EVENT));
              } catch {
                // noop
              }
            }}          >
            {t('workbench:settings.wallpaper.manage', '管理壁纸')}
          </DsButton>
        </div>
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.tileMargins.title')}
        description={t('workbench:settings.tileMargins.desc')}
        checked={tileMargins.enabled}
        loading={!loaded}
        onCheckedChange={(enabled) => {
          if (!loaded) return;
          saveTileMargins({ ...tileMargins, enabled });
        }}
      />

      {loaded && tileMargins.enabled && (
        <SettingRow
          title={t('workbench:settings.tileMargins.px')}
          className="items-center"
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={String(tileMargins.px)}
              min={TILE_MARGIN_MIN}
              max={TILE_MARGIN_MAX}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isNaN(parsed)) return;
                const px = Math.max(TILE_MARGIN_MIN, Math.min(TILE_MARGIN_MAX, parsed));
                saveTileMargins({ ...tileMargins, px });
              }}
              className="!w-20 h-8 text-xs bg-transparent"
            />
            <span className="text-xs text-muted-foreground/70">px</span>
          </div>
        </SettingRow>
      )}

      <SettingRow
        title={t('workbench:settings.dockSize.title')}
        description={t('workbench:settings.dockSize.desc')}
        className="items-center"
      >
        <div className="flex w-52 items-center gap-3">
          <input
            type="range"
            aria-label={t('workbench:settings.dockSize.title')}
            value={dockSize}
            min={DOCK_SIZE_MIN}
            max={DOCK_SIZE_MAX}
            step={5}
            disabled={!loaded}
            onChange={(event) => {
              const next = parseDockSize(event.target.value);
              setDockSize(next);
              void persist(WORKBENCH_SETTING_KEYS.dockSize, String(next), next);
            }}
            className="h-5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <output
            aria-live="polite"
            className="w-10 text-right text-xs tabular-nums text-muted-foreground"
          >
            {dockSize}%
          </output>
        </div>
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.dockAutohide.title')}
        description={t('workbench:settings.dockAutohide.desc')}
        checked={dockAutohide}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          setDockAutohide(next);
          void persist(WORKBENCH_SETTING_KEYS.dockAutohide, String(next), next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.restoreSession.title')}
        description={t('workbench:settings.restoreSession.desc')}
        checked={restoreSession}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          setRestoreSession(next);
          void persist(WORKBENCH_SETTING_KEYS.restoreSession, String(next), next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.menubarAutohide.title')}
        description={t('workbench:settings.menubarAutohide.desc')}
        checked={menuBarAutohide}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          setMenuBarAutohide(next);
          void persist(WORKBENCH_SETTING_KEYS.menuBarAutohide, String(next), next);
        }}
      />

      <SettingRow
        title={t('workbench:settings.titleBarDoubleClick.title')}
        description={t('workbench:settings.titleBarDoubleClick.desc')}
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.titleBarDoubleClick.title')}
          value={titleBarDoubleClick}
          onValueChange={(next) => {
            if (!loaded) return;
            const value = parseTitleBarDoubleClickAction(next);
            setTitleBarDoubleClick(value);
            void persist(WORKBENCH_SETTING_KEYS.titleBarDoubleClick, value, value);
          }}
            options={[
            { value: 'zoom', label: t('workbench:settings.titleBarDoubleClick.zoom') },
            { value: 'minimize', label: t('workbench:settings.titleBarDoubleClick.minimize') },
            { value: 'none', label: t('workbench:settings.titleBarDoubleClick.none') },
          ]}
        />
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.devPanel.title')}
        description={t('workbench:settings.devPanel.desc')}
        checked={devPanel && isWorkbenchDiagnosticsRequested()}
        loading={!loaded}
        disabled={!isWorkbenchDiagnosticsRequested()}
        onCheckedChange={(next) => {
          if (!loaded || !isWorkbenchDiagnosticsRequested()) return;
          setDevPanel(next);
          void persist(WORKBENCH_SETTING_KEYS.devPanel, String(next), next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.browserEnabled.title')}
        description={browserEnabledDescription}
        checked={browserEnabled}
        loading={!loaded}
        disabled={browserControlsDisabled}
        onCheckedChange={(next) => {
          if (!loaded || browserControlsDisabled) return;
          setBrowserEnabled(next);
          void (async () => {
            const ok = await persist(WORKBENCH_SETTING_KEYS.browserEnabled, String(next), next);
            if (ok && !next) await closeBrowserForDisabledGate();
          })();
        }}
      />

      <SettingRow
        title={t('workbench:settings.browserNetworkMode.title')}
        description={
          browserControlsDisabled
            ? t('workbench:settings.browserEnabled.needWorkbench')
            : t('workbench:settings.browserNetworkMode.desc')
        }
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.browserNetworkMode.title')}
          value={browserNetworkMode}
          onValueChange={(next) => {
            handleBrowserNetworkModeChange(next as BrowserNetworkMode);
          }}
            options={[
            {
              value: 'local_whitelist',
              label: t('workbench:settings.browserNetworkMode.local_whitelist'),
              disabled: browserControlsDisabled || browserNetworkModeSaving,
            },
            {
              value: 'full',
              label: t('workbench:settings.browserNetworkMode.full'),
              disabled: browserControlsDisabled || browserNetworkModeSaving,
            },
          ]}
        />
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.browserAgentControl.title')}
        description={
          browserControlsDisabled
            ? t('workbench:settings.browserEnabled.needWorkbench')
            : t('workbench:settings.browserAgentControl.desc')
        }
        checked={browserAgentControl}
        loading={!loaded}
        disabled={browserControlsDisabled}
        onCheckedChange={(next) => {
          if (!loaded || browserControlsDisabled) return;
          setBrowserAgentControl(next);
          void persist(WORKBENCH_SETTING_KEYS.browserAgentControl, String(next), next);
        }}
      />

      <SettingRow
        title={t('workbench:settings.agentControl.title')}
        description={
          browserControlsDisabled
            ? t('workbench:settings.browserEnabled.needWorkbench')
            : t('workbench:settings.agentControl.desc')
        }
        className="items-center"
      >
        <div className="flex flex-col items-end gap-1.5">
          <SegmentedControl
            ariaLabel={t('workbench:settings.agentControl.title')}
            value={agentControl}
            onValueChange={(next) => {
              if (!loaded || browserControlsDisabled) return;
              const value = next as WorkbenchAgentControl;
              setAgentControl(value);
              void persist(WORKBENCH_SETTING_KEYS.agentControl, value, value);
            }}
            options={[
              {
                value: 'off',
                label: t('workbench:settings.agentControl.off'),
                disabled: browserControlsDisabled,
              },
              {
                value: 'background',
                label: t('workbench:settings.agentControl.background'),
                disabled: browserControlsDisabled,
              },
              {
                value: 'follow',
                label: t('workbench:settings.agentControl.follow'),
                disabled: browserControlsDisabled,
              },
            ]}
          />
          {!browserControlsDisabled && (
            <p className="max-w-[22rem] text-right text-xs leading-snug text-muted-foreground/80">
              {agentControl === 'off'
                ? t('workbench:settings.agentControl.offDesc')
                : agentControl === 'follow'
                  ? t('workbench:settings.agentControl.followDesc')
                  : t('workbench:settings.agentControl.backgroundDesc')}
            </p>
          )}
        </div>
      </SettingRow>

      <SettingRow
        title={t('workbench:agentControlCenter.settingsTitle')}
        description={t('workbench:agentControlCenter.settingsDescription')}
        className="sm:flex-col lg:flex-row"
      >
        <AgentCapabilitySummary variant="settings" className="max-w-full lg:max-w-[560px]" />
      </SettingRow>

      <SettingRow
        title={t('workbench:settings.agentPacing.title')}
        description={
          browserControlsDisabled
            ? t('workbench:settings.browserEnabled.needWorkbench')
            : t('workbench:settings.agentPacing.desc')
        }
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.agentPacing.title')}
          value={agentPacing}
          onValueChange={(next) => {
            if (!loaded || browserControlsDisabled) return;
            const value = next as WorkbenchAgentPacing;
            setAgentPacing(value);
            void persist(WORKBENCH_SETTING_KEYS.agentPacing, value, value);
          }}
            options={[
            {
              value: 'fast',
              label: t('workbench:settings.agentPacing.fast'),
              disabled: browserControlsDisabled,
            },
            {
              value: 'normal',
              label: t('workbench:settings.agentPacing.normal'),
              disabled: browserControlsDisabled,
            },
            {
              value: 'demo',
              label: t('workbench:settings.agentPacing.demo'),
              disabled: browserControlsDisabled,
            },
          ]}
        />
      </SettingRow>

      <div className="px-1">
        <button
          type="button"
          aria-expanded={browserAdvancedOpen}
          disabled={browserControlsDisabled}
          onClick={() => {
            if (browserControlsDisabled) return;
            setBrowserAdvancedOpen((prev) => !prev);
          }}
          className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className={`inline-block transition-transform ${browserAdvancedOpen ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          {t('workbench:settings.browserAdvanced')}
        </button>
        {browserAdvancedOpen && !browserControlsDisabled && (
          <SwitchRow
            title={t('workbench:settings.browserCdpWindows.title')}
            description={t('workbench:settings.browserCdpWindows.desc')}
            checked={browserCdpWindows}
            loading={!loaded}
            disabled={browserControlsDisabled}
            onCheckedChange={(next) => {
              if (!loaded || browserControlsDisabled) return;
              setBrowserCdpWindows(next);
              void persist(WORKBENCH_SETTING_KEYS.browserCdpWindows, String(next), next);
            }}
          />
        )}
      </div>

      <DsAlertDialog
        open={browserFullNetworkConfirmOpen}
        onOpenChange={setBrowserFullNetworkConfirmOpen}
        title={t('workbench:settings.browserNetworkMode.fullConfirmTitle')}
        description={t('workbench:settings.browserNetworkMode.fullConfirm')}
        confirmText={t('common:actions.confirm')}
        cancelText={t('common:actions.cancel')}
        confirmVariant="warning"
        onConfirm={confirmBrowserFullNetworkMode}
      />
    </SettingsGroup>
  );
};

export default WorkbenchSettingsSection;
