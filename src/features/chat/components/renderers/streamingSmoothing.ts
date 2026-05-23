import { useEffect, useMemo, useRef, useState } from 'react';
import {
  streamingMarkdownProfiler,
  type StreamingMarkdownProfiler,
} from './streamingProfiler';

export type StreamingSmoothingPreset = 'natural' | 'realtime' | 'balanced' | 'silky' | 'fluid';

export interface StreamingSmoothingConfig {
  /** Legacy: 单帧间隔（ms），保留以兼容旧 setTimeout 路径与既有测试 */
  frameMs: number;
  /** 单帧最小推进字符数 */
  minChunkChars: number;
  /** 单帧最大推进字符数 */
  maxChunkChars: number;
  /** backlog 超过该阈值时启动加速 */
  backlogBoostThreshold: number;
  /** 末尾余量小于该值直接 flush，避免 trailing 尾巴 */
  tailFlushChars: number;
  /** rAF 模式：目标字符吞吐（chars/s），按 dt 动态推进 */
  charsPerSecond: number;
  /** rAF 模式：单帧时间预算（ms），用于自我观测每帧成本 */
  frameBudgetMs: number;
  /** 两次 React commit 之间的最小间隔（ms）；用于减少 ReactMarkdown 的重渲染压力 */
  commitIntervalMs: number;
  /** 是否对齐到词边界后再 commit；CJK/标点边界优先 */
  commitOnWordBoundary: boolean;
}

export type StreamingSmoothingStepReason = 'append' | 'complete' | 'noop' | 'reset';

export interface StreamingSmoothingStep {
  content: string;
  delta: number;
  remaining: number;
  reason: StreamingSmoothingStepReason;
}

export interface UseSmoothedStreamingContentOptions {
  preset?: StreamingSmoothingPreset | string | null;
  enabled?: boolean;
  profiler?: StreamingMarkdownProfiler;
  blockId?: string;
  messageId?: string;
}

// 行业最优解（2026）：默认 balanced。
// 既保留流式即时感，也把碎 chunk 适度合并，配合块级渐显更像“内容长出来”。
const DEFAULT_STREAMING_SMOOTHING_PRESET: StreamingSmoothingPreset = 'balanced';

/**
 * Preset 设计说明（rAF + 时间预算 + commit gate）
 * - charsPerSecond: 期望吞吐，决定基础推进速度
 * - frameBudgetMs:  单帧目标耗时上限，超过则 jank+1
 * - minChunkChars/maxChunkChars: 单帧推进的硬上下限，防止极端跳动
 * - backlogBoostThreshold: backlog 大时按 (remaining/4) 加速消化
 * - tailFlushChars: 末尾小尾巴直接 flush，避免"还差几个字符"的视觉抖动
 * - commitIntervalMs: 两次 setState 之间的最小间隔；rAF 仍以 16ms 计算位置，
 *                    但只有间隔达到该值或落在词边界时才触发 React 重渲染。
 *                    解决"每帧都重跑 ReactMarkdown 管线"的卡顿。
 * - commitOnWordBoundary: 当推进刚好越过词边界（空格/标点/CJK）立刻 commit。
 *
 * natural: 直通模式，文本即来即显。
 * balanced: 默认档位，适度合并 chunk，配合渐显更自然。
 * 其它预设按"丝滑度→速度"递进。
 */
const STREAMING_SMOOTHING_CONFIGS: Record<StreamingSmoothingPreset, StreamingSmoothingConfig> = {
  natural: {
    frameMs: 0,
    minChunkChars: 1,
    maxChunkChars: 9999,
    backlogBoostThreshold: 0,
    tailFlushChars: 0,
    charsPerSecond: 99999,
    frameBudgetMs: 16,
    commitIntervalMs: 0,
    commitOnWordBoundary: false,
  },
  realtime: {
    frameMs: 16,
    minChunkChars: 4,
    maxChunkChars: 96,
    backlogBoostThreshold: 160,
    tailFlushChars: 12,
    charsPerSecond: 900,
    frameBudgetMs: 4,
    commitIntervalMs: 16,
    commitOnWordBoundary: true,
  },
  balanced: {
    frameMs: 28,
    minChunkChars: 2,
    maxChunkChars: 42,
    backlogBoostThreshold: 96,
    tailFlushChars: 8,
    charsPerSecond: 480,
    frameBudgetMs: 6,
    commitIntervalMs: 32,
    commitOnWordBoundary: true,
  },
  silky: {
    frameMs: 36,
    minChunkChars: 1,
    maxChunkChars: 18,
    backlogBoostThreshold: 56,
    tailFlushChars: 4,
    charsPerSecond: 240,
    frameBudgetMs: 8,
    commitIntervalMs: 48,
    commitOnWordBoundary: true,
  },
  fluid: {
    frameMs: 20,
    minChunkChars: 3,
    maxChunkChars: 64,
    backlogBoostThreshold: 120,
    tailFlushChars: 16,
    charsPerSecond: 600,
    frameBudgetMs: 5,
    commitIntervalMs: 24,
    commitOnWordBoundary: true,
  },
};

