/**
 * Chat V2 - ModelMentionPopover 统一 `@` 智能体与模型自动完成弹窗
 *
 * 在输入框上方显示候选列表，支持：
 * 1. 当存在已安装外部 CLI 或活跃蜂群时，顶部展示 Section 1: 智能体（Agents），下方展示 Section 2: 模型（Models）
 * 2. 未安装任何外部 CLI 且无蜂群时，零额外分组标题，保持纯粹模型候选体验
 * 3. 键盘导航（↑↓ 跨分组无缝选择，Enter/Tab 确认，Esc 取消）与指针选择
 */

import React, { useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, Check, Robot, TerminalWindow, UsersThree } from '@phosphor-icons/react';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { cn } from '@/utils/cn';
import { Z_INDEX } from '@/config/zIndex';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { ModelInfo } from '../../utils/parseModelMentions';
import {
  isAgentMentionItem,
  type AgentMentionItem,
  type AgentMentionStatus,
} from './useModelMentionAutocomplete';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelMentionPopoverProps {
  /** 是否显示弹窗 */
  open: boolean;
  /** 智能体 + 模型统一建议列表 */
  suggestions: ModelInfo[];
  /** 当前选中的索引 */
  selectedIndex: number;
  /** 当前搜索查询（@后的文本） */
  query: string;
  /** 选择候选回调 */
  onSelect: (model: ModelInfo) => void;
  /** 设置选中索引 */
  onSelectedIndexChange: (index: number) => void;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 锚点元素 ref（用于定位） */
  anchorRef?: React.RefObject<HTMLElement>;
  /** 自定义类名 */
  className?: string;
}

function getAgentStatusDotClass(status: AgentMentionStatus): string {
  switch (status) {
    case 'working':
      return 'bg-primary animate-pulse motion-reduce:animate-none';
    case 'waiting_children':
    case 'waiting_approval':
      return 'bg-warning animate-pulse motion-reduce:animate-none';
    case 'parked':
    case 'offline':
      return 'bg-muted-foreground/45';
    case 'ready':
    default:
      return 'bg-success';
  }
}

// ============================================================================
// 组件实现
// ============================================================================

