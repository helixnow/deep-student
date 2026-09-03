/**
 * RawRequestPreview - 开发者调试：LLM 请求体预览
 *
 * 从 MessageItem.tsx 抽出的独立子组件（仅在开发者选项开启时渲染）：
 * - 多轮请求切换（R1/R2/...）
 * - 请求体统计（体积 / 消息数 / 图片数 / 工具数）
 * - 按 CopyFilterConfig 分段过滤后复制
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { CopyFilterConfig } from '../../hooks/useDevShowRawRequest';

// ============================================================================
// 类型
// ============================================================================

export type RawRequest = {
  _source?: string;
  model?: string;
  url?: string;
  body?: unknown;
  logFilePath?: string;
};

export interface RawRequestPreviewProps {
  rawRequests?: Array<{
    _source: string;
    model: string;
    url: string;
    body: unknown;
    logFilePath?: string;
    round: number;
  }>;
  rawRequest?: RawRequest;
  copyFilterConfig: CopyFilterConfig;
}

// ============================================================================
// 复制过滤：按 CopyFilterConfig 分段处理请求体
// ============================================================================

async function applyCopyFilter(
  raw: RawRequest,
  _isBackendLlm: boolean,
  fallbackText: string,
  cfg: CopyFilterConfig,
  t: (key: string, options?: Record<string, unknown>) => string,
  notify: (type: 'warning' | 'info', msg: string) => void,
): Promise<string> {
  const needsFullSource = cfg.images === 'full' || cfg.tools === 'full';

  let body: Record<string, unknown> | null = null;
  let usedRawBody = false;

  if (needsFullSource && raw.logFilePath) {
    try {
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      const fullContent = await tauriInvoke<string>('read_debug_log_file', { path: raw.logFilePath });
      body = JSON.parse(fullContent) as Record<string, unknown>;
    } catch {
      notify('warning', t('messageItem.rawRequest.logReadFailed'));
      body = (raw.body ? raw.body : raw) as Record<string, unknown>;
      usedRawBody = true;
    }
  } else if (needsFullSource && !raw.logFilePath) {
    notify('warning', t('messageItem.rawRequest.persistentLogRequired'));
    body = (raw.body ? raw.body : raw) as Record<string, unknown>;
    usedRawBody = true;
  } else {
    body = (raw.body ? raw.body : raw) as Record<string, unknown>;
    usedRawBody = true;
  }

  if (body && usedRawBody && typeof body === 'object' && !Array.isArray(body) && body.messages === undefined && fallbackText) {
    try {
      const parsed = JSON.parse(fallbackText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.messages !== undefined) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* fallbackText parse failed, keep original body */ }
  }

  if (!body) return fallbackText || '{}';

  const result: Record<string, unknown> = {};

  // 标量参数始终保留
  for (const k of ['model', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens', 'tool_choice']) {
    if (body[k] !== undefined) result[k] = body[k];
  }

  // Thinking
  if (cfg.thinking === 'full') {
    for (const k of ['enable_thinking', 'thinking_budget', 'thinking']) {
      if (body[k] !== undefined) result[k] = body[k];
    }
  }

  // Messages
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (msgs) {
    if (cfg.messages === 'full') {
      result.messages = filterImages(msgs, cfg.images);
    } else if (cfg.messages === 'truncate') {
      result.messages = filterImages(msgs, cfg.images).map((m: Record<string, unknown>) => {
        if (typeof m.content === 'string' && m.content.length > cfg.messageTruncateLength) {
          return { ...m, content: m.content.slice(0, cfg.messageTruncateLength) + `...[truncated, total ${m.content.length} chars]` };
        }
        if (Array.isArray(m.content)) {
          return { ...m, content: truncateMultimodalContent(m.content as Array<Record<string, unknown>>, cfg) };
        }
        return m;
      });
    } else {
      result.messages_summary = msgs.map(m => ({
        role: m.role,
        content_type: Array.isArray(m.content) ? 'multimodal' : 'text',
        content_size: typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? m.content.length : 0,
      }));
    }
  }

  // Tools
  const toolsArr = body.tools as Array<Record<string, unknown>> | undefined;
  if (toolsArr) {
    if (cfg.tools === 'full') {
      result.tools = toolsArr;
    } else if (cfg.tools === 'summary') {
      const names = extractToolNames(toolsArr);
      result.tools = [{ _summary: `${toolsArr.length} tools: [${names.join(', ')}]` }];
    } else if (cfg.tools === 'names_only') {
      result.tool_names = extractToolNames(toolsArr);
    }
    // 'remove' → 不包含 tools
  }

  return JSON.stringify(result, null, 2);
}

