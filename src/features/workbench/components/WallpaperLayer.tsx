/**
 * 桌面壁纸层（O14 精修，原 P4）
 * ---------------------------------------------------------------------------
 * - 主题渐变预设：aurora/horizon/graphite 三套沿用 tokens.css 的
 *   --wb-wallpaper-*（O1 拥有）；本轮新增 meadow/lagoon/dusk/sakura/sand/nebula
 *   六套静态 + aurora-flow/dusk-flow 两套动态流动预设，渐变值承载在
 *   WallpaperLayer.css 的自有 wb-wallpaper- 前缀类中（明暗各调）；
 * - 动态预设 = 基础渐变 + 三层缓慢漂移的光斑（纯 transform 动画，
 *   prefers-reduced-motion / minimal 材质档自动静止）；
 * - 自定义图片（kind='image'）：cover 铺满 + 可配模糊（imageBlur）/
 *   额外压暗（imageDim）/ 暗角（imageVignette，默认开）适配层，
 *   叠加既有 --wb-wallpaper-scrim 可读性层；
 * - 壁纸切换 = 双 pane 交叉淡入（新 pane opacity 0→1 盖在旧 pane 上，
 *   animationend + 超时兜底后回收旧 pane），仅动画 opacity；
 * - 纯展示层，pointer-events: none，永远垫在窗口层之下（z-index: 0）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import '../styles/workbench.css';
import './WallpaperLayer.css';

/** 与 WorkbenchSnapshotV1['wallpaper'] 的 kind/value 结构一致；适配字段为可选扩展 */
export interface WallpaperConfig {
  kind: 'theme' | 'image';
  value: string;
  /** 图片壁纸：高斯模糊半径 px（0–40，默认 0） */
  imageBlur?: number;
  /** 图片壁纸：scrim 之外的额外压暗 0–0.6（默认 0） */
  imageDim?: number;
  /** 图片壁纸：边缘暗角（默认开） */
  imageVignette?: boolean;
}

export interface WallpaperPreset {
  id: string;
  /** i18n key（namespace: workbench），设置页 / 桌面右键菜单展示用 */
  nameKey: string;
  /** 随应用分发的静态图片资源；缺省时沿用 CSS 渐变预设 */
  imageUrl?: string;
  /** 图片主体的 cover 对齐位置 */
  imagePosition?: string;
  /** 图片预设额外压暗 0–0.6 */
  imageDim?: number;
  /** 图片预设是否绘制暗角（默认开） */
  imageVignette?: boolean;
  /** 动态流动壁纸（reduced-motion / minimal 档自动静止为首帧） */
  animated?: boolean;
}

/** 渐变预设清单（kind='theme' 时 value 取这里的 id） */
export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  {
    id: 'mountain-mist',
    nameKey: 'workbench:wallpaper.mountainMist',
    imageUrl: '/wallpapers/study-os/mountain-mist.webp',
    imagePosition: 'center 52%',
    imageDim: 0.06,
  },
  {
    id: 'forest-mist',
    nameKey: 'workbench:wallpaper.forestMist',
    imageUrl: '/wallpapers/study-os/forest-mist.webp',
    imagePosition: 'center 54%',
    imageDim: 0.08,
  },
  {
    id: 'alpine-lake',
    nameKey: 'workbench:wallpaper.alpineLake',
    imageUrl: '/wallpapers/study-os/alpine-lake.webp',
    imagePosition: 'center 55%',
    imageDim: 0.12,
  },
  {
    id: 'winter-ridge',
    nameKey: 'workbench:wallpaper.winterRidge',
    imageUrl: '/wallpapers/study-os/winter-ridge.webp',
    imagePosition: 'center 48%',
    imageDim: 0.05,
  },
  { id: 'aurora', nameKey: 'workbench:wallpaper.aurora' },
  { id: 'horizon', nameKey: 'workbench:wallpaper.horizon' },
  { id: 'graphite', nameKey: 'workbench:wallpaper.graphite' },
  { id: 'meadow', nameKey: 'workbench:wallpaper.meadow' },
  { id: 'lagoon', nameKey: 'workbench:wallpaper.lagoon' },
  { id: 'dusk', nameKey: 'workbench:wallpaper.dusk' },
  { id: 'sakura', nameKey: 'workbench:wallpaper.sakura' },
  { id: 'sand', nameKey: 'workbench:wallpaper.sand' },
  { id: 'nebula', nameKey: 'workbench:wallpaper.nebula' },
  { id: 'aurora-flow', nameKey: 'workbench:wallpaper.auroraFlow', animated: true },
  { id: 'dusk-flow', nameKey: 'workbench:wallpaper.duskFlow', animated: true },
] as const;

export const DEFAULT_WALLPAPER: WallpaperConfig = { kind: 'theme', value: 'mountain-mist' };

const PRESET_MAP = new Map(WALLPAPER_PRESETS.map((p) => [p.id, p]));

function resolvePresetId(value: string): string {
  return PRESET_MAP.has(value) ? value : DEFAULT_WALLPAPER.value;
}

