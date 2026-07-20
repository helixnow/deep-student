/**
 * 翻译流式渲染容器
 *
 * 职责：
 * - 封装流式译文的渲染逻辑（纯文本，阅读向排版）
 * - 流式期间显示打字机光标，并自动贴底跟随滚动（用户上滚后停止跟随）
 * - 提供翻译专用的 UI 增强（进度提示、字符统计等）
 *
 * 与聊天模块的关系：
 * - 独立的容器逻辑，不依赖聊天消息结构
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '../components/custom-scroll-area';
import { CircleNotch } from '@phosphor-icons/react';

/**
 * 稳定文本片段：流式期间 content 只在尾部追加，
 * 按段落边界切片后，除最后一片外全部命中 memo，
 * 每帧只有尾片的文本节点真正更新
 */
const StaticSegment = React.memo<{ text: string }>(({ text }) => <span>{text}</span>);
StaticSegment.displayName = 'StaticSegment';

/** 按段落边界（连续空行，含分隔符本身）切片，保证拼接结果与原文严格一致 */
function splitStableSegments(content: string): string[] {
  const parts: string[] = [];
  const re = /\n{2,}/g;
  let idx = 0;
  while (re.exec(content) !== null) {
    parts.push(content.slice(idx, re.lastIndex));
    idx = re.lastIndex;
  }
  parts.push(content.slice(idx));
  return parts;
}

interface TranslationStreamRendererProps {
  content: string;
  isStreaming: boolean;
  placeholder?: string;
  showStats?: boolean;
  charCount?: number;
  wordCount?: number;
}

// 距底部小于该阈值时视为「贴底」，流式期间继续自动跟随
const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

const CJK_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 翻译流式渲染容器
 */
export const TranslationStreamRenderer: React.FC<TranslationStreamRendererProps & { className?: string }> = ({
  content,
  isStreaming,
  placeholder,
  showStats = true,
  charCount: providedCharCount,
  wordCount: providedWordCount,
  className,
}) => {
  const { t } = useTranslation(['translation']);
  const displayPlaceholder = placeholder || t('translation:target_section.placeholder');

  // 使用提供的统计数据，或回退到本地计算
  const charCount = providedCharCount ?? content.length;
  const wordCount = providedWordCount ?? (content.trim() ? content.trim().split(/\s+/).length : 0);
  // CJK 文本按空白分词无意义，隐藏词数
  const showWordCount = !CJK_PATTERN.test(content);

  const segments = useMemo(() => splitStableSegments(content), [content]);

  // 贴底跟随滚动：用户主动上滚后暂停跟随，滚回底部附近恢复
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isPinnedToBottomRef = useRef(true);

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    isPinnedToBottomRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX;
  }, []);

  // 用回调 ref 直接在真实滚动元素上挂原生 scroll 监听
  // （ScrollArea 的 OverlayScrollbars 分支不会把 onScroll 透传到 viewport）
  const attachViewport = useCallback((el: HTMLDivElement | null) => {
    if (viewportRef.current) {
      viewportRef.current.removeEventListener('scroll', handleViewportScroll);
    }
    viewportRef.current = el;
    if (el) {
      el.addEventListener('scroll', handleViewportScroll, { passive: true });
    }
  }, [handleViewportScroll]);

  // 新一轮流式开始时恢复贴底
  useEffect(() => {
    if (isStreaming) {
      isPinnedToBottomRef.current = true;
    }
  }, [isStreaming]);

  // 内容增长时贴底跟随（chunk 已在 hook 层按帧合并，这里直接滚动即可保持平滑）
  useEffect(() => {
    if (!isStreaming || !isPinnedToBottomRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [content, isStreaming]);

  return (
    <div className={`translation-stream-renderer flex flex-col h-full ${className || ''}`}>
      {/* 流式状态提示 */}
      {isStreaming && (
        <div className="flex items-center gap-2 mb-3 px-4 text-sm text-primary">
          <CircleNotch size={16} className="animate-spin motion-reduce:animate-none" />
          <span>{t('translation:progress.translating')}...</span>
        </div>
      )}

      {/* 译文内容 */}
      <CustomScrollArea
        className="translation-content flex-1 min-h-0"
        hideTrackWhenIdle={true}
        trackOffsetTop={4}
        trackOffsetBottom={4}
        trackOffsetRight={2}
        viewportRef={attachViewport}
      >
        {content || isStreaming ? (
          <div className="px-4 pt-6 pb-16 text-base leading-relaxed whitespace-pre-wrap break-words">
            {segments.map((segment, i) =>
              i < segments.length - 1 ? (
                <StaticSegment key={i} text={segment} />
              ) : (
                <span key={i}>{segment}</span>
              )
            )}
            {isStreaming && (
              <span
                aria-hidden="true"
                className="inline-block w-0.5 h-[1.1em] align-[-0.15em] ml-0.5 bg-primary animate-pulse motion-reduce:animate-none"
              />
            )}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground/50 italic select-none px-4 pt-6 pb-16">
            {displayPlaceholder}
          </div>
        )}
      </CustomScrollArea>

      {/* 字符统计 */}
      {showStats && content && (
        <div className="flex items-center gap-4 px-4 pb-2 mt-2 text-xs text-muted-foreground">
          <span>{t('translation:stats.characters')}: {charCount}</span>
          {showWordCount && <span>{t('translation:stats.words')}: {wordCount}</span>}
        </div>
      )}
    </div>
  );
};
