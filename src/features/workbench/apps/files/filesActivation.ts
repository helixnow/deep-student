/**
 * Files 应用 onActivation — R1-14
 *
 * openFolder {folderId} / reveal {resourceId}
 * store 动态 import，避免把 learning-hub 拉进 workbench 首包。
 * v1 reveal：仅选中 + flash，不进入父目录（父目录解析遗留 R2）。
 */

import type { ActivationContext } from '../../core/types';
import { agentFlash } from '../../agent/visuals/agentFlash';

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 导出供单测与 AppDefinition.onActivation */
export function handleFilesActivation(ctx: ActivationContext): void {
  switch (ctx.action) {
    case 'openFolder': {
      const folderId = payloadString(ctx.payload, 'folderId');
      if (!folderId) {
        console.warn('[workbench:files] openFolder ignored: missing folderId');
        return;
      }
      void import('@/features/learning-hub/stores/finderStore')
        .then(({ useFinderStore }) =>
          useFinderStore.getState().enterFolder(folderId),
        )
        .catch((err) => console.warn('[workbench:files] openFolder failed:', err));
      break;
    }
    case 'reveal': {
      const resourceId = payloadString(ctx.payload, 'resourceId');
      if (!resourceId) {
        console.warn('[workbench:files] reveal ignored: missing resourceId');
        return;
      }
      // v1：不解析/进入父目录，仅选中并 flash（当前目录若无该行则 flash no-op）
      void import('@/features/learning-hub/stores/finderStore')
        .then(({ useFinderStore }) => {
          useFinderStore.getState().setSelectedIds(new Set([resourceId]));
          agentFlash('files', resourceId);
        })
        .catch((err) => console.warn('[workbench:files] reveal failed:', err));
      break;
    }
    default:
      console.warn(`[workbench:files] unknown activation action: ${ctx.action}`);
  }
}