/** 转成 CSS url() 字面量，转义引号/反斜杠防样式注入 */
function toCssUrl(value: string): string {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

const USABLE_URL_PATTERN = /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i;

function resolveCustomImageUrl(value: string): string {
  return USABLE_URL_PATTERN.test(value) ? value : convertFileSrc(value);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface ImageAdaptation {
  blur: number;
  dim: number;
  vignette: boolean;
}

/** 设置 JSON 来自系统边界，数字/布尔都做钳制归一 */
function resolveImageAdaptation(config: WallpaperConfig): ImageAdaptation {
  const rawBlur = Number(config.imageBlur);
  const rawDim = Number(config.imageDim);
  return {
    blur: Number.isFinite(rawBlur) ? clamp(rawBlur, 0, 40) : 0,
    dim: Number.isFinite(rawDim) ? clamp(rawDim, 0, 0.6) : 0,
    vignette: config.imageVignette !== false,
  };
}

/** 空 value 的图片配置退回默认主题渐变（保持旧版行为） */
function normalizeConfig(config: WallpaperConfig | undefined): WallpaperConfig {
  const next = config ?? DEFAULT_WALLPAPER;
  if (next.kind === 'image' && !next.value) return DEFAULT_WALLPAPER;
  return next;
}

/** 视觉等价性签名：签名不变则不触发交叉淡入 */
function wallpaperSignature(config: WallpaperConfig): string {
  if (config.kind === 'image') {
    const { blur, dim, vignette } = resolveImageAdaptation(config);
    return `i\u0000${config.value}\u0000${blur}\u0000${dim}\u0000${vignette ? 1 : 0}`;
  }
  return `t\u0000${resolvePresetId(config.value)}`;
}

// ---------------------------------------------------------------------------
// Pane 渲染
// ---------------------------------------------------------------------------

interface PaneEntry {
  key: number;
  signature: string;
  config: WallpaperConfig;
}

const PaneContent: React.FC<{ config: WallpaperConfig }> = ({ config }) => {
  if (config.kind === 'image') {
    const { blur, dim, vignette } = resolveImageAdaptation(config);
    return (
      <>
        <div
          className="wb-wallpaper-image"
          style={{
            backgroundImage: toCssUrl(resolveCustomImageUrl(config.value)),
            // 模糊时轻微放大，避免边缘出血露底
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            transform: blur > 0 ? 'scale(1.06)' : undefined,
          }}
        />
        <div className="wb-wallpaper-scrim" />
        {dim > 0 && <div className="wb-wallpaper-dimmer" style={{ opacity: dim }} />}
        {vignette && <div className="wb-wallpaper-vignette" />}
      </>
    );
  }
  const id = resolvePresetId(config.value);
  const preset = PRESET_MAP.get(id);
  if (preset?.imageUrl) {
    const dim = clamp(Number(preset.imageDim) || 0, 0, 0.6);
    return (
      <>
        <div
          className="wb-wallpaper-image"
          style={{
            backgroundImage: toCssUrl(preset.imageUrl),
            backgroundPosition: preset.imagePosition,
          }}
        />
        <div className="wb-wallpaper-scrim" />
        {dim > 0 && <div className="wb-wallpaper-dimmer" style={{ opacity: dim }} />}
        {preset.imageVignette !== false && <div className="wb-wallpaper-vignette" />}
      </>
    );
  }
  if (preset?.animated) {
    return (
      <>
        <div className="wb-wallpaper-flow wb-wallpaper-flow-a" />
        <div className="wb-wallpaper-flow wb-wallpaper-flow-b" />
        <div className="wb-wallpaper-flow wb-wallpaper-flow-c" />
      </>
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// 壁纸层
// ---------------------------------------------------------------------------

/** 交叉淡入回收的超时兜底（animation-duration 420ms + 余量） */
const FADE_PRUNE_FALLBACK_MS = 640;

export interface WallpaperLayerProps {
  /** 缺省 = 默认渐变预设 aurora */
  wallpaper?: WallpaperConfig;
}

export const WallpaperLayer: React.FC<WallpaperLayerProps> = React.memo(({ wallpaper }) => {
  const config = normalizeConfig(wallpaper);
  const signature = wallpaperSignature(config);

  const nextKeyRef = useRef(1);
  const [panes, setPanes] = useState<PaneEntry[]>(() => [{ key: 0, signature, config }]);

  // 配置变化 → 追加新 pane（最多保留旧 top + 新 pane 两层）
  useEffect(() => {
    setPanes((prev) => {
      const top = prev[prev.length - 1];
      if (top.signature === signature) return prev;
      const pane: PaneEntry = { key: nextKeyRef.current++, signature, config };
      return [top, pane];
    });
    // config 与 signature 一一对应，signature 足以判定变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const prune = useCallback(() => {
    setPanes((prev) => (prev.length > 1 ? [prev[prev.length - 1]] : prev));
  }, []);

  // 兜底：reduced-motion 下 animation-duration 为 0 或事件丢失时也能回收旧 pane
  useEffect(() => {
    if (panes.length <= 1) return undefined;
    const timer = window.setTimeout(prune, FADE_PRUNE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [panes, prune]);

  const handleFadeEnd = useCallback(
    (event: React.AnimationEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      prune();
    },
    [prune],
  );

  return (
    <div className="wb-wallpaper wb-wallpaper-root" aria-hidden="true">
      {panes.map((pane, index) => {
        const isTop = index === panes.length - 1;
        const entering = isTop && pane.key > 0 && panes.length > 1;
        const presetId = pane.config.kind === 'theme' ? resolvePresetId(pane.config.value) : null;
        return (
          <div
            key={pane.key}
            className={`wb-wallpaper-pane${entering ? ' wb-wallpaper-pane-enter' : ''}`}
            data-wb-wallpaper-preset={presetId ?? undefined}
            data-wb-wallpaper-kind={pane.config.kind}
            onAnimationEnd={entering ? handleFadeEnd : undefined}
          >
            <PaneContent config={pane.config} />
          </div>
        );
      })}
    </div>
  );
});

WallpaperLayer.displayName = 'WallpaperLayer';