export const ModelMentionPopover: React.FC<ModelMentionPopoverProps> = ({
  open,
  suggestions,
  selectedIndex,
  query,
  onSelect,
  onSelectedIndexChange,
  onClose,
  className,
}) => {
  const { t } = useTranslation(['chatV2', 'agentMesh']);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const presence = useMotionPresence(open, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'transition',
  });

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, suggestions.length);
  }, [suggestions.length]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);

  useEffect(() => {
    if (!open || suggestions.length === 0) return;

    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem && listRef.current) {
      selectedItem.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [selectedIndex, open, suggestions.length]);

  const { agentEntries, modelEntries } = useMemo(() => {
    const agents: Array<{ item: AgentMentionItem; index: number }> = [];
    const models: Array<{ item: ModelInfo; index: number }> = [];
    suggestions.forEach((item, index) => {
      if (isAgentMentionItem(item)) {
        agents.push({ item, index });
      } else {
        models.push({ item, index });
      }
    });
    return { agentEntries: agents, modelEntries: models };
  }, [suggestions]);

  const hasAgentsSection = agentEntries.length > 0;

  const activeDescendantId = suggestions[selectedIndex]
    ? `model-option-${suggestions[selectedIndex].id}`
    : undefined;

  const showNoResults = presence.mounted && suggestions.length === 0 && query.length > 0;

  if (!presence.mounted) {
    return null;
  }

  const renderAgentStatusText = (agent: AgentMentionItem): string => {
    if (agent.agentStatus === 'waiting_children' && (agent.subagentCount ?? 0) > 0) {
      return t('agentMesh:mention.status.waiting_children_count', {
        count: agent.subagentCount,
        defaultValue: '等待 {{count}} 子代理',
      });
    }
    const statusFallbacks: Record<AgentMentionStatus, string> = {
      ready: '已就绪',
      working: '运行中',
      waiting_children: '等待子代理',
      waiting_approval: '待审批',
      parked: '休眠待命',
      offline: '未就绪',
    };
    return t(`agentMesh:mention.status.${agent.agentStatus}`, {
      defaultValue: statusFallbacks[agent.agentStatus] ?? agent.agentStatus,
    });
  };

  const renderAgentIcon = (agent: AgentMentionItem) => {
    if (agent.driverKind === 'swarm_broadcast') {
      return <UsersThree size={14} weight="duotone" />;
    }
    if (agent.driverKind === 'builtin') {
      return <Robot size={14} weight="duotone" />;
    }
    return <TerminalWindow size={14} weight="duotone" />;
  };

  if (showNoResults) {
    return (
      <div
        className={cn(
          't-dropdown',
          presence.exiting && 'is-closing',
          presence.shown && 'is-open',
          'absolute w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border/50 bg-popover/80 backdrop-blur-xl backdrop-saturate-150 shadow-lg ring-1 ring-border/40',
          'bottom-full mb-3 left-0',
          className,
        )}
        style={{ zIndex: Z_INDEX.inputBarPopover }}
        data-origin="bottom-left"
        data-wb-blur-surface
        role="listbox"
        aria-label={t('chatV2:modelMention.suggestions')}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
          <Cpu size={14} weight="bold" className="text-primary" />
          <span className="text-xs font-medium text-foreground/80">
            {t('chatV2:modelMention.selectModel')}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            @{query}
          </span>
        </div>
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {t('chatV2:modelMention.noResults')}
        </div>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        't-dropdown',
        presence.exiting && 'is-closing',
        presence.shown && 'is-open',
        hasAgentsSection
          ? 'absolute w-[min(22rem,calc(100vw-2rem))]'
          : 'absolute w-[min(18rem,calc(100vw-2rem))]',
        'rounded-2xl border border-border/50 bg-popover/80 backdrop-blur-xl backdrop-saturate-150 shadow-lg ring-1 ring-border/40',
        'bottom-full mb-3 left-0',
        className,
      )}
      style={{ zIndex: Z_INDEX.inputBarPopover }}
      data-origin="bottom-left"
      data-wb-blur-surface
      role="listbox"
      aria-label={t('chatV2:modelMention.suggestions')}
      aria-activedescendant={activeDescendantId}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Cpu size={14} weight="bold" className="text-primary" />
        <span className="text-xs font-medium text-foreground/80">
          {hasAgentsSection
            ? t('agentMesh:mention.selectTarget', { defaultValue: '选择智能体或模型' })
            : t('chatV2:modelMention.selectModel')}
        </span>
        {query && (
          <span className="ml-auto text-xs text-muted-foreground">
            @{query}
          </span>
        )}
      </div>

      {/* 候选列表 */}
      <CustomScrollArea
        viewportRef={listRef}
        fullHeight={false}
        className="max-h-80"
        viewportClassName="max-h-80 p-1"
      >
        {/* Section 1: 智能体（Agents） */}
        {hasAgentsSection && (
          <div data-testid="mention-section-agents" className="mb-1">
            <div className="px-2.5 py-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground/75">
              {t('agentMesh:mention.agentsSection', { defaultValue: '智能体（Agents）' })}
            </div>
            {agentEntries.map(({ item: agent, index }) => (
              <div
                key={agent.id}
                id={`model-option-${agent.id}`}
                data-testid={`mention-agent-option-${agent.agentHandle}`}
                data-mention-kind="agent"
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  'flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                  'text-sm',
                  index === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-[var(--interactive-hover)] text-foreground',
                )}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onSelect(agent);
                }}
                onMouseEnter={() => onSelectedIndexChange(index)}
              >
                <div
                  className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                    'border border-border/40 bg-foreground/[0.04] text-foreground/85',
                  )}
                >
                  {renderAgentIcon(agent)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate">@{agent.agentHandle}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {agent.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <span
                      data-testid={`mention-agent-status-dot-${agent.agentHandle}`}
                      data-status={agent.agentStatus}
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        getAgentStatusDotClass(agent.agentStatus),
                      )}
                    />
                    <span className="truncate">{renderAgentStatusText(agent)}</span>
                    {agent.capabilityBadge && (
                      <span className="ml-auto shrink-0 rounded border border-border/35 bg-foreground/[0.03] px-1.5 py-0.5 text-2xs text-muted-foreground">
                        {agent.capabilityBadge}
                      </span>
                    )}
                  </div>
                </div>

                {index === selectedIndex && (
                  <Check size={15} weight="bold" className="text-primary shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Section 2: 模型（Models） */}
        {modelEntries.length > 0 && (
          <div data-testid={hasAgentsSection ? 'mention-section-models' : undefined}>
            {hasAgentsSection && (
              <div className="mt-1 border-t border-border/35 px-2.5 pt-1.5 pb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground/75">
                {t('agentMesh:mention.modelsSection', { defaultValue: '模型（Models）' })}
              </div>
            )}
            {modelEntries.map(({ item: model, index }) => (
              <div
                key={model.id}
                id={`model-option-${model.id}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                  'text-sm',
                  index === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-[var(--interactive-hover)] text-foreground',
                )}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onSelect(model);
                }}
                onMouseEnter={() => onSelectedIndexChange(index)}
              >
                <div
                  className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                    'border border-border/40 bg-muted/50 text-foreground/85',
                  )}
                >
                  <ProviderIcon
                    modelId={model.model || model.name || model.id}
                    size={14}
                    showTooltip={false}
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{model.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {model.model || model.id}
                  </div>
                </div>

                {index === selectedIndex && (
                  <Check size={16} weight="bold" className="text-primary shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </CustomScrollArea>

      {/* 底部提示 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/50 text-2xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-2xs">↑</kbd>
            <kbd className="px-1 py-0.5 rounded bg-muted text-2xs">↓</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.navigate')}</span>
          </span>
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-2xs">↵</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.confirm')}</span>
          </span>
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-2xs">Esc</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.dismiss')}</span>
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 工具函数 - 供外部调用键盘处理
// ============================================================================

export function shouldHandleModelMentionKey(
  e: React.KeyboardEvent,
  isOpen: boolean,
): boolean {
  if (!isOpen) return false;
  return ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
}

export default ModelMentionPopover;
