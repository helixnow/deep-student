/**
 * 音视频库页：导入 · 搜索 · 筛选（全部 / 在看 / 未转写 / 已转写）· 最近活动排序 · 行操作。
 *
 * 版式对齐技能管理页（study-shell 工具条 + 搜索 + 分段筛选 + 卡片列表 + 空态）；
 * 经典壳桌面把标题行与导入按钮放进顶栏（DesktopShellHeaderPortal），学习桌面窗口 /
 * 手机则在页内。手机导入按钮固定在底部（单手可达），筛选条可横向滚动。
 *
 * 多选：「选择」进入（触屏长按某行也会进入并勾选该行），操作条显示已选数 · 全选（只作用于
 * 筛选 + 搜索后可见的条目）· 移动到分组 · 删除 · 完成；Esc 退出。手机操作条替换底部导入条。
 * 分组：分组即媒体所在的 VFS 文件夹（与资源库一致），「按分组」视图把列表折成可收起的分区，
 * 根目录文件归「未分组」放最后；视图与收起状态记在 localStorage。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  CaretRight,
  ChatCircleText,
  Check,
  CheckSquare,
  CircleNotch,
  FilmStrip,
  FolderSimple,
  FolderSimpleMinus,
  FolderSimplePlus,
  Folders,
  ListBullets,
  MagnifyingGlass,
  Minus,
  Notebook,
  Subtitles,
  Television,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuLabel,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { FILE_TYPES, UnifiedDragDropZone } from '@/components/shared/UnifiedDragDropZone';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  TITLEBAR_CONTROL_CLASS,
  TITLEBAR_META_CLASS,
  TITLEBAR_TITLE_CLASS,
} from '@/app/shell/titlebarUiTokens';
import { dstu, folderApi } from '@/dstu';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { updatePathCacheV2 } from '@/features/chat/context/vfsRefApi';
import { fileManager } from '@/utils/fileManager';
import { getErrorMessage } from '@/utils/errorUtils';
import { mediaTranscriptApi } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import {
  BilibiliLinkDialog,
  summarizeBilibiliBatch,
  type BilibiliLinkDialogMode,
  type BilibiliLinkDialogResult,
} from '@/features/learning-hub/apps/views/media/BilibiliLinkDialog';
import {
  bilibiliLinkApi,
  stripBilibiliExtension,
} from '@/features/learning-hub/apps/views/media/bilibiliLinkApi';
import type { MediaLibraryItem } from '../api';
import {
  commonTitlePrefix,
  countByFilter,
  groupLibraryItems,
  listMediaFolders,
  MEDIA_LIBRARY_FILTERS,
  selectAllState,
  selectedVisibleItems,
  selectLibraryItems,
  toggleSelectAll,
  type MediaLibraryFilter,
  type MediaLibraryGroup,
  type SelectAllState,
} from '../libraryModel';
import { mediaFileAccept } from '../importMedia';
import type { MediaLibraryState } from '../useMediaLibrary';
import type { MediaImportController } from '../useMediaImport';
import { MediaLibraryRow, type MediaRowAction } from './MediaLibraryRow';

/** 媒体文件大：拖放上限与导入上限（4 GB，见设计契约 §4）一致 */
const MAX_MEDIA_FILE_SIZE = 4 * 1024 * 1024 * 1024;

export type MediaLibraryViewMode = 'list' | 'grouped';

export const MEDIA_LIBRARY_VIEW_KEY = 'mediaStudio.library.view';
export const MEDIA_LIBRARY_COLLAPSED_KEY = 'mediaStudio.library.collapsedGroups';
/** 「未分组」分区的收起状态键（文件夹 id 以 fld_ 开头，不会撞） */
const UNGROUPED_KEY = '__ungrouped__';

const groupKey = (group: MediaLibraryGroup) => group.folderId ?? UNGROUPED_KEY;

