import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, ChevronRight, Home, Loader2, FolderInput } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/shad/Dialog';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { folderApi } from '@/dstu';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { isErr } from '@/shared/result';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前选中项的 ID 列表（用于排除不能移动到自身或子文件夹的情况） */
  excludeFolderIds?: string[];
  onConfirm: (targetFolderId: string | null) => void;
  title?: string;
}

interface FolderNodeProps {
  node: FolderTreeNode;
  level: number;
  selectedId: string | null;
  excludeIds: Set<string>;
  expandedIds: Set<string>;
  onSelect: (id: string | null) => void;
  onToggleExpand: (id: string) => void;
}

function FolderNode({
  node,
  level,
  selectedId,
  excludeIds,
  expandedIds,
  onSelect,
  onToggleExpand,
}: FolderNodeProps) {
  const isExcluded = excludeIds.has(node.folder.id);
  const isSelected = selectedId === node.folder.id;
  const isExpanded = expandedIds.has(node.folder.id);
  const hasChildren = node.children.length > 0;
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(isExpanded ? 'auto' : 0);

  useEffect(() => {
    if (contentRef.current) {
      if (isExpanded) {
        const h = contentRef.current.scrollHeight;
        setHeight(h);
        const timer = setTimeout(() => setHeight('auto'), 200);
        return () => clearTimeout(timer);
      } else {
        setHeight(contentRef.current.scrollHeight);
        requestAnimationFrame(() => setHeight(0));
      }
    }
  }, [isExpanded]);

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 py-2 px-2 rounded-md cursor-pointer',
          'transition-all duration-150 ease-out',
          'active:scale-[0.99]',
          isSelected && !isExcluded && 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]',
          !isSelected && !isExcluded && 'hover:bg-muted/50',
          isExcluded && 'opacity-40 cursor-not-allowed'
        )}
        style={{ paddingLeft: `${level * 16 + 12}px` }}
        onClick={() => !isExcluded && onSelect(node.folder.id)}
      >
        {hasChildren ? (
          <NotionButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5 !p-0.5" onClick={(e) => { e.stopPropagation(); onToggleExpand(node.folder.id); }} aria-label="toggle">
            <ChevronRight 
              className={cn(
                'w-3.5 h-3.5 transition-transform duration-200 ease-out',
                isExpanded && 'rotate-90'
              )} 
            />
          </NotionButton>
        ) : (
          <span className="w-4" />
        )}
        <Folder className={cn(
          'w-4 h-4 shrink-0 transition-colors duration-150',
          isSelected ? 'text-primary' : 'text-amber-500'
        )} />
        <span className="text-sm truncate flex-1">{node.folder.title}</span>
      </div>
      {hasChildren && (
        <div
          ref={contentRef}
          className="overflow-hidden transition-[height] duration-200 ease-out"
          style={{ height: typeof height === 'number' ? `${height}px` : height }}
        >
          {node.children.map((child, index) => (
            <div
              key={child.folder.id}
              className="animate-in fade-in-0 slide-in-from-left-1"
              style={{ animationDelay: `${index * 30}ms`, animationFillMode: 'both' }}
            >
              <FolderNode
                node={child}
                level={level + 1}
                selectedId={selectedId}
                excludeIds={excludeIds}
                expandedIds={expandedIds}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  excludeFolderIds = [],
  onConfirm,
  title,
}: FolderPickerDialogProps) {
  const { t } = useTranslation('learningHub');
  const [folderTree, setFolderTree] = useState<FolderTreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const excludeSet = useMemo(() => new Set(excludeFolderIds), [excludeFolderIds]);

  const loadFolderTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const treeResult = await folderApi.getFolderTree();
    if (!isErr(treeResult)) {
      setFolderTree(treeResult.value);
      // 默认展开第一层
      const firstLevelIds = new Set(treeResult.value.map((n) => n.folder.id));
      setExpandedIds(firstLevelIds);
    } else {
      setError(treeResult.error.toUserMessage());
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      loadFolderTree();
      setSelectedId(null);
    }
  }, [open, loadFolderTree]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleConfirm = () => {
    onConfirm(selectedId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md !p-2.5 gap-0 overflow-hidden">
        {/* 标题区 */}
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <FolderInput className="w-4 h-4 text-muted-foreground" />
            {title || t('finder.folderPicker.title')}
          </DialogTitle>
        </DialogHeader>

        {/* 内容区 */}
        <div className="h-[320px] overflow-hidden mb-3">
          <CustomScrollArea className="h-full" fullHeight>
            {isLoading ? (
              <div className="flex items-center justify-center h-32 px-5">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-32 px-5 text-sm text-destructive">
                {error}
              </div>
            ) : (
                <div className="py-1 px-5">
                {/* 根目录选项 */}
                <div
                  className={cn(
                    'flex items-center gap-2 py-2 px-3 rounded-md cursor-pointer',
                    'transition-all duration-150 ease-out active:scale-[0.99]',
                    selectedId === null && 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]',
                    selectedId !== null && 'hover:bg-muted/50'
                  )}
                  onClick={() => setSelectedId(null)}
                >
                  <Home className={cn(
                    'w-4 h-4 transition-colors duration-150',
                    selectedId === null ? 'text-primary' : 'text-muted-foreground'
                  )} />
                  <span className="text-sm font-medium">
                    {t('finder.folderPicker.root')}
                  </span>
                </div>
                {/* 文件夹树 */}
                {folderTree.map((node) => (
                  <FolderNode
                    key={node.folder.id}
                    node={node}
                    level={0}
                    selectedId={selectedId}
                    excludeIds={excludeSet}
                    expandedIds={expandedIds}
                    onSelect={setSelectedId}
                    onToggleExpand={handleToggleExpand}
                  />
                ))}
              </div>
            )}
          </CustomScrollArea>
        </div>

        {/* 底部操作区 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/40">
          <NotionButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" onClick={handleConfirm} disabled={isLoading}>
            {t('finder.folderPicker.confirm')}
          </NotionButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
