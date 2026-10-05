/**
 * useTranscriptTrack — 字幕段 → `<track>` 字幕轨（blob URL 首装 + cue 增量）
 *
 * 首批可渲染段出现时生成一次 VTT blob URL；之后段变化只经
 * createCueSynchronizer 做 addCue/removeCue，不改 `<track src>`（不重建轨道）。
 * `<track>` 尚未加载完 blob 时的变化先挂起，load 事件后补齐。
 *
 * 显示模式完全由 `captionsOn` 驱动：`<track>` 不带 `default`（WebKit 在媒体
 * 加载 / seek / play 等时机会重跑自动选轨，把 default 轨重置为 showing），
 * 挂载时即显式设 mode（非 disabled 才会触发浏览器加载 blob），并在轨道 load、
 * textTracks 的 change/addtrack 与媒体加载/播放事件上纠正（mode 相同则不写，不成环）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from './mediaTranscriptApi';
import { buildWebVtt, createCueSynchronizer, isRenderableSegment } from './transcriptVtt';

const CAPTION_KINDS = new Set(['subtitles', 'captions']);
/** 浏览器可能重跑自动选轨（重置 mode）的媒体事件：在这些点上重新对齐 captionsOn */
const MODE_RESYNC_MEDIA_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'play',
  'playing',
  'seeked',
] as const;

function setTrackMode(track: TextTrack, mode: TextTrackMode) {
  if (track.mode === mode) return;
  try {
    track.mode = mode;
  } catch {
    /* 非关键 */
  }
}

function parentMediaElement(el: HTMLTrackElement): HTMLMediaElement | null {
  const parent = el.parentElement;
  return parent instanceof HTMLMediaElement ? parent : null;
}

/** jsdom 等环境的 textTracks 可能是普通数组：只在支持事件时订阅 */
function eventfulTrackList(media: HTMLMediaElement | null): TextTrackList | null {
  const list = media?.textTracks as TextTrackList | undefined;
  return list && typeof list.addEventListener === 'function' ? list : null;
}

export function useTranscriptTrack(segments: readonly TranscriptSegment[], enabled: boolean) {
  const [trackSrc, setTrackSrc] = useState<string | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const syncRef = useRef<ReturnType<typeof createCueSynchronizer> | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  /** 生成 blob 时用的段：新 `<track>` 元素（播放器 stream→blob 回退重挂）重新从 seed 起算差量 */
  const seedRef = useRef<TranscriptSegment[]>([]);
  const trackElRef = useRef<HTMLTrackElement | null>(null);
  /** 解绑当前 `<track>` / `<video>` 上的监听（元素切换或卸载时调用） */
  const detachRef = useRef<(() => void) | null>(null);
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
    seedRef.current = seed;
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

  /** 让本轨（及同一 `<video>` 上的其它字幕轨）的 mode 跟随 captionsOn */
  const applyMode = useCallback(() => {
    const el = trackElRef.current;
    if (!el) return;
    const own = el.track ?? null;
    if (own) setTrackMode(own, captionsOnRef.current ? 'showing' : 'hidden');
    // 浏览器自动选中的其它字幕轨 / 陈旧轨：关闭时一律不显示，开启时也不与本轨叠显
    const list = parentMediaElement(el)?.textTracks;
    if (!list) return;
    for (const track of Array.from(list)) {
      if (track === own || !CAPTION_KINDS.has(track.kind)) continue;
      if (track.mode === 'showing') setTrackMode(track, 'hidden');
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

  /** callback ref：挂上 `<track>` 时订阅 load 与 mode 纠正事件 */
  const trackRef = useCallback(
    (el: HTMLTrackElement | null) => {
      const isNewElement = el !== null && el !== trackElRef.current;
      detachRef.current?.();
      detachRef.current = null;
      trackElRef.current = el;
      loadedRef.current = false;
      if (!el) return;
      // 新 `<track>` 只会加载 blob 里的 seed cue：已应用状态按 seed 重置
      if (isNewElement && syncRef.current) {
        syncRef.current = createCueSynchronizer(seedRef.current);
      }
      const onLoad = () => {
        // 陈旧元素（stream→blob 回退重挂前的旧 `<track>`）迟到的 load 不得污染新轨状态
        if (trackElRef.current !== el) return;
        loadedRef.current = true;
        applyMode();
        syncNow();
      };
      const media = parentMediaElement(el);
      const list = eventfulTrackList(media);
      el.addEventListener('load', onLoad);
      for (const type of MODE_RESYNC_MEDIA_EVENTS) media?.addEventListener(type, applyMode);
      list?.addEventListener('change', applyMode);
      list?.addEventListener('addtrack', applyMode);
      detachRef.current = () => {
        el.removeEventListener('load', onLoad);
        for (const type of MODE_RESYNC_MEDIA_EVENTS) media?.removeEventListener(type, applyMode);
        list?.removeEventListener('change', applyMode);
        list?.removeEventListener('addtrack', applyMode);
      };
      // 无 default：立即显式设 mode（disabled 轨不会加载 blob）
      applyMode();
      // readyState 2 = LOADED（缓存命中时 load 可能已触发）
      if (el.readyState === 2) onLoad();
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
