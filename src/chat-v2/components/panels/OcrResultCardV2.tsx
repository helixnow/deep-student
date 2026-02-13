/**
 * Chat V2 - OcrResultCardV2
 *
 * V2 封装组件，从 Store modeState 订阅 OCR 数据
 * 保持 OcrResultCard 为纯展示组件
 *
 * 功能：
 * 1. 从 store.modeState 订阅 AnalysisModeState
 * 2. 实现图片点击预览（触发 chat-v2:preview-image 事件）
 * 3. 实现学习笔记变更（通过 store.updateModeState）
 * 4. 渲染 OcrResultCard 纯展示组件
 *
 * 架构约束：
 * - 遵循 SSOT 原则，所有状态从 Store 订阅
 * - 使用细粒度选择器避免不必要重渲染
 * - 正确处理组件生命周期（卸载时清理）
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { OcrResultCard } from './OcrResultCard';
import type { ChatStore } from '../../core/types';
import type { AnalysisModeState, OcrMeta } from '../../plugins/modes/analysis';

// ============================================================================
// 类型定义
// ============================================================================

export interface OcrResultCardV2Props {
  /** V2 Store 实例 */
  store: StoreApi<ChatStore>;
  /** 额外的操作按钮（可选） */
  actions?: React.ReactNode;
  /** 标签操作按钮（可选） */
  tagActions?: React.ReactNode;
  /** 聊天总结（可选，从消息中获取） */
  summary?: string | null;
}

// ============================================================================
// 类型说明
// ============================================================================

/**
 * AnalysisModeState 已在 analysis.ts 中定义以下字段：
 * - note?: string | null - 学习笔记内容（持久化）
 * - noteError?: string | null - 笔记保存错误
 *
 * 本组件直接使用 AnalysisModeState 类型
 */

// ============================================================================
// 事件名称常量（导出供外部监听使用）
// ============================================================================

/**
 * 图片预览事件名称
 *
 * 事件 detail 结构: { images: string[], index: number }
 *
 * @example
 * // 在容器组件中监听此事件
 * useEffect(() => {
 *   const handler = (e: CustomEvent<{ images: string[], index: number }>) => {
 *     openImagePreview(e.detail.images, e.detail.index);
 *   };
 *   window.addEventListener(PREVIEW_IMAGE_EVENT, handler as EventListener);
 *   return () => window.removeEventListener(PREVIEW_IMAGE_EVENT, handler as EventListener);
 * }, []);
 */
export const PREVIEW_IMAGE_EVENT = 'chat-v2:preview-image';

/** 图片预览事件 detail 类型 */
export interface PreviewImageEventDetail {
  images: string[];
  index: number;
}

// ============================================================================
// 图片预览事件触发
// ============================================================================

/**
 * 触发图片预览事件
 */
function dispatchPreviewImageEvent(images: string[], index: number): void {
  const event = new CustomEvent(PREVIEW_IMAGE_EVENT, {
    detail: { images, index },
    bubbles: true,
  });
  window.dispatchEvent(event);
}

// ============================================================================
// 稳定引用常量（避免重渲染）
// ============================================================================

/** 空图片数组常量，避免每次返回新引用 */
const EMPTY_IMAGES: string[] = [];

// ============================================================================
// 细粒度选择器（避免不必要重渲染）
// ============================================================================

/**
 * 从 modeState 提取 OCR 相关数据的选择器
 * 使用 useShallow 进行浅比较，只在实际数据变化时触发重渲染
 */
function useOcrDataSelector(store: StoreApi<ChatStore>) {
  return useStore(
    store,
    useShallow((s: ChatStore) => {
      const modeState = s.modeState as unknown as AnalysisModeState | null;
      return {
        mode: s.mode,
        ocrStatus: modeState?.ocrStatus ?? null,
        ocrMeta: modeState?.ocrMeta ?? null,
        images: modeState?.images ?? EMPTY_IMAGES,
        note: modeState?.note ?? '',
        noteError: modeState?.noteError ?? null,
      };
    })
  );
}

// ============================================================================
// OcrResultCardV2 组件
// ============================================================================

/**
 * OcrResultCardV2 - V2 封装组件
 *
 * 从 Store 订阅 OCR 数据，渲染 OcrResultCard 纯展示组件
 *
 * ⚠️ 架构约束：
 * - 所有 Hooks 必须在条件返回之前调用（React Hooks 规则）
 * - 组件卸载时必须清理所有异步操作
 * - 使用细粒度选择器避免不必要重渲染
 */