export function resolveStreamingSmoothingPreset(
  preset?: StreamingSmoothingPreset | string | null,
): StreamingSmoothingPreset {
  if (
    preset === 'natural' ||
    preset === 'realtime' ||
    preset === 'balanced' ||
    preset === 'silky' ||
    preset === 'fluid'
  ) {
    return preset;
  }
  return DEFAULT_STREAMING_SMOOTHING_PRESET;
}

export function getStreamingSmoothingConfig(
  preset: StreamingSmoothingPreset = DEFAULT_STREAMING_SMOOTHING_PRESET,
): StreamingSmoothingConfig {
  return STREAMING_SMOOTHING_CONFIGS[preset] ?? STREAMING_SMOOTHING_CONFIGS[DEFAULT_STREAMING_SMOOTHING_PRESET];
}

/**
 * 在给定位置附近寻找词边界（空格、标点）。
 * 中文不再按单字边界切分，改由 chunk 尺度和节奏自然推进，避免打字机感。
 */
function snapToWordBoundary(text: string, fromIndex: number, rawEnd: number): number {
  if (rawEnd >= text.length) return text.length;

  const searchStart = Math.max(fromIndex, rawEnd - 12);
  for (let i = rawEnd; i > searchStart; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' ||
        ch === ',' || ch === '.' || ch === ';' || ch === ':' ||
        ch === '、' || ch === '，' || ch === '。' || ch === '；' ||
        ch === '：' || ch === '！' || ch === '？') {
      return i + 1;
    }
  }

  const searchEnd = Math.min(text.length, rawEnd + 6);
  for (let i = rawEnd; i < searchEnd; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' ||
        ch === ',' || ch === '.' || ch === ';' || ch === ':' ||
        ch === '、' || ch === '，' || ch === '。' || ch === '；' ||
        ch === '：' || ch === '！' || ch === '？') {
      return i + 1;
    }
  }

  return rawEnd;
}

/**
 * 仅按 chunk 大小推进（兼容旧路径与既有测试）。
 */
export function computeNextSmoothedContent(
  current: string,
  target: string,
  config: StreamingSmoothingConfig,
): StreamingSmoothingStep {
  if (current === target) {
    return { content: current, delta: 0, remaining: 0, reason: 'noop' };
  }
  if (!target.startsWith(current)) {
    return { content: target, delta: target.length - current.length, remaining: 0, reason: 'reset' };
  }

  const remaining = target.length - current.length;
  const shouldFlushTail = remaining <= Math.max(config.minChunkChars, config.tailFlushChars);
  if (shouldFlushTail) {
    return { content: target, delta: remaining, remaining: 0, reason: 'complete' };
  }

  const boostedChunkSize =
    remaining > config.backlogBoostThreshold
      ? Math.ceil(remaining / 4)
      : config.minChunkChars;
  const rawDelta = Math.min(config.maxChunkChars, Math.max(config.minChunkChars, boostedChunkSize));
  const rawEnd = current.length + rawDelta;

  const snappedEnd = snapToWordBoundary(target, current.length, rawEnd);
  const delta = snappedEnd - current.length;
  const nextContent = target.slice(0, snappedEnd);

  return {
    content: nextContent,
    delta,
    remaining: target.length - nextContent.length,
    reason: 'append',
  };
}

/**
 * 按时间预算推进（rAF 驱动）。
 * - dtMs: 自上一帧起经过的实际时间
 * - 推进量 = clamp(cps * dt, [minChunkChars, maxChunkChars])
 * - backlog 大时按 remaining/4 加速消化
 * - 余量小于 tailFlushChars 时一次 flush
 */
