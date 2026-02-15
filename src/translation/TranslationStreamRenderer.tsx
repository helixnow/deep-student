/**
 * 翻译流式渲染容器
 * 
 * 职责：
 * - 封装流式译文的渲染逻辑
 * - 复用 StreamingMarkdownRenderer 组件
 * - 提供翻译专用的 UI 增强（进度提示、字符统计等）
 * 
 * 与聊天模块的关系：
 * - 复用 StreamingMarkdownRenderer 组件（底层渲染器）
 * - 独立的容器逻辑，不依赖聊天消息结构
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '../components/custom-scroll-area';
import { Loader2 } from 'lucide-react';

interface TranslationStreamRendererProps {
  content: string;
  isStreaming: boolean;
  placeholder?: string;
  showStats?: boolean;
  charCount?: number;
  wordCount?: number;
}

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

  return (
    <div className={`translation-stream-renderer flex flex-col h-full ${className || ''}`}>
      {/* 流式状态提示 */}
      {isStreaming && (
        <div className="flex items-center gap-2 mb-3 px-4 text-sm text-primary animate-pulse">
          <Loader2 className="h-4 w-4 animate-spin" />
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
      >
        {content ? (
          <div className="px-4 pt-6 pb-16 font-mono text-base leading-relaxed whitespace-pre-wrap break-words">
            {content}
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
          <span>{t('translation:stats.words')}: {wordCount}</span>
        </div>
      )}
    </div>
  );
};
