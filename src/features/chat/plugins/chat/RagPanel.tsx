/**
 * Chat V2 - RAG 知识库配置面板
 *
 * ★ 2026-01 简化：VFS RAG 作为唯一检索方案，移除旧知识库选择
 * - 检索学习资源（笔记、教材、题目集等）
 * - 用户记忆由独立的 memory_search 工具处理
 */

import React, { useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Stack, X, Image, Info } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Switch } from '@/components/ui/shad/Switch';
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
/** 多模态 Top-K（chatParams.multimodalTopK，后端默认 10） */
const MULTIMODAL_TOPK_MIN = 1;
const MULTIMODAL_TOPK_MAX = 20;
const MULTIMODAL_TOPK_SNAP_POINTS = [1, 2, 3, 5, 8, 10, 15, 20];
const DEFAULT_MULTIMODAL_TOPK = 10;

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

  // 从 Store 获取状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  // 🚀 P0-2 性能优化：仅订阅实际使用的字段，避免其他 chatParams 字段变化时重渲染
  const {
    ragTopK: storeRagTopK,
    ragEnableReranking: storeRagEnableReranking,
    multimodalRagEnabled: storeMultimodalRagEnabled,
    multimodalTopK: storeMultimodalTopK,
    multimodalEnableReranking: storeMultimodalEnableReranking,
  } = useStore(store, useShallow((s) => ({
    ragTopK: s.chatParams.ragTopK,
    ragEnableReranking: s.chatParams.ragEnableReranking,
    multimodalRagEnabled: s.chatParams.multimodalRagEnabled,
    multimodalTopK: s.chatParams.multimodalTopK,
    multimodalEnableReranking: s.chatParams.multimodalEnableReranking,
  })));
  const isStreaming = sessionStatus === 'streaming';

  // 直接读写 Store（与 AdvancedPanel 一致）。
  // 旧实现用本地 state 镜像 + effect 回写，当 AdvancedPanel 等其他入口
  // 修改同一参数时，本面板会把旧的本地值写回 Store，互相覆盖。
  const ragTopK = storeRagTopK ?? DEFAULT_RAG_TOPK;
  const enableReranking = storeRagEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING;
  const multimodalEnabled = storeMultimodalRagEnabled ?? DEFAULT_MULTIMODAL_RAG_ENABLED;
  const multimodalTopK = storeMultimodalTopK ?? DEFAULT_MULTIMODAL_TOPK;
  // 多模态精排：未显式设置时跟随全局 Rerank 开关（发送链路同样按此回退）
  const multimodalEnableReranking = storeMultimodalEnableReranking ?? enableReranking;

  const ragTopKFieldId = useId();
  const multimodalTopKFieldId = useId();
  const ragControlsDisabled = isStreaming;

  const setRagTopK = useCallback(
    (next: number) => {
      store.getState().setChatParams({ ragTopK: next });
    },
    [store]
  );

  // 重置 TopK
  const resetTopK = useCallback(() => {
    setRagTopK(DEFAULT_RAG_TOPK);
  }, [setRagTopK]);

  // 切换 Rerank
  const toggleReranking = useCallback(() => {
    const current = store.getState().chatParams.ragEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING;
    store.getState().setChatParams({ ragEnableReranking: !current });
  }, [store]);

  // 切换多模态检索
  const toggleMultimodal = useCallback(() => {
    const current = store.getState().chatParams.multimodalRagEnabled ?? DEFAULT_MULTIMODAL_RAG_ENABLED;
    store.getState().setChatParams({ multimodalRagEnabled: !current });
  }, [store]);

  // 设置多模态 Top-K（chatParams 已有字段，随每轮请求快照发往后端）
  const setMultimodalTopK = useCallback(
    (next: number) => {
      store.getState().setChatParams({ multimodalTopK: next });
    },
    [store]
  );

  // 切换多模态精排（首次切换即显式落库，此后不再跟随全局）
  const toggleMultimodalReranking = useCallback(() => {
    const params = store.getState().chatParams;
    const globalDefault = params.ragEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING;
    const current = params.multimodalEnableReranking ?? globalDefault;
    store.getState().setChatParams({ multimodalEnableReranking: !current });
  }, [store]);

  return (
    <div className="space-y-3">
      {/* 📱 面板头部移动端也渲染：提供可见关闭按钮（契约：面板须可见关闭 + 返回键）；副标题窄屏隐藏省宽 */}
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Stack size={16} className="text-foreground shrink-0" />
          <span className="text-sm text-foreground shrink-0">{t('analysis:input_bar.rag.title')}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {t('chat_host:rag.panel.vfs_subtitle')}
          </span>
        </div>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')}>
          <X size={16} />
        </NotionButton>
      </div>

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
              {t('chatV2:ragPanel.topkHelper', { value: ragTopK })}
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
            <span className="text-ui text-foreground">
              {t('enhanced_rag:enable_reranking')}
            </span>
            <Switch
              size="sm"
              checked={enableReranking}
              onCheckedChange={toggleReranking}
              disabled={ragControlsDisabled}
              aria-label={t('enhanced_rag:enable_reranking')}
            />
          </label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('chat_host:rag.panel.rerank_helper')}
          </p>
        </div>

        <div className="rounded-md border border-border bg-card p-2">
          <label className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Image size={13} className="text-muted-foreground" />
              <span className="text-ui text-foreground">
                {t('chat_host:rag.panel.multimodal_label')}
              </span>
            </div>
            <Switch
              size="sm"
              checked={multimodalEnabled}
              onCheckedChange={toggleMultimodal}
              disabled={ragControlsDisabled}
              aria-label={t('chat_host:rag.panel.multimodal_label')}
            />
          </label>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('chat_host:rag.panel.multimodal_helper')}
          </p>

          {/* 多模态 Top-K：开关开启时内联展开（grid-rows 动画，禁模态） */}
          <div
            aria-hidden={!multimodalEnabled}
            className={cn(
              'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              multimodalEnabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="mt-2 border-t border-border/50 pt-2">
                <SnappySlider
                  className={cn('pb-1', ragControlsDisabled && 'pointer-events-none opacity-60')}
                  values={MULTIMODAL_TOPK_SNAP_POINTS}
                  defaultValue={DEFAULT_MULTIMODAL_TOPK}
                  value={Math.min(MULTIMODAL_TOPK_MAX, Math.max(MULTIMODAL_TOPK_MIN, multimodalTopK))}
                  min={MULTIMODAL_TOPK_MIN}
                  max={MULTIMODAL_TOPK_MAX}
                  step={1}
                  inputId={multimodalTopKFieldId}
                  onChange={(next: number) => {
                    if (ragControlsDisabled || !multimodalEnabled) return;
                    setMultimodalTopK(next);
                  }}
                  config={{
                    snappingThreshold: 0.35,
                    labelFormatter: (next: number) => Math.round(next).toString(),
                  }}
                  label={t('chatV2:ragPanel.multimodalTopkLabel')}
                  disabled={ragControlsDisabled || !multimodalEnabled}
                />
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t('chatV2:ragPanel.multimodalTopkHelper')}
                </p>
                {/* 多模态精排开关（默认跟随全局 Rerank） */}
                <div className="mt-2 border-t border-border/50 pt-2">
                  <label className="flex items-center justify-between">
                    <span className="text-[12px] text-foreground">
                      {t('chatV2:ragPanel.multimodalRerankLabel')}
                    </span>
                    <Switch
                      size="sm"
                      checked={multimodalEnableReranking}
                      onCheckedChange={toggleMultimodalReranking}
                      disabled={ragControlsDisabled || !multimodalEnabled}
                      aria-label={t('chatV2:ragPanel.multimodalRerankLabel')}
                    />
                  </label>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {t('chatV2:ragPanel.multimodalRerankHelper')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 轻提示：参数下一次检索生效；streaming 时说明为何锁定 */}
      <p className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        <Info size={12} className="shrink-0" aria-hidden="true" />
        <span>
          {ragControlsDisabled
            ? t('chatV2:ragPanel.streamingLocked')
            : t('chatV2:ragPanel.nextRunHint')}
        </span>
      </p>
    </div>
  );
};

export default RagPanel;
