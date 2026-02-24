import React, { useEffect, useMemo, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMobileHeader } from '@/components/layout';
import { MobileBreadcrumb } from '@/components/learning-hub/components/MobileBreadcrumb';
import type { TFunction } from 'i18next';
import type { ChatSession } from '../types/session';
import type { BreadcrumbItem } from '@/components/learning-hub/stores/finderStore';

export interface UseChatPageLayoutDeps {
  currentSession: ChatSession | undefined;
  currentSessionId: string | null;
  expandGroup: (groupId: string) => void;
  currentSessionHasMessages: boolean;
  viewMode: 'sidebar' | 'browser';
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
    viewMode, t, sessionCount, createSession, isLoading,
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

  const headerRightActions = useMemo(() => {
    if (viewMode === 'browser') {
      return (
        <NotionButton
          variant="primary"
          size="icon"
          iconOnly
          onClick={() => createSession()}
          disabled={isLoading}
          aria-label={t('page.newSession')}
          title={t('page.newSession')}
        >
          <Plus className="w-5 h-5" />
        </NotionButton>
      );
    }
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
        <Plus className="w-5 h-5" />
      </NotionButton>
    );
  }, [viewMode, createSession, isLoading, isEmptyNewChat, t]);

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
  }, [headerTitle, viewMode, headerRightActions, mobileResourcePanelOpen, finderBreadcrumbs, handleFinderBreadcrumbNavigate, t]);

  return {
    isEmptyNewChat,
    headerTitle,
    headerRightActions,
  };
}
