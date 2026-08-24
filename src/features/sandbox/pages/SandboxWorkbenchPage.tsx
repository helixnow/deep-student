import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, SidebarSimple } from '@phosphor-icons/react';

import { useMobileHeader } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { DsButton } from '@/components/ui/DsButton';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '../store/useSandboxWorkbenchStore';
import { SandboxWorkbenchSurface } from '../components/SandboxWorkbenchSurface';

export function SandboxWorkbenchPage() {
  const { t } = useTranslation('workbench');
  const { isSmallScreen } = useBreakpoint();
  const hasSession = useSandboxWorkbenchStore((state) => (
    selectSandboxWorkbenchOwnerState(state, LEGACY_SANDBOX_OWNER_KEY).activeSession !== null
  ));
  const inspectorOpen = useSandboxWorkbenchStore((state) => (
    selectSandboxWorkbenchOwnerState(state, LEGACY_SANDBOX_OWNER_KEY).inspectorOpen
  ));
  const refreshSession = useSandboxWorkbenchStore((state) => state.refreshSession);
  const setInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);

  // D-1: 移动端顶栏标题（sandbox-workbench 独立视图形态；
  // 作为 chat-v2 右屏嵌入时不经过本页面组件，不受影响）
  // ★ 2026-07-08（移动端审计 D-6）：小屏隐藏 Surface 自绘 SandboxToolbar
  // 避免双顶栏，刷新/检查器动作收进统一顶栏右侧。
  useMobileHeader('sandbox-workbench', {
    title: t('sandbox.title'),
    // ★ 顶栏统一：返回箭头回聊天主视图（与设置/总览等子页一致）。
    // viewStore.setCurrentView 仅允许 App.tsx 写入，跨组件导航走 NAVIGATE_TO_VIEW 事件。
    showBackArrow: true,
    onMenuClick: () => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' }),
    rightActions: hasSession ? (
      <>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          aria-label={t('sandbox.refresh')}
          onClick={() => refreshSession(LEGACY_SANDBOX_OWNER_KEY)}
        >
          <ArrowClockwise size={18} />
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          aria-label={inspectorOpen ? t('sandbox.closeInspector') : t('sandbox.openInspector')}
          onClick={() => setInspectorOpen(!inspectorOpen, LEGACY_SANDBOX_OWNER_KEY)}
        >
          <SidebarSimple size={18} />
        </DsButton>
      </>
    ) : undefined,
  }, [t, hasSession, inspectorOpen, refreshSession, setInspectorOpen]);

  return (
    <SandboxWorkbenchSurface
      className="h-full"
      hideToolbar={isSmallScreen}
      ownerKey={LEGACY_SANDBOX_OWNER_KEY}
    />
  );
}

export default SandboxWorkbenchPage;
