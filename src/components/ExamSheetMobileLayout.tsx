/**
 * ExamSheetMobileLayout - 题目集识别移动端专用布局
 *
 * 参考拍题软件UI设计，采用分层架构：
 * - 底层：试卷图片 + 识别框
 * - 上层：可拖拽的 Bottom Sheet 结果浮层
 *
 * 特性：
 * - 可上下拖拽调整浮层高度
 * - 水平数字按钮切换题目
 * - 紧凑的移动端友好布局
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { cn } from '../lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from './ui/shad/Badge';
import {
  ChevronLeft,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
  MoreHorizontal,
  Sparkles,
  Bookmark,
  RefreshCw,
  Camera,
  Send,
  ArrowLeft,
  FileText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ExamPageImage } from './ExamPageImage';

// ============================================================================
// 类型定义
// ============================================================================

export interface MobileExamCard {
  id: string;
  pageIndex: number;
  questionLabel: string;
  ocrText: string;
  bbox: { x: number; y: number; width: number; height: number };
  tags?: string[];
  linkedMistakeIds?: string[];
}

export interface MobileExamPage {
  pageIndex: number;
  /** @deprecated 使用 blobHash 或 originalImagePath */
  imageSrc?: string;
  /** VFS Blob 哈希（新模式） */
  blobHash?: string | null;
  /** 原始图片路径（旧模式） */
  originalImagePath?: string | null;
  /** 图片自然尺寸 */
  naturalSize?: { width: number; height: number };
  cards: MobileExamCard[];
}

export interface ExamSheetMobileLayoutProps {
  /** 页面数据 */
  pages: MobileExamPage[];
  /** 当前页码 */
  currentPageIndex: number;
  /** 页码变更 */
  onPageChange: (index: number) => void;
  /** 当前选中的题目ID */
  selectedCardId: string | null;
  /** 题目选择变更 */
  onCardSelect: (cardId: string | null) => void;
  /** 返回按钮点击 */
  onBack?: () => void;
  /** 分析按钮点击 */
  onAnalyze?: (cardId: string) => void;
  /** 收藏按钮点击 */
  onBookmark?: (cardId: string) => void;
  /** 再拍一页按钮点击 */
  onRetakePage?: () => void;
  /** 显示/隐藏识别框 */
  showBboxes?: boolean;
  onToggleBboxes?: () => void;
  /** 缩放级别 */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** 自定义顶部右侧操作 */
  headerRightActions?: ReactNode;
  /** 自定义底部操作栏 */
  bottomActions?: ReactNode;
  /** 图片路径解析函数（旧模式） */
  resolveImageSrc?: (path: string) => string;
  /** 加载状态 */
  loading?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 文件输入框引用（用于再拍一页） */
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
  /** 文件选择回调 */
  onFileChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** 是否正在上传 */
  isUploading?: boolean;
  /** 会话标题 */
  sessionTitle?: string;
  /** 总页数 */
  totalPages?: number;
}

// ============================================================================
// 浮层高度配置
// ============================================================================

const SHEET_HEIGHTS = {
  collapsed: 180,  // 收起状态：只显示题目选择器和标题
  half: 420,       // 半展开：显示题目内容（增加20px以容纳题目选择器）
  expanded: '85vh', // 完全展开
};

// ============================================================================
// 子组件：题目选择器
// ============================================================================

interface CardSelectorProps {
  cards: MobileExamCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
}

