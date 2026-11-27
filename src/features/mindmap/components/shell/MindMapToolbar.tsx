import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  GitBranch,
  TreeStructure,
  Palette,
  Stack,
  Upload,
  DotsThree,
  ArrowCounterClockwise,
  ArrowClockwise,
  MagnifyingGlass,
  CaretDown,
  Keyboard,
  BookOpen,
  SlidersHorizontal,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  Presentation,
  ShareNetwork,
  Check,
  ClockCounterClockwise,
  FileMd,
  FileCode,
  FilePng,
  FileSvg,
  FileZip,
  FileTxt,
  FilePdf,
  Tray,
  Faders,
  FolderOpen,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { TextSwap } from '@/components/ui/TextSwap';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuCheckboxItem,
  AppMenuSeparator,
  AppMenuSub,
  AppMenuSubTrigger,
  AppMenuSubContent,
} from '@/components/ui/app-menu/AppMenu';
import { useMindMapStore } from '../../store';
import { StructureSelector } from '../mindmap/StructureSelector';
import { StyleSettings } from '../toolbar/StylePanel';
import { getAliveSheetTabs, resolveActiveSheet } from '../../utils/sheetTabs';
import {
  setMindMapPreferences,
  useMindMapPreferences,
} from '../../utils/mindmapPreferences';

export type MindMapToolbarPanel = 'structure' | 'style' | 'more' | 'sheets' | null;

export interface MindMapToolbarProps {
  currentView: 'outline' | 'mindmap';
  activePanel: MindMapToolbarPanel;
  onActivePanelChange: (panel: MindMapToolbarPanel) => void;
  showSearch: boolean;
  onToggleSearch: () => void;
  showMasteryOverlay: boolean;
  onToggleMasteryOverlay: () => void;
  onSwitchView: (next: 'outline' | 'mindmap') => void;
  onEnterPresentation: () => void;
  onStartAssociation: () => void;
  onOpenVersionHistory: () => void;
  onImport: () => void;
  onExport: (format: string) => void;
  onOpenShortcutHelp: () => void;
  onOpenMobileMore: () => void;
}

/** 仅当文档含 ≥2 个 sheet 元数据时才挂载，常态单画布文档零订阅开销 */
const ToolbarSheetSwitcherInner: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = React.memo(({ open, onOpenChange }) => {
  const { t } = useTranslation(['mindmap']);
  const doc = useMindMapStore((state) => state.document);
  const viewRootId = useMindMapStore((state) => state.viewRootId);
  const setViewRootId = useMindMapStore((state) => state.setViewRootId);

  const sheetTabs = useMemo(() => getAliveSheetTabs(doc), [doc]);
  const activeSheet = useMemo(
    () => resolveActiveSheet(doc, sheetTabs, viewRootId),
    [doc, sheetTabs, viewRootId],
  );

  const handleSelectSheet = useCallback(
    (rootNodeId: string | null) => {
      setViewRootId(rootNodeId);
      onOpenChange(false);
    },
    [onOpenChange, setViewRootId],
  );

  if (!sheetTabs) return null;

  return (
    <AppMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip disabled={open}>
        <TooltipTrigger asChild>
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              className="ds-btn shrink-0 max-w-[200px]"
              aria-label={t('mindmap:sheets.switcherLabel')}
              data-testid="mm-sheet-switcher"
            >
              <Stack size={15} />
              <span className="text-xs truncate">
                {activeSheet ? activeSheet.title : t('mindmap:sheets.all')}
              </span>
              <CaretDown size={10} />
            </DsButton>
          </AppMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('mindmap:sheets.switcherHint')}</TooltipContent>
      </Tooltip>
      <AppMenuContent align="start" width={220}>
        <AppMenuItem
          icon={!activeSheet ? <Check size={14} /> : <span className="w-3.5" />}
          onClick={() => handleSelectSheet(null)}
        >
          {t('mindmap:sheets.all')}
        </AppMenuItem>
        <AppMenuSeparator />
        {sheetTabs.map((sheet) => (
          <AppMenuItem
            key={sheet.id}
            icon={
              activeSheet?.id === sheet.id ? (
                <Check size={14} />
              ) : (
                <span className="w-3.5" />
              )
            }
            onClick={() => handleSelectSheet(sheet.rootNodeId)}
          >
            {sheet.title}
          </AppMenuItem>
        ))}
      </AppMenuContent>
    </AppMenu>
  );
});
ToolbarSheetSwitcherInner.displayName = 'ToolbarSheetSwitcherInner';

