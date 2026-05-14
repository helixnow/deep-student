import { useEffect, useMemo, useRef, useState } from 'react';
import {
  streamingMarkdownProfiler,
  type StreamingMarkdownProfiler,
} from './streamingProfiler';

export type StreamingSmoothingPreset = 'realtime' | 'balanced' | 'silky' | 'fluid';

export interface StreamingSmoothingConfig {
  frameMs: number;
  minChunkChars: number;
  maxChunkChars: number;
  backlogBoostThreshold: number;
  tailFlushChars: number;
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

const DEFAULT_STREAMING_SMOOTHING_PRESET: StreamingSmoothingPreset = 'balanced';

const STREAMING_SMOOTHING_CONFIGS: Record<StreamingSmoothingPreset, StreamingSmoothingConfig> = {
  realtime: {
    frameMs: 16,
    minChunkChars: 12,
    maxChunkChars: 96,
    backlogBoostThreshold: 160,
    tailFlushChars: 12,
  },
  balanced: {
    frameMs: 28,
    minChunkChars: 5,
    maxChunkChars: 42,
    backlogBoostThreshold: 96,
    tailFlushChars: 8,
  },
  silky: {
    frameMs: 36,
    minChunkChars: 2,
    maxChunkChars: 18,
    backlogBoostThreshold: 56,
    tailFlushChars: 4,
  },
  fluid: {
    frameMs: 20,
    minChunkChars: 8,
    maxChunkChars: 64,
    backlogBoostThreshold: 120,
    tailFlushChars: 16,
  },
};

export function resolveStreamingSmoothingPreset(
  preset?: StreamingSmoothingPreset | string | null,
): StreamingSmoothingPreset {
  if (preset === 'realtime' || preset === 'balanced' || preset === 'silky' || preset === 'fluid') {
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
 * 在给定位置附近寻找词边界（空格、标点、CJK 字符边界），
 * 避免在单词中间截断，产生更自然的"词组淡入"效果。
 */
function snapToWordBoundary(text: string, fromIndex: number, rawEnd: number): number {
  // 如果 rawEnd 已经在文本末尾或超出，直接返回
  if (rawEnd >= text.length) return text.length;

  // 向前搜索最近的词边界（最多回退 12 字符）
  const searchStart = Math.max(fromIndex, rawEnd - 12);
  for (let i = rawEnd; i > searchStart; i--) {
    const ch = text[i];
    // 空格、标点、CJK 字符后都是自然断点
    if (ch === ' ' || ch === '\n' || ch === '\t' ||
        ch === ',' || ch === '.' || ch === ';' || ch === ':' ||
        ch === '、' || ch === '，' || ch === '。' || ch === '；' ||
        ch === '：' || ch === '！' || ch === '？') {
      return i + 1; // 包含该分隔符
    }
    // CJK 字符本身就是词边界
    const code = ch.charCodeAt(0);
    if (code >= 0x3000 && code <= 0x9fff) {
      return i + 1;
    }
  }

  // 向后搜索（最多前进 6 字符）
  const searchEnd = Math.min(text.length, rawEnd + 6);
  for (let i = rawEnd; i < searchEnd; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' ||
        ch === ',' || ch === '.' || ch === ';' || ch === ':' ||
        ch === '、' || ch === '，' || ch === '。' || ch === '；' ||
        ch === '：' || ch === '！' || ch === '？') {
      return i + 1;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x3000 && code <= 0x9fff) {
      return i + 1;
    }
  }

  // 找不到合适的边界，使用原始位置
  return rawEnd;
}

export function computeNextSmoothedContent(
  current: string,
  target: string,
  config: StreamingSmoothingConfig,
): StreamingSmoothingStep {
  if (current === target) {
    return {
      content: current,
      delta: 0,
      remaining: 0,
      reason: 'noop',
    };
  }

  if (!target.startsWith(current)) {
    return {
      content: target,
      delta: target.length - current.length,
      remaining: 0,
      reason: 'reset',
    };
  }

  const remaining = target.length - current.length;
  const shouldFlushTail = remaining <= Math.max(config.minChunkChars, config.tailFlushChars);
  if (shouldFlushTail) {
    return {
      content: target,
      delta: remaining,
      remaining: 0,
      reason: 'complete',
    };
  }

  const boostedChunkSize =
    remaining > config.backlogBoostThreshold
      ? Math.ceil(remaining / 4)
      : config.minChunkChars;
  const rawDelta = Math.min(config.maxChunkChars, Math.max(config.minChunkChars, boostedChunkSize));
  const rawEnd = current.length + rawDelta;

  // 对齐到词边界，产生更自然的词组级释放
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

export function useSmoothedStreamingContent(
  content: string,
  isStreaming: boolean,
  options: UseSmoothedStreamingContentOptions = {},
): string {
  const preset = resolveStreamingSmoothingPreset(options.preset);
  const config = useMemo(() => getStreamingSmoothingConfig(preset), [preset]);
  const profiler = options.profiler ?? streamingMarkdownProfiler;
  const smoothingEnabled = options.enabled ?? true;
  const [displayedContent, setDisplayedContent] = useState(content);
  const displayedRef = useRef(content);

  useEffect(() => {
    if (!isStreaming || !smoothingEnabled) {
      displayedRef.current = content;
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

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    profiler.record({
      type: 'target',
      preset,
      targetLength: content.length,
      displayedLength: displayedRef.current.length,
      blockId: options.blockId,
      messageId: options.messageId,
    });

    const runStep = () => {
      if (cancelled) return;
      const step = computeNextSmoothedContent(displayedRef.current, content, config);

      if (step.reason !== 'noop') {
        displayedRef.current = step.content;
        setDisplayedContent(step.content);
        profiler.record({
          type: 'display',
          preset,
          targetLength: content.length,
          displayedLength: step.content.length,
          delta: step.delta,
          remaining: step.remaining,
          reason: step.reason,
          blockId: options.blockId,
          messageId: options.messageId,
        });
      }

      if (step.content !== content) {
        timerId = setTimeout(runStep, config.frameMs);
      }
    };

    runStep();

    return () => {
      cancelled = true;
      if (timerId) {
        clearTimeout(timerId);
      }
    };
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
