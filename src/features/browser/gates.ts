/**
 * Browser 双闸前端预检（镜像 Rust `assert_gates_open` 的设置层语义）
 *
 * - 父闸 `desktop.workbenchMode`：必须走权威 `resolveWorkbenchModeEnabled`
 *   （键缺失 → 默认 true + 哨兵迁移），禁止裸 `get_setting(...) === 'true'`。
 * - 子闸 `desktop.workbenchBrowserEnabled`：仍为显式 opt-in（缺失 → 关闭）；
 *   truthy 解析对齐 Rust `is_truthy`（`1|true|yes|on`，大小写不敏感）。
 *
 * 真源仍在 Rust；本层在 open/navigate 前预检并触发父闸迁移，避免语义分叉。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import {
  getCachedWorkbenchModeEnabled,
  interpretWorkbenchModeEnabled,
  resolveWorkbenchModeEnabled,
  WORKBENCH_MODE_SETTING_KEY,
} from '@/features/settings/components/workbenchMode';

import { BROWSER_SETTING_KEYS } from './navigationPolicy';

export { WORKBENCH_MODE_SETTING_KEY };

export interface BrowserGatesSnapshot {
  /** 父闸：学习桌面总开关（缺失默认 true） */
  workbenchModeEnabled: boolean;
  /** 子闸：内置浏览器（缺失默认 false） */
  browserEnabled: boolean;
  /** 两闸均开 */
  open: boolean;
}

/** 闸门关闭错误（避免与 browserApi 循环依赖；由 API 层映射为 BrowserApiError） */
export class BrowserGateClosedError extends Error {
  readonly code = 'BROWSER_GATE_CLOSED';

  constructor(message: string) {
    super(message);
    this.name = 'BrowserGateClosedError';
  }
}

/**
 * 子闸 opt-in：对齐 Rust `is_browser_child_gate_enabled` / `is_truthy`。
 * 缺失 / 空 / 非 truthy → false（不得把父闸默认开误用到子闸）。
 */
export function interpretBrowserChildGateEnabled(raw: unknown): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * 纯函数设置半边，对齐 Rust `assert_settings_gates_open`（无 DB 迁移副作用）。
 * 父闸用 `interpretWorkbenchModeEnabled`（缺失/非法 → true；仅显式 `"false"` 关）。
 */
export function evaluateBrowserSettingsGates(
  workbenchRaw: unknown,
  browserRaw: unknown,
): BrowserGatesSnapshot & { closeMessage: string | null } {
  const workbenchModeEnabled = interpretWorkbenchModeEnabled(workbenchRaw);
  const browserEnabled = interpretBrowserChildGateEnabled(browserRaw);
  const open = workbenchModeEnabled && browserEnabled;
  let closeMessage: string | null = null;
  if (!workbenchModeEnabled) {
    closeMessage = '内置浏览器不可用：请先启用学习桌面';
  } else if (!browserEnabled) {
    closeMessage = '内置浏览器不可用：请在设置中启用内置浏览器';
  }
  return { workbenchModeEnabled, browserEnabled, open, closeMessage };
}

/**
 * 解析双闸状态。父闸始终 await resolveWorkbenchModeEnabled（含迁移语义）。
 */
export async function resolveBrowserGates(): Promise<BrowserGatesSnapshot> {
  const { enabled: workbenchModeEnabled } = await resolveWorkbenchModeEnabled();

  let browserEnabled = false;
  try {
    const raw = await tauriInvoke<string | null>('get_setting', {
      key: BROWSER_SETTING_KEYS.enabled,
    });
    browserEnabled = interpretBrowserChildGateEnabled(raw);
  } catch {
    browserEnabled = false;
  }

  return {
    workbenchModeEnabled,
    browserEnabled,
    open: workbenchModeEnabled && browserEnabled,
  };
}

/**
 * 同步快照：仅当父闸已有进程内缓存时可用；否则返回 null（调用方应 await resolve）。
 */
export function peekBrowserParentGateFromCache(): boolean | null {
  return getCachedWorkbenchModeEnabled();
}

/** open / navigate 前调用；任一闸关闭则抛出 BrowserGateClosedError */
export async function assertBrowserGatesOpen(): Promise<BrowserGatesSnapshot> {
  const gates = await resolveBrowserGates();
  if (!gates.workbenchModeEnabled) {
    throw new BrowserGateClosedError('内置浏览器不可用：请先启用学习桌面');
  }
  if (!gates.browserEnabled) {
    throw new BrowserGateClosedError('内置浏览器不可用：请在设置中启用内置浏览器');
  }
  return gates;
}

/** Feature-flag key mirrored from Rust `FLAG_UI_WORKBENCH_BROWSER`. */
export const WORKBENCH_BROWSER_FEATURE_FLAG = 'ui.workbench_browser';

/**
 * Full launchability: settings dual-gate AND ui.workbench_browser feature flag.
 * Production builds ship the flag disabled; calling Tauri browser_* while closed
 * runs reject_closed_gate and hides the native content window — never invoke
 * when this returns closed.
 */
export async function resolveBrowserLaunchability(): Promise<
  BrowserGatesSnapshot & { featureFlagEnabled: boolean; closeMessage: string | null }
> {
  const gates = await resolveBrowserGates();
  let featureFlagEnabled = false;
  let featureFlagUnavailable = false;
  try {
    featureFlagEnabled = (await tauriInvoke<boolean>('is_feature_enabled', {
      featureName: WORKBENCH_BROWSER_FEATURE_FLAG,
      userId: null,
    })) === true;
  } catch {
    featureFlagUnavailable = true;
  }

  let closeMessage: string | null = null;
  if (!gates.workbenchModeEnabled) {
    closeMessage = '内置浏览器不可用：请先启用学习桌面';
  } else if (!gates.browserEnabled) {
    closeMessage = '内置浏览器不可用：请在设置中启用内置浏览器';
  } else if (!featureFlagEnabled) {
    closeMessage = featureFlagUnavailable
      ? '内置浏览器不可用：无法读取功能开关，请重试'
      : '内置浏览器不可用：当前版本未开放此功能（功能开关已关闭）';
  }

  return {
    ...gates,
    open: gates.open && featureFlagEnabled,
    featureFlagEnabled,
    closeMessage,
  };
}

export async function assertBrowserLaunchable(): Promise<BrowserGatesSnapshot> {
  const snap = await resolveBrowserLaunchability();
  if (!snap.open) {
    throw new BrowserGateClosedError(snap.closeMessage ?? '内置浏览器不可用：功能未启用');
  }
  return snap;
}
