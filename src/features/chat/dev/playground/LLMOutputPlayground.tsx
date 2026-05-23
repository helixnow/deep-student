/**
 * LLM Output Playground - 主页面
 *
 * 一个完整的 LLM 输出模拟游乐场，用于视觉调试所有可能的输出状态。
 * 包含：
 * - 真实的 ChatV2 输入栏（可发送，不持久化）
 * - 模拟的 LLM 回复（自动回复 + 手动注入）
 * - 控制面板（Tab 化：Scenarios / Profiler / Eval）
 * - Compare 模式（A/B 分屏，左右用不同 preset 同步对比）
 */

import '../../init';

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import {
  Moon,
  Sun,
  SidebarSimple,
  ArrowCounterClockwise,
  Columns,
} from '@phosphor-icons/react';
import { AgentTaskPanel } from '../../components/AgentTaskPanel';
import { MessageList } from '../../components/MessageList';
import { InputBarV2 } from '../../components/input-bar';
import { StreamPreferencesProvider } from '../../components/renderers/StreamPreferencesContext';
import type { StreamingSmoothingPreset } from '../../components/renderers/streamingSmoothing';
import type { StreamRenderingMode } from '../../components/renderers/StreamingMarkdownRenderer';
import { PlaygroundControlPanel } from './PlaygroundControlPanel';
import {
  createPlaygroundStore,
  clearAllMessages,
  abortCurrentScenario,
  triggerScenario,
} from './mockAdapter';
import {
  getRenderModeHint,
  getRenderModeLabel,
  getStreamingPresetHint,
  getStreamingPresetLabel,
} from './labels';

const ALL_PRESETS: StreamingSmoothingPreset[] = ['natural', 'realtime', 'balanced', 'silky', 'fluid'];

export const LLMOutputPlayground: React.FC = () => {
  // 主 store
  const storeA = useMemo(() => createPlaygroundStore(), []);
  // Compare 模式才使用的副 store
  const storeB = useMemo(() => createPlaygroundStore(), []);

  // UI 状态
  const [showPanel, setShowPanel] = useState(true);
  const [compareMode, setCompareMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );

  // 渲染偏好（preset / mode）— 通过 Provider 透传到所有 StreamingMarkdownRenderer
  const [presetA, setPresetA] = useState<StreamingSmoothingPreset>('balanced');
  const [presetB, setPresetB] = useState<StreamingSmoothingPreset>('silky');
  const [renderMode, setRenderMode] = useState<StreamRenderingMode>('blocked');

  // 订阅 store A 状态
  const sessionStatus = useStore(storeA, (s) => s.sessionStatus);
  const messageCount = useStore(storeA, (s) => s.messageOrder.length);

  const handleToggleDarkMode = useCallback(() => {
    const next = !isDarkMode;
    setIsDarkMode(next);
    document.documentElement.classList.toggle('dark', next);
  }, [isDarkMode]);

  const handleReset = useCallback(() => {
    abortCurrentScenario();
    clearAllMessages(storeA);
    clearAllMessages(storeB);
  }, [storeA, storeB]);

  // 在 Compare 模式下手动同步触发同一场景到两边
  const handleCompareTrigger = useCallback(
    async (scenarioId: string) => {
      // 顺序触发：因为 mockAdapter 用单例 abort controller
      await Promise.allSettled([
        triggerScenario(storeA, scenarioId),
        triggerScenario(storeB, scenarioId),
      ]);
    },
    [storeA, storeB],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setShowPanel((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        handleToggleDarkMode();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        handleReset();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        setCompareMode((v) => !v);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleToggleDarkMode, handleReset]);

  return (
    <div className="chat-v2 flex flex-col h-full bg-background">
      {/* 顶部工具栏 */}
      <header className="flex-shrink-0 h-10 border-b border-border bg-card/80 backdrop-blur-sm flex items-center justify-between px-3 z-10">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">LLM 输出调试台</h1>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 font-mono">
            DEV
          </span>
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-mono',
              sessionStatus === 'idle'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                : sessionStatus === 'streaming'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300',
            )}
          >
            {sessionStatus === 'idle' ? '空闲' : sessionStatus === 'streaming' ? '流式中' : sessionStatus} · {messageCount} 消息
          </span>
          {compareMode && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300 font-mono">
              对比 A:{getStreamingPresetLabel(presetA)} vs B:{getStreamingPresetLabel(presetB)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setCompareMode((v) => !v)}
            className={cn(
              'p-1.5 rounded transition-colors',
              compareMode
                ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground',
            )}
            title="A/B 对比模式 (Ctrl+Shift+C)"
          >
            <Columns size={14} />
          </button>
          <button
            onClick={handleReset}
            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="重置 (Ctrl+Shift+R)"
          >
            <ArrowCounterClockwise size={14} />
          </button>
          <button
            onClick={handleToggleDarkMode}
            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="切换主题 (Ctrl+Shift+D)"
          >
            {isDarkMode ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            onClick={() => setShowPanel((v) => !v)}
            className={cn(
              'p-1.5 rounded transition-colors',
              showPanel
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground',
            )}
            title="切换控制面板 (Ctrl+Shift+P)"
          >
            <SidebarSimple size={14} />
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 聊天区域（普通 / Compare） */}
        <div className="flex-1 flex flex-col min-w-0 bg-[color:var(--shell-workspace-panel)]">
          {compareMode ? (
            <CompareView
              storeA={storeA}
              storeB={storeB}
              presetA={presetA}
              presetB={presetB}
              onPresetAChange={setPresetA}
              onPresetBChange={setPresetB}
              renderMode={renderMode}
              onTrigger={handleCompareTrigger}
            />
          ) : (
            <StreamPreferencesProvider preset={presetA} mode={renderMode}>
              <div className="flex-1 overflow-hidden relative">
                <MessageList store={storeA} />
              </div>
              <div className="text-center px-4 py-1">
                <span className="text-[11px] text-muted-foreground/50 select-none">
                  调试台模式 · 预设 {getStreamingPresetLabel(presetA)} · 模式 {renderMode === 'legacy' ? '整段' : '块级'}
                </span>
              </div>
              <AgentTaskPanel store={storeA} />
              <div className="chat-composer-motion-frame chat-composer-motion-frame--docked">
                <InputBarV2
                  store={storeA}
                  autoFocus
                />
              </div>
            </StreamPreferencesProvider>
          )}
        </div>

        {/* 控制面板 */}
        {showPanel && (
          <div className="w-[340px] flex-shrink-0">
            <PlaygroundControlPanel
              store={storeA}
              preset={presetA}
              onPresetChange={setPresetA}
              renderMode={renderMode}
              onRenderModeChange={setRenderMode}
            />
          </div>
        )}
      </div>
    </div>
  );
};

