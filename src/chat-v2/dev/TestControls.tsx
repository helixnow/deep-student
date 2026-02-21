import { unifiedAlert, unifiedConfirm, unifiedPrompt } from '@/utils/unifiedDialogs';
/**
 * Chat V2 - 测试控制面板
 *
 * 提供快捷操作用于测试各种场景
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import {
  Play,
  Square,
  Trash2,
  RotateCcw,
  Settings,
  MessageSquare,
  Zap,
  Moon,
  Sun,
  AlertCircle,
} from 'lucide-react';
import type { ChatStore } from '../core/types';

// ============================================================================
// Props 定义
// ============================================================================

export interface TestControlsProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 自定义类名 */
  className?: string;
  /** 切换暗色模式回调 */
  onToggleDarkMode?: () => void;
  /** 当前是否暗色模式 */
  isDarkMode?: boolean;
}

// ============================================================================
// 测试消息模板
// ============================================================================

const TEST_MESSAGES = [
  '你好，请介绍一下自己。',
  '什么是机器学习？请用简单的语言解释。',
  '写一首关于春天的诗。',
  '帮我解释一下 React Hooks 的工作原理。',
  '请生成一个 Python 快速排序的代码示例。',
];

// ============================================================================
// 组件实现
// ============================================================================

export const TestControls: React.FC<TestControlsProps> = ({
  store,
  className,
  onToggleDarkMode,
  isDarkMode = false,
}) => {
  const { t } = useTranslation('chatV2');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 订阅状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  const messageCount = useStore(store, (s) => s.messageOrder.length);
  const canSend = useStore(store, (s) => s.canSend());
  const canAbort = useStore(store, (s) => s.canAbort());

  // 发送测试消息
  const handleSendTest = useCallback(async () => {
    if (!canSend) return;

    setLoading(true);
    setError(null);

    try {
      const randomMsg = TEST_MESSAGES[Math.floor(Math.random() * TEST_MESSAGES.length)];
      await store.getState().sendMessage(randomMsg);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canSend, store]);

  // 发送自定义消息
  const handleSendCustom = useCallback(async () => {
    if (!canSend) return;

    const content = unifiedPrompt('输入测试消息:');
    if (!content?.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await store.getState().sendMessage(content.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canSend, store]);

  // 停止流式
  const handleStop = useCallback(async () => {
    if (!canAbort) return;

    setLoading(true);
    setError(null);

    try {
      await store.getState().abortStream();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canAbort, store]);

  // 清空消息
  const handleClear = useCallback(() => {
    const state = store.getState();
    const messageIds = [...state.messageOrder];

    for (const id of messageIds) {
      if (state.canDelete(id)) {
        state.deleteMessage(id);
      }
    }
  }, [store]);

  // 重置 Store
  const handleReset = useCallback(async () => {
    if (!unifiedConfirm('确定要重置会话吗？所有消息将被清除。')) return;

    try {
      const mode = store.getState().mode;
      await store.getState().initSession(mode);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [store]);

  // 切换功能
  const handleToggleFeature = useCallback(
    (feature: string) => {
      store.getState().toggleFeature(feature);
    },
    [store]
  );

  // 模拟流式完成
  const handleSimulateComplete = useCallback(() => {
    const state = store.getState();
    if (state.sessionStatus === 'streaming') {
      store.getState().completeStream();
    }
  }, [store]);

  // 获取功能状态
  const features = useStore(store, (s) => s.features);

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg overflow-hidden',
        className
      )}
    >
      {/* 头部 */}
      <div className="px-3 py-2 bg-muted/50 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm flex items-center gap-2">
            <Settings className="w-4 h-4" />
            测试控制
          </span>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'px-2 py-0.5 text-xs rounded-full',
                sessionStatus === 'idle'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                  : sessionStatus === 'streaming'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                  : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
              )}
            >
              {sessionStatus}
            </span>
            <span className="text-xs text-muted-foreground">
              {messageCount} 条消息
            </span>
          </div>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 bg-destructive/10 border-b border-destructive/20 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="p-3 space-y-3">
        {/* 消息操作 */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium">{t('dev.testControls.messageActions', 'Message Actions')}</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSendTest}
              disabled={!canSend || loading}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-primary text-primary-foreground',
                'hover:bg-primary/90 transition-colors',
                (!canSend || loading) && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Zap className="w-3.5 h-3.5" />
              {t('dev.testControls.randomTest', 'Random Test')}
            </button>
            <button
              onClick={handleSendCustom}
              disabled={!canSend || loading}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-secondary text-secondary-foreground',
                'hover:bg-secondary/80 transition-colors',
                (!canSend || loading) && 'opacity-50 cursor-not-allowed'
              )}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {t('dev.testControls.customMessage', 'Custom Message')}
            </button>
            <button
              onClick={handleStop}
              disabled={!canAbort || loading}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-destructive text-destructive-foreground',
                'hover:bg-destructive/90 transition-colors',
                (!canAbort || loading) && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Square className="w-3.5 h-3.5" />
              {t('dev.testControls.stop', 'Stop')}
            </button>
          </div>
        </div>

        {/* 会话操作 */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium">{t('dev.testControls.sessionActions', 'Session Actions')}</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleClear}
              disabled={messageCount === 0 || sessionStatus !== 'idle'}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-muted text-muted-foreground',
                'hover:bg-muted/80 transition-colors',
                (messageCount === 0 || sessionStatus !== 'idle') &&
                  'opacity-50 cursor-not-allowed'
              )}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('dev.testControls.clearMessages', 'Clear Messages')}
            </button>
            <button
              onClick={handleReset}
              disabled={sessionStatus !== 'idle'}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-muted text-muted-foreground',
                'hover:bg-muted/80 transition-colors',
                sessionStatus !== 'idle' && 'opacity-50 cursor-not-allowed'
              )}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('dev.testControls.resetSession', 'Reset Session')}
            </button>
            <button
              onClick={handleSimulateComplete}
              disabled={sessionStatus !== 'streaming'}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-muted text-muted-foreground',
                'hover:bg-muted/80 transition-colors',
                sessionStatus !== 'streaming' && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Play className="w-3.5 h-3.5" />
              {t('dev.testControls.simulateComplete', 'Simulate Complete')}
            </button>
          </div>
        </div>

        {/* 功能开关 */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium">{t('dev.testControls.featureToggles', 'Feature Toggles')}</div>
          <div className="flex flex-wrap gap-2">
            {['rag', 'graphRag', 'webSearch', 'anki'].map((feature) => (
              <button
                key={feature}
                onClick={() => handleToggleFeature(feature)}
                className={cn(
                  'px-2 py-1 text-xs rounded-md transition-colors',
                  features.get(feature)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {feature}
              </button>
            ))}
          </div>
        </div>

        {/* 主题切换 */}
        {onToggleDarkMode && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground font-medium">{t('dev.testControls.theme', 'Theme')}</div>
            <button
              onClick={onToggleDarkMode}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5',
                'bg-muted text-muted-foreground',
                'hover:bg-muted/80 transition-colors'
              )}
            >
              {isDarkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5" />
                  {t('dev.testControls.switchToLight', 'Switch to Light')}
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5" />
                  {t('dev.testControls.switchToDark', 'Switch to Dark')}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TestControls;