export function computeNextSmoothedContentByTime(
  current: string,
  target: string,
  config: StreamingSmoothingConfig,
  dtMs: number,
): StreamingSmoothingStep {
  if (current === target) {
    return { content: current, delta: 0, remaining: 0, reason: 'noop' };
  }
  if (!target.startsWith(current)) {
    return { content: target, delta: target.length - current.length, remaining: 0, reason: 'reset' };
  }

  const remaining = target.length - current.length;
  const tailFlush = Math.max(config.minChunkChars, config.tailFlushChars);
  if (remaining <= tailFlush) {
    return { content: target, delta: remaining, remaining: 0, reason: 'complete' };
  }

  const dt = Math.max(1, Math.min(dtMs, 64));
  let advance = (config.charsPerSecond * dt) / 1000;
  if (remaining > config.backlogBoostThreshold) {
    advance = Math.max(advance, Math.ceil(remaining / 4));
  }

  const rawDelta = Math.min(
    config.maxChunkChars,
    Math.max(config.minChunkChars, Math.round(advance)),
  );
  const rawEnd = current.length + rawDelta;
  const snappedEnd = snapToWordBoundary(target, current.length, rawEnd);
  const delta = snappedEnd - current.length;
  const nextContent = target.slice(0, snappedEnd);

  return {
    content: nextContent,
    delta,
    remaining: target.length - nextContent.length,
    reason: 'append',
  };
}

// ─── Shared rAF scheduler ─────────────────────────────────────────────────────
// 所有正在流式的块共用一个 RAF tick，避免每个 hook 各起一个 rAF 抢调度。
// 每帧带预算上限 16ms，超过即在下一帧继续，给浏览器布局/绘制留余量。

type RafTask = (timestamp: number, dtMs: number) => void;

interface RafScheduler {
  add: (task: RafTask) => () => void;
  size: () => number;
}

const TICK_BUDGET_MS = 12; // 每个 tick 处理任务的硬预算

function createRafScheduler(): RafScheduler {
  const tasks = new Set<RafTask>();
  let rafId: number | null = null;
  let lastTs = 0;

  const tick = (ts: number) => {
    rafId = null;
    const dt = lastTs === 0 ? 16 : ts - lastTs;
    lastTs = ts;
    const start = performance.now();

    // 复制一份避免 task 内增删 set 引发遍历问题
    const snapshot = Array.from(tasks);
    for (const task of snapshot) {
      try {
        task(ts, dt);
      } catch (err) {
        // 单个任务异常不污染整个 tick
        // eslint-disable-next-line no-console
        console.warn('[stream-smoothing] task error', err);
      }
      if (performance.now() - start > TICK_BUDGET_MS) break;
    }

    if (tasks.size > 0) {
      schedule();
    } else {
      lastTs = 0;
    }
  };

  const schedule = () => {
    if (rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      // 测试或非浏览器环境兜底
      rafId = setTimeout(() => tick(performance.now()), 16) as unknown as number;
    } else {
      rafId = requestAnimationFrame(tick);
    }
  };

  return {
    add(task) {
      tasks.add(task);
      schedule();
      return () => {
        tasks.delete(task);
        if (tasks.size === 0 && rafId !== null) {
          if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(rafId);
          } else {
            clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
          }
          rafId = null;
          lastTs = 0;
        }
      };
    },
    size: () => tasks.size,
  };
}

const sharedRafScheduler = createRafScheduler();

declare global {
  interface Window {
    __DEEP_STUDENT_RAF_SCHEDULER__?: RafScheduler;
  }
}

if (typeof window !== 'undefined') {
  window.__DEEP_STUDENT_RAF_SCHEDULER__ = sharedRafScheduler;
}

// ─── Reduced motion detection ─────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ─── Word boundary detection (used by commit gate) ───────────────────────────

const WORD_BOUNDARY_CHARS = new Set([
  ' ', '\n', '\t', '\r',
  ',', '.', ';', ':', '!', '?', ')', ']', '}', '"', "'",
  '、', '，', '。', '；', '：', '！', '？', '）', '】', '』', '」', '"', '"',
]);

