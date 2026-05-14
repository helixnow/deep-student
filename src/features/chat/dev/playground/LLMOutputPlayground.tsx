/**
 * LLM Output Playground - 主页面
 *
 * 一个完整的 LLM 输出模拟游乐场，用于视觉调试所有可能的输出状态。
 * 包含：
 * - 真实的 ChatV2 输入栏（可发送，不持久化）
 * - 模拟的 LLM 回复（自动回复 + 手动注入）
 * - 控制面板（触发任意 block 类型/状态）
 */

import '../../init';

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import { Moon, Sun, SidebarSimple, ArrowCounterClockwise } from '@phosphor-icons/react';
import { MessageList } from '../../components/MessageList';
import { InputBarV2 } from '../../components/input-bar';
import { PlaygroundControlPanel } from './PlaygroundControlPanel';
import {
  createPlaygroundStore,
  clearAllMessages,
  abortCurrentScenario,
} from './mockAdapter';
import { AUTO_REPLY_SCENARIOS } from './mockData';

// ============================================================================
// 组件实现
// ============================================================================

export const LLMOutputPlayground: React.FC = () => {
  // 创建独立的 mock store（不连接后端）
  const store = useMemo(() => createPlaygroundStore(), []);

  // UI 状态
  const [showPanel, setShowPanel] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  // 订阅 store 状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  const messageCount = useStore(store, (s) => s.messageOrder.length);

  // 暗色模式切换
  const handleToggleDarkMode = useCallback(() => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    if (newMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // 重置 store
  const handleReset = useCallback(() => {
    abortCurrentScenario();
    clearAllMessages(store);
  }, [store]);

  // 快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Shift + P: 切换控制面板
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setShowPanel((v) => !v);
      }
      // Ctrl/Cmd + Shift + D: 切换暗色模式
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        handleToggleDarkMode();
      }
      // Ctrl/Cmd + Shift + R: 重置
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        handleReset();
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
          <h1 className="text-sm font-semibold">LLM Output Playground</h1>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 font-mono">
            DEV
          </span>
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-mono',
            sessionStatus === 'idle' ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300' :
            sessionStatus === 'streaming' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' :
            'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
          )}>
            {sessionStatus} | {messageCount} msgs
          </span>
        </div>

        <div className="flex items-center gap-1">
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
                : 'hover:bg-muted text-muted-foreground hover:text-foreground'
            )}
            title="切换控制面板 (Ctrl+Shift+P)"
          >
            {showPanel ? <SidebarSimple size={14} /> : <SidebarSimple size={14} />}
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 聊天区域 */}
        <div className="flex-1 flex flex-col min-w-0 bg-[color:var(--shell-workspace-panel)]">
          {/* 消息列表 */}
          <div className="flex-1 overflow-hidden relative">
            <MessageList
              store={store}
            />
          </div>

          {/* AI 免责提示 */}
          <div className="text-center px-4 py-1">
            <span className="text-[11px] text-muted-foreground/50 select-none">
              Playground Mode - 模拟输出，不连接后端
            </span>
          </div>

          {/* 输入栏 */}
          <div className="chat-composer-motion-frame chat-composer-motion-frame--docked">
            <InputBarV2
              store={store}
              autoFocus
            />
          </div>
        </div>

        {/* 控制面板 */}
        {showPanel && (
          <div className="w-[320px] flex-shrink-0">
            <PlaygroundControlPanel store={store} />
          </div>
        )}
      </div>
    </div>
  );
};

export default LLMOutputPlayground;
