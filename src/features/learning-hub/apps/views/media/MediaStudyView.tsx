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
  Target,
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
import { AudioPlayer } from './AudioPlayer';
import { VideoPlayer } from './VideoPlayer';
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
import { sendSelectionToChatInput } from '@/features/pdf/selectionStudyActions';
import { formatMediaRefTimestamp } from './mediaRefTime';
import { captureVideoFrame, CaptureFrameError, frameFileName } from './captureVideoFrame';
import {
  buildTranscriptQuote,
  FRAME_CONTEXT_RADIUS_SECONDS,
  formatTranscriptLines,
  segmentsInWindow,
} from './transcriptExcerpt';
import { makeMediaCards } from './mediaCards';
import {
  checkpointState,
  findCrossedCheckpoint,
  useMediaCheckpoints,
  type MediaCheckpoint,
} from './mediaCheckpoints';
import { CHECKPOINT_REWATCH_LEAD_SECONDS, MediaCheckpointCard } from './MediaCheckpointCard';
import type { MediaScrubberMarker, MediaScrubberRange } from './MediaScrubber';
import {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  useMediaStudyCompanion,
  type MediaStudyCompanionRenderContext,
} from './mediaStudyCompanion';
import { openMediaStudio } from '@/features/media-studio/mediaStudioNavigation';

/** 字幕面板放到右侧所需的最小容器宽度 */
export const SIDE_LAYOUT_MIN_WIDTH = 720;

/** 「到点暂停作答」偏好（默认只标记不打断） */
const PAUSE_AT_CHECKPOINTS_KEY = 'media-study.pauseAtCheckpoints';
/** 答错的检查点在进度条上标出的回看区间：锚点前 15 秒到后 30 秒 */
const WEAK_RANGE_AFTER_SECONDS = 30;

function readPauseAtCheckpoints(): boolean {
  try {
    return window.localStorage.getItem(PAUSE_AT_CHECKPOINTS_KEY) === '1';
  } catch {
    return false;
  }
}

