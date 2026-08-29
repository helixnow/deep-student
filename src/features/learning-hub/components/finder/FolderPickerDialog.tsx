import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, CaretRight, CaretLeft, House, CircleNotch, FolderOpen as FolderInputIcon } from '@phosphor-icons/react';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogFooter } from '@/components/ui/DsDialog';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { folderApi } from '@/dstu';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { isErr } from '@/shared/result';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useMobileSubviewChrome } from '@/components/layout';
import { TouchTarget } from '@/components/ui/TouchTarget';
import './finder-animations.css';

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前选中项的 ID 列表（用于排除不能移动到自身或子文件夹的情况） */
  excludeFolderIds?: string[];
  onConfirm: (targetFolderId: string | null) => void;
  title?: string;
  /**
   * 📱 内联渲染模式（移动端契约：禁止模态框）。
   * true 时不再渲染 DsDialog，而是渲染一个覆盖宿主容器的全屏子屏
   * （absolute inset-0 + 顶栏返回 + 底部确认条），需挂在 relative 容器内。
   */
  inline?: boolean;
}

interface FolderNodeProps {
  node: FolderTreeNode;
  level: number;
  selectedId: string | null;
  excludeIds: Set<string>;
  expandedIds: Set<string>;
  onSelect: (id: string | null) => void;
  onToggleExpand: (id: string) => void;
  /** 祖先节点被排除时，整棵子树都不可选（防止移动到自身的子文件夹形成循环） */
  parentExcluded?: boolean;
}

