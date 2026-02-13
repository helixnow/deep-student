import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage } from '../types';
import { getUnifiedSummaryPrompt } from '../utils/summaryPrompt';
import { StreamingMarkdownRenderer } from '../chat-v2/components/renderers';
import './SummaryBox.css';
import ChatCollapsible from './shared/ChatCollapsible';
import { Badge } from './ui/shad/Badge';
import { NotionButton } from '@/components/ui/NotionButton';

interface SummaryBoxProps {
  chatHistory: ChatMessage[];
  isVisible: boolean;
  onClose?: () => void;
  mistakeId?: string; // 用于错题库详情
  reviewSessionId?: string; // 用于批量分析详情
  // 新增：与AI调用一致的接口
  onGenerateSummary?: (summaryPrompt: string) => void;
  currentStreamId?: string;
  isGenerating?: boolean;
  // 新增：从父组件传递的流式内容
  summaryStreamContent?: string;
  summaryStreamComplete?: boolean;
}

export const SummaryBox: React.FC<SummaryBoxProps> = ({
  chatHistory,
  isVisible,
  onClose,
  mistakeId: _mistakeId,
  reviewSessionId: _reviewSessionId,
  onGenerateSummary,
  isGenerating = false,
  summaryStreamContent = '',
  summaryStreamComplete = false
}) => {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(true);
  const [summaryRequested, setSummaryRequested] = useState(false);
  const [summaryContent, setSummaryContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const summaryContentRef = useRef<HTMLDivElement>(null);

  // 监听流式内容更新
  useEffect(() => {
    if (summaryStreamContent !== undefined) {
      setSummaryContent(summaryStreamContent);
      setIsStreaming(!summaryStreamComplete);
      if (summaryStreamContent && !summaryRequested) {
        setSummaryRequested(true);
      }
    }
  }, [summaryStreamContent, summaryStreamComplete, summaryRequested]);

  // 🎯 新增：当父组件传入的总结内容发生变化时，重置内部状态 - 配合保活机制
  useEffect(() => {
    // 当切换到不同错题时，重置总结请求状态
    // 这确保了在保活模式下，SummaryBox能正确响应新错题的总结状态
    if (summaryStreamContent === '' && summaryRequested) {
      console.log('🔄 [SummaryBox] 检测到新错题无总结内容，重置请求状态');
      setSummaryRequested(false);
    }
  }, [summaryStreamContent, summaryStreamComplete]);

  // 监听生成状态
  useEffect(() => {
    if (isGenerating) {
      setIsStreaming(true);
    } else if (summaryStreamComplete) {
      setIsStreaming(false);
    }
  }, [isGenerating, summaryStreamComplete]);

  // 如果不可见就不渲染
  if (!isVisible) return null;

  const generateSummary = () => {
    if (chatHistory.length === 0) {
      return;
    }

    if (!onGenerateSummary) {
      console.warn('⚠️ onGenerateSummary回调未提供');
      return;
    }

    // 统一提示词（不内联对话记录；对话历史由API另行提供）
    const summaryPrompt = getUnifiedSummaryPrompt();

    console.log('📝 准备通过回调生成总结，提示词长度:', summaryPrompt.length);
    setSummaryRequested(true);
    onGenerateSummary(summaryPrompt);
  };

  return (
    <ChatCollapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      title={<span className="summary-title">{t('summaryBox.title')}</span>}
      countBadge={summaryContent ? (
        <Badge
          variant="outline"
          className="summary-badge text-[10px] px-2 py-[2px] rounded-full"
        >
          {t('summaryBox.generated')}
        </Badge>
      ) : undefined}
      headerRight={(
        <div className="summary-actions">
          {!isGenerating && (
            <NotionButton
              variant="ghost"
              size="sm"
              className="sb-btn sb-btn-ghost"
              onClick={(e) => { e.stopPropagation(); generateSummary(); }}
              title={t('summaryBox.generateSummary')}
            >
              {summaryRequested ? t('summaryBox.regenerate') : t('summaryBox.generateSummary')}
            </NotionButton>
          )}
          {onClose && (
            <NotionButton
              variant="ghost"
              size="sm"
              className="sb-btn sb-btn-icon"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              title={t('summaryBox.closeSummary')}
              aria-label={t('summaryBox.closeSummary')}
            >
              ✕
            </NotionButton>
          )}
        </div>
      )}
      containerClassName={`summary-box ${isExpanded ? 'expanded' : ''}`}
      forceMount
    >
      {isExpanded && (
        <div className="summary-content" ref={summaryContentRef}>
          {isGenerating && (
            <div className="loading-row">
              <div className="loading-spinner" />
              {t('summaryBox.generating')}
            </div>
          )}

          {summaryContent ? (
            <div className="summary-text">
              <StreamingMarkdownRenderer content={summaryContent} isStreaming={isStreaming} />
            </div>
          ) : !isGenerating ? (
            <div className="summary-empty">
              {t('summaryBox.emptyHint')}
            </div>
          ) : (
            <div className="sb-skeleton" aria-hidden>
              <div className="skeleton-line" style={{ width: '78%' }} />
              <div className="skeleton-line" style={{ width: '92%' }} />
              <div className="skeleton-line" style={{ width: '64%' }} />
            </div>
          )}
        </div>
      )}
    </ChatCollapsible>
  );
};
