import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
// 初始化思维导图模块（注册布局、样式、预设）
import './init';
import { useMindMapStore } from './store';
import { MindMapErrorBoundary } from './MindMapErrorBoundary';
import { StyleRegistry } from './registry';
import { exportToOpml, exportToMarkdown, exportToJson, exportToImage } from './utils/exporters';
import { importMindMap } from './utils/importers';
import { fileManager } from '@/utils/fileManager';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  FileText,
  GitBranch,
  Save,
  Download,
  Upload,
  MoreHorizontal,
  Undo2,
  Redo2,
  Search,
  X,
  ChevronUp,
  ChevronDown,
  Keyboard,
  AlertCircle,
  RefreshCw,
  Settings2,
  BookOpen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { OutlineView } from './views/OutlineView';
import { MindMapView } from './views/MindMapView';
import { StructureSelector } from './components/mindmap/StructureSelector';
import { StyleSettings } from './components/toolbar/StylePanel';
import { ReciteStatusBar } from './components/shared/ReciteStatusBar';
import { Progress } from '@/components/ui/shad/Progress';
import './mindmap.css';

interface MindMapContentViewProps {
  resourceId?: string;
  onTitleChange?: (title: string) => void;
  className?: string;
}

export const MindMapContentView: React.FC<MindMapContentViewProps> = ({
  resourceId,
  onTitleChange,
  className
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  
  // 从新 store 获取状态
  const currentView = useMindMapStore(state => state.currentView);
  const setCurrentView = useMindMapStore(state => state.setCurrentView);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const setReciteMode = useMindMapStore(state => state.setReciteMode);
  const mindmapDocument = useMindMapStore(state => state.document);
  const isDirty = useMindMapStore(state => state.isDirty);
  const isSaving = useMindMapStore(state => state.isSaving);
  const isExporting = useMindMapStore(state => state.isExporting);
  const exportProgress = useMindMapStore(state => state.exportProgress);
  const save = useMindMapStore(state => state.save);
  const loadMindMap = useMindMapStore(state => state.loadMindMap);
  const undo = useMindMapStore(state => state.undo);
  const redo = useMindMapStore(state => state.redo);
  const canUndo = useMindMapStore(state => state.canUndo);
  const canRedo = useMindMapStore(state => state.canRedo);
  
  // 搜索
  const searchFn = useMindMapStore(state => state.search);
  const searchResults = useMindMapStore(state => state.searchResults);
  const currentSearchIndex = useMindMapStore(state => state.currentSearchIndex);
  const nextSearchResult = useMindMapStore(state => state.nextSearchResult);
  const prevSearchResult = useMindMapStore(state => state.prevSearchResult);
  const clearSearch = useMindMapStore(state => state.clearSearch);
  const setDocument = useMindMapStore(state => state.setDocument);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  
  // 获取当前主题（用于导出时设置背景色）
  const styleId = useMindMapStore(state => state.styleId);
  const currentTheme = useMemo(() => StyleRegistry.get(styleId) || StyleRegistry.getDefault(), [styleId]);
  
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const lastTitleRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 工具栏面板互斥状态：同一时间只允许打开一个面板
  const [activePanel, setActivePanel] = useState<'structure' | 'style' | 'export' | 'more' | null>(null);

  // 移动端悬浮面板状态
  const [showMobileStructure, setShowMobileStructure] = useState(false);
  const [showMobileStyle, setShowMobileStyle] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);

  const tryLoadMindMap = useCallback(async () => {
    if (!resourceId) return;

    setIsLoadingDoc(true);
    setLoadError(null);
    try {
      await loadMindMap(resourceId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('mindmap:loadError');
      setLoadError(message);
      showGlobalNotification('error', message, t('mindmap:loadErrorTitle'));
      console.error('[MindMapContentView] Failed to load mindmap:', err);
    } finally {
      setIsLoadingDoc(false);
    }
  }, [resourceId, loadMindMap]);

  // 加载文档
  useEffect(() => {
    void tryLoadMindMap();
  }, [tryLoadMindMap]);

  // 同步标题变更到外部
  useEffect(() => {
    if (!onTitleChange) return;
    const title = mindmapDocument?.root?.text ?? '';
    if (lastTitleRef.current !== title) {
      lastTitleRef.current = title;
      onTitleChange(title);
    }
  }, [mindmapDocument?.root?.text, onTitleChange]);

  const handleExport = useCallback(async (format: string) => {
    if (!mindmapDocument) return;
    
    const filename = mindmapDocument.root.text || 'mindmap';
    
    // 图片导出需要特殊处理：必须在思维导图视图才能导出
    if (format === 'png' || format === 'svg') {
      if (currentView !== 'mindmap') {
        showGlobalNotification(
          'warning',
          t('mindmap:export.switchToMindMapView')
        );
        return;
      }
      try {
        // ★ 修复：使用当前主题的背景色；传入容器 ref 避免多实例导出错误
        const backgroundColor = currentTheme?.canvas?.background || '#ffffff';
        await exportToImage({ format: format as 'png' | 'svg', filename, backgroundColor, container: containerRef.current });
      } catch (error: unknown) {
        console.error('Image export failed:', error);
        showGlobalNotification(
          'error',
          t('mindmap:export.failed')
        );
      }
      return;
    }
    
    let content = '';
    let ext = '.txt';
    let filterName = t('mindmap:export.filterText');
    let filterExt = 'txt';
    let dialogTitle = t('mindmap:export.exportFile');
    
    switch (format) {
      case 'opml':
        content = exportToOpml(mindmapDocument);
        ext = '.opml';
        filterName = t('mindmap:export.filterOpml');
        filterExt = 'opml';
        dialogTitle = t('mindmap:export.dialogExportOpml');
        break;
      case 'markdown':
        content = exportToMarkdown(mindmapDocument);
        ext = '.md';
        filterName = t('mindmap:export.filterMarkdown');
        filterExt = 'md';
        dialogTitle = t('mindmap:export.dialogExportMarkdown');
        break;
      case 'json':
        content = exportToJson(mindmapDocument);
        ext = '.json';
        filterName = t('mindmap:export.filterJson');
        filterExt = 'json';
        dialogTitle = t('mindmap:export.dialogExportJson');
        break;
      default:
        return;
    }
    
    try {
      // 使用 Tauri 文件对话框让用户选择保存位置
      const result = await fileManager.saveTextFile({
        title: dialogTitle,
        defaultFileName: filename + ext,
        content,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      
      if (result.canceled) {
        return; // 用户取消导出
      }
    } catch (error: unknown) {
      console.error('Export failed:', error);
        showGlobalNotification(
          'error',
          t('mindmap:export.failed')
        );
    }
  }, [mindmapDocument, currentView, t, currentTheme]);

  const handleImport = useCallback(async () => {
    try {
      // M-073: 导入前检查是否有未保存的修改
      const currentState = useMindMapStore.getState();
      if (currentState.isDirty) {
        const confirmed = window.confirm(t('mindmap:import.unsavedWarning'));
        if (!confirmed) return;
      }

      const filePath = await fileManager.pickSingleFile({
        title: t('mindmap:import.dialogTitle'),
        filters: [
          { name: t('mindmap:import.filterName'), extensions: ['opml', 'md', 'markdown', 'json'] },
        ],
      });

      if (!filePath) return;

      const content = await fileManager.readTextFile(filePath);
      const imported = importMindMap(content, 'auto');
      setDocument(imported);
      setFocusedNodeId(imported.root.id);
      showGlobalNotification('success', t('mindmap:import.success'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('mindmap:import.failed');
      showGlobalNotification('error', message, t('mindmap:import.failedTitle'));
    }
  }, [setDocument, setFocusedNodeId, t]);

  const handleSave = useCallback(() => {
    save();
  }, [save]);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const isTextInputContext =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // 画布视图下 undo/redo/save 由 useMindMapKeyboard hook 处理，避免重复触发
      if (currentView !== 'mindmap' && !isTextInputContext) {
        if (isMod && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (canUndo()) undo();
        }
        if (isMod && (e.key === 'Z' || e.key === 'y')) {
          e.preventDefault();
          if (canRedo()) redo();
        }
        if (isMod && e.key === 's') {
          e.preventDefault();
          if (isDirty && !isSaving) save();
        }
      }

      if (isMod && e.key === 'f' && !isTextInputContext) {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
        clearSearch();
        setSearchInput('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, canUndo, canRedo, save, isDirty, isSaving, showSearch, clearSearch, currentView]);

  // M-069: 组件卸载时同步保存草稿到 localStorage，防止异步 save 未完成导致数据丢失
  // loadMindMap 时会自动检查并恢复本地草稿
  useEffect(() => {
    return () => {
      useMindMapStore.getState().saveDraftSync();
    };
  }, []);

  useEffect(() => {
    const flushPendingChanges = () => {
      const state = useMindMapStore.getState();
      // M-069: 先同步写入 localStorage 草稿，确保即使异步 save 未完成也不丢失
      state.saveDraftSync();
      if (state.isDirty && !state.isSaving) {
        void state.save();
      }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = useMindMapStore.getState();
      if (state.isDirty) {
        flushPendingChanges();
        event.preventDefault();
        event.returnValue = '';
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingChanges();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', flushPendingChanges);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', flushPendingChanges);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 错误边界重置处理
  const handleErrorReset = useCallback(() => {
    void tryLoadMindMap();
  }, [tryLoadMindMap]);

  return (
    <MindMapErrorBoundary onReset={handleErrorReset} fallbackMessage={t('mindmap:errorBoundary')}>
    <div ref={containerRef} className={cn("flex flex-col h-full w-full bg-[var(--mm-bg)] mindmap-container", className)}>
      {/* Notion-style Topbar */}
      <div className="notion-topbar">
        {/* Left: View Switcher & Undo/Redo */}
        <div className="flex items-center gap-3">
          {/* View Switcher - Segmented Control with sliding indicator */}
          <div className="relative flex items-center bg-[var(--mm-bg-hover)] p-[3px] rounded-lg">
            {/* Sliding background pill */}
            <div
              className="absolute top-[3px] bottom-[3px] rounded-md bg-[var(--mm-bg-elevated)] shadow-sm border border-[var(--mm-border)] transition-all duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]"
              style={{
                left: currentView === 'outline' ? '3px' : '50%',
                right: currentView === 'mindmap' ? '3px' : '50%',
              }}
            />
            <NotionButton variant="ghost"
              className={cn(
                "relative z-[1] flex items-center justify-center px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200 !bg-transparent hover:!bg-transparent active:!bg-transparent",
                currentView === 'outline'
                  ? "text-[var(--mm-text)]"
                  : "text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]"
              )}
              onClick={() => setCurrentView('outline')}
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {t('mindmap:toolbar.outline')}
            </NotionButton>
            <NotionButton variant="ghost"
              className={cn(
                "relative z-[1] flex items-center justify-center px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200 !bg-transparent hover:!bg-transparent active:!bg-transparent",
                currentView === 'mindmap'
                  ? "text-[var(--mm-text)]"
                  : "text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]"
              )}
              onClick={() => setCurrentView('mindmap')}
            >
              <GitBranch className="w-3.5 h-3.5 mr-1.5" />
              {t('mindmap:toolbar.mindmap')}
            </NotionButton>
          </div>
          
          <div className="w-px h-4 bg-[var(--mm-border)]" />
          
          <div className="flex items-center gap-0.5">
             <NotionButton variant="ghost" 
              className="notion-btn" 
              onClick={undo} 
              disabled={!canUndo()}
              title={t('mindmap:toolbar.undoShortcut')}
              aria-label={t('mindmap:toolbar.undo')}
            >
              <Undo2 className="w-4 h-4" />
            </NotionButton>
            <NotionButton variant="ghost" 
              className="notion-btn" 
              onClick={redo} 
              disabled={!canRedo()}
              title={t('mindmap:toolbar.redoShortcut')}
              aria-label={t('mindmap:toolbar.redo')}
            >
              <Redo2 className="w-4 h-4" />
            </NotionButton>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Desktop: Structure Selector */}
          <StructureSelector 
            className="hidden sm:flex"
            open={activePanel === 'structure'}
            onOpenChange={(open) => setActivePanel(open ? 'structure' : null)}
            trigger={
              <NotionButton variant="ghost" className="notion-btn" title={t('mindmap:toolbar.switchStructure')}>
                <GitBranch className="w-4 h-4" />
                <span className="text-xs">{t('mindmap:toolbar.structure')}</span>
                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
              </NotionButton>
            }
          />

          {/* Desktop: Style Settings */}
          <StyleSettings
            className="hidden sm:flex"
            open={activePanel === 'style'}
            onOpenChange={(open) => setActivePanel(open ? 'style' : null)}
            trigger={
              <NotionButton variant="ghost" className="notion-btn" title={t('mindmap:toolbar.styleSettings')}>
                <Settings2 className="w-4 h-4" />
                <span className="text-xs">{t('mindmap:toolbar.style')}</span>
                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
              </NotionButton>
            }
          />

          <div className="w-px h-4 bg-[var(--mm-border)] mx-1 hidden sm:block" />

          {/* Desktop: Recite Mode Toggle */}
          <NotionButton variant="ghost"
            className={cn("notion-btn hidden sm:flex", reciteMode && "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400")}
            onClick={() => setReciteMode(!reciteMode)}
            title={t('mindmap:recite.enter')}
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-xs">{t('mindmap:recite.title')}</span>
          </NotionButton>

          {/* Desktop: Search Toggle */}
          <NotionButton variant="ghost" 
            className={cn("notion-btn hidden sm:flex", showSearch && "bg-[var(--mm-bg-active)]")}
            onClick={() => setShowSearch(!showSearch)}
            title={t('mindmap:toolbar.searchShortcut')}
          >
            <Search className="w-4 h-4" />
            <span className="text-xs">{t('mindmap:toolbar.search')}</span>
          </NotionButton>

          {/* Desktop: Export Menu */}
          <AppMenu open={activePanel === 'export'} onOpenChange={(open) => setActivePanel(open ? 'export' : null)}>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" className="notion-btn hidden sm:flex">
                <Download className="w-4 h-4" />
                <span className="text-xs">{t('mindmap:export.title')}</span>
                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={180}>
              <AppMenuItem icon={<Upload className="w-4 h-4" />} onClick={handleImport}>
                {t('mindmap:import.title')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('markdown')}>
                Markdown
              </AppMenuItem>
              <AppMenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('opml')}>
                OPML
              </AppMenuItem>
              <AppMenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('json')}>
                JSON
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Download className="w-4 h-4" />} onClick={() => handleExport('png')}>
                {t('mindmap:export.pngImage')}
              </AppMenuItem>
              <AppMenuItem icon={<Download className="w-4 h-4" />} onClick={() => handleExport('svg')}>
                {t('mindmap:export.svgVector')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>

          <div className="w-px h-4 bg-[var(--mm-border)] mx-1 hidden sm:block" />

          {/* Desktop: More Menu (simplified) */}
          <AppMenu open={activePanel === 'more'} onOpenChange={(open) => setActivePanel(open ? 'more' : null)}>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" className="notion-btn w-7 justify-center px-0 hidden sm:flex" aria-label={t('mindmap:toolbar.moreActions')} title={t('mindmap:toolbar.moreActions')}>
                <MoreHorizontal className="w-4 h-4" />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={180}>
              <AppMenuItem icon={<Save className="w-4 h-4" />} onClick={handleSave} disabled={!isDirty || isSaving}>
                {isSaving ? t('mindmap:toolbar.saving') : isDirty ? t('mindmap:toolbar.save') : t('mindmap:toolbar.saved')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Keyboard className="w-4 h-4" />} onClick={() => setShowShortcutHelp(true)}>
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>

          {/* Mobile: Unified More Menu */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" className="notion-btn w-7 justify-center px-0 sm:hidden" aria-label={t('mindmap:toolbar.moreActions')} title={t('mindmap:toolbar.moreActions')}>
                <MoreHorizontal className="w-4 h-4" />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={180}>
              <AppMenuItem icon={<GitBranch className="w-4 h-4" />} onClick={() => setShowMobileStructure(true)}>
                {t('mindmap:toolbar.structure')}
              </AppMenuItem>
              <AppMenuItem icon={<Settings2 className="w-4 h-4" />} onClick={() => setShowMobileStyle(true)}>
                {t('mindmap:toolbar.style')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Search className="w-4 h-4" />} onClick={() => setShowSearch(!showSearch)}>
                {t('mindmap:toolbar.search')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Upload className="w-4 h-4" />} onClick={handleImport}>
                {t('mindmap:import.title')}
              </AppMenuItem>
              <AppMenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('markdown')}>
                {t('mindmap:export.exportMarkdown')}
              </AppMenuItem>
              <AppMenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('opml')}>
                {t('mindmap:export.exportOpml')}
              </AppMenuItem>
              <AppMenuItem icon={<Download className="w-4 h-4" />} onClick={() => handleExport('png')}>
                {t('mindmap:export.exportPng')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Keyboard className="w-4 h-4" />} onClick={() => setShowShortcutHelp(true)}>
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
              <AppMenuItem icon={<Save className="w-4 h-4" />} onClick={handleSave} disabled={!isDirty || isSaving}>
                {isSaving ? t('mindmap:toolbar.saving') : isDirty ? t('mindmap:toolbar.save') : t('mindmap:toolbar.saved')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        </div>
      </div>

      {showSearch && (
        <div className="flex items-center gap-2 h-10 px-4 border-b border-[var(--mm-border)] bg-[var(--mm-bg)] animate-in slide-in-from-top-1 duration-200">
          <Search className="w-4 h-4 text-[var(--mm-text-muted)]" />
          <input
            className="flex-1 h-full bg-transparent border-none outline-none text-sm placeholder-[var(--mm-text-muted)]"
            placeholder={t('mindmap:toolbar.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              searchFn(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) {
                  prevSearchResult();
                } else {
                  nextSearchResult();
                }
              }
            }}
            autoFocus
          />
          
          {searchResults.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-[var(--mm-text-secondary)]">
              <span>{currentSearchIndex + 1} / {searchResults.length}</span>
              <div className="flex items-center border border-[var(--mm-border)] rounded overflow-hidden">
                <NotionButton variant="ghost" 
                  className="p-1 hover:bg-[var(--mm-bg-hover)]"
                  onClick={prevSearchResult}
                  aria-label={t('mindmap:toolbar.prevResult')}
                >
                  <ChevronUp className="w-3 h-3" />
                </NotionButton>
                <div className="w-px h-4 bg-[var(--mm-border)]" />
                <NotionButton variant="ghost" 
                  className="p-1 hover:bg-[var(--mm-bg-hover)]"
                  onClick={nextSearchResult}
                  aria-label={t('mindmap:toolbar.nextResult')}
                >
                  <ChevronDown className="w-3 h-3" />
                </NotionButton>
              </div>
            </div>
          )}
          
          <NotionButton variant="ghost" 
            className="p-1 hover:bg-[var(--mm-bg-hover)] rounded text-[var(--mm-text-secondary)]"
            aria-label={t('mindmap:toolbar.closeSearch')}
            onClick={() => {
              setShowSearch(false);
              clearSearch();
              setSearchInput('');
            }}
          >
            <X className="w-4 h-4" />
          </NotionButton>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative bg-[var(--mm-bg)]">
        {/* 背诵模式状态条（两个视图共享） */}
        <ReciteStatusBar />
        {isLoadingDoc ? (
          <div className="h-full w-full flex items-center justify-center text-sm text-[var(--mm-text-muted)]">
            {t('mindmap:loading')}
          </div>
        ) : loadError ? (
          <div className="h-full w-full flex items-center justify-center p-6">
            <div className="max-w-md w-full rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-5 text-center shadow-sm">
              <AlertCircle className="w-8 h-8 mx-auto mb-3 text-red-500" />
              <p className="text-sm font-medium text-[var(--mm-text)] mb-2">{t('mindmap:loadFailed')}</p>
              <p className="text-xs text-[var(--mm-text-muted)] break-words">{loadError}</p>
              <NotionButton variant="ghost"
                className="notion-btn mt-4 mx-auto"
                onClick={() => void tryLoadMindMap()}
              >
                <RefreshCw className="w-4 h-4" />
                <span className="text-xs">{t('mindmap:retryLoad')}</span>
              </NotionButton>
            </div>
          </div>
        ) : currentView === 'outline' ? (
          <OutlineView />
        ) : (
          <MindMapView />
        )}

        {showShortcutHelp && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/35" onClick={() => setShowShortcutHelp(false)} />
            <div className="relative w-full max-w-lg rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] shadow-lg">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--mm-border)]">
                <h3 className="text-sm font-medium">{t('mindmap:shortcuts.title')}</h3>
                <NotionButton variant="ghost"
                  className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
                  onClick={() => setShowShortcutHelp(false)}
                  aria-label={t('mindmap:toolbar.closeShortcuts')}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              </div>
              <div className="p-4 text-sm text-[var(--mm-text-secondary)] space-y-2">
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Tab</kbd> {t('mindmap:shortcuts.addChild')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Enter</kbd> {t('mindmap:shortcuts.addSiblingOrEdit')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Cmd/Ctrl + Z</kbd> {t('mindmap:shortcuts.undo')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Cmd/Ctrl + Shift + Z</kbd> / <kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Cmd/Ctrl + Y</kbd> {t('mindmap:shortcuts.redo')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Cmd/Ctrl + S</kbd> {t('mindmap:shortcuts.save')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Cmd/Ctrl + F</kbd> {t('mindmap:shortcuts.search')}</p>
                <p><kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs">Del</kbd> {t('mindmap:shortcuts.deleteNode')}</p>
              </div>
            </div>
          </div>
        )}
        
        {/* Mobile: Structure Panel Overlay */}
        {showMobileStructure && (
          <div className="absolute inset-0 z-50 sm:hidden">
            <div 
              className="absolute inset-0 bg-black/30" 
              onClick={() => setShowMobileStructure(false)} 
            />
            <div className="absolute top-4 left-4 right-4 bg-[var(--mm-bg-elevated)] rounded-lg shadow-lg border border-[var(--mm-border)] max-h-[80vh] overflow-auto">
              <div className="flex items-center justify-between p-3 border-b border-[var(--mm-border)]">
                <span className="font-medium text-sm">{t('mindmap:selectStructure')}</span>
                <NotionButton variant="ghost" 
                  className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
                  onClick={() => setShowMobileStructure(false)}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              </div>
              <div className="p-2">
                <StructureSelector 
                  placement="inline"
                  onSelect={() => setShowMobileStructure(false)}
                />
              </div>
            </div>
          </div>
        )}
        
        {/* Mobile: Style Panel Overlay */}
        {showMobileStyle && (
          <div className="absolute inset-0 z-50 sm:hidden">
            <div 
              className="absolute inset-0 bg-black/30" 
              onClick={() => setShowMobileStyle(false)} 
            />
            <div className="absolute top-4 left-4 right-4 bg-[var(--mm-bg-elevated)] rounded-lg shadow-lg border border-[var(--mm-border)] max-h-[80vh] overflow-auto">
              <div className="flex items-center justify-between p-3 border-b border-[var(--mm-border)]">
                <span className="font-medium text-sm">{t('mindmap:toolbar.styleSettings')}</span>
                <NotionButton variant="ghost" 
                  className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
                  onClick={() => setShowMobileStyle(false)}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              </div>
              <div className="p-2">
                <StyleSettings placement="inline" />
              </div>
            </div>
          </div>
        )}

        {/* Export Loading Overlay */}
        {isExporting && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
            <div className="bg-[var(--mm-bg-elevated)] px-8 py-6 rounded-lg shadow-lg border border-[var(--mm-border)] flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-200 min-w-[240px]">
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-[var(--mm-text)]">{t('mindmap:export.processing')}</span>
                  <span className="text-[var(--mm-text-muted)]">{exportProgress}%</span>
                </div>
                <Progress value={exportProgress} className="h-1.5" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </MindMapErrorBoundary>
  );
};
