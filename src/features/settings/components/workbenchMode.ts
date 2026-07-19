/**
 * workbenchMode — 学习桌面（Workbench）总开关的轻量读写助手
 *
 * 供设置页以外的轻量入口（如 legacy 侧边栏快捷开关）复用同一事件契约
 * （与 WorkbenchSettingsSection 总开关一致）：
 *
 * - 读：resolveWorkbenchModeEnabled()（缺失键 → 默认 true + 迁移哨兵）
 * - 写：save_setting →（关闭时联动 browser_close）→ workbenchBus.setEnabled(v) →
 *   CustomEvent 'workbench:mode-changed' { enabled }
 *
 * 刻意保持零 UI 依赖（仅 bus + invoke），避免把设置页组件链拖进侧边栏 bundle。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

export const WORKBENCH_MODE_SETTING_KEY = 'desktop.workbenchMode';
/** 一次性默认值迁移哨兵：避免对缺失键重复写入 / 重复提示 */
export const WORKBENCH_MODE_MIGRATED_KEY = 'desktop.workbenchMode.migrated.v1';

export interface WorkbenchModeResolveResult {
  enabled: boolean;
  /** 本次调用刚完成「缺失 → true」迁移（含一次性提示） */
  migratedNow: boolean;
}

/** 进程内最近一次权威解析/持久化结果；供同步场景读取（无缓存时返回 null） */
let cachedWorkbenchModeEnabled: boolean | null = null;

/**
 * 纯解析：仅接受显式 `"true"` / `"false"`（trim）；缺失/非法 → null。
 * 调用方若要对缺失键应用产品默认，请用 `interpretWorkbenchModeEnabled` 或
 * 权威异步路径 `resolveWorkbenchModeEnabled`（含哨兵迁移）。
 */
export function parseWorkbenchModeRaw(raw: unknown): boolean | null {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

/**
 * 同步解释：显式 true/false 原样；缺失/非法 → 默认 true。
 * 不写库、不发迁移提示——仅用于已有 raw / localStorage 等同步场景。
 */
export function interpretWorkbenchModeEnabled(raw: unknown): boolean {
  return parseWorkbenchModeRaw(raw) ?? true;
}

/** 读取进程内缓存（resolve / persist 成功后更新）；无缓存返回 null */
export function getCachedWorkbenchModeEnabled(): boolean | null {
  return cachedWorkbenchModeEnabled;
}

export function setCachedWorkbenchModeEnabled(enabled: boolean): void {
  cachedWorkbenchModeEnabled = enabled;
}

/**
 * 解析学习桌面总开关：显式 true/false 原样返回；键缺失时默认 true，
 * 并写入哨兵（及 mode=true），避免重复迁移。
 */
export async function resolveWorkbenchModeEnabled(): Promise<WorkbenchModeResolveResult> {
  try {
    const raw = await tauriInvoke<string | null>('get_setting', {
      key: WORKBENCH_MODE_SETTING_KEY,
    });
    const explicit = parseWorkbenchModeRaw(raw);
    if (explicit !== null) {
      setCachedWorkbenchModeEnabled(explicit);
      return { enabled: explicit, migratedNow: false };
    }

    const migratedRaw = await tauriInvoke<string | null>('get_setting', {
      key: WORKBENCH_MODE_MIGRATED_KEY,
    });
    const alreadyMigrated = String(migratedRaw ?? '').trim() === 'true';

    if (alreadyMigrated) {
      // 哨兵已在、mode 键意外缺失：静默回填，不再提示
      try {
        await tauriInvoke('save_setting', {
          key: WORKBENCH_MODE_SETTING_KEY,
          value: 'true',
        });
      } catch {
        /* 回填失败仍按默认启用 */
      }
      setCachedWorkbenchModeEnabled(true);
      return { enabled: true, migratedNow: false };
    }

    await tauriInvoke('save_setting', {
      key: WORKBENCH_MODE_SETTING_KEY,
      value: 'true',
    });
    await tauriInvoke('save_setting', {
      key: WORKBENCH_MODE_MIGRATED_KEY,
      value: 'true',
    });

    showGlobalNotification(
      'info',
      i18n.t('workbench:settings.mode.migratedNotice', {
        defaultValue: '已启用学习桌面，可在设置切回经典模式',
      }),
    );

    setCachedWorkbenchModeEnabled(true);
    return { enabled: true, migratedNow: true };
  } catch {
    // 读失败时按产品默认启用；不声称完成迁移
    setCachedWorkbenchModeEnabled(true);
    return { enabled: true, migratedNow: false };
  }
}

export async function readWorkbenchModeEnabled(): Promise<boolean> {
  const { enabled } = await resolveWorkbenchModeEnabled();
  return enabled;
}

async function closeBrowserForDisabledGate(): Promise<void> {
  try {
    await tauriInvoke('browser_close', {});
  } catch (error) {
    // 浏览器可能不可用或已关闭；持久化的闸值仍是准绳
    console.warn('[workbenchMode] browser gate cleanup failed:', getErrorMessage(error));
  }
}

/**
 * 持久化总开关并按契约广播；失败时通知并返回 false（调用方负责回滚乐观态）。
 */
export async function persistWorkbenchModeEnabled(enabled: boolean): Promise<boolean> {
  try {
    await tauriInvoke('save_setting', {
      key: WORKBENCH_MODE_SETTING_KEY,
      value: String(enabled),
    });
  } catch (error) {
    showGlobalNotification('error', getErrorMessage(error));
    return false;
  }
  setCachedWorkbenchModeEnabled(enabled);
  if (!enabled) await closeBrowserForDisabledGate();
  workbenchBus.setEnabled(enabled);
  try {
    window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled } }));
  } catch {
    // noop
  }
  return true;
}

/** 测试辅助：清空进程内缓存 */
export function __resetWorkbenchModeCacheForTest(): void {
  cachedWorkbenchModeEnabled = null;
}
