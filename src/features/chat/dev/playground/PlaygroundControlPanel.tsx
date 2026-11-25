/**
 * LLM Output Playground - 控制面板
 *
 * 提供手动触发各种 block 类型/状态的控制界面
 */

import React, { useState, useCallback } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  Play,
  Square,
  Trash,
  Lightning,
  CaretDown,
  CaretRight,
  Stack,
  Cube,
  ListChecks,
  WarningCircle,
  CircleNotch,
  CheckCircle,
  Clock,
  ChartBar,
  Cpu,
} from '@phosphor-icons/react';
import type { ChatStore } from '../../core/types';
import type { BlockStatus } from '../../core/types/block';
import type { StreamingSmoothingPreset } from '@/features/chat/components/renderers/streamingSmoothing';
import type { StreamRenderingMode } from '@/features/chat/components/renderers/StreamingMarkdownRenderer';
import {
  BLOCK_TEMPLATES,
  ALL_BLOCK_STATUSES,
  AUTO_REPLY_SCENARIOS,
  PLAYGROUND_BLOCKING_SAMPLES,
} from './mockData';
import {
  triggerScenario,
  triggerSingleBlock,
  triggerBlockingAskUser,
  triggerBlockingToolApproval,
  triggerBlockingToolLimit,
  triggerTodoSample,
  clearAllMessages,
  abortCurrentScenario,
  createAssistantMessage,
  injectBlock,
  setMockRhythm,
} from './mockAdapter';
import { ProfilerPanel } from './ProfilerPanel';
import { EvalPanel } from './EvalPanel';
import { RHYTHM_PRESETS } from './eval/rhythm';
import {
  getRenderModeHint,
  getRenderModeLabel,
  getStreamingPresetHint,
  getStreamingPresetLabel,
} from './labels';

// ============================================================================
// Props
// ============================================================================

export type PlaygroundTab = 'scenarios' | 'profiler' | 'eval';

const ALL_PRESETS: StreamingSmoothingPreset[] = ['natural', 'realtime', 'balanced', 'silky', 'fluid'];
const ALL_MODES: StreamRenderingMode[] = ['legacy', 'blocked'];

export interface PlaygroundControlPanelProps {
  store: StoreApi<ChatStore>;
  className?: string;
  preset: StreamingSmoothingPreset;
  onPresetChange: (preset: StreamingSmoothingPreset) => void;
  renderMode: StreamRenderingMode;
  onRenderModeChange: (mode: StreamRenderingMode) => void;
}

// ============================================================================
// 状态图标
// ============================================================================

const StatusIcon: React.FC<{ status: BlockStatus; className?: string }> = ({ status, className }) => {
  switch (status) {
    case 'pending':
      return <Clock className={cn('w-3 h-3 text-muted-foreground', className)} />;
    case 'running':
      return <CircleNotch className={cn('w-3 h-3 text-info animate-spin', className)} />;
    case 'success':
      return <CheckCircle className={cn('w-3 h-3 text-success', className)} />;
    case 'error':
      return <WarningCircle className={cn('w-3 h-3 text-destructive', className)} />;
  }
};

// ============================================================================
// 组件实现
// ============================================================================

