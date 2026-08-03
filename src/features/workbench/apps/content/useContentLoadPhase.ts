/**
 * useContentLoadPhase — 资源窗口骨架屏的生命周期状态机（O17）
 *
 * 适配层无法侵入 legacy 视图（UnifiedAppPanel / MindMapContentView）的内部
 * 加载状态，因此用三个外部信号驱动骨架的退场：
 * 1. 数据就绪：legacy 视图在资源加载成功后必然回调 onTitleChange —— 宿主把
 *    首次回调转成 markReady()（loading → fading，淡出后卸载骨架）；
 * 2. 加载失败：legacy 错误 UI 带 role="alert"（UnifiedAppPanel 错误分支 /
 *    AppContentErrorBoundary 崩溃兜底）—— MutationObserver 侦测到即 dismiss()
 *    立刻让位，绝不让骨架盖住错误信息；
 * 3. 安全兜底：超时（缺省 8s）后强制淡出，保证骨架永远不会把窗口锁死
 *    （如 mindmap 非活跃窗口不加载文档、标题回调永不触发的场景）。
 *
 * phase：loading（骨架呈现）→ fading（opacity 过渡中）→ done（骨架卸载）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ContentLoadPhase = 'loading' | 'fading' | 'done';

export interface UseContentLoadPhaseOptions {
  /** 骨架与内容的公共宿主（role="alert" 侦测范围） */
  hostRef: { readonly current: HTMLElement | null };
  /** false 时（如缺 instanceKey 的空态）整个状态机短路为 done */
  enabled?: boolean;
  /** 安全兜底超时（ms），超过后即使无就绪信号也淡出骨架 */
  timeoutMs?: number;
  /** 淡出时长（ms），需 ≥ ContentSkeleton.css 的 opacity 过渡时长 */
  fadeMs?: number;
}

export interface ContentLoadPhaseHandle {
  phase: ContentLoadPhase;
  /** 数据就绪：开始淡出（幂等，后续调用无效果） */
  markReady: () => void;
  /** 立即卸载骨架（错误让位等场景，跳过淡出） */
  dismiss: () => void;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_FADE_MS = 300;

export function useContentLoadPhase(options: UseContentLoadPhaseOptions): ContentLoadPhaseHandle {
  const {
    hostRef,
    enabled = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fadeMs = DEFAULT_FADE_MS,
  } = options;

  const [phase, setPhase] = useState<ContentLoadPhase>(enabled ? 'loading' : 'done');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const fadeTimerRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    if (phaseRef.current === 'done') return;
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    setPhase('done');
  }, []);

  const markReady = useCallback(() => {
    if (phaseRef.current !== 'loading') return;
    setPhase('fading');
    fadeTimerRef.current = window.setTimeout(() => {
      fadeTimerRef.current = null;
      setPhase('done');
    }, fadeMs);
  }, [fadeMs]);

  // 错误让位：宿主子树出现 role="alert" 时立即卸载骨架
  useEffect(() => {
    if (!enabled || phase !== 'loading') return;
    const host = hostRef.current;
    if (!host || typeof MutationObserver === 'undefined') return;

    const hasAlert = () => host.querySelector('[role="alert"]') !== null;
    if (hasAlert()) {
      dismiss();
      return;
    }

    const observer = new MutationObserver(() => {
      if (hasAlert()) {
        observer.disconnect();
        dismiss();
      }
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [enabled, phase, hostRef, dismiss]);

  // 安全兜底超时
  useEffect(() => {
    if (!enabled || phase !== 'loading') return;
    const timer = window.setTimeout(markReady, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [enabled, phase, timeoutMs, markReady]);

  // 卸载清理淡出定时器
  useEffect(
    () => () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
      }
    },
    [],
  );

  return { phase, markReady, dismiss };
}
