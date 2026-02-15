/**
 * Chat V2 - 对话控制（高级设置）面板
 *
 * 提供温度、上下文长度、最大输出、思维链等设置
 */

import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { SlidersHorizontal, X, MessageSquare, Thermometer, Layers, Image } from 'lucide-react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SnappySlider } from '@/components/ui/SnappySlider';
import { Switch } from '@/components/ui/shad/Switch';
import { Label } from '@/components/ui/shad/Label';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { ChatStore } from '../../core/types';
import { ensureModelsCacheLoaded, getModelInfoByConfigId } from '../../hooks/useAvailableModels';
import { deriveInputContextBudget, inferModelContextWindow } from '../../../utils/modelCapabilities';

// ============================================================================
// 常量
// ============================================================================

const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const TEMPERATURE_STEP = 0.1;
const TEMPERATURE_DEFAULT = 0.7;
const TEMPERATURE_SNAP_POINTS = [0, 0.3, 0.5, 0.7, 1.0, 1.3, 1.5, 2.0];

const MAX_TOKENS_MIN = 1024;
const MAX_TOKENS_MAX = 128000;
const MAX_TOKENS_DEFAULT = 32768;
const MAX_TOKENS_SNAP_POINTS = [1024, 4096, 16384, 32768, 65536, 128000];
const CONTEXT_LIMIT_MIN = 2048;
const CONTEXT_LIMIT_MAX = 2_000_000;
const CONTEXT_LIMIT_BASE_POINTS = [
  2048,
  4096,
  8192,
  16384,
  32768,
  65536,
  128000,
  200000,
  400000,
  800000,
  1000000,
  2000000,
];

const TOP_P_MIN = 0;
const TOP_P_MAX = 1;
const TOP_P_STEP = 0.05;
const TOP_P_DEFAULT = 0.9;
const TOP_P_SNAP_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 1.0];

const PENALTY_MIN = -2;
const PENALTY_MAX = 2;
const PENALTY_STEP = 0.1;
const PENALTY_DEFAULT = 0;
const PENALTY_SNAP_POINTS = [-2, -1, -0.5, 0, 0.5, 1, 2];

// RAG 知识库配置常量
const RAG_TOPK_MIN = 1;
const RAG_TOPK_MAX = 50;
const RAG_TOPK_DEFAULT = 10;
const RAG_TOPK_SNAP_POINTS = [1, 2, 3, 5, 8, 10, 12, 16, 20, 24, 30, 40, 50];
const DEFAULT_RAG_ENABLE_RERANKING = true;
const DEFAULT_MULTIMODAL_RAG_ENABLED = false;

function formatTokenNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${value}`;
}

// ============================================================================
// 类型
// ============================================================================

interface AdvancedPanelProps {
  store: StoreApi<ChatStore>;
  onClose: () => void;
  /** 侧栏模式：隐藏头部，使用单列布局 */
  sidebarMode?: boolean;
}

// ============================================================================
// 组件
// ============================================================================

export const AdvancedPanel: React.FC<AdvancedPanelProps> = ({ store, onClose, sidebarMode = false }) => {
  const { t } = useTranslation(['chat_host', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 从 Store 获取状态
  const chatParams = useStore(store, (s) => s.chatParams);
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  const isStreaming = sessionStatus === 'streaming';

  // ID for accessibility
  const temperatureId = useId();
  const topPId = useId();
  const freqPenaltyId = useId();
  const presPenaltyId = useId();
  const maxTokensId = useId();
  const contextLimitId = useId();
  const [modelMetaVersion, setModelMetaVersion] = useState(0);

  useEffect(() => {
    let disposed = false;
    void ensureModelsCacheLoaded()
      .then(() => {
        if (!disposed) {
          setModelMetaVersion((prev) => prev + 1);
        }
      })
      .catch((err) => { console.warn('[AdvancedPanel] ensureModelsCacheLoaded failed:', err); });
    return () => {
      disposed = true;
    };
  }, [chatParams.modelId]);

  // 更新参数
  const updateParam = useCallback(
    (key: keyof typeof chatParams, value: any) => {
      store.getState().setChatParams({ [key]: value });
    },
    [store]
  );

  const temperature = chatParams.temperature ?? TEMPERATURE_DEFAULT;
  const topP = chatParams.topP ?? TOP_P_DEFAULT;
  const frequencyPenalty = chatParams.frequencyPenalty ?? PENALTY_DEFAULT;
  const presencePenalty = chatParams.presencePenalty ?? PENALTY_DEFAULT;
  const maxTokens = chatParams.maxTokens ?? MAX_TOKENS_DEFAULT;
  const enableThinking = chatParams.enableThinking ?? true;
  const modelInfo = useMemo(
    () => getModelInfoByConfigId(chatParams.modelId),
    [chatParams.modelId, modelMetaVersion]
  );
  const inferredContextWindow = useMemo(
    () => {
      // 优先使用 ApiConfig 中用户配置/推断引擎写入的 contextWindow
      if (typeof modelInfo?.contextWindow === 'number' && modelInfo.contextWindow > 0) {
        return modelInfo.contextWindow;
      }
      // fallback：实时推断（兼容旧配置无 contextWindow 字段的情况）
      return inferModelContextWindow(modelInfo?.model ?? chatParams.modelId, maxTokens);
    },
    [modelInfo?.model, modelInfo?.contextWindow, chatParams.modelId, maxTokens]
  );
  const autoContextLimit = useMemo(
    () =>
      deriveInputContextBudget({
        contextWindow: inferredContextWindow,
        maxOutputTokens: maxTokens,
      }),
    [inferredContextWindow, maxTokens]
  );
  const contextLimit = chatParams.contextLimit ?? autoContextLimit;
  const contextSliderMax = Math.max(
    CONTEXT_LIMIT_MIN,
    Math.min(CONTEXT_LIMIT_MAX, Math.max(inferredContextWindow, contextLimit))
  );
  const contextSliderPoints = useMemo(() => {
    const filtered = CONTEXT_LIMIT_BASE_POINTS.filter((point) => point >= CONTEXT_LIMIT_MIN && point <= contextSliderMax);
    if (!filtered.includes(contextSliderMax)) {
      filtered.push(contextSliderMax);
    }
    return filtered.sort((a, b) => a - b);
  }, [contextSliderMax]);
  
  // RAG 知识库配置
  const ragTopK = chatParams.ragTopK ?? RAG_TOPK_DEFAULT;
  const ragEnableReranking = chatParams.ragEnableReranking ?? DEFAULT_RAG_ENABLE_RERANKING;
  const multimodalRagEnabled = chatParams.multimodalRagEnabled ?? DEFAULT_MULTIMODAL_RAG_ENABLED;

  return (
    <div className={cn('flex flex-col', isMobile ? 'h-full' : sidebarMode ? 'h-full' : 'max-h-[calc(60vh-40px)]')}>
      {/* 面板头部 - 移动端/侧栏模式隐藏 */}
      {!isMobile && !sidebarMode && (
        <div className="flex items-center justify-between mb-3 shrink-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-foreground shrink-0" />
            <span className="text-sm text-foreground shrink-0">{t('common:chat_controls')}</span>
            <span className="text-xs text-muted-foreground">
              {t('chat_host:advanced.notice')}
            </span>
          </div>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')}>
            <X size={16} />
          </NotionButton>
        </div>
      )}

      {/* 设置区域 - 可滚动 */}
      <CustomScrollArea className="flex-1 min-h-0" viewportClassName={cn('pr-3', isMobile || sidebarMode ? 'h-full' : 'max-h-[calc(60vh-120px)]')}>
        {/* 侧栏模式强制单列布局，非侧栏模式使用响应式双列 */}
        <div className={sidebarMode ? 'flex flex-col gap-2 pb-1' : 'grid grid-cols-1 md:grid-cols-2 gap-2 pb-1'}>
        {/* 温度 */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <Thermometer size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={temperatureId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.temperature.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.temperature.description')}
            </span>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={TEMPERATURE_SNAP_POINTS}
            defaultValue={TEMPERATURE_DEFAULT}
            value={temperature}
            min={TEMPERATURE_MIN}
            max={TEMPERATURE_MAX}
            step={TEMPERATURE_STEP}
            inputId={temperatureId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('temperature', next);
            }}
            config={{
              snappingThreshold: 0.15,
              labelFormatter: (v: number) => v.toFixed(1),
            }}
            disabled={isStreaming}
          />
          {enableThinking && (
            <p className="mt-1 text-[10px] text-amber-500/80">
              {t('chat_host:advanced.thinking_mode_notice')}
            </p>
          )}
        </div>

        {/* Top-P */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <Thermometer size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={topPId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.top_p.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.top_p.description')}
            </span>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={TOP_P_SNAP_POINTS}
            defaultValue={TOP_P_DEFAULT}
            value={topP}
            min={TOP_P_MIN}
            max={TOP_P_MAX}
            step={TOP_P_STEP}
            inputId={topPId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('topP', next);
            }}
            config={{
              snappingThreshold: 0.1,
              labelFormatter: (v: number) => v.toFixed(2),
            }}
            disabled={isStreaming}
          />
        </div>

        {/* 上下文输入预算 */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <Layers size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={contextLimitId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.context.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.context.description')}
            </span>
            <NotionButton
              variant="ghost"
              size="sm"
              className={cn(
                'ml-auto !h-auto !px-1.5 !py-0.5 text-[10px]',
                isStreaming && 'pointer-events-none opacity-60'
              )}
              onClick={() => {
                if (!isStreaming) {
                  updateParam('contextLimit', undefined);
                }
              }}
            >
              {t('chat_host:advanced.context.reset_auto')}
            </NotionButton>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={contextSliderPoints}
            defaultValue={autoContextLimit}
            value={contextLimit}
            min={CONTEXT_LIMIT_MIN}
            max={contextSliderMax}
            step={256}
            inputId={contextLimitId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('contextLimit', Math.floor(next));
            }}
            config={{
              snappingThreshold: 0.2,
              labelFormatter: formatTokenNumber,
            }}
            disabled={isStreaming}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {chatParams.contextLimit === undefined
              ? t('chat_host:advanced.context.auto_hint', {
                  window: formatTokenNumber(inferredContextWindow),
                  budget: formatTokenNumber(autoContextLimit),
                })
              : t('chat_host:advanced.context.manual_hint', {
                  value: formatTokenNumber(contextLimit),
                })}
          </p>
        </div>
        {/* 最大输出 Token */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={maxTokensId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.max_tokens.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.max_tokens.description')}
            </span>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={MAX_TOKENS_SNAP_POINTS}
            defaultValue={MAX_TOKENS_DEFAULT}
            value={maxTokens}
            min={MAX_TOKENS_MIN}
            max={MAX_TOKENS_MAX}
            step={256}
            inputId={maxTokensId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('maxTokens', next);
            }}
            config={{
              snappingThreshold: 0.2,
              labelFormatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v),
            }}
            disabled={isStreaming}
          />
        </div>

        {/* Frequency Penalty */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={freqPenaltyId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.frequency_penalty.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.frequency_penalty.description')}
            </span>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={PENALTY_SNAP_POINTS}
            defaultValue={PENALTY_DEFAULT}
            value={frequencyPenalty}
            min={PENALTY_MIN}
            max={PENALTY_MAX}
            step={PENALTY_STEP}
            inputId={freqPenaltyId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('frequencyPenalty', next);
            }}
            config={{
              snappingThreshold: 0.2,
              labelFormatter: (v: number) => v.toFixed(1),
            }}
            disabled={isStreaming}
          />
        </div>

        {/* Presence Penalty */}
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal size={12} className="text-muted-foreground shrink-0" />
            <Label htmlFor={presPenaltyId} className="text-xs font-medium shrink-0">
              {t('chat_host:advanced.presence_penalty.label')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:advanced.presence_penalty.description')}
            </span>
          </div>
          <SnappySlider
            className={cn(isStreaming && 'pointer-events-none opacity-60')}
            values={PENALTY_SNAP_POINTS}
            defaultValue={PENALTY_DEFAULT}
            value={presencePenalty}
            min={PENALTY_MIN}
            max={PENALTY_MAX}
            step={PENALTY_STEP}
            inputId={presPenaltyId}
            onChange={(next: number) => {
              if (!isStreaming) updateParam('presencePenalty', next);
            }}
            config={{
              snappingThreshold: 0.2,
              labelFormatter: (v: number) => v.toFixed(1),
            }}
            disabled={isStreaming}
          />
        </div>

        {/* 知识库检索配置 */}
        <div className={cn('p-2', !sidebarMode && 'md:col-span-2')}>
          <div className="flex items-center gap-1.5 mb-2">
            <Layers size={12} className="text-muted-foreground shrink-0" />
            <Label className="text-xs font-medium shrink-0">
              {t('analysis:input_bar.rag.title')}
            </Label>
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {t('chat_host:rag.panel.vfs_subtitle')}
            </span>
          </div>
          <div className={sidebarMode ? 'flex flex-col gap-2' : 'grid grid-cols-1 md:grid-cols-3 gap-2'}>
            {/* Top-K 滑条 */}
            <div className="p-2">
              <SnappySlider
                className={cn(isStreaming && 'pointer-events-none opacity-60')}
                values={RAG_TOPK_SNAP_POINTS}
                defaultValue={RAG_TOPK_DEFAULT}
                value={Math.min(RAG_TOPK_MAX, Math.max(RAG_TOPK_MIN, ragTopK))}
                min={RAG_TOPK_MIN}
                max={RAG_TOPK_MAX}
                step={1}
                onChange={(next: number) => {
                  if (!isStreaming) updateParam('ragTopK', next);
                }}
                config={{
                  snappingThreshold: 0.35,
                  labelFormatter: (v: number) => Math.round(v).toString(),
                }}
                label={t('chat_host:rag.panel.topk_label')}
                disabled={isStreaming}
              />
            </div>

            {/* Rerank 开关 */}
            <div className="p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-foreground">
                  {t('enhanced_rag:enable_reranking')}
                </span>
                <Switch
                  checked={ragEnableReranking}
                  onCheckedChange={(checked) => updateParam('ragEnableReranking', checked)}
                  disabled={isStreaming}
                  className="scale-75 shrink-0"
                />
              </div>
              <p className="mt-1 text-[10px] leading-3 text-muted-foreground">
                {t('chat_host:rag.panel.rerank_helper')}
              </p>
            </div>

            {/* ★ 多模态检索开关 - 多模态索引已禁用，暂时隐藏。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可 */}
            {/* <div className="p-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Image size={11} className="text-muted-foreground" />
                  <span className="text-xs text-foreground">
                    {t('chat_host:rag.panel.multimodal_label')}
                  </span>
                </div>
                <Switch
                  checked={multimodalRagEnabled}
                  onCheckedChange={(checked) => updateParam('multimodalRagEnabled', checked)}
                  disabled={isStreaming}
                  className="scale-75 shrink-0"
                />
              </div>
              <p className="mt-1 text-[10px] leading-3 text-muted-foreground">
                {t('chat_host:rag.panel.multimodal_helper')}
              </p>
            </div> */}
          </div>
        </div>
      </div>
      </CustomScrollArea>
    </div>
  );
};

export default AdvancedPanel;
