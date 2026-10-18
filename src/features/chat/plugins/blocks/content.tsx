/**
 * Chat V2 - 正文块渲染插件
 *
 * 渲染 AI 的主要回复内容
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingBlockRenderer } from '../../components/renderers';
import { citationEvents } from '../../utils/citationEvents';
import { CitationSourceContext } from '../../utils/citationSourceContext';
import type { RetrievalSource, RetrievalSourceType } from './components/types';
import { useMessage, useMessageBlocks } from '../../hooks/useChatStore';
import { extractSourcesFromMessageBlocks, resolveCitationSource as resolveSourceByCitation } from '../../components/panels/sourceAdapter';
import { useStableSourceBlocks } from '../../components/panels/useStableSourceBlocks';
import type { UnifiedSourceItem } from '../../components/panels/sourceTypes';
import { maskSecrets, shouldMaskUserContent } from '../../utils/secretMask';

// ============================================================================
// 正文块组件
// ============================================================================

/**
 * ContentBlock - 正文块渲染组件
 *
 * 功能：
 * 1. 流式 Markdown 渲染
 * 2. 代码高亮
 * 3. LaTeX 公式支持
 * 4. 暗色/亮色主题支持
 * 5. 用户消息展示级密钥/令牌默认脱敏（可切换显示原文，见 secretMask.ts）
 */
type ContentBlockBaseProps = Pick<BlockComponentProps, 'block' | 'isStreaming'> & {
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => { url: string; title?: string } | null | undefined;
  /** 用户消息展示级脱敏后的正文；null/undefined 表示渲染原文（assistant 消息恒为 null） */
  maskedContent?: string | null;
  /** 本块被隐藏的敏感串数量；0/undefined 不渲染脱敏提示 */
  hiddenSecretCount?: number;
  /** 是否已切换为「显示原文」 */
  secretsRevealed?: boolean;
  /** 切换「显示原文 / 隐藏原文」 */
  onToggleSecrets?: () => void;
};

/**
 * 脱敏提示行：`已隐藏 N 处疑似密钥/令牌` + `显示原文 / 隐藏原文` 按钮。
 *
 * 独立成组件是为了让未命中敏感串的块（绝大多数 assistant 消息）完全不调用
 * useTranslation、不产生额外 DOM —— 保持原渲染路径零开销。
 */
const SecretMaskNotice: React.FC<{
  count: number;
  revealed: boolean;
  onToggle: () => void;
}> = ({ count, revealed, onToggle }) => {
  const { t } = useTranslation('chatV2');

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground select-none">
      <span>{t('messageItem.secretMask.detected', { count })}</span>
      <DsButton
        variant="ghost"
        size="sm"
        aria-pressed={revealed}
        onClick={onToggle}
        className="!h-auto !min-h-0 !border-0 !bg-transparent !px-0 !py-0 !text-xs !font-normal text-muted-foreground underline decoration-dotted underline-offset-2 hover:!bg-transparent hover:text-foreground"
      >
        {revealed ? t('messageItem.secretMask.hide') : t('messageItem.secretMask.show')}
      </DsButton>
    </div>
  );
};

const ContentBlockBase: React.FC<ContentBlockBaseProps> = ({
  block,
  isStreaming,
  resolveCitationImage,
  maskedContent,
  hiddenSecretCount,
  secretsRevealed,
  onToggleSecrets,
}) => {
  const content = block.content || '';
  // 命中脱敏时用 masked 文本（默认）或原文（用户点「显示原文」后）渲染
  const displayContent = maskedContent ?? content;
  const showSecretNotice = (hiddenSecretCount ?? 0) > 0 && onToggleSecrets != null;

  // P2-5：不再在这里额外挂 makeCitationRemarkPlugin。
  // MarkdownRenderer 检测到 onCitationClick/resolveCitationImage 后会自动注册
  // 同一插件，双份注册只会白跑一次 AST 遍历。

  // 🆕 引用点击处理：发射事件到来源面板（带 messageId，面板侧按消息过滤）
  const handleCitationClick = useCallback((type: string, index: number) => {
    citationEvents.emit({
      type: type as RetrievalSourceType,
      index,
      messageId: block.messageId,
    });
  }, [block.messageId]);

  // 无内容时显示占位符
  if (!content && !isStreaming) {
    return null;
  }

  return (
    <div className="chat-message-body chat-message-body--markdown">
      <StreamingBlockRenderer
        content={displayContent}
        isStreaming={isStreaming ?? false}
        onCitationClick={handleCitationClick}
        resolveCitationImage={resolveCitationImage}
        blockId={block.id}
        messageId={block.messageId}
      />
      {showSecretNotice && (
        <SecretMaskNotice
          count={hiddenSecretCount ?? 0}
          revealed={secretsRevealed ?? false}
          onToggle={onToggleSecrets}
        />
      )}
    </div>
  );
};