function extractToolNames(toolsArr: Array<Record<string, unknown>>): string[] {
  return toolsArr.flatMap(t => {
    const name = (t.function as Record<string, unknown> | undefined)?.name;
    if (typeof name === 'string') return [name];
    const summary = t._summary;
    if (typeof summary === 'string') {
      const match = summary.match(/\[(.+)\]/);
      return match ? match[1].split(',').map(s => s.trim()) : [];
    }
    return [];
  });
}

function filterImages(msgs: Array<Record<string, unknown>>, mode: CopyFilterConfig['images']): Array<Record<string, unknown>> {
  if (mode === 'full') return msgs;
  return msgs.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = (msg.content as Array<Record<string, unknown>>)
      .map(part => {
        if (part.type !== 'image_url') return part;
        if (mode === 'remove') return null;
        const urlVal = (part.image_url as Record<string, unknown> | undefined)?.url;
        if (typeof urlVal === 'string' && urlVal.startsWith('data:')) {
          const base64Len = urlVal.indexOf(',') >= 0 ? urlVal.length - urlVal.indexOf(',') - 1 : urlVal.length;
          return { type: 'image_url', image_url: { url: `[base64 image: ~${Math.round(base64Len * 3 / 4 / 1024)}KB, ${base64Len} chars]` } };
        }
        return part;
      })
      .filter(Boolean);
    return { ...msg, content: filtered };
  });
}

function truncateMultimodalContent(parts: Array<Record<string, unknown>>, cfg: CopyFilterConfig): Array<Record<string, unknown>> {
  return parts.map(part => {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > cfg.messageTruncateLength) {
      return { ...part, text: part.text.slice(0, cfg.messageTruncateLength) + `...[truncated, total ${part.text.length} chars]` };
    }
    return part;
  });
}

// ============================================================================
// 请求体统计信息提取
// ============================================================================

interface RequestBodyStats {
  bodyChars: number;
  messageCount: number;
  imageCount: number;
  toolCount: number;
  toolCallMsgCount: number;
  toolResultMsgCount: number;
  systemPromptChars: number;
}

function extractRequestStats(body: unknown): RequestBodyStats {
  const stats: RequestBodyStats = {
    bodyChars: 0,
    messageCount: 0,
    imageCount: 0,
    toolCount: 0,
    toolCallMsgCount: 0,
    toolResultMsgCount: 0,
    systemPromptChars: 0,
  };

  if (!body || typeof body !== 'object') return stats;

  stats.bodyChars = JSON.stringify(body).length;
  const obj = body as Record<string, unknown>;

  const msgs = obj.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(msgs)) {
    stats.messageCount = msgs.length;
    for (const msg of msgs) {
      const role = msg.role as string | undefined;
      if (role === 'system' && typeof msg.content === 'string') {
        stats.systemPromptChars += msg.content.length;
      }
      if (role === 'tool') stats.toolResultMsgCount++;
      if (msg.tool_calls) stats.toolCallMsgCount++;

      if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'image_url') stats.imageCount++;
        }
      }
    }
  }

  const tools = obj.tools as unknown[] | undefined;
  if (Array.isArray(tools)) {
    stats.toolCount = tools.length;

    // 后端标准级别会把 tools 合并为一个 _summary 对象，尝试从中提取数量
    if (tools.length === 1) {
      const first = tools[0] as Record<string, unknown>;
      if (typeof first._summary === 'string') {
        const match = (first._summary as string).match(/^(\d+) tools:/);
        if (match) stats.toolCount = parseInt(match[1], 10);
      }
    }
  }

  return stats;
}

function formatStatsLine(
  stats: RequestBodyStats,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  parts.push(t('messageItem.rawRequest.stats.bodyChars', { kb: (stats.bodyChars / 1024).toFixed(1) }));
  parts.push(t('messageItem.rawRequest.stats.messages', { count: stats.messageCount }));
  if (stats.imageCount > 0) parts.push(t('messageItem.rawRequest.stats.images', { count: stats.imageCount }));
  if (stats.toolCount > 0) parts.push(t('messageItem.rawRequest.stats.tools', { count: stats.toolCount }));
  if (stats.toolCallMsgCount > 0) parts.push(t('messageItem.rawRequest.stats.toolCalls', { count: stats.toolCallMsgCount }));
  if (stats.toolResultMsgCount > 0) parts.push(t('messageItem.rawRequest.stats.toolResults', { count: stats.toolResultMsgCount }));
  return parts.join(' · ');
}

// ============================================================================
// 组件
// ============================================================================

