/**
 * 壁纸管理面板
 * ---------------------------------------------------------------------------
 * 契约：
 * - 由 WorkbenchDesktop 挂载；`window` 事件 'workbench:open-wallpaper-manager'
 *   由入口方（桌面右键菜单 / 设置页）派发，WorkbenchDesktop 监听后置 open=true。
 * - 面板内改壁纸 = 写 'desktop.workbenchWallpaper'（save_setting，非 Tauri 回退
 *   localStorage）+ 派发 'workbench:settings-changed'，桌面与设置页热更新。
 * - 自定义壁纸库数据层见 settings/components/wallpaperLibrary.ts。
 * - 面板选择壁纸后不关闭：实时预览依赖桌面对 settings-changed 的热更新。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Trash, UploadSimple, X } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useFocusTrap } from '@/hooks/useFocusTrap';

import {
  CUSTOM_WALLPAPER_LIBRARY_LIMIT,
  importWallpaperToLibrary,
  listCustomWallpapers,
  removeCustomWallpaper,
  type CustomWallpaperEntry,
} from '@/features/settings/components/wallpaperLibrary';
import { DEFAULT_WALLPAPER, WALLPAPER_PRESETS, type WallpaperConfig } from './WallpaperLayer';
import './WallpaperManagerDialog.css';

export const OPEN_WALLPAPER_MANAGER_EVENT = 'workbench:open-wallpaper-manager';

// ---------------------------------------------------------------------------
// 设置持久化（模式照抄 DesktopContextMenu.persistWorkbenchSetting，不改动原文件）
// ---------------------------------------------------------------------------

const WALLPAPER_SETTING_KEY = 'desktop.workbenchWallpaper';
/** 滑块拖动 → 落盘的防抖间隔（UI 即时，落盘合并） */
const ADJUST_PERSIST_DEBOUNCE_MS = 150;

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

/**
 * 持久化 + 派发 'workbench:settings-changed'。
 * 桌面（WorkbenchDesktop）与设置页共用该事件热更新，面板不直接改桌面 state。
 */
async function persistWorkbenchSetting(key: string, raw: string, parsed: unknown): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await invoke('save_setting', { key, value: raw });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, raw);
    }
  } catch {
    // 落盘失败仍派发热更新（本次会话内生效）
  }
  try {
    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', { detail: { key, value: parsed } }),
    );
  } catch {
    // noop
  }
}

// ---------------------------------------------------------------------------
// 工具（与 WallpaperLayer 内部约定一致）
// ---------------------------------------------------------------------------

const USABLE_URL_PATTERN = /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i;

function resolveCustomImageUrl(value: string): string {
  return USABLE_URL_PATTERN.test(value) ? value : convertFileSrc(value);
}