interface CompareViewProps {
  storeA: ReturnType<typeof createPlaygroundStore>;
  storeB: ReturnType<typeof createPlaygroundStore>;
  presetA: StreamingSmoothingPreset;
  presetB: StreamingSmoothingPreset;
  onPresetAChange: (p: StreamingSmoothingPreset) => void;
  onPresetBChange: (p: StreamingSmoothingPreset) => void;
  renderMode: StreamRenderingMode;
  onTrigger: (scenarioId: string) => void;
}

const COMPARE_SCENARIOS: Array<{ id: string; label: string }> = [
  { id: 'full-response', label: '完整回复' },
  { id: 'rag-response', label: 'RAG 检索' },
  { id: 'tool-chain', label: '工具链' },
  { id: 'academic-flow', label: '学术流程' },
];

const CompareView: React.FC<CompareViewProps> = ({
  storeA,
  storeB,
  presetA,
  presetB,
  onPresetAChange,
  onPresetBChange,
  renderMode,
  onTrigger,
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Compare toolbar */}
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-border bg-card/40 flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">同步触发：</span>
        {COMPARE_SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onTrigger(s.id)}
            className="px-2 py-0.5 rounded bg-muted hover:bg-primary/10 hover:text-primary transition-colors"
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 双栏 */}
      <div className="flex-1 grid grid-cols-2 gap-px bg-border min-h-0">
        <ComparePane
          store={storeA}
          preset={presetA}
          onPresetChange={onPresetAChange}
          renderMode={renderMode}
          label="A"
        />
        <ComparePane
          store={storeB}
          preset={presetB}
          onPresetChange={onPresetBChange}
          renderMode={renderMode}
          label="B"
        />
      </div>
    </div>
  );
};

interface ComparePaneProps {
  store: ReturnType<typeof createPlaygroundStore>;
  preset: StreamingSmoothingPreset;
  onPresetChange: (p: StreamingSmoothingPreset) => void;
  renderMode: StreamRenderingMode;
  label: string;
}

const ComparePane: React.FC<ComparePaneProps> = ({
  store,
  preset,
  onPresetChange,
  renderMode,
  label,
}) => {
  return (
    <div className="flex flex-col min-h-0 bg-background">
      <div className="flex-shrink-0 px-3 py-1 border-b border-border bg-muted/30 flex items-center gap-2 text-[11px]">
        <span className="font-mono font-medium">{label}</span>
        <div className="flex gap-0.5">
          {ALL_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPresetChange(p)}
              title={getStreamingPresetHint(p)}
              className={cn(
                'px-1.5 py-0.5 text-[10px] rounded transition-colors',
                preset === p
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground',
              )}
              >
                {getStreamingPresetLabel(p)}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground/80" title={getRenderModeHint(renderMode)}>
          {getRenderModeLabel(renderMode)}
        </span>
      </div>
      <StreamPreferencesProvider preset={preset} mode={renderMode}>
        <div className="flex-1 overflow-hidden">
          <MessageList store={store} />
        </div>
      </StreamPreferencesProvider>
     </div>
  );
};

export default LLMOutputPlayground;
