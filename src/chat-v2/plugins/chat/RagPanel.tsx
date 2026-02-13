/**
 * Chat V2 - RAG 知识库配置面板
 *
 * ★ 2026-01 简化：VFS RAG 作为唯一检索方案，移除旧知识库选择
 * - 检索学习资源（笔记、教材、题目集等）
 * - 用户记忆由独立的 memory_search 工具处理
 */

import React, { useState, useEffect, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { Layers, X, Image } from 'lucide-react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SnappySlider } from '@/components/ui/SnappySlider';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 常量
// ============================================================================

const RAG_TOPK_MIN = 1;
const RAG_TOPK_MAX = 50;
const RAG_TOPK_SNAP_POINTS = [1, 2, 3, 5, 8, 10, 12, 16, 20, 24, 30, 40, 50];
const DEFAULT_RAG_TOPK = 10;
/** Rerank 默认启用 */
const DEFAULT_RAG_ENABLE_RERANKING = true;
/** 多模态检索默认值 */
const DEFAULT_MULTIMODAL_RAG_ENABLED = false;

// ============================================================================
// 类型
// ============================================================================

interface RagPanelProps {
  store: StoreApi<ChatStore>;
  onClose: () => void;
}

// ============================================================================
// 组件
// ============================================================================

export const RagPanel: React.FC<RagPanelProps> = ({ store, onClose }) => {
  const { t } = useTranslation(['chat_host', 'common', 'chatV2']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 从 Store 获取状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  const chatParams = useStore(store, (s) => s.chatParams);
  const isStreaming = sessionStatus === 'streaming';

  // 本地状态（简化：只保留检索参数配置）
  const [ragTopK, setRagTopK] = useState(chatParams.ragTopK ?? DEFAULT_RAG_TOPK);
  const [enableReranking, setEnableReranking] = useState(chatParams.ragEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING);
  const [multimodalEnabled, setMultimodalEnabled] = useState(chatParams.multimodalRagEnabled ?? DEFAULT_MULTIMODAL_RAG_ENABLED);

  const ragTopKFieldId = useId();
  const ragControlsDisabled = isStreaming;

  // 同步 ragTopK 到 Store
  useEffect(() => {
    if (ragTopK !== (chatParams.ragTopK ?? DEFAULT_RAG_TOPK)) {
      store.getState().setChatParams({ ragTopK });
    }
  }, [ragTopK, chatParams.ragTopK, store]);

  // 同步 enableReranking 到 Store
  useEffect(() => {
    if (enableReranking !== (chatParams.ragEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING)) {
      store.getState().setChatParams({ ragEnableReranking: enableReranking });
    }
  }, [enableReranking, chatParams.ragEnableReranking, store]);

  // 同步 multimodalEnabled 到 Store
  useEffect(() => {
    if (multimodalEnabled !== (chatParams.multimodalRagEnabled ?? DEFAULT_MULTIMODAL_RAG_ENABLED)) {
      store.getState().setChatParams({ multimodalRagEnabled: multimodalEnabled });
    }
  }, [multimodalEnabled, chatParams.multimodalRagEnabled, store]);

  // 重置 TopK
  const resetTopK = useCallback(() => {
    setRagTopK(DEFAULT_RAG_TOPK);
  }, []);

  // 切换 Rerank
  const toggleReranking = useCallback(() => {
    setEnableReranking((prev) => !prev);
  }, []);

  // 切换多模态检索
  const toggleMultimodal = useCallback(() => {
    setMultimodalEnabled((prev) => !prev);
  }, []);

  return (
    <div className="space-y-3">
      {/* 面板头部 - 移动端隐藏 */}
      {!isMobile && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-foreground shrink-0" />
            <span className="text-sm text-foreground shrink-0">{t('analysis:input_bar.rag.title')}</span>
            <span className="text-xs text-muted-foreground">
              {t('chat_host:rag.panel.vfs_subtitle')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* 配置区域（简化：只保留检索参数） */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Top-K 滑条 */}
        <div className="rounded-md border border-border bg-card p-2">
          <SnappySlider
            className={cn('pb-1', ragControlsDisabled && 'pointer-events-none opacity-60')}
            values={RAG_TOPK_SNAP_POINTS}
            defaultValue={DEFAULT_RAG_TOPK}
            value={Math.min(RAG_TOPK_MAX, Math.max(RAG_TOPK_MIN, ragTopK))}
            min={RAG_TOPK_MIN}
            max={RAG_TOPK_MAX}
            step={1}
            inputId={ragTopKFieldId}
            onChange={(next: number) => {
              if (ragControlsDisabled) return;
              setRagTopK(next);
            }}
            config={{
              snappingThreshold: 0.35,
              labelFormatter: (next: number) => Math.round(next).toString(),
            }}
            label={t('chat_host:rag.panel.topk_label')}
            disabled={ragControlsDisabled}
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {t('chat_host:rag.panel.topk_helper_short')}
            </span>
            <NotionButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetTopK}
              disabled={ragControlsDisabled}
              className="h-5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t('common:actions.reset')}
            </NotionButton>
          </div>
        </div>

        {/* Rerank 开关 */}
        <div className="rounded-md border border-border bg-card p-2">
          <label className="flex items-center justify-between">
            <span className="text-[13px] text-foreground">
              {t('enhanced_rag:enable_reranking')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enableReranking}
              disabled={ragControlsDisabled}
              onClick={toggleReranking}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                enableReranking ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                  enableReranking ? 'translate-x-4' : 'translate-x-0'
                )}
              />
            </button>
          </label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('chat_host:rag.panel.rerank_helper')}
          </p>
        </div>

        {/* ★ 多模态检索开关 - 多模态索引已禁用，暂时隐藏。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可 */}
        {/* <div className="rounded-md border border-border bg-card p-2">
          <label className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Image size={13} className="text-muted-foreground" />
              <span className="text-[13px] text-foreground">
                {t('chat_host:rag.panel.multimodal_label')}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={multimodalEnabled}
              disabled={ragControlsDisabled}
              onClick={toggleMultimodal}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                multimodalEnabled ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                  multimodalEnabled ? 'translate-x-4' : 'translate-x-0'
                )}
              />
            </button>
          </label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('chat_host:rag.panel.multimodal_helper')}
          </p>
        </div> */}
      </div>
    </div>
  );
};

export default RagPanel;
