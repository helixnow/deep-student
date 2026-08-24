/**
 * 收集 action-bar 中未出现在 handler 注册表的 action id。
 * actionHandlers 未传入时不强制注册表（与 ActionBar 一致），返回空数组。
 * 返回值去重且保持首次出现顺序。
 */

import type { GenerativeUIIntent } from '../types';

function actionIdsFromActionBar(block: GenerativeUIIntent['blocks'][number]): string[] {
  if (block.type !== 'action-bar') return [];
  const actions = (block.props as { actions?: Array<{ id?: unknown }> } | undefined)?.actions;
  if (!Array.isArray(actions)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    const id = action?.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function actionBarIsReachable(
  block: GenerativeUIIntent['blocks'][number],
  actionHandlers?: Record<string, unknown>,
): boolean {
  const ids = actionIdsFromActionBar(block);
  if (ids.length === 0) return false;
  if (actionHandlers == null) return true;
  return ids.some((id) => Object.hasOwn(actionHandlers, id));
}

function actionBarActionIds(intent: GenerativeUIIntent): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of intent.blocks) {
    for (const id of actionIdsFromActionBar(block)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 第一个可聚焦 ActionBar 的下标；没有则 -1。 */
export function firstReachableActionBarIndex(
  intent: GenerativeUIIntent,
  actionHandlers?: Record<string, unknown>,
): number {
  return intent.blocks.findIndex((block) => actionBarIsReachable(block, actionHandlers));
}

export function collectUnregisteredActionIds(
  intent: GenerativeUIIntent,
  actionHandlers?: Record<string, unknown>,
): string[] {
  if (actionHandlers == null) return [];
  return actionBarActionIds(intent).filter((id) => !Object.hasOwn(actionHandlers, id));
}

/** 是否存在可聚焦的 ActionBar：无注册表时有 action-bar 即可；有注册表时至少有一个已注册 id。 */
export function intentHasReachableActionBar(
  intent: GenerativeUIIntent,
  actionHandlers?: Record<string, unknown>,
): boolean {
  return firstReachableActionBarIndex(intent, actionHandlers) >= 0;
}