export const OcrResultCardV2: React.FC<OcrResultCardV2Props> = ({
  store,
  actions,
  tagActions,
  summary,
}) => {
  const { t } = useTranslation('chatV2');

  // ========== 从 Store 订阅状态（细粒度选择器） ==========

  const { mode, ocrStatus, ocrMeta, images, note, noteError } = useOcrDataSelector(store);

  // ========== 本地笔记状态（用于防抖保存） ==========

  const [localNote, setLocalNote] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true); // 🔧 跟踪组件挂载状态

  // 同步 Store 笔记到本地状态
  useEffect(() => {
    setLocalNote(note);
  }, [note]);

  // ========== 图片点击处理（Hooks 必须在条件返回之前） ==========

  const handleImageClick = useCallback(
    (index: number) => {
      if (images && images.length > 0) {
        dispatchPreviewImageEvent(images, index);
      }
    },
    [images]
  );

  // 🔧 保存当前笔记内容的 ref（用于卸载时保存）
  // 初始值使用 Store 中的 note，避免空字符串覆盖已有数据
  const localNoteRef = useRef(note);

  // 同步 localNote 到 ref（用于卸载时获取最新值）
  useEffect(() => {
    localNoteRef.current = localNote;
  }, [localNote]);

  // ========== 笔记变更处理（防抖保存到 Store） ==========

  const handleNoteChange = useCallback(
    (nextValue: string) => {
      setLocalNote(nextValue);
      setSaveError(null);

      // 清除之前的防抖定时器
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      // 防抖 800ms 后保存到 Store
      setIsSaving(true);
      saveTimeoutRef.current = setTimeout(() => {
        // 🔧 定时器执行完成，重置 ref
        saveTimeoutRef.current = null;

        // 🔧 检查组件是否仍然挂载
        if (!isMountedRef.current) return;

        try {
          store.getState().updateModeState({
            note: nextValue,
          });
          if (isMountedRef.current) {
            setIsSaving(false);
          }
        } catch (error: unknown) {
          if (isMountedRef.current) {
            setIsSaving(false);
            setSaveError(t('analysis.ocrCard.noteSaveError'));
          }
        }
      }, 800);
    },
    [store, t]
  );

  // 🔧 组件生命周期管理
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;

      // 清理定时器
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);

        // 🔧 卸载前立即保存未保存的笔记（避免数据丢失）
        // 注意：此时 isMountedRef 已为 false，不会触发 setState
        try {
          const currentNote = localNoteRef.current;
          // 只有当本地笔记与 Store 不同时才保存
          const storeNote = store.getState().modeState as unknown as AnalysisModeState | null;
          if (currentNote !== (storeNote?.note ?? '')) {
            store.getState().updateModeState({ note: currentNote });
          }
        } catch {
          // 忽略卸载时的保存错误
        }
      }
    };
  }, [store]);

  // ========== 条件渲染（Hooks 之后） ==========

  // 不是 analysis 模式时不渲染
  if (mode !== 'analysis') {
    return null;
  }

  // OCR 未成功或无结果时不渲染
  if (ocrStatus !== 'success' || !ocrMeta) {
    return null;
  }

  // ========== 提取 OCR 数据 ==========

  const ocrText = ocrMeta.question || ocrMeta.rawText || '';
  const tags = ocrMeta.tags || [];
  const mistakeType = ocrMeta.questionType || '';

  // ========== 渲染 ==========

  return (
    <OcrResultCard
      ocrText={ocrText}
      tags={tags}
      mistakeType={mistakeType}
      images={images}
      onImageClick={handleImageClick}
      tagActions={tagActions}
      actions={actions}
      summary={summary}
      note={localNote}
      onNoteChange={handleNoteChange}
      isSavingNote={isSaving}
      noteError={saveError || noteError}
      noteDisabled={ocrStatus !== 'success'}
    />
  );
};

// ============================================================================
// 选择器 Hook（可选，用于更细粒度订阅）
// ============================================================================

/**
 * 从 Store 获取 OCR 元数据
 *
 * ⚠️ 注意：返回的 OcrMeta 对象引用可能变化，如果需要稳定引用请使用 useOcrDataSelector
 */
export function useOcrMeta(store: StoreApi<ChatStore>): OcrMeta | null {
  return useStore(store, (s: ChatStore) => {
    if (s.mode !== 'analysis') return null;
    const modeState = s.modeState as unknown as AnalysisModeState | null;
    return modeState?.ocrMeta ?? null;
  });
}

/**
 * 从 Store 获取 OCR 图片
 *
 * 使用稳定的空数组引用避免不必要重渲染
 */
export function useOcrImages(store: StoreApi<ChatStore>): string[] {
  return useStore(store, (s: ChatStore) => {
    if (s.mode !== 'analysis') return EMPTY_IMAGES;
    const modeState = s.modeState as unknown as AnalysisModeState | null;
    return modeState?.images ?? EMPTY_IMAGES;
  });
}

/**
 * 从 Store 获取 OCR 状态
 */
export function useOcrStatus(store: StoreApi<ChatStore>): string | null {
  return useStore(store, (s: ChatStore) => {
    if (s.mode !== 'analysis') return null;
    const modeState = s.modeState as unknown as AnalysisModeState | null;
    return modeState?.ocrStatus ?? null;
  });
}

/**
 * 从 Store 获取完整 OCR 数据（使用浅比较）
 *
 * 推荐：当需要多个字段时使用此 Hook，避免多次订阅
 */
export function useOcrData(store: StoreApi<ChatStore>) {
  return useStore(
    store,
    useShallow((s: ChatStore) => {
      if (s.mode !== 'analysis') {
        return {
          isAnalysisMode: false as const,
          ocrStatus: null,
          ocrMeta: null,
          images: EMPTY_IMAGES,
        };
      }
      const modeState = s.modeState as unknown as AnalysisModeState | null;
      return {
        isAnalysisMode: true as const,
        ocrStatus: modeState?.ocrStatus ?? null,
        ocrMeta: modeState?.ocrMeta ?? null,
        images: modeState?.images ?? EMPTY_IMAGES,
      };
    })
  );
}

export default OcrResultCardV2;
