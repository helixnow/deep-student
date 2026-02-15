/**
 * Chat V2 - 工具输入展示组件
 *
 * 用于展示 MCP 工具调用的输入参数
 * 支持可折叠、JSON 格式化显示
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { ChevronDown, ChevronRight, Code2 } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface ToolInputViewProps {
  /** 工具输入参数 */
  input: Record<string, unknown>;
  /** 是否默认折叠 */
  collapsed?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 值渲染组件
// ============================================================================

interface ValueRendererProps {
  value: unknown;
  depth?: number;
}

/**
 * 递归渲染 JSON 值
 */
const ValueRenderer: React.FC<ValueRendererProps> = ({ value, depth = 0 }) => {
  const maxDepth = 3;

  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (value === undefined) {
    return <span className="text-muted-foreground italic">undefined</span>;
  }

  if (typeof value === 'boolean') {
    return (
      <span className="text-purple-600 dark:text-purple-400">
        {value.toString()}
      </span>
    );
  }

  if (typeof value === 'number') {
    return (
      <span className="text-blue-600 dark:text-blue-400">{value}</span>
    );
  }

  if (typeof value === 'string') {
    // 对于长字符串截断显示
    const maxLength = 200;
    const displayValue =
      value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
    return (
      <span className="text-green-600 dark:text-green-400">
        "{displayValue}"
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (depth >= maxDepth) {
      return (
        <span className="text-muted-foreground">[Array({value.length})]</span>
      );
    }
    return (
      <span className="text-muted-foreground">
        [{value.length > 0 && '...'}]
      </span>
    );
  }

  if (typeof value === 'object') {
    if (depth >= maxDepth) {
      return <span className="text-muted-foreground">{'{Object}'}</span>;
    }
    const keys = Object.keys(value);
    return (
      <span className="text-muted-foreground">
        {'{'}
        {keys.length > 0 && '...'}
        {'}'}
      </span>
    );
  }

  return <span className="text-foreground">{String(value)}</span>;
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ToolInputView - 工具输入展示组件
 */
export const ToolInputView: React.FC<ToolInputViewProps> = ({
  input,
  collapsed = true,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(!collapsed);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // 格式化的 JSON 字符串
  const formattedJson = useMemo(() => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [input]);

  // 获取参数键列表
  const paramKeys = useMemo(() => Object.keys(input), [input]);

  if (paramKeys.length === 0) {
    return null;
  }

  return (
    <div className={cn('tool-input-view', className)}>
      {/* 折叠头部 */}
      <NotionButton variant="ghost" size="sm" onClick={toggleExpanded} className="w-full !justify-start gap-1.5 !py-1 text-muted-foreground hover:text-foreground">
        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Code2 className="w-3 h-3" />
        <span>{t('blocks.mcpTool.input')}</span>
        <span className="text-muted-foreground/60">({paramKeys.length})</span>
      </NotionButton>

      {/* 内容区域 */}
      {isExpanded && (
        <div
          className={cn(
            'mt-1 p-2 rounded',
            'bg-muted/30 dark:bg-muted/20',
            'border border-border/30',
            'overflow-auto max-h-48'
          )}
        >
          {/* 简洁模式：键值对列表 */}
          <div className="space-y-1">
            {paramKeys.map((key) => (
              <div key={key} className="flex gap-2 text-xs">
                <span className="text-amber-600 dark:text-amber-400 font-medium shrink-0">
                  {key}:
                </span>
                <ValueRenderer value={input[key]} />
              </div>
            ))}
          </div>

          {/* 完整 JSON（可选） */}
          {paramKeys.length > 3 && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                {t('blocks.mcpTool.showFullJson')}
              </summary>
              <pre className="mt-1 text-xs whitespace-pre-wrap break-words text-muted-foreground font-mono">
                {formattedJson}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolInputView;
