import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  FileArchive,
  FileText,
  FolderPlus,
  Lightbulb,
  LinkSimple,
  MagnifyingGlass,
  Notebook,
  Tag,
  Trash,
  TreeStructure,
  X,
} from '@phosphor-icons/react';
import type { DstuNode } from '@/dstu';
import { DsButton } from '@/components/ui/DsButton';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import {
  NOTE_TITLE_MAX_CHARS,
  NOTE_TITLE_COUNT_WARN_THRESHOLD,
  countNoteInputChars,
  sanitizeNoteTitleInput,
} from '@/features/notes/noteInputLimits';
import { useOptionalSlot, useOptionalUiKernel } from '@/ui-kernel/react';
import type { NotesTreeMenuActions } from '@/ui-kernel/contracts/content';
import {
  officialNotesTreeMenuEntries,
  resolveNotesTreeMenu,
  type ResourceMenuError,
} from '@/ui-plugins/official/menu/notesTreeMenu';
import { WorkbenchSidebarSurface } from '../../../components/sidebar';
import { ExplorerOverflowMenu, type ExplorerOverflowAction } from '../ExplorerOverflowMenu';
import { FavoritesSection } from '../FavoritesSection';
import { InsightsSection } from '../InsightsSection';
import { TagFilter } from '../TagFilter';
import type { UseNoteFavoritesResult } from '../hooks/useNoteFavorites';
import type { NotesWorkspaceResourceRef } from '../workspaceRegistry';
import {
  NotesWorkspaceTree,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeItem,
  type NotesWorkspaceTreeMenuItem,
} from '../tree';
import {
  getExplorerTargetName,
  isStableVfsFolderId,
  type ResourceDialog,
  type ResourceType,
} from '../workspaceTreeModel';
import { IconButton } from './WorkspaceTabStrip';

const TREE_SKELETON_ROWS: Array<{ indent: number; width: string }> = [
  { indent: 0, width: '68%' },
  { indent: 1, width: '54%' },
  { indent: 1, width: '62%' },
  { indent: 2, width: '48%' },
];

export interface WorkspaceExplorerProps {
  canNavBack: boolean;
  canNavForward: boolean;
  onNavBack: () => void;
  onNavForward: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedTags: string[];
  onSelectedTagsChange: (tags: string[]) => void;
  loading: boolean;
  loadError: string | null;
  resourcesCount: number;
  filteredResources: readonly DstuNode[];
  treeItems: readonly NotesWorkspaceTreeItem[];
  expandedIds: ReadonlySet<string>;
  selectedTreeId: string | null;
  selectedFolderId: string | null;
  activeTabId: string | null;
  backlinksOpen: boolean;
  favorites: UseNoteFavoritesResult;
  resourceDialog: ResourceDialog | null;
  dialogError: string | null;
  onResourceDialogChange: (dialog: ResourceDialog | null) => void;
  onDialogErrorChange: (error: string | null) => void;
  onCreateResource: (type: ResourceType, folderId?: string | null) => void;
  onCreateFolderSubmit: () => void;
  onDeleteConfirm: () => void;
  onDeleteManyConfirm: () => void;
  onOpenLearningCreate: (folderId?: string | null) => void;
  onOpenFullTextSearch: () => void;
  onToggleBacklinks: () => void;
  onOpenTrash: () => void;
  onOpenLibrary: () => void;
  onRetryLoad: () => void;
  onOpenResource: (ref: NotesWorkspaceResourceRef, title?: string) => Promise<void>;
  onOpenTabInRightSplit: (key: string) => void;
  onOpenSearchResult: (node: DstuNode) => void;
  onCloseExplorerIfCompact: () => void;
  onToggleTreeExpand: (id: string) => void;
  onExpandTreeFolder: (id: string) => void;
  onSelectTreeItem: (id: string | null) => void;
  onOpenTreeItem: (id: string) => void;
  onMoveTreeItem: (dragId: string, targetId: string, position: NotesWorkspaceDropPosition) => void;
  onRenameTreeItem: (id: string, name: string) => void;
  onRequestDeleteTreeItem: (item: NotesWorkspaceTreeItem) => void;
  onRequestDeleteTreeItems: (items: readonly NotesWorkspaceTreeItem[]) => void;
}