function writePauseAtCheckpoints(value: boolean): void {
  try {
    window.localStorage.setItem(PAUSE_AT_CHECKPOINTS_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用时只在本次会话生效
  }
}

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
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MediaPlayerHandle | null>(null);
  const containerWidth = useContainerWidth(rootRef);
  const sideLayout = containerWidth >= SIDE_LAYOUT_MIN_WIDTH;
  const isVideo = kind === 'video';
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
  const { trackSrc, trackRef, captionsOn, toggleCaptions } = useTranscriptTrack(segments, isVideo);

  // ---------------------------------------------------------------- 播放状态 / 跟随高亮
  const [isReady, setIsReady] = useState(false);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(-1);
  const segmentsForActiveRef = useRef(displaySegments);
  segmentsForActiveRef.current = displaySegments;
  const lastTimeRef = useRef(0);

  const externalSeekRef = useRef(false);
  const { onStatus: onProgressStatus, resumedFromRef } = useMediaProgressSync({
    resourceId,
    enabled: true,
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

  // ---------------------------------------------------------------- 课中检查点（仅音视频学习页）
  const { checkpoints, recordResult: recordCheckpointResult } = useMediaCheckpoints(resourceId, Boolean(companion));
  const checkpointsRef = useRef(checkpoints);
  checkpointsRef.current = checkpoints;
  const promptedCheckpointsRef = useRef(new Set<string>());
  const [activeCheckpoint, setActiveCheckpoint] = useState<MediaCheckpoint | null>(null);
  const [pauseAtCheckpoints, setPauseAtCheckpointsState] = useState(readPauseAtCheckpoints);
  const pauseAtCheckpointsRef = useRef(pauseAtCheckpoints);
  pauseAtCheckpointsRef.current = pauseAtCheckpoints;
  const setPauseAtCheckpoints = useCallback((value: boolean) => {
    setPauseAtCheckpointsState(value);
    writePauseAtCheckpoints(value);
  }, []);
  useEffect(() => {
    promptedCheckpointsRef.current = new Set();
    setActiveCheckpoint(null);
  }, [resourceId]);

  const handleStatusChange = useCallback(
    (s: MediaPlayerStatus) => {
      const previousTime = lastTimeRef.current;
      lastTimeRef.current = s.currentTime;
      setIsReady((prev) => (prev === s.isReady ? prev : s.isReady));
      recomputeActive(s.currentTime);
      onProgressStatus(s);
      if (s.isPlaying && checkpointsRef.current.length > 0) {
        // 答对过的不再打断；答错的回看后再播到会再问一次
        const open = checkpointsRef.current.filter((cp) => checkpointState(cp) !== 'correct');
        const crossed = findCrossedCheckpoint(open, previousTime, s.currentTime, promptedCheckpointsRef.current);
        if (crossed) {
          promptedCheckpointsRef.current.add(crossed.questionId);
          setActiveCheckpoint(crossed);
          if (pauseAtCheckpointsRef.current) handleRef.current?.pause();
        }
      }
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
      const seconds = el.currentTime;
      const timestamp = formatMediaRefTimestamp(seconds);
      const blob = await captureVideoFrame(el);
      const name = frameFileName(fileName, timestamp);
      const uploaded = await uploadAttachmentBlob(blob, {
        name,
        mimeType: 'image/png',
        type: 'image',
      });
      // 模型只看到一张图时不知道老师此刻在讲什么：附上前后 30 秒字幕（图片上下文定义消费）
      const excerpt = formatTranscriptLines(segmentsInWindow(
        segments,
        (seconds - FRAME_CONTEXT_RADIUS_SECONDS) * 1000,
        (seconds + FRAME_CONTEXT_RADIUS_SECONDS) * 1000,
      ));
      await referenceToChat({
        sourceType: 'image',
        sourceId: uploaded.sourceId,
        metadata: {
          title: t('learningHub:mediaTranscript.frameTitle', { name: fileName, time: timestamp }),
          mimeType: 'image/png',
          size: blob.size,
          mediaResourceId: resourceId,
          mediaSeconds: Math.floor(seconds),
          ...(excerpt ? { mediaTranscriptExcerpt: excerpt } : {}),
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
  }, [fileName, referenceToChat, resourceId, segments, t]);

  // ---------------------------------------------------------------- 字幕选段 → 引用到对话 / 制卡
  // 学习页（有 companion）新开课程对话（附媒体 + 课程学习技能，同问答分区）；
  // 资源库 / 聊天右侧面板预填当前对话的输入框（同 PDF 划词「添加到聊天」）。
  const handleQuoteSelection = useCallback((selected: TranscriptSegment[]) => {
    const quote = buildTranscriptQuote(resourceId, selected);
    if (!quote) return;
    const title = fileName.replace(/\.[^.]+$/, '') || fileName;
    const text = `${t('learningHub:mediaTranscript.quoteIntro', { name: title, ref: quote.marker })}\n${quote.quote}\n\n`;
    if (!companion) {
      sendSelectionToChatInput({ text, sourceName: fileName });
      return;
    }
    void import('@/features/media-studio/mediaChat')
      .then(({ startMediaChat }) => startMediaChat({ resourceId, name: fileName, prompt: text, referenceToChat }))
      .catch((err: unknown) => {
        showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaTranscript.quoteFailed'));
      });
  }, [companion, fileName, referenceToChat, resourceId, t]);

  const handleCardsFromSelection = useCallback((selected: TranscriptSegment[]) => {
    void makeMediaCards({
      resourceId,
      fileName,
      segments: selected,
      extraRequirements: t('learningHub:mediaCards.selectionRequirement'),
      maxCards: Math.min(10, Math.max(3, Math.ceil(selected.length / 3))),
      t,
    });
  }, [fileName, resourceId, t]);

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
  const getCurrentTime = useCallback(
    () => handleRef.current?.getElement()?.currentTime ?? lastTimeRef.current,
    [],
  );

  // 检查点：进度条按作答状态标点，答错的标出回看区间
  const scrubberMarkers = useMemo<MediaScrubberMarker[]>(
    () => checkpoints.map((cp) => ({ at: cp.seconds, kind: 'checkpoint', state: checkpointState(cp) })),
    [checkpoints],
  );
  const scrubberHighlights = useMemo<MediaScrubberRange[]>(
    () => checkpoints
      .filter((cp) => checkpointState(cp) === 'wrong')
      .map((cp) => ({
        from: Math.max(0, cp.seconds - CHECKPOINT_REWATCH_LEAD_SECONDS),
        to: cp.seconds + WEAK_RANGE_AFTER_SECONDS,
      })),
    [checkpoints],
  );
  const checkpointsDone = useMemo(
    () => checkpoints.filter((cp) => checkpointState(cp) === 'correct').length,
    [checkpoints],
  );
  const openNextCheckpoint = useCallback(() => {
    const next = checkpoints.find((cp) => checkpointState(cp) !== 'correct') ?? checkpoints[0];
    if (next) setActiveCheckpoint(next);
  }, [checkpoints]);
  const rewatchCheckpoint = useCallback((seconds: number) => {
    // 回看后再播到锚点时重新提问
    if (activeCheckpoint) promptedCheckpointsRef.current.delete(activeCheckpoint.questionId);
    setActiveCheckpoint(null);
    seekToSeconds(seconds);
  }, [activeCheckpoint, seekToSeconds]);
  const resumeAfterCheckpoint = useCallback(() => {
    setActiveCheckpoint(null);
    handleRef.current?.play();
  }, []);
  const doneSegments = useMemo(() => segments.filter((s) => s.status === 'done').length, [segments]);
  const companionRenderContext = useMemo<MediaStudyCompanionRenderContext>(
    () => ({
      resourceId,
      kind,
      src,
      fileName,
      transcriptStatus: status,
      hasTranscript: hasDoneSegments && !running,
      doneSegments,
      totalSegments: transcript?.progress?.totalSegments || segments.length,
      segments,
      seekTo: seekToSeconds,
      getCurrentTime,
    }),
    [resourceId, kind, src, fileName, status, hasDoneSegments, running, doneSegments, transcript, segments, seekToSeconds, getCurrentTime],
  );

  // ---------------------------------------------------------------- 渲染
  const transcribeLabel =
    status === 'partial'
      ? t('learningHub:mediaTranscript.retryFailed')
      : status === 'failed'
        ? t('learningHub:mediaTranscript.retry')
        : t('learningHub:mediaTranscript.transcribe');
  const showTranscribeButton = !running && status !== 'completed';
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

  const player = isVideo ? (
    <VideoPlayer
      key={src}
      src={src}
      fileName={fileName}
      compatibilityHint={compatibilityHint}
      isActive={isActive}
      onError={onError}
      handleRef={handleRef}
      onStatusChange={handleStatusChange}
      crossOrigin="anonymous"
      extraControls={captionsButton}
      scrubberMarkers={scrubberMarkers}
      scrubberHighlights={scrubberHighlights}
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
      scrubberMarkers={scrubberMarkers}
      scrubberHighlights={scrubberHighlights}
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

        {companion && checkpoints.length > 0 && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={openNextCheckpoint}
            title={t('learningHub:mediaCheckpoint.toolbarTitle', { total: checkpoints.length })}
            data-media-checkpoint-toolbar=""
            className={cn(toolbarButtonClass, 'gap-1.5 px-2.5 text-xs tabular-nums')}
          >
            <Target size={14} aria-hidden="true" />
            {t('learningHub:mediaCheckpoint.toolbar', { done: checkpointsDone, total: checkpoints.length })}
          </DsButton>
        )}

        {/* 讲义：字幕 → 抽帧/帧说明 → 大纲 → 分节 → 落为笔记（docs/dev/media-learning §3） */}
        {!companion && (
          <HandoutGenerateButton
            resourceId={resourceId}
            kind={kind}
            src={src}
            fileName={fileName}
            hasTranscript={hasDoneSegments && !running}
          />
        )}

        {isVideo && (
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
          <AppMenuContent align="end" width={200}>
            <AppMenuItem
              icon={<FileArrowUp size={15} aria-hidden="true" />}
              disabled={running}
              onClick={() => void handleImport()}
            >
              {t('learningHub:mediaTranscript.import')}
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
            'min-h-0 min-w-0',
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
            {activeCheckpoint && (
              <MediaCheckpointCard
                key={activeCheckpoint.questionId}
                checkpoint={activeCheckpoint}
                pauseAtCheckpoints={pauseAtCheckpoints}
                onPauseAtCheckpointsChange={setPauseAtCheckpoints}
                onSeek={rewatchCheckpoint}
                onResume={resumeAfterCheckpoint}
                onClose={() => setActiveCheckpoint(null)}
                onAnswered={recordCheckpointResult}
              />
            )}
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
                  onQuoteSelection={handleQuoteSelection}
                  onMakeCardsFromSelection={handleCardsFromSelection}
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
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleImport()}
                      className="gap-1.5"
                    >
                      <FileArrowUp size={14} aria-hidden="true" />
                      {t('learningHub:mediaTranscript.import')}
                    </DsButton>
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
            onQuoteSelection={handleQuoteSelection}
            onMakeCardsFromSelection={handleCardsFromSelection}
          />
        )}
      </div>

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
