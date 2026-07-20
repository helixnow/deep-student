import React, { useEffect, useMemo, useCallback } from 'react';
import { Plus } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { MobileBreadcrumb } from '@/features/learning-hub/components/MobileBreadcrumb';
import type { TFunction } from 'i18next';
import type { ChatSession } from '../types/session';
import type { BreadcrumbItem } from '@/features/learning-hub/stores/finderStore';

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
}

export function useChatPageLayout(deps: UseChatPageLayoutDeps) {
  const {
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, sessionSheetOpen, t, sessionCount, createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setViewMode,
    mobileSandboxOpen, closeMobileSandbox,
    openAppTitle, closeMobileOpenApp,
    groupEditorOpen, groupEditorMode, closeGroupEditor,
  } = deps;

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
      return `${t('browser.title')} (${sessionCount})`;
    }
    return currentSession?.title || t('page.newChat');
  }, [viewMode, currentSession?.title, t, sessionCount]);

  // 同步窗口标题栏
  useDocumentTitle(currentSession?.title);

  const headerRightActions = useMemo(() => {
    if (viewMode === 'browser') {
      return (
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
      );
    }
    // C-10 修复：移除"对话控制"幽灵按钮（其目标面板从未在抽屉中渲染）；
    // 对话参数控制已由输入栏的对话控制面板承载。
    return (
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={() => createSession()}
        disabled={isLoading || isEmptyNewChat}
        aria-label={t('page.newSession')}
        title={t('page.newSession')}
      >
        <Plus size={20} />
      </DsButton>
    );
  }, [viewMode, createSession, isLoading, isEmptyNewChat, setViewMode, t]);

  // 📱 移动端资源库面包屑导航回调
  const handleFinderBreadcrumbNavigate = useCallback((index: number) => {
    finderJumpToBreadcrumb(index);
  }, [finderJumpToBreadcrumb]);

  // 顶栏分支与移动端可见内容一一对应：
  // 右屏（沙箱 > 资源预览 > 资源库列表）→ 中屏子屏（Anki 卡片编辑 > 分组编辑器）→ 默认（浏览视图/聊天）
  useMobileHeader('chat-v2', mobileSandboxOpen ? {
    title: t('common:navigation.sandbox_workbench', '沙箱工作台'),
    showBackArrow: true,
    onMenuClick: closeMobileSandbox,
  } : mobileResourcePanelOpen ? (
    openAppTitle !== null ? {
      title: openAppTitle || t('common:untitled', '未命名'),
      showBackArrow: true,
      onMenuClick: closeMobileOpenApp,
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
    }
  ) : (groupEditorOpen && viewMode !== 'browser') ? {
    title: groupEditorMode === 'edit'
      ? t('page.editGroup', '编辑分组')
      : t('page.createGroup', '新建分组'),
    showBackArrow: true,
    onMenuClick: closeGroupEditor,
  } : {
    title: headerTitle,
    showMenu: viewMode !== 'browser',
    showBackArrow: viewMode === 'browser',
    onMenuClick: viewMode === 'browser'
      ? () => {
          setViewMode('sidebar');
          setSessionSheetOpen(true);
        }
      : sessionSheetOpen
        ? () => setSessionSheetOpen(false)
        : () => setSessionSheetOpen(true),
    rightActions: headerRightActions,
  }, [
    headerTitle, viewMode, headerRightActions, mobileResourcePanelOpen, sessionSheetOpen,
    finderBreadcrumbs, handleFinderBreadcrumbNavigate, t,
    mobileSandboxOpen, closeMobileSandbox, openAppTitle, closeMobileOpenApp,
    groupEditorOpen, groupEditorMode, closeGroupEditor,
  ]);

  return {
    isEmptyNewChat,
    headerTitle,
    headerRightActions,
  };
}
