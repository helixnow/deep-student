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
      return <CircleNotch className={cn('w-3 h-3 text-blue-500 animate-spin', className)} />;
    case 'success':
      return <CheckCircle className={cn('w-3 h-3 text-green-500', className)} />;
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
              'px-1.5 py-0.5 text-[10px] rounded font-mono',
              sessionStatus === 'idle' ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300' :
              sessionStatus === 'streaming' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' :
              'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
            )}>
              {sessionStatus === 'idle' ? '空闲' : sessionStatus === 'streaming' ? '流式中' : sessionStatus}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {messageCount} 消息 / {blockCount} 块
            </span>
          </div>
        </div>
      </div>

      {/* 全局渲染偏好 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border space-y-1.5 bg-muted/20">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground tracking-wider font-medium w-12">
            预设
          </span>
          <div className="flex gap-0.5 flex-1">
            {ALL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPresetChange(p)}
                title={getStreamingPresetHint(p)}
                className={cn(
                  'flex-1 px-1 py-0.5 text-[10px] rounded transition-colors',
                  preset === p
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                {getStreamingPresetLabel(p)}
              </button>
            ))}
          </div>
        </div>
        <p className="pl-[3.375rem] text-[10px] leading-relaxed text-muted-foreground/80">
          {getStreamingPresetHint(preset)}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground tracking-wider font-medium w-12">
            模式
          </span>
          <div className="flex gap-0.5 flex-1">
            {ALL_MODES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onRenderModeChange(m)}
                title={getRenderModeHint(m)}
                className={cn(
                  'flex-1 px-1 py-0.5 text-[10px] rounded transition-colors',
                  renderMode === m
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                {getRenderModeLabel(m)}
              </button>
            ))}
          </div>
        </div>
        <p className="pl-[3.375rem] text-[10px] leading-relaxed text-muted-foreground/80">
          {getRenderModeHint(renderMode)}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-border text-[11px]">
        {([
          { id: 'scenarios' as const, label: '场景', Icon: Lightning },
          { id: 'profiler' as const, label: '性能', Icon: ChartBar },
          { id: 'eval' as const, label: '评测', Icon: Cpu },
        ]).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex-1 px-2 py-1.5 transition-colors flex items-center justify-center gap-1',
              activeTab === id
                ? 'text-foreground border-b-2 border-primary -mb-px font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'scenarios' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* 快捷操作 */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-border flex flex-wrap gap-1.5">
            <button
              onClick={handleClear}
              className="px-2 py-1 text-[11px] rounded bg-muted hover:bg-destructive/10 hover:text-destructive transition-colors flex items-center gap-1"
            >
              <Trash size={12} />
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
              <Square size={12} />
              中断
            </button>
            <button
              onClick={handleInjectAll}
              className="px-2 py-1 text-[11px] rounded bg-muted hover:bg-primary/10 hover:text-primary transition-colors flex items-center gap-1"
            >
              <Stack size={12} />
              注入全部
            </button>
          </div>

          {/* 状态选择器 */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-border space-y-2">
            <div>
              <div className="text-[10px] text-muted-foreground mb-1.5 font-medium tracking-wider">
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
                    {status === 'pending' ? '待处理' : status === 'running' ? '运行中' : status === 'success' ? '成功' : '错误'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground mb-1 font-medium tracking-wider">
                流式节奏
              </div>
              <select
                value={scenarioRhythmId}
                onChange={(e) => handleScenarioRhythmChange(e.target.value)}
                className="w-full text-[11px] px-2 py-1 rounded bg-muted/50 border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
          <div className="flex-1 overflow-y-auto">
            <CollapsibleSection
              title="预设场景"
              icon={<Lightning size={14} />}
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
                      <Play size={12} className="text-muted-foreground group-hover:text-primary transition-colors" />
                      <span className="font-medium">{scenario.label}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground ml-[18px] mt-0.5">
                      {scenario.description}
                    </div>
                  </button>
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
                          流式
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

            <CollapsibleSection
              title="真实阻塞交互"
              icon={<WarningCircle size={14} />}
              expanded={expandedSections.has('blocking')}
              onToggle={() => toggleSection('blocking')}
              badge="ask_user"
            >
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={handleInjectBlockingAskUser}
                  className="w-full text-left rounded px-2 py-2 text-[11px] transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `ask_user`</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    接管输入栏，显示带选项和自定义输入的真实调试弹条。
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleInjectBlockingApproval}
                  className="w-full text-left rounded px-2 py-2 text-[11px] transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `tool_approval`</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    验证敏感度徽章、参数展开，以及批准/拒绝后的 resolved 态。
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleInjectBlockingToolLimit}
                  className="w-full text-left rounded px-2 py-2 text-[11px] transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">真实 `tool_limit`</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    直接走输入栏 continue 交互，检查阻塞态与恢复行为。
                  </div>
                </button>
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
                <button
                  type="button"
                  onClick={handleInjectTodoSample}
                  className="w-full text-left rounded px-2 py-2 text-[11px] transition-colors hover:bg-muted/80"
                >
                  <div className="font-medium">Todo sample 数据</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    注入一组带 running / completed / pending 状态的 todo_list 示例，调试折叠摘要和步骤高亮。
                  </div>
                </button>
              </div>
            </CollapsibleSection>
          </div>
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
    <button
      onClick={onToggle}
      className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
      {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
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
