/**
 * Chat V2 - ChatParamsPanel 对话参数面板
 *
 * 职责：控制对话参数配置
 *
 * 功能：
 * 1. 模型选择器
 * 2. 温度滑块
 * 3. 上下文长度设置
 * 4. 最大输出设置
 * 5. 启用思维链开关
 * 6. 禁用工具开关
 * 7. 暗色/亮色主题支持
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Bot,
  Thermometer,
  FileText,
  Brain,
  Wrench,
  ChevronDown,
  RotateCcw,
} from 'lucide-react';
import { UnifiedModelSelector } from '@/components/shared/UnifiedModelSelector';
import type { ChatStore, ChatParams } from '../core/types';
import { useChatParams } from '../hooks/useChatStore';

// ============================================================================
// Props 定义
// ============================================================================

/**
 * 模型配置项
 */
export interface ModelConfig {
  /** 模型 ID */
  id: string;
  /** 模型显示名称 */
  name: string;
  /** 模型提供商 */
  provider?: string;
  /** 是否支持思维链 */
  supportsThinking?: boolean;
  /** 是否支持工具调用 */
  supportsTools?: boolean;
  /** 最大上下文长度 */
  maxContext?: number;
  /** 最大输出长度 */
  maxOutput?: number;
}

export interface ChatParamsPanelProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 可用模型列表 */
  modelConfigs: ModelConfig[];
  /** 是否展开 */
  expanded?: boolean;
  /** 展开/收起回调 */
  onExpandedChange?: (expanded: boolean) => void;
  /** 自定义类名 */
  className?: string;
  /** 是否紧凑模式 */
  compact?: boolean;
}

// ============================================================================
// 子组件：滑块
// ============================================================================

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
}

const SliderControl: React.FC<SliderControlProps> = ({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  formatValue,
  ariaLabel,
}) => {
  const displayValue = formatValue ? formatValue(value) : value.toString();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-medium tabular-nums">{displayValue}</span>
      </div>
      <input
        aria-label={ariaLabel || label || undefined}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className={cn(
          'w-full h-2 rounded-full appearance-none cursor-pointer',
          'bg-muted',
          '[&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:w-4',
          '[&::-webkit-slider-thumb]:h-4',
          '[&::-webkit-slider-thumb]:rounded-full',
          '[&::-webkit-slider-thumb]:bg-primary',
          '[&::-webkit-slider-thumb]:cursor-pointer',
          '[&::-webkit-slider-thumb]:transition-transform',
          '[&::-webkit-slider-thumb]:hover:scale-110',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      />
    </div>
  );
};

// ============================================================================
// 子组件：开关
// ============================================================================

interface ToggleControlProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}

const ToggleControl: React.FC<ToggleControlProps> = ({
  label,
  description,
  checked,
  onChange,
  disabled,
  icon,
}) => {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 p-3',
        'rounded-lg',
        'hover:bg-muted/50 transition-colors',
        !disabled && 'cursor-pointer',
        disabled && 'opacity-50'
      )}
      onClick={() => !disabled && onChange(!checked)}
    >
      <div className="flex items-center gap-3">
        {icon && (
          <div className="text-muted-foreground">{icon}</div>
        )}
        <div>
          <div id={`toggle-${label}`} className="text-sm font-medium">{label}</div>
          {description && (
            <div className="text-xs text-muted-foreground">{description}</div>
          )}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onChange(!checked);
        }}
        disabled={disabled}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full',
          'transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
          disabled && 'cursor-not-allowed'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow',
            'transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </button>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ChatParamsPanel 对话参数面板
 */
