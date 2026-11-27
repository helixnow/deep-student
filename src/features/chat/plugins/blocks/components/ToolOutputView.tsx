/**
 * Chat V2 - 工具输出展示组件
 *
 * 用于展示 MCP 工具调用的输出结果
 * 支持多种输出格式（JSON、文本、图片、表格等）
 */

import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { CheckCircle, FileJs, FileText, Globe, Table, Image as ImageIcon, Copy, Check } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import { builtinToolSkills } from '@/features/chat/skills/builtin-tools';

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
  loadedTools: Array<{
    name: string;
    skillId: string;
  }>;
  message?: string;
}

const BUILTIN_TOOL_SKILL_IDS = new Set(builtinToolSkills.map((skill) => skill.id));

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
  const loadedTools = Array.isArray(data.loaded_tools)
    ? data.loaded_tools.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const skillIdValue = record.skill_id ?? record.skillId;
        const skillId = typeof skillIdValue === 'string' ? skillIdValue.trim() : '';
        return name && skillId ? [{ name, skillId }] : [];
      })
    : [];
  const message = typeof data.message === 'string' ? data.message : undefined;

  if (
    loadedSkillIds.length === 0
    && loadedToolNames.length === 0
    && loadedTools.length === 0
    && !message
  ) {
    return null;
  }

  return {
    loadedSkillIds,
    loadedToolNames,
    loadedTools,
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
    <CustomScrollArea
      fullHeight={false}
      className="max-h-60"
      viewportClassName="max-h-60"
    >
      <pre className="text-xs whitespace-pre-wrap break-words font-mono text-muted-foreground">
        {formattedJson}
      </pre>
    </CustomScrollArea>
  );
};

/** 文本输出折叠阈值：超过后默认只显示头部，可一键展开/收起 */
const TEXT_OUTPUT_COLLAPSE_CHARS = 1500;

/**
 * 文本输出渲染（长文本默认折叠，块内展开，不弹层）
 */
const TextOutput: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > TEXT_OUTPUT_COLLAPSE_CHARS;
  const displayText = !isLong || expanded ? text : text.slice(0, TEXT_OUTPUT_COLLAPSE_CHARS) + '…';
  const content = (
    <div className="text-sm text-foreground whitespace-pre-wrap break-words">
      {displayText}
    </div>
  );

  return (
    <div>
      {isLong && expanded ? (
        <CustomScrollArea fullHeight={false} className="max-h-96" viewportClassName="max-h-96">
          {content}
        </CustomScrollArea>
      ) : content}
      {isLong && (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="mt-1 !h-auto !px-1.5 !py-0.5 text-[11px] text-muted-foreground hover:text-foreground relative after:absolute after:-inset-y-2.5 after:inset-x-0 after:content-[''] [@media(pointer:coarse)]:!min-h-11"
        >
          {expanded
            ? t('blocks.mcpTool.collapseLongOutput')
            : t('blocks.mcpTool.expandLongOutput', { count: text.length })}
        </DsButton>
      )}
    </div>
  );
};

/**
 * 表格输出渲染
 */
const TableOutput: React.FC<{ data: Record<string, unknown>[] }> = ({ data }) => {
  const { t } = useTranslation('chatV2');
  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);
  const maxRows = 10;
  const displayData = data.slice(0, maxRows);
  const hasMore = data.length > maxRows;

  return (
    <CustomScrollArea
      orientation="both"
      fullHeight={false}
      className="max-h-60"
      viewportClassName="max-h-60"
    >
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
          {t('blocks.mcpTool.moreRows', { count: data.length - maxRows })}
        </div>
      )}
    </CustomScrollArea>
  );
};

/**
 * 图片输出渲染
 */
const ImageOutput: React.FC<{ output: unknown }> = ({ output }) => {
  const { t } = useTranslation('chatV2');
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
        alt={t('blocks.mcpTool.toolOutputImage')}
        className="max-w-full max-h-60 rounded object-contain"
        loading="lazy"
      />
    </div>
  );
};