export const WorkspaceExplorer: React.FC<WorkspaceExplorerProps> = ({
  canNavBack,
  canNavForward,
  onNavBack,
  onNavForward,
  query,
  onQueryChange,
  selectedTags,
  onSelectedTagsChange,
  loading,
  loadError,
  resourcesCount,
  filteredResources,
  treeItems,
  expandedIds,
  selectedTreeId,
  selectedFolderId,
  activeTabId,
  backlinksOpen,
  favorites,
  resourceDialog,
  dialogError,
  onResourceDialogChange,
  onDialogErrorChange,
  onCreateResource,
  onCreateFolderSubmit,
  onDeleteConfirm,
  onDeleteManyConfirm,
  onOpenLearningCreate,
  onOpenFullTextSearch,
  onToggleBacklinks,
  onOpenTrash,
  onOpenLibrary,
  onRetryLoad,
  onOpenResource,
  onOpenTabInRightSplit,
  onOpenSearchResult,
  onCloseExplorerIfCompact,
  onToggleTreeExpand,
  onExpandTreeFolder,
  onSelectTreeItem,
  onOpenTreeItem,
  onMoveTreeItem,
  onRenameTreeItem,
  onRequestDeleteTreeItem,
  onRequestDeleteTreeItems,
}) => {
  const { t } = useTranslation(['workbench', 'notes', 'common']);
  const explorerRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const createFolderComposingRef = useRef(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [insightCreateNonce, setInsightCreateNonce] = useState(0);
  const hasTreeItems = treeItems.length > 0;
  const showTagFilter = tagFilterOpen || selectedTags.length > 0;

  // 行内输入行 / 确认条（非模态）：打开时把焦点送进面板，关闭后归还给触发
  // 元素；触发行已被删除时回落到树内相邻可聚焦行。
  useEffect(() => {
    const mode = resourceDialog?.mode;
    if (!mode) return;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = mode === 'delete' || mode === 'delete-many'
      ? window.requestAnimationFrame(() => {
        explorerRef.current
          ?.querySelector<HTMLElement>('[data-notes-inline-confirm] button.is-danger')
          ?.focus();
      })
      : null;
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      // 焦点仍停在别的控件上（如失焦取消时点中的目标）就不要抢回来
      if (active instanceof HTMLElement && active !== document.body) return;
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      explorerRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
    };
  }, [resourceDialog?.mode]);

  const resolveCreateFolderId = useCallback((item: NotesWorkspaceTreeItem): string | undefined => {
    if (item.kind === 'folder' && isStableVfsFolderId(item.id)) return item.id;
    return selectedFolderId ?? undefined;
  }, [selectedFolderId]);

  // 目录树右键菜单：resource.contextMenu 的 notes-tree 行（官方行见 ui-plugins/official/menu/notesTreeMenu.ts）；无 UI 内核时用官方表
  const uiKernel = useOptionalUiKernel();
  const treeMenuEntries = useOptionalSlot('resource.contextMenu') ?? officialNotesTreeMenuEntries;
  const treeMenuActions = useMemo<NotesTreeMenuActions>(() => ({
    open: (item) => {
      if (item.kind !== 'folder') void onOpenResource({ type: item.kind, id: item.id }, item.name);
    },
    openInSplit: (item) => {
      if (item.kind === 'folder') return;
      const kind = item.kind;
      void (async () => {
        await onOpenResource({ type: kind, id: item.id }, item.name);
        onOpenTabInRightSplit(`${kind}:${item.id}`);
      })();
    },
    isFavorite: (item) => favorites.items.some((entry) => entry.id === item.id && entry.type === item.kind)
      || item.favorite === true,
    setFavorite: (item, favorite) => {
      if (item.kind === 'folder') return;
      void favorites.setFavorite(item.id, item.kind, favorite, {
        path: item.path,
        name: item.name,
      });
    },
    createResource: (kind, folderId) => { onCreateResource(kind, folderId); },
    createFolder: (parentId) => {
      onDialogErrorChange(null);
      onResourceDialogChange({
        mode: 'create-folder',
        value: '',
        parentId,
      });
    },
    createLearningNote: (folderId) => { onOpenLearningCreate(folderId); },
    requestDelete: (item) => { onRequestDeleteTreeItem(item); },
  }), [
    favorites,
    onCreateResource,
    onDialogErrorChange,
    onOpenLearningCreate,
    onOpenResource,
    onOpenTabInRightSplit,
    onRequestDeleteTreeItem,
    onResourceDialogChange,
  ]);

  const reportTreeMenuError = useCallback<ResourceMenuError>((entry, phase, error) => {
    if (uiKernel) uiKernel.errors.report({ pluginId: entry.owner, origin: entry.origin, phase, error, slot: 'resource.contextMenu', entryId: entry.id });
    else console.error(`[NotesWorkspaceApp] resource.contextMenu "${entry.id}" failed`, error);
  }, [uiKernel]);

  const getTreeMenuItems = useCallback((
    item: NotesWorkspaceTreeItem,
    helpers: { beginRename: () => void },
  ): NotesWorkspaceTreeMenuItem[] => resolveNotesTreeMenu(treeMenuEntries, {
    scope: 'notes-tree',
    // TreeContextMenu closes the menu after every row it runs
    closeMenu: () => {},
    item: {
      id: item.id,
      name: item.name,
      kind: item.kind,
      favorite: item.favorite,
      path: item.path,
      canRename: item.canRename,
      canMove: item.canMove,
    },
    beginRename: helpers.beginRename,
    createFolderId: resolveCreateFolderId(item) ?? null,
    canDelete: item.kind === 'folder' ? isStableVfsFolderId(item.id) : true,
    actions: treeMenuActions,
  }, t, reportTreeMenuError), [reportTreeMenuError, resolveCreateFolderId, t, treeMenuActions, treeMenuEntries]);

  // 新建按资源类型归组；库级操作始终收进菜单，避免侧栏宽度与窗口分级不一致时溢出。
  const explorerCreateActions: ExplorerOverflowAction[] = [
    { key: 'new-note', label: t('notesWorkspace.explorer.newNote', 'New note'), icon: <FileText size={15} />, onSelect: () => onCreateResource('note') },
    { key: 'new-learning-note', label: t('notes:learning.create.title', { defaultValue: '新建学习笔记' }), icon: <Notebook size={15} />, onSelect: () => onOpenLearningCreate(undefined) },
    {
      key: 'new-folder',
      label: t('notesWorkspace.explorer.newFolder', 'New folder'),
      icon: <FolderPlus size={15} />,
      onSelect: () => {
        onDialogErrorChange(null);
        onResourceDialogChange({ mode: 'create-folder', value: '', parentId: selectedFolderId });
      },
    },
    { key: 'new-mindmap', label: t('notesWorkspace.explorer.newMindmap', 'New mind map'), icon: <TreeStructure size={15} />, onSelect: () => onCreateResource('mindmap') },
  ];
  const explorerTailActions: ExplorerOverflowAction[] = [
    { key: 'search', label: t('notesWorkspace.ribbon.search', 'Search notes'), icon: <MagnifyingGlass size={15} />, onSelect: onOpenFullTextSearch },
    { key: 'new-insight', label: t('notes:insights.add_placeholder', '记录一条灵感…'), icon: <Lightbulb size={15} />, onSelect: () => setInsightCreateNonce((n) => n + 1) },
    { key: 'backlinks', label: t('notesWorkspace.ribbon.backlinks', 'Linked notes'), icon: <LinkSimple size={15} />, active: backlinksOpen, onSelect: onToggleBacklinks },
    { key: 'trash', label: t('notesWorkspace.ribbon.trash', 'Trash'), icon: <Trash size={15} />, onSelect: onOpenTrash },
    { key: 'library', label: t('notesWorkspace.library.manage', 'Import or export library'), icon: <FileArchive size={15} />, onSelect: onOpenLibrary },
  ];

  return (
    <WorkbenchSidebarSurface
      ariaLabel={t('notesWorkspace.explorer.title', 'Files')}
      ref={explorerRef}
      className="notes-explorer"
      data-notes-explorer
    >
      <header>
        <span>{t('notesWorkspace.explorer.title', 'Files')}</span>
        <div>
          <IconButton
            label={t('notesWorkspace.navigation.back', 'Back')}
            disabled={!canNavBack}
            onClick={onNavBack}
          ><ArrowLeft size={15} /></IconButton>
          <IconButton
            label={t('notesWorkspace.navigation.forward', 'Forward')}
            disabled={!canNavForward}
            onClick={onNavForward}
          ><ArrowRight size={15} /></IconButton>
          <ExplorerOverflowMenu
            label={t('notes:chrome.create')}
            triggerText={t('notes:chrome.create')}
            actions={explorerCreateActions}
          />
          <ExplorerOverflowMenu
            label={t('notesWorkspace.explorer.moreActions', 'More actions')}
            actions={explorerTailActions}
          />
        </div>
      </header>
      <div className="notes-search">
        <MagnifyingGlass size={14} aria-hidden />
        <input
          ref={searchInputRef}
          className="notes-search-input"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKeyEvent(event)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (query) {
                onQueryChange('');
              } else {
                event.currentTarget.blur();
              }
              return;
            }
            if (event.key === 'ArrowDown') {
              if (treeItems.length > 0) {
                event.preventDefault();
                const firstId = treeItems[0].id;
                onSelectTreeItem(firstId);
                const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                  ? CSS.escape(firstId)
                  : firstId;
                const row = explorerRef.current?.querySelector<HTMLElement>(
                  `.notes-tree-host [role="treeitem"][data-nwt-id="${escaped}"]`,
                ) ?? explorerRef.current?.querySelector<HTMLElement>('.notes-tree-host [role="treeitem"]');
                row?.focus();
                return;
              }
              const firstAction = explorerRef.current?.querySelector<HTMLElement>('.notes-tree-host button');
              if (firstAction) {
                event.preventDefault();
                firstAction.focus();
              }
              return;
            }
            if (event.key === 'Enter' && query.trim() && filteredResources.length > 0) {
              event.preventDefault();
              onOpenSearchResult(filteredResources[0]);
            }
          }}
          placeholder={t('notesWorkspace.search.placeholder', 'Search files...')}
          aria-label={t('notesWorkspace.search.aria', 'Search files')}
        />
        {query.trim() && (
          <span
            className="shrink-0 text-2xs tabular-nums text-muted-foreground/70"
            data-testid="notes-search-match-count"
            aria-live="polite"
          >
            {t('notes:workspace.searchMatchCount', { count: filteredResources.length })}
          </span>
        )}
        {query && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="notes-icon-button h-6 w-6 shrink-0"
            aria-label={t('notesWorkspace.search.clear', 'Clear search')}
            title={t('notesWorkspace.search.clear', 'Clear search')}
            onClick={() => {
              onQueryChange('');
              searchInputRef.current?.focus();
            }}
          >
            <X size={12} />
          </DsButton>
        )}
        <DsButton
          variant="ghost"
          size="sm"
          className="notes-search-tag-btn"
          data-active={showTagFilter ? 'true' : undefined}
          aria-pressed={showTagFilter}
          aria-expanded={showTagFilter}
          aria-label={t('notesWorkspace.tagFilter.label')}
          title={t('notesWorkspace.tagFilter.label')}
          onClick={() => setTagFilterOpen((open) => !open)}
        >
          <Tag size={13} aria-hidden />
          {selectedTags.length > 0 && (
            <span className="notes-search-tag-count">{selectedTags.length}</span>
          )}
        </DsButton>
      </div>
      {showTagFilter && (
        <TagFilter
          selectedTags={selectedTags}
          onChange={onSelectedTagsChange}
          open={showTagFilter}
          onOpenChange={(next) => {
            if (!next && selectedTags.length === 0) setTagFilterOpen(false);
          }}
          className="notes-explorer-tag-filter"
        />
      )}
      {/* Notion 式：收藏区与灵感区只在有内容时出现，不白占页面树的纵向空间 */}
      {favorites.items.length > 0 && (
        <FavoritesSection
          items={favorites.items}
          activeId={activeTabId}
          onOpen={(item) => {
            void onOpenResource({ type: item.type, id: item.id }, item.name);
            onCloseExplorerIfCompact();
          }}
          onUnfavorite={(item) => {
            void favorites.setFavorite(item.id, item.type, false, { path: item.path, name: item.name });
          }}
        />
      )}
      <InsightsSection createRequestNonce={insightCreateNonce} />
      {resourceDialog?.mode === 'create-folder' && (
        <div className="notes-inline-create ui-rise-in" data-notes-inline-create>
          <div className="notes-inline-create-row">
            <FolderPlus size={14} aria-hidden />
            <input
              autoFocus
              value={resourceDialog.value}
              placeholder={t('notesWorkspace.dialog.createFolderTitle', 'New folder')}
              aria-label={t('notesWorkspace.dialog.createFolderTitle', 'New folder')}
              onChange={(event) => {
                onDialogErrorChange(null);
                onResourceDialogChange({
                  mode: 'create-folder',
                  // 输入侧就地清洗：粘贴内容折叠换行、去控制字符、按 500 字符截断
                  //（与后端 note_repo validate_title 限额一致）
                  value: sanitizeNoteTitleInput(event.target.value),
                  parentId: resourceDialog.parentId,
                });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  onDialogErrorChange(null);
                  onResourceDialogChange(null);
                  return;
                }
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                onCreateFolderSubmit();
              }}
              onCompositionStart={() => { createFolderComposingRef.current = true; }}
              onCompositionEnd={() => { createFolderComposingRef.current = false; }}
              onBlur={(event) => {
                // 失焦只在「还没输入任何内容」时视为取消。已有输入或 IME 合成中
                //（点候选词可能触发 blur）、以及焦点仍落在行内面板内部（计数器/
                // 错误提示）时保留输入行，避免误取消丢输入。
                if (createFolderComposingRef.current) return;
                if (
                  event.relatedTarget instanceof Node
                  && event.currentTarget.closest('[data-notes-inline-create]')?.contains(event.relatedTarget)
                ) return;
                if (resourceDialog.value.trim()) return;
                onDialogErrorChange(null);
                onResourceDialogChange(null);
              }}
            />
          </div>
          {countNoteInputChars(resourceDialog.value) > NOTE_TITLE_COUNT_WARN_THRESHOLD && (
            <p
              className="notes-inline-counter"
              data-at-limit={countNoteInputChars(resourceDialog.value) >= NOTE_TITLE_MAX_CHARS ? 'true' : undefined}
              aria-live="polite"
            >
              {t('notesWorkspace.validation.charCount', {
                defaultValue: '{{count}} / {{max}}',
                count: countNoteInputChars(resourceDialog.value),
                max: NOTE_TITLE_MAX_CHARS,
              })}
            </p>
          )}
          {dialogError && <p className="notes-inline-error" role="alert">{dialogError}</p>}
        </div>
      )}
      {(resourceDialog?.mode === 'delete' || resourceDialog?.mode === 'delete-many') && (
        <div
          className="notes-inline-confirm ui-rise-in"
          data-notes-inline-confirm
          role="group"
          aria-label={t('notesWorkspace.dialog.deleteTitle', 'Move to trash')}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onDialogErrorChange(null);
            onResourceDialogChange(null);
          }}
        >
          <p className="notes-inline-confirm-copy">
            {resourceDialog.mode === 'delete'
              ? t('notesWorkspace.dialog.deleteDescription', {
                defaultValue: 'Move "{{name}}" to the trash?',
                name: getExplorerTargetName(resourceDialog.target),
              })
              : t('notesWorkspace.dialog.deleteManyDescription', {
                defaultValue: 'Move {{count}} selected items to the trash?',
                count: resourceDialog.targets.length,
              })}
          </p>
          {dialogError && <p className="notes-inline-error" role="alert">{dialogError}</p>}
          <div className="notes-inline-confirm-actions">
            <button
              type="button"
              onClick={() => {
                onDialogErrorChange(null);
                onResourceDialogChange(null);
              }}
            >
              {t('notesWorkspace.dialog.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={() => {
                if (resourceDialog.mode === 'delete') onDeleteConfirm();
                else onDeleteManyConfirm();
              }}
            >
              {t('notesWorkspace.dialog.delete', 'Delete')}
            </button>
          </div>
        </div>
      )}
      <div className="notes-tree-host" aria-live="polite">
        {loading && !hasTreeItems ? (
              <div
                className="notes-tree"
                role="tree"
                aria-label={t('notesWorkspace.tree.aria')}
                aria-busy="true"
              >
                <div
                  className="nes-tree-skeleton notes-tree-loading"
                  aria-label={t('notesWorkspace.tree.loading', 'Loading files')}
                >
                  {TREE_SKELETON_ROWS.map((row, index) => (
                    <div
                      key={index}
                      className="nes-tree-skeleton__row"
                      style={{ '--nes-indent': row.indent } as React.CSSProperties}
                    >
                      <i
                        className="nes-tree-skeleton__bar"
                        style={{ '--nes-bar-w': row.width } as React.CSSProperties}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : loadError && !hasTreeItems ? (
              <div
                className="notes-tree"
                role="tree"
                aria-label={t('notesWorkspace.tree.aria')}
                aria-busy="false"
              >
                <div className="notes-tree-message" data-state="error">
                  <span>{t('notesWorkspace.tree.loadFailed', 'Could not load files')}</span>
                  <button type="button" onClick={onRetryLoad}>{t('notesWorkspace.tree.retry', 'Retry')}</button>
                </div>
              </div>
            ) : !hasTreeItems ? (
              <div
                className="notes-tree"
                role="tree"
                aria-label={t('notesWorkspace.tree.aria')}
                aria-busy="false"
              >
                <div className="nes-tree-empty notes-tree-message" data-state="empty">
                  {query || selectedTags.length > 0 ? (
                    <>
                      <p className="nes-tree-empty__message">
                        {t('notesWorkspace.tree.noMatches', {
                          defaultValue: 'No files match "{{query}}"',
                          query: query || selectedTags.join(', '),
                        })}
                      </p>
                      <DsButton
                        variant="outline"
                        size="sm"
                        className="nes-action"
                        onClick={() => {
                          onQueryChange('');
                          onSelectedTagsChange([]);
                          searchInputRef.current?.focus();
                        }}
                      >
                        {t('notesWorkspace.tree.showAll', 'Show all files')}
                      </DsButton>
                    </>
                  ) : (
                    <>
                      <div className="nes-tree-empty__icon" aria-hidden>
                        <Notebook size={32} weight="thin" />
                      </div>
                      <p className="nes-tree-empty__title">
                        {t('workbench:notesWorkspace.empty.treeTitle')}
                      </p>
                      <div className="nes-tree-empty__actions">
                        <button
                          type="button"
                          className="nes-action"
                          onClick={() => onCreateResource('note')}
                        >
                          <FileText size={13} aria-hidden />
                          {t('workbench:notesWorkspace.empty.treeNewNote')}
                        </button>
                        <button
                          type="button"
                          className="nes-action nes-action--ghost"
                          onClick={() => {
                            onDialogErrorChange(null);
                            onResourceDialogChange({ mode: 'create-folder', value: '', parentId: selectedFolderId });
                          }}
                        >
                          <FolderPlus size={13} aria-hidden />
                          {t('workbench:notesWorkspace.empty.treeNewFolder')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <NotesWorkspaceTree
                items={[...treeItems]}
                expandedIds={expandedIds}
                selectedId={selectedTreeId ?? selectedFolderId}
                activeId={activeTabId}
                showRoot={false}
                aria-busy={loading}
                rootLabel={t('notesWorkspace.tree.root')}
                onToggleExpand={onToggleTreeExpand}
                onExpand={onExpandTreeFolder}
                onSelect={onSelectTreeItem}
                onOpen={onOpenTreeItem}
                onMove={onMoveTreeItem}
                onRename={onRenameTreeItem}
                onDelete={onRequestDeleteTreeItem}
                onDeleteMany={onRequestDeleteTreeItems}
                getMenuItems={getTreeMenuItems}
              />
            )}
      </div>
    </WorkbenchSidebarSurface>
  );
};