const ToolbarSheetSwitcher: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = React.memo(({ open, onOpenChange }) => {
  const hasSheets = useMindMapStore(
    (state) => (state.document.meta.sheets?.length ?? 0) >= 2,
  );
  if (!hasSheets) return null;
  return <ToolbarSheetSwitcherInner open={open} onOpenChange={onOpenChange} />;
});
ToolbarSheetSwitcher.displayName = 'ToolbarSheetSwitcher';

/** 隔离高频 history / isDirty / isSaving 订阅，不牵连壳层根组件重渲染 */
const ToolbarHistoryAndSave: React.FC = React.memo(() => {
  const { t } = useTranslation(['mindmap']);
  const hasUndo = useMindMapStore((state) => state.history.past.length > 0);
  const hasRedo = useMindMapStore((state) => state.history.future.length > 0);
  const undo = useMindMapStore((state) => state.undo);
  const redo = useMindMapStore((state) => state.redo);
  const isDirty = useMindMapStore((state) => state.isDirty);
  const isSaving = useMindMapStore((state) => state.isSaving);
  const save = useMindMapStore((state) => state.save);

  const handleSave = useCallback(() => {
    void save();
  }, [save]);

  return (
    <>
      <div className="flex items-center gap-0.5 shrink-0">
        {/* disabled 按钮不冒泡鼠标事件，tooltip 挂在外层 span 上保证禁用态也有提示 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 motion-reduce:transition-none"
                onClick={undo}
                disabled={!hasUndo}
                aria-label={t('mindmap:toolbar.undo')}
              >
                <ArrowCounterClockwise size={16} />
              </DsButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" shortcut={hasUndo ? '⌘Z' : undefined}>
            {hasUndo ? t('mindmap:toolbar.undo') : t('mindmap:toolbar.undoDisabled')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 motion-reduce:transition-none"
                onClick={redo}
                disabled={!hasRedo}
                aria-label={t('mindmap:toolbar.redo')}
              >
                <ArrowClockwise size={16} />
              </DsButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" shortcut={hasRedo ? '⌘⇧Z' : undefined}>
            {hasRedo ? t('mindmap:toolbar.redo') : t('mindmap:toolbar.redoDisabled')}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="w-px h-4 bg-[var(--mm-border)] hidden md:block shrink-0" />

      {/* 保存状态内联可视化：状态点常显，未保存时可点击立即保存 */}
      <Tooltip disabled={!isDirty || isSaving}>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            className="mm-toolbar-save ds-btn shrink-0 hidden md:flex motion-reduce:transition-none"
            data-save-state={isSaving ? 'saving' : isDirty ? 'unsaved' : 'saved'}
            aria-label={t('mindmap:toolbar.save')}
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            <span
              aria-hidden
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                isSaving
                  ? 'bg-[var(--mm-primary)] motion-safe:animate-pulse'
                  : isDirty
                    ? 'bg-[var(--mm-warning)]'
                    : 'bg-[var(--mm-text-muted)] opacity-60',
              )}
            />
            <span aria-live="polite">
              <TextSwap
                className="text-xs text-[var(--mm-text-muted)]"
                text={
                  isSaving
                    ? t('mindmap:toolbar.saving')
                    : isDirty
                      ? t('mindmap:toolbar.unsaved')
                      : t('mindmap:toolbar.saved')
                }
              />
            </span>
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" shortcut="⌘S">
          {t('mindmap:toolbar.save')}
        </TooltipContent>
      </Tooltip>
    </>
  );
});
ToolbarHistoryAndSave.displayName = 'ToolbarHistoryAndSave';

