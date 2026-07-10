/**
 * Todo 应用 onActivation — R1-14
 *
 * showList {listId} / focusItem {itemId}
 * store 动态 import，避免把 todo 拉进 workbench 首包（与 chat register 纪律一致）。
 */

import type { ActivationContext } from '../../core/types';
import { agentFlash } from '../../agent/visuals/agentFlash';

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 导出供单测与 AppDefinition.onActivation */
export function handleTodoActivation(ctx: ActivationContext): void {
  switch (ctx.action) {
    case 'showList': {
      const listId = payloadString(ctx.payload, 'listId');
      if (!listId) {
        console.warn('[workbench:todo] showList ignored: missing listId');
        return;
      }
      void import('@/features/todo/stores/useTodoStore')
        .then(({ useTodoStore }) => {
          useTodoStore.getState().setActiveList(listId);
        })
        .catch((err) => console.warn('[workbench:todo] showList failed:', err));
      break;
    }
    case 'focusItem': {
      const itemId = payloadString(ctx.payload, 'itemId');
      if (!itemId) {
        console.warn('[workbench:todo] focusItem ignored: missing itemId');
        return;
      }
      void import('@/features/todo/stores/useTodoStore')
        .then(({ useTodoStore }) => {
          useTodoStore.getState().selectItem(itemId);
          agentFlash('todo', itemId);
        })
        .catch((err) => console.warn('[workbench:todo] focusItem failed:', err));
      break;
    }
    default:
      console.warn(`[workbench:todo] unknown activation action: ${ctx.action}`);
  }
}
