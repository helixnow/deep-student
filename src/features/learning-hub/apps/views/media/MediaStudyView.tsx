/**
 * MediaStudyView — 音视频预览 + 转写 / 字幕 / 时间戳跳转 / 断点续播 / 帧引用
 *
 * 契约：docs/dev/media-learning/README.md §1.3 / §2。不新增页面：挂在
 * FileContentView 的音视频分支里，学习资源页标签、聊天右侧面板、工作台 file
 * 窗共用。
 *
 * 布局：容器宽 ≥ SIDE_LAYOUT_MIN_WIDTH 时字幕面板在右侧；否则（手机 / 窄面板）
 * 在播放器下方。顶部一条工具栏放转写入口与字幕操作。
 *
 * 音视频子应用（学习页）经 MediaStudyCompanionContext 注入讲义 / 问答 / 练习分区：
 * 字幕面板变为「字幕 / 讲义 / 问答 / 练习」分段面板（始终可见），讲义入口移入讲义分区；
 * 资源库与聊天右侧面板无 context，工具栏多一个「在音视频中学习」跳转。
 *
 * B 站链接条目（`bilibili` 非空）：默认在应用自己的播放器里播放 `bilistream://`（后端取 B 站
 * MP4 地址并转发 Range 请求），截帧 / 字幕轨 / 播放进度与本地视频一样可用；直接播放出错时
 * 退回 B 站外链播放器（iframe，不能截帧、不记进度）。没有本地音频文件，所以不能转写，
 * 字幕从 B 站重新获取。应用内播放可切换清晰度（后端按登录身份取可用档位，控制条上的菜单），
 * 切换时保持播放位置与播放 / 暂停；外链播放器拿不到应用里的登录，始终按游客播放。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  ClosedCaptioning,
  DotsThree,
  FileArrowDown,
  FileArrowUp,
  Subtitles,
  Waveform,
  X,
  CircleNotch,
  ArrowClockwise,
  ArrowSquareOut,
  ArrowUpRight,
  Television,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { fileManager } from '@/utils/fileManager';
import { useReferenceToChat } from '@/features/learning-hub/useReferenceToChat';
import { uploadAttachmentBlob } from '@/features/chat/context/vfsRefApi';
import { openUrl } from '@/utils/urlOpener';
import { AudioPlayer } from './AudioPlayer';
import { VideoPlayer } from './VideoPlayer';
import { BilibiliEmbedPlayer } from './BilibiliEmbedPlayer';
import { BilibiliLinkDialog, type BilibiliLinkDialogMode } from './BilibiliLinkDialog';
import { buildBilibiliPageUrl, type BilibiliLinkDescriptor } from './bilibiliLinkApi';
import { shortQualityLabel } from './bilibiliAccount';
import { useBilibiliQuality } from './useBilibiliQuality';
import type { MediaPlayerHandle, MediaPlayerStatus } from './mediaPlayerHandle';
import type { TranscriptExportFormat, TranscriptSegment } from './mediaTranscriptApi';
import { useMediaTranscript } from './useMediaTranscript';
import { useTranscriptTrack } from './useTranscriptTrack';
import { useMediaProgressSync } from './useMediaProgressSync';
import { matchesMediaFocusTarget, useMediaFocusListener } from './useMediaFocusListener';
import { rememberPendingMediaFocus, takePendingMediaFocus } from './mediaRefEvents';
import { TranscriptPanel, selectDisplaySegments } from './TranscriptPanel';
import { findActiveSegmentIndex } from './transcriptVtt';
import { HandoutGenerateButton } from '@/features/media-handout';
import { formatMediaRefTimestamp } from './mediaRefTime';
import { captureVideoFrame, CaptureFrameError, frameFileName } from './captureVideoFrame';
import {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  useMediaStudyCompanion,
  type MediaStudyCompanionRenderContext,
} from './mediaStudyCompanion';
import { openMediaStudio } from '@/features/media-studio/mediaStudioNavigation';

/** 字幕面板放到右侧所需的最小容器宽度 */
export const SIDE_LAYOUT_MIN_WIDTH = 720;

const toolbarButtonClass =
  'h-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!min-w-11';

export interface MediaStudyViewProps {
  kind: 'audio' | 'video';
  src: string;
  /** VFS File 资源 ID（file_*），转写 / 进度命令的 resource_id */
  resourceId: string;
  sourceId?: string;
  nodePath?: string;
  fileName: string;
  meta?: string;
  compatibilityHint?: string;
  isActive?: boolean;
  focusScopeId?: string;
  onError: () => void;
  /** B 站链接条目的描述；非空时用内嵌播放器 */
  bilibili?: BilibiliLinkDescriptor | null;
}

function useContainerWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number') setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export const MediaStudyView: React.FC<MediaStudyViewProps> = ({
  kind,
  src,
  resourceId,
  sourceId,
  nodePath,
  fileName,
  meta,
  compatibilityHint,
  isActive = true,
  focusScopeId,
  onError,
  bilibili = null,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MediaPlayerHandle | null>(null);
  const containerWidth = useContainerWidth(rootRef);
  const sideLayout = containerWidth >= SIDE_LAYOUT_MIN_WIDTH;
  const isVideo = kind === 'video';
  const isLink = bilibili !== null;
  /** 链接条目直接播放出错后退回 B 站外链播放器（换条目时重置） */
  const [linkEmbed, setLinkEmbed] = useState(false);
  /** 外链播放器是播放出错自动退回的（提示语不同） */
  const [embedFallback, setEmbedFallback] = useState(false);
  useEffect(() => {
    setLinkEmbed(false);
    setEmbedFallback(false);
  }, [resourceId]);
  /** 外链 iframe 播放：拿不到画面与进度 */
  const embedPlayback = isLink && linkEmbed;
  const bilibiliQuality = useBilibiliQuality(isLink ? resourceId : null);
  const playerSrc = isLink ? (bilibiliQuality.streamUrl ?? src) : src;
  /** 讲义 / 伴随分区按此取帧：外链播放器没有可抽帧的画面 */
  const contentKind = embedPlayback ? 'audio' : kind;
  const companion = useMediaStudyCompanion();

  // ---------------------------------------------------------------- 转写
  const transcriptState = useMediaTranscript({
    resourceId,
    aliasIds: [sourceId],
  });
  const { transcript, estimate, estimating, starting, cancelling } = transcriptState;
  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
  const status = transcript?.status ?? 'none';
  const running = status === 'running' || status === 'queued';
  const displaySegments = useMemo(() => selectDisplaySegments(segments), [segments]);
  const hasTranscript = displaySegments.length > 0;
  const hasDoneSegments = useMemo(() => segments.some((s) => s.status === 'done'), [segments]);

  const [panelPref, setPanelPref] = useState<boolean | null>(null);
  // 子应用分段面板始终可用（无字幕时字幕分区给出转写 / 导入入口）；手机布局下不可收起
  const panelOpen = companion
    ? (panelPref ?? true) || !sideLayout
    : (panelPref ?? true) && (hasTranscript || running);

  // ---------------------------------------------------------------- 字幕轨（视频）
  const { trackSrc, trackRef, captionsOn, toggleCaptions } = useTranscriptTrack(segments, isVideo && !embedPlayback);

  // ---------------------------------------------------------------- 播放状态 / 跟随高亮
  const [isReady, setIsReady] = useState(false);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(-1);
  const segmentsForActiveRef = useRef(displaySegments);
  segmentsForActiveRef.current = displaySegments;
  const lastTimeRef = useRef(0);
  const lastPlayingRef = useRef(false);

  // 同一条目换播放地址（切清晰度 / 登录换代）：播放器按新地址重建，记下位置与播放状态，
  // 新播放器就绪后恢复。必须在渲染期记录——新播放器挂载时会先回报 0 秒覆盖 lastTimeRef。
  const pendingRestoreRef = useRef<{ time: number; play: boolean; armed: boolean } | null>(null);
  const prevPlayerRef = useRef({ resourceId, src: playerSrc });
  if (prevPlayerRef.current.src !== playerSrc) {
    pendingRestoreRef.current =
      prevPlayerRef.current.resourceId === resourceId && lastTimeRef.current > 0
        ? { time: lastTimeRef.current, play: lastPlayingRef.current, armed: false }
        : null;
    prevPlayerRef.current = { resourceId, src: playerSrc };
  }

  const externalSeekRef = useRef(false);
  const { onStatus: onProgressStatus, resumedFromRef } = useMediaProgressSync({
    resourceId,
    enabled: !embedPlayback,
    handleRef,
    hasExternalSeek: () => externalSeekRef.current,
  });

  const recomputeActive = useCallback((timeSec: number) => {
    const list = segmentsForActiveRef.current;
    const i = findActiveSegmentIndex(list, timeSec * 1000);
    const seg = i >= 0 ? list[i] : null;
    // 落在段间空白超过 3s 时不高亮上一段
    const idx = seg && timeSec * 1000 <= seg.endMs + 3000 ? seg.idx : -1;
    setActiveSegmentIdx((prev) => (prev === idx ? prev : idx));
  }, []);

  const handleStatusChange = useCallback(
    (s: MediaPlayerStatus) => {
      const restore = pendingRestoreRef.current;
      if (restore) {
        // 旧播放器卸载前可能还会回报一次就绪状态：等新播放器先回报「未就绪」再恢复
        if (!s.isReady) restore.armed = true;
        else if (restore.armed) {
          pendingRestoreRef.current = null;
          const handle = handleRef.current;
          if (handle) {
            handle.seekTo(restore.time);
            if (restore.play) handle.play();
          }
          lastTimeRef.current = restore.time;
          lastPlayingRef.current = restore.play;
          setIsReady(true);
          return;
        }
        // 恢复前不让新播放器的 0 秒覆盖进度与跟随高亮
        if (!s.isReady) {
          setIsReady(false);
          return;
        }
      }
      lastTimeRef.current = s.currentTime;
      lastPlayingRef.current = s.isPlaying;
      setIsReady((prev) => (prev === s.isReady ? prev : s.isReady));
      recomputeActive(s.currentTime);
      onProgressStatus(s);
    },
    [recomputeActive, onProgressStatus],
  );

  useEffect(() => {
    recomputeActive(lastTimeRef.current);
  }, [displaySegments, recomputeActive]);

  const seekToSegment = useCallback((seg: TranscriptSegment) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.seekTo(seg.startMs / 1000);
    handle.play();
  }, []);

  // ---------------------------------------------------------------- 引用跳转（media-ref:focus）
  // 只有可见（活跃）实例响应：学习资源页保活的隐藏标签不能抢走跳转并在后台出声；
  // 派发方带回执重发，目标标签激活后自然命中
  const [focusRequest, handleFocusHandled] = useMediaFocusListener({
    enabled: isActive,
    focusScopeId,
    nodeId: resourceId,
    nodeSourceId: sourceId,
    nodePath,
  });

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.isStale?.()) {
      handleFocusHandled(focusRequest.requestId, false);
      return;
    }
    const handle = handleRef.current;
    if (!handle || !isReady) return; // 就绪后 effect 重跑
    externalSeekRef.current = true;
    handle.seekTo(focusRequest.seconds);
    if (focusRequest.play) handle.play();
    // 回执路径已兑现：丢弃本资源的待兑现意图，避免就绪兜底再 seek 一次
    takePendingMediaFocus((id) =>
      matchesMediaFocusTarget(id, { nodeId: resourceId, nodeSourceId: sourceId, nodePath }),
    );
    handleFocusHandled(focusRequest.requestId, true);
  }, [focusRequest, isReady, handleFocusHandled, resourceId, sourceId, nodePath]);

  // 冷启动兜底：引用点击后视图晚于重发 / 回执窗口才就绪时，领取待兑现的跳转意图
  useEffect(() => {
    if (!isActive || !isReady) return;
    const handle = handleRef.current;
    if (!handle) return;
    const seconds = takePendingMediaFocus((id) =>
      matchesMediaFocusTarget(id, { nodeId: resourceId, nodeSourceId: sourceId, nodePath }),
    );
    if (seconds === null) return;
    externalSeekRef.current = true;
    handle.seekTo(seconds);
    handle.play();
  }, [isActive, isReady, resourceId, sourceId, nodePath]);

  // 断点续播提示（一次性）
  const resumeToastShownRef = useRef(false);
  useEffect(() => {
    if (!isReady || resumeToastShownRef.current) return;
    const timer = window.setTimeout(() => {
      const from = resumedFromRef.current;
      if (from !== null && !resumeToastShownRef.current) {
        resumeToastShownRef.current = true;
        showGlobalNotification(
          'info',
          t('learningHub:mediaTranscript.resumed', { time: formatMediaRefTimestamp(from) }),
        );
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [isReady, resumedFromRef, t]);

  // ---------------------------------------------------------------- 转写动作
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleTranscribeClick = useCallback(async () => {
    const result = await transcriptState.requestEstimate();
    if (result.ok) {
      setConfirmOpen(true);
    } else {
      showGlobalNotification('error', result.error ?? '', t('learningHub:mediaTranscript.estimateFailed'));
    }
  }, [transcriptState, t]);

  const handleConfirmStart = useCallback(async () => {
    const result = await transcriptState.start();
    setConfirmOpen(false);
    if (result.ok) {
      setPanelPref(true);
    } else {
      showGlobalNotification('error', result.error ?? '', t('learningHub:mediaTranscript.startFailed'));
    }
  }, [transcriptState, t]);

  /** 重试失败段：已有计划与费用确认过，直接续做（后端跳过已完成段） */
  const handleRetry = useCallback(async () => {
    const result = await transcriptState.start();
    if (!result.ok) {
      showGlobalNotification('error', result.error ?? '', t('learningHub:mediaTranscript.startFailed'));
    }
  }, [transcriptState, t]);

  const handleCancel = useCallback(() => {
    void transcriptState.cancel();
  }, [transcriptState]);

  const handleImport = useCallback(async () => {
    try {
      const path = await fileManager.pickSingleFile({
        filters: [
          {
            name: t('learningHub:mediaTranscript.importFilterName'),
            extensions: ['srt', 'vtt', 'json'],
          },
        ],
      });
      if (!path) return;
      const count = await transcriptState.importFromPath(path);
      setPanelPref(true);
      showGlobalNotification('success', t('learningHub:mediaTranscript.importSuccess', { count }));
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaTranscript.importFailed'));
    }
  }, [transcriptState, t]);

  // ---------------------------------------------------------------- B 站字幕 / 在 B 站打开
  const [bilibiliDialogOpen, setBilibiliDialogOpen] = useState(false);
  const bilibiliDialogMode = useMemo<BilibiliLinkDialogMode>(
    () =>
      bilibili
        ? { kind: 'refetch', resourceId, name: fileName, url: bilibili.url, page: bilibili.page }
        : { kind: 'attach', resourceId, name: fileName },
    [bilibili, resourceId, fileName],
  );
  const handleBilibiliDone = useCallback(
    (result: { segments: number }) => {
      void transcriptState.refresh();
      setPanelPref(true);
      showGlobalNotification('success', t('learningHub:mediaBilibili.attached', { count: result.segments }));
    },
    [transcriptState, t],
  );
  const handleOpenOnBilibili = useCallback(() => {
    if (!bilibili) return;
    void openUrl(buildBilibiliPageUrl(bilibili, lastTimeRef.current));
  }, [bilibili]);

  const handleExport = useCallback(
    async (format: TranscriptExportFormat) => {
      try {
        const base = fileName.replace(/\.[^.]+$/, '') || 'transcript';
        const dest = await fileManager.pickSavePath({
          defaultFileName: `${base}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!dest) return;
        await transcriptState.exportToPath(format, dest);
        showGlobalNotification('success', t('learningHub:mediaTranscript.exportSuccess'));
      } catch (err: unknown) {
        showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaTranscript.exportFailed'));
      }
    },
    [fileName, transcriptState, t],
  );

  // ---------------------------------------------------------------- 截帧 → 引用到聊天
  const { referenceToChat } = useReferenceToChat();
  const [capturing, setCapturing] = useState(false);
  const handleCaptureFrame = useCallback(async () => {
    const el = handleRef.current?.getElement();
    if (!(el instanceof HTMLVideoElement)) return;
    setCapturing(true);
    try {
      const timestamp = formatMediaRefTimestamp(el.currentTime);
      const blob = await captureVideoFrame(el);
      const name = frameFileName(fileName, timestamp);
      const uploaded = await uploadAttachmentBlob(blob, {
        name,
        mimeType: 'image/png',
        type: 'image',
      });
      await referenceToChat({
        sourceType: 'image',
        sourceId: uploaded.sourceId,
        metadata: {
          title: t('learningHub:mediaTranscript.frameTitle', { name: fileName, time: timestamp }),
          mimeType: 'image/png',
          size: blob.size,
          mediaResourceId: resourceId,
          mediaSeconds: Math.floor(el.currentTime),
        },
      });
    } catch (err: unknown) {
      const code = err instanceof CaptureFrameError ? err.code : null;
      const message =
        code === 'not_ready'
          ? t('learningHub:mediaTranscript.captureNotReady')
          : code === 'tainted'
            ? t('learningHub:mediaTranscript.captureTainted')
            : getErrorMessage(err);
      showGlobalNotification('error', message, t('learningHub:mediaTranscript.captureFailed'));
    } finally {
      setCapturing(false);
    }
  }, [fileName, referenceToChat, resourceId, t]);

  // ---------------------------------------------------------------- 在音视频中学习
  // 交接：本视图暂停（保活的资源库标签不能和学习页同时出声）；正在播放时把当前位置作为
  // 待兑现跳转交给学习页，接着从同一秒继续播放
  const handleOpenInStudio = useCallback(() => {
    const handle = handleRef.current;
    const el = handle?.getElement();
    if (el && !el.paused) rememberPendingMediaFocus(resourceId, Math.floor(el.currentTime));
    handle?.pause();
    openMediaStudio(resourceId);
  }, [resourceId]);

  // ---------------------------------------------------------------- 伴随面板（音视频子应用）
  const seekToSeconds = useCallback((seconds: number) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.seekTo(seconds);
    handle.play();
  }, []);
  const doneSegments = useMemo(() => segments.filter((s) => s.status === 'done').length, [segments]);
  const companionRenderContext = useMemo<MediaStudyCompanionRenderContext>(
    () => ({
      resourceId,
      kind: contentKind,
      src: playerSrc,
      fileName,
      transcriptStatus: status,
      hasTranscript: hasDoneSegments && !running,
      doneSegments,
      totalSegments: transcript?.progress?.totalSegments || segments.length,
      seekTo: seekToSeconds,
    }),
    [resourceId, contentKind, playerSrc, fileName, status, hasDoneSegments, running, doneSegments, transcript, segments.length, seekToSeconds],
  );

  // ---------------------------------------------------------------- 渲染
  const transcribeLabel =
    status === 'partial'
      ? t('learningHub:mediaTranscript.retryFailed')
      : status === 'failed'
        ? t('learningHub:mediaTranscript.retry')
        : t('learningHub:mediaTranscript.transcribe');
  const showTranscribeButton = !isLink && !running && status !== 'completed';
  const progress = transcript?.progress ?? null;

  const captionsButton =
    isVideo && trackSrc ? (
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={
          captionsOn
            ? t('learningHub:mediaTranscript.captionsOff')
            : t('learningHub:mediaTranscript.captionsOn')
        }
        aria-pressed={captionsOn}
        title={
          captionsOn
            ? t('learningHub:mediaTranscript.captionsOff')
            : t('learningHub:mediaTranscript.captionsOn')
        }
        onClick={toggleCaptions}
        className={cn(
          'h-8 w-8 text-white hover:bg-[var(--overlay-control-hover)] hover:text-white [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
          captionsOn && 'bg-[var(--overlay-control-hover)]',
        )}
      >
        <ClosedCaptioning size={16} weight={captionsOn ? 'fill' : 'regular'} aria-hidden="true" />
      </DsButton>
    ) : null;

  const handleLinkStreamError = useCallback(() => {
    setLinkEmbed(true);
    setEmbedFallback(true);
  }, []);

  // ---------------------------------------------------------------- 清晰度（应用内播放）
  const { info: qualityInfo, select: selectQuality } = bilibiliQuality;
  /** 用户刚选的档位：B 站降档时提示一次实际清晰度 */
  const chosenQnRef = useRef<number | null>(null);
  const handleQualityChange = useCallback(
    (qn: number) => {
      chosenQnRef.current = qn;
      selectQuality(qn);
    },
    [selectQuality],
  );
  useEffect(() => {
    const chosen = chosenQnRef.current;
    if (chosen === null || !qualityInfo || qualityInfo.requested !== chosen) return;
    chosenQnRef.current = null;
    if (qualityInfo.current < chosen) {
      const actual = qualityInfo.options.find((o) => o.qn === qualityInfo.current);
      showGlobalNotification(
        'info',
        t('learningHub:mediaBilibili.playback.qualityDowngraded', {
          quality: actual ? shortQualityLabel(actual) : String(qualityInfo.current),
        }),
      );
    }
  }, [qualityInfo, t]);
  const videoQuality = useMemo(
    () =>
      isLink && qualityInfo && qualityInfo.options.length > 0
        ? {
            options: qualityInfo.options.map((o) => ({ value: o.qn, label: shortQualityLabel(o) })),
            value: qualityInfo.current,
            onChange: handleQualityChange,
          }
        : null,
    [isLink, qualityInfo, handleQualityChange],
  );

  const player = bilibili && linkEmbed ? (
    <BilibiliEmbedPlayer
      link={bilibili}
      isActive={isActive}
      handleRef={handleRef}
      onStatusChange={handleStatusChange}
    />
  ) : isVideo ? (
    <VideoPlayer
      key={playerSrc}
      src={playerSrc}
      fileName={fileName}
      compatibilityHint={compatibilityHint}
      isActive={isActive}
      onError={isLink ? handleLinkStreamError : onError}
      handleRef={handleRef}
      onStatusChange={handleStatusChange}
      crossOrigin="anonymous"
      extraControls={captionsButton}
      quality={videoQuality}
      trackSlot={
        trackSrc ? (
          <track
            ref={trackRef}
            kind="subtitles"
            label={t('learningHub:mediaTranscript.trackLabel')}
            src={trackSrc}
          />
        ) : null
      }
    />
  ) : (
    <AudioPlayer
      key={src}
      src={src}
      fileName={fileName}
      meta={meta}
      compatibilityHint={compatibilityHint}
      isActive={isActive}
      onError={onError}
      handleRef={handleRef}
      onStatusChange={handleStatusChange}
      compact={panelOpen && !sideLayout}
    />
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* 工具栏：转写入口 / 进度 / 字幕操作 / 截帧 */}
      <div
        role="toolbar"
        aria-label={t('learningHub:mediaTranscript.toolbarLabel')}
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 [@media(pointer:coarse)]:h-14"
      >
        {showTranscribeButton && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => {
              if (status === 'partial' || status === 'failed') void handleRetry();
              else void handleTranscribeClick();
            }}
            disabled={estimating || starting || transcriptState.loading}
            className={cn(toolbarButtonClass, 'gap-1.5 px-2.5 text-xs')}
          >
            {estimating || starting ? (
              <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : status === 'partial' || status === 'failed' ? (
              <ArrowClockwise size={14} aria-hidden="true" />
            ) : (
              <Waveform size={14} aria-hidden="true" />
            )}
            {transcribeLabel}
          </DsButton>
        )}

        {running && (
          <div className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
            <CircleNotch size={14} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            <span className="truncate">
              {status === 'queued'
                ? t('learningHub:mediaTranscript.queued')
                : t('learningHub:mediaTranscript.running')}
            </span>
            {progress && progress.totalSegments > 0 && (
              <span className="shrink-0 tabular-nums">
                {t('learningHub:mediaTranscript.progressCount', {
                  completed: progress.completedSegments,
                  total: progress.totalSegments,
                })}
              </span>
            )}
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={handleCancel}
              disabled={cancelling}
              aria-label={t('learningHub:mediaTranscript.cancel')}
              title={t('learningHub:mediaTranscript.cancel')}
              className="h-7 w-7 shrink-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            >
              <X size={13} aria-hidden="true" />
            </DsButton>
          </div>
        )}

        <div className="flex-1" />

        {/* 讲义：字幕 → 抽帧/帧说明 → 大纲 → 分节 → 落为笔记（docs/dev/media-learning §3） */}
        {!companion && (
          <HandoutGenerateButton
            resourceId={resourceId}
            kind={contentKind}
            src={src}
            fileName={fileName}
            hasTranscript={hasDoneSegments && !running}
          />
        )}

        {isLink && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleOpenOnBilibili}
            aria-label={t('learningHub:mediaBilibili.openOnBilibili')}
            title={t('learningHub:mediaBilibili.openOnBilibili')}
            className={cn(toolbarButtonClass, 'gap-1.5 px-2.5 text-xs')}
            data-bilibili-open=""
          >
            <ArrowUpRight size={14} aria-hidden="true" />
            <span className="max-sm:hidden">{t('learningHub:mediaBilibili.openOnBilibili')}</span>
          </DsButton>
        )}

        {isLink && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setEmbedFallback(false);
              setLinkEmbed((prev) => !prev);
            }}
            className={cn(toolbarButtonClass, 'gap-1.5 px-2.5 text-xs')}
            data-bilibili-playback={linkEmbed ? 'embed' : 'stream'}
          >
            <span>{linkEmbed ? t('learningHub:mediaBilibili.playback.retry') : t('learningHub:mediaBilibili.playback.useEmbed')}</span>
          </DsButton>
        )}

        {isVideo && !embedPlayback && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => void handleCaptureFrame()}
            disabled={!isReady || capturing}
            aria-label={t('learningHub:mediaTranscript.captureFrame')}
            title={t('learningHub:mediaTranscript.captureFrame')}
            className={cn(toolbarButtonClass, 'gap-1.5 px-2.5 text-xs')}
          >
            {capturing ? (
              <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Camera size={14} aria-hidden="true" />
            )}
            <span className="max-sm:hidden">{t('learningHub:mediaTranscript.captureFrameShort')}</span>
          </DsButton>
        )}

        {(companion ? sideLayout : hasTranscript || running) && (
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => setPanelPref(!panelOpen)}
            aria-pressed={panelOpen}
            aria-label={
              panelOpen
                ? t('learningHub:mediaTranscript.hidePanel')
                : t('learningHub:mediaTranscript.showPanel')
            }
            title={
              panelOpen
                ? t('learningHub:mediaTranscript.hidePanel')
                : t('learningHub:mediaTranscript.showPanel')
            }
            className={cn(
              'h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
              panelOpen && 'bg-[var(--interactive-hover)] text-primary',
            )}
          >
            <Subtitles size={16} aria-hidden="true" />
          </DsButton>
        )}

        {!companion && (
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleOpenInStudio}
            aria-label={t('learningHub:mediaTranscript.openInStudio')}
            title={t('learningHub:mediaTranscript.openInStudio')}
            data-media-open-in-studio=""
            className="h-8 w-8"
          >
            <ArrowSquareOut size={16} aria-hidden="true" />
          </DsButton>
        )}

        <AppMenu mode="dropdown">
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('learningHub:mediaTranscript.more')}
              title={t('learningHub:mediaTranscript.more')}
              className="h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            >
              <DotsThree size={18} weight="bold" aria-hidden="true" />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={220}>
            <AppMenuItem
              icon={<FileArrowUp size={15} aria-hidden="true" />}
              disabled={running}
              onClick={() => void handleImport()}
            >
              {t('learningHub:mediaTranscript.import')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Television size={15} aria-hidden="true" />}
              disabled={running}
              onClick={() => setBilibiliDialogOpen(true)}
            >
              {isLink ? t('learningHub:mediaBilibili.refetch') : t('learningHub:mediaBilibili.fromLink')}
            </AppMenuItem>
            <AppMenuSeparator />
            {(['srt', 'vtt', 'txt'] as const).map((format) => (
              <AppMenuItem
                key={format}
                icon={<FileArrowDown size={15} aria-hidden="true" />}
                disabled={!hasDoneSegments}
                onClick={() => void handleExport(format)}
              >
                {t(
                  format === 'srt'
                    ? 'learningHub:mediaTranscript.exportSrt'
                    : format === 'vtt'
                      ? 'learningHub:mediaTranscript.exportVtt'
                      : 'learningHub:mediaTranscript.exportTxt',
                )}
              </AppMenuItem>
            ))}
          </AppMenuContent>
        </AppMenu>
      </div>

      {/* 播放器 + 字幕面板 */}
      <div className={cn('flex min-h-0 flex-1', sideLayout ? 'flex-row' : 'flex-col')}>
        <div
          className={cn(
            'relative min-h-0 min-w-0',
            !panelOpen || sideLayout
              ? 'flex-1'
              : companion
                ? isVideo
                  // 手机学习页：播放器固定在上方，16:9 且不超过 42% 视口高
                  ? 'aspect-video max-h-[42svh] w-full shrink-0'
                  : 'shrink-0'
                : isVideo
                  ? 'h-[45%] min-h-[200px] shrink-0'
                  : 'h-[300px] shrink-0',
          )}
        >
          {embedPlayback && (
            <p className="absolute inset-x-0 top-0 z-10 bg-black/60 px-3 py-1 text-[11px] text-white" role="status" data-bilibili-fallback="">
              {embedFallback
                ? `${t('learningHub:mediaBilibili.playback.fallback')} ${t('learningHub:mediaBilibili.playback.embedGuest')}`
                : t('learningHub:mediaBilibili.playback.embedGuest')}
            </p>
          )}
          {player}
        </div>
        {panelOpen && companion && (
          <section
            aria-label={companion.ariaLabel}
            data-media-study-companion={sideLayout ? 'side' : 'bottom'}
            className={cn(
              'flex min-h-0 flex-col bg-background',
              sideLayout
                ? 'w-[340px] shrink-0 border-l border-border xl:w-[380px]'
                : 'min-h-0 flex-1 border-t border-border',
            )}
          >
            <div className="shrink-0 px-3 pb-1 pt-2">
              <SegmentedControl<string>
                ariaLabel={companion.ariaLabel}
                value={companion.activeTab}
                onValueChange={companion.onActiveTabChange}
                options={[
                  { value: MEDIA_STUDY_TRANSCRIPT_TAB, label: t('learningHub:mediaTranscript.panelTitle') },
                  ...companion.tabs.map((tab) => ({ value: tab.id, label: tab.label })),
                ]}
                size="compact"
                stretch
                // 本仓 cn 不做 tailwind-merge：覆盖基元默认宽度需用 important（同 CardsHubTabs）
                className="!flex !w-full !flex-nowrap"
                itemClassName="!flex-1 whitespace-nowrap"
              />
            </div>
            <div
              // Tailwind 的 .flex 会压过 [hidden]，可见性用类切换
              className={cn(
                'min-h-0 flex-1 flex-col',
                companion.activeTab === MEDIA_STUDY_TRANSCRIPT_TAB ? 'flex' : 'hidden',
              )}
              data-media-study-tab={MEDIA_STUDY_TRANSCRIPT_TAB}
            >
              {hasTranscript || running || status === 'partial' || status === 'failed' ? (
                <TranscriptPanel
                  segments={segments}
                  activeSegmentIdx={activeSegmentIdx}
                  onSeek={seekToSegment}
                  status={status}
                  progress={progress}
                  error={progress?.error ?? transcriptState.error}
                  onCancel={handleCancel}
                  cancelling={cancelling}
                  onRetry={() => void handleRetry()}
                  retrying={starting}
                  layout={sideLayout ? 'side' : 'bottom'}
                  hideTitle
                  bordered={false}
                  className="min-h-0 flex-1"
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
                  <Subtitles size={28} weight="duotone" className="text-muted-foreground/60" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {t('learningHub:mediaTranscript.emptyTitle')}
                    </p>
                    <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                      {t('learningHub:mediaTranscript.emptyHint')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {isLink ? (
                      <DsButton
                        variant="primary"
                        size="sm"
                        onClick={() => setBilibiliDialogOpen(true)}
                        className="gap-1.5"
                      >
                        <Television size={14} aria-hidden="true" />
                        {t('learningHub:mediaBilibili.refetch')}
                      </DsButton>
                    ) : (
                      <DsButton
                        variant="primary"
                        size="sm"
                        onClick={() => void handleTranscribeClick()}
                        disabled={estimating || starting || transcriptState.loading}
                        className="gap-1.5"
                      >
                        {estimating || starting ? (
                          <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        ) : (
                          <Waveform size={14} aria-hidden="true" />
                        )}
                        {t('learningHub:mediaTranscript.transcribe')}
                      </DsButton>
                    )}
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleImport()}
                      className="gap-1.5"
                    >
                      <FileArrowUp size={14} aria-hidden="true" />
                      {t('learningHub:mediaTranscript.import')}
                    </DsButton>
                    {!isLink && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setBilibiliDialogOpen(true)}
                        className="gap-1.5"
                      >
                        <Television size={14} aria-hidden="true" />
                        {t('learningHub:mediaBilibili.fromLink')}
                      </DsButton>
                    )}
                  </div>
                </div>
              )}
            </div>
            {companion.tabs.map((tab) => (
              // 分区常驻挂载、仅切换可见：讲义生成等进行中的任务不因切换分区被中止
              <div
                key={tab.id}
                className={cn('min-h-0 flex-1 flex-col', companion.activeTab === tab.id ? 'flex' : 'hidden')}
                data-media-study-tab={tab.id}
              >
                {tab.render(companionRenderContext)}
              </div>
            ))}
          </section>
        )}
        {panelOpen && !companion && (
          <TranscriptPanel
            segments={segments}
            activeSegmentIdx={activeSegmentIdx}
            onSeek={seekToSegment}
            status={status}
            progress={progress}
            error={progress?.error ?? transcriptState.error}
            onCancel={handleCancel}
            cancelling={cancelling}
            onRetry={() => void handleRetry()}
            retrying={starting}
            layout={sideLayout ? 'side' : 'bottom'}
            className={sideLayout ? 'w-[340px] shrink-0 xl:w-[380px]' : 'min-h-0 flex-1'}
          />
        )}
      </div>

      <BilibiliLinkDialog
        open={bilibiliDialogOpen}
        mode={bilibiliDialogMode}
        onOpenChange={setBilibiliDialogOpen}
        onDone={handleBilibiliDone}
      />

      {/* 费用确认 */}
      <DsAlertDialog
        open={confirmOpen && estimate !== null}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) transcriptState.clearEstimate();
        }}
        title={t('learningHub:mediaTranscript.estimateTitle', {
          kind: isVideo
            ? t('learningHub:mediaTranscript.kindVideo')
            : t('learningHub:mediaTranscript.kindAudio'),
        })}
        description={t('learningHub:mediaTranscript.estimateDesc')}
        confirmText={t('learningHub:mediaTranscript.startConfirm')}
        confirmVariant="primary"
        onConfirm={() => void handleConfirmStart()}
        loading={starting}
        disabled={!estimate?.asrConfigured}
      >
        {estimate && (
          <div className="space-y-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <dt className="text-muted-foreground">{t('learningHub:mediaTranscript.estimateDuration')}</dt>
              <dd className="tabular-nums text-foreground">
                {estimate.durationMs !== null ? formatMediaRefTimestamp(estimate.durationMs / 1000) : '—'}
              </dd>
              <dt className="text-muted-foreground">{t('learningHub:mediaTranscript.estimateSegments')}</dt>
              <dd className="tabular-nums text-foreground">
                {estimate.plannedSegments === null
                  ? '—'
                  : estimate.exact
                    ? String(estimate.plannedSegments)
                    : t('learningHub:mediaTranscript.estimateSegmentsValue', {
                        count: estimate.plannedSegments,
                      })}
              </dd>
              {estimate.asrModel && (
                <>
                  <dt className="text-muted-foreground">{t('learningHub:mediaTranscript.estimateModel')}</dt>
                  <dd className="min-w-0 break-all text-foreground">{estimate.asrModel}</dd>
                </>
              )}
            </dl>
            {!estimate.asrConfigured && (
              <p className="text-xs text-warning" role="alert">
                {t('learningHub:mediaTranscript.estimateNoModel')}
              </p>
            )}
          </div>
        )}
      </DsAlertDialog>
    </div>
  );
};

export default MediaStudyView;
