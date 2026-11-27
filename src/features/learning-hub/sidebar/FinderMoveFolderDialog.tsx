/**
 * FinderMoveFolderDialog — 「移动到…」文件夹选择对话框
 *
 * 每个可选目标（包括「根目录」及所有可移动文件夹）均为可交互 `<button>`，
 * 带有 `aria-selected`、高亮状态与当前目标提示，避免非交互节点导致键盘或辅助技术无法选中。
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  CaretRight,
  CaretLeft,
  House,
  CircleNotch,
  FolderOpen as FolderInputIcon,
} from '@phosphor-icons/react';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogFooter } from '@/components/ui/DsDialog';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { folderApi } from '@/dstu';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { isErr } from '@/shared/result';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { useMobileSubviewChrome } from '@/components/layout';
import '../components/finder/finder-animations.css';

export interface FinderMoveFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeFolderIds?: string[];
  onConfirm: (targetFolderId: string | null) => void;
  title?: string;
  inline?: boolean;
  footerStart?: React.ReactNode;
  confirmLabel?: string;
}

function withoutReservedFolders(nodes: FolderTreeNode[]): FolderTreeNode[] {
  return nodes
    .filter((node) => node.folder.title.trim().toLowerCase() !== '__system__')
    .map((node) => ({ ...node, children: withoutReservedFolders(node.children ?? []) }));
}

function collectFolderTitles(
  nodes: FolderTreeNode[],
  map: Map<string, string>,
): void {
  for (const node of nodes) {
    map.set(node.folder.id, node.folder.title);
    if (node.children?.length) collectFolderTitles(node.children, map);
  }
}

function collectExpandableIds(nodes: FolderTreeNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.children?.length) {
      out.add(node.folder.id);
      collectExpandableIds(node.children, out);
    }
  }
}

interface FolderNodeRowProps {
  node: FolderTreeNode;
  level: number;
  selectedId: string | null;
  excludeIds: Set<string>;
  expandedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  parentExcluded?: boolean;
}

const FolderNodeRow: React.FC<FolderNodeRowProps> = ({
  node,
  level,
  selectedId,
  excludeIds,
  expandedIds,
  onSelect,
  onToggleExpand,
  parentExcluded = false,
}) => {
  const { t } = useTranslation('learningHub');
  const isExcluded = parentExcluded || excludeIds.has(node.folder.id);
  const isSelected = !isExcluded && selectedId === node.folder.id;
  const isExpanded = expandedIds.has(node.folder.id);
  const hasChildren = (node.children?.length ?? 0) > 0;

  return (
    <div role="none">
      <div
        className="flex items-center gap-1"
        style={{ paddingLeft: `${level * 18}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] transition-colors"
            onClick={() => onToggleExpand(node.folder.id)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? t('finder.folderPicker.collapseFolder') : t('finder.folderPicker.expandFolder')}
          >
            <CaretRight
              size={12}
              className={cn(
                'text-muted-foreground transition-transform duration-150',
                isExpanded && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden="true" />
        )}

        <button
          type="button"
          disabled={isExcluded}
          aria-selected={isSelected}
          aria-pressed={isSelected}
          data-selected={isSelected ? 'true' : undefined}
          data-folder-option-id={node.folder.id}
          onClick={() => {
            if (!isExcluded) onSelect(node.folder.id);
          }}
          className={cn(
            'flex-1 min-w-0 flex items-center justify-start gap-2 py-2 px-2.5 rounded-md text-left',
            'transition-all duration-150 ease-out active:scale-[0.99]',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
            isExcluded && 'opacity-40 cursor-not-allowed',
            !isExcluded && !isSelected && 'cursor-pointer hover:bg-[var(--interactive-hover)]',
            isSelected && 'bg-primary/10 text-primary font-medium ring-1 ring-primary/35',
          )}
        >
          <Folder
            size={16}
            className={cn(
              'shrink-0 transition-colors duration-150',
              isSelected ? 'text-primary' : 'text-warning',
            )}
          />
          <span className="text-sm truncate">{node.folder.title}</span>
        </button>
      </div>

      {hasChildren && isExpanded && (
        <div role="group">
          {node.children.map((child) => (
            <FolderNodeRow
              key={child.folder.id}
              node={child}
              level={level + 1}
              selectedId={selectedId}
              excludeIds={excludeIds}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              parentExcluded={isExcluded}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FinderMoveFolderDialog: React.FC<FinderMoveFolderDialogProps> = ({
  open,
  onOpenChange,
  excludeFolderIds = [],
  onConfirm,
  title,
  inline = false,
  footerStart,
  confirmLabel,
}) => {
  const { t } = useTranslation(['learningHub', 'common', 'dstu']);
  const tRef = useRef(t);
  tRef.current = t;
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const excludeSet = useMemo(() => new Set(excludeFolderIds), [excludeFolderIds]);
  const rootLabel = t('learningHub:folder.root');

  const folderTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    collectFolderTitles(tree, map);
    return map;
  }, [tree]);

  const selectedDestinationLabel = selectedId === null
    ? rootLabel
    : (folderTitleMap.get(selectedId) ?? rootLabel);

  const loadFolderTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await folderApi.getFolderTree();
      if (isErr(result)) {
        setError(result.error.message);
        return;
      }
      const cleaned = withoutReservedFolders(result.value);
      setTree(cleaned);
      const initialExpanded = new Set<string>();
      collectExpandableIds(cleaned, initialExpanded);
      setExpandedIds(initialExpanded);
    } catch (err) {
      setError(err instanceof Error ? err.message : tRef.current('learningHub:finder.folderPicker.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadFolderTree();
      setSelectedId(null);
    }
  }, [open, loadFolderTree]);

  useEffect(() => {
    if (!open || !inline) return;
    return registerBackHandler(() => {
      onOpenChange(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open, inline, onOpenChange]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirm = () => {
    onConfirm(selectedId);
    onOpenChange(false);
  };

  const resolvedTitle = title || t('learningHub:finder.folderPicker.title');

  const subviewChromeHosted = useMobileSubviewChrome(
    {
      title: resolvedTitle,
      onBack: () => onOpenChange(false),
      screen: 'center',
    },
    inline && open,
  );

  const treeBody = isLoading ? (
    <div className="flex items-center justify-center h-32 px-5">
      <CircleNotch size={20} className="animate-spin text-muted-foreground" />
    </div>
  ) : error ? (
    <div className="flex items-center justify-center h-32 px-5 text-sm text-destructive">
      {error}
    </div>
  ) : (
    <div
      className={cn('py-1 space-y-1', inline ? 'px-3' : 'px-5')}
      role="listbox"
      aria-label={resolvedTitle}
    >
      <button
        type="button"
        aria-selected={selectedId === null}
        aria-pressed={selectedId === null}
        data-selected={selectedId === null ? 'true' : undefined}
        data-folder-option-id="root"
        onClick={() => setSelectedId(null)}
        className={cn(
          'w-full flex items-center justify-start gap-2 py-2 px-3 rounded-md text-left',
          'transition-all duration-150 ease-out active:scale-[0.99]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
          selectedId === null
            ? 'bg-primary/10 text-primary font-medium ring-1 ring-primary/35'
            : 'cursor-pointer hover:bg-[var(--interactive-hover)]',
        )}
      >
        <House
          size={16}
          className={cn(
            'shrink-0 transition-colors duration-150',
            selectedId === null ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="text-sm">{rootLabel}</span>
      </button>

      {tree.length === 0 ? (
        <div className="text-center py-6 text-xs text-muted-foreground">
          {t('learningHub:finder.folderPicker.noSubfolders')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {tree.map((node) => (
            <FolderNodeRow
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
    </div>
  );

  const destinationSummary = (
    <div
      className={cn(
        'text-xs text-muted-foreground flex items-center gap-1.5 truncate',
        inline ? 'px-4 py-1.5 border-t border-border/50 bg-muted/20' : 'px-5 pb-2',
      )}
      data-testid="finder-move-selected-destination"
    >
      <span>{t('dstu:finder.selectedTarget', { defaultValue: '当前目标：' })}</span>
      <span className="font-medium text-foreground truncate">{selectedDestinationLabel}</span>
    </div>
  );

  const inlinePresence = useMotionPresence(inline && open, {
    exitMs: readCssDurationMs('--modal-exit-dur', 150),
    enter: 'transition',
  });

  if (inline) {
    if (!inlinePresence.mounted) return null;
    return (
      <div
        className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background finder-fade-in"
        data-state={inlinePresence.exiting ? 'closed' : 'open'}
        role="dialog"
        aria-modal="true"
        aria-label={resolvedTitle}
        aria-hidden={inlinePresence.exiting || undefined}
      >
        {!subviewChromeHosted && (
          <div className="flex items-center gap-1 border-b border-border/50 pl-1 pr-2 py-1.5 shrink-0">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              aria-label={t('common:back')}
              className="gap-1 px-2 shrink-0"
            >
              <CaretLeft className="h-4 w-4" aria-hidden="true" />
              {t('common:back')}
            </DsButton>
            <FolderInputIcon size={16} className="text-muted-foreground shrink-0" />
            <h2 className="text-sm font-semibold truncate">{resolvedTitle}</h2>
          </div>
        )}

        <CustomScrollArea className="flex-1 min-h-0" fullHeight>
          {treeBody}
        </CustomScrollArea>

        {destinationSummary}

        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2 shrink-0 bg-background pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]">
          {footerStart && <div className="mr-auto min-w-0">{footerStart}</div>}
          <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="px-4">
            {t('common:cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleConfirm} disabled={isLoading} className="px-4">
            {confirmLabel ?? t('learningHub:finder.folderPicker.confirm')}
          </DsButton>
        </div>
      </div>
    );
  }

  return (
    <DsDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="max-w-md"
    >
      <DsDialogHeader>
        <DsDialogTitle className="flex items-center gap-2">
          <FolderInputIcon size={16} className="text-muted-foreground" />
          {resolvedTitle}
        </DsDialogTitle>
      </DsDialogHeader>

      <div className="h-[320px] overflow-hidden mb-3">
        <CustomScrollArea className="h-full" fullHeight>
          {treeBody}
        </CustomScrollArea>
      </div>

      {destinationSummary}

      <DsDialogFooter>
        {footerStart && <div className="mr-auto min-w-0">{footerStart}</div>}
        <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          {t('common:cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" onClick={handleConfirm} disabled={isLoading}>
          {confirmLabel ?? t('learningHub:finder.folderPicker.confirm')}
        </DsButton>
      </DsDialogFooter>
    </DsDialog>
  );
};
