import React, { useEffect, useMemo, useCallback } from 'react';
import { Plus } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
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
}

export function useChatPageLayout(deps: UseChatPageLayoutDeps) {
  const {
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, sessionSheetOpen, t, sessionCount, createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setViewMode,
  } = deps;

  useEffect(() => {
    if (!currentSession) return;
    const groupId = currentSession.groupId || 'ungrouped';
    expandGroup(groupId);
  }, [currentSessionId, currentSession?.groupId, expandGroup]);

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
        <NotionButton
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
        </NotionButton>
      );
    }
    // C-10 修复：移除"对话控制"幽灵按钮（其目标面板从未在抽屉中渲染）；
    // 对话参数控制已由输入栏的对话控制面板承载。
    return (
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={() => createSession()}
        disabled={isLoading || isEmptyNewChat}
        aria-label={t('page.newSession')}
        title={t('page.newSession')}
      >
        <Plus size={20} />
      </NotionButton>
    );
  }, [viewMode, createSession, isLoading, isEmptyNewChat, setViewMode, t]);

  // 📱 移动端资源库面包屑导航回调
  const handleFinderBreadcrumbNavigate = useCallback((index: number) => {
    finderJumpToBreadcrumb(index);
  }, [finderJumpToBreadcrumb]);

  useMobileHeader('chat-v2', mobileResourcePanelOpen ? {
    titleNode: (
      <MobileBreadcrumb
        rootTitle={t('learningHub:title')}
        breadcrumbs={finderBreadcrumbs}
        onNavigate={handleFinderBreadcrumbNavigate}
      />
    ),
    showBackArrow: true,
    onMenuClick: () => setMobileResourcePanelOpen(false),
  } : {
    hidden: sessionSheetOpen,
    title: headerTitle,
    showMenu: viewMode !== 'browser',
    showBackArrow: viewMode === 'browser',
    onMenuClick: viewMode === 'browser'
      ? () => {
          setViewMode('sidebar');
          setSessionSheetOpen(true);
        }
      : () => setSessionSheetOpen(prev => !prev),
    rightActions: headerRightActions,
  }, [headerTitle, viewMode, headerRightActions, mobileResourcePanelOpen, sessionSheetOpen, finderBreadcrumbs, handleFinderBreadcrumbNavigate, t]);

  return {
    isEmptyNewChat,
    headerTitle,
    headerRightActions,
  };
}
