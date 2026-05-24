import React, { useEffect, useMemo, useCallback } from 'react';
import { Plus, SlidersHorizontal } from '@phosphor-icons/react';
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
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
}

export function useChatPageLayout(deps: UseChatPageLayoutDeps) {
  const {
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, sessionSheetOpen, t, sessionCount, createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setShowChatControl, setViewMode,
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
    return (
      <>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => {
            setViewMode('sidebar');
            setShowChatControl(true);
            setSessionSheetOpen(true);
          }}
          aria-label={t('common:chat_controls')}
          title={t('common:chat_controls')}
        >
          <SlidersHorizontal size={20} />
        </NotionButton>
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
      </>
    );
  }, [viewMode, createSession, isLoading, isEmptyNewChat, setSessionSheetOpen, setShowChatControl, setViewMode, t]);

  // 📱 移动端资源库面包屑导航回调
  const handleFinderBreadcrumbNavigate = useCallback((index: number) => {
    finderJumpToBreadcrumb(index);
  }, [finderJumpToBreadcrumb]);

  useMobileHeader('chat-v2', mobileResourcePanelOpen ? {
    // 📱 资源库打开时：顶栏显示面包屑导航
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
