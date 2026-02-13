/**
 * Chat V2 - 页面导航组件
 *
 * 教材导学模式的页面导航器
 * 支持页面切换、缩略图预览和页码跳转
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  BookOpen,
  Loader2,
  AlertCircle,
  RefreshCw,
  Image,
} from 'lucide-react';
import type { ChatStore } from '../../../core/types';
import type { TextbookModeState, TextbookPage } from '../textbook';
import {
  setCurrentPage,
  goToPreviousPage,
  goToNextPage,
  reloadTextbook,
} from '../textbook';

// ============================================================================
// 类型定义
// ============================================================================

export interface PageNavigatorProps {
  /** Store 实例（用于读取 modeState） */
  store: StoreApi<ChatStore>;
}

// ============================================================================
// 页面导航组件
// ============================================================================

/**
 * PageNavigator - 教材页面导航器
 *
 * 功能：
 * 1. 显示当前页码 / 总页数
 * 2. 上一页 / 下一页按钮
 * 3. 首页 / 末页快捷跳转
 * 4. 页码输入跳转
 * 5. 当前页缩略图预览
 * 6. 加载状态 / 错误状态显示
 * 7. 支持暗色/亮色主题
 */
export const PageNavigator: React.FC<PageNavigatorProps> = ({ store }) => {
  const { t } = useTranslation('chatV2');
  const [isThumbExpanded, setIsThumbExpanded] = useState(false);
  const [inputPage, setInputPage] = useState('');

  // 使用 useStore 订阅状态
  const mode = useStore(store, (s) => s.mode);
  const modeState = useStore(store, (s) => s.modeState as unknown as TextbookModeState | null);

  // 如果不是 textbook 模式或没有 modeState，不渲染
  if (!modeState || mode !== 'textbook') {
    return null;
  }

  const {
    loadingStatus,
    loadingError,
    currentPage,
    totalPages,
    pages,
  } = modeState;

  // 获取当前页数据
  const currentPageData = useMemo(
    () => pages.find((p) => p.pageNum === currentPage),
    [pages, currentPage]
  );

  // 处理页码输入
  const handlePageInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputPage(e.target.value);
    },
    []
  );

  // 处理页码跳转
  const handlePageJump = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const pageNum = parseInt(inputPage, 10);
        if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
          setCurrentPage(store.getState(), pageNum);
          setInputPage('');
        }
      }
    },
    [inputPage, totalPages, store]
  );

  // 处理重试
  const handleRetry = useCallback(() => {
    reloadTextbook(store.getState()).catch(console.error);
  }, [store]);

  // 加载中状态
  if (loadingStatus === 'loading') {
    return (
      <div
        className={cn(
          'rounded-lg border p-3',
          'bg-muted/30 border-border/50',
          'dark:bg-muted/20 dark:border-border/30',
          'flex items-center gap-3'
        )}
      >
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">
          {t('textbook.loading')}
        </span>
      </div>
    );
  }

  // 错误状态
  if (loadingStatus === 'error') {
    return (
      <div
        className={cn(
          'rounded-lg border p-3',
          'bg-destructive/5 border-destructive/30',
          'dark:bg-destructive/10 dark:border-destructive/20',
          'flex items-center justify-between'
        )}
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-destructive" />
          <span className="text-sm text-destructive">
            {loadingError || t('textbook.loadError')}
          </span>
        </div>
        <button
          onClick={handleRetry}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded',
            'text-xs text-primary hover:bg-primary/10',
            'transition-colors'
          )}
        >
          <RefreshCw className="w-3 h-3" />
          {t('textbook.retry')}
        </button>
      </div>
    );
  }

  // 没有页面
  if (totalPages === 0) {
    return (
      <div
        className={cn(
          'rounded-lg border p-3',
          'bg-muted/30 border-border/50',
          'dark:bg-muted/20 dark:border-border/30',
          'flex items-center gap-2 text-muted-foreground'
        )}
      >
        <BookOpen className="w-5 h-5" />
        <span className="text-sm">{t('textbook.noPages')}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-card border-border/50',
        'dark:bg-card dark:border-border/30',
        'transition-colors'
      )}
    >
      {/* 主导航栏 */}
      <div className="flex items-center justify-between px-3 py-2">
        {/* 左侧：标题和图标 */}
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            {t('textbook.title')}
          </span>
        </div>

        {/* 中间：分页控制 */}
        <div className="flex items-center gap-1">
          {/* 首页按钮 */}
          <NavigationButton
            onClick={() => setCurrentPage(store.getState(), 1)}
            disabled={currentPage <= 1}
            title={t('textbook.firstPage')}
          >
            <ChevronsLeft className="w-4 h-4" />
          </NavigationButton>

          {/* 上一页按钮 */}
          <NavigationButton
            onClick={() => goToPreviousPage(store.getState())}
            disabled={currentPage <= 1}
            title={t('textbook.prevPage')}
          >
            <ChevronLeft className="w-4 h-4" />
          </NavigationButton>

          {/* 页码显示/输入 */}
          <div className="flex items-center gap-1 px-2">
            <input
              type="text"
              value={inputPage}
              onChange={handlePageInput}
              onKeyDown={handlePageJump}
              placeholder={String(currentPage)}
              className={cn(
                'w-10 h-6 text-center text-sm rounded',
                'bg-muted/50 border border-border/50',
                'focus:outline-none focus:ring-1 focus:ring-primary',
                'placeholder:text-foreground'
              )}
            />
            <span className="text-sm text-muted-foreground">/</span>
            <span className="text-sm text-foreground">{totalPages}</span>
          </div>

          {/* 下一页按钮 */}
          <NavigationButton
            onClick={() => goToNextPage(store.getState())}
            disabled={currentPage >= totalPages}
            title={t('textbook.nextPage')}
          >
            <ChevronRight className="w-4 h-4" />
          </NavigationButton>

          {/* 末页按钮 */}
          <NavigationButton
            onClick={() => setCurrentPage(store.getState(), totalPages)}
            disabled={currentPage >= totalPages}
            title={t('textbook.lastPage')}
          >
            <ChevronsRight className="w-4 h-4" />
          </NavigationButton>
        </div>

        {/* 右侧：缩略图切换 */}
        <button
          onClick={() => setIsThumbExpanded((prev) => !prev)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded',
            'text-xs text-muted-foreground hover:text-foreground',
            'hover:bg-muted/50 transition-colors',
            isThumbExpanded && 'bg-muted/50 text-foreground'
          )}
        >
          <Image className="w-3 h-3" />
          {t('textbook.preview')}
        </button>
      </div>

      {/* 缩略图预览区域 */}
      {isThumbExpanded && currentPageData && (
        <div className="border-t border-border/30 p-3">
          <div
            className={cn(
              'relative rounded-lg overflow-hidden',
              'bg-muted/30',
              'max-h-48'
            )}
          >
            <img
              src={currentPageData.thumbnail || currentPageData.imageUrl}
              alt={t('textbook.pageAlt', { page: currentPage })}
              className="w-full h-auto object-contain"
            />
            {/* 页码标签 */}
            <div
              className={cn(
                'absolute bottom-2 right-2 px-2 py-0.5 rounded',
                'bg-black/60 text-white text-xs'
              )}
            >
              {t('textbook.pageLabel', { page: currentPage })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 导航按钮子组件
// ============================================================================

interface NavigationButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}

const NavigationButton: React.FC<NavigationButtonProps> = ({
  onClick,
  disabled,
  title,
  children,
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center justify-center w-7 h-7 rounded',
        'transition-colors',
        disabled
          ? 'text-muted-foreground/50 cursor-not-allowed'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
      )}
    >
      {children}
    </button>
  );
};
