import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Article,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  BookOpen,
  CaretLeft,
  Check,
  ClockCounterClockwise,
  EyeSlash,
  FileCode,
  FileMd,
  FilePdf,
  FilePng,
  FileSvg,
  FileTxt,
  FileZip,
  FloppyDisk,
  GitBranch,
  Heartbeat,
  MagnifyingGlass,
  Palette,
  Presentation,
  SelectionPlus,
  ShareNetwork,
  Tray,
  TreeStructure,
  Upload,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useMindMapStore, useMindMapStoreApi } from '../../store';
import { StructureSelector } from '../mindmap/StructureSelector';
import { StyleSettings } from '../toolbar/StylePanel';
import { ShortcutHelpPanel } from '../toolbar/ShortcutHelpPanel';
import { exportMindMapSelectionToHandoutNote } from '../../interop/handoutExport';
import { findNodeById } from '../../utils/node/find';
import type { MindMapKeymap } from '../../utils/mindmapPreferences';

export type MindMapMobileOverlay = 'structure' | 'style' | 'more' | 'shortcuts' | 'versions' | null;

export interface MindMapMobileSubviewsProps {
  resourceId?: string;
  currentView: 'outline' | 'mindmap';
  keymap: MindMapKeymap;
  overlayPanel: MindMapMobileOverlay;
  onOverlayPanelChange: (panel: MindMapMobileOverlay) => void;
  showMasteryOverlay: boolean;
  onOpenSearch: () => void;
  onEnterPresentation: () => void;
  onToggleMasteryOverlay: () => void;
  onStartAssociation: () => void;
  onImport: () => void;
  onExport: (format: string) => void;
}

const MobileMenuRow: React.FC<{
  icon?: React.ReactNode;
  label: string;
  badge?: number;
  checked?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick: () => void;
}> = ({ icon, label, badge, checked, disabled, testId, onClick }) => (
  <DsButton
    variant="ghost"
    className="w-full min-h-11 h-11 !justify-start gap-3 px-3 rounded-md text-sm text-[var(--mm-text)] motion-reduce:transition-none"
    disabled={disabled}
    data-testid={testId}
    onClick={onClick}
  >
    <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--mm-text-secondary)]">
      {icon}
    </span>
    <span className="flex-1 text-left truncate">{label}</span>
    {typeof badge === 'number' && badge > 0 && (
      <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--mm-primary-soft)] text-[var(--mm-primary)] text-[11px] leading-5 font-mono tabular-nums text-center shrink-0">
        {badge > 99 ? '99+' : badge}
      </span>
    )}
    {checked && <Check size={16} className="text-[var(--mm-primary)] shrink-0" />}
  </DsButton>
);

const MobileMenuGroup: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="mb-2">
    <div className="h-8 flex items-end px-3 pb-1 text-[11px] font-medium text-[var(--mm-text-muted)]">
      {title}
    </div>
    {children}
  </div>
);

