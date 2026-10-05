/**
 * 讲义章节：最新讲义笔记里的小节（`##` 标题 + 起点锚点），后端 `media_chapters` 解析。
 * 进度条画章节线、工具栏显示当前章节、讲义分区列章节可跳转。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEventRegistry } from '@/hooks/useEventRegistry';

export interface MediaChapter {
  title: string;
  /** 起点（秒） */
  seconds: number;
}

export function normalizeChapters(raw: unknown): MediaChapter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): MediaChapter | null => {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      return typeof r.title === 'string' && r.title.trim() && typeof r.seconds === 'number' && Number.isFinite(r.seconds)
        ? { title: r.title.trim(), seconds: Math.max(0, r.seconds) }
        : null;
    })
    .filter((chapter): chapter is MediaChapter => chapter !== null)
    .sort((a, b) => a.seconds - b.seconds);
}

/** 当前时刻所在章节的下标（第一章之前为 -1） */
export function chapterIndexAt(chapters: readonly MediaChapter[], seconds: number): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].seconds <= seconds) index = i;
    else break;
  }
  return index;
}

export function useMediaChapters(resourceId: string, enabled: boolean): MediaChapter[] {
  const [chapters, setChapters] = useState<MediaChapter[]>([]);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const generation = ++generationRef.current;
    try {
      const next = normalizeChapters(await invoke<unknown>('media_chapters', { resourceId }));
      if (generation === generationRef.current) setChapters(next);
    } catch {
      // 章节是锦上添花：拉取失败保持现状
    }
  }, [enabled, resourceId]);

  useEffect(() => {
    if (!enabled) {
      setChapters([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // 讲义刚生成 / 在笔记里改过标题后回到学习页时重拉
  const onVisible = useCallback(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, [refresh]);
  useEventRegistry(
    enabled
      ? [
          { target: 'document', type: 'visibilitychange', listener: onVisible },
          { target: 'window', type: 'focus', listener: () => void refresh() },
        ]
      : [],
    [enabled, onVisible, refresh],
  );

  return chapters;
}