export function RawRequestPreview({ rawRequests, rawRequest, copyFilterConfig }: RawRequestPreviewProps) {
  // 显式使用 chatV2 命名空间（messageItem.rawRequest.* 定义在 chatV2.json），
  // 避免依赖 40+ 个 fallbackNS 的全量扫描
  const { t } = useTranslation('chatV2');
  const rounds = rawRequests ?? [];
  const fallbackRaw = rawRequest;

  const allRounds = rounds.length > 0 ? rounds : (fallbackRaw ? [{
    _source: fallbackRaw._source ?? '',
    model: fallbackRaw.model ?? '',
    url: fallbackRaw.url ?? '',
    body: fallbackRaw._source === 'backend_llm' ? fallbackRaw.body : fallbackRaw,
    logFilePath: fallbackRaw.logFilePath,
    round: 1,
  }] : []);

  const [selectedRound, setSelectedRound] = React.useState(allRounds.length);

  React.useEffect(() => {
    setSelectedRound(allRounds.length);
  }, [allRounds.length]);

  if (allRounds.length === 0) return null;

  const activeIdx = Math.min(selectedRound, allRounds.length) - 1;
  const current = allRounds[activeIdx];
  const isBackendLlm = current._source === 'backend_llm';
  const displayBody = current.body;
  const displayText = JSON.stringify(displayBody, null, 2);
  const stats = extractRequestStats(displayBody);

  const handleCopy = async () => {
    try {
      const needsFullSource = copyFilterConfig.images === 'full' || copyFilterConfig.tools === 'full';
      let textToCopy = displayText;

      if (needsFullSource && current.logFilePath) {
        try {
          const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
          const fullContent = await tauriInvoke<string>('read_debug_log_file', { path: current.logFilePath });
          const fullBody = JSON.parse(fullContent);
          const asRaw: RawRequest = {
            _source: current._source,
            model: current.model,
            url: current.url,
            body: fullBody,
            logFilePath: current.logFilePath,
          };
          textToCopy = await applyCopyFilter(asRaw, isBackendLlm, displayText, copyFilterConfig, t, showGlobalNotification);
        } catch {
          showGlobalNotification('warning', t('messageItem.rawRequest.logReadFailed'));
        }
      }

      await copyTextToClipboard(textToCopy);
      showGlobalNotification('success', t('messageItem.rawRequest.copySuccess'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.rawRequest.copyFailed'));
    }
  };

  return (
    <div className="mt-4 rounded-md border border-border/50 bg-muted/30 p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          {isBackendLlm
            ? t('messageItem.rawRequest.titleWithModel', { model: current.model })
            : t('messageItem.rawRequest.title')}
          {current.logFilePath && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-success/10 text-success">{t('messageItem.rawRequest.persisted')}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleCopy} title={t('messageItem.rawRequest.copy')}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {t('messageItem.rawRequest.copy')}
          </DsButton>
        </div>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground/70 flex flex-wrap gap-x-2.5 gap-y-0.5">
        <span>{formatStatsLine(stats, t)}</span>
      </div>

      {allRounds.length > 1 && (
        <div className="mb-2 flex items-center gap-1 flex-wrap">
          {allRounds.map((r, i) => {
            const rStats = extractRequestStats(r.body);
            return (
              <button
                key={i}
                type="button"
                aria-pressed={i === activeIdx}
                onClick={() => setSelectedRound(i + 1)}
                className={`px-2 py-0.5 text-2xs rounded transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 ${
                  i === activeIdx
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground/60 hover:bg-[var(--interactive-hover)]'
                }`}
                title={rStats.toolCallMsgCount > 0
                  ? t('messageItem.rawRequest.roundTooltipWithToolCalls', {
                    round: i + 1,
                    messageCount: rStats.messageCount,
                    toolCallMsgCount: rStats.toolCallMsgCount,
                  })
                  : t('messageItem.rawRequest.roundTooltip', {
                    round: i + 1,
                    messageCount: rStats.messageCount,
                  })}
              >
                R{i + 1}
                {rStats.toolCallMsgCount > 0 && <span className="ml-0.5 opacity-60">🔧</span>}
              </button>
            );
          })}
        </div>
      )}

      {isBackendLlm && current.url && (
        <div className="mb-1.5 text-[11px] text-muted-foreground/70 font-mono truncate" title={current.url}>
          POST {current.url}
        </div>
      )}

      <CustomScrollArea
        orientation="both"
        fullHeight={false}
        className="max-h-80 rounded bg-background/80"
        viewportClassName="max-h-80"
      >
        <pre className="p-2 text-xs text-foreground/80 font-mono">{displayText}</pre>
      </CustomScrollArea>
    </div>
  );
}

export default RawRequestPreview;