function FolderNode({
  node,
  level,
  selectedId,
  excludeIds,
  expandedIds,
  onSelect,
  onToggleExpand,
  parentExcluded = false,
}: FolderNodeProps) {
  const { t } = useTranslation('learningHub');
  const isExcluded = parentExcluded || excludeIds.has(node.folder.id);
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
    <div role="none">
      <TouchTarget asChild>
        <div
          role="treeitem"
          aria-selected={isSelected && !isExcluded}
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-disabled={isExcluded || undefined}
          tabIndex={isExcluded ? -1 : 0}
          className={cn(
            'flex items-center justify-start gap-1.5 py-2 px-2 rounded-md cursor-pointer',
            'transition-all duration-150 ease-out',
            'active:scale-[0.99]',
            'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]',
            isSelected && !isExcluded && 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]',
            !isSelected && !isExcluded && 'hover:bg-[var(--interactive-hover)]',
            isExcluded && 'opacity-40 cursor-not-allowed'
          )}
          style={{ paddingLeft: `${level * 16 + 12}px` }}
          onClick={() => !isExcluded && onSelect(node.folder.id)}
          onKeyDown={(e) => {
            if (isExcluded) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(node.folder.id);
            } else if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
              e.preventDefault();
              onToggleExpand(node.folder.id);
            } else if (e.key === 'ArrowLeft' && hasChildren && isExpanded) {
              e.preventDefault();
              onToggleExpand(node.folder.id);
            }
          }}
        >
        {hasChildren ? (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            tabIndex={-1}
            className="!h-5 !w-5 !p-0.5"
            onClick={(e) => { e.stopPropagation(); onToggleExpand(node.folder.id); }}
            aria-label={isExpanded ? t('common:actions.collapse') : t('common:actions.expand')}
            aria-expanded={isExpanded}
          >
            <CaretRight 
              className={cn(
                'transition-transform duration-200 ease-out',
                isExpanded && 'rotate-90'
              )}
              size={14}
            />
          </DsButton>
        ) : (
          <span className="w-4" />
        )}
        <Folder size={16} className={cn(
          'shrink-0 transition-colors duration-150',
          isSelected ? 'text-primary' : 'text-amber-500'
        )} />
          <span className="text-sm truncate flex-1">{node.folder.title}</span>
        </div>
      </TouchTarget>
      {hasChildren && (
        <div
          ref={contentRef}
          className="overflow-hidden transition-[height] duration-200 ease-out"
          style={{ height: typeof height === 'number' ? `${height}px` : height }}
        >
          {node.children.map((child, index) => (
            <div
              key={child.folder.id}
              className="ui-slide-fade-in [--ui-enter-x:-4px]"
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
                parentExcluded={isExcluded}
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
  inline = false,
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

  // 📱 内联子屏形态：Android 返回键 = 关闭子屏（契约第 4 条）
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

  const resolvedTitle = title || t('finder.folderPicker.title');

  // 📱 小屏 learning-hub 承载（中屏子屏）：标题/返回上移 App 级统一顶栏，
  // 页内不再自绘返回行；返回箭头与上方系统返回键同语义（关闭子屏）。
  // 无宿主（桌面分栏 / 「保存为笔记」的独立 fixed 承载等）返回 false，保持自绘返回行。
  // 注意：通道只接管顶栏，不注册返回键——上面的 registerBackHandler 必须保留。
  const subviewChromeHosted = useMobileSubviewChrome(
    {
      title: resolvedTitle,
      onBack: () => onOpenChange(false),
      screen: 'center',
    },
    [resolvedTitle, onOpenChange],
    inline && open,
  );

  // 树内容（Dialog / 内联子屏共用）
  const treeBody = isLoading ? (
    <div className="flex items-center justify-center h-32 px-5">
      <CircleNotch size={20} className="animate-spin text-muted-foreground" />
    </div>
  ) : error ? (
    <div className="flex items-center justify-center h-32 px-5 text-sm text-destructive">
      {error}
    </div>
  ) : (
    <div className={cn('py-1', inline ? 'px-3' : 'px-5')} role="tree" aria-label={resolvedTitle}>
      {/* 根目录选项 */}
      <TouchTarget asChild>
        <div
          role="treeitem"
          aria-selected={selectedId === null}
          tabIndex={0}
          className={cn(
            'flex items-center justify-start gap-2 py-2 px-3 rounded-md cursor-pointer',
            'transition-all duration-150 ease-out active:scale-[0.99]',
            'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]',
            selectedId === null && 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]',
            selectedId !== null && 'hover:bg-[var(--interactive-hover)]'
          )}
          onClick={() => setSelectedId(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelectedId(null);
            }
          }}
        >
          <House size={16} className={cn(
            'transition-colors duration-150',
            selectedId === null ? 'text-primary' : 'text-muted-foreground'
          )} />
          <span className="text-sm font-medium">
            {t('finder.folderPicker.root')}
          </span>
        </div>
      </TouchTarget>
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
  );

  // 📱 内联全屏子屏（范式：IndexStatusView OCR 移动全屏）
  if (inline) {
    if (!open) return null;
    return (
      <div
        className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background finder-fade-in"
        role="dialog"
        aria-label={resolvedTitle}
      >
        {/* 顶栏：返回 + 标题（有统一顶栏宿主时由其接管，页内不再自绘） */}
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

        {/* 文件夹树列表 */}
        <CustomScrollArea className="flex-1 min-h-0" fullHeight>
          {treeBody}
        </CustomScrollArea>

        {/* 底部确认条 */}
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2 shrink-0 bg-background pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))]">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="px-4"
          >
            {t('common:cancel')}
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={isLoading}
            className="px-4"
          >
            {t('finder.folderPicker.confirm')}
          </DsButton>
        </div>
      </div>
    );
  }

  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-md">
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2">
            <FolderInputIcon size={16} className="text-muted-foreground" />
            {resolvedTitle}
          </DsDialogTitle>
        </DsDialogHeader>

        {/* 内容区 */}
        <div className="h-[320px] overflow-hidden mb-3">
          <CustomScrollArea className="h-full" fullHeight>
            {treeBody}
          </CustomScrollArea>
        </div>

        <DsDialogFooter>
          <DsButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleConfirm} disabled={isLoading}>
            {t('finder.folderPicker.confirm')}
          </DsButton>
        </DsDialogFooter>
    </DsDialog>
  );
}
