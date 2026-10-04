/**
 * 讲义生成流水线（docs/dev/media-learning §3「讲义」）：
 * 字幕 → 抽帧（仅视频）→ VLM 帧说明筛选 → [分块摘要] → 大纲 → 分节 IR（校验 + 重试 + 兜底）
 * → 高清重抽被引用帧 → 落为笔记（图片走 notes_save_asset，小节带 `[媒体@…]` 锚点）。
 *
 * 流程编排思路参考 wangke-agent `src/pipelines/handout.ts`
 * （https://github.com/BA7MLV/wangke-agent，MIT, Copyright (c) 2026 BA7MLV）。
 */
import * as api from './api';
import { AdaptiveLimit, adaptivePool, errorText, isFatalError, isRateLimitError } from './adaptivePool';
import {
  blobToBase64,
  extractFrames,
  extractFramesAt,
  type ExtractedFrame,
} from './frames';
import {
  collectFigureTimestamps,
  formatClock,
  parseSectionBlocks,
  salvageBlocks,
  type Block,
  type HandoutSection,
} from './ir';
import { handoutToMarkdown } from './markdown';
import {
  chunkSummaryPrompt,
  frameCaptionPrompt,
  outlinePrompt,
  parseFrameCaption,
  sectionPrompt,
  type HandoutLang,
} from './prompts';
import {
  chunkTranscript,
  DIRECT_OUTLINE_MAX_CHARS,
  parseOutline,
  sectionFigureRange,
  sectionFrameWindow,
  sectionTranscriptWindow,
  segmentsToTranscript,
  snapToFrame,
  usableSegments,
  type HandoutFrame,
  type Outline,
} from './windowing';

export type HandoutPhase =
  | 'transcript'
  | 'frames'
  | 'captions'
  | 'outline'
  | 'writing'
  | 'images'
  | 'saving'
  | 'done';

export interface HandoutProgress {
  phase: HandoutPhase;
  done: number;
  total: number;
}

export type HandoutErrorCode = 'no_transcript' | 'outline_failed' | 'note_failed' | 'cancelled';

export class HandoutError extends Error {
  constructor(
    public readonly code: HandoutErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HandoutError';
  }
}

export interface RunHandoutInput {
  resourceId: string;
  mediaName: string;
  /** 视频可播放 URL（filestream:/blob:）；音频或无画面时为 null → 纯文字讲义 */
  videoSrc: string | null;
  lang: HandoutLang;
  signal?: AbortSignal;
  onProgress?: (p: HandoutProgress) => void;
  /** 本地化字符串（标题后缀、兜底文案） */
  text: {
    titleSuffix: string;
    sectionFallback: string;
    frameFallbackCaption: string;
  };
}

export interface RunHandoutResult {
  noteId: string;
  title: string;
  sectionCount: number;
  figureCount: number;
  /** 视频但未能使用画面（抽帧或视觉模型不可用） */
  framesDegraded: boolean;
}

const MIN_SEGMENTS = 3;
const SECTION_CONCURRENCY = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new HandoutError('cancelled');
}

function isAbort(e: unknown): boolean {
  return (
    (e instanceof HandoutError && e.code === 'cancelled') ||
    (e instanceof Error && e.name === 'AbortError') ||
    errorText(e).endsWith('cancelled')
  );
}

/** 文本调用重试：鉴权/参数错误与取消不重试，其余指数退避 */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, retries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (signal?.aborted || isAbort(e)) throw new HandoutError('cancelled');
      if (isFatalError(e)) throw e;
      if (i < retries - 1) await sleep(1000 * 2 ** i + Math.random() * 400);
    }
  }
  throw last;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx], idx);
      }
    }),
  );
}

/** VLM 帧说明：自适应并发；单帧失败兜底为教学画面；视觉模型不可用时整体放弃画面 */
async function captionFrames(
  frames: ExtractedFrame[],
  input: RunHandoutInput,
  runId: string,
): Promise<{ frames: HandoutFrame[]; unavailable: boolean }> {
  const out: Array<HandoutFrame | undefined> = new Array(frames.length);
  const limiter = new AdaptiveLimit(3, 1, 6);
  const prompt = frameCaptionPrompt(input.lang);
  let unavailable = false;
  let done = 0;
  const abort = new AbortController();
  input.signal?.addEventListener('abort', () => abort.abort());

  await adaptivePool(
    frames,
    limiter,
    async (frame, i) => {
      let result: HandoutFrame = {
        ...frame,
        caption: input.text.frameFallbackCaption,
        isTeaching: true,
      };
      try {
        const b64 = await blobToBase64(frame.blob);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const raw = await api.vlmCaption(prompt, b64, { runId });
            const parsed = parseFrameCaption(raw, input.text.frameFallbackCaption);
            result = { ...frame, ...parsed };
            break;
          } catch (e) {
            if (isAbort(e) || input.signal?.aborted) throw e;
            if (isFatalError(e)) {
              unavailable = true;
              abort.abort();
              throw e;
            }
            if (isRateLimitError(e)) {
              limiter.onRateLimit();
              await sleep(2000 * 2 ** attempt);
            } else {
              await sleep(800 * 2 ** attempt);
            }
          }
        }
      } catch {
        // 兜底：保持 fallback caption（取消/不可用由外层判断）
      }
      out[i] = result;
      done++;
      input.onProgress?.({ phase: 'captions', done, total: frames.length });
    },
    abort.signal,
  );
  throwIfAborted(input.signal);
  if (unavailable) return { frames: [], unavailable: true };
  return { frames: out.filter((f): f is HandoutFrame => !!f), unavailable: false };
}