const ContentBlockWithStore: React.FC<BlockComponentProps> = ({ block, isStreaming, store }) => {
  const messageBlocks = useMessageBlocks(store!, block.messageId);
  const message = useMessage(store!, block.messageId);
  const content = block.content || '';

  // 🔐 用户消息展示级脱敏（assistant 消息不处理）：
  // - 仅 role === 'user' 且确实命中敏感串才启用；未命中/assistant 完全走原渲染路径；
  // - 用户消息内容非流式，按 content 缓存检测结果；只有命中时才会出现第二次扫描
  //   （shouldMaskUserContent 内部已做一次，maskSecrets 复扫），成本可忽略。
  const secretMask = useMemo(() => {
    if (!shouldMaskUserContent(message?.role, content)) return null;
    const result = maskSecrets(content);
    return result.count > 0 ? result : null;
  }, [message?.role, content]);
  const hiddenSecretCount = secretMask?.count ?? 0;

  // 「显示原文」只对当前块、当前内容生效；内容一变（编辑/重试）自动回到默认脱敏，
  // 不依赖 effect，避免先闪过一帧原文。
  const [secretReveal, setSecretReveal] = useState<{ content: string; revealed: boolean } | null>(null);
  const secretsRevealed =
    secretReveal !== null && secretReveal.content === content && secretReveal.revealed;
  const toggleSecrets = useCallback(() => {
    setSecretReveal((prev) => ({
      content,
      revealed: !(prev !== null && prev.content === content && prev.revealed),
    }));
  }, [content]);

  // 流式期间 content 块每次 flush 换新引用会让 messageBlocks 整体换引用；
  // 先折叠为"仅来源相关块"的稳定数组，来源未变时 sourceBundle 保持同一引用，
  // 下游三个 resolver 回调与 CitationSourceContext value 不再每次 flush 击穿
  // MemoizedBlock 的已完成块缓存
  const sourceBlocks = useStableSourceBlocks(messageBlocks);
  const sourceBundle = useMemo(() => {
    return extractSourcesFromMessageBlocks(sourceBlocks);
  }, [sourceBlocks]);

  // 按"类型内 1-based 序号"（[类型-N] 的 N，契约不可变）查找来源项。
  // 使用 adapter 的 resolveCitationSource（基于 typeIndex，按全局出现顺序计数），
  // 与来源面板卡片编号完全对齐；多 provider 结果交错时不会与扁平下标错位。
  const findSourceItem = useCallback((type: RetrievalSourceType, index: number): UnifiedSourceItem | null => {
    return resolveSourceByCitation(sourceBundle, type, index);
  }, [sourceBundle]);

  const resolveCitationImage = useCallback((type: RetrievalSourceType, index: number) => {
    const item = findSourceItem(type, index);
    if (!item) return null;
    
    // 🔧 修复：优先使用后端返回的 imageUrl 字段，支持 RAG 和多模态检索结果
    const url = item.imageUrl || item.multimodal?.thumbnailBase64 || item.raw?.url || item.link;
    
    // 🔧 新增：如果没有直接的图片 URL，但有 resourceId + pageIndex，返回用于异步加载
    // 支持 PDF 页面图片的按需获取（textbook/attachment/exam 类型）
    const canLoadPdfPage = item.resourceId && item.pageIndex !== undefined && item.pageIndex !== null;
    
    if (!url && !canLoadPdfPage) return null;
    
    return { 
      url, 
      title: item.title,
      // PDF 页面图片异步加载所需字段
      resourceId: item.resourceId,
      pageIndex: item.pageIndex,
      resourceType: item.resourceType,
    };
  }, [findSourceItem]);

  // 🆕 P0-2：正文徽章 hover 即时预览所需的来源数据（标题/snippet/score/url），
  // 经 CitationSourceContext 跨过中间渲染层直达 CitationBadgeWithPopover
  const resolveCitationSource = useCallback((type: RetrievalSourceType, index: number): RetrievalSource | null => {
    const item = findSourceItem(type, index);
    if (!item) return null;
    return {
      id: item.id,
      type,
      title: item.title,
      snippet: item.snippet || item.raw?.chunk_text || '',
      url: item.link || item.raw?.url,
      score: item.score,
    };
  }, [findSourceItem]);

  return (
    <CitationSourceContext.Provider value={resolveCitationSource}>
      <ContentBlockBase
        block={block}
        isStreaming={isStreaming}
        resolveCitationImage={resolveCitationImage}
        // 默认渲染脱敏文本；用户点「显示原文」后传 null 回退原文
        maskedContent={secretMask != null && !secretsRevealed ? secretMask.masked : null}
        hiddenSecretCount={hiddenSecretCount}
        secretsRevealed={secretsRevealed}
        onToggleSecrets={hiddenSecretCount > 0 ? toggleSecrets : undefined}
      />
    </CitationSourceContext.Provider>
  );
};

const ContentBlock: React.FC<BlockComponentProps> = React.memo(({ store, ...rest }) => {
  if (!store) {
    return <ContentBlockBase {...rest} />;
  }
  return <ContentBlockWithStore store={store} {...rest} />;
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('content', {
  type: 'content',
  component: ContentBlock,
  onAbort: 'keep-content', // 中断时保留已生成内容
});

// 导出组件（可选，用于测试）
export { ContentBlock };
