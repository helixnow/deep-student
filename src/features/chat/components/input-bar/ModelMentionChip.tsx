/**
 * Chat V2 - ModelMentionChip 统一 `@agent` / `@model` 提及胶囊组件
 *
 * 渲染为不可编辑的气泡/chip，支持：
 * 1. 智能体胶囊（精细极简中性描边 + 专属终端/智能体微图标 + `@claude` / `@codex`）
 * 2. 当存在已选外部编程 CLI 胶囊时，在胶囊行并排呈现轻巧 `WorkspaceFolderPill`（`📁 folderName ▾`）
 * 3. 模型胶囊（保持原有样式、点击 × 与 Backspace 删除）
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Robot, TerminalWindow, UsersThree, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassForBadge16 } from '@/components/ui/coarseHit';
import { WorkspaceFolderPill } from '@/features/agent-mesh';
import type { ModelInfo } from '../../utils/parseModelMentions';
import {
  isAgentMentionItem,
  isExternalCliMentionItem,
} from './useModelMentionAutocomplete';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelMentionChipProps {
  /** 模型或智能体候选信息 */
  model: ModelInfo;
  /** 删除回调 */
  onRemove: (modelId: string) => void;
  /** 是否禁用（流式生成中） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

function simplifyModelName(name: string, modelId?: string): string {
  let simplified = name || modelId || '';
  const dashIndex = simplified.indexOf(' - ');
  if (dashIndex !== -1) {
    simplified = simplified.slice(dashIndex + 3);
  }

  const trimmed = simplified.trim();
  const looksLikeHumanLabel = /[\s（()\u4e00-\u9fff]/.test(trimmed);

  if (looksLikeHumanLabel) {
    simplified = trimmed.replace(/[（(].*?[）)]/g, '').trim();
  } else {
    const parts = trimmed.split('/');
    if (parts.length > 1) {
      simplified = parts[parts.length - 1];
    } else {
      simplified = trimmed;
    }
  }

  if (!simplified) {
    simplified = modelId || name;
  }

  return simplified;
}

// ============================================================================
// 组件实现
// ============================================================================

export const ModelMentionChip: React.FC<ModelMentionChipProps> = ({
  model,
  onRemove,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['common', 'chatV2']);
  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        onRemove(model.id);
      }
    },
    [model.id, onRemove, disabled],
  );

  if (isAgentMentionItem(model)) {
    const AgentIcon =
      model.driverKind === 'swarm_broadcast'
        ? UsersThree
        : model.driverKind === 'builtin'
          ? Robot
          : TerminalWindow;

    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full',
          'text-xs font-medium border border-border/45 bg-foreground/[0.035] text-foreground',
          'select-none cursor-default transition-colors duration-150',
          disabled && 'opacity-60',
          !disabled && 'hover:bg-foreground/[0.06]',
          className,
        )}
        style={{ WebkitTextSizeAdjust: '100%', textSizeAdjust: '100%' } as React.CSSProperties}
        title={model.name}
        data-testid={`agent-mention-chip-${model.agentHandle}`}
        data-model-id={model.id}
        data-agent-handle={model.agentHandle}
      >
        <AgentIcon size={12} weight="duotone" className="shrink-0 text-primary/85" />
        <span className="truncate max-w-[110px]">@{model.agentHandle}</span>
        {!disabled && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={handleRemove}
            className={cn(
              'ml-0.5 -mr-1 !h-4 !w-4 !p-0 !rounded-full opacity-60 hover:opacity-100 hover:bg-[var(--interactive-hover)] relative',
              coarseHitClassForBadge16,
            )}
            aria-label={t('chatV2:common.removeNamed', { name: model.name })}
          >
            <X size={10} weight="bold" />
          </DsButton>
        )}
      </span>
    );
  }

  const simplifiedName = simplifyModelName(model.name, model.model);
  const displayName =
    simplifiedName.length > 30 ? simplifiedName.slice(0, 27) + '...' : simplifiedName;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full',
        'text-xs font-medium border border-transparent',
        'bg-primary/10 text-primary border-primary/20',
        'select-none cursor-default',
        'transition-all duration-200 hover:scale-105',
        disabled && 'opacity-60',
        !disabled && 'hover:bg-primary/20',
        className,
      )}
      style={{ WebkitTextSizeAdjust: '100%', textSizeAdjust: '100%' } as React.CSSProperties}
      title={model.name}
      data-model-id={model.id}
    >
      <span className="text-primary/70 text-2xs leading-none">@</span>
      <span className="truncate max-w-[80px]">{displayName}</span>
      {!disabled && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={handleRemove}
          className={cn(
            'ml-1 -mr-1 !h-4 !w-4 !p-0 !rounded-full opacity-60 hover:opacity-100 hover:bg-[var(--interactive-hover)] relative',
            coarseHitClassForBadge16,
          )}
          aria-label={t('chatV2:common.removeNamed', { name: model.name })}
        >
          <X size={10} weight="bold" />
        </DsButton>
      )}
    </span>
  );
};

// ============================================================================
// 多个 Chips 容器组件
// ============================================================================

export interface ModelMentionChipsProps {
  /** 已选中的智能体与模型列表 */
  models: ModelInfo[];
  /** 删除单个胶囊 */
  onRemove: (modelId: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

export const ModelMentionChips: React.FC<ModelMentionChipsProps> = ({
  models,
  onRemove,
  disabled = false,
  className,
}) => {
  if (models.length === 0) {
    return null;
  }

  const firstExternalAgent = models.find(isExternalCliMentionItem);

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 mb-1', className)}>
      {models.map((model) => (
        <ModelMentionChip
          key={model.id}
          model={model}
          onRemove={onRemove}
          disabled={disabled}
        />
      ))}
      {firstExternalAgent && (
        <WorkspaceFolderPill
          sessionId={firstExternalAgent.sessionId}
          disabled={disabled}
        />
      )}
    </div>
  );
};

export default ModelMentionChip;
