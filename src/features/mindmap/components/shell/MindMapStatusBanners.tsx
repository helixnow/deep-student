import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  CircleNotch,
  Download,
  FloppyDisk,
  Info,
  MagnifyingGlass,
  Upload,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { Input } from '@/components/ui/shad/Input';
import { Progress } from '@/components/ui/shad/Progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { useMindMapStore } from '../../store';
import { useImeCompositionGuard } from '../../hooks/useImeCompositionGuard';
import { MindMapFormatBar } from '../toolbar/FormatBar';
import { MindmapAgentSuggestionBar } from '../agent/MindmapAgentSuggestionBar';
import { VersionHistoryPanel } from '../toolbar/VersionHistoryPanel';
import { ShortcutHelpPanel } from '../toolbar/ShortcutHelpPanel';
import { InlineCollapse } from '../toolbar/InlineCollapse';
import { ReciteStatusBar } from '../shared/ReciteStatusBar';
import type { MindMapKeymap } from '../../utils/mindmapPreferences';

export interface MindMapImportReportBannerData {
  nodes: number;
  droppedImages: number;
  droppedSummaries: number;
}

export interface MindMapFormatDockProps {
  currentView: 'outline' | 'mindmap';
  isCoarsePointer: boolean;
  reciteMode: boolean;
  presentationMode: boolean;
}

/**
 * 悬浮毛玻璃格式条容器：仅在思维导图画布视图（`currentView === 'mindmap'`）下渲染，
 * 直接作为 `.mm-content-stage` 的子级，匹配 `.mm-content-stage:has(...) > .mm-format-dock` 防碰撞规则，
 * 同时将 `focusedNodeId` / `selection` 订阅隔离出主壳层。
 * 大纲视图已有行内 `OutlineNodeMenu`、选区气泡与底部 `OutlineMultiselectBar`，不叠加此浮层避免遮挡文档标题。
 */
export const MindMapFormatDock: React.FC<MindMapFormatDockProps> = React.memo(
  ({ currentView, isCoarsePointer, reciteMode, presentationMode }) => {
    const hasFocusOrSelection = useMindMapStore(
      (state) => Boolean(state.focusedNodeId) || state.selection.length > 0,
    );
    if (
      currentView !== 'mindmap' ||
      isCoarsePointer ||
      reciteMode ||
      presentationMode ||
      !hasFocusOrSelection
    ) {
      return null;
    }
    return (
      <div className="mm-format-dock ui-drop-in" data-wb-blur-surface>
        <MindMapFormatBar />
      </div>
    );
  },
);
MindMapFormatDock.displayName = 'MindMapFormatDock';

/** 隔离保存冲突横幅订阅 */
const ConflictSnapshotBanner: React.FC<{ resourceId?: string }> = React.memo(
  ({ resourceId }) => {
    const { t } = useTranslation(['mindmap']);
    const conflictSnapshot = useMindMapStore((state) => state.conflictSnapshot);
    const restoreConflictSnapshot = useMindMapStore(
      (state) => state.restoreConflictSnapshot,
    );
    const dismissConflictSnapshot = useMindMapStore(
      (state) => state.dismissConflictSnapshot,
    );

    const visible = Boolean(
      conflictSnapshot && conflictSnapshot.mindmapId === resourceId,
    );

    return (
      <AnimatePresence initial={false}>
        {visible && (
          <InlineCollapse role="alert">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm flex-1 min-w-[160px]">
                {t('mindmap:store.conflictBannerTitle')}
              </span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={() => restoreConflictSnapshot()}
              >
                <ArrowCounterClockwise size={14} />
                <span className="text-xs">
                  {t('mindmap:store.conflictRestoreMine')}
                </span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={() => dismissConflictSnapshot()}
              >
                <span className="text-xs">
                  {t('mindmap:shellV2.conflict.keepServer')}
                </span>
              </DsButton>
            </div>
          </InlineCollapse>
        )}
      </AnimatePresence>
    );
  },
);
ConflictSnapshotBanner.displayName = 'ConflictSnapshotBanner';

/** 隔离导出进度订阅 */
const ExportProgressBanner: React.FC = React.memo(() => {
  const { t } = useTranslation(['mindmap']);
  const isExporting = useMindMapStore((state) => state.isExporting);
  const exportProgress = useMindMapStore((state) => state.exportProgress);

  return (
    <AnimatePresence initial={false}>
      {isExporting && (
        <InlineCollapse role="status" aria-live="polite">
          <div className="mm-inline-banner flex items-center gap-2.5 px-4 py-1.5 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)]">
            <Download size={14} className="shrink-0 text-[var(--mm-text-muted)]" />
            <span className="text-xs text-[var(--mm-text)] whitespace-nowrap">
              {t('mindmap:export.processing')}
            </span>
            <Progress value={exportProgress} className="h-1 flex-1 max-w-64" />
            <span className="text-xs text-[var(--mm-text-muted)] tabular-nums">
              {exportProgress}%
            </span>
          </div>
        </InlineCollapse>
      )}
    </AnimatePresence>
  );
});
ExportProgressBanner.displayName = 'ExportProgressBanner';

