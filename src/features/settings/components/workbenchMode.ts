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
// 停用事务（缝一）：本模块是设置页之外所有模式开关入口（侧边栏快捷开关 /
// 品牌菜单「退出学习桌面」等）的唯一写通道，停用预检必须在这里收口，
// 否则这些入口会绕过逐窗 canClose 直接卸壳（App.tsx 已静态引入同一模块，
// 不新增首屏体积）。
import { runWorkbenchDeactivationTransaction } from '@/features/workbench/core/deactivationTransaction';
// 接缝三 handoff（r5 边界审阅接线）：停用成功后、卸壳前采集焦点窗
// descriptor 落独立 key 并对齐经典壳视图；模块已在 App.tsx 静态图中。
import { handoffWorkbenchToLegacyShell } from '@/features/workbench/core/legacyNavigationMap';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

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
  if (!enabled) {
    // 停用前先走共享停用事务（逐窗 canClose 预检，可取消；single-flight）。
    // 事务 ok 之前不产生任何副作用：不 persist、不动 bus、不派发事件——
    // 取消即返回 false，调用方按「未保存」回滚乐观 UI（事务内部已向用户提示）。
    let precheckOk = false;
    try {
      precheckOk = (await runWorkbenchDeactivationTransaction('mode-off')).ok;
    } catch {
      // 事务内部的取消 toast 只在「窗口拒绝关闭」分支发出；promise 意外
      // reject（canClose 回调抛错等）时内部无任何提示，这里兜底通知一次，
      // 与 WorkbenchSettingsSection.handleModeChange 的 catch 对齐——否则
      // 侧边栏 / 品牌菜单入口只会看到开关静默弹回。两分支互斥，无双 toast。
      showGlobalNotification(
        'info',
        i18n.t('workbench:deactivation.cancelled', {
          defaultValue: '已取消停用，学习桌面保持开启。',
        }),
      );
    }
    if (!precheckOk) return false;
  }
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
  if (!enabled) {
    // 焦点上下文交接：持久化成功后、setEnabled(false)/mode-changed 之前——
    // 窗口尚未卸载，采集完整（legacyNavigationMap 头注的调用点契约）。
    // 交接是尽力而为的增强，失败绝不阻塞停用本身。
    try {
      handoffWorkbenchToLegacyShell();
    } catch (error) {
      console.warn('[workbenchMode] focus handoff failed:', getErrorMessage(error));
    }
    await closeBrowserForDisabledGate();
  }
  workbenchBus.setEnabled(enabled);
  try {
    dispatchAppEvent(APP_EVENTS.WORKBENCH_MODE_CHANGED, { enabled });
  } catch {
    // noop
  }
  return true;
}

/** 测试辅助：清空进程内缓存 */
export function __resetWorkbenchModeCacheForTest(): void {
  cachedWorkbenchModeEnabled = null;
}
