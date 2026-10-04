/**
 * `<video>` + canvas 抽帧：等间隔采样 + 16×16 灰度差去重；以及对被引用帧的高清重抽。
 *
 * Adapted from wangke-agent `src/media/frames.ts`
 * (https://github.com/BA7MLV/wangke-agent).
 * MIT License — Copyright (c) 2026 BA7MLV. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files, to deal in the Software without restriction, subject to the
 * condition that the above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE SOFTWARE IS
 * PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * 视频源：filestream:// URL（其 CORS 白名单含应用源）或同源 blob: URL，
 * `crossOrigin="anonymous"` 保证 canvas 不被污染（契约 §4）。
 */

export interface ExtractedFrame {
  /** 采样时间（整数秒） */
  ts: number;
  blob: Blob;
  width: number;
  height: number;
}

export const FRAME_INTERVAL_SEC = 25;
export const FRAME_MAX_WIDTH = 640;
export const FRAME_DIFF_THRESHOLD = 16;
export const MAX_FRAMES = 60;
export const HIRES_MAX_WIDTH = 1600;

/** 两张 16×16 灰度图的平均绝对差（0~255） */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/** RGBA 像素 → 灰度（ITU-R BT.601 权重） */
export function rgbaToGray(data: ArrayLike<number>): Uint8Array {
  const n = Math.floor(data.length / 4);
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * 去重决策：与**上一张保留帧**比较，差异 ≥ 阈值才保留（PPT 翻页保留，讲师晃动过滤）。
 * 返回被保留的下标。纯函数，供单测与抽帧循环共用。
 */
export function selectDistinctFrames(
  grays: Uint8Array[],
  threshold = FRAME_DIFF_THRESHOLD,
  maxFrames = MAX_FRAMES,
): number[] {
  const kept: number[] = [];
  let last: Uint8Array | null = null;
  for (let i = 0; i < grays.length && kept.length < maxFrames; i++) {
    if (!last || frameDiff(grays[i], last) >= threshold) {
      kept.push(i);
      last = grays[i];
    }
  }
  return kept;
}

/** 等间隔采样时间点（整数秒；避开片头 0 s 黑场与片尾） */
export function sampleTimestamps(durationSec: number, intervalSec = FRAME_INTERVAL_SEC): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const out: number[] = [];
  const first = Math.max(1, Math.min(2, Math.floor(durationSec * 0.02)));
  for (let t = first; t < durationSec - 1; t += intervalSec) out.push(Math.floor(t));
  if (out.length === 0) out.push(Math.floor(durationSec / 2));
  return out;
}

class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortedError();
}

async function openVideo(src: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('video metadata timeout')), 30_000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('video load failed'));
    };
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new AbortedError());
    });
    video.src = src;
  });
  if (!video.videoWidth || !video.videoHeight) throw new Error('video has no picture track');
  return video;
}

function closeVideo(video: HTMLVideoElement) {
  video.removeAttribute('src');
  try {
    video.load();
  } catch {
    /* ignore */
  }
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('seek timeout'));
    }, 15_000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('seek failed'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = t;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
}

function grayThumb(source: HTMLCanvasElement, probe: HTMLCanvasElement): Uint8Array {
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  if (!pctx) return new Uint8Array(256);
  pctx.drawImage(source, 0, 0, 16, 16);
  return rgbaToGray(pctx.getImageData(0, 0, 16, 16).data);
}

/** 探测视频时长（秒）；无画面轨或失败返回 null */
export async function probeVideo(src: string): Promise<{ durationSec: number; width: number; height: number } | null> {
  let video: HTMLVideoElement | null = null;
  try {
    video = await openVideo(src);
    return { durationSec: video.duration, width: video.videoWidth, height: video.videoHeight };
  } catch {
    return null;
  } finally {
    if (video) closeVideo(video);
  }
}

/** 等间隔抽帧（640 px JPEG q0.75）+ 灰度差去重，≤ maxFrames 张 */
export async function extractFrames(
  src: string,
  opts: {
    intervalSec?: number;
    maxFrames?: number;
    diffThreshold?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ExtractedFrame[]> {
  const {
    intervalSec = FRAME_INTERVAL_SEC,
    maxFrames = MAX_FRAMES,
    diffThreshold = FRAME_DIFF_THRESHOLD,
    signal,
    onProgress,
  } = opts;
  const video = await openVideo(src, signal);
  try {
    const timestamps = sampleTimestamps(video.duration, intervalSec);
    const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const probe = document.createElement('canvas');
    probe.width = 16;
    probe.height = 16;

    const frames: ExtractedFrame[] = [];
    let lastGray: Uint8Array | null = null;
    for (let i = 0; i < timestamps.length; i++) {
      throwIfAborted(signal);
      const ts = timestamps[i];
      try {
        await seekTo(video, ts);
      } catch {
        onProgress?.(i + 1, timestamps.length);
        continue; // 单点 seek 失败不影响整体
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const gray = grayThumb(canvas, probe);
      // 与上一张保留帧比较（同 selectDistinctFrames）
      if (!lastGray || frameDiff(gray, lastGray) >= diffThreshold) {
        const blob = await canvasToJpeg(canvas, 0.75);
        if (blob) {
          frames.push({ ts, blob, width: canvas.width, height: canvas.height });
          lastGray = gray;
        }
      }
      onProgress?.(i + 1, timestamps.length);
      if (frames.length >= maxFrames) break;
    }
    return frames;
  } finally {
    closeVideo(video);
  }
}

/** 对被引用帧按原分辨率（≤ 1600 px）q0.92 重抽；失败的时间点不出现在结果中 */
export async function extractFramesAt(
  src: string,
  timestamps: number[],
  opts: { maxWidth?: number; quality?: number; signal?: AbortSignal } = {},
): Promise<Map<number, ExtractedFrame>> {
  const { maxWidth = HIRES_MAX_WIDTH, quality = 0.92, signal } = opts;
  const out = new Map<number, ExtractedFrame>();
  if (timestamps.length === 0) return out;
  const video = await openVideo(src, signal);
  try {
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    for (const ts of timestamps) {
      throwIfAborted(signal);
      try {
        await seekTo(video, Math.min(Math.max(0, ts), Math.max(0, video.duration - 0.1)));
      } catch {
        continue;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToJpeg(canvas, quality);
      if (blob) out.set(ts, { ts, blob, width: canvas.width, height: canvas.height });
    }
    return out;
  } finally {
    closeVideo(video);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