export const ChatParamsPanel: React.FC<ChatParamsPanelProps> = ({
  store,
  modelConfigs,
  expanded = true,
  onExpandedChange,
  className,
  compact = false,
}) => {
  const { t } = useTranslation('chatV2');
  const chatParams = useChatParams(store);

  // 当前选中的模型配置
  const selectedModelConfig = useMemo(() => {
    return modelConfigs.find((m) => m.id === chatParams.modelId);
  }, [modelConfigs, chatParams.modelId]);

  // 更新参数
  const updateParam = useCallback(
    <K extends keyof ChatParams>(key: K, value: ChatParams[K]) => {
      store.getState().setChatParams({ [key]: value });
    },
    [store]
  );

  // 重置参数
  const handleReset = useCallback(() => {
    store.getState().resetChatParams();
  }, [store]);

  // 紧凑模式只显示基本选项
  if (compact) {
    return (
      <div className={cn('space-y-3', className)}>
        {/* 模型选择 */}
        <UnifiedModelSelector
          models={modelConfigs}
          value={chatParams.modelId}
          onChange={(id) => updateParam('modelId', id)}
          variant="compact"
          showSearch={false}
          triggerIcon={<Bot className="w-4 h-4" />}
        />

        {/* 快捷开关 */}
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={chatParams.enableThinking}
              onChange={(e) => updateParam('enableThinking', e.target.checked)}
              className="rounded border-border"
              disabled={!selectedModelConfig?.supportsThinking}
            />
            <span className="text-muted-foreground">
              {t('chatParams.enableThinking')}
            </span>
          </label>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-border/50',
        'bg-card dark:bg-card/80',
        'overflow-hidden',
        className
      )}
    >
      {/* 头部 */}
      <div
        className={cn(
          'flex items-center justify-between px-4 py-3',
          'border-b border-border/50',
          onExpandedChange && 'cursor-pointer hover:bg-muted/50'
        )}
        onClick={() => onExpandedChange?.(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" />
          <span className="font-medium">{t('chatParams.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleReset(); }} aria-label={t('chatParams.reset')} title={t('chatParams.reset')}>
            <RotateCcw className="w-4 h-4 text-muted-foreground" />
          </NotionButton>
          {onExpandedChange && (
            <ChevronDown
              className={cn(
                'w-4 h-4 text-muted-foreground transition-transform',
                expanded && 'rotate-180'
              )}
            />
          )}
        </div>
      </div>

      {/* 内容 */}
      {expanded && (
        <div className="p-4 space-y-6">
          {/* 模型选择 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Bot className="w-4 h-4" />
              <span>{t('chatParams.model')}</span>
            </div>
            <UnifiedModelSelector
              models={modelConfigs}
              value={chatParams.modelId}
              onChange={(id) => updateParam('modelId', id)}
              variant="full"
            />
          </div>

          {/* 温度 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Thermometer className="w-4 h-4" />
              <span>{t('chatParams.temperature')}</span>
            </div>
            <SliderControl
              label=""
              ariaLabel={t('chatParams.temperature')}
              value={chatParams.temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(v) => updateParam('temperature', v)}
              formatValue={(v) => v.toFixed(1)}
            />
            <p className="text-xs text-muted-foreground">
              {t('chatParams.temperatureHint')}
            </p>
          </div>

          {/* 最大输出 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="w-4 h-4" />
              <span>{t('chatParams.maxTokens')}</span>
            </div>
            <SliderControl
              label=""
              ariaLabel={t('chatParams.maxTokens')}
              value={chatParams.maxTokens}
              min={256}
              max={selectedModelConfig?.maxOutput || 32768}
              step={256}
              onChange={(v) => updateParam('maxTokens', v)}
              formatValue={(v) => `${(v / 1024).toFixed(1)}K`}
            />
          </div>

          {/* 开关选项 */}
          <div className="space-y-1 -mx-3">
            {/* 启用思维链 */}
            <ToggleControl
              label={t('chatParams.enableThinking')}
              description={t('chatParams.enableThinkingDesc')}
              checked={chatParams.enableThinking}
              onChange={(v) => updateParam('enableThinking', v)}
              disabled={!selectedModelConfig?.supportsThinking}
              icon={<Brain className="w-4 h-4" />}
            />

            {/* 禁用工具 */}
            <ToggleControl
              label={t('chatParams.disableTools')}
              description={t('chatParams.disableToolsDesc')}
              checked={chatParams.disableTools}
              onChange={(v) => updateParam('disableTools', v)}
              disabled={!selectedModelConfig?.supportsTools}
              icon={<Wrench className="w-4 h-4" />}
            />
          </div>

          {/* 工具递归限制（仅在启用工具时显示） */}
          {!chatParams.disableTools && selectedModelConfig?.supportsTools && (
            <div className="space-y-2 pt-2 border-t border-border/50">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RotateCcw className="w-4 h-4" />
                <span>{t('chatParams.maxToolRecursion')}</span>
              </div>
              <SliderControl
                label=""
                ariaLabel={t('chatParams.maxToolRecursion')}
                value={chatParams.maxToolRecursion ?? 30}
                min={1}
                max={100}
                step={1}
                onChange={(v) => updateParam('maxToolRecursion', v)}
                formatValue={(v) => t('chatParams.maxToolRecursionUnit', { count: v })}
              />
              <p className="text-xs text-muted-foreground">
                {t('chatParams.maxToolRecursionHint')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatParamsPanel;
