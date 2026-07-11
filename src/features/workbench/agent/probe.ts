/**
 * ACR probe — R1-07
 *
 * 同步判定目标资源六态（DESIGN §1.1 / ROUND1 R1-07）：
 * disabled → closed → frozen → dirty → hot → clean
 *
 * hot 仅当「焦点窗且 driver 报 hot」。不许 async。
 * 设计：docs/dev/acr/DESIGN.md §1.1
 */
import { isContentDirty } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { getWindowRenderHint } from '@/features/workbench/core/scheduler';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  findWorkspaceHostForResource,
  getWorkspaceActiveResource,
} from '@/features/workbench/apps/notes/workspaceRegistry';
import { getAgentControlMode } from './gates';
import { stageManager } from './stageManager';
import type { AcrProbeState, AcrTarget, ProbeResult } from './types';

/**
 * 在 windowStore 中查找目标窗：
 * - typeId 必须匹配
 * - 有 resourceId → instanceKey === resourceId（content 类）
 * - 无 resourceId → 同 typeId 任意窗（单例 instanceKey 为 null；多窗取最近焦点）
 */
function findTargetWindow(target: AcrTarget): { id: string; instanceKey: string | null } | null {
  const { windows } = useWindowStore.getState();
  if (target.typeId === 'note' || target.typeId === 'mindmap') {
    const resourceId = target.resourceId?.trim();
    let windowId: string | null = null;
    if (resourceId) {
      windowId = findWorkspaceHostForResource({ type: target.typeId, id: resourceId });
    } else {
      const candidate = Object.values(windows)
        .filter((win) => win.typeId === 'notes')
        .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
        .find((win) => getWorkspaceActiveResource(win.id)?.type === target.typeId);
      windowId = candidate?.id ?? null;
    }
    const workspaceWindow = windowId ? windows[windowId] : undefined;
    if (workspaceWindow) {
      return { id: workspaceWindow.id, instanceKey: resourceId ?? null };
    }
  }
  const matches = Object.values(windows).filter((win) => {
    if (win.typeId !== target.typeId) return false;
    if (target.resourceId != null && target.resourceId !== '') {
      return win.instanceKey === target.resourceId;
    }
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  const win = matches[0];
  return win ? { id: win.id, instanceKey: win.instanceKey } : null;
}

function isWindowFrozen(windowId: string): boolean {
  try {
    const hint = getWindowRenderHint(windowId);
    if (hint.lifecycle === 'frozen') return true;
  } catch {
    /* scheduler 未初始化时忽略 */
  }
  const { lifecycles } = useWindowStore.getState();
  return lifecycles[windowId] === 'frozen';
}

/** 焦点窗 = focusStack 栈顶且未 minimized，或 lifecycle === 'focused' */
function isFocusedWindow(windowId: string): boolean {
  const { focusStack, windows, lifecycles } = useWindowStore.getState();
  for (let i = focusStack.length - 1; i >= 0; i--) {
    const id = focusStack[i];
    const win = windows[id];
    if (win && !win.minimized) {
      return id === windowId;
    }
  }
  return lifecycles[windowId] === 'focused';
}

/**
 * 探测目标窗口/资源状态。同步，禁止 await。
 * 返回 ProbeResult（state + windowId）；契约见 types.ts。
 */
export function probeTarget(target: AcrTarget): ProbeResult {
  // OS 关 或 control=off → disabled，域执行器走后端直写（R2-08 / ERRORS.md）
  if (!workbenchBus.isEnabled() || getAgentControlMode() === 'off') {
    return { state: 'disabled', windowId: null };
  }

  const win = findTargetWindow(target);
  if (!win) {
    return { state: 'closed', windowId: null };
  }

  if (isWindowFrozen(win.id)) {
    return { state: 'frozen', windowId: win.id };
  }

  let driverState: AcrProbeState | null = null;
  const driver = stageManager.getDriver(target.typeId);
  if (driver) {
    try {
      driverState = driver.probe(target);
    } catch (err) {
      console.warn('[ACR] driver.probe failed:', err);
    }
  }

  // dirty：contentDirty 或 driver 自报 dirty（优先于 hot）
  const instanceKey =
    target.resourceId != null && target.resourceId !== ''
      ? target.resourceId
      : win.instanceKey;
  if (driverState === 'dirty' || isContentDirty(target.typeId, instanceKey)) {
    return { state: 'dirty', windowId: win.id };
  }

  // hot：仅焦点窗且 driver 报 hot
  if (driverState === 'hot' && isFocusedWindow(win.id)) {
    return { state: 'hot', windowId: win.id };
  }

  return { state: 'clean', windowId: win.id };
}
