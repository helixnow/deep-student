/**
 * ACR 状态查询 provider — R1-08
 *
 * 注册 list_windows / query_state 到 StageManager。
 * WindowSummary 组装：getSortedWindows + lifecycles + focusStack 栈顶 + isContentDirty
 * + appRegistry nameKey 生成 title 兜底。
 *
 * @see docs/dev/acr/DESIGN.md §2.3
 * @see docs/dev/acr/ROUND1.md R1-08
 */

import i18n from 'i18next';
import { isContentDirty } from '../apps/content/contentDirtyRegistry';
import { appRegistry } from '../core/appRegistry';
import { getSortedWindows } from '../core/windowListCache';
import { useWindowStore } from '../core/windowStore';
import type { WorkbenchWindow } from '../core/types';
import type { CollabDriver, StageManagerApi, WindowSummary } from './types';

/** Driver 可选扩展：query_state 时合并进摘要（鸭子探测，不改 CollabDriver 冻结接口） */
export type QueryStateCapableDriver = CollabDriver & {
  queryState?: (ctx: {
    windowId: string;
    typeId: string;
    instanceKey: string | null;
  }) => Record<string, unknown> | unknown;
};

export interface ListWindowsResult {
  windows: WindowSummary[];
  focused?: string;
}

export interface QueryStateResult {
  typeId: string;
  title: string;
  instanceKey: string | null;
  lifecycle: string;
  windowId: string;
  [key: string]: unknown;
}

function resolveWindowTitle(win: WorkbenchWindow): string {
  const trimmed = typeof win.title === 'string' ? win.title.trim() : '';
  if (trimmed) return trimmed;
  const def = appRegistry.get(win.typeId);
  if (def?.nameKey) {
    const label = i18n.t(def.nameKey, win.typeId);
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return win.typeId;
}

function resolveLifecycle(
  win: WorkbenchWindow,
  lifecycles: Record<string, string>,
  focusedId: string | undefined,
): string {
  const explicit = lifecycles[win.id];
  if (explicit) return explicit;
  if (win.minimized) return 'background';
  return win.id === focusedId ? 'focused' : 'visible';
}

/** 从当前 windowStore 组装 WindowSummary 列表（供单测与 provider 复用） */
export function buildWindowSummaries(): ListWindowsResult {
  const state = useWindowStore.getState();
  const focusedId =
    state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : undefined;
  const sorted = getSortedWindows(state.windows);
  const windows: WindowSummary[] = sorted.map((win) => ({
    windowId: win.id,
    typeId: win.typeId,
    instanceKey: win.instanceKey,
    title: resolveWindowTitle(win),
    lifecycle: resolveLifecycle(win, state.lifecycles, focusedId),
    focused: focusedId === win.id,
    dirty: isContentDirty(win.typeId, win.instanceKey),
  }));
  return focusedId ? { windows, focused: focusedId } : { windows };
}

function mergeDriverQueryState(
  stage: StageManagerApi,
  win: WorkbenchWindow,
  base: QueryStateResult,
): QueryStateResult {
  const driver = stage.getDriver(win.typeId) as QueryStateCapableDriver | undefined;
  if (!driver || typeof driver.queryState !== 'function') return base;
  try {
    const ext = driver.queryState({
      windowId: win.id,
      typeId: win.typeId,
      instanceKey: win.instanceKey,
    });
    if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
      return { ...base, ...(ext as Record<string, unknown>) };
    }
  } catch {
    /* driver 扩展失败不影响默认摘要 */
  }
  return base;
}

function buildQueryState(
  stage: StageManagerApi,
  args: unknown,
): QueryStateResult | { code: string; message: string; hint: string; retryable: boolean } {
  const state = useWindowStore.getState();
  const input = (args && typeof args === 'object' ? args : {}) as {
    scope?: string;
    windowId?: string;
  };
  const scope = input.scope === 'window' ? 'window' : 'focused';

  let windowId: string | undefined;
  if (scope === 'window') {
    windowId = typeof input.windowId === 'string' ? input.windowId : undefined;
    if (!windowId) {
      return {
        code: 'WINDOW_NOT_FOUND',
        message: 'scope=window 时必须提供 windowId',
        hint: '先调用 list_windows 获取 windowId，再 query_state',
        retryable: false,
      };
    }
  } else {
    windowId =
      state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : undefined;
    if (!windowId) {
      return {
        code: 'WINDOW_NOT_FOUND',
        message: '当前没有焦点窗口',
        hint: '用 list_windows 查看桌面，或 open_app 打开目标应用',
        retryable: false,
      };
    }
  }

  const win = state.windows[windowId];
  if (!win) {
    return {
      code: 'WINDOW_NOT_FOUND',
      message: `窗口不存在: ${windowId}`,
      hint: '窗口可能已关闭；重新 list_windows',
      retryable: false,
    };
  }

  const focusedId =
    state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : undefined;
  const base: QueryStateResult = {
    windowId: win.id,
    typeId: win.typeId,
    title: resolveWindowTitle(win),
    instanceKey: win.instanceKey,
    lifecycle: resolveLifecycle(win, state.lifecycles, focusedId),
  };
  return mergeDriverQueryState(stage, win, base);
}

/**
 * 向 StageManager 注册内置查询 provider。
 * scope 名与桥命令对齐：'list_windows' / 'query_state'。
 */
export function registerBuiltinQueryProviders(stage: StageManagerApi): void {
  stage.registerQueryProvider('list_windows', () => buildWindowSummaries());
  stage.registerQueryProvider('query_state', (args) => buildQueryState(stage, args));
}
