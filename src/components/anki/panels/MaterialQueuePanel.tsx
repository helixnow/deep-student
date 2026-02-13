/**
 * MaterialQueuePanel - 待制卡素材队列面板
 *
 * 显示和管理待制卡的素材队列，包括：
 * - 素材列表显示
 * - 批量选择操作
 * - 加载/移除素材
 * - 合并选中素材
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { formatDisplayDate } from '@/components/anki/utils/formatters';
import type { QueuedAnkiMaterial } from '@/stores/ankiQueueStore';

// 为了保持向后兼容，导出类型别名
export type QueuedMaterial = QueuedAnkiMaterial;

export interface MaterialQueuePanelProps {
  /** 素材队列列表 */
  materials: QueuedMaterial[];
  /** 已选中的素材 ID 集合 */
  selectedIds: Set<string>;
  /** 选择状态变化回调 */
  onSelectionChange: (queueId: string, checked: boolean | 'indeterminate') => void;
  /** 全选/取消全选 */
  onSelectAll: () => void;
  /** 清除选择 */
  onClearSelection: () => void;
  /** 合并选中素材 */
  onMergeSelected: () => void;
  /** 清空队列 */
  onClearQueue: () => void;
  /** 加载素材回调 */
  onLoadMaterial: (material: QueuedMaterial, mode: 'replace' | 'append') => void;
  /** 移除素材回调 */
  onRemoveMaterial: (queueId: string) => void;
}

/**
 * 待制卡素材队列面板组件
 */
export function MaterialQueuePanel({
  materials,
  selectedIds,
  onSelectionChange,
  onSelectAll,
  onClearSelection,
  onMergeSelected,
  onClearQueue,
  onLoadMaterial,
  onRemoveMaterial,
}: MaterialQueuePanelProps) {
  const { t } = useTranslation();

  const hasItems = materials.length > 0;
  const hasSelection = selectedIds.size > 0;
  const allSelected = hasItems && selectedIds.size === materials.length;
  const selectionCount = selectedIds.size;

  const getSourceLabel = (sourceType: string) => {
    switch (sourceType) {
      case 'mistake':
        return t('card_generation_page.source_mistakes');
      case 'file':
        return t('card_generation_page.source_file');
      case 'chat':
        return t('card_generation_page.source_chat');
      default:
        return sourceType;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px]">
          {t('material_queue_title')} ({materials.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasItems ? (
          <div className="space-y-3">
            {/* 操作按钮组 */}
            <div className="flex flex-wrap items-center gap-2">
              <NotionButton
                size="sm"
                variant={allSelected ? 'default' : 'outline'}
                onClick={onSelectAll}
                disabled={!hasItems}
              >
                {allSelected ? t('card_list.deselect_all') : t('card_list.select_all')}
              </NotionButton>
              <NotionButton
                size="sm"
                variant={hasSelection ? 'default' : 'outline'}
                onClick={onMergeSelected}
                disabled={!hasSelection}
              >
                {t('actions.merge_selected')}
              </NotionButton>
              <NotionButton
                size="sm"
                variant="ghost"
                onClick={onClearSelection}
                disabled={!hasSelection}
              >
                {t('clear_selection')}
              </NotionButton>
              <NotionButton
                size="sm"
                variant="destructive"
                onClick={onClearQueue}
                disabled={!hasItems}
              >
                {t('actions.clear_queue')}
              </NotionButton>
              {hasSelection && (
                <Badge variant="secondary" className="text-[11px]">
                  {t('selected_count')} {selectionCount}
                </Badge>
              )}
            </div>

            {/* 素材列表 */}
            <CustomScrollArea
              className="max-h-[260px] -mr-2"
              viewportClassName="pr-2 space-y-3"
              trackOffsetTop={8}
              trackOffsetBottom={8}
              trackOffsetRight={0}
            >
              <div className="space-y-3">
                {materials.map((material) => {
                  const isSelected = selectedIds.has(material.queueId);
                  const sourceLabel = getSourceLabel(material.sourceType);
                  const previewText = (material.summary || material.content.slice(0, 160)).replace(/\s+/g, ' ');

                  return (
                    <div
                      key={material.queueId}
                      className="rounded-lg border bg-card px-3 py-3 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(value) => onSelectionChange(material.queueId, value)}
                            className="mt-1"
                            aria-label={t('select_material')}
                          />
                          <div className="space-y-1 min-w-0">
                            <div
                              className="text-sm font-semibold text-foreground truncate"
                              title={material.title}
                            >
                              {material.title}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>{t('source')}：{sourceLabel}</span>
                              {material.tags && material.tags.length > 0 && (
                                <span>
                                  {t('tags')}：
                                  {material.tags.slice(0, 3).join('、')}
                                  {material.tags.length > 3 ? ` +${material.tags.length - 3}` : ''}
                                </span>
                              )}
                              <span>
                                {t('queued_at')}：{formatDisplayDate(material.createdAt)}
                              </span>
                            </div>
                            {previewText && (
                              <p
                                className="text-xs text-muted-foreground line-clamp-2"
                                title={previewText}
                              >
                                {previewText}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-1.5">
                            <NotionButton
                              size="sm"
                              variant="outline"
                              onClick={() => onLoadMaterial(material, 'replace')}
                            >
                              {t('load_replace')}
                            </NotionButton>
                            <NotionButton
                              size="sm"
                              variant="outline"
                              onClick={() => onLoadMaterial(material, 'append')}
                            >
                              {t('load_append')}
                            </NotionButton>
                          </div>
                          <NotionButton
                            size="sm"
                            variant="ghost"
                            onClick={() => onRemoveMaterial(material.queueId)}
                          >
                            {t('remove')}
                          </NotionButton>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CustomScrollArea>
          </div>
        ) : (
          <div className="rounded-md border border-dashed bg-muted px-4 py-6 text-sm text-muted-foreground break-words">
            {t('material_queue_empty_hint')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default MaterialQueuePanel;
