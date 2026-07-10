/**
 * 思维导图应用注册（P8 + ACR R1-11）
 *
 * 复用 MindMapContentView，weight=2，multi（instanceKey=resourceId）。
 * onActivation：focusNode / setView（DESIGN §5.1）。
 */
import React from 'react';
import { MindmapIcon } from '@/features/learning-hub/icons';
import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapViewType } from '@/features/mindmap/types';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, AppDefinition } from '../../core/types';
import { MINDMAP_APP_TYPE_ID } from '../content/typeMap';

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

/** onActivation：focusNode {nodeId} / setView {view:'outline'|'mindmap'} */
export function handleMindmapActivation(ctx: ActivationContext): void {
  const store = useMindMapStore.getState();
  const payload = payloadRecord(ctx.payload);

  switch (ctx.action) {
    case 'focusNode': {
      const nodeId =
        (typeof payload?.nodeId === 'string' && payload.nodeId) ||
        (typeof payload?.node_id === 'string' && payload.node_id) ||
        null;
      if (!nodeId) {
        console.warn('[workbench:mindmap] focusNode ignored: missing nodeId');
        return;
      }
      store.expandToNode(nodeId, { silent: true });
      store.setFocusedNodeId(nodeId);
      break;
    }
    case 'setView': {
      const view = payload?.view;
      if (view !== 'outline' && view !== 'mindmap') {
        console.warn('[workbench:mindmap] setView ignored: invalid view', view);
        return;
      }
      store.setCurrentView(view as MindMapViewType);
      break;
    }
    default:
      console.warn(`[workbench:mindmap] unknown activation action: ${ctx.action}`);
  }
}

/** 导出供测试断言元数据 */
export const MINDMAP_APP_DEFINITION: AppDefinition = {
  typeId: MINDMAP_APP_TYPE_ID,
  nameKey: 'workbench:apps.mindmap',
  icon: React.createElement(MindmapIcon, { className: 'h-full w-full' }),
  instanceMode: 'multi',
  memoryWeight: 2,
  defaultFrame: { w: 920, h: 660 },
  minSize: { w: 420, h: 320 },
  render: React.lazy(() => import('./MindmapAppWindow')),
  onActivation: handleMindmapActivation,
};

appRegistry.register(MINDMAP_APP_DEFINITION);