export interface MindMapSearchBannerProps {
  showSearch: boolean;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  onCloseSearch: () => void;
  /** 演示模式下顶部工具栏隐藏，需要保留搜索条内部关闭按钮 */
  presentationMode?: boolean;
}

/**
 * 局部搜索条：
 * - 隔离搜索结果订阅；
 * - 挂载 `useImeCompositionGuard`，防止中文/日文/韩文输入法按 Enter 上屏候选词时误触发 `nextSearchResult`。
 */
export const MindMapSearchBanner: React.FC<MindMapSearchBannerProps> = React.memo(
  ({ showSearch, searchInput, onSearchInputChange, onCloseSearch, presentationMode = false }) => {
    const { t } = useTranslation(['mindmap']);
    const searchFn = useMindMapStore((state) => state.search);
    const searchResults = useMindMapStore((state) => state.searchResults);
    const currentSearchIndex = useMindMapStore((state) => state.currentSearchIndex);
    const nextSearchResult = useMindMapStore((state) => state.nextSearchResult);
    const prevSearchResult = useMindMapStore((state) => state.prevSearchResult);
    const searchFilterMode = useMindMapStore((state) => state.searchFilterMode);
    const setSearchFilterMode = useMindMapStore((state) => state.setSearchFilterMode);

    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchWholeWord, setSearchWholeWord] = useState(false);
    const imeGuard = useImeCompositionGuard();

    const runSearch = useCallback(
      (query: string, caseSensitive: boolean, wholeWord: boolean) => {
        searchFn(query, { caseSensitive, wholeWord });
      },
      [searchFn],
    );

    const toggleSearchCaseSensitive = useCallback(() => {
      setSearchCaseSensitive((prev) => {
        const next = !prev;
        runSearch(searchInput, next, searchWholeWord);
        return next;
      });
    }, [runSearch, searchInput, searchWholeWord]);

    const toggleSearchWholeWord = useCallback(() => {
      setSearchWholeWord((prev) => {
        const next = !prev;
        runSearch(searchInput, searchCaseSensitive, next);
        return next;
      });
    }, [runSearch, searchCaseSensitive, searchInput]);

    if (!showSearch) return null;

    return (
      <div
        role="search"
        className="mm-search-popover ui-drop-in max-md:flex-wrap"
        data-wb-blur-surface
      >
              <MagnifyingGlass size={16} className="text-[var(--mm-text-muted)]" />
              <Input
                type="search"
                className="mm-search-input"
                placeholder={t('mindmap:toolbar.searchPlaceholder')}
                value={searchInput}
                onCompositionStart={imeGuard.onCompositionStart}
                onCompositionEnd={imeGuard.onCompositionEnd}
                onChange={(e) => {
                  onSearchInputChange(e.target.value);
                  runSearch(e.target.value, searchCaseSensitive, searchWholeWord);
                }}
                onKeyDown={(e) => {
                  if (imeGuard.isComposingKeyEvent(e)) {
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCloseSearch();
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) {
                      prevSearchResult();
                    } else {
                      nextSearchResult();
                    }
                  }
                }}
                autoFocus
              />

              {/* W08 SearchOptions：大小写敏感 / 全词匹配开关 */}
              <div
                className="flex items-center gap-0.5"
                role="group"
                aria-label={t('mindmap:toolbar.searchOptions')}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DsButton
                      variant="ghost"
                      className={cn(
                        'ds-btn h-6 px-1.5 text-xs font-medium',
                        "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
                        searchCaseSensitive
                          ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                          : 'text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      onClick={toggleSearchCaseSensitive}
                      aria-pressed={searchCaseSensitive}
                      aria-label={t('mindmap:toolbar.searchCaseSensitive')}
                    >
                      Aa
                    </DsButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('mindmap:toolbar.searchCaseSensitive')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DsButton
                      variant="ghost"
                      className={cn(
                        'ds-btn h-6 px-1.5 text-xs font-medium',
                        "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
                        searchWholeWord
                          ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                          : 'text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)]',
                      )}
                      onClick={toggleSearchWholeWord}
                      aria-pressed={searchWholeWord}
                      aria-label={t('mindmap:toolbar.searchWholeWord')}
                    >
                      <span className="underline underline-offset-2">ab</span>
                    </DsButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('mindmap:toolbar.searchWholeWord')}
                  </TooltipContent>
                </Tooltip>
              </div>

              {searchInput.trim() && (
                <div
                  className="mm-search-mode"
                  role="group"
                  aria-label={t('mindmap:toolbar.searchMode')}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DsButton
                        variant="ghost"
                        className={cn(
                          'mm-search-mode-button',
                          searchFilterMode
                            ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                            : 'text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                        )}
                        onClick={() => setSearchFilterMode(true)}
                        aria-pressed={searchFilterMode}
                      >
                        {t('mindmap:toolbar.searchFilter')}
                      </DsButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('mindmap:toolbar.searchFilterHint')}
                    </TooltipContent>
                  </Tooltip>
                  <div className="mm-search-divider" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DsButton
                        variant="ghost"
                        className={cn(
                          'mm-search-mode-button',
                          !searchFilterMode
                            ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                            : 'text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]',
                        )}
                        onClick={() => setSearchFilterMode(false)}
                        aria-pressed={!searchFilterMode}
                      >
                        {t('mindmap:toolbar.searchLocate')}
                      </DsButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('mindmap:toolbar.searchLocateHint')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}

              {searchInput.trim() && searchResults.length === 0 && (
                <span
                  className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap"
                  aria-live="polite"
                >
                  {t('mindmap:toolbar.searchNoResults')}
                </span>
              )}

              {searchResults.length > 0 && (
                <div className="mm-search-results">
                  <span className="tabular-nums">
                    {currentSearchIndex + 1}/{searchResults.length}
                  </span>
                  <div className="mm-search-navigation">
                    <DsButton
                      variant="ghost"
                      className="mm-search-nav-button"
                      onClick={prevSearchResult}
                      aria-label={t('mindmap:toolbar.prevResult')}
                    >
                      <CaretUp size={12} />
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      className="mm-search-nav-button"
                      onClick={nextSearchResult}
                      aria-label={t('mindmap:toolbar.nextResult')}
                    >
                      <CaretDown size={12} />
                    </DsButton>
                  </div>
                </div>
              )}

              <DsButton
                variant="ghost"
                className={cn('mm-search-close', !presentationMode && 'md:hidden')}
                aria-label={t('mindmap:toolbar.closeSearch')}
                onClick={onCloseSearch}
              >
                <X className="w-4 h-4" />
              </DsButton>
      </div>
    );
  },
);
MindMapSearchBanner.displayName = 'MindMapSearchBanner';

export interface MindMapStatusBannersProps {
  resourceId?: string;
  currentView: 'outline' | 'mindmap';
  keymap: MindMapKeymap;
  isImporting: boolean;
  importError: string | null;
  importReport: MindMapImportReportBannerData | null;
  showImportConfirm: boolean;
  showVersionHistory: boolean;
  showShortcutHelp: boolean;
  onRetryImport: () => void;
  onDismissImportError: () => void;
  onDismissImportReport: () => void;
  onSaveAndImport: () => void;
  onConfirmImport: () => void;
  onCancelImportConfirm: () => void;
  onCloseVersionHistory: () => void;
  onCloseShortcutHelp: () => void;
}

/**
 * 顶部文档流状态横幅区（紧贴 `.mm-toolbar` 下方，0 遮挡）：
 * 包含保存冲突恢复条、AI 建议条、导入进度/报告/错误/未保存确认条、
 * 版本历史、桌面快捷键帮助、导出进度条与背诵状态条。
 */
export const MindMapStatusBanners: React.FC<MindMapStatusBannersProps> = React.memo(
  ({
    resourceId,
    currentView,
    keymap,
    isImporting,
    importError,
    importReport,
    showImportConfirm,
    showVersionHistory,
    showShortcutHelp,
    onRetryImport,
    onDismissImportError,
    onDismissImportReport,
    onSaveAndImport,
    onConfirmImport,
    onCancelImportConfirm,
    onCloseVersionHistory,
    onCloseShortcutHelp,
  }) => {
    const { t } = useTranslation(['mindmap', 'common']);
    const isMobile = useIsMobile();
    const isDesktopShortcutDialogOpen = showShortcutHelp && !isMobile;
    const [hasOpenedShortcutDialog, setHasOpenedShortcutDialog] = useState(isDesktopShortcutDialogOpen);
    useEffect(() => {
      if (isDesktopShortcutDialogOpen) setHasOpenedShortcutDialog(true);
    }, [isDesktopShortcutDialogOpen]);
    const hasConflict = useMindMapStore(
      (state) => Boolean(state.conflictSnapshot && state.conflictSnapshot.mindmapId === resourceId),
    );
    const isExporting = useMindMapStore((state) => state.isExporting);

    // 单一顶部瞬态状态横幅槽（冲突 > 导入未保存确认 > 导入失败 > 导入中 > 导出中 > 导入报告）
    const activeTransientBanner: React.ReactNode = (() => {
      if (hasConflict) {
        return <ConflictSnapshotBanner resourceId={resourceId} />;
      }
      if (showImportConfirm) {
        return (
          <InlineCollapse key="import-confirm" role="alert">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm flex-1 min-w-[160px]">
                {t('mindmap:import.unsavedWarning')}
              </span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={onSaveAndImport}
              >
                <FloppyDisk size={14} />
                <span className="text-xs">
                  {t('mindmap:import.saveAndImport', { defaultValue: '保存并导入' })}
                </span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={onConfirmImport}
              >
                <Upload size={14} />
                <span className="text-xs">{t('mindmap:import.unsavedConfirm')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={onCancelImportConfirm}
              >
                <span className="text-xs">{t('common:cancel')}</span>
              </DsButton>
            </div>
          </InlineCollapse>
        );
      }
      if (importError) {
        return (
          <InlineCollapse key="import-error" role="alert">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm font-medium shrink-0">
                {t('mindmap:shellV2.import.errorTitle')}
              </span>
              <span className="text-xs flex-1 min-w-[160px] break-words opacity-90">
                {importError}
              </span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={onRetryImport}
              >
                <ArrowClockwise size={14} />
                <span className="text-xs">{t('mindmap:shellV2.import.retry')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={onDismissImportError}
              >
                <span className="text-xs">{t('mindmap:shellV2.import.dismiss')}</span>
              </DsButton>
            </div>
          </InlineCollapse>
        );
      }
      if (isImporting) {
        return (
          <InlineCollapse key="importing" role="status">
            <div
              className="mm-inline-banner flex items-center gap-2 px-4 py-2 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] text-[var(--mm-text-muted)]"
              aria-busy="true"
            >
              <CircleNotch
                size={16}
                className="shrink-0 animate-spin motion-reduce:animate-none"
              />
              <span className="text-sm">{t('mindmap:import.importing')}</span>
            </div>
          </InlineCollapse>
        );
      }
      if (isExporting) {
        return <ExportProgressBanner />;
      }
      if (importReport) {
        return (
          <InlineCollapse key="import-report" role="status">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] text-[var(--mm-text)]">
              <Info size={16} className="shrink-0 text-[var(--mm-primary)]" />
              <span className="text-xs font-medium shrink-0">
                {t('mindmap:import.reportTitle', {
                  defaultValue: '导入完成（含兼容提示）',
                })}
              </span>
              <span className="text-xs flex-1 min-w-[160px] text-[var(--mm-text-secondary)]">
                {t('mindmap:import.successSummaryIgnored', {
                  nodes: importReport.nodes,
                  images: importReport.droppedImages,
                  summaries: importReport.droppedSummaries,
                })}
              </span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={onDismissImportReport}
              >
                <span className="text-xs">{t('mindmap:shellV2.import.dismiss')}</span>
              </DsButton>
            </div>
          </InlineCollapse>
        );
      }
      return null;
    })();

    return (
      <>
        <AnimatePresence initial={false}>
          {activeTransientBanner}
        </AnimatePresence>

        {/* P2 人机双写：AI 建议确认条（组件内部空态返回 null，不套 InlineCollapse） */}
        {resourceId && <MindmapAgentSuggestionBar mindmapId={resourceId} />}

        {/* 版本历史内联面板 */}
        <AnimatePresence initial={false}>
          {showVersionHistory && resourceId && (
            <InlineCollapse>
              <VersionHistoryPanel
                mindmapId={resourceId}
                onClose={onCloseVersionHistory}
              />
            </InlineCollapse>
          )}
        </AnimatePresence>

        {/* 快捷键速查：桌面端改为宽幅居中弹窗一次性完整呈现，不再从顶栏往下挤压画布 */}
        {(hasOpenedShortcutDialog || isDesktopShortcutDialogOpen) && (
          <DsDialog
            open={isDesktopShortcutDialogOpen}
            onOpenChange={(open) => {
              if (!open) onCloseShortcutHelp();
            }}
            maxWidth="max-w-4xl"
            aria-label={t('mindmap:shortcuts.title')}
          >
            <DsDialogHeader>
              <DsDialogTitle>{t('mindmap:shortcuts.title')}</DsDialogTitle>
              <DsDialogDescription>
                {keymap === 'classic'
                  ? t('mindmap:preferences.classicKeymapActive')
                  : t('mindmap:preferences.deepStudentKeymapActive')}
              </DsDialogDescription>
            </DsDialogHeader>
            <DsDialogBody>
              <ShortcutHelpPanel
                view={currentView}
                keymap={keymap}
                onClose={onCloseShortcutHelp}
                embeddedInDialog
              />
            </DsDialogBody>
          </DsDialog>
        )}

        {/* 背诵模式状态条：顶部文档流内联条（双视图共享，不遮挡画布） */}
        <ReciteStatusBar />
      </>
    );
  },
);

MindMapStatusBanners.displayName = 'MindMapStatusBanners';