export const PlaygroundControlPanel: React.FC<PlaygroundControlPanelProps> = ({
  store,
  className,
  preset,
  onPresetChange,
  renderMode,
  onRenderModeChange,
}) => {
  const [activeTab, setActiveTab] = useState<PlaygroundTab>('scenarios');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['scenarios', 'blocks'])
  );
  const [selectedStatus, setSelectedStatus] = useState<BlockStatus>('success');
  const [isExecuting, setIsExecuting] = useState(false);
  const [scenarioRhythmId, setScenarioRhythmId] = useState<string>('fixed-fast');

  // rhythm selector → push into mockAdapter
  const handleScenarioRhythmChange = useCallback((id: string) => {
    setScenarioRhythmId(id);
    const preset = RHYTHM_PRESETS.find((r) => r.id === id);
    if (preset) setMockRhythm(preset.rhythm);
  }, []);

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

  const handleInjectBlockingAskUser = useCallback(() => {
    triggerBlockingAskUser(store, PLAYGROUND_BLOCKING_SAMPLES.askUser);
  }, [store]);

  const handleInjectBlockingApproval = useCallback(() => {
    triggerBlockingToolApproval(store, PLAYGROUND_BLOCKING_SAMPLES.toolApproval);
  }, [store]);

  const handleInjectBlockingToolLimit = useCallback(() => {
    triggerBlockingToolLimit(store, PLAYGROUND_BLOCKING_SAMPLES.toolLimit);
  }, [store]);

  const handleInjectTodoSample = useCallback(() => {
    triggerTodoSample(store, PLAYGROUND_BLOCKING_SAMPLES.todoList);
  }, [store]);

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
          <span className="font-medium text-sm">控制面板</span>
          <div className="flex items-center gap-2">
            <span className={cn(
              'px-1.5 py-0.5 text-2xs rounded font-mono',
              sessionStatus === 'idle' ? 'bg-success/10 text-success' :
              sessionStatus === 'streaming' ? 'bg-info/10 text-info' :
              'bg-warning/10 text-warning'
            )}>
              {sessionStatus === 'idle' ? '空闲' : sessionStatus === 'streaming' ? '流式中' : sessionStatus}
            </span>
            <span className="text-2xs text-muted-foreground">
              {messageCount} 消息 / {blockCount} 块
            </span>
          </div>
        </div>
      </div>

      {/* 全局渲染偏好 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border space-y-1.5 bg-muted/20">
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-muted-foreground tracking-wider font-medium w-12">
            预设
          </span>
          <div className="flex gap-0.5 flex-1">
            {ALL_PRESETS.map((p) => (
              <DsButton
                key={p}
                variant="ghost"
                size="sm"
                onClick={() => onPresetChange(p)}
                title={getStreamingPresetHint(p)}
                className={cn(
                  '!h-auto flex-1 !px-1 !py-0.5 text-2xs rounded transition-colors',
                  preset === p
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                {getStreamingPresetLabel(p)}
              </DsButton>
            ))}
          </div>
        </div>
        <p className="pl-[3.375rem] text-2xs leading-relaxed text-muted-foreground/80">
          {getStreamingPresetHint(preset)}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-muted-foreground tracking-wider font-medium w-12">
            模式
          </span>
          <div className="flex gap-0.5 flex-1">
            {ALL_MODES.map((m) => (
              <DsButton
                key={m}
                variant="ghost"
                size="sm"
                onClick={() => onRenderModeChange(m)}
                title={getRenderModeHint(m)}
                className={cn(
                  '!h-auto flex-1 !px-1 !py-0.5 text-2xs rounded transition-colors',
                  renderMode === m
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                {getRenderModeLabel(m)}
              </DsButton>
            ))}
          </div>
        </div>
        <p className="pl-[3.375rem] text-2xs leading-relaxed text-muted-foreground/80">
          {getRenderModeHint(renderMode)}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-border text-xs">
        {([
          { id: 'scenarios' as const, label: '场景', Icon: Lightning },
          { id: 'profiler' as const, label: '性能', Icon: ChartBar },
          { id: 'eval' as const, label: '评测', Icon: Cpu },
        ]).map(({ id, label, Icon }) => (
          <DsButton
            key={id}
            variant="ghost"
            size="sm"
            onClick={() => setActiveTab(id)}
            className={cn(
              '!h-auto flex-1 !rounded-none !px-2 !py-1.5 text-xs transition-colors flex items-center justify-center gap-1',
              activeTab === id
                ? 'text-foreground border-b-2 border-primary -mb-px font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon size={11} />
            {label}
          </DsButton>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'scenarios' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* 快捷操作 */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-border flex flex-wrap gap-1.5">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="!h-auto !px-2.5 !py-1.5 min-h-7 text-xs rounded bg-muted hover:bg-destructive/10 hover:text-destructive transition-colors flex items-center gap-1"
            >
              <Trash size={12} />
              清空
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleAbort}
              disabled={sessionStatus === 'idle'}
              className={cn(
                '!h-auto !px-2.5 !py-1.5 min-h-7 text-xs rounded flex items-center gap-1 transition-colors',
                sessionStatus === 'idle'
                  ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
                  : 'bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive'
              )}
            >
              <Square size={12} />
              中断
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleInjectAll}
              className="!h-auto !px-2.5 !py-1.5 min-h-7 text-xs rounded bg-muted hover:bg-primary/10 hover:text-primary transition-colors flex items-center gap-1"
            >
              <Stack size={12} />
              注入全部
            </DsButton>
          </div>

          {/* 状态选择器 */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-border space-y-2">
            <div>
              <div className="text-2xs text-muted-foreground mb-1.5 font-medium tracking-wider">
                注入状态
              </div>
              <div className="flex gap-1">
                {ALL_BLOCK_STATUSES.map((status) => (
                  <DsButton
                    key={status}
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedStatus(status)}
                    className={cn(
                      '!h-auto flex-1 !px-2 !py-1 text-xs rounded flex items-center justify-center gap-1 transition-colors',
                      selectedStatus === status
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80 text-muted-foreground'
                    )}
                  >
                    <StatusIcon status={status} className={selectedStatus === status ? 'text-primary-foreground' : undefined} />
                    {status === 'pending' ? '待处理' : status === 'running' ? '运行中' : status === 'success' ? '成功' : '错误'}
                  </DsButton>
                ))}
              </div>
            </div>
            <div>
              <div className="text-2xs text-muted-foreground mb-1 font-medium tracking-wider">
                流式节奏
              </div>
              <select
                value={scenarioRhythmId}
                onChange={(e) => handleScenarioRhythmChange(e.target.value)}
                className="w-full text-xs px-2 py-1 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] rounded bg-muted/50 border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {RHYTHM_PRESETS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 可滚动内容区 */}
          <CustomScrollArea className="min-h-0 flex-1">
            <CollapsibleSection
              title="预设场景"
              icon={<Lightning size={14} />}
              expanded={expandedSections.has('scenarios')}
              onToggle={() => toggleSection('scenarios')}
            >
              <div className="space-y-1">
                {AUTO_REPLY_SCENARIOS.map((scenario) => (
                  <DsButton
                    key={scenario.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTriggerScenario(scenario.id)}
                    disabled={isExecuting || sessionStatus === 'streaming'}
                    className={cn(
                      '!h-auto w-full !flex-col !items-start text-left !px-2 !py-1.5 rounded text-xs transition-colors',
                      'hover:bg-muted/80 group',
                      (isExecuting || sessionStatus === 'streaming') && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Play size={12} className="text-muted-foreground group-hover:text-primary transition-colors" />
                      <span className="font-medium">{scenario.label}</span>
                    </div>
                    <div className="text-2xs text-muted-foreground ml-[18px] mt-0.5">
                      {scenario.description}
                    </div>
                  </DsButton>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="块类型"
              icon={<Cube size={14} />}
              expanded={expandedSections.has('blocks')}
              onToggle={() => toggleSection('blocks')}
              badge={`${BLOCK_TEMPLATES.length}`}
            >
              <div className="space-y-0.5">
                {BLOCK_TEMPLATES.map((template, index) => (
                  <DsButton
                    key={`${template.type}-${index}`}
                    variant="ghost"
                    size="sm"
                    onClick={() => handleInjectBlock(index)}
                    className="!h-auto w-full !flex-col !items-stretch text-left !px-2 !py-1.5 rounded text-xs hover:bg-muted/80 transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-2xs px-1 py-0.5 rounded bg-muted text-muted-foreground">
                          {template.type}
                        </span>
                        <span className="font-medium">{template.label}</span>
                      </div>
                      {template.supportsStreaming && (
                        <span className="text-2xs px-1 py-0.5 rounded bg-info/10 text-info">
                          流式
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-muted-foreground mt-0.5">
                      {template.description}
                    </div>
                  </DsButton>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="真实阻塞交互"
              icon={<WarningCircle size={14} />}
              expanded={expandedSections.has('blocking')}
              onToggle={() => toggleSection('blocking')}
              badge="ask_user"
            >
              <div className="space-y-1.5">
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleInjectBlockingAskUser}
                  className="!h-auto w-full !flex-col !items-start text-left rounded !px-2 !py-2 text-xs transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `ask_user`</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    接管输入栏，显示带选项和自定义输入的真实调试弹条。
                  </div>
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleInjectBlockingApproval}
                  className="!h-auto w-full !flex-col !items-start text-left rounded !px-2 !py-2 text-xs transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `tool_approval`</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    验证敏感度徽章、参数展开，以及批准/拒绝后的 resolved 态。
                  </div>
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleInjectBlockingToolLimit}
                  className="!h-auto w-full !flex-col !items-start text-left rounded !px-2 !py-2 text-xs transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `tool_limit`</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    直接走输入栏 continue 交互，检查阻塞态与恢复行为。
                  </div>
                </DsButton>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="任务面板"
              icon={<ListChecks size={14} />}
              expanded={expandedSections.has('task-panel')}
              onToggle={() => toggleSection('task-panel')}
              badge="todo"
            >
              <div className="space-y-1.5">
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleInjectTodoSample}
                  className="!h-auto w-full !flex-col !items-start text-left rounded !px-2 !py-2 text-xs transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">Todo sample 数据</div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    注入一组带 running / completed / pending 状态的 todo_list 示例，调试折叠摘要和步骤高亮。
                  </div>
                </DsButton>
              </div>
            </CollapsibleSection>
          </CustomScrollArea>
        </div>
      )}

      {activeTab === 'profiler' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ProfilerPanel embedded />
        </div>
      )}

      {activeTab === 'eval' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <EvalPanel />
        </div>
      )}
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
    <DsButton
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className="!h-auto w-full !rounded-none !px-3 !py-2 flex items-center !justify-between hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
      {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        {icon}
        {title}
      </div>
      {badge && (
        <span className="text-2xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
          {badge}
        </span>
      )}
    </DsButton>
    {expanded && <div className="px-2 pb-2">{children}</div>}
  </div>
);

export default PlaygroundControlPanel;
