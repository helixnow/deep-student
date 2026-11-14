import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { exportResourceById } from './utils/exportResource';
import { UnifiedDragDropZone, FILE_TYPES } from '@/components/shared/UnifiedDragDropZone';
import { useDebounce } from '@/hooks/useDebounce';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import {
  useFinderStoreFor,
  type FinderPath,
  type QuickAccessType,
} from './stores/finderStore';
import { useRecentStore } from './stores/recentStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  FinderQuickAccess,
  FinderBatchToolbar,
  FinderQuickLook,
  FolderPickerDialog,
} from './components/finder';
import type { FinderClipboardEntry } from './utils/finderClipboard';
import { dstu, type DstuNode } from '@/dstu';
import { dstuNodeToResourceListItem } from './types';
import type { LearningHubSidebarProps, ResourceListItem } from './types';
import type { ContextMenuTarget } from './components/LearningHubContextMenu';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { ImportProgressModal, type ImportProgressState } from './components/ImportProgressModal';
import { useVfsContextInject } from './hooks';
import {
  CONVERT_MARKDOWN_TO_NOTE_EVENT,
  type ConvertMarkdownToNoteDetail,
  splitLeadingMarkdownHeading,
  markIntentionalRemoval,
  isDragDropBlockedView,
} from './dragDropRouting';
import { getCreatableFolderId } from './viewGuards';
import {
  getFinderPathDisplayPath,
  getQuickAccessTypeFromPath,
  getViewCapabilities,
} from './learningHubContracts';
import { useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import { getSearchPlaceholderKey } from './utils/searchHonesty';
import { CreateLearningNoteDialog } from '@/features/notes/components/CreateLearningNoteDialog';
import { useNotesLearningView } from './components/finder/NotesLearningViewTabs';
import { useExamsView } from './mistakeBook/mistakeBookNavigation';
import {
  CANVAS_BLOCKED_VIEW_KINDS,
  CANVAS_FALLBACK_PATH,
  isPendingFolderId,
  type DeleteConfirmTarget,
  type PendingFolderDraft,
  type SoftDeleteTarget,
} from './sidebar/sidebarConstants';
import { useMemoryFolderDisplay } from './sidebar/useMemoryFolderDisplay';
import { useMobileCreateMenu } from './sidebar/useMobileCreateMenu';
import { refreshCanvasList } from './sidebar/canvasLocalList';
import { useFinderHostLifecycle } from './sidebar/useFinderHostLifecycle';
import { runFinderLoadEffect } from './sidebar/finderLoadEffect';
import { createOpenHandlers } from './sidebar/openHandlers';
import { useDstuWatchRefresh } from './sidebar/useDstuWatchRefresh';
import { subscribeFavoriteCount } from './sidebar/favoriteCount';
import { beginPendingFolderDraft, confirmInlineEdit } from './sidebar/inlineEditActions';
import { createResourceCreators } from './sidebar/resourceCreators';
import { useMarkdownNoteImport, importMarkdownNoteFromDialog } from './sidebar/useMarkdownNoteImport';
import { useQuickAccessNavigation } from './sidebar/useQuickAccessNavigation';
import { importPathsIntoLibrary, importDroppedFiles } from './sidebar/importActions';
import { createContextMenuHandlers } from './sidebar/contextMenuHandlers';
import {
  showSoftDeleteUndo,
  deleteFolderToTrash,
  deleteResourceToTrash,
  executeBatchSoftDelete,
  restoreTrashItem,
  permanentlyDeleteTrashItem,
  emptyTrashBin,
  confirmPendingDelete,
} from './sidebar/trashActions';
import { toggleResourceFavorite, dropOnSpecialTarget } from './sidebar/resourceActions';
import { moveSingleItem, moveMultipleItems, confirmBatchMove, undoLastFinderOperation } from './sidebar/moveActions';
import {
  useClipboardSelection,
  useClipboardPasteActions,
  copyEntriesToFolder,
  type CopySuccessKey,
} from './sidebar/useFinderClipboard';
import { useDropTargets } from './sidebar/useDropTargets';
import { useMultiSelectBridge } from './sidebar/useMultiSelectBridge';
import {
  useSidebarReferenceToChat,
  useMakeCardsAction,
  batchAddSelectionToChat,
} from './sidebar/useSidebarChatActions';
import { handleFinderKeyDown } from './sidebar/finderKeyboardShortcuts';
import { SidebarMobileToolbar } from './sidebar/SidebarMobileToolbar';
import { SidebarCanvasNavBar, SidebarCanvasToolbar } from './sidebar/SidebarCanvasBars';
import { SidebarFinderToolbar } from './sidebar/SidebarFinderToolbar';
import { SidebarContentArea } from './sidebar/SidebarContentArea';
import { SidebarContextMenu } from './sidebar/SidebarContextMenu';
import { AttachImportProgressBanner } from './sidebar/AttachImportProgressBanner';
import { useLearningHubSidebarController } from './useLearningHubSidebarController';


export function LearningHubSidebar(props: LearningHubSidebarProps) {
  const {
    mode,
    onOpenApp,
    onOpenPreview,
    onClose,
    onReferenceToChat,
    className,
    isCollapsed = false,
    onToggleCollapse,
    activeFileId,
    mobileBottomPadding = false,
    hasOpenApp = false,
    onCloseApp,
    hideToolbarAndNav = false,
    quickAccessPortalTarget,
    toolbarPortalTarget,
    toolbarPortalMode = 'window',
    highlightedIds,
    hostId,
    sessionActive,
    commandsEnabled,
    onMultiSelectModeChange,
    multiSelectToggleRef,
  } = props;
  const { addRecent, attachImportProgress, baseQuickAccessType, canAddToChatInCurrentView, canCreateInCurrentView, canDeleteInCurrentView, canDragDropInCurrentView, canInject, canMoveInCurrentView, canPasteHere, canRecordMoveUndo, canSearchInCurrentView, cancelInlineEdit, canvasError, canvasIsLoading, canvasItems, canvasLastSelectedId, canvasRequestIdRef, canvasSearchQuery, canvasSelectedIds, clearSelection, clipboardCount, commandEventsEnabled, containerRef, contextMenuOpen, contextMenuPosition, contextMenuTarget, creatingLearningNote, currentCreatableFolderId, currentPath, currentPathDisplay, currentQuickAccessType, debouncedSearchQuery, deleteConfirmOpen, deleteTarget, displayBreadcrumbs, displayedItems, effectivePath, effectiveQuickAccessCollapsed, ensureCreatableView, enterCanvasFolder, enterFolder, error, examsMistakesActive, examsView, executeBatchDelete, executeCopyEntries, executeEmptyTrash, executePermanentDelete, favoriteCount, finderRefresh, finderStore, focusSearchInput, getItemDisplayName, getSelectedNodes, goBack, goCanvasBack, goCanvasForward, goCanvasUp, goForward, goUp, handleBatchAddToChat, handleBatchDelete, handleBatchMove, handleBatchMoveConfirm, handleClearSelection, handleConfirmDelete, handleContainerContextMenu, handleContextMenu, handleCopyFromContextMenu, handleCopySelection, handleDeleteFolder, handleDeleteResource, handleDuplicateFromContextMenu, handleDuplicateSelection, handleEmptyStateCreate, handleEmptyTrash, handleExportFolder, handleExportResource, handleFilesDrop, handleImportMarkdownNote, handleInlineEditCancel, handleInlineEditConfirm, handleMakeCards, handleMoveItem, handleMoveItems, handleMoveTo, handleNewEssay, handleNewExam, handleNewFolder, handleNewMindMap, handleNewNote, handleNewTextbook, handleNewTranslation, handleOpen, handleOpenFolder, handleOpenMany, handleOpenRenameDialog, handleOpenRenameResourceDialog, handlePaste, handlePathsDrop, handlePermanentDeleteItem, handleQuickAccessNavigate, handleQuickLookOpen, handleReferenceToChat, handleRefresh, handleRestoreItem, handleSelectAll, handleSilentRefresh, handleSpecialDrop, handleToggleFavorite, handleUndoLastOperation, history, historyIndex, importMarkdownFileObjects, importMarkdownPathNotes, importPaths, importProgress, injectToChat, inlineEdit, isBatchProcessing, isCanvasPathBlocked, isDeleting, isDragDropEnabled, isInMemoryFolder, isInjecting, isLearningHubViewActive, isLoading, isMountedRef, isMultiSelectMode, isSearching, isSmallScreen, isTouchPrimary, isTrashView, items, jumpCanvasToBreadcrumb, jumpToBreadcrumb, lastLoadSignatureRef, memoryTreeView, mobileCreateMenuOpen, mobileCreateMenuTriggerRef, mobileSearchExpanded, moveDialogOpen, moveTargetIds, moveUndoSourceFolderId, multiSelectActive, navigateCanvasQuickAccess, navigateCanvasTo, navigateTo, notesLearningView, notifyMarkdownImportResult, openImportedMarkdownNote, parentDropTargets, pathsDropHandledRef, pendingFolderDraft, pendingFolderDraftRef, pendingFolderSequenceRef, queryItemsForPath, quickAccessCollapsed, quickAccessNavigate, quickAccessNode, quickLookItem, refreshCanvas, resetCanvasLocalSelection, resetCanvasLocalState, resolveContextTargetNodes, searchMeta, searchPlaceholder, searchQuery, select, selectAll, selectedIds, setAttachImportProgress, setCanvasError, setCanvasIsLoading, setCanvasItems, setCanvasLastSelectedId, setCanvasSearchQuery, setCanvasSelectedIds, setContextMenuOpen, setContextMenuPosition, setContextMenuTarget, setCreatingLearningNote, setDeleteConfirmOpen, setDeleteTarget, setExamsView, setFavoriteCount, setImportProgress, setIsBatchProcessing, setIsDeleting, setIsMultiSelectMode, setMemoryTreeView, setMobileCreateMenuOpen, setMobileSearchExpanded, setMoveDialogOpen, setMoveTargetIds, setNotesLearningView, setPendingFolderDraft, setQuickAccessCollapsed, setQuickLookItem, setSearchQuery, setSelectedIds, setSorting, setViewMode, shouldRenderQuickAccess, showSoftDeleteUndoToast, softDeleteUndoGenRef, softDeleteUndoInFlightRef, sortBy, sortOrder, specialDropTargets, startInlineEdit, storeClearSelection, storeCurrentPath, storeEnterFolder, storeError, storeGoBack, storeGoForward, storeGoUp, storeHistory, storeHistoryIndex, storeIsLoading, storeItems, storeJumpToBreadcrumb, storeNavigateTo, storeQuickAccessNavigate, storeSearchQuery, storeSelect, storeSelectAll, storeSelectedIds, storeSetSearchQuery, storeSetSelectedIds, t, toggleMultiSelect, viewCapabilities, viewMode } = useLearningHubSidebarController(props);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 overflow-hidden',
        isSmallScreen && mode === 'fullscreen'
          ? 'bg-background'
          : 'study-shell-sidebar-frame',
        className,
      )}
      tabIndex={-1}
    >
      {/* 左侧快速导航；移动端由 LearningHubPage portal 到统一抽屉。 */}
      {quickAccessPortalTarget && quickAccessNode
        ? createPortal(quickAccessNode, quickAccessPortalTarget)
        : quickAccessNode}

      {/* 右侧：工具栏 + 文件列表（包裹拖拽导入区域） */}
      <UnifiedDragDropZone
        zoneId="learning-hub-finder"
        onFilesDropped={handleFilesDrop}
        onPathsDropped={handlePathsDrop}
        enabled={isDragDropEnabled}
        acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT, FILE_TYPES.CODE]}
        maxFiles={20}
        maxFileSize={200 * 1024 * 1024}
        customOverlayText={t('finder.dragDrop.overlayText')}
        className="flex-1 flex flex-col min-w-0 min-h-0"
      >
        {/* P1-20: 移动端顶部工具栏（搜索 + 新建文件夹 + 新建笔记 + 清空回收站；canvas 模式不叠渲染） */}
        {isSmallScreen && mode !== 'canvas' && !hideToolbarAndNav && (
          <SidebarMobileToolbar
            t={t}
            mobileSearchExpanded={mobileSearchExpanded}
            setMobileSearchExpanded={setMobileSearchExpanded}
            searchPlaceholder={searchPlaceholder}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            canSearchInCurrentView={canSearchInCurrentView}
            mobileCreateMenuOpen={mobileCreateMenuOpen}
            setMobileCreateMenuOpen={setMobileCreateMenuOpen}
            mobileCreateMenuTriggerRef={mobileCreateMenuTriggerRef}
            canCreateInCurrentView={canCreateInCurrentView}
            handleNewFolder={handleNewFolder}
            handleNewNote={handleNewNote}
            setCreatingLearningNote={setCreatingLearningNote}
            handleImportMarkdownNote={handleImportMarkdownNote}
            handleNewExam={handleNewExam}
            handleNewTextbook={handleNewTextbook}
            handleNewTranslation={handleNewTranslation}
            handleNewEssay={handleNewEssay}
            handleNewMindMap={handleNewMindMap}
            isTrashView={isTrashView}
            handleEmptyTrash={handleEmptyTrash}
            items={items}
          />
        )}

        {/* ★ Canvas 模式导航栏：仅在进入子目录或存在历史记录时渲染，消除根目录双顶栏堆叠 */}
        {mode === 'canvas' && !hideToolbarAndNav && (displayBreadcrumbs.length > 0 || historyIndex > 0 || history.length > 1) && (
          <SidebarCanvasNavBar
            t={t}
            isSmallScreen={isSmallScreen}
            goBack={goBack}
            goForward={goForward}
            historyIndex={historyIndex}
            history={history}
            jumpToBreadcrumb={jumpToBreadcrumb}
            displayBreadcrumbs={displayBreadcrumbs}
          />
        )}

        {/* ★ Canvas 模式顶部工具栏：多选模式 + 关闭按钮。
            移动端聊天内嵌（hideToolbarAndNav）不渲染此条：面板完全使用全局
            顶栏，多选切换按钮由 ChatV2Page 放到全局顶栏右上角。 */}
        {mode === 'canvas' && !hideToolbarAndNav && (
          <SidebarCanvasToolbar
            t={t}
            isSmallScreen={isSmallScreen}
            isMultiSelectMode={isMultiSelectMode}
            selectedIds={selectedIds}
            items={items}
            handleClearSelection={handleClearSelection}
            handleSelectAll={handleSelectAll}
            canAddToChatInCurrentView={canAddToChatInCurrentView}
            handleBatchAddToChat={handleBatchAddToChat}
            isBatchProcessing={isBatchProcessing}
            isInjecting={isInjecting}
            toggleMultiSelect={toggleMultiSelect}
            onClose={onClose}
          />
        )}

        {!isSmallScreen && mode === 'fullscreen' && !hideToolbarAndNav && (
          <SidebarFinderToolbar
            t={t}
            displayBreadcrumbs={displayBreadcrumbs}
            jumpToBreadcrumb={jumpToBreadcrumb}
            currentQuickAccessType={currentQuickAccessType}
            historyIndex={historyIndex}
            history={history}
            goBack={goBack}
            goForward={goForward}
            viewMode={viewMode}
            setViewMode={setViewMode}
            sortBy={sortBy}
            sortOrder={sortOrder}
            setSorting={setSorting}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchPlaceholder={searchPlaceholder}
            canSearchInCurrentView={canSearchInCurrentView}
            canCreateInCurrentView={canCreateInCurrentView}
            handleNewFolder={handleNewFolder}
            handleRefresh={handleRefresh}
            quickAccessPortalTarget={quickAccessPortalTarget}
            handleNewNote={handleNewNote}
            setCreatingLearningNote={setCreatingLearningNote}
            handleImportMarkdownNote={handleImportMarkdownNote}
            handleNewExam={handleNewExam}
            handleNewTextbook={handleNewTextbook}
            handleNewTranslation={handleNewTranslation}
            handleNewEssay={handleNewEssay}
            handleNewMindMap={handleNewMindMap}
            toolbarPortalTarget={toolbarPortalTarget}
            toolbarPortalMode={toolbarPortalMode}
          />
        )}

        {/* ★ 2026-01-15: 向量化状态视图 */}
        {/* ★ 2026-01-19: VFS 记忆管理视图 */}
        {/* ★ 2026-01-31: 桌面视图 */}
        <SidebarContentArea
          t={t}
          effectivePath={effectivePath}
          currentPath={currentPath}
          mode={mode}
          onOpenApp={onOpenApp}
          activeFileId={activeFileId}
          highlightedIds={highlightedIds}
          isCollapsed={isCollapsed}
          isSmallScreen={isSmallScreen}
          isMountedRef={isMountedRef}
          items={items}
          displayedItems={displayedItems}
          isLoading={isLoading}
          error={error}
          viewMode={viewMode}
          selectedIds={selectedIds}
          multiSelectActive={multiSelectActive}
          isMultiSelectMode={isMultiSelectMode}
          isSearching={isSearching}
          searchMeta={searchMeta}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          debouncedSearchQuery={debouncedSearchQuery}
          currentQuickAccessType={currentQuickAccessType}
          isInMemoryFolder={isInMemoryFolder}
          memoryTreeView={memoryTreeView}
          setMemoryTreeView={setMemoryTreeView}
          notesLearningView={notesLearningView}
          setNotesLearningView={setNotesLearningView}
          examsView={examsView}
          setExamsView={setExamsView}
          examsMistakesActive={examsMistakesActive}
          canCreateInCurrentView={canCreateInCurrentView}
          canDragDropInCurrentView={canDragDropInCurrentView}
          isTrashView={isTrashView}
          inlineEdit={inlineEdit}
          handleQuickAccessNavigate={handleQuickAccessNavigate}
          handleOpen={handleOpen}
          handleOpenMany={handleOpenMany}
          enterFolder={enterFolder}
          navigateTo={navigateTo}
          goUp={goUp}
          handleRefresh={handleRefresh}
          select={select}
          clearSelection={clearSelection}
          setSelectedIds={setSelectedIds}
          handleContextMenu={handleContextMenu}
          handleContainerContextMenu={handleContainerContextMenu}
          handleEmptyStateCreate={handleEmptyStateCreate}
          handleMoveItem={handleMoveItem}
          handleMoveItems={handleMoveItems}
          handleInlineEditConfirm={handleInlineEditConfirm}
          handleInlineEditCancel={handleInlineEditCancel}
          startInlineEdit={startInlineEdit}
          getItemDisplayName={getItemDisplayName}
          parentDropTargets={parentDropTargets}
          specialDropTargets={specialDropTargets}
          handleSpecialDrop={handleSpecialDrop}
        />
      
        {creatingLearningNote && (
          <CreateLearningNoteDialog
            folderId={effectivePath.viewKind === 'folder' ? effectivePath.folderId : null}
            onClose={() => setCreatingLearningNote(false)}
            onCreated={(node) => { void handleRefresh(); onOpenApp?.(dstuNodeToResourceListItem(node, 'note')); }}
          />
        )}
        {/* Batch Operation Toolbar + View Mode Toggle + App Close
            canvas / 特殊系统视图（索引状态、记忆、桌面）不显示文件列表底栏，避免「0 个项目」错位 */}
        {mode === 'canvas' || effectivePath.viewKind === 'indexStatus' || effectivePath.viewKind === 'memory' || effectivePath.viewKind === 'desktop' ? null : (
          <FinderBatchToolbar
            selectedCount={selectedIds.size}
            totalCount={items.length}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onBatchDelete={canDeleteInCurrentView ? handleBatchDelete : undefined}
            onBatchMove={canMoveInCurrentView ? handleBatchMove : undefined}
            onBatchAddToChat={canAddToChatInCurrentView ? handleBatchAddToChat : undefined}
            isTrashView={isTrashView}
            isProcessing={isBatchProcessing || isInjecting}
            viewMode={isCollapsed ? 'list' : viewMode}
            onViewModeChange={isSmallScreen && !isCollapsed ? setViewMode : undefined}
            multiSelectMode={isMultiSelectMode}
            onToggleMultiSelectMode={
              isTouchPrimary
                ? () => {
                    if (isMultiSelectMode) {
                      setIsMultiSelectMode(false);
                      handleClearSelection();
                    } else {
                      setIsMultiSelectMode(true);
                    }
                  }
                : undefined
            }
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={isSmallScreen ? setSorting : undefined}
            hasOpenApp={!isSmallScreen && hasOpenApp}
            onCloseApp={onCloseApp}
          />
        )}
      </UnifiedDragDropZone>

      {/* Context Menu - canvas 模式禁用 */}
      <SidebarContextMenu
        mode={mode}
        contextMenuOpen={contextMenuOpen}
        setContextMenuOpen={setContextMenuOpen}
        contextMenuPosition={contextMenuPosition}
        contextMenuTarget={contextMenuTarget}
        effectivePath={effectivePath}
        isTrashView={isTrashView}
        canCreateInCurrentView={canCreateInCurrentView}
        canDeleteInCurrentView={canDeleteInCurrentView}
        canMoveInCurrentView={canMoveInCurrentView}
        canAddToChatInCurrentView={canAddToChatInCurrentView}
        handleNewFolder={handleNewFolder}
        handleNewNote={handleNewNote}
        handleNewExam={handleNewExam}
        handleNewTextbook={handleNewTextbook}
        handleNewTranslation={handleNewTranslation}
        handleNewEssay={handleNewEssay}
        handleNewMindMap={handleNewMindMap}
        handleImportMarkdownNote={handleImportMarkdownNote}
        handleRefresh={handleRefresh}
        handleOpenFolder={handleOpenFolder}
        handleOpenRenameDialog={handleOpenRenameDialog}
        selectedIds={selectedIds}
        handleBatchDelete={handleBatchDelete}
        handleDeleteFolder={handleDeleteFolder}
        onOpenApp={onOpenApp}
        handleOpenRenameResourceDialog={handleOpenRenameResourceDialog}
        handleDeleteResource={handleDeleteResource}
        handleToggleFavorite={handleToggleFavorite}
        handleCopyFromContextMenu={handleCopyFromContextMenu}
        canPasteHere={canPasteHere}
        handleDuplicateFromContextMenu={handleDuplicateFromContextMenu}
        handlePaste={handlePaste}
        clipboardCount={clipboardCount}
        handleExportResource={handleExportResource}
        handleExportFolder={handleExportFolder}
        handleRestoreItem={handleRestoreItem}
        handlePermanentDeleteItem={handlePermanentDeleteItem}
        handleEmptyTrash={handleEmptyTrash}
        handleReferenceToChat={handleReferenceToChat}
        handleMakeCards={handleMakeCards}
        handleMoveTo={handleMoveTo}
      />
      
      {/* Folder Picker for Batch Move
          移动端契约：走 inline 全屏子屏（挂在中屏容器 absolute inset-0），桌面保留 Dialog */}
      <FolderPickerDialog
        open={moveDialogOpen}
        onOpenChange={(open) => {
          setMoveDialogOpen(open);
          if (!open) setMoveTargetIds(null);
        }}
        excludeFolderIds={Array.from<string>(moveTargetIds ?? selectedIds).filter(id =>
          items.find(i => i.id === id)?.type === 'folder'
        )}
        onConfirm={handleBatchMoveConfirm}
        title={t('finder.batch.moveDialogTitle')}
        inline={isSmallScreen}
      />

      {/* ★ 删除确认对话框 - 替代原生 window.confirm */}
      <DsAlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteConfirmOpen(false);
            setDeleteTarget(null);
          }
        }}
        title={
          deleteTarget?.type === 'emptyTrash'
            ? t('finder.trash.emptyTitle')
            : t('contextMenu.deleteTitle')
        }
        description={deleteTarget?.message}
        confirmText={isDeleting ? t('common:actions.deleting') : t('common:delete')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        loading={isDeleting}
        disabled={isDeleting}
        onConfirm={handleConfirmDelete}
      />

      {/* Rename Dialog - Replaced with Inline Editing */}

      {/* ★ Quick Look：空格快速预览浮层（空格/Esc/点遮罩关闭） */}
      {quickLookItem && (
        <FinderQuickLook
          item={quickLookItem}
          onClose={() => setQuickLookItem(null)}
          onOpen={handleQuickLookOpen}
        />
      )}

      {/* ★ 教材导入进度模态框 */}
      <ImportProgressModal
        state={importProgress}
        onClose={() => setImportProgress(prev => ({ ...prev, isImporting: false }))}
      />

      {/* ★ 2026-06-12（审阅问题 FE-M5）：附件批量导入进度横幅（非模态，不阻塞操作） */}
      {attachImportProgress && (
        <AttachImportProgressBanner t={t} attachImportProgress={attachImportProgress} />
      )}
    </div>
  );
}
