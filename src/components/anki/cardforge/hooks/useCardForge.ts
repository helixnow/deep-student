/**
 * CardForge 2.0 - React Hook
 *
 * 提供 React 组件集成 CardForge 的便捷 Hook
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { cardAgent, taskController } from '../engines';
import type {
  GenerateCardsInput,
  GenerateCardsOutput,
  AnkiCardResult,
  TaskInfo,
  TaskStatus,
  GenerationStats,
  ControlTaskOutput,
} from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/** CardForge 状态 */
export interface CardForgeState {
  /** 当前文档 ID */
  documentId: string | null;
  /** 是否正在生成 */
  isGenerating: boolean;
  /** 是否已暂停 */
  isPaused: boolean;
  /** 是否已取消 */
  isCancelled: boolean;
  /** 已生成的卡片 */
  cards: AnkiCardResult[];
  /** 任务列表 */
  tasks: TaskInfo[];
  /** 生成统计 */
  stats: GenerationStats | null;
  /** 错误信息 */
  error: string | null;
  /** 当前阶段 */
  phase: 'idle' | 'segmenting' | 'generating' | 'completed' | 'paused' | 'error';
  /** 进度 (0-100) */
  progress: number;
}

/** CardForge Hook 返回值 */
export interface UseCardForgeReturn extends CardForgeState {
  /** 开始生成卡片 */
  generate: (input: GenerateCardsInput) => Promise<GenerateCardsOutput>;
  /** 暂停生成 */
  pause: () => Promise<ControlTaskOutput>;
  /** 恢复生成 */
  resume: () => Promise<ControlTaskOutput>;
  /** 取消生成 */
  cancel: () => Promise<ControlTaskOutput>;
  /** 重试失败任务 */
  retryFailed: () => Promise<ControlTaskOutput>;
  /** 重试单个任务 */
  retryTask: (taskId: string) => Promise<ControlTaskOutput>;
  /** 清空状态 */
  reset: () => void;
  /** 更新卡片 */
  updateCard: (cardId: string, updates: Partial<AnkiCardResult>) => void;
  /** 删除卡片 */
  removeCard: (cardId: string) => void;
  /** 添加卡片（手动） */
  addCard: (card: AnkiCardResult) => void;
}

/** Hook 选项 */
export interface UseCardForgeOptions {
  /** 自动监听事件 */
  autoSubscribe?: boolean;
  /** 生成完成回调 */
  onComplete?: (output: GenerateCardsOutput) => void;
  /** 卡片生成回调 */
  onCardGenerated?: (card: AnkiCardResult) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
  /** 进度回调 */
  onProgress?: (progress: number) => void;
}

// ============================================================================
// 初始状态
// ============================================================================

const initialState: CardForgeState = {
  documentId: null,
  isGenerating: false,
  isPaused: false,
  isCancelled: false,
  cards: [],
  tasks: [],
  stats: null,
  error: null,
  phase: 'idle',
  progress: 0,
};

// ============================================================================
// useCardForge Hook
// ============================================================================

