import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, SidebarSimple } from '@phosphor-icons/react';

import { useMobileHeader } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { NotionButton } from '@/components/ui/NotionButton';
import { useSandboxWorkbenchStore } from '../store/useSandboxWorkbenchStore';
import { SandboxWorkbenchSurface } from '../components/SandboxWorkbenchSurface';

export function SandboxWorkbenchPage() {
  const { t } = useTranslation('common');
  const { isSmallScreen } = useBreakpoint();
  const hasSession = useSandboxWorkbenchStore((state) => state.activeSession !== null);
  const inspectorOpen = useSandboxWorkbenchStore((state) => state.inspectorOpen);
  const refreshSession = useSandboxWorkbenchStore((state) => state.refreshSession);
  const setInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);

  // D-1: 移动端顶栏标题（sandbox-workbench 独立视图形态；
  // 作为 chat-v2 右屏嵌入时不经过本页面组件，不受影响）
  // ★ 2026-07-08（移动端审计 D-6）：小屏隐藏 Surface 自绘 SandboxToolbar
  // 避免双顶栏，刷新/检查器动作收进统一顶栏右侧。
  useMobileHeader('sandbox-workbench', {
    title: t('navigation.sandbox_workbench', '沙箱工作台'),
    rightActions: hasSession ? (
      <>
        <NotionButton
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('actions.refresh', '刷新')}
          onClick={refreshSession}
        >
          <ArrowClockwise size={18} />
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={inspectorOpen ? t('sandbox_workbench.close_inspector', '收起检查器') : t('sandbox_workbench.open_inspector', '打开检查器')}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          <SidebarSimple size={18} />
        </NotionButton>
      </>
    ) : undefined,
  }, [t, hasSession, inspectorOpen, refreshSession, setInspectorOpen]);

  return <SandboxWorkbenchSurface className="h-full" hideToolbar={isSmallScreen} />;
}

export default SandboxWorkbenchPage;