const CardSelector: React.FC<CardSelectorProps> = ({
  cards,
  selectedCardId,
  onSelect,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到选中项
  useEffect(() => {
    if (!selectedCardId || !scrollRef.current) return;
    const selectedIndex = cards.findIndex(c => c.id === selectedCardId);
    if (selectedIndex >= 0) {
      const button = scrollRef.current.children[selectedIndex] as HTMLElement;
      button?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [selectedCardId, cards]);

  return (
    <div
      ref={scrollRef}
      className="flex items-center gap-2 overflow-x-auto py-2 px-1 scrollbar-hide"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {cards.map((card, index) => {
        const isSelected = card.id === selectedCardId;
        return (
          <NotionButton
            key={card.id}
            variant="ghost" size="icon" iconOnly
            onClick={() => onSelect(card.id)}
            className={cn(
              '!w-10 !h-10 !rounded-full text-sm font-semibold shrink-0',
              'border-2',
              isSelected
                ? 'bg-primary text-primary-foreground border-primary scale-110 shadow-lg'
                : 'bg-card text-foreground border-border hover:border-primary/50 hover:bg-accent'
            )}
          >
            {index + 1}
          </NotionButton>
        );
      })}
    </div>
  );
};

// ============================================================================
// 子组件：题目详情内容
// ============================================================================

interface CardDetailProps {
  card: MobileExamCard | null;
  onBookmark?: (cardId: string) => void;
}

const CardDetail: React.FC<CardDetailProps> = ({ card, onBookmark }) => {
  const { t } = useTranslation(['exam_sheet', 'common']);

  if (!card) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        {t('exam_sheet:select_card_hint')}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 space-y-3">
      {/* 题目标题行 */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-foreground">
          {t('exam_sheet:question_title')}
        </h3>
        {onBookmark && (
          <NotionButton
            variant="outline"
            size="sm"
            onClick={() => onBookmark(card.id)}
            className="shrink-0"
          >
            <Bookmark className="w-4 h-4 mr-1.5" />
            {t('exam_sheet:bookmark')}
          </NotionButton>
        )}
      </div>

      {/* 题目内容 */}
      <div className="text-base text-foreground leading-relaxed whitespace-pre-wrap">
        {card.ocrText || t('exam_sheet:no_ocr_text')}
      </div>

      {/* 标签 */}
      {card.tags && card.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {card.tags.map((tag, idx) => (
            <Badge key={idx} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ExamSheetMobileLayout: React.FC<ExamSheetMobileLayoutProps> = ({
  pages,
  currentPageIndex,
  onPageChange,
  selectedCardId,
  onCardSelect,
  onBack,
  onAnalyze,
  onBookmark,
  onRetakePage,
  showBboxes = true,
  onToggleBboxes,
  zoom = 1,
  onZoomChange,
  headerRightActions,
  bottomActions,
  resolveImageSrc,
  loading = false,
  className,
  fileInputRef,
  onFileChange,
  isUploading = false,
  sessionTitle,
  totalPages = 0,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);
  const [sheetHeight, setSheetHeight] = useState<number | string>(SHEET_HEIGHTS.half);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 当前页面数据
  const currentPage = useMemo(() => {
    return pages.find(p => p.pageIndex === currentPageIndex) || pages[0];
  }, [pages, currentPageIndex]);

  // 当前页面的所有题目
  const currentCards = useMemo(() => {
    return currentPage?.cards || [];
  }, [currentPage]);

  // 选中的题目
  const selectedCard = useMemo(() => {
    if (!selectedCardId) return currentCards[0] || null;
    return currentCards.find(c => c.id === selectedCardId) || null;
  }, [currentCards, selectedCardId]);

  // 自动选中第一个题目
  useEffect(() => {
    if (!selectedCardId && currentCards.length > 0) {
      onCardSelect(currentCards[0].id);
    }
  }, [currentCards, selectedCardId, onCardSelect]);

  // 拖拽处理
  const handleDragStart = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    setIsDragging(true);
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragStartY.current = clientY;
    dragStartHeight.current = typeof sheetHeight === 'number'
      ? sheetHeight
      : window.innerHeight * 0.85;
  }, [sheetHeight]);

  const handleDragMove = useCallback((e: TouchEvent | MouseEvent) => {
    if (!isDragging) return;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaY = dragStartY.current - clientY;
    const newHeight = Math.max(
      SHEET_HEIGHTS.collapsed,
      Math.min(window.innerHeight * 0.9, dragStartHeight.current + deltaY)
    );
    setSheetHeight(newHeight);
  }, [isDragging]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);

    // 吸附到最近的高度档位
    const currentHeight = typeof sheetHeight === 'number' ? sheetHeight : window.innerHeight * 0.85;
    const thresholds = [
      { value: SHEET_HEIGHTS.collapsed, threshold: 250 },
      { value: SHEET_HEIGHTS.half, threshold: 500 },
      { value: window.innerHeight * 0.85, threshold: Infinity },
    ];

    for (const { value, threshold } of thresholds) {
      if (currentHeight < threshold) {
        setSheetHeight(value);
        break;
      }
    }
  }, [isDragging, sheetHeight]);

  // 添加全局拖拽事件监听
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('touchmove', handleDragMove, { passive: true });
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('touchend', handleDragEnd);
      window.addEventListener('mouseup', handleDragEnd);
    }
    return () => {
      window.removeEventListener('touchmove', handleDragMove);
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('touchend', handleDragEnd);
      window.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  // 计算浮层是否完全展开
  const isExpanded = typeof sheetHeight === 'number' && sheetHeight > 500;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-full w-full flex flex-col bg-black overflow-hidden',
        className
      )}
    >
      {/* ========== 顶部导航栏 ========== */}
      <div className="absolute top-0 left-0 right-0 z-40 safe-area-top">
        <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/70 to-transparent">
          {/* 返回按钮 */}
          {onBack && (
            <NotionButton
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="w-10 h-10 rounded-full text-white hover:bg-white/20"
            >
              <ArrowLeft className="w-5 h-5" />
            </NotionButton>
          )}
          
          {/* 标题区域 */}
          <div className="flex-1 text-center">
            <h1 className="text-white font-medium text-base truncate px-2">
              {sessionTitle || t('exam_sheet:title')}
            </h1>
            {totalPages > 0 && (
              <p className="text-white/70 text-xs">
                {t('exam_sheet:page_info', { 
                  current: currentPageIndex + 1,
                  total: totalPages
                })}
              </p>
            )}
          </div>
          
          {/* 右侧操作区域 */}
          <div className="w-10">
            {headerRightActions}
          </div>
        </div>
      </div>

      {/* ========== 试卷图片层（底层） ========== */}
      <div
        className="flex-1 relative overflow-hidden"
        style={{
          // 为底部浮层预留空间（不需要额外预留题目选择器）
          paddingBottom: typeof sheetHeight === 'number' ? sheetHeight + 20 : 'calc(85vh + 20px)',
        }}
      >
        {currentPage && (
          <div
            className="absolute inset-0 overflow-auto pt-2 px-2 pb-2"
          >
            {/* 试卷图片容器 - 从顶部开始显示，充分利用空间 */}
            <div
              className="relative w-full"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'top center',
              }}
            >
              <ExamPageImage
                blobHash={currentPage.blobHash}
                originalImagePath={currentPage.originalImagePath}
                resolveImageSrc={resolveImageSrc}
                alt={`Page ${currentPage.pageIndex + 1}`}
                className="w-full h-auto object-contain !rounded-lg !shadow-none"
              />

              {/* 识别框叠加层 */}
              {showBboxes && (
                <div className="absolute inset-0 pointer-events-none">
                  {currentCards.map((card, index) => {
                    const isSelected = card.id === selectedCardId;
                    return (
                      <div
                        key={card.id}
                        className={cn(
                          'absolute border-2 rounded transition-all cursor-pointer pointer-events-auto',
                          isSelected
                            ? 'border-primary bg-primary/10 shadow-lg'
                            : 'border-white/70 bg-white/5 hover:border-primary/70'
                        )}
                        style={{
                          left: `${card.bbox.x}%`,
                          top: `${card.bbox.y}%`,
                          width: `${card.bbox.width}%`,
                          height: `${card.bbox.height}%`,
                        }}
                        onClick={() => onCardSelect(card.id)}
                      >
                        {/* 题目编号 */}
                        <span
                          className={cn(
                            'absolute -top-3 -right-3 flex items-center justify-center',
                            'w-6 h-6 rounded-full text-xs font-bold shadow',
                            isSelected
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-white text-gray-800'
                          )}
                        >
                          {index + 1}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 缩放控制悬浮按钮 */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-10">
          {onToggleBboxes && (
            <NotionButton
              variant="secondary"
              size="icon"
              onClick={onToggleBboxes}
              className="w-10 h-10 rounded-full shadow-lg bg-card/90 backdrop-blur"
            >
              {showBboxes ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </NotionButton>
          )}
          {onZoomChange && (
            <>
              <NotionButton
                variant="secondary"
                size="icon"
                onClick={() => onZoomChange(Math.min(3, zoom + 0.2))}
                className="w-10 h-10 rounded-full shadow-lg bg-card/90 backdrop-blur"
              >
                <ZoomIn className="w-5 h-5" />
              </NotionButton>
              <NotionButton
                variant="secondary"
                size="icon"
                onClick={() => onZoomChange(Math.max(0.5, zoom - 0.2))}
                className="w-10 h-10 rounded-full shadow-lg bg-card/90 backdrop-blur"
              >
                <ZoomOut className="w-5 h-5" />
              </NotionButton>
              <NotionButton
                variant="secondary"
                size="icon"
                onClick={() => onZoomChange(1)}
                className="w-10 h-10 rounded-full shadow-lg bg-card/90 backdrop-blur"
              >
                <RefreshCw className="w-4 h-4" />
              </NotionButton>
            </>
          )}
        </div>
      </div>

      {/* ========== 底部结果浮层（上层） ========== */}
      <motion.div
        className={cn(
          'absolute bottom-0 left-0 right-0 z-30',
          'bg-card rounded-t-3xl shadow-lg ring-1 ring-border/40 border-transparent',
          'flex flex-col overflow-hidden',
          isDragging && 'select-none'
        )}
        style={{
          height: sheetHeight,
        }}
        animate={{
          height: sheetHeight,
        }}
        transition={{
          type: 'spring',
          damping: 30,
          stiffness: 300,
        }}
      >
        {/* 拖拽手柄 */}
        <div
          className="flex items-center justify-center py-2 cursor-grab active:cursor-grabbing shrink-0"
          onTouchStart={handleDragStart}
          onMouseDown={handleDragStart}
        >
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

        {/* 题目选择器 */}
        <div className="px-3 shrink-0">
          <CardSelector
            cards={currentCards}
            selectedCardId={selectedCardId}
            onSelect={onCardSelect}
          />
        </div>

        {/* 题目详情（可滚动） */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <CardDetail card={selectedCard} onBookmark={onBookmark} />

          {/* 同类题讲解区域 */}
          {isExpanded && selectedCard && (
            <div className="px-3 py-2 border-t border-border/50">
              <h4 className="text-base font-semibold text-foreground mb-2">
                {t('exam_sheet:similar_questions')}
              </h4>
              <div className="text-sm text-muted-foreground">
                {t('exam_sheet:similar_questions_hint')}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="shrink-0 px-3 py-2 border-t border-border/50 bg-card safe-area-bottom">
          {bottomActions || (
            <div className="flex items-center gap-2">
              {/* 再拍一页按钮 */}
              <NotionButton 
                variant="outline" 
                size="sm"
                onClick={onRetakePage}
                disabled={isUploading}
                className="shrink-0 rounded-full gap-1.5"
              >
                <Camera className="w-4 h-4" />
                {isUploading 
                  ? t('exam_sheet:uploading')
                  : t('exam_sheet:retake_page')
                }
              </NotionButton>
              
              {/* AI 分析按钮 */}
              {selectedCard && onAnalyze && (
                <NotionButton 
                  variant="default" 
                  size="sm"
                  onClick={() => onAnalyze(selectedCard.id)}
                  className="flex-1 rounded-full gap-1.5"
                >
                  <Sparkles className="w-4 h-4" />
                  {t('exam_sheet:ai_analyze')}
                </NotionButton>
              )}
            </div>
          )}
        </div>
        
        {/* 隐藏的文件输入框 */}
        {fileInputRef && onFileChange && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            onChange={onFileChange}
            className="hidden"
          />
        )}
      </motion.div>

      {/* 加载遮罩 */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
          >
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ExamSheetMobileLayout;
