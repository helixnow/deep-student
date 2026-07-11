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
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect } from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
// 刻意深路径导入：workbench 公共出口（index.ts）聚合了 chat/系统应用等重量级
// re-export，settings 页只需要 bus / 材质 / 壁纸预设三个轻量模块，
// 走 index 会把整条 chat store 链拖进 settings bundle（见 P10 进度文件遗留项）。
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { setMaterialTier, type MaterialTierSetting } from '@/features/workbench/core/materialTier';
import { WALLPAPER_PRESETS, DEFAULT_WALLPAPER, type WallpaperConfig } from '@/features/workbench/components/WallpaperLayer';

export type PerformanceProfile = 'quality' | 'balanced' | 'performance' | 'custom';

export const WORKBENCH_SETTING_KEYS = {
  mode: 'desktop.workbenchMode',
  performanceProfile: 'desktop.workbenchPerformanceProfile',
  materialTier: 'desktop.workbenchMaterialTier',
  wallpaper: 'desktop.workbenchWallpaper',
  tileMargins: 'desktop.workbenchTileMargins',
  dockAutohide: 'desktop.workbenchDockAutohide',
  /** 与 DesktopContextMenu / WorkbenchDesktop 共用同一 key */
  parallax: 'desktop.workbenchWallpaperParallax',
  dockMagnification: 'desktop.workbenchDockMagnification',
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

export type BrowserNetworkMode = 'local_whitelist' | 'full';

/** ACR 桌面操控档（DESIGN §6） */
export type WorkbenchAgentControl = 'off' | 'background' | 'follow';

/** ACR 演出节奏档（DESIGN §4.3） */
export type WorkbenchAgentPacing = 'fast' | 'normal' | 'demo';

/** 性能预设 → 材质 / 视差 / Dock 放大 */
export const PERFORMANCE_PROFILE_PRESETS: Record<
  Exclude<PerformanceProfile, 'custom'>,
  { materialTier: MaterialTierSetting; parallax: boolean; dockMagnification: boolean }
> = {
  quality: { materialTier: 'full', parallax: true, dockMagnification: true },
  balanced: { materialTier: 'reduced', parallax: false, dockMagnification: true },
  performance: { materialTier: 'minimal', parallax: false, dockMagnification: false },
};

export type WallpaperSetting = WallpaperConfig;

export interface TileMarginsSetting {
  enabled: boolean;
  px: number;
}

const DEFAULT_TILE_MARGINS: TileMarginsSetting = { enabled: true, px: 8 };
const TILE_MARGIN_MIN = 0;
const TILE_MARGIN_MAX = 32;
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

export interface WorkbenchSettingsSectionProps {
  className?: string;
}

export const WorkbenchSettingsSection: React.FC<WorkbenchSettingsSectionProps> = ({ className }) => {
  const { t } = useTranslation(['workbench', 'settings']);

  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState(false);
  const [performanceProfile, setPerformanceProfile] = useState<PerformanceProfile>('custom');
  const [materialTier, setMaterialTierState] = useState<MaterialTierSetting>('auto');
  const [parallax, setParallax] = useState(false);
  const [dockMagnification, setDockMagnification] = useState(true);
  const [wallpaper, setWallpaper] = useState<WallpaperSetting>(DEFAULT_WALLPAPER);
  const [imagePathDraft, setImagePathDraft] = useState('');
  const [tileMargins, setTileMargins] = useState<TileMarginsSetting>(DEFAULT_TILE_MARGINS);
  const [dockAutohide, setDockAutohide] = useState(false);
  const [devPanel, setDevPanel] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserNetworkMode, setBrowserNetworkMode] = useState<BrowserNetworkMode>('local_whitelist');
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
        modeVal,
        profileVal,
        tierVal,
        wallpaperVal,
        marginsVal,
        autohideVal,
        parallaxVal,
        dockMagVal,
        devPanelVal,
        browserEnabledVal,
        browserNetworkModeVal,
        browserAgentControlVal,
        browserCdpWindowsVal,
        agentControlVal,
        agentPacingVal,
      ] = await Promise.all([
        read(WORKBENCH_SETTING_KEYS.mode),
        read(WORKBENCH_SETTING_KEYS.performanceProfile),
        read(WORKBENCH_SETTING_KEYS.materialTier),
        read(WORKBENCH_SETTING_KEYS.wallpaper),
        read(WORKBENCH_SETTING_KEYS.tileMargins),
        read(WORKBENCH_SETTING_KEYS.dockAutohide),
        read(WORKBENCH_SETTING_KEYS.parallax),
        read(WORKBENCH_SETTING_KEYS.dockMagnification),
        read(WORKBENCH_SETTING_KEYS.devPanel),
        read(WORKBENCH_SETTING_KEYS.browserEnabled),
        read(WORKBENCH_SETTING_KEYS.browserNetworkMode),
        read(WORKBENCH_SETTING_KEYS.browserAgentControl),
        read(WORKBENCH_SETTING_KEYS.browserCdpWindows),
        read(WORKBENCH_SETTING_KEYS.agentControl),
        read(WORKBENCH_SETTING_KEYS.agentPacing),
      ]);
      if (cancelled) return;
      setMode(String(modeVal ?? '') === 'true');
      setPerformanceProfile(parseProfile(profileVal));
      setMaterialTierState(parseMaterialTier(tierVal));
      // 未设置 → 关闭视差（冷启动更省）；显式 'true' 才开
      setParallax(String(parallaxVal ?? '') === 'true');
      // 未设置 → 保留 Dock 放大（与 quality 默认手感一致）；显式 'false' 才关
      setDockMagnification(String(dockMagVal ?? '') !== 'false');
      const wp = parseJsonSetting<WallpaperSetting>(wallpaperVal, DEFAULT_WALLPAPER);
      setWallpaper(wp);
      setImagePathDraft(wp.kind === 'image' ? wp.value : '');
      setTileMargins(parseJsonSetting<TileMarginsSetting>(marginsVal, DEFAULT_TILE_MARGINS));
      setDockAutohide(String(autohideVal ?? '') === 'true');
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
        window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled } }));
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

  const applyParallax = useCallback(
    (next: boolean) => {
      setParallax(next);
      void persist(WORKBENCH_SETTING_KEYS.parallax, String(next), next);
    },
    [persist],
  );

  const applyDockMagnification = useCallback(
    (next: boolean) => {
      setDockMagnification(next);
      void persist(WORKBENCH_SETTING_KEYS.dockMagnification, String(next), next);
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
      applyParallax(preset.parallax);
      applyDockMagnification(preset.dockMagnification);
    },
    [applyDockMagnification, applyMaterialTier, applyParallax, persist],
  );

  const handleTierChange = useCallback(
    (next: MaterialTierSetting) => {
      markCustomIfNeeded();
      applyMaterialTier(next);
    },
    [applyMaterialTier, markCustomIfNeeded],
  );

  const handleParallaxChange = useCallback(
    (next: boolean) => {
      markCustomIfNeeded();
      applyParallax(next);
    },
    [applyParallax, markCustomIfNeeded],
  );

  const handleDockMagChange = useCallback(
    (next: boolean) => {
      markCustomIfNeeded();
      applyDockMagnification(next);
    },
    [applyDockMagnification, markCustomIfNeeded],
  );

  const saveWallpaper = useCallback(
    (next: WallpaperSetting) => {
      setWallpaper(next);
      void persist(WORKBENCH_SETTING_KEYS.wallpaper, JSON.stringify(next), next);
    },
    [persist],
  );

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
    ? t(
        'workbench:settings.browserEnabled.needWorkbench',
        '请先启用学习桌面，才能打开内置浏览器相关选项。',
      )
    : t(
        'workbench:settings.browserEnabled.desc',
        '在学习桌面中打开独立浏览器窗口（页面在隔离 WebView 中运行）。需先启用学习桌面。',
      );

  const handleBrowserNetworkModeChange = useCallback(
    (next: BrowserNetworkMode) => {
      if (!loaded || browserControlsDisabled) return;
      if (next === 'full' && browserNetworkMode !== 'full') {
        setBrowserFullNetworkConfirmOpen(true);
        return;
      }
      setBrowserFullNetworkConfirmOpen(false);
      setBrowserNetworkMode(next);
      void persist(WORKBENCH_SETTING_KEYS.browserNetworkMode, next, next);
    },
    [browserControlsDisabled, browserNetworkMode, loaded, persist],
  );

  const confirmBrowserFullNetworkMode = useCallback(() => {
    setBrowserFullNetworkConfirmOpen(false);
    setBrowserNetworkMode('full');
    void persist(WORKBENCH_SETTING_KEYS.browserNetworkMode, 'full', 'full');
  }, [persist]);

  return (
    <SettingsGroup
      title={t('workbench:settings.sectionTitle', '学习桌面（实验）')}
      description={t(
        'workbench:settings.sectionDesc',
        '把主内容区变为可自由开窗、平铺的学习桌面（Workbench）。实验功能，可随时关闭回到现有布局。',
      )}
      className={className}
    >
      <SwitchRow
        title={t('workbench:settings.mode.title', '启用学习桌面')}
        description={t(
          'workbench:settings.mode.desc',
          '开启后主内容区切换为窗口化桌面模式；关闭后恢复现有视图，桌面布局快照会保留。',
        )}
        checked={mode}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          void handleModeChange(next);
        }}
      />

      <SettingRow
        title={t('workbench:settings.performanceProfile.title', '性能档位')}
        description={t(
          'workbench:settings.performanceProfile.desc',
          '一键平衡画质与流畅度。选择预设会同步材质、壁纸视差与 Dock 放大；单独改下面选项会变为「自定义」。',
        )}
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.performanceProfile.title', '性能档位')}
          value={performanceProfile}
          onValueChange={(next) => {
            if (!loaded) return;
            handleProfileChange(next as PerformanceProfile);
          }}
          size="compact"
          options={[
            {
              value: 'quality',
              label: t('workbench:settings.performanceProfile.quality', '画质'),
            },
            {
              value: 'balanced',
              label: t('workbench:settings.performanceProfile.balanced', '均衡'),
            },
            {
              value: 'performance',
              label: t('workbench:settings.performanceProfile.performance', '性能'),
            },
            {
              value: 'custom',
              label: t('workbench:settings.performanceProfile.custom', '自定义'),
            },
          ]}
        />
      </SettingRow>

      <SettingRow
        title={t('workbench:settings.materialTier.title', '视觉材质')}
        description={t(
          'workbench:settings.materialTier.desc',
          '玻璃材质档位。也可由上方「性能档位」预设驱动；单独修改会切到自定义。',
        )}
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.materialTier.title', '视觉材质')}
          value={materialTier}
          onValueChange={(next) => {
            if (!loaded) return;
            handleTierChange(next as MaterialTierSetting);
          }}
          size="compact"
          options={[
            { value: 'auto', label: t('workbench:settings.materialTier.auto', '跟随平台') },
            { value: 'full', label: t('workbench:settings.materialTier.full', '全效果') },
            { value: 'reduced', label: t('workbench:settings.materialTier.reduced', '降透明') },
            { value: 'minimal', label: t('workbench:settings.materialTier.minimal', '极简') },
          ]}
        />
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.parallax.title', '壁纸视差')}
        description={t(
          'workbench:settings.parallax.desc',
          '指针移动时轻微平移壁纸。关闭可降低桌面合成开销（默认关闭）。',
        )}
        checked={parallax}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          handleParallaxChange(next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.dockMagnification.title', 'Dock 邻近放大')}
        description={t(
          'workbench:settings.dockMagnification.desc',
          '指针划过 Dock 时图标放大。关闭可减少悬停时的布局测量与合成成本。',
        )}
        checked={dockMagnification}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          handleDockMagChange(next);
        }}
      />

      <SettingRow
        title={t('workbench:settings.wallpaper.title', '桌面壁纸')}
        description={t('workbench:settings.wallpaper.desc', '选择主题渐变预设，或使用自定义图片。')}
        className="items-center"
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl
            ariaLabel={t('workbench:settings.wallpaper.title', '桌面壁纸')}
            value={wallpaper.kind}
            onValueChange={(kind) => {
              if (!loaded) return;
              if (kind === 'theme') {
                const value = PRESET_IDS.includes(wallpaper.value)
                  ? wallpaper.value
                  : DEFAULT_WALLPAPER.value;
                saveWallpaper({ kind: 'theme', value });
              } else {
                saveWallpaper({ kind: 'image', value: imagePathDraft.trim() });
              }
            }}
            size="compact"
            options={[
              { value: 'theme', label: t('workbench:settings.wallpaper.kindTheme', '主题渐变') },
              { value: 'image', label: t('workbench:settings.wallpaper.kindImage', '自定义图片') },
            ]}
          />
          {wallpaper.kind === 'theme' ? (
            <AppSelect
              value={PRESET_IDS.includes(wallpaper.value) ? wallpaper.value : DEFAULT_WALLPAPER.value}
              onValueChange={(value) => {
                if (!loaded) return;
                saveWallpaper({ kind: 'theme', value });
              }}
              options={presetOptions}
              size="sm"
              variant="ghost"
              className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
              width={100}
            />
          ) : (
            <Input
              type="text"
              value={imagePathDraft}
              aria-label={t('workbench:settings.wallpaper.imagePath', '图片路径')}
              placeholder={t('workbench:settings.wallpaper.imagePlaceholder', '输入本地图片路径…')}
              onChange={(e) => setImagePathDraft(e.target.value)}
              onBlur={() => {
                if (!loaded) return;
                const value = imagePathDraft.trim();
                if (value === wallpaper.value) return;
                saveWallpaper({ kind: 'image', value });
              }}
              className="h-8 !w-52 text-xs bg-transparent"
            />
          )}
        </div>
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.tileMargins.title', '平铺间距')}
        description={t(
          'workbench:settings.tileMargins.desc',
          '平铺窗口之间保留间距，关闭后平铺窗口紧贴排列。',
        )}
        checked={tileMargins.enabled}
        loading={!loaded}
        onCheckedChange={(enabled) => {
          if (!loaded) return;
          saveTileMargins({ ...tileMargins, enabled });
        }}
      />

      {loaded && tileMargins.enabled && (
        <SettingRow
          title={t('workbench:settings.tileMargins.px', '间距（px）')}
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
            <span className="text-[11px] text-muted-foreground/70">px</span>
          </div>
        </SettingRow>
      )}

      <SwitchRow
        title={t('workbench:settings.dockAutohide.title', '自动隐藏 Dock')}
        description={t(
          'workbench:settings.dockAutohide.desc',
          '不使用时 Dock 自动收起，指针移到屏幕底部时滑出。',
        )}
        checked={dockAutohide}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          setDockAutohide(next);
          void persist(WORKBENCH_SETTING_KEYS.dockAutohide, String(next), next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.devPanel.title', '诊断面板')}
        description={t(
          'workbench:settings.devPanel.desc',
          '在桌面上显示窗口生命周期、内存预算与帧耗时等调度诊断信息（开发用）。',
        )}
        checked={devPanel}
        loading={!loaded}
        onCheckedChange={(next) => {
          if (!loaded) return;
          setDevPanel(next);
          void persist(WORKBENCH_SETTING_KEYS.devPanel, String(next), next);
        }}
      />

      <SwitchRow
        title={t('workbench:settings.browserEnabled.title', '内置浏览器')}
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
        title={t('workbench:settings.browserNetworkMode.title', '网络范围')}
        description={
          browserControlsDisabled
            ? t(
                'workbench:settings.browserEnabled.needWorkbench',
                '请先启用学习桌面，才能打开内置浏览器相关选项。',
              )
            : t('workbench:settings.browserNetworkMode.desc', '限制可访问的地址范围。')
        }
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.browserNetworkMode.title', '网络范围')}
          value={browserNetworkMode}
          onValueChange={(next) => {
            handleBrowserNetworkModeChange(next as BrowserNetworkMode);
          }}
          size="compact"
          options={[
            {
              value: 'local_whitelist',
              label: t(
                'workbench:settings.browserNetworkMode.local_whitelist',
                '本地与白名单',
              ),
              disabled: browserControlsDisabled,
            },
            {
              value: 'full',
              label: t('workbench:settings.browserNetworkMode.full', '完整上网（需确认）'),
              disabled: browserControlsDisabled,
            },
          ]}
        />
      </SettingRow>

      <SwitchRow
        title={t('workbench:settings.browserAgentControl.title', '允许助手操控浏览器')}
        description={
          browserControlsDisabled
            ? t(
                'workbench:settings.browserEnabled.needWorkbench',
                '请先启用学习桌面，才能打开内置浏览器相关选项。',
              )
            : t(
                'workbench:settings.browserAgentControl.desc',
                '助手可在共享会话中导航与操作页面；敏感动作仍会请求确认。',
              )
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
        title={t('workbench:settings.agentControl.title', 'AI 助手操控')}
        description={
          browserControlsDisabled
            ? t(
                'workbench:settings.browserEnabled.needWorkbench',
                '请先启用学习桌面，才能打开内置浏览器相关选项。',
              )
            : t(
                'workbench:settings.agentControl.desc',
                '控制 Chat 助手能否在学习桌面中打开窗口、跟随焦点并演出操作。破坏性动作仍会请求确认。',
              )
        }
        className="items-center"
      >
        <div className="flex flex-col items-end gap-1.5">
          <SegmentedControl
            ariaLabel={t('workbench:settings.agentControl.title', 'AI 助手操控')}
            value={agentControl}
            onValueChange={(next) => {
              if (!loaded || browserControlsDisabled) return;
              const value = next as WorkbenchAgentControl;
              setAgentControl(value);
              void persist(WORKBENCH_SETTING_KEYS.agentControl, value, value);
            }}
            size="compact"
            options={[
              {
                value: 'off',
                label: t('workbench:settings.agentControl.off', '关闭'),
                disabled: browserControlsDisabled,
              },
              {
                value: 'background',
                label: t('workbench:settings.agentControl.background', '后台'),
                disabled: browserControlsDisabled,
              },
              {
                value: 'follow',
                label: t('workbench:settings.agentControl.follow', '跟随'),
                disabled: browserControlsDisabled,
              },
            ]}
          />
          {!browserControlsDisabled && (
            <p className="max-w-[22rem] text-right text-[11px] leading-snug text-muted-foreground/80">
              {agentControl === 'off'
                ? t(
                    'workbench:settings.agentControl.offDesc',
                    '只读允许列出/查询窗口；打开、关闭、指令与演出一律拒绝。数据修改可走后端直写，不会开窗或演出。',
                  )
                : agentControl === 'follow'
                  ? t(
                      'workbench:settings.agentControl.followDesc',
                      '自动开窗并聚焦跟随：助手操作时会把目标窗口带到前台演出。',
                    )
                  : t(
                      'workbench:settings.agentControl.backgroundDesc',
                      '允许操控但不抢焦点：可在已开窗口演出，或直落终态并在 Dock 提示。',
                    )}
            </p>
          )}
        </div>
      </SettingRow>

      <SettingRow
        title={t('workbench:settings.agentPacing.title', '操控演出节奏')}
        description={
          browserControlsDisabled
            ? t(
                'workbench:settings.browserEnabled.needWorkbench',
                '请先启用学习桌面，才能打开内置浏览器相关选项。',
              )
            : t(
                'workbench:settings.agentPacing.desc',
                '助手在桌面窗口中逐步应用操作时的视觉节奏。',
              )
        }
        className="items-center"
      >
        <SegmentedControl
          ariaLabel={t('workbench:settings.agentPacing.title', '操控演出节奏')}
          value={agentPacing}
          onValueChange={(next) => {
            if (!loaded || browserControlsDisabled) return;
            const value = next as WorkbenchAgentPacing;
            setAgentPacing(value);
            void persist(WORKBENCH_SETTING_KEYS.agentPacing, value, value);
          }}
          size="compact"
          options={[
            {
              value: 'fast',
              label: t('workbench:settings.agentPacing.fast', '快速'),
              disabled: browserControlsDisabled,
            },
            {
              value: 'normal',
              label: t('workbench:settings.agentPacing.normal', '正常'),
              disabled: browserControlsDisabled,
            },
            {
              value: 'demo',
              label: t('workbench:settings.agentPacing.demo', '演示'),
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
          {t('workbench:settings.browserAdvanced', '高级（浏览器）')}
        </button>
        {browserAdvancedOpen && !browserControlsDisabled && (
          <SwitchRow
            title={t('workbench:settings.browserCdpWindows.title', 'Windows CDP 加速（高级）')}
            description={t(
              'workbench:settings.browserCdpWindows.desc',
              '仅 Windows。启用远程调试端口以增强自动化；有额外安全面，默认关闭。',
            )}
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

      <NotionAlertDialog
        open={browserFullNetworkConfirmOpen}
        onOpenChange={setBrowserFullNetworkConfirmOpen}
        title={t('workbench:settings.browserNetworkMode.fullConfirmTitle', '启用完整上网？')}
        description={t(
          'workbench:settings.browserNetworkMode.fullConfirm',
          '完整上网将允许访问公网地址，请确认你了解相关风险。是否继续？',
        )}
        confirmText={t('common:actions.confirm', '确认')}
        cancelText={t('common:actions.cancel', '取消')}
        confirmVariant="warning"
        onConfirm={confirmBrowserFullNetworkMode}
      />
    </SettingsGroup>
  );
};

export default WorkbenchSettingsSection;