const LoadSkillsSummary: React.FC<{ data: LoadSkillsSummaryData }> = ({ data }) => {
  const { t } = useTranslation(['chatV2', 'skills', 'mcp']);
  const structuredToolNames = new Set(data.loadedTools.map((tool) => tool.name));
  const legacyToolNames = data.loadedToolNames.filter((name) => !structuredToolNames.has(name));
  const hasLoadedTools = data.loadedTools.length > 0 || legacyToolNames.length > 0;

  if (data.loadedSkillIds.length === 0 && !hasLoadedTools && !data.message) {
    return null;
  }

  return (
    <div className="space-y-2 mb-2">
      {data.loadedSkillIds.length > 0 && (
        <div>
          <div className="text-xs font-medium text-foreground/80 mb-1.5">
            {t('blocks.mcpTool.loadedSkills', { ns: 'chatV2' })}
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

      {hasLoadedTools && (
        <div>
          <div className="text-xs font-medium text-foreground/80 mb-1.5">
            {t('blocks.mcpTool.loadedTools', { ns: 'chatV2' })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.loadedTools.map(({ name, skillId }) => (
              <span
                key={`${skillId}:${name}`}
                title={`${skillId}: ${name}`}
                className="inline-flex items-center rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-xs text-foreground"
              >
                {getReadableToolName(name, t, BUILTIN_TOOL_SKILL_IDS.has(skillId)
                  ? { source: 'builtin' }
                  : { source: 'external', providerName: skillId })}
              </span>
            ))}
            {legacyToolNames.map((toolName) => (
              <span
                key={`legacy:${toolName}`}
                title={toolName}
                className="inline-flex items-center rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-xs text-foreground"
              >
                {getReadableToolName(toolName, t, {
                  source: 'external',
                  providerName: t('labels.skill', { ns: 'mcp' }),
                })}
              </span>
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

interface BrowserScreenshotSummaryData {
  available: boolean;
  width?: number;
  height?: number;
  annotated: boolean;
  url?: string;
  urlHost?: string;
  locator?: string;
  artifactPath?: string;
  reason?: string;
}

function extractUrlHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host || rawUrl;
  } catch {
    return rawUrl;
  }
}

function extractBrowserScreenshotSummary(output: unknown): BrowserScreenshotSummaryData | null {
  const data = unwrapLoadSkillsPayload(output);
  if (!data) return null;

  const action = typeof data.action === 'string' ? data.action : '';
  if (action !== 'screenshot' && action !== 'screenshot_capability') {
    return null;
  }

  const available = data.available !== false;
  const width = typeof data.width === 'number' && Number.isFinite(data.width) && data.width > 0
    ? data.width
    : undefined;
  const height = typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0
    ? data.height
    : undefined;
  const annotated = data.annotated === true;
  const url = typeof data.url === 'string' && data.url.trim() ? data.url.trim() : undefined;
  const urlHost = url ? extractUrlHost(url) : undefined;
  const locator = typeof data.locator === 'string' && data.locator.trim() ? data.locator.trim() : undefined;
  const artifactPath = typeof data.artifact_path === 'string' && data.artifact_path.trim()
    ? data.artifact_path.trim()
    : undefined;
  const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : undefined;

  if (available && width === undefined && height === undefined && !urlHost && !locator && !artifactPath) {
    return null;
  }

  return {
    available,
    width,
    height,
    annotated,
    url,
    urlHost,
    locator,
    artifactPath,
    reason,
  };
}

const BrowserScreenshotSummary: React.FC<{ data: BrowserScreenshotSummaryData }> = ({ data }) => {
  const { t } = useTranslation('chatV2');
  const artifactRef = data.locator ?? data.artifactPath;
  const hasResolution = data.width !== undefined && data.height !== undefined;

  return (
    <div
      data-testid="browser-screenshot-summary"
      className="mb-2 rounded border border-border/40 bg-background/60 px-2.5 py-2 text-xs space-y-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {hasResolution && (
          <span className="inline-flex items-center gap-1 font-medium text-foreground tabular-nums">
            <ImageIcon size={12} className="shrink-0 text-muted-foreground" />
            <span>{`${data.width} × ${data.height}`}</span>
          </span>
        )}
        {data.annotated && (
          <span className="inline-flex items-center rounded border border-border/50 bg-muted/60 px-1.5 py-0.5 text-2xs leading-none text-foreground/80">
            {t('blocks.mcpTool.browserScreenshot.annotated')}
          </span>
        )}
        {data.urlHost && (
          <span
            className="inline-flex min-w-0 max-w-[220px] items-center gap-1 text-muted-foreground"
            title={data.url ?? data.urlHost}
          >
            <Globe size={12} className="shrink-0" />
            <span className="min-w-0 truncate font-mono">{data.urlHost}</span>
          </span>
        )}
        {!data.available && (
          <span className="text-warning">
            {data.reason
              ? `${t('blocks.mcpTool.browserScreenshot.unavailable')} (${data.reason})`
              : t('blocks.mcpTool.browserScreenshot.unavailable')}
          </span>
        )}
      </div>

      {artifactRef && (
        <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="shrink-0">{t('blocks.mcpTool.browserScreenshot.artifact')}</span>
          <span
            className="min-w-0 truncate font-mono text-foreground/80"
            title={data.artifactPath ?? data.locator}
          >
            {artifactRef}
          </span>
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
  const browserScreenshotSummary = useMemo(() => extractBrowserScreenshotSummary(output), [output]);
  const [copied, setCopied] = useState(false);

  // 内联复制输出（文本原样，其余序列化为 JSON）
  const copyableText = useMemo(() => {
    if (output === null || output === undefined) return null;
    if (typeof output === 'string') return output;
    if (outputType === 'image') return null;
    try {
      return JSON.stringify(output, null, 2) ?? String(output);
    } catch {
      return String(output);
    }
  }, [output, outputType]);

  const handleCopy = useCallback(async () => {
    if (!copyableText) return;
    try {
      await copyTextToClipboard(copyableText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[ToolOutputView] Copy failed:', error);
    }
  }, [copyableText]);

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
        {copyableText && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={handleCopy}
            className="!h-5 !w-5 ml-auto text-muted-foreground hover:text-foreground relative after:absolute after:-inset-3 after:content-['']"
            aria-label={t('blocks.mcpTool.copyOutput')}
            title={t('blocks.mcpTool.copyOutput')}
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </DsButton>
        )}
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
        {browserScreenshotSummary && <BrowserScreenshotSummary data={browserScreenshotSummary} />}
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