function isWordBoundaryEnd(text: string, end: number): boolean {
  if (end <= 0 || end > text.length) return false;
  const ch = text[end - 1];
  if (WORD_BOUNDARY_CHARS.has(ch)) return true;
  // 末尾恰好是文本末尾
  if (end === text.length) return true;
  return false;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSmoothedStreamingContent(
  content: string,
  isStreaming: boolean,
  options: UseSmoothedStreamingContentOptions = {},
): string {
  const preset = resolveStreamingSmoothingPreset(options.preset);
  const config = useMemo(() => getStreamingSmoothingConfig(preset), [preset]);
  const profiler = options.profiler ?? streamingMarkdownProfiler;
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const smoothingEnabled =
    (options.enabled ?? true) && !reducedMotion && preset !== 'natural';

  const [displayedContent, setDisplayedContent] = useState(content);
  const displayedRef = useRef(content);
  const targetRef = useRef(content);
  targetRef.current = content;

  // 内部"已推进位置"——可能比 displayedRef 领先（rAF 在算，但 React 还没 commit）
  const advancedRef = useRef(content.length);
  const lastCommitTsRef = useRef(0);

  useEffect(() => {
    if (!isStreaming || !smoothingEnabled) {
      displayedRef.current = content;
      advancedRef.current = content.length;
      lastCommitTsRef.current = 0;
      setDisplayedContent(content);
      profiler.record({
        type: 'flush',
        preset,
        targetLength: content.length,
        displayedLength: content.length,
        blockId: options.blockId,
        messageId: options.messageId,
      });
      return undefined;
    }

    profiler.record({
      type: 'target',
      preset,
      targetLength: content.length,
      displayedLength: displayedRef.current.length,
      blockId: options.blockId,
      messageId: options.messageId,
    });

    // 若 target 不再以已显示内容为前缀（reset 场景），重置内部推进位置
    if (!content.startsWith(displayedRef.current)) {
      displayedRef.current = '';
      advancedRef.current = 0;
    }

    const task: RafTask = (ts, dtMs) => {
      const target = targetRef.current;
      const remaining = target.length - advancedRef.current;
      if (remaining <= 0) {
        // 推进追上 target；若 displayed 还没追上就 commit 一次再退出
        if (displayedRef.current.length < advancedRef.current) {
          const next = target.slice(0, advancedRef.current);
          displayedRef.current = next;
          setDisplayedContent(next);
          profiler.record({
            type: 'flush',
            preset,
            targetLength: target.length,
            displayedLength: next.length,
          });
        }
        unsubscribe();
        return;
      }

      // 1) 计算本帧推进量
      const tailFlush = Math.max(config.minChunkChars, config.tailFlushChars);
      let advance: number;
      if (remaining <= tailFlush) {
        advance = remaining;
      } else {
        const dt = Math.max(1, Math.min(dtMs, 64));
        let raw = (config.charsPerSecond * dt) / 1000;
        if (remaining > config.backlogBoostThreshold) {
          raw = Math.max(raw, Math.ceil(remaining / 4));
        }
        advance = Math.min(
          remaining,
          Math.max(config.minChunkChars, Math.min(config.maxChunkChars, Math.round(raw))),
        );
      }

      let nextEnd = advancedRef.current + advance;
      // 对齐到词边界（除非已经能 flush 完整 target）
      if (nextEnd < target.length) {
        nextEnd = snapToWordBoundary(target, advancedRef.current, nextEnd);
      }
      advancedRef.current = nextEnd;

      // 2) Commit gate：达到 commitInterval 或落在词边界（或追平 target）才 setState
      const sinceCommit = ts - lastCommitTsRef.current;
      const reachedTarget = nextEnd >= target.length;
      const onBoundary =
        config.commitOnWordBoundary && isWordBoundaryEnd(target, nextEnd);
      const intervalMet =
        config.commitIntervalMs <= 0 || sinceCommit >= config.commitIntervalMs;

      const shouldCommit = reachedTarget || (intervalMet && (onBoundary || sinceCommit >= config.commitIntervalMs * 2));

      if (shouldCommit && nextEnd > displayedRef.current.length) {
        const nextContent = target.slice(0, nextEnd);
        const delta = nextContent.length - displayedRef.current.length;
        displayedRef.current = nextContent;
        lastCommitTsRef.current = ts;
        setDisplayedContent(nextContent);
        profiler.record({
          type: 'display',
          preset,
          targetLength: target.length,
          displayedLength: nextContent.length,
          delta,
          remaining: target.length - nextContent.length,
          reason: reachedTarget ? 'complete' : 'append',
          blockId: options.blockId,
          messageId: options.messageId,
        });
      }

      if (reachedTarget && displayedRef.current.length >= target.length) {
        unsubscribe();
      }
    };

    const unsubscribe = sharedRafScheduler.add(task);
    return unsubscribe;
  }, [
    config,
    content,
    isStreaming,
    options.blockId,
    options.messageId,
    preset,
    profiler,
    smoothingEnabled,
  ]);

  return isStreaming && smoothingEnabled ? displayedContent : content;
}
