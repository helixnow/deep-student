import React, { useEffect, useMemo, useCallback } from 'react';
import { ArrowClockwise, ArrowSquareOut, ListChecks, Plus, SidebarSimple } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { useMobileHeader } from '@/components/layout';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { MobileBreadcrumb } from '@/features/learning-hub/components/MobileBreadcrumb';
import { groupEditorSubmitRef } from '../components/groups/GroupEditorDialog';
import {
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { cn } from '@/lib/utils';
import type { TFunction } from 'i18next';
import type { ChatSession } from '../types/session';
import type { BreadcrumbItem } from '@/features/learning-hub/stores/finderStore';
import type { SandboxOwnerKey } from '@/features/sandbox/types';

/**
 * 移动端全局顶栏「在学习中心打开」桥接：ChatV2Page 挂载期间写入
 * handleOpenInLearningHub（与 groupEditorSubmitRef 同一模式，避免把回调
 * 层层穿进布局 hook 的 deps）。卸载时清空，防止陈旧闭包被点击。
 */
export const openAppInLearningHubRef: React.MutableRefObject<(() => void) | null> = { current: null };

export interface UseChatPageLayoutDeps {
  currentSession: ChatSession | undefined;
  currentSessionId: string | null;
  expandGroup: (groupId: string) => void;
  currentSessionHasMessages: boolean;
  viewMode: 'sidebar' | 'browser';
  sessionSheetOpen: boolean;
  t: TFunction<any, any>;
  sessionCount: number;
  createSession: (groupId?: string) => Promise<void>;
  isLoading: boolean;
  mobileResourcePanelOpen: boolean;
  finderBreadcrumbs: BreadcrumbItem[];
  finderJumpToBreadcrumb: (index: number) => void;
  setMobileResourcePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  /** 移动端右屏正在展示沙箱工作台 */
  mobileSandboxOpen: boolean;
  /** 关闭移动端沙箱工作台（同时收起右屏） */
  closeMobileSandbox: () => void;
  /** 沙箱工作台 owner key：顶栏刷新/检查器动作定向到本页实例 */
  sandboxOwnerKey: SandboxOwnerKey;
  /** 移动端右屏正在展示的资源标题（null = 资源库列表，显示面包屑） */
  openAppTitle: string | null;
  /** 关闭右屏资源预览（回到资源库列表上一层） */
  closeMobileOpenApp: () => void;
  /** 分组编辑器（inline 子屏）是否打开 */
  groupEditorOpen: boolean;
  /** 分组编辑器模式（决定顶栏标题） */
  groupEditorMode: 'create' | 'edit';
  /** 关闭分组编辑器（顶栏返回箭头 / Android 返回键） */
  closeGroupEditor: () => void;
  /** 移动端右屏资源库：多选模式是否激活（全局顶栏勾选按钮高亮） */
  resourceMultiSelectActive: boolean;
  /** 移动端右屏资源库：多选模式切换句柄（由 LearningHubSidebar 持续写入） */
  resourceMultiSelectToggleRef: React.MutableRefObject<(() => void) | null>;
}

export function useChatPageLayout(deps: UseChatPageLayoutDeps) {
  const {
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, t, sessionCount, createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setViewMode,
    mobileSandboxOpen, closeMobileSandbox, sandboxOwnerKey,
    openAppTitle, closeMobileOpenApp,
    groupEditorOpen, groupEditorMode, closeGroupEditor,
    resourceMultiSelectActive, resourceMultiSelectToggleRef,
  } = deps;

  // 沙箱右屏顶栏动作：嵌入形态 hideToolbar 后，Surface 自绘工具栏的
  // 刷新/检查器入口上移到全局顶栏（与 SandboxWorkbenchPage 独立视图对齐）
  const sandboxInspectorOpen = useSandboxWorkbenchStore((state) => (
    selectSandboxWorkbenchOwnerState(state, sandboxOwnerKey).inspectorOpen
  ));
  const refreshSandboxSession = useSandboxWorkbenchStore((state) => state.refreshSession);
  const setSandboxInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);

  const currentSessionGroupKey = currentSession ? (currentSession.groupId || 'ungrouped') : null;
  useEffect(() => {
    if (!currentSessionGroupKey) return;
    expandGroup(currentSessionGroupKey);
  }, [currentSessionId, currentSessionGroupKey, expandGroup]);

  // 空态判断：没有会话或当前会话没有消息，即为空态新对话
  // 有消息则可以新建对话，避免创建多个空对话
  const isEmptyNewChat = !currentSessionId || !currentSessionHasMessages;

  // 根据视图模式配置顶栏
  const headerTitle = useMemo(() => {
    if (viewMode === 'browser') {
      return t('browser.titleWithCount', { count: sessionCount });
    }
    return currentSession?.title?.trim() || undefined;
  }, [viewMode, currentSession?.title, t, sessionCount]);

  // 同步窗口标题栏
  useDocumentTitle(currentSession?.title);

  const homepageNewChatAction = useMemo(() => (
    <DsButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={() => void createSession()}
      disabled={isLoading}
      className={shellIconButtonClassName}
      data-mobile-floating-menu-button
      aria-label={t('page.newSession')}
      title={t('page.newSession')}
    >
      <Plus size={21} weight="regular" />
    </DsButton>
  ), [createSession, isLoading, t]);

  const sessionNewChatAction = useMemo(() => (
    <DsButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={() => void createSession()}
      disabled={isLoading || isEmptyNewChat}
      className={shellIconButtonClassName}
      aria-label={t('page.newSession')}
      title={t('page.newSession')}
    >
      <Plus size={20} />
    </DsButton>
  ), [createSession, isEmptyNewChat, isLoading, t]);

  const browserNewChatAction = useMemo(() => (
    <DsButton
      variant="primary"
      size="icon"
      iconOnly
      onClick={() => {
        setViewMode('sidebar');
        void createSession();
      }}
      disabled={isLoading}
      aria-label={t('page.newSession')}
      title={t('page.newSession')}
    >
      <Plus size={20} />
    </DsButton>
  ), [createSession, isLoading, setViewMode, t]);

  // 📱 移动端资源库面包屑导航回调
  const handleFinderBreadcrumbNavigate = useCallback((index: number) => {
    finderJumpToBreadcrumb(index);
  }, [finderJumpToBreadcrumb]);

  const isMinimalChatHeader = viewMode !== 'browser' && isEmptyNewChat;

  // 顶栏分支与移动端可见内容一一对应：
  // 右屏（沙箱 > 资源预览 > 资源库列表）→ 中屏子屏（分组编辑器）→ 默认（浏览视图/聊天）
  useMobileHeader('chat-v2', mobileSandboxOpen ? {
    title: t('common:navigation.sandbox_workbench', '沙箱工作台'),
    showBackArrow: true,
    onMenuClick: closeMobileSandbox,
    rightActions: (
      <>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
          onClick={() => refreshSandboxSession(sandboxOwnerKey)}
          aria-label={t('workbench:sandbox.refresh', '刷新')}
          title={t('workbench:sandbox.refresh', '刷新')}
        >
          <ArrowClockwise size={20} />
        </DsButton>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => setSandboxInspectorOpen(!sandboxInspectorOpen, sandboxOwnerKey)}
          className={cn(
            '[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
            sandboxInspectorOpen
              && 'bg-primary/10 text-primary hover:bg-primary/15',
          )}
          aria-label={sandboxInspectorOpen
            ? t('workbench:sandbox.closeInspector', '收起检查器')
            : t('workbench:sandbox.openInspector', '打开检查器')}
          title={sandboxInspectorOpen
            ? t('workbench:sandbox.closeInspector', '收起检查器')
            : t('workbench:sandbox.openInspector', '打开检查器')}
        >
          <SidebarSimple size={20} />
        </DsButton>
      </>
    ),
  } : mobileResourcePanelOpen ? (
    openAppTitle !== null ? {
      title: openAppTitle || t('common:untitled', '未命名'),
      showBackArrow: true,
      onMenuClick: closeMobileOpenApp,
      // ★ 右屏资源预览 fullScreen 形态隐藏了面板自带工具栏（renderOpenAppPanel），
      // 「在学习中心打开」入口上移全局顶栏；句柄由 ChatV2Page 挂载期间写入
      rightActions: (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
          onClick={() => openAppInLearningHubRef.current?.()}
          aria-label={t('page.openInLearningHub')}
          title={t('page.openInLearningHub')}
        >
          <ArrowSquareOut size={20} />
        </DsButton>
      ),
    } : {
      titleNode: (
        <MobileBreadcrumb
          rootTitle={t('learningHub:title')}
          breadcrumbs={finderBreadcrumbs}
          onNavigate={handleFinderBreadcrumbNavigate}
        />
      ),
      showBackArrow: true,
      onMenuClick: () => setMobileResourcePanelOpen(false),
      // ★ 学习资源面板不再自带次顶栏：仅把「勾选文件」切换按钮放到全局顶栏右上角
      rightActions: (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => resourceMultiSelectToggleRef.current?.()}
          className={cn(
            '[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
            resourceMultiSelectActive
              && 'bg-primary/10 text-primary hover:bg-primary/15',
          )}
          aria-label={resourceMultiSelectActive
            ? t('learningHub:finder.canvas.exitMultiSelect')
            : t('learningHub:finder.canvas.multiSelect')}
          title={resourceMultiSelectActive
            ? t('learningHub:finder.canvas.exitMultiSelect')
            : t('learningHub:finder.canvas.multiSelect')}
        >
          <ListChecks size={20} />
        </DsButton>
      ),
    }
  ) : (groupEditorOpen && viewMode !== 'browser') ? {
    title: groupEditorMode === 'edit'
      ? t('page.editGroup')
      : t('page.createGroup'),
    showBackArrow: true,
    onMenuClick: closeGroupEditor,
    // ★ 子屏主操作上移全局顶栏：提交句柄由 GroupEditorPanel 挂载期间写入
    rightActions: (
      <DsButton
        variant="primary"
        className="[@media(pointer:coarse)]:!min-h-11"
        onClick={() => groupEditorSubmitRef.current?.()}
      >
        {t('common:save')}
      </DsButton>
    ),
  } : {
    title: isMinimalChatHeader ? undefined : headerTitle,
    titleNode: isMinimalChatHeader ? <></> : undefined,
    showMenu: viewMode !== 'browser',
    showBackArrow: viewMode === 'browser',
    onMenuClick: viewMode === 'browser'
      ? () => {
          setViewMode('sidebar');
          setSessionSheetOpen(true);
        }
      : () => setSessionSheetOpen(true),
    rightActions: viewMode === 'browser'
      ? browserNewChatAction
      : isMinimalChatHeader
        ? homepageNewChatAction
        : sessionNewChatAction,
  }, [
    currentSessionId, homepageNewChatAction, sessionNewChatAction, browserNewChatAction, headerTitle, mobileResourcePanelOpen, viewMode, isMinimalChatHeader,
    finderBreadcrumbs, handleFinderBreadcrumbNavigate, t,
    mobileSandboxOpen, closeMobileSandbox, openAppTitle, closeMobileOpenApp,
    sandboxOwnerKey, sandboxInspectorOpen, refreshSandboxSession, setSandboxInspectorOpen,
    groupEditorOpen, groupEditorMode, closeGroupEditor,
    setSessionSheetOpen,
    resourceMultiSelectActive, resourceMultiSelectToggleRef,
  ]);

  return {
    isEmptyNewChat,
    headerTitle,
  };
}
