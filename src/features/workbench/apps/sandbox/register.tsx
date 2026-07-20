/**
 * 沙箱工作台应用注册（P9）
 *
 * instanceMode 决策：独立工作台固定绑定 standalone owner，产品上只需要一个
 * 宿主窗口；chat 内嵌预览使用各自 owner，不与该单例窗口共享活动指针。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { SandboxViewportPreset } from '@/features/sandbox/types';
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
    case 'setMode':
      // ACR 4.0（A6 诚实化）：渲染面固定 chat-safe 安全预览，切模式没有任何真实
      // 渲染效果——不改 store、不假装成功。能力已从 manifest 撤除，此处兜底同语义。
      return unavailable('Sandbox 仅有安全预览（safe-preview）一种渲染形态，不支持切换运行模式');
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
    icon: <AppIconImage typeId="sandbox" className="h-8 w-8" />,
    // 沙箱是聊天代码块的内嵌工作面，不再作为可独立启动的应用暴露。
    // 保留窗口注册仅用于旧快照与既有 agent 能力的兼容。
    showInLauncher: false,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 960, h: 680 },
    // 最小宽 640 与 chat 对齐：560–640 区间没有 compact 适配分支（useWbSysSize
    // 的 compact 档 <640，而 SandboxAppWindow.css 无对应消费），直接避免进入该区间
    minSize: { w: 640, h: 420 },
    render: React.lazy(() => import('./SandboxAppWindow')),
    onActivation: handleSandboxActivation,
    agentManifest: createSandboxAgentManifest(handleSandboxActivation),
  });
}