/** 核心学习控件组（仅保留高频入口：待整理池与背诵模式；低频开关收纳至「更多 -> 显示与学习」） */
const ToolbarLearningGroup: React.FC = React.memo(() => {
  const { t } = useTranslation(['mindmap']);
  const stagingTrayOpen = useMindMapStore((state) => state.stagingTrayOpen);
  const setStagingTrayOpen = useMindMapStore((state) => state.setStagingTrayOpen);
  const excerptIntakeMode = useMindMapStore((state) => state.excerptIntakeMode);
  const stagingCount = useMindMapStore(
    (state) => state.document.stagingExcerpts?.length ?? 0,
  );
  const reciteMode = useMindMapStore((state) => state.reciteMode);
  const setReciteMode = useMindMapStore((state) => state.setReciteMode);

  return (
    <div
      className="mm-learning-group hidden md:flex shrink-0"
      role="group"
      aria-label={t('mindmap:toolbar.learning')}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <DsButton
              variant="ghost"
              className={cn(
                'mm-learning-button shrink-0 motion-reduce:transition-none',
                (stagingTrayOpen || excerptIntakeMode === 'staging') &&
                  'bg-[var(--mm-primary-soft)] text-[var(--mm-primary)]',
              )}
              onClick={() => setStagingTrayOpen(!stagingTrayOpen)}
              disabled={reciteMode}
              aria-label={t('mindmap:mn5.stagingTrayTitle')}
              aria-pressed={stagingTrayOpen}
              data-testid="mm-staging-tray-toggle"
            >
              <Tray size={15} />
              <span className="mm-learning-text">{t('mindmap:mn5.stagingTrayTitle')}</span>
              {stagingCount > 0 && (
                <span
                  className="ml-0.5 font-mono tabular-nums text-[11px] opacity-80"
                  data-testid="mm-staging-toolbar-count"
                >
                  {stagingCount}
                </span>
              )}
            </DsButton>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('mindmap:mn5.stagingTrayToggleHint')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            className={cn('mm-learning-button shrink-0 motion-reduce:transition-none', reciteMode && 'is-active')}
            onClick={() => setReciteMode(!reciteMode)}
            aria-label={reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
            aria-pressed={reciteMode}
          >
            <BookOpen size={15} />
            <span className="mm-learning-text">
              {reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
            </span>
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.enter')}
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
ToolbarLearningGroup.displayName = 'ToolbarLearningGroup';

/** 更多菜单中的「显示与学习」二级子菜单：隔离 autoExcerpt / reciteMode / hideCompleted 订阅 */
const MoreMenuDisplaySubmenu: React.FC<{
  isMindMapView: boolean;
  showMasteryOverlay: boolean;
  onToggleMasteryOverlay: () => void;
}> = React.memo(({ isMindMapView, showMasteryOverlay, onToggleMasteryOverlay }) => {
  const { t } = useTranslation(['mindmap']);
  const autoExcerptEnabled = useMindMapStore((state) => state.autoExcerptEnabled);
  const setAutoExcerptEnabled = useMindMapStore((state) => state.setAutoExcerptEnabled);
  const reciteMode = useMindMapStore((state) => state.reciteMode);
  const hideCompleted = useMindMapStore((state) => state.hideCompleted);
  const setHideCompleted = useMindMapStore((state) => state.setHideCompleted);

  return (
    <AppMenuSub>
      <AppMenuSubTrigger
        icon={<Faders size={16} />}
        data-testid="mm-more-sub-display"
      >
        {t('mindmap:toolbar.moreSubDisplay')}
      </AppMenuSubTrigger>
      <AppMenuSubContent>
        <AppMenuCheckboxItem
          checked={autoExcerptEnabled}
          disabled={reciteMode}
          onCheckedChange={setAutoExcerptEnabled}
          data-testid="mm-auto-excerpt-toggle"
        >
          {t('mindmap:mn5.autoExcerptToggle')}
        </AppMenuCheckboxItem>
        {isMindMapView && (
          <AppMenuCheckboxItem
            checked={showMasteryOverlay}
            onCheckedChange={() => onToggleMasteryOverlay()}
            data-testid="mm-mastery-toggle"
          >
            {t('mindmap:toolbar.masteryOverlay', { defaultValue: '掌握度' })}
          </AppMenuCheckboxItem>
        )}
        <AppMenuCheckboxItem
          checked={hideCompleted}
          onCheckedChange={setHideCompleted}
          data-testid="mm-hide-completed-toggle"
        >
          {t('mindmap:toolbar.hideCompleted')}
        </AppMenuCheckboxItem>
      </AppMenuSubContent>
    </AppMenuSub>
  );
});
MoreMenuDisplaySubmenu.displayName = 'MoreMenuDisplaySubmenu';

/** 移动端顶栏右侧快捷入口：摘录暂存盘（带未处理角标）+ 更多子屏 */
const ToolbarMobileQuickActions: React.FC<{
  onOpenMobileMore: () => void;
}> = React.memo(({ onOpenMobileMore }) => {
  const { t } = useTranslation(['mindmap']);
  const stagingTrayOpen = useMindMapStore((state) => state.stagingTrayOpen);
  const setStagingTrayOpen = useMindMapStore((state) => state.setStagingTrayOpen);
  const stagingCount = useMindMapStore(
    (state) => state.document.stagingExcerpts?.length ?? 0,
  );
  const reciteMode = useMindMapStore((state) => state.reciteMode);

  return (
    <div className="flex items-center gap-0.5 shrink-0 md:hidden">
      <DsButton
        variant="ghost"
        className={cn(
          'ds-btn shrink-0 relative w-10 h-10 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 justify-center px-0 motion-reduce:transition-none',
          stagingTrayOpen && 'bg-[var(--mm-primary-soft)] text-[var(--mm-primary)]',
        )}
        disabled={reciteMode}
        aria-label={t('mindmap:mn5.stagingTrayTitle')}
        aria-pressed={stagingTrayOpen}
        data-testid="mm-mobile-staging-tray-toggle"
        onClick={() => setStagingTrayOpen(!stagingTrayOpen)}
      >
        <Tray size={16} />
        {stagingCount > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--mm-primary)] text-[hsl(var(--primary-foreground))] text-[10px] leading-4 font-mono tabular-nums text-center"
            data-testid="mm-mobile-staging-badge"
          >
            {stagingCount > 99 ? '99+' : stagingCount}
          </span>
        )}
      </DsButton>

      <DsButton
        variant="ghost"
        className="ds-btn shrink-0 mm-mobile-more w-10 h-10 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 justify-center px-0 motion-reduce:transition-none"
        aria-label={t('mindmap:toolbar.moreActions')}
        onClick={onOpenMobileMore}
      >
        <DotsThree size={16} />
      </DsButton>
    </div>
  );
});
ToolbarMobileQuickActions.displayName = 'ToolbarMobileQuickActions';

/**
 * 思维导图顶部文档流工具栏（42px `.mm-toolbar`）：
 * - 根元素保持直接挂载为 `.mm-document-column > .mm-toolbar`，兼容 M4 样式与演示/移动子屏隐藏规则；
 * - 高频状态通过内部原子子组件隔离订阅，显著减少根壳层重渲染；
 * - 图标语义唯一：大纲 `<FileText>`、导图 `<TreeStructure>`、Sheet `<Stack>`、结构 `<GitBranch>`、样式 `<Palette>`、掌握度 `<Heartbeat>`。
 */
export const MindMapToolbar: React.FC<MindMapToolbarProps> = React.memo(
  ({
    currentView,
    activePanel,
    onActivePanelChange,
    showSearch,
    onToggleSearch,
    showMasteryOverlay,
    onToggleMasteryOverlay,
    onSwitchView,
    onEnterPresentation,
    onStartAssociation,
    onOpenVersionHistory,
    onImport,
    onExport,
    onOpenShortcutHelp,
    onOpenMobileMore,
  }) => {
    const { t } = useTranslation(['mindmap']);
    const mindMapPreferences = useMindMapPreferences();
    const isMindMapView = currentView !== 'outline';
    const collapseAll = useMindMapStore((state) => state.collapseAll);
    const expandAll = useMindMapStore((state) => state.expandAll);
    const collapseToDepth = useMindMapStore((state) => state.collapseToDepth);

    return (
      <div className="mm-toolbar">
        {/* Left: View Switcher, Sheet Switcher, Undo/Redo & Save Status */}
        <div className="mm-toolbar-history flex items-center gap-3">
          <SegmentedControl<'outline' | 'mindmap'>
            ariaLabel={t('mindmap:toolbar.view')}
            size="compact"
            itemClassName="[@media(pointer:coarse)]:!min-h-11"
            value={currentView}
            onValueChange={onSwitchView}
            options={[
              {
                value: 'outline',
                ariaLabel: t('mindmap:toolbar.outline'),
                label: (
                  <span className="inline-flex items-center">
                    <FileText className="mm-view-switcher-icon w-3.5 h-3.5 mr-1.5" />
                    <span className="mm-view-switcher-label">
                      {t('mindmap:toolbar.outline')}
                    </span>
                  </span>
                ),
              },
              {
                value: 'mindmap',
                ariaLabel: t('mindmap:toolbar.mindmap'),
                label: (
                  <span className="inline-flex items-center">
                    <TreeStructure className="mm-view-switcher-icon w-3.5 h-3.5 mr-1.5" />
                    <span className="mm-view-switcher-label">
                      {t('mindmap:toolbar.mindmap')}
                    </span>
                  </span>
                ),
              },
            ]}
          />

          <ToolbarSheetSwitcher
            open={activePanel === 'sheets'}
            onOpenChange={(open) => onActivePanelChange(open ? 'sheets' : null)}
          />

          <div className="w-px h-4 bg-[var(--mm-border)] hidden md:block shrink-0" />

          <ToolbarHistoryAndSave />
        </div>

        {/* Right: Structure, Style, Learning, Search, Presentation & More */}
        <div className="mm-toolbar-actions flex items-center gap-1 shrink-0">
          {isMindMapView && (
            <>
              <StructureSelector
                className="hidden md:flex shrink-0"
                open={activePanel === 'structure'}
                onOpenChange={(open) => onActivePanelChange(open ? 'structure' : null)}
                trigger={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DsButton
                        variant="ghost"
                        className="mm-toolbar-button shrink-0 motion-reduce:transition-none"
                        aria-label={t('mindmap:toolbar.switchStructure')}
                      >
                        <GitBranch size={16} />
                      </DsButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('mindmap:toolbar.switchStructure')}
                    </TooltipContent>
                  </Tooltip>
                }
              />

              <StyleSettings
                className="hidden md:flex shrink-0"
                open={activePanel === 'style'}
                onOpenChange={(open) => onActivePanelChange(open ? 'style' : null)}
                trigger={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DsButton
                        variant="ghost"
                        className="mm-toolbar-button shrink-0 motion-reduce:transition-none"
                        aria-label={t('mindmap:toolbar.styleSettings')}
                      >
                        <Palette size={16} />
                      </DsButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('mindmap:toolbar.styleSettings')}
                    </TooltipContent>
                  </Tooltip>
                }
              />
            </>
          )}

          <ToolbarLearningGroup />

          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                variant="ghost"
                className={cn(
                  'mm-toolbar-button shrink-0 hidden md:flex motion-reduce:transition-none',
                  showSearch && 'is-active',
                )}
                onClick={onToggleSearch}
                aria-label={t('mindmap:toolbar.search')}
                aria-pressed={showSearch}
              >
                <MagnifyingGlass size={16} />
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" shortcut="⌘F">
              {t('mindmap:toolbar.search')}
            </TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-[var(--mm-border)] mx-1 hidden md:block shrink-0" />

          {/* Desktop: More Menu（一级精简 + 二级子菜单分层收纳） */}
          <AppMenu
            open={activePanel === 'more'}
            onOpenChange={(open) => onActivePanelChange(open ? 'more' : null)}
          >
            <Tooltip disabled={activePanel === 'more'}>
              <TooltipTrigger asChild>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    className={cn(
                      'mm-toolbar-button shrink-0 hidden md:flex motion-reduce:transition-none',
                      activePanel === 'more' && 'is-active',
                    )}
                    aria-label={t('mindmap:toolbar.moreActions')}
                    data-testid="mm-more-menu-trigger"
                  >
                    <DotsThree size={16} />
                  </DsButton>
                </AppMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('mindmap:toolbar.moreActions')}</TooltipContent>
            </Tooltip>
            <AppMenuContent align="end" width={208}>
              <AppMenuSub>
                <AppMenuSubTrigger
                  icon={<ArrowsOutLineVertical size={16} />}
                  data-testid="mm-more-sub-fold"
                >
                  {t('mindmap:toolbar.moreSubFold')}
                </AppMenuSubTrigger>
                <AppMenuSubContent>
                  <AppMenuItem
                    icon={<ArrowsOutLineVertical size={16} />}
                    shortcut="⌘⇧]"
                    onClick={() => expandAll()}
                  >
                    {t('mindmap:toolbar.expandAll')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<ArrowsInLineVertical size={16} />}
                    shortcut="⌘⇧["
                    onClick={() => collapseAll()}
                  >
                    {t('mindmap:toolbar.collapseAll')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                  <AppMenuItem onClick={() => collapseToDepth(1)}>
                    {t('mindmap:toolbar.collapseToLevel', { level: 1 })}
                  </AppMenuItem>
                  <AppMenuItem onClick={() => collapseToDepth(2)}>
                    {t('mindmap:toolbar.collapseToLevel', { level: 2 })}
                  </AppMenuItem>
                  <AppMenuItem onClick={() => collapseToDepth(3)}>
                    {t('mindmap:toolbar.collapseToLevel', { level: 3 })}
                  </AppMenuItem>
                </AppMenuSubContent>
              </AppMenuSub>

              <MoreMenuDisplaySubmenu
                isMindMapView={isMindMapView}
                showMasteryOverlay={showMasteryOverlay}
                onToggleMasteryOverlay={onToggleMasteryOverlay}
              />

              <AppMenuSeparator />

              {isMindMapView && (
                <AppMenuItem
                  icon={<Presentation size={16} />}
                  onClick={onEnterPresentation}
                  data-testid="mm-presentation-toggle"
                >
                  {t('mindmap:presentation.enter')}
                </AppMenuItem>
              )}
              {isMindMapView && (
                <AppMenuItem
                  icon={<ShareNetwork size={16} />}
                  shortcut="⌘L"
                  onClick={onStartAssociation}
                >
                  {t('mindmap:association.add')}
                </AppMenuItem>
              )}
              <AppMenuItem
                icon={<ClockCounterClockwise size={16} />}
                onClick={onOpenVersionHistory}
              >
                {t('mindmap:versions.title')}
              </AppMenuItem>

              <AppMenuSeparator />

              <AppMenuSub>
                <AppMenuSubTrigger
                  icon={<FolderOpen size={16} />}
                  data-testid="mm-more-sub-io"
                >
                  {t('mindmap:toolbar.moreSubImportExport')}
                </AppMenuSubTrigger>
                <AppMenuSubContent>
                  <AppMenuItem icon={<Upload size={16} />} onClick={onImport} data-testid="mm-import-toggle">
                    {t('mindmap:import.title')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                  <AppMenuItem
                    icon={<FileMd size={16} />}
                    onClick={() => onExport('markdown')}
                  >
                    {t('mindmap:export.exportMarkdown')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<TreeStructure size={16} />}
                    onClick={() => onExport('opml')}
                  >
                    {t('mindmap:export.exportOpml')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FileCode size={16} />}
                    onClick={() => onExport('json')}
                  >
                    {t('mindmap:export.dialogExportJson')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FileZip size={16} />}
                    onClick={() => onExport('xmind')}
                  >
                    {t('mindmap:export.exportXmind')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FileTxt size={16} />}
                    onClick={() => onExport('text')}
                  >
                    {t('mindmap:export.exportText')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                  <AppMenuItem
                    icon={<FilePng size={16} />}
                    onClick={() => onExport('png')}
                  >
                    {t('mindmap:export.pngImage')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FileSvg size={16} />}
                    onClick={() => onExport('svg')}
                  >
                    {t('mindmap:export.svgVector')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<FilePdf size={16} />}
                    onClick={() => onExport('pdf')}
                  >
                    {t('mindmap:export.exportPdf')}
                  </AppMenuItem>
                </AppMenuSubContent>
              </AppMenuSub>

              <AppMenuSub>
                <AppMenuSubTrigger
                  icon={<SlidersHorizontal size={16} />}
                  data-testid="mm-more-sub-prefs"
                >
                  {t('mindmap:toolbar.moreSubPreferences')}
                </AppMenuSubTrigger>
                <AppMenuSubContent>
                  <AppMenuCheckboxItem
                    checked={mindMapPreferences.keymap === 'classic'}
                    onCheckedChange={(checked) =>
                      setMindMapPreferences({ keymap: checked ? 'classic' : 'deep-student' })
                    }
                  >
                    {t('mindmap:preferences.classicKeymap')}
                  </AppMenuCheckboxItem>
                  {isMindMapView ? (
                    <AppMenuCheckboxItem
                      checked={mindMapPreferences.canvasNavigation === 'spatial'}
                      onCheckedChange={(checked) =>
                        setMindMapPreferences({
                          canvasNavigation: checked ? 'spatial' : 'document',
                        })
                      }
                    >
                      {t('mindmap:preferences.spatialNavigation')}
                    </AppMenuCheckboxItem>
                  ) : (
                    <AppMenuCheckboxItem
                      checked={mindMapPreferences.descriptionPreview === 'first-line'}
                      onCheckedChange={(checked) =>
                        setMindMapPreferences({
                          descriptionPreview: checked ? 'first-line' : 'full',
                        })
                      }
                    >
                      {t('mindmap:preferences.descriptionFirstLine')}
                    </AppMenuCheckboxItem>
                  )}
                </AppMenuSubContent>
              </AppMenuSub>

              <AppMenuSeparator />
              <AppMenuItem
                icon={<Keyboard size={16} />}
                shortcut="?"
                onClick={onOpenShortcutHelp}
              >
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>

          <ToolbarMobileQuickActions onOpenMobileMore={onOpenMobileMore} />
        </div>
      </div>
    );
  },
);

MindMapToolbar.displayName = 'MindMapToolbar';
