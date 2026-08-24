/**
 * 收集 action-bar 中未出现在 handler 注册表的 action id。
 * actionHandlers 未传入时不强制注册表（与 ActionBar 一致），返回空数组。
 * 返回值去重且保持首次出现顺序。
 */

import type { GenerativeUIIntent } from '../types';

function actionBarActionIds(intent: GenerativeUIIntent): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of intent.blocks) {
    if (block.type !== 'action-bar') continue;
    const actions = (block.props as { actions?: Array<{ id?: unknown }> } | undefined)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const id = action?.id;
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function collectUnregisteredActionIds(
  intent: GenerativeUIIntent,
  actionHandlers?: Record<string, unknown>,
): string[] {
  if (actionHandlers == null) return [];
  return actionBarActionIds(intent).filter((id) => actionHandlers[id] == null);
}
