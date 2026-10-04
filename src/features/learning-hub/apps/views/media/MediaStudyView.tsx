/**
 * MediaStudyView — 音视频预览 + 转写 / 字幕 / 时间戳跳转 / 断点续播 / 帧引用
 *
 * 契约：docs/dev/media-learning/README.md §1.3 / §2。不新增页面：挂在
 * FileContentView 的音视频分支里，学习资源页标签、聊天右侧面板、工作台 file
 * 窗共用。
 *
 * 布局：容器宽 ≥ SIDE_LAYOUT_MIN_WIDTH 时字幕面板在右侧；否则（手机 / 窄面板）
 * 在播放器下方。顶部一条工具栏放转写入口与字幕操作。
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
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
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
import { useMediaFocusListener } from './useMediaFocusListener';
import { TranscriptPanel, selectDisplaySegments } from './TranscriptPanel';
import { findActiveSegmentIndex } from './transcriptVtt';
import { formatMediaRefTimestamp } from './mediaRefTime';
import { captureVideoFrame, CaptureFrameError, frameFileName } from './captureVideoFrame';

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
  const panelOpen = (panelPref ?? true) && (hasTranscript || running);

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

  const handleStatusChange = useCallback(
    (s: MediaPlayerStatus) => {
      lastTimeRef.current = s.currentTime;
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
    handleFocusHandled(focusRequest.requestId, true);
  }, [focusRequest, isReady, handleFocusHandled]);

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
      trackSlot={
        trackSrc ? (
          <track
            ref={trackRef}
            kind="subtitles"
            label={t('learningHub:mediaTranscript.trackLabel')}
            src={trackSrc}
            default
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

        {(hasTranscript || running) && (
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
              : isVideo
                ? 'h-[45%] min-h-[200px] shrink-0'
                : 'h-[300px] shrink-0',
          )}
        >
          {player}
        </div>
        {panelOpen && (
          <TranscriptPanel
            segments={segments}
            activeSegmentIdx={activeSegmentIdx}
            onSeek={seekToSegment}
            status={status}
            progress={progress}
            error={transcriptState.error}
            onCancel={handleCancel}
            cancelling={cancelling}
            onRetry={() => void handleRetry()}
            retrying={starting}
            layout={sideLayout ? 'side' : 'bottom'}
            className={sideLayout ? 'w-[340px] shrink-0 xl:w-[380px]' : 'min-h-0 flex-1'}
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
        disabled={!estimate?.asrModel}
      >
        {estimate && (
          <div className="space-y-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <dt className="text-muted-foreground">{t('learningHub:mediaTranscript.estimateDuration')}</dt>
              <dd className="tabular-nums text-foreground">
                {formatMediaRefTimestamp(estimate.durationMs / 1000)}
              </dd>
              <dt className="text-muted-foreground">{t('learningHub:mediaTranscript.estimateSegments')}</dt>
              <dd className="tabular-nums text-foreground">
                {t('learningHub:mediaTranscript.estimateSegmentsValue', {
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
            {!estimate.asrModel && (
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
