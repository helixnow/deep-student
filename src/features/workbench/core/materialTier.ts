/**
 * 材质档位管理（P4 专属）
 * ---------------------------------------------------------------------------
 * 三档材质（设计文档 §6.5）：
 *   full    — blur + 高光 + 全部动效（Windows / macOS 默认）
 *   reduced — 零 backdrop-filter，玻璃改高不透明纯色（Linux/WebKitGTK 默认）
 *   minimal — 全不透明 + 动效时长归零（跟随系统 prefers-reduced-motion）
 *
 * 档位通过 `<html data-wb-material="...">` 属性驱动 CSS 降级
 * （token 覆写见 styles/workbench.tokens.css），改属性即时生效，无需重载。
 *
 * 默认档位自动检测（'auto'）；显式 setMaterialTier 后固定，
 * setMaterialTier('auto') 恢复跟随平台/系统偏好（供 P10 设置页
 * 「跟随平台 / full / reduced / minimal」分段控件使用）。
 *
 * O1 增补：
 *   - 切档平滑过渡：档位变化时给 <html> 短暂加 data-wb-material-switching，
 *     token 层（workbench.tokens.css）对玻璃面做 background/box-shadow 交叉
 *     淡化后自动移除——不硬切；目标档为 minimal 或系统 reduced-motion 时
 *     时长 token 已归零，自动退化为硬切。
 *   - auto 检测补 prefers-reduced-transparency → reduced（WebView2/WebKit
 *     均已支持该媒体查询；不支持的平台 matchMedia 返回 not-matched，无副作用）。
 */
import { useSyncExternalStore } from 'react';
import type { MaterialTier } from './types';

/** 设置页取值：'auto' = 跟随平台与系统偏好 */
export type MaterialTierSetting = MaterialTier | 'auto';

const HTML_ATTR = 'data-wb-material';
/** 切档过渡标记：token 层据此启用交叉淡化 transition */
const SWITCHING_ATTR = 'data-wb-material-switching';
/** 略大于 --wb-motion-tier-fade(220ms)，保证过渡完整后再摘除 transition */
const SWITCHING_CLEAR_MS = 300;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

const listeners = new Set<() => void>();
/** 用户显式选择；null = auto（跟随检测） */
let explicitTier: MaterialTier | null = null;
let resolvedTier: MaterialTier = 'full';
let initialized = false;
let switchingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 平台/系统偏好检测：
 * prefers-reduced-motion → minimal；prefers-reduced-transparency → reduced；
 * Linux 桌面（WebKitGTK 合成弱）→ reduced；其余 full。
 */
export function detectAutoMaterialTier(): MaterialTier {
  if (typeof window === 'undefined') return 'full';
  if (window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches) return 'minimal';
  if (window.matchMedia?.(REDUCED_TRANSPARENCY_QUERY)?.matches) return 'reduced';
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('linux') && !ua.includes('android')) return 'reduced';
  return 'full';
}

function applyToDom(tier: MaterialTier, options?: { transition?: boolean }): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (html.getAttribute(HTML_ATTR) === tier) return;
  if (options?.transition) {
    // 同一次样式重算内：先挂 transition 标记，再改档位属性 → 玻璃面从旧值
    // 平滑过渡到新值；标记在过渡完成后移除（快速连切时重置计时器）。
    html.setAttribute(SWITCHING_ATTR, '');
    if (switchingTimer !== null) clearTimeout(switchingTimer);
    switchingTimer = setTimeout(() => {
      switchingTimer = null;
      html.removeAttribute(SWITCHING_ATTR);
    }, SWITCHING_CLEAR_MS);
  }
  html.setAttribute(HTML_ATTR, tier);
}

function emit(): void {
  for (const fn of listeners) fn();
}

function resolve(): void {
  const next = explicitTier ?? detectAutoMaterialTier();
  if (next !== resolvedTier) {
    resolvedTier = next;
    // 运行期切档走平滑过渡（首次初始化不走，见 ensureInit）
    applyToDom(next, { transition: true });
    emit();
  } else {
    applyToDom(next);
  }
}

function watchMediaQuery(queryText: string, onChange: () => void): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const query = window.matchMedia(queryText);
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
  } else if (typeof query.addListener === 'function') {
    // 旧 WebKit 兼容
    query.addListener(onChange);
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  resolvedTier = explicitTier ?? detectAutoMaterialTier();
  applyToDom(resolvedTier);
  // auto 模式下跟随系统偏好（reduced-motion / reduced-transparency）的实时变化
  const onPreferenceChange = (): void => {
    if (explicitTier === null) resolve();
  };
  watchMediaQuery(REDUCED_MOTION_QUERY, onPreferenceChange);
  watchMediaQuery(REDUCED_TRANSPARENCY_QUERY, onPreferenceChange);
}

/** 当前生效档位（首次调用时完成自动检测并写入 html 属性） */
export function getMaterialTier(): MaterialTier {
  ensureInit();
  return resolvedTier;
}

/**
 * 设置档位。传 'auto' 清除显式选择、恢复平台/系统偏好检测。
 * 改动即时生效（仅改 html attribute，无需重载）。
 */
export function setMaterialTier(tier: MaterialTierSetting): void {
  ensureInit();
  explicitTier = tier === 'auto' ? null : tier;
  resolve();
}

function subscribe(fn: () => void): () => void {
  ensureInit();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook：订阅当前档位（档位变化触发重渲染） */
export function useMaterialTier(): MaterialTier {
  return useSyncExternalStore(subscribe, getMaterialTier, () => 'full');
}

/** 仅供单测：重置模块态并清掉 html 上的档位/过渡属性 */
export function resetMaterialTierForTests(): void {
  if (switchingTimer !== null) {
    clearTimeout(switchingTimer);
    switchingTimer = null;
  }
  explicitTier = null;
  resolvedTier = 'full';
  initialized = false;
  listeners.clear();
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute(HTML_ATTR);
    document.documentElement.removeAttribute(SWITCHING_ATTR);
  }
}
