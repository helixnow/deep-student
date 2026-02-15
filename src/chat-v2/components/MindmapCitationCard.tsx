/**
 * Chat V2 - 思维导图引用卡片组件
 *
 * 在消息正文中渲染思维导图引用的预览卡片
 * 支持：
 * - 内联完整 ReactFlow 预览（MindMapEmbed）
 * - 点击跳转到学习资源管理器
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Network } from 'lucide-react';
import { MindMapEmbed } from '@/components/mindmap/components/mindmap/MindMapEmbed';

// ============================================================================
// 类型定义
// ============================================================================

export interface MindmapCitationCardProps {
  /** 思维导图 ID（当前版本引用） */
  mindmapId?: string;
  /** 思维导图版本 ID（历史版本引用） */
  versionId?: string;
  /** 可选的显示标题（覆盖从 API 获取的标题） */
  displayTitle?: string;
  /** 自定义类名 */
  className?: string;
  /** 嵌入式预览高度（默认 280px） */
  embedHeight?: number;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * MindmapCitationCard - 思维导图引用卡片
 *
 * 功能：
 * 1. 使用 MindMapEmbed 渲染完整的 ReactFlow 预览
 * 2. 支持缩放、平移交互
 * 3. 点击打开按钮跳转到学习资源管理器
 */
export const MindmapCitationCard: React.FC<MindmapCitationCardProps> = ({
  mindmapId,
  versionId,
  displayTitle,
  className,
  embedHeight = 280,
}) => {
  return (
    <div className={cn('my-3 w-full max-w-[600px]', className)}>
      <MindMapEmbed
        mindmapId={mindmapId}
        versionId={versionId}
        height={embedHeight}
        // ★ 2026-02-13 修复：版本引用也显示打开按钮
        // MindMapEmbed 内部会自动从版本元数据获取父导图 ID 进行导航
        showOpenButton
        displayTitle={displayTitle}
      />
    </div>
  );
};

// ============================================================================
// 内联简化版本（用于段落内嵌入）
// ============================================================================

export interface MindmapCitationBadgeProps {
  /** 思维导图 ID */
  mindmapId: string;
  /** 显示标题 */
  title?: string;
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * MindmapCitationBadge - 思维导图引用徽章（简化版）
 *
 * 更紧凑的内联显示，适合在段落中使用
 */
export const MindmapCitationBadge: React.FC<MindmapCitationBadgeProps> = ({
  mindmapId,
  title,
  onClick,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (onClick) {
      onClick();
      return;
    }

    // 在右侧面板打开预览
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: {
        id: mindmapId,
        type: 'mindmap',
        title: title || '思维导图',
      },
    }));
  }, [mindmapId, title, onClick]);

  return (
    <NotionButton
      variant="ghost"
      size="sm"
      onClick={handleClick}
      className={cn(
        '!inline-flex !h-auto !px-1.5 !py-0.5 mx-0.5',
        'bg-violet-500/10 hover:bg-violet-500/20',
        'text-violet-600 dark:text-violet-400',
        'text-sm font-medium',
        'border border-violet-500/20 hover:border-violet-500/40',
        className
      )}
      title={t('mindmapCitation.mindmapTitle', { title: title || mindmapId })}
    >
      <Network className="w-3 h-3" />
      <span className="truncate max-w-[120px]">{title || t('mindmapCitation.mindmap')}</span>
    </NotionButton>
  );
};

export default MindmapCitationCard;