function readViewMode(): MediaLibraryViewMode {
  try {
    return window.localStorage.getItem(MEDIA_LIBRARY_VIEW_KEY) === 'grouped' ? 'grouped' : 'list';
  } catch {
    return 'list';
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(MEDIA_LIBRARY_COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 存储被禁：只是不记住 */
  }
}

/** 勾选框外观（分组头整块是按钮，不能嵌套 Radix Checkbox 按钮） */
const SelectMark: React.FC<{ state: SelectAllState }> = ({ state }) => (
  <span
    aria-hidden="true"
    className={cn(
      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors',
      state === 'none' ? 'border-border bg-transparent' : 'border-primary bg-primary text-primary-foreground',
    )}
  >
    {state === 'all' ? <Check size={12} weight="bold" /> : state === 'some' ? <Minus size={12} weight="bold" /> : null}
  </span>
);

interface BatchOutcome {
  done: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface MediaLibraryPageProps {
  library: MediaLibraryState;
  importer: MediaImportController;
  onOpen: (item: MediaLibraryItem) => void;
  /** 打开刚从 B 站链接导入的条目（列表里可能还没有它） */
  onOpenId?: (id: string) => void;
  isSmallScreen: boolean;
  /** 经典壳桌面顶栏槽位；null 时标题行在页内 */
  titlebarTarget: HTMLElement | null;
}

export const MediaLibraryPage: React.FC<MediaLibraryPageProps> = ({
  library,
  importer,
  onOpen,
  onOpenId,
  isSmallScreen,
  titlebarTarget,
}) => {
  const { t, i18n } = useTranslation(['mediaStudio', 'learningHub', 'common']);
  const [filter, setFilter] = useState<MediaLibraryFilter>('all');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ item: MediaLibraryItem; name: string } | null>(null);
  const [deleting, setDeleting] = useState<MediaLibraryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [bilibiliMode, setBilibiliMode] = useState<BilibiliLinkDialogMode | null>(null);
  const [viewMode, setViewModeState] = useState<MediaLibraryViewMode>(readViewMode);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [newGroup, setNewGroup] = useState<{ name: string } | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const { items, loaded, error, refresh, removeLocal } = library;

  const counts = useMemo(() => countByFilter(items), [items]);
  const visible = useMemo(() => selectLibraryItems(items, filter, query), [items, filter, query]);
  const groups = useMemo(() => (viewMode === 'grouped' ? groupLibraryItems(visible) : []), [viewMode, visible]);
  const folders = useMemo(() => listMediaFolders(items), [items]);
  // 批量操作只作用于「选中且可见」的条目：筛选 / 搜索隐藏的已选项不会被误删或误移
  const selectedItems = useMemo(() => selectedVisibleItems(visible, selected), [visible, selected]);
  const allState = selectAllState(visible, selected);
  // 相对时间以渲染时刻为基准；列表随事件刷新时一起更新
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [items]);

  // ---------------------------------------------------------------- 行操作
  const handleAction = useCallback((item: MediaLibraryItem, action: MediaRowAction) => {
    switch (action.type) {
      case 'rename':
        setRenaming({ item, name: item.name });
        return;
      case 'delete':
        setDeleting(item);
        return;
      case 'reveal':
        window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
          detail: { view: 'learning-hub', openResource: `/${item.id}` },
        }));
        return;
      case 'importSubtitle':
        void (async () => {
          try {
            const path = await fileManager.pickSingleFile({
              filters: [{ name: t('learningHub:mediaTranscript.importFilterName'), extensions: ['srt', 'vtt', 'json'] }],
            });
            if (!path) return;
            const result = await mediaTranscriptApi.importFile(item.id, path);
            const count = result.segments.filter((s) => s.status === 'done').length;
            showGlobalNotification('success', t('learningHub:mediaTranscript.importSuccess', { count }));
            void refresh();
          } catch (err: unknown) {
            showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaTranscript.importFailed'));
          }
        })();
        return;
      case 'bilibiliSubtitle':
        if (!item.isLink) {
          setBilibiliMode({ kind: 'attach', resourceId: item.id, name: item.name });
          return;
        }
        void (async () => {
          try {
            const link = await bilibiliLinkApi.getLink(item.id);
            setBilibiliMode({
              kind: 'refetch',
              resourceId: item.id,
              name: stripBilibiliExtension(item.name),
              url: link.url,
              page: link.page,
            });
          } catch (err: unknown) {
            showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaBilibili.loadFailed'));
          }
        })();
        return;
      case 'exportSubtitle':
        void (async () => {
          try {
            const base = item.name.replace(/\.[^.]+$/, '') || 'transcript';
            const dest = await fileManager.pickSavePath({
              defaultFileName: `${base}.${action.format}`,
              filters: [{ name: action.format.toUpperCase(), extensions: [action.format] }],
            });
            if (!dest) return;
            await mediaTranscriptApi.exportFile(item.id, action.format, dest);
            showGlobalNotification('success', t('learningHub:mediaTranscript.exportSuccess'));
          } catch (err: unknown) {
            showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaTranscript.exportFailed'));
          }
        })();
        return;
    }
  }, [refresh, t]);

  const confirmRename = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name || name === renaming.item.name) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    const result = await dstu.rename(`/${renaming.item.id}`, name);
    setBusy(false);
    if (!result.ok) {
      showGlobalNotification('error', result.error.toUserMessage(), t('mediaStudio:row.renameFailed'));
      return;
    }
    setRenaming(null);
    void refresh();
  }, [renaming, refresh, t]);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setBusy(true);
    const result = await dstu.delete(`/${deleting.id}`);
    setBusy(false);
    if (!result.ok) {
      showGlobalNotification('error', result.error.toUserMessage(), t('mediaStudio:row.deleteFailed'));
      return;
    }
    removeLocal(deleting.id);
    showGlobalNotification('success', t('mediaStudio:row.deleted', { name: deleting.name }));
    setDeleting(null);
  }, [deleting, removeLocal, t]);

  // ---------------------------------------------------------------- 视图 / 分组
  const setViewMode = useCallback((mode: MediaLibraryViewMode) => {
    setViewModeState(mode);
    writeStored(MEDIA_LIBRARY_VIEW_KEY, mode);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeStored(MEDIA_LIBRARY_COLLAPSED_KEY, JSON.stringify([...next].sort()));
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- 多选
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggleItem = useCallback((item: MediaLibraryItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const enterSelectWith = useCallback((item: MediaLibraryItem) => {
    setSelectMode(true);
    setSelected((prev) => new Set(prev).add(item.id));
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => toggleSelectAll(visible, prev));
  }, [visible]);

  const toggleGroupSelection = useCallback((group: MediaLibraryGroup) => {
    setSelected((prev) => toggleSelectAll(group.items, prev));
  }, []);

  const dialogOpen = renaming !== null || deleting !== null || bilibiliMode !== null || batchDeleting || newGroup !== null;

  const handleSelectKeys = useCallback((event: Event) => {
    if (!selectMode || dialogOpen || !(event instanceof KeyboardEvent)) return;
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      // 打开着的菜单（移动到分组 / 行菜单）先吃掉这次 Esc
      if (document.querySelector('[role="menu"]')) return;
      event.preventDefault();
      exitSelect();
      return;
    }
    const typing = event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]');
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelected((prev) => {
        const next = new Set(prev);
        for (const item of visible) next.add(item.id);
        return next;
      });
    }
  }, [selectMode, dialogOpen, exitSelect, visible]);
  useEventRegistry([
    { target: 'window', type: 'keydown', listener: handleSelectKeys },
  ], [handleSelectKeys]);

  /** 批量结束：全部成功退出多选；有失败只留下失败的条目继续选中 */
  const finishBatch = useCallback((outcome: BatchOutcome) => {
    if (outcome.failed.length === 0) {
      exitSelect();
    } else {
      setSelected(new Set(outcome.failed.map((f) => f.id)));
    }
  }, [exitSelect]);

  const confirmBatchDelete = useCallback(async () => {
    const targets = selectedItems;
    if (targets.length === 0) return;
    setBatchBusy(true);
    const outcome: BatchOutcome = { done: [], failed: [] };
    // 逐个删除：与单行删除同一条 dstu 软删路径，失败不影响其余条目
    for (const item of targets) {
      const result = await dstu.delete(`/${item.id}`);
      if (result.ok) {
        outcome.done.push(item.id);
        removeLocal(item.id);
      } else {
        outcome.failed.push({ id: item.id, error: result.error.toUserMessage() });
      }
    }
    setBatchBusy(false);
    setBatchDeleting(false);
    if (outcome.failed.length === 0) {
      showGlobalNotification('success', t('mediaStudio:select.deleted', { count: outcome.done.length }));
    } else {
      showGlobalNotification(
        outcome.done.length > 0 ? 'warning' : 'error',
        outcome.failed[0].error,
        t('mediaStudio:select.deletePartial', { done: outcome.done.length, failed: outcome.failed.length }),
      );
    }
    finishBatch(outcome);
  }, [finishBatch, removeLocal, selectedItems, t]);

  const moveSelected = useCallback(async (folderId: string | null, folderName: string) => {
    // 已在目标分组里的条目跳过
    const targets = selectedItems.filter((item) => (item.folderId ?? null) !== folderId);
    if (targets.length === 0) {
      exitSelect();
      return;
    }
    setBatchBusy(true);
    const outcome: BatchOutcome = { done: [], failed: [] };
    for (const item of targets) {
      // 与资源库批量移动同一接口；目标文件夹的路径缓存在最后统一刷新
      const result = await folderApi.moveItem('file', item.id, folderId ?? undefined, { skipCacheRefresh: true });
      if (result.ok) outcome.done.push(item.id);
      else outcome.failed.push({ id: item.id, error: result.error.toUserMessage() });
    }
    if (folderId && outcome.done.length > 0) await updatePathCacheV2(folderId);
    setBatchBusy(false);
    if (outcome.failed.length === 0) {
      showGlobalNotification(
        'success',
        folderId
          ? t('mediaStudio:select.moved', { count: outcome.done.length, name: folderName })
          : t('mediaStudio:select.movedOut', { count: outcome.done.length }),
      );
    } else {
      showGlobalNotification(
        outcome.done.length > 0 ? 'warning' : 'error',
        outcome.failed[0].error,
        t('mediaStudio:select.movePartial', { done: outcome.done.length, failed: outcome.failed.length }),
      );
    }
    finishBatch(outcome);
    void refresh();
  }, [exitSelect, finishBatch, refresh, selectedItems, t]);

  const openNewGroup = useCallback(() => {
    const names = selectedItems.map((item) => (item.isLink ? stripBilibiliExtension(item.name) : item.name));
    setNewGroup({ name: commonTitlePrefix(names) });
  }, [selectedItems]);

  const confirmNewGroup = useCallback(async () => {
    const name = newGroup?.name.trim();
    if (!name || batchBusy) return;
    setBatchBusy(true);
    const created = await folderApi.createFolder(name);
    setBatchBusy(false);
    if (!created.ok) {
      showGlobalNotification('error', created.error.toUserMessage(), t('mediaStudio:group.createFailed'));
      return;
    }
    setNewGroup(null);
    await moveSelected(created.value.id, created.value.title || name);
  }, [batchBusy, moveSelected, newGroup, t]);

  const handleBilibiliDone = useCallback((result: BilibiliLinkDialogResult) => {
    const mode = bilibiliMode;
    void refresh();
    if (result.batch) {
      const { batch } = result;
      showGlobalNotification(
        batch.failed.length > 0 || batch.remaining > 0 ? 'warning' : 'success',
        summarizeBilibiliBatch(batch, t, i18n.resolvedLanguage ?? i18n.language),
      );
      return;
    }
    if (mode?.kind === 'create') {
      const name = stripBilibiliExtension(result.name);
      showGlobalNotification(
        'success',
        result.created
          ? t('learningHub:mediaBilibili.created', { name, count: result.segments })
          : t('learningHub:mediaBilibili.updated', { name, count: result.segments }),
      );
      onOpenId?.(result.fileId);
      return;
    }
    showGlobalNotification('success', t('learningHub:mediaBilibili.attached', { count: result.segments }));
  }, [bilibiliMode, i18n.language, i18n.resolvedLanguage, onOpenId, refresh, t]);

  // ---------------------------------------------------------------- 导入
  const onFilesDropped = useCallback((files: File[]) => {
    void importer.importSources(files.map((file) => ({ kind: 'file' as const, file })));
  }, [importer]);
  const onPathsDropped = useCallback((paths: string[]) => {
    void importer.importSources(paths.map((path) => ({ kind: 'path' as const, path })));
  }, [importer]);

  const importButton = (inTitlebar: boolean) => (
    <DsButton
      variant={inTitlebar ? 'shell' : 'primary'}
      size="sm"
      onClick={importer.pick}
      disabled={importer.importing}
      data-media-import=""
      className={inTitlebar
        ? cn(TITLEBAR_CONTROL_CLASS, 'border-transparent bg-[color:var(--button-tonal-bg)]')
        : 'gap-1.5'}
    >
      {importer.importing
        ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <UploadSimple size={14} aria-hidden="true" />}
      {t('mediaStudio:import.button')}
    </DsButton>
  );

  const bilibiliButton = (inTitlebar: boolean) => (
    <DsButton
      variant={inTitlebar ? 'shell' : 'ghost'}
      size="sm"
      onClick={() => setBilibiliMode({ kind: 'create' })}
      data-media-bilibili=""
      className={inTitlebar ? TITLEBAR_CONTROL_CLASS : 'gap-1.5'}
    >
      <Television size={14} aria-hidden="true" />
      {t('mediaStudio:import.bilibili')}
    </DsButton>
  );

  const selectToggle = (variant: 'titlebar' | 'page' | 'phone') => (
    <DsButton
      variant={variant === 'titlebar' ? 'shell' : 'ghost'}
      size={variant === 'phone' ? 'md' : 'sm'}
      iconOnly={variant === 'phone'}
      onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
      aria-pressed={selectMode}
      aria-label={variant === 'phone' ? t('mediaStudio:select.toggle') : undefined}
      title={t('mediaStudio:select.toggle')}
      data-media-select-toggle=""
      className={cn(
        variant === 'titlebar' ? TITLEBAR_CONTROL_CLASS : variant === 'page' ? 'gap-1.5' : 'shrink-0',
        selectMode && 'bg-primary/10 text-primary hover:bg-primary/15',
      )}
    >
      <CheckSquare size={variant === 'phone' ? 18 : 14} aria-hidden="true" />
      {variant === 'phone' ? null : t('mediaStudio:select.toggle')}
    </DsButton>
  );

  const headerRow = (inTitlebar: boolean) => (
    <div className={cn('flex min-w-0 items-center justify-between gap-3', inTitlebar && 'pointer-events-auto h-full flex-1')}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(inTitlebar ? TITLEBAR_TITLE_CLASS : 'truncate text-base font-semibold text-foreground', 'shrink-0')}>
          {t('mediaStudio:title')}
        </span>
        {loaded && items.length > 0 ? (
          <>
            <span className="text-muted-foreground/40">/</span>
            <span className={inTitlebar ? TITLEBAR_META_CLASS : 'text-xs text-muted-foreground'}>
              {t('mediaStudio:count', { count: items.length })}
            </span>
          </>
        ) : null}
      </div>
      {!isSmallScreen ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {items.length > 0 ? selectToggle(inTitlebar ? 'titlebar' : 'page') : null}
          {/* 库为空时空态里已经有这两个按钮（更醒目），标题行不再重复；加载失败时空态不出现，仍放在这里 */}
          {items.length > 0 || error ? (
            <>
              {bilibiliButton(inTitlebar)}
              {importButton(inTitlebar)}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const filterOptions = MEDIA_LIBRARY_FILTERS.map((value) => ({
    value,
    label: (
      <>
        <span>{t(`mediaStudio:filter.${value}`)}</span>
        <span className={cn('ml-1 text-2xs tabular-nums opacity-60', filter === value && 'opacity-100')}>
          {counts[value]}
        </span>
      </>
    ),
  }));

  const viewOptions = ([
    ['list', ListBullets],
    ['grouped', Folders],
  ] as const).map(([value, Icon]) => ({
    value,
    ariaLabel: t(`mediaStudio:view.${value}`),
    title: t(`mediaStudio:view.${value}`),
    label: <Icon size={isSmallScreen ? 18 : 15} aria-hidden="true" />,
  }));

  const viewToggle = (
    <SegmentedControl<MediaLibraryViewMode>
      ariaLabel={t('mediaStudio:view.aria')}
      value={viewMode}
      onValueChange={setViewMode}
      options={viewOptions}
      size="compact"
      className="shrink-0 [&_.study-shell-segmented-thumb]:border-transparent"
      itemClassName={isSmallScreen ? '!h-auto !min-h-11 !min-w-11 !px-3' : '!h-auto !px-2 !py-1'}
    />
  );

  const selectedCount = selectedItems.length;
  const canMoveOut = selectedItems.some((item) => item.folderId);

  const moveMenu = (phone: boolean) => (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton
          variant="ghost"
          size={phone ? 'md' : 'sm'}
          disabled={selectedCount === 0 || batchBusy}
          data-media-select-move=""
          className={cn('gap-1.5', phone && 'flex-1')}
        >
          <FolderSimple size={phone ? 16 : 14} aria-hidden="true" />
          {t('mediaStudio:select.move')}
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align={phone ? 'start' : 'end'} width={240} aria-label={t('mediaStudio:group.pickerLabel')}>
        {folders.length > 0 ? (
          <>
            <AppMenuLabel>{t('mediaStudio:group.existing')}</AppMenuLabel>
            {folders.map((folder) => (
              <AppMenuItem
                key={folder.id}
                icon={<FolderSimple size={15} aria-hidden="true" />}
                onClick={() => void moveSelected(folder.id, folder.label)}
                data-media-move-target={folder.id}
              >
                <span className="truncate">{folder.label}</span>
              </AppMenuItem>
            ))}
            <AppMenuSeparator />
          </>
        ) : null}
        <AppMenuItem icon={<FolderSimplePlus size={15} aria-hidden="true" />} onClick={openNewGroup}>
          {t('mediaStudio:group.new')}
        </AppMenuItem>
        <AppMenuItem
          icon={<FolderSimpleMinus size={15} aria-hidden="true" />}
          disabled={!canMoveOut}
          onClick={() => void moveSelected(null, '')}
        >
          {t('mediaStudio:group.moveOut')}
        </AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  );

  const selectCount = (
    <span className="min-w-0 truncate text-xs font-medium text-foreground tabular-nums" aria-live="polite" data-media-select-count="">
      {t('mediaStudio:select.count', { count: selectedCount })}
    </span>
  );

  const selectAllButton = (phone: boolean) => (
    <DsButton
      variant="ghost"
      size={phone ? 'md' : 'sm'}
      onClick={toggleAll}
      disabled={visible.length === 0}
      data-media-select-all={allState}
      className="shrink-0"
    >
      {allState === 'all' ? t('mediaStudio:select.deselectAll') : t('mediaStudio:select.selectAll')}
    </DsButton>
  );

  const deleteSelectedButton = (phone: boolean) => (
    <DsButton
      variant="ghost"
      size={phone ? 'md' : 'sm'}
      disabled={selectedCount === 0 || batchBusy}
      onClick={() => setBatchDeleting(true)}
      data-media-select-delete=""
      className={cn('gap-1.5 text-danger hover:text-danger', phone && 'flex-1')}
    >
      <Trash size={phone ? 16 : 14} aria-hidden="true" />
      {t('mediaStudio:select.delete')}
    </DsButton>
  );

  const doneButton = (phone: boolean) => (
    <DsButton variant="primary" size={phone ? 'md' : 'sm'} onClick={exitSelect} data-media-select-done="" className="shrink-0">
      {t('mediaStudio:select.done')}
    </DsButton>
  );

  const renderRow = (item: MediaLibraryItem) => (
    <MediaLibraryRow
      key={item.id}
      item={item}
      now={now}
      onOpen={onOpen}
      onAction={handleAction}
      selectMode={selectMode}
      selected={selected.has(item.id)}
      onToggleSelect={toggleItem}
      onLongPressSelect={selectMode ? undefined : enterSelectWith}
      hideFolder={viewMode === 'grouped'}
    />
  );

  const groupedList = (
    <div className="flex flex-col gap-4" data-media-groups="">
      {groups.map((group) => {
        const key = groupKey(group);
        const name = group.folderId ? group.label : t('mediaStudio:group.ungrouped');
        const isCollapsed = collapsed.has(key);
        const groupState = selectAllState(group.items, selected);
        const listId = `media-group-${key}`;
        return (
          <section key={key} data-media-group={key} aria-label={name}>
            <div className="mb-2 flex min-w-0 items-center gap-1">
              {selectMode ? (
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  role="checkbox"
                  aria-checked={groupState === 'all' ? true : groupState === 'some' ? 'mixed' : false}
                  aria-label={t('mediaStudio:select.group', { name })}
                  onClick={() => toggleGroupSelection(group)}
                  className="!h-8 !w-8 shrink-0"
                >
                  <SelectMark state={groupState} />
                </DsButton>
              ) : null}
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => toggleCollapsed(key)}
                aria-expanded={!isCollapsed}
                aria-controls={listId}
                aria-label={t('mediaStudio:group.toggle', { name })}
                data-media-group-toggle={key}
                className="!h-auto min-h-8 min-w-0 flex-1 !justify-start gap-1.5 !px-1.5 text-left"
              >
                <CaretRight
                  size={12}
                  weight="bold"
                  aria-hidden="true"
                  className={cn('shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !isCollapsed && 'rotate-90')}
                />
                {group.folderId
                  ? <FolderSimple size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  : null}
                <span className="min-w-0 truncate text-xs font-semibold text-foreground">{name}</span>
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{group.items.length}</span>
              </DsButton>
            </div>
            {isCollapsed ? null : (
              <ul id={listId} className="flex flex-col gap-2" aria-label={name}>
                {group.items.map(renderRow)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );

  const progress = importer.progress;
  const importRow = importer.importing ? (
    <div
      className="study-shell-secondary-card mb-3 flex items-center gap-3 px-3 py-2.5 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
      data-media-import-progress=""
    >
      <CircleNotch size={16} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate">
          {progress
            ? t('mediaStudio:import.progress', { index: progress.index, total: progress.total, name: progress.name })
            : t('mediaStudio:import.preparing')}
        </span>
        {progress?.fraction != null ? (
          <span
            className="block h-1 w-full overflow-hidden rounded-full bg-[color:var(--surface-muted)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.fraction * 100)}
          >
            <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </span>
        ) : null}
      </div>
    </div>
  ) : null;

  const emptyState = (
    <div className="study-shell-empty-state" data-media-library-empty="">
      <div className="study-shell-empty-state__icon">
        <FilmStrip size={32} weight="duotone" className="text-muted-foreground/50" />
      </div>
      <p className="study-shell-empty-state__title">{t('mediaStudio:empty.title')}</p>
      <ul className="mt-3 flex max-w-md flex-col gap-2 text-left text-xs leading-relaxed text-muted-foreground">
        {([
          ['transcribe', Subtitles],
          ['ask', ChatCircleText],
          ['review', Notebook],
        ] as const).map(([key, Icon]) => (
          <li key={key} className="flex items-start gap-2">
            <Icon size={16} className="mt-px shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t(`mediaStudio:empty.${key}`)}</span>
          </li>
        ))}
      </ul>
      {!isSmallScreen ? (
        <div className="mt-4 flex items-center justify-center gap-2">
          {importButton(false)}
          {bilibiliButton(false)}
        </div>
      ) : null}
      <p className="study-shell-empty-state__description mt-3">{t('mediaStudio:empty.subtitleNote')}</p>
    </div>
  );

  const hasItems = items.length > 0;

  return (
    <div className="study-shell-page flex h-full min-h-0 min-w-0 flex-col" data-media-library="">
      {titlebarTarget ? createPortal(
        <div className="pointer-events-none flex h-full min-w-0 items-center px-2">{headerRow(true)}</div>,
        titlebarTarget,
      ) : null}

      {importer.usesFileInput ? (
        <input
          ref={importer.inputRef}
          type="file"
          multiple
          accept={mediaFileAccept()}
          onChange={importer.onInputChange}
          className="hidden"
          data-media-import-input=""
        />
      ) : null}

      <UnifiedDragDropZone
        zoneId="media-studio-library"
        onFilesDropped={onFilesDropped}
        onPathsDropped={onPathsDropped}
        enabled={!isSmallScreen && !importer.importing}
        acceptedFileTypes={[FILE_TYPES.AUDIO, FILE_TYPES.VIDEO]}
        maxFiles={20}
        maxFileSize={MAX_MEDIA_FILE_SIZE}
        customOverlayText={t('mediaStudio:import.dropHint')}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className={cn('study-shell-toolbar study-shell-toolbar--seamless shrink-0 space-y-3 px-5 pt-4 sm:px-8 lg:px-10', isSmallScreen && 'px-3 pt-3')}>
          {!titlebarTarget && !isSmallScreen ? headerRow(false) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">{t('mediaStudio:tagline')}</p>
          {hasItems ? (
            <div className={cn('flex items-center gap-3', isSmallScreen && 'flex-col items-stretch gap-2')}>
              <div className={cn('flex min-w-0 flex-1 items-center gap-2', !isSmallScreen && 'max-w-xs')}>
                <div className="relative min-w-0 flex-1">
                  <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" aria-hidden="true" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('mediaStudio:searchPlaceholder')}
                    aria-label={t('mediaStudio:searchPlaceholder')}
                    className={cn(
                      'border-transparent bg-[color:var(--surface-muted)] pl-8 pr-3',
                      isSmallScreen ? 'h-11 text-sm' : 'h-8 text-xs',
                    )}
                  />
                </div>
                {isSmallScreen ? viewToggle : null}
                {isSmallScreen ? selectToggle('phone') : null}
              </div>
              <SegmentedControl<MediaLibraryFilter>
                ariaLabel={t('mediaStudio:filter.aria')}
                value={filter}
                onValueChange={setFilter}
                options={filterOptions}
                size="compact"
                className={cn(
                  '!flex-nowrap overflow-x-auto scrollbar-none [&_.study-shell-segmented-thumb]:border-transparent',
                  isSmallScreen && '-mx-1 !w-auto px-1',
                )}
                itemClassName={isSmallScreen
                  ? '!h-auto !px-3 !py-2 text-sm font-medium whitespace-nowrap'
                  : '!h-auto !px-2.5 !py-1 text-xs font-medium whitespace-nowrap'}
              />
              {isSmallScreen ? null : <div className="ml-auto">{viewToggle}</div>}
            </div>
          ) : null}
          {selectMode && !isSmallScreen && hasItems ? (
            <div
              role="toolbar"
              aria-label={t('mediaStudio:select.barLabel')}
              className="study-shell-secondary-card flex items-center gap-2 px-3 py-1.5"
              data-media-select-bar=""
            >
              {selectCount}
              {selectAllButton(false)}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {batchBusy ? <CircleNotch size={14} className="animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" /> : null}
                {moveMenu(false)}
                {deleteSelectedButton(false)}
                {doneButton(false)}
              </div>
            </div>
          ) : null}
        </div>

        <CustomScrollArea
          className="min-h-0 flex-1"
          viewportClassName="pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))] sm:pb-6"
        >
          <div className={cn('px-5 pt-4 sm:px-8 lg:px-10', isSmallScreen && 'px-3 pt-3')}>
            {importRow}
            {error && !hasItems ? (
              <div className="study-shell-empty-state" role="alert">
                <p className="study-shell-empty-state__title">{t('mediaStudio:loadFailed')}</p>
                <p className="study-shell-empty-state__description break-words">{error}</p>
                <DsButton variant="ghost" size="sm" className="mt-3" onClick={() => void refresh()}>
                  {t('common:retry')}
                </DsButton>
              </div>
            ) : !loaded ? (
              <div className="flex justify-center py-12 text-muted-foreground" role="status" aria-label={t('common:loading')}>
                <CircleNotch size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              </div>
            ) : !hasItems ? (
              emptyState
            ) : visible.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground" data-media-library-no-match="">
                {query.trim() ? t('mediaStudio:noMatch') : t(`mediaStudio:filterEmpty.${filter}`)}
              </p>
            ) : (
              viewMode === 'grouped' ? groupedList : (
                <ul className="flex flex-col gap-2" aria-label={t('mediaStudio:listLabel')}>
                  {visible.map(renderRow)}
                </ul>
              )
            )}
          </div>
        </CustomScrollArea>
      </UnifiedDragDropZone>

      {isSmallScreen && selectMode && hasItems ? (
        // 手机多选：操作条替换底部导入条（单手可达）
        <div
          role="toolbar"
          aria-label={t('mediaStudio:select.barLabel')}
          className="study-shell-toolbar shrink-0 space-y-1.5 border-t px-3 pt-2"
          style={{ paddingBottom: 'calc(0.5rem + var(--mobile-safe-area-bottom, 0px))' }}
          data-media-select-bar=""
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{selectCount}</div>
            {selectAllButton(true)}
            {doneButton(true)}
          </div>
          <div className="flex items-center gap-2">
            {moveMenu(true)}
            {deleteSelectedButton(true)}
          </div>
        </div>
      ) : isSmallScreen ? (
        // 手机：导入固定在底部，单手可达
        <div
          className="study-shell-toolbar shrink-0 border-t px-3 pt-2"
          style={{ paddingBottom: 'calc(0.5rem + var(--mobile-safe-area-bottom, 0px))' }}
          data-media-import-bar=""
        >
          <div className="flex items-center gap-2">
            <DsButton
              variant="primary"
              onClick={importer.pick}
              disabled={importer.importing}
              data-media-import=""
              className="flex-1 gap-1.5"
            >
              {importer.importing
                ? <CircleNotch size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <UploadSimple size={16} aria-hidden="true" />}
              {t('mediaStudio:import.button')}
            </DsButton>
            <DsButton
              variant="ghost"
              onClick={() => setBilibiliMode({ kind: 'create' })}
              data-media-bilibili=""
              className="shrink-0 gap-1.5"
            >
              <Television size={16} aria-hidden="true" />
              {t('mediaStudio:import.bilibili')}
            </DsButton>
          </div>
        </div>
      ) : null}

      <DsAlertDialog
        open={renaming !== null}
        onOpenChange={(open) => { if (!open) setRenaming(null); }}
        title={t('mediaStudio:row.rename')}
        confirmText={t('common:save')}
        confirmVariant="primary"
        onConfirm={() => void confirmRename()}
        loading={busy}
        disabled={!renaming?.name.trim()}
      >
        <Input
          autoFocus
          value={renaming?.name ?? ''}
          onChange={(event) => setRenaming((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void confirmRename();
          }}
          aria-label={t('mediaStudio:row.rename')}
          className="h-9 text-sm"
        />
      </DsAlertDialog>

      <BilibiliLinkDialog
        open={bilibiliMode !== null}
        mode={bilibiliMode ?? { kind: 'create' }}
        onOpenChange={(open) => { if (!open) setBilibiliMode(null); }}
        onDone={handleBilibiliDone}
      />

      <DsAlertDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t('mediaStudio:row.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('mediaStudio:row.deleteDesc')}
        confirmText={t('mediaStudio:row.delete')}
        onConfirm={() => void confirmDelete()}
        loading={busy}
      />

      <DsAlertDialog
        open={batchDeleting}
        onOpenChange={(open) => { if (!open && !batchBusy) setBatchDeleting(false); }}
        title={t('mediaStudio:select.deleteTitle', { count: selectedCount })}
        description={t('mediaStudio:row.deleteDesc')}
        confirmText={t('mediaStudio:row.delete')}
        onConfirm={() => void confirmBatchDelete()}
        loading={batchBusy}
        disabled={selectedCount === 0}
      />

      <DsAlertDialog
        open={newGroup !== null}
        onOpenChange={(open) => { if (!open && !batchBusy) setNewGroup(null); }}
        title={t('mediaStudio:group.newTitle')}
        description={t('mediaStudio:group.newHint', { count: selectedCount })}
        confirmText={t('mediaStudio:group.create')}
        confirmVariant="primary"
        onConfirm={() => void confirmNewGroup()}
        loading={batchBusy}
        disabled={!newGroup?.name.trim()}
      >
        <Input
          autoFocus
          value={newGroup?.name ?? ''}
          onChange={(event) => setNewGroup((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void confirmNewGroup();
          }}
          placeholder={t('mediaStudio:group.namePlaceholder')}
          aria-label={t('mediaStudio:group.namePlaceholder')}
          className="h-9 text-sm"
          data-media-new-group-name=""
        />
      </DsAlertDialog>
    </div>
  );
};

export default MediaLibraryPage;