/** 转成 CSS url() 字面量，转义引号/反斜杠防样式注入 */
function toCssUrl(value: string): string {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface ImageAdjust {
  blur: number;
  dim: number;
  vignette: boolean;
}

function adjustFromConfig(config: WallpaperConfig): ImageAdjust {
  const rawBlur = Number(config.imageBlur);
  const rawDim = Number(config.imageDim);
  return {
    blur: Number.isFinite(rawBlur) ? clamp(rawBlur, 0, 40) : 0,
    dim: Number.isFinite(rawDim) ? clamp(rawDim, 0, 0.6) : 0,
    vignette: config.imageVignette !== false,
  };
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface WallpaperManagerDialogProps {
  open: boolean;
  /** 当前生效壁纸（来自 WorkbenchDesktop 的设置状态） */
  wallpaper: WallpaperConfig;
  onClose: () => void;
}

export const WallpaperManagerDialog: React.FC<WallpaperManagerDialogProps> = ({
  open,
  wallpaper,
  onClose,
}) => {
  const { t } = useTranslation('workbench');

  const [entries, setEntries] = useState<CustomWallpaperEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<ImageAdjust>(() => adjustFromConfig(wallpaper));

  // 焦点陷阱（aria-modal 契约）：Tab 在面板内循环；关闭后焦点归还打开前元素
  const panelRef = useFocusTrap<HTMLDivElement>(open);
  const adjustTimerRef = useRef<number | null>(null);

  const applyWallpaper = useCallback((next: WallpaperConfig) => {
    void persistWorkbenchSetting(WALLPAPER_SETTING_KEY, JSON.stringify(next), next);
  }, []);

  const refreshEntries = useCallback(async () => {
    try {
      setEntries(await listCustomWallpapers());
    } catch {
      setEntries([]);
    }
  }, []);

  // 打开时加载自定义壁纸库并清掉过期错误
  useEffect(() => {
    if (!open) return;
    setImportError(null);
    void refreshEntries();
  }, [open, refreshEntries]);

  // 外部壁纸变化 → 同步图片调节控件（面板持久化后热更新回流也走这里）
  useEffect(() => {
    setAdjust(adjustFromConfig(wallpaper));
  }, [wallpaper]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时的初始聚焦 / Tab 循环 / 关闭归还统一由 useFocusTrap 提供

  // 卸载 / 关闭兜底：取消进行中的调节防抖计时器
  useEffect(() => {
    if (open) return undefined;
    return () => {
      if (adjustTimerRef.current !== null) {
        window.clearTimeout(adjustTimerRef.current);
        adjustTimerRef.current = null;
      }
    };
  }, [open]);
  useEffect(
    () => () => {
      if (adjustTimerRef.current !== null) {
        window.clearTimeout(adjustTimerRef.current);
        adjustTimerRef.current = null;
      }
    },
    [],
  );

  // ---- 动作 ----

  const applyCustomEntry = useCallback(
    (path: string) => {
      applyWallpaper({
        kind: 'image',
        value: path,
        imageBlur: adjust.blur,
        imageDim: adjust.dim,
        imageVignette: adjust.vignette,
      });
    },
    [adjust, applyWallpaper],
  );

  const handleImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importWallpaperToLibrary({
        pickerTitle: t('wallpaperManager.selectTitle'),
      });
      if (result.status === 'success') {
        await refreshEntries();
        applyCustomEntry(result.entry.path);
      } else if (result.status === 'limit-exceeded') {
        setImportError(t('wallpaperManager.limitReached', { limit: result.limit }));
      } else if (result.status === 'error') {
        setImportError(t('wallpaperManager.importFailed'));
      }
      // cancelled：忽略
    } finally {
      setImporting(false);
    }
  }, [applyCustomEntry, importing, refreshEntries, t]);

  const handleRemove = useCallback(
    async (entry: CustomWallpaperEntry) => {
      try {
        await removeCustomWallpaper(entry.path);
      } catch {
        setImportError(t('wallpaperManager.importFailed'));
        return;
      }
      await refreshEntries();
      // 删的是当前生效壁纸 → 回退默认预设
      if (wallpaper.kind === 'image' && wallpaper.value === entry.path) {
        applyWallpaper(DEFAULT_WALLPAPER);
      }
    },
    [applyWallpaper, refreshEntries, t, wallpaper],
  );

  const commitAdjust = useCallback(
    (next: ImageAdjust, debounce: boolean) => {
      setAdjust(next);
      if (wallpaper.kind !== 'image') return;
      const config: WallpaperConfig = {
        kind: 'image',
        value: wallpaper.value,
        imageBlur: next.blur,
        imageDim: next.dim,
        imageVignette: next.vignette,
      };
      if (adjustTimerRef.current !== null) {
        window.clearTimeout(adjustTimerRef.current);
        adjustTimerRef.current = null;
      }
      if (debounce) {
        adjustTimerRef.current = window.setTimeout(() => {
          adjustTimerRef.current = null;
          applyWallpaper(config);
        }, ADJUST_PERSIST_DEBOUNCE_MS);
      } else {
        applyWallpaper(config);
      }
    },
    [applyWallpaper, wallpaper],
  );

  if (!open || typeof document === 'undefined') return null;

  const atLimit = entries.length >= CUSTOM_WALLPAPER_LIBRARY_LIMIT;
  const showAdjust = wallpaper.kind === 'image';

  return createPortal(
    <div
      className="wb-wpm-overlay"
      data-testid="wpm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="wb-wpm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('wallpaperManager.title')}
        tabIndex={-1}
        data-testid="wpm-dialog"
      >
        <header className="wb-wpm-header">
          <h2 className="wb-wpm-title">{t('wallpaperManager.title')}</h2>
          <button
            type="button"
            className="wb-wpm-close"
            aria-label={t('wallpaperManager.close')}
            data-testid="wpm-close"
            onClick={onClose}
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <CustomScrollArea
          className="wb-wpm-body"
          viewportClassName="wb-wpm-body-viewport"
          trackOffsetTop={4}
          trackOffsetBottom={12}
          trackOffsetRight={5}
        >
          {/* ==== 内置壁纸 ==== */}
          <section className="wb-wpm-section" aria-label={t('wallpaperManager.presetsSection')}>
            <div className="wb-wpm-section-head">
              <h3 className="wb-wpm-section-title">{t('wallpaperManager.presetsSection')}</h3>
            </div>
            <div className="wb-wpm-grid">
              {WALLPAPER_PRESETS.map((preset) => {
                const selected = wallpaper.kind === 'theme' && wallpaper.value === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`wb-wpm-card${selected ? ' wb-wpm-card-selected' : ''}`}
                    aria-pressed={selected}
                    data-testid={`wpm-preset-${preset.id}`}
                    onClick={() => applyWallpaper({ kind: 'theme', value: preset.id })}
                  >
                    {preset.imageUrl ? (
                      <span
                        className="wb-wpm-thumb"
                        aria-hidden="true"
                        style={{
                          backgroundImage: toCssUrl(preset.imageUrl),
                          backgroundPosition: preset.imagePosition,
                        }}
                      />
                    ) : (
                      <span
                        className="wb-wpm-thumb wb-wpm-thumb-gradient"
                        aria-hidden="true"
                        data-wpm-gradient={preset.id}
                      >
                        {preset.animated ? <span className="wb-wpm-thumb-flow" /> : null}
                      </span>
                    )}
                    <span className="wb-wpm-card-name">{t(preset.nameKey, preset.id)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ==== 我的壁纸 ==== */}
          <section className="wb-wpm-section" aria-label={t('wallpaperManager.customSection')}>
            <div className="wb-wpm-section-head">
              <h3 className="wb-wpm-section-title">{t('wallpaperManager.customSection')}</h3>
              <button
                type="button"
                className="wb-wpm-import"
                data-testid="wpm-import"
                disabled={importing || atLimit}
                data-loading={importing ? 'true' : undefined}
                onClick={() => void handleImport()}
              >
                <UploadSimple size={13} weight="bold" aria-hidden="true" />
                {importing ? t('wallpaperManager.importing') : t('wallpaperManager.import')}
              </button>
            </div>
            {atLimit && (
              <p className="wb-wpm-hint" data-testid="wpm-limit-hint">
                {t('wallpaperManager.limitReached', { limit: CUSTOM_WALLPAPER_LIBRARY_LIMIT })}
              </p>
            )}
            {importError && (
              <p className="wb-wpm-error" role="alert" data-testid="wpm-import-error">
                {importError}
              </p>
            )}
            {entries.length === 0 ? (
              <p className="wb-wpm-empty" data-testid="wpm-empty">
                {t('wallpaperManager.empty')}
              </p>
            ) : (
              <div className="wb-wpm-grid">
                {entries.map((entry) => {
                  const selected = wallpaper.kind === 'image' && wallpaper.value === entry.path;
                  return (
                    <div
                      key={entry.path}
                      className={`wb-wpm-card wb-wpm-card-custom${selected ? ' wb-wpm-card-selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="wb-wpm-card-hit"
                        aria-pressed={selected}
                        data-testid={`wpm-custom-${entry.fileName}`}
                        onClick={() => applyCustomEntry(entry.path)}
                      >
                        <span
                          className="wb-wpm-thumb"
                          aria-hidden="true"
                          style={{ backgroundImage: toCssUrl(resolveCustomImageUrl(entry.path)) }}
                        />
                      </button>
                      <button
                        type="button"
                        className="wb-wpm-remove"
                        aria-label={t('wallpaperManager.remove')}
                        data-testid={`wpm-remove-${entry.fileName}`}
                        onClick={() => void handleRemove(entry)}
                      >
                        <Trash size={13} weight="bold" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ==== 图片调节（仅自定义图片壁纸） ==== */}
          {showAdjust && (
            <section className="wb-wpm-section" aria-label={t('wallpaperManager.adjustTitle')}>
              <div className="wb-wpm-section-head">
                <h3 className="wb-wpm-section-title">{t('wallpaperManager.adjustTitle')}</h3>
              </div>
              <div className="wb-wpm-adjust" data-testid="wpm-adjust">
                <label className="wb-wpm-adjust-row">
                  <span className="wb-wpm-adjust-label">{t('wallpaperManager.blur')}</span>
                  <input
                    type="range"
                    // 触屏命中区 ≥44px：原生 appearance 轨道垂直居中渲染，加高盒不改轨道视觉
                    className="wb-wpm-slider [@media(pointer:coarse)]:!min-h-11"
                    min={0}
                    max={40}
                    step={1}
                    value={adjust.blur}
                    aria-label={t('wallpaperManager.blur')}
                    data-testid="wpm-blur"
                    onChange={(e) =>
                      commitAdjust(
                        { ...adjust, blur: clamp(Number(e.target.value) || 0, 0, 40) },
                        true,
                      )
                    }
                  />
                  <span className="wb-wpm-adjust-value">{adjust.blur}px</span>
                </label>
                <label className="wb-wpm-adjust-row">
                  <span className="wb-wpm-adjust-label">{t('wallpaperManager.dim')}</span>
                  <input
                    type="range"
                    // 触屏命中区 ≥44px：原生 appearance 轨道垂直居中渲染，加高盒不改轨道视觉
                    className="wb-wpm-slider [@media(pointer:coarse)]:!min-h-11"
                    min={0}
                    max={0.6}
                    step={0.05}
                    value={adjust.dim}
                    aria-label={t('wallpaperManager.dim')}
                    data-testid="wpm-dim"
                    onChange={(e) =>
                      commitAdjust(
                        { ...adjust, dim: clamp(Number(e.target.value) || 0, 0, 0.6) },
                        true,
                      )
                    }
                  />
                  <span className="wb-wpm-adjust-value">{Math.round(adjust.dim * 100)}%</span>
                </label>
                <div className="wb-wpm-adjust-row">
                  <span className="wb-wpm-adjust-label" id="wb-wpm-vignette-label">
                    {t('wallpaperManager.vignette')}
                  </span>
                  <button
                    type="button"
                    className="wb-wpm-switch"
                    role="switch"
                    aria-checked={adjust.vignette}
                    aria-labelledby="wb-wpm-vignette-label"
                    data-testid="wpm-vignette"
                    onClick={() => commitAdjust({ ...adjust, vignette: !adjust.vignette }, false)}
                  >
                    <span className="wb-wpm-switch-knob" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </section>
          )}
        </CustomScrollArea>
      </div>
    </div>,
    document.body,
  );
};

WallpaperManagerDialog.displayName = 'WallpaperManagerDialog';
