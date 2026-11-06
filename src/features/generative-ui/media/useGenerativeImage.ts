/**
 * Generative UI — 图片加载 hook + 预算 context
 *
 * - GenerativeImageBudgetContext：渲染器为每个 intent 提供一个 25MB 预算；缺省（独立使用）时每个
 *   hook 只受单图 10MB 限制。
 * - useGenerativeImage(source, { enabled })：enabled=false（流式中）不发任何请求；
 *   resource / pdf-page → Blob URL（卸载 / 换源时 revoke 并释放预算）；url → 直接返回（不 fetch）。
 */

import React, { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';
import {
  GenerativeImageBudget,
  GENUI_IMAGE_BUDGET_BYTES,
  generativeImageSourceKey,
  resolveGenerativeImage,
  type GenerativeImageFailureReason,
  type ResolveGenerativeImageDeps,
} from './resolveGenerativeImage';
import { generativeImageSourceSchema, type GenerativeImageSource } from '../schema';

export const GenerativeImageBudgetContext = createContext<GenerativeImageBudget | null>(null);

/** 渲染器包一层：同一 intent 内所有图片共享 25MB 预算 */
export function GenerativeImageBudgetProvider({
  limitBytes = GENUI_IMAGE_BUDGET_BYTES,
  children,
}: {
  limitBytes?: number;
  children?: React.ReactNode;
}) {
  const budget = useMemo(() => new GenerativeImageBudget(limitBytes), [limitBytes]);
  return React.createElement(GenerativeImageBudgetContext.Provider, { value: budget }, children);
}

/** 测试注入点：替换解析依赖（invoke / getPdfPageImage） */
export const GenerativeImageDepsContext = createContext<ResolveGenerativeImageDeps | undefined>(undefined);

export type GenerativeImageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; src: string; kind: 'url' | 'blob' }
  | { status: 'error'; reason: GenerativeImageFailureReason };

export interface UseGenerativeImageOptions {
  /** false 时不发请求（流式中） */
  enabled?: boolean;
}

function createObjectUrl(blob: Blob): string | null {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

function revokeObjectUrl(url: string): void {
  try {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

export function useGenerativeImage(
  source: GenerativeImageSource | undefined,
  options: UseGenerativeImageOptions = {},
): GenerativeImageState {
  const enabled = options.enabled !== false;
  const budget = useContext(GenerativeImageBudgetContext);
  const deps = useContext(GenerativeImageDepsContext);
  const holder = useId();
  const parsed = useMemo(() => {
    const result = generativeImageSourceSchema.safeParse(source);
    return result.success ? result.data : null;
  }, [source]);
  const sourceKey = parsed ? generativeImageSourceKey(parsed) : null;
  const [state, setState] = useState<GenerativeImageState>({ status: 'idle' });

  useEffect(() => {
    if (!parsed || !sourceKey) {
      setState(source === undefined ? { status: 'idle' } : { status: 'error', reason: 'invalid_source' });
      return;
    }
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    let reservedKey: string | null = null;
    setState({ status: 'loading' });

    void resolveGenerativeImage(parsed, deps).then((resolution) => {
      if (cancelled) return;
      if ('reason' in resolution) {
        setState({ status: 'error', reason: resolution.reason });
        return;
      }
      if ('src' in resolution) {
        setState({ status: 'ready', src: resolution.src, kind: 'url' });
        return;
      }
      if (budget && !budget.tryReserve(resolution.key, holder, resolution.bytes)) {
        setState({ status: 'error', reason: 'budget_exceeded' });
        return;
      }
      reservedKey = budget ? resolution.key : null;
      objectUrl = createObjectUrl(resolution.blob);
      if (!objectUrl) {
        if (reservedKey) budget?.release(reservedKey, holder);
        reservedKey = null;
        setState({ status: 'error', reason: 'load_failed' });
        return;
      }
      setState({ status: 'ready', src: objectUrl, kind: 'blob' });
    });

    return () => {
      cancelled = true;
      if (objectUrl) revokeObjectUrl(objectUrl);
      if (reservedKey) budget?.release(reservedKey, holder);
    };
    // parsed 由 sourceKey 唯一决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, enabled, budget, deps, holder]);

  return state;
}
