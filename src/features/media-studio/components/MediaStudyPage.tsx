/**
 * 学习页：资源库同一个媒体视图（FileContentView → MediaStudyView：播放器 / 转写 / 字幕 /
 * 截帧 / 续播 / 引用跳转），经伴随 context 加上「讲义 / 问答 / 练习」分区。
 * 不复制任何播放 / 转写逻辑——这里只负责取节点、标题行与分区内容。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CircleNotch } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  TITLEBAR_ICON_CONTROL_CLASS,
  TITLEBAR_META_CLASS,
  TITLEBAR_TITLE_CLASS,
} from '@/app/shell/titlebarUiTokens';
import { dstu } from '@/dstu';
import type { DstuNode } from '@/dstu/types';
import FileContentView from '@/features/learning-hub/apps/views/FileContentView';
import { stripBilibiliExtension } from '@/features/learning-hub/apps/views/media/bilibiliLinkApi';
import {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  MediaStudyCompanionContext,
  type MediaStudyCompanionValue,
} from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';
import { MEDIA_STUDIO_FOCUS_SCOPE } from '../mediaStudioNavigation';
import { MediaAskTab, MediaHandoutTab, MediaPracticeTab, type MediaTabMeta } from './MediaStudyTabs';

export type MediaStudyTabId = typeof MEDIA_STUDY_TRANSCRIPT_TAB | 'handout' | 'ask' | 'practice';

export interface MediaStudyPageProps {
  resourceId: string;
  isActive: boolean;
  isSmallScreen: boolean;
  titlebarTarget: HTMLElement | null;
  onBack: () => void;
  /** 标题回调（手机顶栏 / 学习桌面窗口标题） */
  onTitleChange?: (title: string | null) => void;
}

function nodeMimeType(node: DstuNode): string | undefined {
  const meta = node.metadata as { mimeType?: unknown; mime_type?: unknown } | undefined;
  const value = meta?.mimeType ?? meta?.mime_type;
  return typeof value === 'string' && value ? value : undefined;
}

export const MediaStudyPage: React.FC<MediaStudyPageProps> = ({
  resourceId,
  isActive,
  isSmallScreen,
  titlebarTarget,
  onBack,
  onTitleChange,
}) => {
  const { t } = useTranslation(['mediaStudio', 'common']);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>(MEDIA_STUDY_TRANSCRIPT_TAB);

  useEffect(() => {
    let cancelled = false;
    setNode(null);
    setError(null);
    setActiveTab(MEDIA_STUDY_TRANSCRIPT_TAB);
    void dstu.get(`/${resourceId}`).then((result) => {
      if (cancelled) return;
      if (result.ok && result.value) setNode(result.value);
      else setError(result.ok ? t('mediaStudio:study.notFound') : result.error.toUserMessage());
    });
    return () => { cancelled = true; };
  }, [resourceId, t]);

  const displayName = node ? stripBilibiliExtension(node.name) : '';
  useEffect(() => {
    onTitleChange?.(displayName || null);
  }, [displayName, onTitleChange]);

  const meta = useMemo<MediaTabMeta>(() => ({
    name: node?.name ?? resourceId,
    mimeType: node ? nodeMimeType(node) : undefined,
    size: typeof node?.size === 'number' ? node.size : undefined,
  }), [node, resourceId]);

  const companion = useMemo<MediaStudyCompanionValue>(() => ({
    ariaLabel: t('mediaStudio:study.tabsAria'),
    activeTab,
    onActiveTabChange: setActiveTab,
    tabs: [
      {
        id: 'handout',
        label: t('mediaStudio:study.tab.handout'),
        render: (ctx) => <MediaHandoutTab ctx={ctx} visible={activeTab === 'handout'} />,
      },
      {
        id: 'ask',
        label: t('mediaStudio:study.tab.ask'),
        render: (ctx) => <MediaAskTab ctx={ctx} meta={meta} />,
      },
      {
        id: 'practice',
        label: t('mediaStudio:study.tab.practice'),
        render: (ctx) => <MediaPracticeTab ctx={ctx} meta={meta} visible={activeTab === 'practice'} />,
      },
    ],
  }), [activeTab, meta, t]);

  const headerRow = (inTitlebar: boolean) => (
    <div className={cn('flex min-w-0 items-center gap-2', inTitlebar && 'pointer-events-auto h-full flex-1')}>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onBack}
        aria-label={t('mediaStudio:study.back')}
        title={t('mediaStudio:study.back')}
        data-media-study-back=""
        className={cn('shrink-0 text-muted-foreground', inTitlebar ? TITLEBAR_ICON_CONTROL_CLASS : '!h-8 !w-8')}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </DsButton>
      <span className={cn(inTitlebar ? TITLEBAR_TITLE_CLASS : 'text-sm font-semibold text-foreground', 'shrink-0')}>
        {t('mediaStudio:title')}
      </span>
      <span className="text-muted-foreground/40">/</span>
      <span className={cn(inTitlebar ? TITLEBAR_META_CLASS : 'text-xs text-muted-foreground', 'min-w-0 truncate')}>
        {displayName}
      </span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-media-study={resourceId}>
      {titlebarTarget ? createPortal(
        <div className="pointer-events-none flex h-full min-w-0 items-center px-2">{headerRow(true)}</div>,
        titlebarTarget,
      ) : null}
      {!titlebarTarget && !isSmallScreen ? (
        <div className="study-shell-toolbar flex h-11 shrink-0 items-center px-3">{headerRow(false)}</div>
      ) : null}

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="study-shell-empty-state m-6" role="alert">
            <p className="study-shell-empty-state__title">{t('mediaStudio:study.loadFailed')}</p>
            <p className="study-shell-empty-state__description break-words">{error}</p>
            <DsButton variant="ghost" size="sm" className="mt-3" onClick={onBack}>
              {t('mediaStudio:study.back')}
            </DsButton>
          </div>
        ) : !node ? (
          <div className="flex h-full items-center justify-center text-muted-foreground" role="status" aria-label={t('common:loading')}>
            <CircleNotch size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          </div>
        ) : (
          <MediaStudyCompanionContext.Provider value={companion}>
            <FileContentView node={node} isActive={isActive} focusScopeId={MEDIA_STUDIO_FOCUS_SCOPE} />
          </MediaStudyCompanionContext.Provider>
        )}
      </div>
    </div>
  );
};

export default MediaStudyPage;