/**
 * useCardForge - CardForge React Hook
 *
 * @example
 * ```tsx
 * function AnkiGenerationPanel() {
 *   const {
 *     isGenerating,
 *     cards,
 *     progress,
 *     generate,
 *     pause,
 *     resume,
 *     cancel,
 *   } = useCardForge({
 *     onCardGenerated: (card) => console.log('New card:', card),
 *     onComplete: (output) => console.log('Done:', output),
 *   });
 *
 *   const handleGenerate = async () => {
 *     await generate({ content: document.body.innerText });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleGenerate} disabled={isGenerating}>
 *         {isGenerating ? `Generating... ${progress}%` : 'Generate Cards'}
 *       </button>
 *       {isGenerating && (
 *         <>
 *           <button onClick={pause}>Pause</button>
 *           <button onClick={cancel}>Cancel</button>
 *         </>
 *       )}
 *       <div>Generated {cards.length} cards</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useCardForge(options: UseCardForgeOptions = {}): UseCardForgeReturn {
  const {
    autoSubscribe = true,
    onComplete,
    onCardGenerated,
    onError,
    onProgress,
  } = options;

  // 状态
  const [state, setState] = useState<CardForgeState>(initialState);

  // 取消订阅函数引用
  const unsubscribesRef = useRef<Array<() => void>>([]);

  // 使用 ref 存储回调函数，避免依赖项变化导致重复订阅
  // 这解决了 P1 问题：如果回调没有 useCallback 包装会导致重复订阅
  const callbacksRef = useRef({
    onCardGenerated,
    onProgress,
    onError,
    onComplete,
  });

  // 更新 ref（不触发重渲染）
  useEffect(() => {
    callbacksRef.current = {
      onCardGenerated,
      onProgress,
      onError,
      onComplete,
    };
  });

  // ==========================================================================
  // 事件订阅
  // ==========================================================================

  useEffect(() => {
    if (!autoSubscribe) return;

    // 订阅卡片生成事件
    const unsubCard = cardAgent.on<{ card: AnkiCardResult }>('card:generated', (event) => {
      const card = event.payload.card;

      setState((prev) => ({
        ...prev,
        cards: [...prev.cards, card],
      }));

      callbacksRef.current.onCardGenerated?.(card);
    });

    // 订阅任务进度事件
    const unsubProgress = cardAgent.on<{ progress: number; status: TaskStatus }>(
      'task:progress',
      (event) => {
        const { progress } = event.payload;
        setState((prev) => ({
          ...prev,
          progress,
        }));
        callbacksRef.current.onProgress?.(progress);
      }
    );

    // 订阅文档开始事件
    const unsubStart = cardAgent.on<{ totalSegments: number }>(
      'document:start',
      (_event) => {
        setState((prev) => ({
          ...prev,
          phase: 'generating',
          isGenerating: true,
        }));
      }
    );

    // 订阅文档完成事件
    const unsubComplete = cardAgent.on('document:complete', () => {
      setState((prev) => ({
        ...prev,
        phase: 'completed',
        isGenerating: false,
        progress: 100,
      }));
    });

    // 订阅文档暂停事件
    const unsubPaused = cardAgent.on('document:paused', () => {
      setState((prev) => ({
        ...prev,
        phase: 'paused',
        isPaused: true,
        isGenerating: false,
      }));
    });

    // 订阅错误事件
    const unsubError = cardAgent.on<{ error: string }>('task:error', (event) => {
      const errorMsg = event.payload.error;
      setState((prev) => ({
        ...prev,
        error: errorMsg,
      }));
      callbacksRef.current.onError?.(errorMsg);
    });

    unsubscribesRef.current = [
      unsubCard,
      unsubProgress,
      unsubStart,
      unsubComplete,
      unsubPaused,
      unsubError,
    ];

    return () => {
      unsubscribesRef.current.forEach((unsub) => unsub());
      unsubscribesRef.current = [];
    };
  }, [autoSubscribe]); // 依赖项只保留 autoSubscribe，回调通过 ref 访问

  // ==========================================================================
  // 操作方法
  // ==========================================================================

  /** 开始生成 */
  const generate = useCallback(
    async (input: GenerateCardsInput): Promise<GenerateCardsOutput> => {
      // 重置状态
      setState({
        ...initialState,
        isGenerating: true,
        phase: 'segmenting',
      });

      try {
        const result = await cardAgent.generateCards(input);

        if (result.ok) {
          const isPaused = !!result.paused;
          setState((prev) => ({
            ...prev,
            documentId: result.documentId || null,
            cards: result.cards || [],
            stats: result.stats || null,
            phase: isPaused ? 'paused' : 'completed',
            isGenerating: false,
            isPaused,
            progress: isPaused ? prev.progress : 100,
          }));
          if (!isPaused) {
            callbacksRef.current.onComplete?.(result);
          }
        } else {
          setState((prev) => ({
            ...prev,
            error: result.error || 'Unknown error',
            phase: 'error',
            isGenerating: false,
          }));
          callbacksRef.current.onError?.(result.error || 'Unknown error');
        }

        return result;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        setState((prev) => ({
          ...prev,
          error: errorMsg,
          phase: 'error',
          isGenerating: false,
        }));
        callbacksRef.current.onError?.(errorMsg);
        return { ok: false, error: errorMsg };
      }
    },
    [] // 移除回调依赖，通过 ref 访问
  );

  /** 暂停 */
  const pause = useCallback(async (): Promise<ControlTaskOutput> => {
    if (!state.documentId) {
      return { ok: false, message: 'documentId is required' };
    }

    const result = await taskController.pause(state.documentId);
    if (result.ok) {
      setState((prev) => ({
        ...prev,
        isPaused: true,
        isGenerating: false,
        phase: 'paused',
      }));
    }
    return result;
  }, [state.documentId]);

  /** 恢复 */
  const resume = useCallback(async (): Promise<ControlTaskOutput> => {
    if (!state.documentId) {
      return { ok: false, message: 'documentId is required' };
    }

    const result = await taskController.resume(state.documentId);
    if (result.ok) {
      setState((prev) => ({
        ...prev,
        isPaused: false,
        isGenerating: true,
        phase: 'generating',
        tasks: result.tasks || prev.tasks,
      }));
    }
    return result;
  }, [state.documentId]);

  /** 取消 */
  const cancel = useCallback(async (): Promise<ControlTaskOutput> => {
    if (!state.documentId) {
      return { ok: false, message: 'documentId is required' };
    }

    const result = await taskController.cancel(state.documentId);
    if (result.ok) {
      setState((prev) => ({
        ...prev,
        isCancelled: true,
        isGenerating: false,
        phase: 'idle',
      }));
    }
    return result;
  }, [state.documentId]);

  /** 重试所有失败任务 */
  const retryFailed = useCallback(async (): Promise<ControlTaskOutput> => {
    if (!state.documentId) {
      return { ok: false, message: 'documentId is required' };
    }

    const result = await taskController.retryAllFailed(state.documentId);
    if (result.ok) {
      setState((prev) => ({
        ...prev,
        isGenerating: true,
        phase: 'generating',
        error: null,
      }));
    }
    return result;
  }, [state.documentId]);

  /** 重试单个任务 */
  const retryTask = useCallback(
    async (taskId: string): Promise<ControlTaskOutput> => {
      if (!state.documentId) {
        return { ok: false, message: 'documentId is required' };
      }

      const result = await taskController.retry(state.documentId, taskId);
      if (result.ok) {
        setState((prev) => ({
          ...prev,
          tasks: result.tasks || prev.tasks,
        }));
      }
      return result;
    },
    [state.documentId]
  );

  /** 重置状态 */
  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  /** 更新卡片 */
  const updateCard = useCallback(
    (cardId: string, updates: Partial<AnkiCardResult>) => {
      setState((prev) => ({
        ...prev,
        cards: prev.cards.map((card) =>
          card.id === cardId ? { ...card, ...updates } : card
        ),
      }));
    },
    []
  );

  /** 删除卡片 */
  const removeCard = useCallback((cardId: string) => {
    setState((prev) => ({
      ...prev,
      cards: prev.cards.filter((card) => card.id !== cardId),
    }));
  }, []);

  /** 添加卡片 */
  const addCard = useCallback((card: AnkiCardResult) => {
    setState((prev) => ({
      ...prev,
      cards: [...prev.cards, card],
    }));
  }, []);

  // ==========================================================================
  // 返回
  // ==========================================================================

  return {
    // 状态
    ...state,
    // 操作
    generate,
    pause,
    resume,
    cancel,
    retryFailed,
    retryTask,
    reset,
    updateCard,
    removeCard,
    addCard,
  };
}

// ============================================================================
// 导出
// ============================================================================

export default useCardForge;
