/**
 * ExamPreview - 题目集预览组件
 *
 * 展示题目集识别结果，包含页面缩略图和题目卡片列表
 * 用于学习资源管理器中题目集会话的预览
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '../../ui/shad/Skeleton';
import { NotionButton } from '../../ui/NotionButton';
import { Badge } from '../../ui/shad/Badge';
import { CustomScrollArea } from '../../custom-scroll-area';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '../../../utils/errorUtils';
import {
  AlertCircle,
  FileSpreadsheet,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Tag,
  Hash,
} from 'lucide-react';
import type {
  ExamPreviewProps,
  ExamPreviewData,
  ExamPagePreviewData,
  ExamCardPreviewData,
} from './types';

// ============================================================================
// 骨架屏
// ============================================================================

/**
 * 题目集预览骨架屏
 */
const ExamSkeleton: React.FC = () => (
  <div className="space-y-4 p-4">
    {/* 头部 */}
    <div className="flex items-start gap-3">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
    {/* 页面列表 */}
    {[1, 2].map((i) => (
      <div key={i} className="space-y-2">
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="space-y-1.5 pl-2">
          <Skeleton className="h-8 w-full rounded" />
          <Skeleton className="h-8 w-5/6 rounded" />
        </div>
      </div>
    ))}
  </div>
);

// ============================================================================
// 题目卡片组件
// ============================================================================

interface QuestionCardProps {
  card: ExamCardPreviewData;
  isExpanded: boolean;
  onToggle: () => void;
  onClick?: (card: ExamCardPreviewData) => void;
}

/**
 * 单个题目卡片
 */
