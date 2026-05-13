/**
 * LLM Output Playground - 控制面板
 *
 * 提供手动触发各种 block 类型/状态的控制界面
 */

import React, { useState, useCallback } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import {
  Play,
  Square,
  Trash2,
  Zap,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Layers,
  Box,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import type { ChatStore } from '../../core/types';
import type { BlockStatus } from '../../core/types/block';
import {
  BLOCK_TEMPLATES,
  ALL_BLOCK_STATUSES,
  AUTO_REPLY_SCENARIOS,
} from './mockData';
import {
  triggerScenario,
  triggerSingleBlock,
  clearAllMessages,
  abortCurrentScenario,
  createAssistantMessage,
  injectBlock,
} from './mockAdapter';

// ============================================================================
// Props
// ============================================================================

export interface PlaygroundControlPanelProps {
  store: StoreApi<ChatStore>;
  className?: string;
}

// ============================================================================
// 状态图标
// ============================================================================

const StatusIcon: React.FC<{ status: BlockStatus; className?: string }> = ({ status, className }) => {
  switch (status) {
    case 'pending':
      return <Clock className={cn('w-3 h-3 text-muted-foreground', className)} />;
    case 'running':
      return <Loader2 className={cn('w-3 h-3 text-blue-500 animate-spin', className)} />;
    case 'success':
      return <CheckCircle2 className={cn('w-3 h-3 text-green-500', className)} />;
    case 'error':
      return <AlertCircle className={cn('w-3 h-3 text-destructive', className)} />;
  }
};

// ============================================================================
// 组件实现
// ============================================================================

export const PlaygroundControlPanel: React.FC<PlaygroundControlPanelProps> = ({
  store,
  className,
}) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['scenarios', 'blocks'])
  );
  const [selectedStatus, setSelectedStatus] = useState<BlockStatus>('success');
  const [isExecuting, setIsExecuting] = useState(false);

  // 订阅状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  const messageCount = useStore(store, (s) => s.messageOrder.length);
  const blockCount = useStore(store, (s) => s.blocks.size);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  // 执行场景
  const handleTriggerScenario = useCallback(async (scenarioId: string) => {
    setIsExecuting(true);
    try {
      await triggerScenario(store, scenarioId);
    } finally {
      setIsExecuting(false);
    }
  }, [store]);

  // 注入单个 block
  const handleInjectBlock = useCallback((templateIndex: number) => {
    triggerSingleBlock(store, templateIndex, selectedStatus);
  }, [store, selectedStatus]);

  // 注入所有 block 类型（同一消息）
  const handleInjectAll = useCallback(() => {
    const messageId = createAssistantMessage(store);
    BLOCK_TEMPLATES.forEach((template) => {
      injectBlock(store, messageId, {
        type: template.type,
        status: selectedStatus,
        content: template.content,
        toolName: template.toolName,
        toolInput: template.toolInput,
        toolOutput: template.toolOutput,
        citations: template.citations,
      });
    });
    if (selectedStatus !== 'running') {
      store.setState({ sessionStatus: 'idle' });
    }
  }, [store, selectedStatus]);

  // 清空
  const handleClear = useCallback(() => {
    abortCurrentScenario();
    clearAllMessages(store);
  }, [store]);

  // 中断
  const handleAbort = useCallback(() => {
    abortCurrentScenario();
    store.getState().completeStream('cancelled');
  }, [store]);

  return (
    <div className={cn('flex flex-col h-full overflow-hidden bg-card border-l border-border', className)}>
      {/* 头部状态栏 */}
      <div className="flex-shrink-0 px-3 py-2 bg-muted/50 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Control Panel</span>
          <div className="flex items-center gap-2">
            <span className={cn(
              'px-1.5 py-0.5 text-[10px] rounded font-mono',
              sessionStatus === 'idle' ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300' :
              sessionStatus === 'streaming' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' :
              'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
            )}>
              {sessionStatus}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {messageCount}msg / {blockCount}blk
            </span>
          </div>
        </div>
      </div>

      {/* 快捷操作 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border flex flex-wrap gap-1.5">
        <button
          onClick={handleClear}
          className="px-2 py-1 text-[11px] rounded bg-muted hover:bg-destructive/10 hover:text-destructive transition-colors flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          清空
        </button>
        <button
          onClick={handleAbort}
          disabled={sessionStatus === 'idle'}
          className={cn(
            'px-2 py-1 text-[11px] rounded flex items-center gap-1 transition-colors',
            sessionStatus === 'idle'
              ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
              : 'bg-destructive/10 text-destructive hover:bg-destructive/20'
          )}
        >
          <Square className="w-3 h-3" />
          中断
        </button>
        <button
          onClick={handleInjectAll}
          className="px-2 py-1 text-[11px] rounded bg-muted hover:bg-primary/10 hover:text-primary transition-colors flex items-center gap-1"
        >
          <Layers className="w-3 h-3" />
          注入全部
        </button>
      </div>

      {/* 状态选择器 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border">
        <div className="text-[10px] text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">
          注入状态
        </div>
        <div className="flex gap-1">
          {ALL_BLOCK_STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => setSelectedStatus(status)}
              className={cn(
                'flex-1 px-2 py-1 text-[11px] rounded flex items-center justify-center gap-1 transition-colors',
                selectedStatus === status
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground'
              )}
            >
              <StatusIcon status={status} className={selectedStatus === status ? 'text-primary-foreground' : undefined} />
              {status}
            </button>
          ))}
        </div>
      </div>

      {/* 可滚动内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* 预设场景 */}
        <CollapsibleSection
          title="预设场景"
          icon={<Zap className="w-3.5 h-3.5" />}
          expanded={expandedSections.has('scenarios')}
          onToggle={() => toggleSection('scenarios')}
        >
          <div className="space-y-1">
            {AUTO_REPLY_SCENARIOS.map((scenario) => (
              <button
                key={scenario.id}
                onClick={() => handleTriggerScenario(scenario.id)}
                disabled={isExecuting || sessionStatus === 'streaming'}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded text-[11px] transition-colors',
                  'hover:bg-muted/80 group',
                  (isExecuting || sessionStatus === 'streaming') && 'opacity-50 cursor-not-allowed'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Play className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
                  <span className="font-medium">{scenario.label}</span>
                </div>
                <div className="text-[10px] text-muted-foreground ml-[18px] mt-0.5">
                  {scenario.description}
                </div>
              </button>
            ))}
          </div>
        </CollapsibleSection>

        {/* Block 类型注入 */}
        <CollapsibleSection
          title="Block 类型"
          icon={<Box className="w-3.5 h-3.5" />}
          expanded={expandedSections.has('blocks')}
          onToggle={() => toggleSection('blocks')}
          badge={`${BLOCK_TEMPLATES.length}`}
        >
          <div className="space-y-0.5">
            {BLOCK_TEMPLATES.map((template, index) => (
              <button
                key={`${template.type}-${index}`}
                onClick={() => handleInjectBlock(index)}
                className="w-full text-left px-2 py-1.5 rounded text-[11px] hover:bg-muted/80 transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                      {template.type}
                    </span>
                    <span className="font-medium">{template.label}</span>
                  </div>
                  {template.supportsStreaming && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300">
                      stream
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {template.description}
                </div>
              </button>
            ))}
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
};

// ============================================================================
// 辅助组件
// ============================================================================

interface CollapsibleSectionProps {
  title: string;
  icon?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  badge?: string;
  children: React.ReactNode;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  icon,
  expanded,
  onToggle,
  badge,
  children,
}) => (
  <div className="border-b border-border">
    <button
      onClick={onToggle}
      className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {icon}
        {title}
      </div>
      {badge && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
          {badge}
        </span>
      )}
    </button>
    {expanded && <div className="px-2 pb-2">{children}</div>}
  </div>
);

export default PlaygroundControlPanel;
