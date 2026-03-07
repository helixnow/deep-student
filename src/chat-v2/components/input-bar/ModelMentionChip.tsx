/**
 * Chat V2 - ModelMentionChip 模型提及气泡组件
 *
 * 渲染为不可编辑的气泡/chip，支持：
 * 1. 显示模型名称
 * 2. 点击 × 删除
 * 3. 键盘删除（Backspace）
 * 4. 暗色/亮色模式
 */

import React, { useCallback } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ModelInfo } from '../../utils/parseModelMentions';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelMentionChipProps {
  /** 模型信息 */
  model: ModelInfo;
  /** 删除回调 */
  onRemove: (modelId: string) => void;
  /** 是否禁用（流式生成中） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * ModelMentionChip - 模型提及气泡组件
 */
export const ModelMentionChip: React.FC<ModelMentionChipProps> = ({
  model,
  onRemove,
  disabled = false,
  className,
}) => {
  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        onRemove(model.id);
      }
    },
    [model.id, onRemove, disabled]
  );

  // 简化模型名称显示：
  // 1. 移除供应商前缀（如 "SiliconFlow - xxx" -> "xxx"）
  // 2. 对于纯模型 ID 路径（如 "Qwen/Qwen3-8B"）才按 / 取最后一段
  // 3. 对于 "Qwen3.5 Plus (多模态/混合思考)" 这类展示名，保留主名称并去掉括号说明
  const simplifyModelName = (name: string, modelId?: string): string => {
    let simplified = name || modelId || '';
    // 移除供应商前缀（格式：供应商名 - 模型名）
    const dashIndex = simplified.indexOf(' - ');
    if (dashIndex !== -1) {
      simplified = simplified.slice(dashIndex + 3);
    }

    const trimmed = simplified.trim();
    const looksLikeHumanLabel = /[\s（()\u4e00-\u9fff]/.test(trimmed);

    // 对人类可读标签，优先保留括号前的主名称
    if (looksLikeHumanLabel) {
      simplified = trimmed
        .replace(/[（(].*?[）)]/g, '')
        .trim();
    } else {
      // 对于 xxx/xxx/abc 这类模型 ID 路径，只取最后一段
      const parts = trimmed.split('/');
      if (parts.length > 1) {
        simplified = parts[parts.length - 1];
      } else {
        simplified = trimmed;
      }
    }

    // 兜底：如果清洗后为空，则回退到 modelId 或原始名称
    if (!simplified) {
      simplified = modelId || name;
    }

    return simplified;
  };

  const simplifiedName = simplifyModelName(model.name, model.model);
  // 截断过长的名称
  const displayName = simplifiedName.length > 30 
    ? simplifiedName.slice(0, 27) + '...' 
    : simplifiedName;

  return (
    <span
      className={cn(
        // 🔧 样式统一：与技能标签 (ContextRefChips) 保持一致
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full',
        'text-xs font-medium border border-transparent',
        'bg-primary/10 text-primary border-primary/20',
        'select-none cursor-default',
        'transition-all duration-200 hover:scale-105',
        disabled && 'opacity-60',
        !disabled && 'hover:bg-primary/20',
        className
      )}
      // 🔧 安卓 WebView 修复：禁止字体大小自动调整
      style={{ WebkitTextSizeAdjust: '100%', textSizeAdjust: '100%' } as React.CSSProperties}
      title={model.name}
      data-model-id={model.id}
    >
      <span className="text-primary/70 text-[10px] leading-none">@</span>
      {/* 🔧 样式统一：与技能标签保持一致 */}
      <span className="truncate max-w-[80px]">{displayName}</span>
      {!disabled && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRemove} className="ml-1 -mr-1 !h-4 !w-4 !p-0 !rounded-full opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10" aria-label={`Remove ${model.name}`}>
          <X size={10} />
        </NotionButton>
      )}
    </span>
  );
};

// ============================================================================
// 多个 Chips 容器组件
// ============================================================================

export interface ModelMentionChipsProps {
  /** 已选中的模型列表 */
  models: ModelInfo[];
  /** 删除单个模型 */
  onRemove: (modelId: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * ModelMentionChips - 多个模型提及气泡容器
 */
export const ModelMentionChips: React.FC<ModelMentionChipsProps> = ({
  models,
  onRemove,
  disabled = false,
  className,
}) => {
  if (models.length === 0) {
    return null;
  }

  return (
    // 🔧 移动端优化：减小间距
    <div className={cn('flex flex-wrap gap-1 mb-1', className)}>
      {models.map((model) => (
        <ModelMentionChip
          key={model.id}
          model={model}
          onRemove={onRemove}
          disabled={disabled}
        />
      ))}
    </div>
  );
};

export default ModelMentionChip;