const QuestionCard: React.FC<QuestionCardProps> = ({
  card,
  isExpanded,
  onToggle,
  onClick,
}) => {
  const { t } = useTranslation(['notes']);
  
  // 截取 OCR 文本摘要
  const ocrSummary = card.ocrText.length > 80
    ? card.ocrText.slice(0, 80) + '...'
    : card.ocrText;

  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        'border-border bg-card hover:border-primary/30',
        'dark:border-border dark:bg-card dark:hover:border-primary/40'
      )}
    >
      {/* 卡片头部 */}
      <NotionButton variant="ghost" size="sm" onClick={onToggle} className={cn('!w-full !justify-start !px-3 !py-2 !h-auto !text-left', 'hover:bg-muted/50 !rounded-t-lg', !isExpanded && '!rounded-b-lg')}>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Hash className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="font-medium text-sm text-foreground">
          {card.questionLabel || t('notes:previewPanel.exam.unknownQuestion')}
        </span>
        {card.linkedMistakeIds && card.linkedMistakeIds.length > 0 && (
          <Badge variant="secondary" className="ml-auto text-xs">
            {t('notes:previewPanel.exam.linked')}
          </Badge>
        )}
      </NotionButton>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {/* OCR 文本 */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3 w-3" />
              <span>{t('notes:previewPanel.exam.ocrText')}</span>
            </div>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
              {card.ocrText || t('notes:previewPanel.exam.noOcrText')}
            </p>
          </div>

          {/* 标签 */}
          {card.tags && card.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="h-3 w-3 text-muted-foreground" />
              {card.tags.slice(0, 5).map((tag, idx) => (
                <Badge key={idx} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {card.tags.length > 5 && (
                <span className="text-xs text-muted-foreground">
                  +{card.tags.length - 5}
                </span>
              )}
            </div>
          )}

          {/* 裁切图片 */}
          {card.croppedImagePath && (
            <div className="mt-2">
              <img
                src={convertFileSrc(card.croppedImagePath)}
                alt={card.questionLabel}
                className="max-h-32 w-full object-contain rounded border border-border bg-muted/20"
                loading="lazy"
              />
            </div>
          )}

          {/* 操作按钮 */}
          {onClick && (
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => onClick(card)}
              className="w-full mt-2 text-xs"
            >
              {t('notes:previewPanel.exam.viewCardDetail')}
            </NotionButton>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 页面组件
// ============================================================================

interface PageSectionProps {
  page: ExamPagePreviewData;
  expandedCards: Set<string>;
  onToggleCard: (cardId: string) => void;
  onCardClick?: (card: ExamCardPreviewData) => void;
}

/**
 * 单个页面区块
 */
const PageSection: React.FC<PageSectionProps> = ({
  page,
  expandedCards,
  onToggleCard,
  onCardClick,
}) => {
  const { t } = useTranslation(['notes']);
  const [showImage, setShowImage] = useState(false);

  return (
    <div className="space-y-2">
      {/* 页面缩略图 */}
      <div className="relative">
        <NotionButton variant="ghost" size="sm" onClick={() => setShowImage(!showImage)} className={cn('!w-full !p-0 !h-auto overflow-hidden !rounded-lg border border-border', 'bg-muted/30 hover:border-primary/30', 'dark:bg-muted/20 dark:hover:border-primary/40')}>
          {showImage && page.originalImagePath ? (
            <img
              src={convertFileSrc(page.originalImagePath)}
              alt={t('notes:previewPanel.exam.pageImage', { index: page.pageIndex + 1 })}
              className="w-full h-auto max-h-48 object-contain"
              loading="lazy"
            />
          ) : (
            <div className="flex items-center justify-center gap-2 py-4">
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t('notes:previewPanel.exam.pageLabel', { index: page.pageIndex + 1 })}
              </span>
              <Badge variant="secondary" className="text-xs">
                {t('notes:previewPanel.exam.questionCount', { count: page.cards.length })}
              </Badge>
            </div>
          )}
        </NotionButton>
      </div>

      {/* 题目卡片列表 */}
      <div className="space-y-1.5 pl-2">
        {page.cards.map((card) => (
          <QuestionCard
            key={card.cardId}
            card={card}
            isExpanded={expandedCards.has(card.cardId)}
            onToggle={() => onToggleCard(card.cardId)}
            onClick={onCardClick}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// 数据获取
// ============================================================================

/**
 * 检测是否在 Tauri 环境中
 */
function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 从后端获取题目集数据
 */
async function fetchExamData(sessionId: string): Promise<ExamPreviewData> {
  if (!isTauriEnvironment()) {
    // Mock 数据（开发环境）
    return {
      sessionId,
      examName: 'Mock Exam',
      pages: [
        {
          pageIndex: 0,
          originalImagePath: '',
          cards: [
            {
              cardId: 'mock_card_1',
              pageIndex: 0,
              questionLabel: '1',
              ocrText: 'Mock OCR text for question 1',
              tags: ['Mock'],
              linkedMistakeIds: [],
            },
            {
              cardId: 'mock_card_2',
              pageIndex: 0,
              questionLabel: '2',
              ocrText: 'Mock OCR text for question 2',
              tags: [],
              linkedMistakeIds: [],
            },
          ],
        },
      ],
      createdAt: new Date().toISOString(),
    };
  }

  // 调用后端获取题目集数据
  // 后端命令: get_exam_sheet_session_detail (已存在于 commands.rs)
  const response = await invoke<{
    detail: {
      summary: {
        id: string;
        subject: string;
        exam_name?: string;
        created_at: string;
      };
      preview: {
        pages: Array<{
          page_index: number;
          original_image_path: string;
          cards: Array<{
            card_id: string;
            page_index: number;
            question_label: string;
            cropped_image_path?: string;
            ocr_text: string;
            tags: string[];
            linked_mistake_ids?: string[];
          }>;
        }>;
      };
    };
  }>('get_exam_sheet_session_detail', { request: { session_id: sessionId } });

  // 解构返回的 detail 字段
  const result = response.detail;

  // 转换为前端数据格式
  return {
    sessionId: result.summary.id,
    examName: result.summary.exam_name,
    createdAt: result.summary.created_at,
    pages: result.preview.pages.map((page) => ({
      pageIndex: page.page_index,
      originalImagePath: page.original_image_path,
      cards: page.cards.map((card) => ({
        cardId: card.card_id,
        pageIndex: card.page_index,
        questionLabel: card.question_label,
        croppedImagePath: card.cropped_image_path,
        ocrText: card.ocr_text,
        tags: card.tags,
        linkedMistakeIds: card.linked_mistake_ids,
      })),
    })),
  };
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * 题目集预览组件
 */
export const ExamPreview: React.FC<ExamPreviewProps> = ({
  sessionId,
  examData: initialExamData,
  onCardClick,
  onViewDetail,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes']);

  // 状态
  const [examData, setExamData] = useState<ExamPreviewData | null>(initialExamData || null);
  const [isLoading, setIsLoading] = useState(!initialExamData);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  // 加载数据
  useEffect(() => {
    if (initialExamData) {
      setExamData(initialExamData);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      setIsLoading(true);
      setLoadError(null);

      try {
        const data = await fetchExamData(sessionId);
        if (!cancelled) {
          setExamData(data);
        }
      } catch (err: unknown) {
        console.error('[ExamPreview] Failed to load exam data:', err);
        if (!cancelled) {
          setLoadError(getErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, [sessionId, initialExamData]);

  // 切换卡片展开状态
  const handleToggleCard = useCallback((cardId: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  // 统计题目总数
  const totalQuestions = examData?.pages.reduce((sum, page) => sum + page.cards.length, 0) ?? 0;

  // 加载状态
  if (loading || isLoading) {
    return (
      <div className={cn('h-full', className)}>
        <ExamSkeleton />
      </div>
    );
  }

  // 错误状态
  if (error || loadError) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{error || loadError}</p>
      </div>
    );
  }

  // 无数据
  if (!examData) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <FileSpreadsheet className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t('notes:previewPanel.exam.noData')}
        </p>
      </div>
    );
  }

  return (
    <CustomScrollArea className={cn('h-full', className)}>
      <div className="space-y-4 p-4">
        {/* 头部信息 */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-50 dark:bg-green-950/30">
            <FileSpreadsheet className="h-5 w-5 text-green-500 dark:text-green-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-foreground line-clamp-2">
              {examData.examName || t('notes:previewPanel.exam.untitled')}
            </h3>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {t('notes:previewPanel.exam.pageCount', { count: examData.pages.length })}
              </span>
              <span>·</span>
              <span>
                {t('notes:previewPanel.exam.totalQuestions', { count: totalQuestions })}
              </span>
            </div>
          </div>
        </div>

        {/* 页面列表 */}
        <div className="space-y-4">
          {examData.pages.map((page) => (
            <PageSection
              key={page.pageIndex}
              page={page}
              expandedCards={expandedCards}
              onToggleCard={handleToggleCard}
              onCardClick={onCardClick}
            />
          ))}
        </div>

        {/* 查看详情按钮 */}
        {onViewDetail && (
          <NotionButton
            variant="default"
            size="sm"
            onClick={() => onViewDetail(sessionId)}
            className="w-full gap-2"
          >
            <ExternalLink className="h-4 w-4" />
            {t('notes:previewPanel.exam.viewDetail')}
          </NotionButton>
        )}
      </div>
    </CustomScrollArea>
  );
};

export default ExamPreview;
