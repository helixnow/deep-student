/**
 * 沙箱工作台应用注册（P9）
 *
 * instanceMode 决策：独立工作台固定绑定 standalone owner，产品上只需要一个
 * 宿主窗口；chat 内嵌预览使用各自 owner，不与该单例窗口共享活动指针。
 */
import React from 'react';
import { CodeBlock } from '@phosphor-icons/react';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { SandboxViewportPreset, SandboxWorkbenchMode } from '@/features/sandbox/types';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult } from '../../core/types';
import { createSandboxAgentManifest } from './agentManifest';

let registered = false;

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function unavailable(hint: string): ActivationResult {
  return { handled: false, code: 'ACTION_UNAVAILABLE', hint };
}

export function handleSandboxActivation(ctx: ActivationContext): ActivationResult {
  const store = useSandboxWorkbenchStore.getState();
  const current = selectSandboxWorkbenchOwnerState(store, LEGACY_SANDBOX_OWNER_KEY);
  const payload = payloadRecord(ctx.payload);
  switch (ctx.action) {
    case 'refresh':
      if (!current.activeSession) {
        return { handled: false, code: 'INVALID_STATE', hint: 'Sandbox 当前没有活动会话' };
      }
      const beforeUpdatedAt = current.activeSession.updatedAt;
      store.refreshSession(LEGACY_SANDBOX_OWNER_KEY);
      const refreshed = selectSandboxWorkbenchOwnerState(
        useSandboxWorkbenchStore.getState(),
        LEGACY_SANDBOX_OWNER_KEY,
      ).activeSession;
      return refreshed?.updatedAt !== beforeUpdatedAt
        ? { handled: true, acknowledged: true }
        : unavailable('Sandbox 刷新未产生新的表面版本');
    case 'setViewport': {
      const viewport = payload.viewport as SandboxViewportPreset;
      if (viewport !== 'desktop' && viewport !== 'tablet' && viewport !== 'mobile') {
        return { handled: false, code: 'INVALID_ARGS', hint: 'viewport 值无效' };
      }
      if (current.viewportPreset === viewport) return unavailable('Sandbox 已处于目标视口');
      store.setViewportPreset(viewport, LEGACY_SANDBOX_OWNER_KEY);
      return { handled: true, acknowledged: true };
    }
    case 'setInspector':
      if (typeof payload.open !== 'boolean') {
        return { handled: false, code: 'INVALID_ARGS', hint: 'setInspector 需要 open' };
      }
      if (current.inspectorOpen === payload.open) return unavailable('Sandbox 检查器已处于目标状态');
      store.setInspectorOpen(payload.open, LEGACY_SANDBOX_OWNER_KEY);
      return { handled: true, acknowledged: true };
    case 'setMode': {
      const mode = payload.mode as SandboxWorkbenchMode;
      if (mode !== 'safe-preview' && mode !== 'sandbox-run') {
        return { handled: false, code: 'INVALID_ARGS', hint: 'mode 值无效' };
      }
      if (!current.activeSession) {
        return { handled: false, code: 'INVALID_STATE', hint: 'Sandbox 当前没有活动会话' };
      }
      if (current.activeSession.mode === mode) return unavailable('Sandbox 已处于目标运行模式');
      store.setWorkbenchMode(mode, LEGACY_SANDBOX_OWNER_KEY);
      return { handled: true, acknowledged: true };
    }
    case 'closeSession':
      if (!current.activeSession) return unavailable('Sandbox 当前没有活动会话');
      store.closeSession(LEGACY_SANDBOX_OWNER_KEY);
      return { handled: true, acknowledged: true };
    default:
      return { handled: false, code: 'UNKNOWN_ACTION', hint: `Sandbox 不支持指令 ${ctx.action}` };
  }
}

/** 幂等注册沙箱工作台应用 */
export function registerSandboxApp(): void {
  if (registered) return;
  registered = true;

  appRegistry.register({
    typeId: 'sandbox',
    nameKey: 'workbench:apps.sandbox',
    icon: <CodeBlock size={26} weight="duotone" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 960, h: 680 },
    minSize: { w: 560, h: 420 },
    render: React.lazy(() => import('./SandboxAppWindow')),
    onActivation: handleSandboxActivation,
    agentManifest: createSandboxAgentManifest(handleSandboxActivation),
  });
}
