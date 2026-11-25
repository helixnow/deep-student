/**
 * 学习页：资源库同一个媒体视图（FileContentView → MediaStudyView：播放器 / 转写 / 字幕 /
 * 截帧 / 续播 / 引用跳转），经伴随 context 加上「讲义 / 问答 / 练习」分区。
 * 不复制任何播放 / 转写逻辑——这里只负责取节点、标题行与分区内容。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CircleNotch, SpeakerHigh } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
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
import './MediaStudyPage.css';

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
  const [mutedAutoplayNotice, setMutedAutoplayNotice] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const studyContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNode(null);
    setError(null);
    setActiveTab(MEDIA_STUDY_TRANSCRIPT_TAB);
    setMutedAutoplayNotice(false);
    setPlaybackError(null);
    void dstu.get(`/${resourceId}`).then((result) => {
      if (cancelled) return;
      if (result.ok && result.value) setNode(result.value);
      else setError(result.ok ? t('mediaStudio:study.notFound') : result.error.toUserMessage());
    });
    return () => { cancelled = true; };
  }, [resourceId, t]);

  useEffect(() => {
    const container = studyContainerRef.current;
    if (!container || !node) return;
    const guarded = new WeakSet<HTMLMediaElement>();
    const cleanups: Array<() => void> = [];

    const attachGuard = (el: HTMLMediaElement) => {
      if (guarded.has(el)) return;
      guarded.add(el);
      const rawPlay = el.play.bind(el);
      el.play = () => {
        setPlaybackError(null);
        let playPromise: Promise<void>;
        try {
          playPromise = rawPlay();
        } catch (err) {
          const errName = (err as DOMException | null)?.name;
          if (errName === 'NotAllowedError' && !el.muted) {
            el.muted = true;
            setMutedAutoplayNotice(true);
            try {
              return rawPlay();
            } catch (mutedErr) {
              setPlaybackError(getErrorMessage(mutedErr));
              return Promise.reject(mutedErr);
            }
          }
          if (errName !== 'AbortError') {
            setPlaybackError(getErrorMessage(err));
          }
          return Promise.reject(err);
        }
        if (!playPromise || typeof playPromise.then !== 'function') {
          return playPromise;
        }
        return playPromise.catch((err: unknown) => {
          const errName = (err as DOMException | null)?.name;
          if (errName === 'NotAllowedError' && !el.muted) {
            el.muted = true;
            setMutedAutoplayNotice(true);
            return rawPlay().catch((mutedErr: unknown) => {
              if ((mutedErr as DOMException | null)?.name !== 'AbortError') {
                setPlaybackError(getErrorMessage(mutedErr));
              }
              throw mutedErr;
            });
          }
          if (errName !== 'AbortError') {
            setPlaybackError(getErrorMessage(err));
          }
          throw err;
        });
      };

      const onPlaying = () => setPlaybackError(null);
      const onVolumeChange = () => {
        if (!el.muted) setMutedAutoplayNotice(false);
      };
      const onMediaError = () => {
        const mediaErrMsg =
          el.error?.message?.trim() ||
          t('mediaStudio:study.loadFailed', { defaultValue: '无法打开这个音视频' });
        setPlaybackError(mediaErrMsg);
      };
      el.addEventListener('playing', onPlaying);
      el.addEventListener('volumechange', onVolumeChange);
      el.addEventListener('error', onMediaError);
      cleanups.push(() => {
        el.removeEventListener('playing', onPlaying);
        el.removeEventListener('volumechange', onVolumeChange);
        el.removeEventListener('error', onMediaError);
      });
    };

    const scan = () => {
      container.querySelectorAll('video, audio').forEach((media) => {
        if (media instanceof HTMLMediaElement) attachGuard(media);
      });
    };
    scan();

    // Mobile 360px fallback: if preload="metadata" has not completed before user taps a disabled Play button,
    // initiate playback directly so a user tap is never a silent dead click.
    const handlePreMetadataPlayClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest('button');
      if (!btn || !btn.hasAttribute('disabled')) return;
      const aria = `${btn.getAttribute('aria-label') ?? ''} ${btn.getAttribute('title') ?? ''}`;
      if (!/播放|play/i.test(aria)) return;
      const media = container.querySelector('video, audio');
      if (media instanceof HTMLMediaElement && media.paused) {
        event.stopPropagation();
        void media.play().catch(() => undefined);
      }
    };
    container.addEventListener('click', handlePreMetadataPlayClick, true);

    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => scan())
        : null;
    observer?.observe(container, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      container.removeEventListener('click', handlePreMetadataPlayClick, true);
      for (const cleanup of cleanups) cleanup();
    };
  }, [node, resourceId, t]);

  const handleUnmute = useCallback(() => {
    const media = studyContainerRef.current?.querySelector('video, audio');
    if (media instanceof HTMLMediaElement) {
      media.muted = false;
    }
    setMutedAutoplayNotice(false);
  }, []);

  const handleRetryPlay = useCallback(() => {
    const media = studyContainerRef.current?.querySelector('video, audio');
    if (media instanceof HTMLMediaElement) {
      void media.play().catch(() => undefined);
    }
  }, []);

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
        render: (ctx) => <MediaAskTab ctx={ctx} meta={meta} visible={activeTab === 'ask'} />,
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
    <div ref={studyContainerRef} className="flex h-full min-h-0 min-w-0 flex-col" data-media-study={resourceId}>
      {titlebarTarget ? createPortal(
        <div className="pointer-events-none flex h-full min-w-0 items-center px-2">{headerRow(true)}</div>,
        titlebarTarget,
      ) : null}
      {!titlebarTarget && !isSmallScreen ? (
        <div className="study-shell-toolbar flex h-11 shrink-0 items-center px-3">{headerRow(false)}</div>
      ) : null}
      {mutedAutoplayNotice ? (
        <div
          role="status"
          data-testid="media-muted-autoplay-banner"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border/35 bg-muted/40 px-3 py-1.5 text-xs text-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('mediaStudio:study.mutedAutoplay', {
              defaultValue: '浏览器限制非静音自动播放，已切换为静音播放',
            })}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleUnmute}
            className="!h-auto gap-1 !px-2 !py-0.5 text-xs font-medium text-primary [@media(pointer:coarse)]:!min-h-11"
          >
            <SpeakerHigh size={13} aria-hidden="true" />
            <span>{t('mediaStudio:study.unmute', { defaultValue: '取消静音' })}</span>
          </DsButton>
        </div>
      ) : null}
      {playbackError ? (
        <div
          role="alert"
          data-testid="media-playback-error-banner"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">
            {t('mediaStudio:study.playbackFailed', {
              message: playbackError,
              defaultValue: '播放失败：{{message}}',
            })}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleRetryPlay}
            className="!h-auto shrink-0 !px-2 !py-0.5 text-xs font-medium !text-destructive hover:!bg-destructive/15 [@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:retry', { defaultValue: '重试' })}
          </DsButton>
        </div>
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