async function buildOutline(
  input: RunHandoutInput,
  transcript: string,
  durationSec: number,
  runId: string,
): Promise<Outline> {
  let material = transcript;
  if (transcript.length > DIRECT_OUTLINE_MAX_CHARS) {
    const chunks = chunkTranscript(transcript);
    const summaries: string[] = new Array(chunks.length);
    let done = 0;
    await pool(chunks, SECTION_CONCURRENCY, async (chunk, i) => {
      summaries[i] = await withRetry(
        () => api.llmComplete(chunkSummaryPrompt(chunk, input.lang), { runId }),
        input.signal,
      );
      done++;
      input.onProgress?.({ phase: 'outline', done, total: chunks.length + 1 });
    });
    material = summaries.join('\n');
  }

  const fallbackTitle = `${input.mediaName}${input.text.titleSuffix}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await withRetry(
      () => api.llmComplete(outlinePrompt(material, input.mediaName, input.lang), { json: true, runId }),
      input.signal,
    );
    try {
      return parseOutline(raw, durationSec, fallbackTitle);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new HandoutError('outline_failed', lastErr instanceof Error ? lastErr.message : undefined);
}

/** 把 figure 吸附到实际抽到的帧（时间对齐），无对应帧的丢弃 */
export function snapFigures(blocks: Block[], frames: HandoutFrame[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type !== 'figure') {
      out.push(b);
      continue;
    }
    const f = snapToFrame(b.ts, frames);
    if (f) out.push({ ...b, ts: f.ts, caption: b.caption || f.caption });
  }
  return out;
}

async function writeSections(
  input: RunHandoutInput,
  outline: Outline,
  segments: ReturnType<typeof usableSegments>,
  frames: HandoutFrame[],
  fullTranscript: string,
  runId: string,
): Promise<HandoutSection[]> {
  const sections: HandoutSection[] = new Array(outline.sections.length);
  let done = 0;
  input.onProgress?.({ phase: 'writing', done: 0, total: outline.sections.length });
  await pool(outline.sections, SECTION_CONCURRENCY, async (sec, i) => {
    const secSegments = sectionTranscriptWindow(segments, sec);
    const secFrames = sectionFrameWindow(frames, sec);
    const frameNotes = secFrames.map((f) => `- ${formatClock(f.ts)}: ${f.caption}`).join('\n');
    const prompt = sectionPrompt(
      {
        heading: sec.heading,
        points: sec.points,
        transcript: segmentsToTranscript(secSegments) || fullTranscript.slice(0, 3000),
        frameNotes,
        title: outline.title,
        summary: outline.summary,
      },
      input.lang,
    );
    const range = sectionFigureRange(sec);
    let raw = '';
    let blocks: Block[] | null = null;
    for (let attempt = 0; attempt < 2 && !blocks; attempt++) {
      raw = await withRetry(() => api.llmComplete(prompt, { json: true, runId }), input.signal);
      try {
        blocks = parseSectionBlocks(raw, range);
      } catch {
        // IR 校验失败：重试一次
      }
    }
    const finalBlocks = blocks ? snapFigures(blocks, secFrames) : salvageBlocks(raw, input.text.sectionFallback);
    sections[i] = { heading: sec.heading, startSec: sec.startSec, blocks: finalBlocks };
    done++;
    input.onProgress?.({ phase: 'writing', done, total: outline.sections.length });
  });
  return sections;
}

async function saveAsNote(
  input: RunHandoutInput,
  outline: Outline,
  sections: HandoutSection[],
  figureBlobs: Map<number, Blob>,
): Promise<{ noteId: string; figureCount: number }> {
  const { saveTextAsNote } = await import('@/shared/notes/saveTextAsNote');
  const { notesDstuAdapter } = await import('@/dstu/adapters/notesDstuAdapter');
  const base = { resourceId: input.resourceId, title: outline.title, summary: outline.summary, sections, lang: input.lang };

  // 先建纯文字笔记拿到 noteId（笔记资产按 noteId 归档），再存图、回写完整正文；
  // 存图/回写失败时笔记仍保有完整文字内容。
  const created = await saveTextAsNote({
    content: handoutToMarkdown(base),
    title: outline.title,
    folderId: null,
    origin: { kind: 'resource', resourceId: input.resourceId, title: input.mediaName },
  });
  if (created.ok === false) throw new HandoutError('note_failed', created.error);
  if (figureBlobs.size === 0) return { noteId: created.noteId, figureCount: 0 };

  const images = new Map<number, string>();
  let done = 0;
  for (const [ts, blob] of figureBlobs) {
    try {
      images.set(ts, await api.saveNoteImage(created.noteId, await blobToBase64(blob)));
    } catch {
      // 单图失败：省略该图
    }
    done++;
    input.onProgress?.({ phase: 'saving', done, total: figureBlobs.size });
  }
  if (images.size > 0) {
    const updated = await notesDstuAdapter.updateNoteContent(created.noteId, handoutToMarkdown({ ...base, images }));
    if (!updated.ok) return { noteId: created.noteId, figureCount: 0 };
  }
  return { noteId: created.noteId, figureCount: images.size };
}

export async function runHandout(input: RunHandoutInput): Promise<RunHandoutResult> {
  const runId = `handout-${input.resourceId}-${Date.now().toString(36)}`;
  const onAbort = () => void api.cancelRun(runId);
  input.signal?.addEventListener('abort', onAbort);
  try {
    // 1. 字幕
    input.onProgress?.({ phase: 'transcript', done: 0, total: 1 });
    const transcriptData = await api.getMediaTranscript(input.resourceId);
    const segments = usableSegments(transcriptData.segments);
    if (segments.length < MIN_SEGMENTS) throw new HandoutError('no_transcript');
    const transcript = segmentsToTranscript(segments);
    const durationSec = Math.ceil(segments[segments.length - 1].endMs / 1000);
    throwIfAborted(input.signal);

    // 2. 抽帧 + 3. 帧说明（仅视频；失败降级为纯文字讲义）
    let frames: HandoutFrame[] = [];
    let rawFrames: ExtractedFrame[] = [];
    let framesDegraded = false;
    if (input.videoSrc) {
      try {
        rawFrames = await extractFrames(input.videoSrc, {
          signal: input.signal,
          onProgress: (done, total) => input.onProgress?.({ phase: 'frames', done, total }),
        });
      } catch (e) {
        if (input.signal?.aborted) throw new HandoutError('cancelled');
        console.warn('[handout] frame extraction failed, text-only handout', e);
        framesDegraded = true;
      }
      if (rawFrames.length > 0) {
        const captioned = await captionFrames(rawFrames, input, runId);
        framesDegraded = captioned.unavailable;
        frames = captioned.frames.filter((f) => f.isTeaching);
      }
    }
    throwIfAborted(input.signal);

    // 4. 大纲
    input.onProgress?.({ phase: 'outline', done: 0, total: 1 });
    const outline = await buildOutline(input, transcript, durationSec, runId);

    // 5. 分节写作
    const sections = await writeSections(input, outline, segments, frames, transcript, runId);
    throwIfAborted(input.signal);

    // 6. 被引用帧高清重抽（失败用 640px 帧兜底）
    const usedTs = collectFigureTimestamps(sections);
    const figureBlobs = new Map<number, Blob>();
    for (const ts of usedTs) {
      const f = frames.find((x) => x.ts === ts);
      if (f) figureBlobs.set(ts, f.blob);
    }
    if (input.videoSrc && usedTs.length > 0) {
      input.onProgress?.({ phase: 'images', done: 0, total: usedTs.length });
      try {
        const hires = await extractFramesAt(input.videoSrc, usedTs, { signal: input.signal });
        for (const [ts, frame] of hires) figureBlobs.set(ts, frame.blob);
      } catch {
        if (input.signal?.aborted) throw new HandoutError('cancelled');
      }
    }
    throwIfAborted(input.signal);

    // 7. 落为笔记
    input.onProgress?.({ phase: 'saving', done: 0, total: Math.max(1, figureBlobs.size) });
    const saved = await saveAsNote(input, outline, sections, figureBlobs);
    input.onProgress?.({ phase: 'done', done: 1, total: 1 });
    return {
      noteId: saved.noteId,
      title: outline.title,
      sectionCount: sections.length,
      figureCount: saved.figureCount,
      framesDegraded,
    };
  } catch (e) {
    if (input.signal?.aborted || isAbort(e)) throw new HandoutError('cancelled');
    throw e;
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    void api.releaseRun(runId);
  }
}
