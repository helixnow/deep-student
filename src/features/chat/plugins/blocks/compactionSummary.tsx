/**
 * Chat V2 - Compaction Summary 块渲染插件（P1）
 *
 * 渲染一次上下文压缩（compaction）产生的锚定摘要。
 * 摘要内容由后端按"学习状态"模板生成（科目/目标/已掌握/薄弱点/当前任务/…）。
 *
 * 视图语义：
 * - 默认折叠，只显示"🗜️ 上下文已压缩"标签
 * - 展开显示摘要 Markdown 正文
 *
 * 备注：
 *   该 block 由后端一次性产出（status=success，不会流式），所以
 *   `isStreaming` 总为 false，这里不做流式特殊处理。
 *
 * 自执行注册：import 即注册。
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import {
  CaretDown,
  CaretRight,
  Archive,
  Copy,
  Check,
  ArrowCounterClockwise,
  CircleNotch,
  WarningCircle,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingMarkdownRenderer } from '../../components/renderers';
import { getChatMessageListScrollHandle } from '../../components/messageListScrollRegistry';

interface CompactionMetadata {
  sessionId?: string;
  compactionId?: string;
  isActive?: boolean;
  previousCompactionId?: string | null;
  rangeStartMessageId?: string;
  rangeEndMessageId?: string;
  tailStartMessageId?: string;
  compactedMessageCount?: number;
  tailMessageCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryTokens?: number;
  summaryPasses?: number;
  modelId?: string;
}

function readCompactionMetadata(value: unknown): CompactionMetadata {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const raw = parsed as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === 'string' ? raw[key] : undefined);
  const count = (key: string) => {
    const candidate = raw[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
  };
  return {
    sessionId: text('sessionId'),
    compactionId: text('compactionId'),
    isActive: typeof raw.isActive === 'boolean' ? raw.isActive : undefined,
    previousCompactionId:
      raw.previousCompactionId === null ? null : text('previousCompactionId'),
    rangeStartMessageId: text('rangeStartMessageId'),
    rangeEndMessageId: text('rangeEndMessageId'),
    tailStartMessageId: text('tailStartMessageId'),
    compactedMessageCount: count('compactedMessageCount'),
    tailMessageCount: count('tailMessageCount'),
    tokensBefore: count('tokensBefore'),
    tokensAfter: count('tokensAfter'),
    summaryTokens: count('summaryTokens'),
    summaryPasses: count('summaryPasses'),
    modelId: text('modelId'),
  };
}

const CompactionSummaryBlock: React.FC<BlockComponentProps> = React.memo(({ block, store }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isUndone, setIsUndone] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  // 定位失败的两种语义：目标消息不在当前会话（已删除/属其他会话）vs 视图未就绪
  const [locateError, setLocateError] = useState<'not_found' | 'not_ready' | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const content = block.content || '';
  const metadata = useMemo(
    () => readCompactionMetadata(block.toolOutput),
    [block.toolOutput]
  );

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await copyTextToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[CompactionSummaryBlock] Copy failed:', error);
    }
  }, [content]);

  const handleUndo = useCallback(async () => {
    const sessionId = metadata.sessionId || store?.getState().sessionId;
    if (!sessionId || !metadata.compactionId || isUndoing) return;
    setIsUndoing(true);
    setUndoError(null);
    try {
      await invoke('chat_v2_undo_compaction', {
        sessionId,
        compactionId: metadata.compactionId,
      });
      setIsUndone(true);
      try {
        await store?.getState().loadSession(sessionId);
      } catch (reloadError) {
        console.error(
          '[CompactionSummaryBlock] Compaction undone but session reload failed:',
          reloadError
        );
      }
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUndoing(false);
    }
  }, [isUndoing, metadata.compactionId, metadata.sessionId, store]);

  // 定位原始消息：走 messageListScrollRegistry 的程序化滚动 handle（A45-5）。
  // 直接 querySelector + scrollIntoView 有两个坑：虚拟化长会话下目标行未渲染
  // 必然找不到；scrollIntoView 会连带滚动 OS/workbench 宿主窗口。
  // rangeStartMessageId 是被压缩区间首条消息的 ID——压缩只影响模型视图，
  // 原始消息仍在会话的 messageOrder 里，与 scrollToMessage 的语义匹配。
  const handleLocateOriginal = useCallback(async () => {
    const messageId = metadata.rangeStartMessageId;
    if (!messageId || isLocating) return;
    // 注册表 key 是「当前渲染本块的会话」——优先取 store 的 sessionId
    //（分支克隆会话中 metadata.sessionId 可能仍指向源会话）
    const sessionId = store?.getState().sessionId || metadata.sessionId;
    setIsLocating(true);
    try {
      const handle = sessionId ? getChatMessageListScrollHandle(sessionId) : null;
      if (!handle) {
        setLocateError('not_ready');
        return;
      }
      const outcome = await handle.scrollToMessage(messageId);
      if (outcome.status === 'scrolled') {
        setLocateError(null);
      } else if (outcome.status === 'message_not_found') {
        setLocateError('not_found');
      } else {
        setLocateError('not_ready');
      }
    } finally {
      setIsLocating(false);
    }
  }, [isLocating, metadata.rangeStartMessageId, metadata.sessionId, store]);

  if (!content.trim()) return null;

  const contentId = `compaction-summary-${block.id}`;

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-warning/5 border-warning/30',
        'transition-colors'
      )}
    >
      <DsButton
        variant="ghost"
        size="sm"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="w-full !justify-start gap-2 !px-3 !py-2 !rounded-lg text-warning"
      >
        {isExpanded ? <CaretDown size={16} /> : <CaretRight size={16} />}
        <Archive size={16} />
        <span className="font-medium">{t('blocks.compactionSummary.title')}</span>
        {!isExpanded && (
          <span className="ml-auto text-xs text-warning/80">
            {t('blocks.compactionSummary.expandHint')}
          </span>
        )}
      </DsButton>

      {isExpanded && (
        <div
          id={contentId}
          className={cn(
            'px-3 pb-3 thinking-content',
            'border-t border-warning/20',
            'text-foreground/90'
          )}
        >
          <div className="pt-2">
            <StreamingMarkdownRenderer
              content={content}
              isStreaming={false}
              blockId={block.id}
              messageId={block.messageId}
            />
          </div>
          {(metadata.compactedMessageCount !== undefined ||
            metadata.tokensBefore !== undefined ||
            metadata.modelId) && (
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              {metadata.compactedMessageCount !== undefined && (
                <span className="rounded bg-muted/60 px-2 py-1">
                  {t('blocks.compactionSummary.messageCount', {
                    count: metadata.compactedMessageCount,
                  })}
                </span>
              )}
              {metadata.tokensBefore !== undefined && metadata.tokensAfter !== undefined && (
                <span className="rounded bg-muted/60 px-2 py-1 tabular-nums">
                  {t('blocks.compactionSummary.tokenChange', {
                    before: metadata.tokensBefore.toLocaleString(),
                    after: metadata.tokensAfter.toLocaleString(),
                  })}
                </span>
              )}
              {metadata.summaryPasses !== undefined && (
                <span className="rounded bg-muted/60 px-2 py-1">
                  {t('blocks.compactionSummary.summaryPasses', {
                    count: metadata.summaryPasses,
                  })}
                </span>
              )}
              {metadata.modelId && (
                <span className="max-w-full truncate rounded bg-muted/60 px-2 py-1">
                  {metadata.modelId}
                </span>
              )}
            </div>
          )}
          {undoError && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <WarningCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{t('blocks.compactionSummary.undoFailed')}</span>
            </div>
          )}
          {locateError && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
              <WarningCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                {locateError === 'not_found'
                  ? t('blocks.compactionSummary.originalMissing')
                  : t('blocks.compactionSummary.originalNotLoaded')}
              </span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground italic">
              {t('blocks.compactionSummary.footnote')}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {metadata.rangeStartMessageId && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleLocateOriginal}
                  disabled={isLocating}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('blocks.compactionSummary.locateOriginal')}
                  title={t('blocks.compactionSummary.locateOriginal')}
                >
                  {isLocating ? (
                    <CircleNotch size={12} className="animate-spin" />
                  ) : (
                    <MagnifyingGlass size={12} />
                  )}
                  <span className="text-xs">
                    {t('blocks.compactionSummary.locateOriginal')}
                  </span>
                </DsButton>
              )}
              {metadata.compactionId && metadata.isActive !== false && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleUndo}
                  disabled={isUndoing || isUndone}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('blocks.compactionSummary.undo')}
                  title={t('blocks.compactionSummary.undoHint')}
                >
                  {isUndoing ? (
                    <CircleNotch size={12} className="animate-spin" />
                  ) : isUndone ? (
                    <Check size={12} className="text-success" />
                  ) : (
                    <ArrowCounterClockwise size={12} />
                  )}
                  <span className="text-xs">
                    {isUndone
                      ? t('blocks.compactionSummary.undone')
                      : t('blocks.compactionSummary.undo')}
                  </span>
                </DsButton>
              )}
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('blocks.compactionSummary.copy')}
                title={t('blocks.compactionSummary.copy')}
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                <span className="text-xs">
                  {copied ? t('blocks.compactionSummary.copied') : t('blocks.compactionSummary.copy')}
                </span>
              </DsButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

CompactionSummaryBlock.displayName = 'CompactionSummaryBlock';

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('compaction_summary', {
  type: 'compaction_summary',
  component: CompactionSummaryBlock,
  onAbort: 'keep-content',
});

export { CompactionSummaryBlock };
