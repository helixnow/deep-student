/**
 * Chat V2 - 引用弹出层组件
 *
 * 点击引用标记时显示的弹出层
 * 支持预览来源内容
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  FileText,
  Globe,
  Brain,
  ImageIcon,
  ExternalLink,
  X,
} from 'lucide-react';
import type { RetrievalSource, RetrievalSourceType } from './types';
import { openUrl } from '@/utils/urlOpener';

// ============================================================================
// Props
// ============================================================================

export interface CitationPopoverProps {
  /** 来源数据 */
  source: RetrievalSource;
  /** 是否显示 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 定位位置 */
  position?: { x: number; y: number };
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 图标映射
// ============================================================================

// ★ 2026-01 清理：移除 graph 图标（错题系统废弃）
const sourceTypeIcons: Record<RetrievalSourceType, typeof FileText> = {
  rag: FileText,
  memory: Brain,
  web_search: Globe,
  multimodal: ImageIcon,
};

// ============================================================================
// 组件
// ============================================================================

/**
 * CitationPopover - 引用弹出层组件
 *
 * 功能：
 * 1. 显示来源详细信息
 * 2. 支持跳转到原文
 * 3. 点击外部关闭
 * 4. 暗色/亮色主题支持
 */
export const CitationPopover: React.FC<CitationPopoverProps> = ({
  source,
  isOpen,
  onClose,
  position,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  const Icon = sourceTypeIcons[source.type] || FileText;
  const hasUrl = !!source.url;

  const handleOpenUrl = useCallback(() => {
    if (hasUrl) {
      openUrl(source.url);
    }
  }, [source.url, hasUrl]);

  // 点击背景关闭
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) {
    return null;
  }

  // 计算弹出位置样式
  const positionStyle: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, 8px)',
      }
    : {};

  return (
    <>
      {/* 透明背景层 */}
      <div
        className="fixed inset-0 z-40"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* 弹出层 */}
      <div
        role="dialog"
        aria-modal="true"
        style={positionStyle}
        className={cn(
          'z-50 w-80 rounded-lg border shadow-lg',
          'bg-popover text-popover-foreground',
          'dark:bg-popover dark:border-border',
          'animate-in fade-in-0 zoom-in-95',
          !position && 'relative',
          className
        )}
      >
        {/* 头部 */}
        <div className="flex items-start gap-2 p-3 border-b border-border/50">
          {/* 类型图标 */}
          <div
            className={cn(
              'flex-shrink-0 flex items-center justify-center',
              'w-8 h-8 rounded bg-muted/50'
            )}
          >
            <Icon className="w-4 h-4 text-muted-foreground" />
          </div>

          {/* 标题 */}
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-sm text-foreground line-clamp-2">
              {source.title}
            </h4>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {t(`blocks.retrieval.sourceTypes.${source.type}`)}
              </span>
              {source.score !== undefined && (
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded text-xs',
                    'bg-primary/10 text-primary'
                  )}
                >
                  {Math.round(source.score * 100)}%
                </span>
              )}
            </div>
          </div>

          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className={cn(
              'flex-shrink-0 p-1 rounded',
              'text-muted-foreground hover:text-foreground',
              'hover:bg-muted/50 transition-colors'
            )}
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-3 max-h-48 overflow-y-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {source.snippet || t('blocks.retrieval.noSnippet')}
          </p>
        </div>

        {/* 底部操作 */}
        {hasUrl && (
          <div className="p-3 border-t border-border/50">
            <button
              onClick={handleOpenUrl}
              className={cn(
                'w-full flex items-center justify-center gap-2',
                'py-2 rounded-lg text-sm',
                'bg-primary text-primary-foreground',
                'hover:bg-primary/90 transition-colors'
              )}
            >
              <ExternalLink className="w-4 h-4" />
              <span>{t('blocks.retrieval.openSource')}</span>
            </button>
          </div>
        )}
      </div>
    </>
  );
};

// ============================================================================
// 引用标记组件（用于内容中的引用标记）
// ============================================================================

export interface CitationBadgeProps {
  /** 引用序号 */
  index: number;
  /** 点击回调 */
  onClick?: (e: React.MouseEvent) => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * CitationBadge - 引用标记组件
 *
 * 用于在正文中显示引用标记 [1]、[2] 等
 */
export const CitationBadge: React.FC<CitationBadgeProps> = ({
  index,
  onClick,
  className,
}) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center',
        'min-w-[1.25rem] h-5 px-1 mx-0.5',
        'text-xs font-medium rounded',
        'bg-primary/10 text-primary',
        'hover:bg-primary/20 transition-colors',
        'cursor-pointer',
        className
      )}
    >
      [{index + 1}]
    </button>
  );
};
