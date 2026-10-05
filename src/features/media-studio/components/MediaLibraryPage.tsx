/**
 * 音视频库页：导入 · 搜索 · 筛选（全部 / 在看 / 未转写 / 已转写）· 最近活动排序 · 行操作。
 *
 * 版式对齐技能管理页（study-shell 工具条 + 搜索 + 分段筛选 + 卡片列表 + 空态）；
 * 经典壳桌面把标题行与导入按钮放进顶栏（DesktopShellHeaderPortal），学习桌面窗口 /
 * 手机则在页内。手机导入按钮固定在底部（单手可达），筛选条可横向滚动。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChatCircleText,
  CircleNotch,
  FilmStrip,
  MagnifyingGlass,
  Notebook,
  Subtitles,
  Television,
  UploadSimple,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { FILE_TYPES, UnifiedDragDropZone } from '@/components/shared/UnifiedDragDropZone';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  TITLEBAR_CONTROL_CLASS,
  TITLEBAR_META_CLASS,
  TITLEBAR_TITLE_CLASS,
} from '@/app/shell/titlebarUiTokens';
import { dstu } from '@/dstu';
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
  countByFilter,
  MEDIA_LIBRARY_FILTERS,
  selectLibraryItems,
  type MediaLibraryFilter,
} from '../libraryModel';
import { mediaFileAccept } from '../importMedia';
import type { MediaLibraryState } from '../useMediaLibrary';
import type { MediaImportController } from '../useMediaImport';
import { MediaLibraryRow, type MediaRowAction } from './MediaLibraryRow';

/** 媒体文件大：拖放上限与导入上限（4 GB，见设计契约 §4）一致 */
const MAX_MEDIA_FILE_SIZE = 4 * 1024 * 1024 * 1024;

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
  const { items, loaded, error, refresh, removeLocal } = library;

  const counts = useMemo(() => countByFilter(items), [items]);
  const visible = useMemo(() => selectLibraryItems(items, filter, query), [items, filter, query]);
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
          {bilibiliButton(inTitlebar)}
          {importButton(inTitlebar)}
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
              <div className={cn('relative flex-1', !isSmallScreen && 'max-w-xs')}>
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
              <ul className="flex flex-col gap-2" aria-label={t('mediaStudio:listLabel')}>
                {visible.map((item) => (
                  <MediaLibraryRow key={item.id} item={item} now={now} onOpen={onOpen} onAction={handleAction} />
                ))}
              </ul>
            )}
          </div>
        </CustomScrollArea>
      </UnifiedDragDropZone>

      {isSmallScreen ? (
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
    </div>
  );
};

export default MediaLibraryPage;
