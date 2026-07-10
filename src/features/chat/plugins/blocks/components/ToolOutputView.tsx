/**
 * Chat V2 - 工具输出展示组件
 *
 * 用于展示 MCP 工具调用的输出结果
 * 支持多种输出格式（JSON、文本、图片、表格等）
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { CheckCircle, FileJs, FileText, Table, Image as ImageIcon } from '@phosphor-icons/react';

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

interface LoadSkillsSummaryData {
  loadedSkillIds: string[];
  loadedToolNames: string[];
  message?: string;
}

function unwrapLoadSkillsPayload(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }

  const data = output as Record<string, unknown>;
  if (data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    return data.result as Record<string, unknown>;
  }

  return data;
}

function resolveTranslationLabel(translated: string, fallbackKey: string, fallbackValue: string): string {
  if (!translated || translated === fallbackKey || translated === `skills:${fallbackKey}`) {
    return fallbackValue;
  }

  return translated;
}

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

function extractLoadSkillsSummary(output: unknown): LoadSkillsSummaryData | null {
  const data = unwrapLoadSkillsPayload(output);
  if (!data) return null;

  const loadedSkillIds = Array.isArray(data.loaded_skill_ids)
    ? data.loaded_skill_ids.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const loadedToolNames = Array.isArray(data.loaded_tool_names)
    ? data.loaded_tool_names.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const message = typeof data.message === 'string' ? data.message : undefined;

  if (loadedSkillIds.length === 0 && loadedToolNames.length === 0 && !message) {
    return null;
  }

  return {
    loadedSkillIds,
    loadedToolNames,
    message,
  };
}

// ============================================================================
// 子组件
// ============================================================================

/** JSON 展示上限：超大 payload 截断渲染（滚动容器内塞几 MB 文本会拖垮布局） */
const JSON_OUTPUT_MAX_CHARS = 50_000;

/**
 * JSON 输出渲染
 */
const JsonOutput: React.FC<{ data: unknown }> = ({ data }) => {
  const formattedJson = useMemo(() => {
    try {
      const text = JSON.stringify(data, null, 2) ?? String(data);
      return text.length > JSON_OUTPUT_MAX_CHARS
        ? text.slice(0, JSON_OUTPUT_MAX_CHARS) + '\n…'
        : text;
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
                'hover:bg-[var(--interactive-hover)] transition-colors',
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

const LoadSkillsSummary: React.FC<{ data: LoadSkillsSummaryData }> = ({ data }) => {
  const { t } = useTranslation(['chatV2', 'skills']);

  if (data.loadedSkillIds.length === 0 && data.loadedToolNames.length === 0 && !data.message) {
    return null;
  }

  return (
    <div className="space-y-2 mb-2">
      {data.loadedSkillIds.length > 0 && (
        <div>
          <div className="text-xs font-medium text-foreground/80 mb-1.5">
            {t('blocks.mcpTool.loadedSkills', { ns: 'chatV2', defaultValue: 'Loaded skills' })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.loadedSkillIds.map((skillId) => {
              const key = `builtinNames.${skillId}`;
              const translated = t(key, { ns: 'skills', defaultValue: '' });
              const displayName = resolveTranslationLabel(translated, key, skillId);
              return (
                <span
                  key={skillId}
                  className="inline-flex items-center rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-xs text-foreground"
                  title={skillId}
                >
                  {displayName}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {data.loadedToolNames.length > 0 && (
        <div>
          <div className="text-xs font-medium text-foreground/80 mb-1.5">
            {t('blocks.mcpTool.loadedTools', { ns: 'chatV2', defaultValue: 'Loaded tools' })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.loadedToolNames.map((toolName) => (
              <code
                key={toolName}
                className="inline-flex items-center rounded-md border border-border/40 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {toolName}
              </code>
            ))}
          </div>
        </div>
      )}

      {data.message && (
        <div className="text-xs text-muted-foreground">
          {data.message}
        </div>
      )}
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
  const loadSkillsSummary = useMemo(() => extractLoadSkillsSummary(output), [output]);

  // 获取类型图标
  const TypeIcon = useMemo(() => {
    switch (outputType) {
      case 'json':
        return FileJs;
      case 'text':
        return FileText;
      case 'table':
        return Table;
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
        <TypeIcon size={12} />
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
        {loadSkillsSummary && <LoadSkillsSummary data={loadSkillsSummary} />}
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
