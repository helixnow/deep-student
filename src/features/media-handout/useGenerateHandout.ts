import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { HandoutError, runHandout, type HandoutProgress, type RunHandoutResult } from './pipeline';
import { errorText } from './adaptivePool';
import type { HandoutLang } from './prompts';

export interface UseGenerateHandoutOptions {
  resourceId: string;
  kind: 'audio' | 'video';
  /** 播放器使用的同一 URL（filestream:/blob:），视频抽帧用 */
  src: string;
  fileName: string;
}

export interface GenerateHandoutState {
  running: boolean;
  progress: HandoutProgress | null;
  result: RunHandoutResult | null;
  start: () => void;
  cancel: () => void;
}

/** 讲义打开：无 source → 工作台 / 经典壳学习资源页打开（见 features/notes/openNoteEvent.ts） */
export function openHandoutNote(noteId: string): void {
  window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId } }));
}

export function resolveHandoutLang(language: string | undefined): HandoutLang {
  return (language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function useGenerateHandout({ resourceId, kind, src, fileName }: UseGenerateHandoutOptions): GenerateHandoutState {
  const { t, i18n } = useTranslation(['learningHub']);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<HandoutProgress | null>(null);
  const [result, setResult] = useState<RunHandoutResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 切资源 / 卸载时中止在途生成
  useEffect(() => () => abortRef.current?.abort(), [resourceId]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const start = useCallback(() => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    setProgress({ phase: 'transcript', done: 0, total: 1 });
    const mediaName = fileName.replace(/\.[^.]+$/, '') || fileName;

    void runHandout({
      resourceId,
      mediaName,
      videoSrc: kind === 'video' ? src : null,
      lang: resolveHandoutLang(i18n.resolvedLanguage ?? i18n.language),
      signal: controller.signal,
      onProgress: (p) => {
        if (!controller.signal.aborted) setProgress(p);
      },
      text: {
        titleSuffix: t('learningHub:mediaHandout.titleSuffix'),
        sectionFallback: t('learningHub:mediaHandout.sectionFallback'),
        frameFallbackCaption: t('learningHub:mediaHandout.frameFallbackCaption'),
      },
    })
      .then((res) => {
        setResult(res);
        showGlobalNotification(
          res.framesDegraded ? 'warning' : 'success',
          res.framesDegraded
            ? t('learningHub:mediaHandout.doneTextOnly', { title: res.title })
            : t('learningHub:mediaHandout.done', { title: res.title }),
          undefined,
          {
            action: {
              label: t('learningHub:mediaHandout.openNote'),
              onClick: () => openHandoutNote(res.noteId),
            },
            borderTone: 'neutral',
          },
        );
      })
      .catch((e: unknown) => {
        if (e instanceof HandoutError && e.code === 'cancelled') {
          showGlobalNotification('info', t('learningHub:mediaHandout.cancelled'));
          return;
        }
        const message =
          e instanceof HandoutError && e.code === 'no_transcript'
            ? t('learningHub:mediaHandout.needTranscript')
            : e instanceof HandoutError && e.code === 'outline_failed'
              ? t('learningHub:mediaHandout.outlineFailed')
              : errorText(e) || t('learningHub:mediaHandout.failed');
        showGlobalNotification('error', message, t('learningHub:mediaHandout.failed'));
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setRunning(false);
        setProgress(null);
      });
  }, [fileName, i18n.language, i18n.resolvedLanguage, kind, resourceId, src, t]);

  return { running, progress, result, start, cancel };
}
