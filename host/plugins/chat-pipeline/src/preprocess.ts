export const AUXILIARY_MM_STAGE_TIMEOUT_MS = 30_000;
export const OCR_STAGE_TIMEOUT_MS = 45_000;
export const VISUAL_PREPROCESS_TURN_BUDGET_MS = 75_000;
export const UNAVAILABLE_IMAGE_OBSERVATION = '[图片内容当前不可解析：没有健康的多模态辅助模型或 OCR 引擎。原图引用已保留，可在能力恢复后重试。]';

export type ContextImageCompileStrategy = 'noImages' | 'multimodalDirect' | 'textModelPreprocess';
export function contextImageCompileStrategy(modelIsMultimodal: boolean, hasImages: boolean): ContextImageCompileStrategy {
  return !hasImages ? 'noImages' : modelIsMultimodal ? 'multimodalDirect' : 'textModelPreprocess';
}
export function finalizeVisualObservation(observation: string | null): [string, boolean] {
  return observation === null ? [UNAVAILABLE_IMAGE_OBSERVATION, false] : [observation, true];
}
export type PreprocessStageError = { kind: 'cancelled' } | { kind: 'timedOut' } | { kind: 'failed'; error: unknown };
export type PreprocessStageResult<T> = { ok: true; value: T } | { ok: false; error: PreprocessStageError };

/** Deadlines use monotonic performance.now() milliseconds. Rust preprocess.rs:46-77. */
export async function runPreprocessStage<T>(parent: AbortSignal | null, turnDeadline: number,
  stageTimeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<PreprocessStageResult<T>> {
  const now = performance.now();
  if (now >= turnDeadline) return { ok: false, error: { kind: 'timedOut' } };
  const deadline = Math.min(turnDeadline, now + stageTimeout);
  const stage = new AbortController();
  const onParentAbort = () => stage.abort();
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) stage.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: (() => void) | undefined;
  try {
    // tokio::select! is biased towards cancellation and does not poll an already-cancelled operation.
    if (stage.signal.aborted) return { ok: false, error: { kind: 'cancelled' } };
    const cancelled = new Promise<PreprocessStageResult<T>>(resolve => {
      onCancel = () => resolve({ ok: false, error: { kind: 'cancelled' } });
      stage.signal.addEventListener('abort', onCancel, { once: true });
    });
    const timedOut = new Promise<PreprocessStageResult<T>>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, error: { kind: 'timedOut' } }), Math.max(0, deadline - performance.now()));
    });
    const work = Promise.resolve().then<PreprocessStageResult<T>>(() => {
      if (stage.signal.aborted) return { ok: false as const, error: { kind: 'cancelled' as const } };
      return operation(stage.signal).then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error: { kind: 'failed' as const, error } }),
      );
    });
    return await Promise.race([cancelled, work, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onCancel) stage.signal.removeEventListener('abort', onCancel);
    parent?.removeEventListener('abort', onParentAbort);
    stage.abort();
  }
}
