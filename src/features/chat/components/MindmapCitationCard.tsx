/**
 * Chat V2 - 思维导图引用卡片组件
 *
 * 在消息正文中渲染思维导图引用的预览卡片
 * 支持：
 * - 内联完整 ReactFlow 预览（MindMapEmbed）
 * - 在会话右侧打开完整导图
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { TreeStructure } from '@phosphor-icons/react';
import { MindMapEmbed } from '@/features/mindmap/components/mindmap/MindMapEmbed';
import { publishMindmapNodeTarget } from '@/features/mindmap/nodeTargetBridge';

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
  /** 节点定位提示（[思维导图:mm_xxx#节点:标题] 的 `#` 段：节点 ID 或文字） */
  nodeHint?: string;
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
 * 3. 点击打开按钮在会话右侧展开完整导图
 */
export const MindmapCitationCard: React.FC<MindmapCitationCardProps> = ({
  mindmapId,
  versionId,
  displayTitle,
  className,
  embedHeight = 280,
  nodeHint,
}) => {
  const { t } = useTranslation('common');
  const handleOpen = useCallback((id: string) => {
    // 先登记节点定位（导图实例加载完成后展开祖先/居中/高亮），再打开导图
    if (nodeHint) publishMindmapNodeTarget({ mindmapId: id, text: nodeHint });
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: { id, type: 'mindmap', title: displayTitle },
    }));
  }, [displayTitle, nodeHint]);

  return (
    <div className={cn('my-3 w-full', className)}>
      <MindMapEmbed
        mindmapId={mindmapId}
        versionId={versionId}
        height={embedHeight}
        // ★ 2026-02-13 修复：版本引用也显示打开按钮
        // MindMapEmbed 内部会自动从版本元数据获取父导图 ID 进行导航
        showOpenButton
        onOpen={handleOpen}
        openLabel={t('actions.open')}
        displayTitle={displayTitle}
        focusNodeHint={nodeHint}
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
  /** 节点定位提示 */
  nodeHint?: string;
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
  nodeHint,
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

    // 在右侧面板打开预览（带节点提示时登记定位；版本 ID 无法直接打开实例，不定位）
    if (nodeHint && mindmapId.startsWith('mm_')) {
      publishMindmapNodeTarget({ mindmapId, text: nodeHint });
    }
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: {
        id: mindmapId,
        type: 'mindmap',
        title: title || t('mindmapCitation.mindmap'),
      },
    }));
  }, [mindmapId, title, nodeHint, onClick, t]);

  return (
    <DsButton
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
      <TreeStructure size={12} />
      <span className="truncate max-w-[120px]">{title || t('mindmapCitation.mindmap')}</span>
    </DsButton>
  );
};

export default MindmapCitationCard;
