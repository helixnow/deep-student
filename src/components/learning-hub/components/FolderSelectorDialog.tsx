/**
 * 文件夹选择器对话框
 *
 * 用于批量移动资源时选择目标文件夹
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/shad/Dialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import type { FolderTreeNode } from '@/dstu/types/folder';

// ============================================================================
// 类型定义
// ============================================================================

export interface FolderSelectorDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
  /** 选择确认回调 */
  onConfirm: (folderId: string | null) => void;
  /** 文件夹树数据 */
  folderTree: FolderTreeNode[];
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 是否正在移动 */
  isMoving?: boolean;
  /** 标题 */
  title?: string;
  /** 描述 */
  description?: string;
}

// ============================================================================
// 文件夹树节点组件
// ============================================================================

interface FolderTreeItemProps {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
}

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  node,
  depth,
  selectedId,
  onSelect,
  expandedIds,
  onToggleExpand,
}) => {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.folder.id);
  const isSelected = selectedId === node.folder.id;

  return (
    <>
      <NotionButton
        variant="ghost" size="sm"
        className={cn(
          'w-full !justify-start !px-2 !py-1.5',
          isSelected
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted text-foreground',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node.folder.id)}
      >
        {/* 展开/折叠按钮 */}
        {hasChildren ? (
          <NotionButton
            variant="ghost" size="icon" iconOnly
            className="shrink-0 !h-5 !w-5 !p-0.5 mr-1"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.folder.id);
            }}
            aria-label="toggle"
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </NotionButton>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* 文件夹图标 */}
        {isExpanded ? (
          <FolderOpen className="w-4 h-4 mr-2 shrink-0 text-amber-500" />
        ) : (
          <Folder className="w-4 h-4 mr-2 shrink-0 text-amber-500" />
        )}

        {/* 标题 */}
        <span className="truncate">{node.folder.title}</span>
      </NotionButton>

      {/* 子节点 */}
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <FolderTreeItem
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export function FolderSelectorDialog({
  open,
  onOpenChange,
  onConfirm,
  folderTree,
  isLoading = false,
  isMoving = false,
  title,
  description,
}: FolderSelectorDialogProps) {
  const { t } = useTranslation('learningHub');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // 展开/折叠文件夹
  const handleToggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // 确认选择
  const handleConfirm = () => {
    onConfirm(selectedId);
  };

  // 过滤掉内置文件夹（只保留用户创建的文件夹）
  const userFolders = useMemo(() => {
    return folderTree.filter((node) => !node.folder.isBuiltin);
  }, [folderTree]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>
            {title || t('multiSelect.moveDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {description || t('multiSelect.moveDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        {/* 文件夹列表 */}
        <div className="min-h-[200px] max-h-[300px] border rounded-md">
          <CustomScrollArea className="h-[300px]">
            <div className="p-2">
              {isLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  <span className="text-sm">{t('loading.resources')}</span>
                </div>
              ) : userFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Folder className="w-8 h-8 mb-2 opacity-50" />
                  <span className="text-sm">{t('folder.noFolders')}</span>
                  <span className="text-xs mt-1 opacity-70">
                    {t('folder.createFirst')}
                  </span>
                </div>
              ) : (
                <>
                  {/* 根目录选项 */}
                  <NotionButton variant="ghost" size="sm" className={cn('w-full !justify-start !px-2 !py-1.5 mb-1', selectedId === null ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-foreground')} onClick={() => setSelectedId(null)}>
                    <span className="w-5 shrink-0" />
                    <Folder className="w-4 h-4 mr-2 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t('folder.root')}</span>
                  </NotionButton>

                  {/* 文件夹树 */}
                  {userFolders.map((node) => (
                    <FolderTreeItem
                      key={node.folder.id}
                      node={node}
                      depth={0}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      expandedIds={expandedIds}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                </>
              )}
            </div>
          </CustomScrollArea>
        </div>

        <DialogFooter>
          <NotionButton
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            {t('common.cancel')}
          </NotionButton>
          <NotionButton
            onClick={handleConfirm}
            disabled={isMoving || isLoading}
          >
            {isMoving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('multiSelect.moving')}
              </>
            ) : (
              t('multiSelect.moveConfirm')
            )}
          </NotionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