/** 仅在移动端「更多」子屏打开时挂载，零常态 store 订阅 */
const MobileMorePanel: React.FC<{
  resourceId?: string;
  showMasteryOverlay: boolean;
  onClose: () => void;
  onOpenMobileStructure: () => void;
  onOpenMobileStyle: () => void;
  onOpenSearch: () => void;
  onEnterPresentation: () => void;
  onToggleMasteryOverlay: () => void;
  onStartAssociation: () => void;
  onOpenVersionHistory: () => void;
  onImport: () => void;
  onExport: (format: string) => void;
}> = ({
  resourceId,
  showMasteryOverlay,
  onClose,
  onOpenMobileStructure,
  onOpenMobileStyle,
  onOpenSearch,
  onEnterPresentation,
  onToggleMasteryOverlay,
  onStartAssociation,
  onOpenVersionHistory,
  onImport,
  onExport,
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const storeApi = useMindMapStoreApi();
  const isDirty = useMindMapStore((state) => state.isDirty);
  const isSaving = useMindMapStore((state) => state.isSaving);
  const save = useMindMapStore((state) => state.save);
  const autoExcerptEnabled = useMindMapStore((state) => state.autoExcerptEnabled);
  const setAutoExcerptEnabled = useMindMapStore((state) => state.setAutoExcerptEnabled);
  const stagingTrayOpen = useMindMapStore((state) => state.stagingTrayOpen);
  const setStagingTrayOpen = useMindMapStore((state) => state.setStagingTrayOpen);
  const stagingCount = useMindMapStore(
    (state) => state.document.stagingExcerpts?.length ?? 0,
  );
  const reciteMode = useMindMapStore((state) => state.reciteMode);
  const setReciteMode = useMindMapStore((state) => state.setReciteMode);
  const hideCompleted = useMindMapStore((state) => state.hideCompleted);
  const setHideCompleted = useMindMapStore((state) => state.setHideCompleted);
  const expandAll = useMindMapStore((state) => state.expandAll);
  const collapseAll = useMindMapStore((state) => state.collapseAll);
  const collapseToDepth = useMindMapStore((state) => state.collapseToDepth);

  const closeThen = useCallback(
    (action: () => void) => () => {
      onClose();
      action();
    },
    [onClose],
  );

  const handleExportHandout = useCallback(() => {
    if (!resourceId) return;
    const state = storeApi.getState();
    const selectedIds =
      state.selection.length > 0
        ? state.selection
        : state.focusedNodeId
          ? [state.focusedNodeId]
          : [state.document.root.id];
    const nodes = selectedIds
      .map((id) => findNodeById(state.document.root, id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (nodes.length === 0) return;

    void exportMindMapSelectionToHandoutNote({
      nodes,
      mindmapId: resourceId,
      mindmapTitle: state.document.root.text,
      defaultNoteSuffix: t('mindmap:mn5.exportHandoutSuffix', { defaultValue: '讲义' }),
    })
      .then((outcome) => {
        showGlobalNotification(
          'success',
          t('mindmap:mn5.exportHandoutSuccess', {
            defaultValue: '已导出讲义笔记「{{title}}」',
            title: outcome.noteTitle,
          }),
        );
      })
      .catch((err) => {
        showGlobalNotification(
          'error',
          t('mindmap:mn5.exportHandoutFailed', {
            defaultValue: '导出讲义笔记失败：{{error}}',
            error: getErrorMessage(err),
          }),
        );
      });
  }, [resourceId, storeApi, t]);

  return (
    <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
      <div className="mm-mobile-subview-header">
        <DsButton
          variant="ghost"
          className="mm-mobile-subview-back"
          onClick={onClose}
          aria-label={t('common:back')}
        >
          <CaretLeft className="w-5 h-5" />
        </DsButton>
        <span className="font-medium text-sm">{t('mindmap:toolbar.moreActions')}</span>
      </div>
      <CustomScrollArea
        className="flex-1 min-h-0"
        viewportClassName="mm-mobile-subview-scroll px-1 py-1"
      >
        <MobileMenuGroup title={t('mindmap:menu.groupView', { defaultValue: '视图' })}>
          <MobileMenuRow
            icon={<GitBranch size={18} />}
            label={t('mindmap:toolbar.structure')}
            onClick={onOpenMobileStructure}
          />
          <MobileMenuRow
            icon={<Palette size={18} />}
            label={t('mindmap:toolbar.style')}
            onClick={onOpenMobileStyle}
          />
          <MobileMenuRow
            icon={<MagnifyingGlass size={18} />}
            label={t('mindmap:toolbar.search')}
            onClick={closeThen(onOpenSearch)}
          />
          <MobileMenuRow
            icon={<Presentation size={18} />}
            label={t('mindmap:presentation.enter')}
            onClick={closeThen(onEnterPresentation)}
          />
          <MobileMenuRow
            icon={<ArrowsOutLineVertical size={18} />}
            label={t('mindmap:toolbar.expandAll')}
            onClick={closeThen(() => expandAll())}
          />
          <MobileMenuRow
            icon={<ArrowsInLineVertical size={18} />}
            label={t('mindmap:toolbar.collapseAll')}
            onClick={closeThen(() => collapseAll())}
          />
          <MobileMenuRow
            label={t('mindmap:toolbar.collapseToLevel', { level: 1 })}
            onClick={closeThen(() => collapseToDepth(1))}
          />
          <MobileMenuRow
            label={t('mindmap:toolbar.collapseToLevel', { level: 2 })}
            onClick={closeThen(() => collapseToDepth(2))}
          />
          <MobileMenuRow
            label={t('mindmap:toolbar.collapseToLevel', { level: 3 })}
            onClick={closeThen(() => collapseToDepth(3))}
          />
        </MobileMenuGroup>

        <MobileMenuGroup title={t('mindmap:toolbar.learning')}>
          <MobileMenuRow
            icon={<SelectionPlus size={18} />}
            label={t('mindmap:mn5.autoExcerptToggle')}
            checked={autoExcerptEnabled}
            disabled={reciteMode}
            onClick={() => setAutoExcerptEnabled(!autoExcerptEnabled)}
          />
          <MobileMenuRow
            icon={<Tray size={18} />}
            label={t('mindmap:mn5.stagingTrayTitle')}
            badge={stagingCount}
            checked={stagingTrayOpen}
            disabled={reciteMode}
            testId="mm-mobile-more-staging-tray"
            onClick={closeThen(() => setStagingTrayOpen(!stagingTrayOpen))}
          />
          <MobileMenuRow
            icon={<BookOpen size={18} />}
            label={reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
            checked={reciteMode}
            onClick={closeThen(() => setReciteMode(!reciteMode))}
          />
          <MobileMenuRow
            icon={<Heartbeat size={18} />}
            label={t('mindmap:toolbar.masteryOverlay', { defaultValue: '掌握度' })}
            checked={showMasteryOverlay}
            testId="mm-mobile-more-mastery"
            onClick={closeThen(onToggleMasteryOverlay)}
          />
          <MobileMenuRow
            icon={<EyeSlash size={18} />}
            label={t('mindmap:toolbar.hideCompleted')}
            checked={hideCompleted}
            onClick={() => setHideCompleted(!hideCompleted)}
          />
          <MobileMenuRow
            icon={<ShareNetwork size={18} />}
            label={t('mindmap:association.add')}
            onClick={closeThen(onStartAssociation)}
          />
          <MobileMenuRow
            icon={<Article size={18} />}
            label={t('mindmap:mn5.exportHandout', { defaultValue: '导出讲义笔记' })}
            disabled={!resourceId}
            onClick={closeThen(handleExportHandout)}
          />
        </MobileMenuGroup>

        <MobileMenuGroup title={t('mindmap:menu.groupData', { defaultValue: '数据' })}>
          <MobileMenuRow
            icon={<FloppyDisk size={18} />}
            label={
              isSaving
                ? t('mindmap:toolbar.saving')
                : isDirty
                  ? t('mindmap:toolbar.save')
                  : t('mindmap:toolbar.saved')
            }
            disabled={!isDirty || isSaving}
            onClick={closeThen(() => {
              void save();
            })}
          />
          <MobileMenuRow
            icon={<ClockCounterClockwise size={18} />}
            label={t('mindmap:versions.title')}
            onClick={closeThen(onOpenVersionHistory)}
          />
          <MobileMenuRow
            icon={<Upload size={18} />}
            label={t('mindmap:import.title')}
            onClick={closeThen(onImport)}
          />
          <MobileMenuRow
            icon={<FileMd size={18} />}
            label={t('mindmap:export.exportMarkdown')}
            onClick={closeThen(() => onExport('markdown'))}
          />
          <MobileMenuRow
            icon={<TreeStructure size={18} />}
            label={t('mindmap:export.exportOpml')}
            onClick={closeThen(() => onExport('opml'))}
          />
          <MobileMenuRow
            icon={<FileCode size={18} />}
            label={t('mindmap:export.dialogExportJson')}
            onClick={closeThen(() => onExport('json'))}
          />
          <MobileMenuRow
            icon={<FileZip size={18} />}
            label={t('mindmap:export.exportXmind')}
            onClick={closeThen(() => onExport('xmind'))}
          />
          <MobileMenuRow
            icon={<FileTxt size={18} />}
            label={t('mindmap:export.exportText')}
            onClick={closeThen(() => onExport('text'))}
          />
          <MobileMenuRow
            icon={<FilePng size={18} />}
            label={t('mindmap:export.exportPng')}
            onClick={closeThen(() => onExport('png'))}
          />
          <MobileMenuRow
            icon={<FileSvg size={18} />}
            label={t('mindmap:export.svgVector')}
            onClick={closeThen(() => onExport('svg'))}
          />
          <MobileMenuRow
            icon={<FilePdf size={18} />}
            label={t('mindmap:export.exportPdf')}
            onClick={closeThen(() => onExport('pdf'))}
          />
        </MobileMenuGroup>
      </CustomScrollArea>
    </div>
  );
};

/**
 * 移动端全屏内联子屏集合（结构 / 样式 / 快捷键 / 更多），
 * 仅在 `< 768px` 视口显示并覆盖内容区。
 */
export const MindMapMobileSubviews: React.FC<MindMapMobileSubviewsProps> = React.memo(
  ({
    resourceId,
    currentView,
    keymap,
    overlayPanel,
    onOverlayPanelChange,
    showMasteryOverlay,
    onOpenSearch,
    onEnterPresentation,
    onToggleMasteryOverlay,
    onStartAssociation,
    onImport,
    onExport,
  }) => {
    const { t } = useTranslation(['mindmap', 'common']);
    const close = useCallback(() => onOverlayPanelChange(null), [onOverlayPanelChange]);

    return (
      <>
        {overlayPanel === 'shortcuts' && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden bg-[var(--mm-bg)]">
            <ShortcutHelpPanel
              mobile
              view={currentView}
              keymap={keymap}
              onClose={close}
            />
          </div>
        )}

        {overlayPanel === 'structure' && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="mm-mobile-subview-header">
              <DsButton
                variant="ghost"
                className="mm-mobile-subview-back"
                onClick={close}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </DsButton>
              <span className="font-medium text-sm">
                {t('mindmap:selectStructure')}
              </span>
            </div>
            <CustomScrollArea
              className="flex-1 min-h-0"
              viewportClassName="mm-mobile-subview-scroll p-2"
            >
              <StructureSelector placement="inline" onSelect={close} />
            </CustomScrollArea>
          </div>
        )}

        {overlayPanel === 'style' && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="mm-mobile-subview-header">
              <DsButton
                variant="ghost"
                className="mm-mobile-subview-back"
                onClick={close}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </DsButton>
              <span className="font-medium text-sm">
                {t('mindmap:toolbar.styleSettings')}
              </span>
            </div>
            <CustomScrollArea
              className="flex-1 min-h-0"
              viewportClassName="mm-mobile-subview-scroll p-2"
            >
              <StyleSettings placement="inline" />
            </CustomScrollArea>
          </div>
        )}

        {overlayPanel === 'more' && (
          <MobileMorePanel
            resourceId={resourceId}
            showMasteryOverlay={showMasteryOverlay}
            onClose={close}
            onOpenMobileStructure={() => onOverlayPanelChange('structure')}
            onOpenMobileStyle={() => onOverlayPanelChange('style')}
            onOpenSearch={onOpenSearch}
            onEnterPresentation={onEnterPresentation}
            onToggleMasteryOverlay={onToggleMasteryOverlay}
            onStartAssociation={onStartAssociation}
            onOpenVersionHistory={() => onOverlayPanelChange('versions')}
            onImport={onImport}
            onExport={onExport}
          />
        )}
      </>
    );
  },
);

MindMapMobileSubviews.displayName = 'MindMapMobileSubviews';
