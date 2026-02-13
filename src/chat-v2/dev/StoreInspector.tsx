/**
 * Chat V2 - Store 状态检视器
 *
 * 用于开发调试，实时显示 Store 状态
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { cn } from '@/utils/cn';
import { ChevronDown, ChevronRight, Copy, Check, RefreshCw } from 'lucide-react';
import type { ChatStore } from '../core/types';

// ============================================================================
// Props 定义
// ============================================================================

export interface StoreInspectorProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 自定义类名 */
  className?: string;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
}

// ============================================================================
// 子组件
// ============================================================================

interface JsonViewerProps {
  data: unknown;
  name: string;
  depth?: number;
}

const JsonViewer: React.FC<JsonViewerProps> = ({ data, name, depth = 0 }) => {
  const [expanded, setExpanded] = useState(depth < 2);

  const isExpandable = useMemo(() => {
    if (data === null || data === undefined) return false;
    if (typeof data === 'object') {
      if (data instanceof Map || data instanceof Set) return true;
      return Object.keys(data).length > 0;
    }
    return false;
  }, [data]);

  const renderValue = useCallback(() => {
    if (data === null) return <span className="text-orange-500">null</span>;
    if (data === undefined) return <span className="text-gray-500">undefined</span>;

    if (typeof data === 'string') {
      const displayValue = data.length > 100 ? data.slice(0, 100) + '...' : data;
      return <span className="text-green-600 dark:text-green-400">"{displayValue}"</span>;
    }
    if (typeof data === 'number') {
      return <span className="text-blue-600 dark:text-blue-400">{data}</span>;
    }
    if (typeof data === 'boolean') {
      return <span className="text-purple-600 dark:text-purple-400">{String(data)}</span>;
    }

    if (data instanceof Map) {
      return <span className="text-muted-foreground">Map({data.size})</span>;
    }
    if (data instanceof Set) {
      return <span className="text-muted-foreground">Set({data.size})</span>;
    }
    if (Array.isArray(data)) {
      return <span className="text-muted-foreground">Array({data.length})</span>;
    }
    if (typeof data === 'object') {
      return <span className="text-muted-foreground">Object({Object.keys(data).length})</span>;
    }
    if (typeof data === 'function') {
      return <span className="text-yellow-600 dark:text-yellow-400">ƒ {(data as Function).name || 'anonymous'}()</span>;
    }

    return <span>{String(data)}</span>;
  }, [data]);

  const renderChildren = useCallback(() => {
    if (!expanded || !isExpandable) return null;

    let entries: [string, unknown][] = [];

    if (data instanceof Map) {
      entries = Array.from(data.entries()).map(([k, v]) => [String(k), v]);
    } else if (data instanceof Set) {
      entries = Array.from(data.values()).map((v, i) => [String(i), v]);
    } else if (Array.isArray(data)) {
      entries = data.map((v, i) => [String(i), v]);
    } else if (typeof data === 'object' && data !== null) {
      entries = Object.entries(data);
    }

    // 限制显示数量
    const maxItems = 50;
    const truncated = entries.length > maxItems;
    const displayEntries = truncated ? entries.slice(0, maxItems) : entries;

    return (
      <div className="ml-4 border-l border-border pl-2">
        {displayEntries.map(([key, value]) => (
          <JsonViewer key={key} name={key} data={value} depth={depth + 1} />
        ))}
        {truncated && (
          <div className="text-muted-foreground text-xs italic">
            ... {entries.length - maxItems} more items
          </div>
        )}
      </div>
    );
  }, [expanded, isExpandable, data, depth]);

  return (
    <div className="text-xs font-mono">
      <div
        className={cn(
          'flex items-center gap-1 py-0.5 hover:bg-muted/50 rounded cursor-pointer',
          isExpandable && 'cursor-pointer'
        )}
        onClick={() => isExpandable && setExpanded(!expanded)}
      >
        {isExpandable ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )
        ) : (
          <span className="w-3" />
        )}
        <span className="text-foreground font-medium">{name}:</span>
        {renderValue()}
      </div>
      {renderChildren()}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const StoreInspector: React.FC<StoreInspectorProps> = ({
  store,
  className,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 订阅完整状态
  const state = useStore(store);

  // 过滤掉函数，只显示数据
  const displayState = useMemo(() => {
    const result: Record<string, unknown> = {};

    // 核心状态
    result.sessionId = state.sessionId;
    result.mode = state.mode;
    result.sessionStatus = state.sessionStatus;

    // 消息
    result.messageMap = state.messageMap;
    result.messageOrder = state.messageOrder;
    result.blocks = state.blocks;

    // 流式追踪
    result.currentStreamingMessageId = state.currentStreamingMessageId;
    result.activeBlockIds = state.activeBlockIds;

    // 参数
    result.chatParams = state.chatParams;
    result.features = state.features;
    result.modeState = state.modeState;

    // 输入框
    result.inputValue = state.inputValue;
    result.attachments = state.attachments;
    result.panelStates = state.panelStates;

    return result;
  }, [state, refreshKey]);

  // 复制状态
  const handleCopy = useCallback(async () => {
    try {
      const serialized = JSON.stringify(
        displayState,
        (key, value) => {
          if (value instanceof Map) return Object.fromEntries(value);
          if (value instanceof Set) return Array.from(value);
          return value;
        },
        2
      );
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      console.error('[StoreInspector] Copy failed:', error);
    }
  }, [displayState]);

  // 刷新
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 守卫状态
  const guards = useMemo(() => ({
    canSend: state.canSend(),
    canAbort: state.canAbort(),
  }), [state]);

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg overflow-hidden',
        className
      )}
    >
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <span className="font-medium text-sm">Store Inspector</span>
          <span className="text-xs text-muted-foreground">
            ({state.sessionId?.slice(0, 8)}...)
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* 守卫状态指示器 */}
          <span
            className={cn(
              'px-1.5 py-0.5 text-xs rounded',
              guards.canSend
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
            )}
          >
            {guards.canSend ? 'canSend' : '!canSend'}
          </span>
          <span
            className={cn(
              'px-1.5 py-0.5 text-xs rounded',
              guards.canAbort
                ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
            )}
          >
            {guards.canAbort ? 'canAbort' : '!canAbort'}
          </span>

          {/* 工具栏 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefresh();
            }}
            className="p-1 hover:bg-muted rounded"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            className="p-1 hover:bg-muted rounded"
            title="Copy JSON"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 内容 */}
      {expanded && (
        <div className="p-3 max-h-96 overflow-auto">
          {Object.entries(displayState).map(([key, value]) => (
            <JsonViewer key={key} name={key} data={value} />
          ))}
        </div>
      )}
    </div>
  );
};

export default StoreInspector;
