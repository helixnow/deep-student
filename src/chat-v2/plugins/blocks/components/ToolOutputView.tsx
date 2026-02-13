/**
 * Chat V2 - 工具输出展示组件
 *
 * 用于展示 MCP 工具调用的输出结果
 * 支持多种输出格式（JSON、文本、图片、表格等）
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { CheckCircle, FileJson, FileText, Table2, Image as ImageIcon } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface ToolOutputViewProps {
  /** 工具输出结果 */
  output: unknown;
  /** 自定义类名 */
  className?: string;
}

type OutputType = 'json' | 'text' | 'table' | 'image' | 'unknown';

// ============================================================================
// 输出类型检测
// ============================================================================

/**
 * 检测输出的类型
 */
function detectOutputType(output: unknown): OutputType {
  if (output === null || output === undefined) {
    return 'unknown';
  }

  if (typeof output === 'string') {
    // 检查是否是图片 URL 或 base64
    if (
      output.startsWith('data:image/') ||
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(output)
    ) {
      return 'image';
    }
    return 'text';
  }

  if (Array.isArray(output)) {
    // 检查是否是表格数据（对象数组）
    if (output.length > 0 && typeof output[0] === 'object' && output[0] !== null) {
      return 'table';
    }
    return 'json';
  }

  if (typeof output === 'object') {
    // 检查是否包含图片字段
    const obj = output as Record<string, unknown>;
    if (obj.image || obj.imageUrl || obj.url) {
      const imageValue = obj.image || obj.imageUrl || obj.url;
      if (
        typeof imageValue === 'string' &&
        (imageValue.startsWith('data:image/') ||
          /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(imageValue))
      ) {
        return 'image';
      }
    }
    return 'json';
  }

  return 'text';
}

// ============================================================================
// 子组件
// ============================================================================

/**
 * JSON 输出渲染
 */
const JsonOutput: React.FC<{ data: unknown }> = ({ data }) => {
  const formattedJson = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return (
    <pre
      className={cn(
        'text-xs whitespace-pre-wrap break-words font-mono',
        'text-muted-foreground',
        'max-h-60 overflow-auto'
      )}
    >
      {formattedJson}
    </pre>
  );
};

/**
 * 文本输出渲染
 */
const TextOutput: React.FC<{ text: string }> = ({ text }) => {
  return (
    <div className="text-sm text-foreground whitespace-pre-wrap break-words">
      {text}
    </div>
  );
};

/**
 * 表格输出渲染
 */
const TableOutput: React.FC<{ data: Record<string, unknown>[] }> = ({ data }) => {
  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);
  const maxRows = 10;
  const displayData = data.slice(0, maxRows);
  const hasMore = data.length > maxRows;

  return (
    <div className="overflow-auto max-h-60">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-muted/50">
            {columns.map((col) => (
              <th
                key={col}
                className="text-left p-1.5 border-b border-border/30 font-medium text-muted-foreground"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayData.map((row, idx) => (
            <tr
              key={idx}
              className={cn(
                'hover:bg-muted/30 transition-colors',
                idx % 2 === 0 ? 'bg-transparent' : 'bg-muted/10'
              )}
            >
              {columns.map((col) => (
                <td key={col} className="p-1.5 border-b border-border/20 text-foreground">
                  {String(row[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="text-xs text-muted-foreground text-center py-2">
          ... and {data.length - maxRows} more rows
        </div>
      )}
    </div>
  );
};

/**
 * 图片输出渲染
 */
const ImageOutput: React.FC<{ output: unknown }> = ({ output }) => {
  const imageUrl = useMemo(() => {
    if (typeof output === 'string') {
      return output;
    }
    if (typeof output === 'object' && output !== null) {
      const obj = output as Record<string, unknown>;
      return (obj.image || obj.imageUrl || obj.url) as string;
    }
    return null;
  }, [output]);

  if (!imageUrl) return null;

  return (
    <div className="flex justify-center">
      <img
        src={imageUrl}
        alt="Tool output"
        className="max-w-full max-h-60 rounded object-contain"
        loading="lazy"
      />
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ToolOutputView - 工具输出展示组件
 */
export const ToolOutputView: React.FC<ToolOutputViewProps> = ({
  output,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const outputType = useMemo(() => detectOutputType(output), [output]);

  // 获取类型图标
  const TypeIcon = useMemo(() => {
    switch (outputType) {
      case 'json':
        return FileJson;
      case 'text':
        return FileText;
      case 'table':
        return Table2;
      case 'image':
        return ImageIcon;
      default:
        return CheckCircle;
    }
  }, [outputType]);

  if (output === null || output === undefined) {
    return (
      <div className={cn('text-xs text-muted-foreground italic', className)}>
        {t('blocks.mcpTool.noOutput')}
      </div>
    );
  }

  return (
    <div className={cn('tool-output-view', className)}>
      {/* 头部 */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <TypeIcon className="w-3 h-3" />
        <span>{t('blocks.mcpTool.output')}</span>
      </div>

      {/* 内容 */}
      <div
        className={cn(
          'p-2 rounded',
          'bg-muted/30 dark:bg-muted/20',
          'border border-border/30'
        )}
      >
        {outputType === 'json' && <JsonOutput data={output} />}
        {outputType === 'text' && <TextOutput text={String(output)} />}
        {outputType === 'table' && (
          <TableOutput data={output as Record<string, unknown>[]} />
        )}
        {outputType === 'image' && <ImageOutput output={output} />}
        {outputType === 'unknown' && (
          <div className="text-xs text-muted-foreground">
            {String(output)}
          </div>
        )}
      </div>
    </div>
  );
};

export default ToolOutputView;
