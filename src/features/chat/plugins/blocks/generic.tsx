/**
 * Chat V2 - 通用块渲染插件
 *
 * Fallback 渲染器，用于未注册的块类型。
 *
 * 2026-07 改造：从开发者向 JSON dump 升级为产品态卡片——
 * 友好的"未知块类型"标题 + 状态徽章 + 折叠的输入/输出 JSON + 复制按钮。
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { Question, CircleNotch, CaretDown, Copy, Check } from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 工具函数
// ============================================================================

/** 安全序列化：循环引用/BigInt 等 JSON.stringify 会抛错的场景降级为 String() */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ============================================================================
// 子组件：折叠 JSON 区块
// ============================================================================

interface CollapsibleJsonProps {
  label: string;
  text: string;
}

const CollapsibleJson: React.FC<CollapsibleJsonProps> = ({ label, text }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation('chatV2');

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('[GenericBlock] Copy failed:', error);
    }
  }, [text]);

  return (
    <div className="mt-2 rounded-md border border-border/30 overflow-hidden">
      <div className="flex items-center bg-muted/30">
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex-1 !justify-start gap-1.5 !px-2 !py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <CaretDown
            size={12}
            className={cn('transition-transform duration-200 flex-shrink-0', !expanded && '-rotate-90')}
          />
          <span>{label}</span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={handleCopy}
          className="!h-6 !w-6 mr-1 text-muted-foreground hover:text-foreground"
          aria-label={t('blocks.generic.copy')}
          title={t('blocks.generic.copy')}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </NotionButton>
      </div>
      {expanded && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-background/50 p-2 text-xs text-muted-foreground">
          {text}
        </pre>
      )}
    </div>
  );
};

// ============================================================================
// 通用块组件
// ============================================================================

/**
 * GenericBlock - 通用块渲染组件
 *
 * 功能：
 * 1. 友好的"未知块类型"标题 + 类型标签
 * 2. 显示块内容（如果有）
 * 3. 折叠的输入/输出 JSON + 复制
 * 4. 状态徽章与流式指示器
 */
const GenericBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30'
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <Question size={16} className="text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium text-foreground">
          {t('blocks.generic.unknownType')}
        </span>
        <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {block.type}
        </span>
        <span
          className={cn(
            'text-xs px-1.5 py-0.5 rounded',
            block.status === 'success' && 'bg-success/10 text-success',
            block.status === 'error' && 'bg-destructive/10 text-destructive',
            block.status === 'running' && 'bg-primary/10 text-primary',
            block.status === 'pending' && 'bg-muted/50 text-muted-foreground'
          )}
        >
          {t(`blocks.generic.status.${block.status}`, { defaultValue: block.status })}
        </span>
        {(isStreaming || block.status === 'running') && (
          <CircleNotch size={12} className="animate-spin text-primary ml-auto" />
        )}
      </div>

      {/* 内容 */}
      {block.content && (
        <pre className="mt-2 text-sm whitespace-pre-wrap break-words text-foreground bg-background/50 p-2 rounded">
          {block.content}
        </pre>
      )}

      {/* 工具输入（折叠 JSON） */}
      {block.toolInput !== undefined && block.toolInput !== null && (
        <CollapsibleJson
          label={t('blocks.generic.input')}
          text={safeStringify(block.toolInput)}
        />
      )}

      {/* 工具输出（折叠 JSON） */}
      {block.toolOutput !== undefined && block.toolOutput !== null && (
        <CollapsibleJson
          label={t('blocks.generic.output')}
          text={
            typeof block.toolOutput === 'string'
              ? block.toolOutput
              : safeStringify(block.toolOutput)
          }
        />
      )}

      {/* 错误信息 */}
      {block.error && (
        <div className="mt-2 text-sm text-destructive break-words">
          {t('blocks.generic.error')}: {block.error}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

// 注册为 'generic' 类型（用作 fallback）
blockRegistry.register('generic', {
  type: 'generic',
  component: GenericBlock,
  onAbort: 'mark-error', // 中断时标记为错误
});

// 导出组件（可选，用于测试）
export { GenericBlock };
