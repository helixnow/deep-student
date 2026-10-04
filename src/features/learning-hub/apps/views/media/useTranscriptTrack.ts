/**
 * useTranscriptTrack — 字幕段 → `<track>` 字幕轨（blob URL 首装 + cue 增量）
 *
 * 首批可渲染段出现时生成一次 VTT blob URL；之后段变化只经
 * createCueSynchronizer 做 addCue/removeCue，不改 `<track src>`（不重建轨道）。
 * `<track>` 尚未加载完 blob 时的变化先挂起，load 事件后补齐。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from './mediaTranscriptApi';
import { buildWebVtt, createCueSynchronizer, isRenderableSegment } from './transcriptVtt';

export function useTranscriptTrack(segments: readonly TranscriptSegment[], enabled: boolean) {
  const [trackSrc, setTrackSrc] = useState<string | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const syncRef = useRef<ReturnType<typeof createCueSynchronizer> | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const trackElRef = useRef<HTMLTrackElement | null>(null);
  const loadedRef = useRef(false);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const captionsOnRef = useRef(captionsOn);
  captionsOnRef.current = captionsOn;

  const hasRenderable = enabled && segments.some(isRenderableSegment);

  // 首装：只生成一次 blob（之后段变化走 cue 增量）
  useEffect(() => {
    if (!hasRenderable || syncRef.current) return;
    const seed = segmentsRef.current.slice();
    syncRef.current = createCueSynchronizer(seed);
    const url = URL.createObjectURL(new Blob([buildWebVtt(seed)], { type: 'text/vtt' }));
    blobUrlRef.current = url;
    setTrackSrc(url);
  }, [hasRenderable]);

  // 卸载释放 blob
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      // StrictMode 探测性卸载后重挂：让首装 effect 重新生成 blob
      syncRef.current = null;
    };
  }, []);

  const applyMode = useCallback(() => {
    const track = trackElRef.current?.track;
    if (!track) return;
    try {
      track.mode = captionsOnRef.current ? 'showing' : 'hidden';
    } catch {
      /* 非关键 */
    }
  }, []);

  const syncNow = useCallback(() => {
    const track = trackElRef.current?.track;
    const sync = syncRef.current;
    if (!track || !sync || !loadedRef.current) return;
    sync.sync(track, segmentsRef.current);
  }, []);

  // 段变化 → 增量
  useEffect(() => {
    syncNow();
  }, [segments, syncNow]);

  useEffect(() => {
    applyMode();
  }, [captionsOn, applyMode]);

  /** callback ref：挂上 `<track>` 时订阅 load */
  const trackRef = useCallback(
    (el: HTMLTrackElement | null) => {
      trackElRef.current = el;
      loadedRef.current = false;
      if (!el) return;
      const onLoad = () => {
        loadedRef.current = true;
        applyMode();
        syncNow();
      };
      // readyState 2 = LOADED（缓存命中时 load 可能已触发）
      if (el.readyState === 2) onLoad();
      else el.addEventListener('load', onLoad, { once: true });
    },
    [applyMode, syncNow],
  );

  return {
    trackSrc,
    trackRef,
    captionsOn,
    toggleCaptions: useCallback(() => setCaptionsOn((v) => !v), []),
  };
}
