import { useEffect, useMemo, useRef, useState } from 'react';
import {
  streamingMarkdownProfiler,
  type StreamingMarkdownProfiler,
} from './streamingProfiler';

export type StreamingSmoothingPreset = 'realtime' | 'balanced' | 'silky';

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
};

export function resolveStreamingSmoothingPreset(
  preset?: StreamingSmoothingPreset | string | null,
): StreamingSmoothingPreset {
  if (preset === 'realtime' || preset === 'balanced' || preset === 'silky') {
    return preset;
  }
  return DEFAULT_STREAMING_SMOOTHING_PRESET;
}

export function getStreamingSmoothingConfig(
  preset: StreamingSmoothingPreset = DEFAULT_STREAMING_SMOOTHING_PRESET,
): StreamingSmoothingConfig {
  return STREAMING_SMOOTHING_CONFIGS[preset] ?? STREAMING_SMOOTHING_CONFIGS[DEFAULT_STREAMING_SMOOTHING_PRESET];
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
  const delta = Math.min(config.maxChunkChars, Math.max(config.minChunkChars, boostedChunkSize));
  const nextContent = current + target.slice(current.length, current.length + delta);

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
