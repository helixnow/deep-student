import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PencilSimple, Copy, Trash, MagnifyingGlass, FileText, Plus,
  PencilSimple as EditIcon, Warning, X, Lightbulb, User,
  Target, Gear, Palette, PaintBrush, Upload, Download,
  ArrowClockwise, CircleNotch, ArrowLeft, SquaresFour, List, Eye, BookOpen,
  Code, Database, CaretRight
} from '@phosphor-icons/react';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from './ui/unified-sidebar/UnifiedSidebar';
import { CustomAnkiTemplate, CreateTemplateRequest, FieldExtractionRule, TemplateExportResponse } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { templateManager } from '../data/ankiTemplates';
import { IframePreview, renderCardPreview } from './SharedPreview';
import MinimalTemplateEditor, { EditorTabType } from './MinimalTemplateEditor';
import { NotionButton } from './ui/NotionButton';
import { Input as ShadInput } from './ui/shad/Input';
import { Separator } from './ui/shad/Separator';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from './ui/NotionDialog';
import { Checkbox } from './ui/shad/Checkbox';
import { getErrorMessage, formatErrorMessage, logError } from '../utils/errorUtils';
import { templateService } from '../services/templateService';
import { useUIStore } from '@/stores/uiStore';
import './TemplateManagementPage.css';
// 直接加载 AI 模板工作室，避免某些环境下动态 import 悬挂导致的无限 Loading
import { CustomScrollArea } from './custom-scroll-area';
import { fileManager } from '../utils/fileManager';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { showGlobalNotification } from './UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

function buildExportErrorMessage(permissionDeniedText: string, prefix: string, error: unknown) {
  const rawMessage = getErrorMessage(error);
  const normalized = rawMessage.toLowerCase();

  const permissionDenied =
    (normalized.includes('fs.write_text_file') && normalized.includes('not allowed')) ||
    normalized.includes('permission denied') ||
    normalized.includes('access denied');

  if (permissionDenied) {
    return `${prefix}: ${permissionDeniedText}`;
  }

  return formatErrorMessage(prefix, error);
}

interface TemplateManagementPageProps {
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  onCancel?: () => void;
  // 从模板管理返回到 Anki 制卡
  onBackToAnki?: () => void;
  onOpenJsonPreview?: () => void;
  refreshToken?: number;
}

const TemplateManagementPage: React.FC<TemplateManagementPageProps> = ({
  isSelectingMode = false,
  onTemplateSelected,
  onCancel,
  onBackToAnki,
  onOpenJsonPreview,
  refreshToken = 0,
}) => {
  const { t } = useTranslation('template');
  const { t: tAnki } = useTranslation('anki');
  const { isSmallScreen } = useBreakpoint();
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  const sidebarOpen = screenPosition === 'left';
  const setSidebarOpen = useCallback((open: boolean) => setScreenPosition(open ? 'left' : 'center'), []);
  const [editorPortalTarget, setEditorPortalTarget] = useState<HTMLDivElement | null>(null);
  const globalLeftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);

  // 面包屑导航组件（移动端显示 "Anki 制卡 > 卡片模板管理"）
  const BreadcrumbNav = useMemo(() => {
    if (isSelectingMode) {
      // 选择模式下只显示标题
      return (
        <h1 className="text-base font-semibold truncate">
          {t('page_title_select')}
        </h1>
      );
    }
    // 正常模式：显示面包屑导航
    return (
      <div className="flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap min-w-0">
        <NotionButton variant="ghost" size="sm" onClick={() => onBackToAnki?.()} className="hover:text-primary !p-0 !h-auto truncate max-w-[100px]">
          {tAnki('page_title')}
        </NotionButton>
        <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[120px]">
          {t('manager_title')}
        </span>
      </div>
    );
  }, [isSelectingMode, t, tAnki, onBackToAnki]);

  // 移动端统一顶栏配置 - 使用面包屑导航
  useMobileHeader('template-management', {
    titleNode: BreadcrumbNav,
    showMenu: true,
    onMenuClick: () => setScreenPosition(prev => prev === 'left' ? 'center' : 'left'),
  }, [BreadcrumbNav]);

  // ========== 页面生命周期监控 ==========
  usePageMount('template-management', 'TemplateManagementPage');

  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'browse' | 'edit' | 'create'>('browse');
  const [selectedTemplate, setSelectedTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<CustomAnkiTemplate | null>(null);
  // 编辑器内部 tab 状态（集成到左侧栏）
  const [editorTab, setEditorTab] = useState<EditorTabType>('basic');
  const isCodeMode = !isSelectingMode && (editorTab === 'templates' || editorTab === 'styles') && (activeTab === 'create' || activeTab === 'edit');

  // 离开代码编辑模式时，若停留在右屏则回到中屏
  useEffect(() => {
    if (!isCodeMode && screenPosition === 'right') {
      setScreenPosition('center');
    }
  }, [isCodeMode, screenPosition]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportExternalDialog, setShowImportExternalDialog] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [showBatchExportDialog, setShowBatchExportDialog] = useState(false);
  const [batchExportSelection, setBatchExportSelection] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicatorStyle, setIndicatorStyle] = useState({ transform: 'translateX(0)', width: 0 });

  // 🔧 P1-47: 使用 useCallback 包装 loadTemplates，确保 refreshToken 变化时正确触发刷新
  const loadTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      await templateManager.refresh();
      setTemplates(templateManager.getAllTemplates());
    } catch (err: unknown) {
      logError('加载模板失败', err);
      setError(formatErrorMessage(t('load_failed'), err));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const loadDefaultTemplateId = useCallback(async () => {
    try {
      await templateManager.loadUserDefaultTemplate();
      setDefaultTemplateId(templateManager.getDefaultTemplateId());
    } catch (err: unknown) {
      console.warn('Failed to load default template ID:', err);
    }
  }, []);

  // 初始加载模板
  useEffect(() => {
    pageLifecycleTracker.log('template-management', 'TemplateManagementPage', 'data_load', 'loadTemplates');
    const start = Date.now();
    Promise.all([loadTemplates(), loadDefaultTemplateId()]).then(() => {
      pageLifecycleTracker.log('template-management', 'TemplateManagementPage', 'data_ready', undefined, { duration: Date.now() - start });
    });

    // 订阅模板变化
    const unsubscribe = templateManager.subscribe(setTemplates);
    return unsubscribe;
  }, [loadTemplates, loadDefaultTemplateId]);

  // 🔧 P1-47: refreshToken > 0 时强制刷新模板列表（AI 工作室导入后触发）
  useEffect(() => {
    if (refreshToken > 0) {
      loadTemplates();
    }
  }, [refreshToken, loadTemplates]);

  // 导入外部模板（JSON）
  const handleImportExternalClick = () => {
    setSelectedImportFile(null);
    setOverwriteExisting(true);
    setShowImportExternalDialog(true);
  };

  const handleExternalFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    setSelectedImportFile(file || null);
  };

  const copyJsonToClipboard = useCallback(async (content: string) => {
    if (navigator?.clipboard?.writeText) {
      try {
        await copyTextToClipboard(content);
        return true;
      } catch (err: unknown) {
        console.warn('clipboard write failed', err);
      }
    }
    return false;
  }, []);

  const getSuggestedFileName = useCallback((name: string, fallback: string) => {
    const safe = name.replace(/[^a-zA-Z0-9-_]+/g, '_');
    return safe || fallback;
  }, []);

  const handleExportTemplate = useCallback(async (template: CustomAnkiTemplate) => {
    try {
      const response = await invoke<TemplateExportResponse>('export_template', { templateId: template.id });
      const defaultFile = `${getSuggestedFileName(template.name, 'template')}.json`;

      try {
        const result = await fileManager.saveTextFile({
          title: t('export_dialog_title', { name: template.name }),
          defaultFileName: defaultFile,
          filters: [{ name: t('file_filter_json'), extensions: ['json'] }],
          content: response.template_data,
        });
        if (result.canceled) {
          return;
        }
        unifiedAlert(t('export_success', { path: result.path ?? defaultFile }));
        return;
      } catch (dialogError: unknown) {
        console.warn('保存模板文件失败，尝试复制到剪贴板', dialogError);
      }

      const copied = await copyJsonToClipboard(response.template_data);
      unifiedAlert(
        copied
          ? t('dialog_unavailable_clipboard', { name: template.name })
          : t('dialog_unavailable_no_clipboard'),
      );
      if (!copied) {
        console.log('Template JSON:', response.template_data);
      }
    } catch (err: unknown) {
      logError(t('export_failed'), err);
      setError(buildExportErrorMessage(t('template:permission_denied'), t('export_failed'), err));
    }
  }, [copyJsonToClipboard, getSuggestedFileName]);

  const handleOpenBatchExportDialog = () => {
    setBatchExportSelection(new Set());
    setShowBatchExportDialog(true);
  };

  const handleToggleBatchExportSelection = (templateId: string, checked: boolean) => {
    setBatchExportSelection(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(templateId);
      } else {
        next.delete(templateId);
      }
      return next;
    });
  };

  // 批量导出：未选择任何项时给出统一通知（替代 alert）
  const notifySelectAtLeastOne = useCallback(() => {
    showGlobalNotification('warning', t('select_at_least_one'));
  }, [t]);

  const handleSelectAllBatch = () => {
    setBatchExportSelection(new Set(templates.map(t => t.id)));
  };

  const handleClearBatchSelection = () => {
    setBatchExportSelection(new Set());
  };

  const handleBatchExportConfirm = async () => {
    if (batchExportSelection.size === 0) {
      unifiedAlert(t('select_at_least_one'));
      return;
    }
    setIsExporting(true);
    try {
      const ids = Array.from(batchExportSelection);
      const exportJson = await templateService.exportTemplates(ids);

      const selectedTemplates = templates.filter(t => batchExportSelection.has(t.id));
      const defaultFile = ids.length === 1
        ? `${getSuggestedFileName(selectedTemplates[0]?.name || 'template', 'template')}.json`
        : `anki_templates_${new Date().toISOString().slice(0, 10)}.json`;

      let saved = false;
      try {
        const result = await fileManager.saveTextFile({
          title: ids.length === 1 ? t('export_dialog_title', { name: selectedTemplates[0]?.name }) : t('export_dialog_title_multiple'),
          defaultFileName: defaultFile,
          filters: [{ name: t('file_filter_json'), extensions: ['json'] }],
          content: exportJson,
        });
        if (!result.canceled) {
          unifiedAlert(t('export_success', { path: result.path ?? defaultFile }));
          saved = true;
          setShowBatchExportDialog(false);
        } else {
          return;
        }
      } catch (dialogError: unknown) {
        console.warn('批量导出对话框不可用，尝试复制到剪贴板', dialogError);
      }

      if (!saved) {
        const copied = await copyJsonToClipboard(exportJson);
        unifiedAlert(copied ? t('dialog_unavailable_batch') : t('dialog_unavailable_no_clipboard'));
        if (!copied) {
          console.log('Templates JSON:', exportJson);
        }
        setShowBatchExportDialog(false);
      }
    } catch (err: unknown) {
      logError(t('batch_export_failed'), err);
      setError(buildExportErrorMessage(t('template:permission_denied'), t('batch_export_failed'), err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleConfirmImportExternal = async () => {
    if (!selectedImportFile) return;
    setIsImporting(true);
    try {
      const text = await selectedImportFile.text();
      let strictBuiltin = true;
      try {
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        strictBuiltin = items.every(item => item && typeof item === 'object' && ('fields_json' in item || 'field_extraction_rules_json' in item));
      } catch {
        strictBuiltin = false;
      }
      const result = await invoke<string>('import_custom_templates_bulk', {
        template_data: text,
        templateData: text,
        overwrite_existing: overwriteExisting,
        overwriteExisting: overwriteExisting,
        strict_builtin: strictBuiltin,
        strictBuiltin: strictBuiltin,
      });
      unifiedAlert(t('import_success', { result }));
      setShowImportExternalDialog(false);
      await loadTemplates();
    } catch (err: unknown) {
      logError(t('import_external_failed'), err);
      setError(formatErrorMessage(t('import_external_failed'), err));
    } finally {
      setIsImporting(false);
    }
  };

  // 过滤模板
  const filteredTemplates = templates.filter(template =>
    template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    template.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 选择模板
  const handleSelectTemplate = (template: CustomAnkiTemplate) => {
    setSelectedTemplate(template);
  };

  // 设置默认模板
  const handleSetDefaultTemplate = async (template: CustomAnkiTemplate) => {
    try {
      await templateManager.setDefaultTemplate(template.id);
      setDefaultTemplateId(template.id); // 立即更新本地状态
      setError(null);
      console.log(`✅ Set "${template.name}" as default template`);
    } catch (err: unknown) {
      logError('设置默认模板失败', err);
      setError(formatErrorMessage(t('set_default_failed'), err));
    }
  };

  // 编辑模板
  const handleEditTemplate = (template: CustomAnkiTemplate) => {
    setEditingTemplate({ ...template });
    setActiveTab('edit');
  };

  // 复制模板
  const handleDuplicateTemplate = (template: CustomAnkiTemplate) => {
    const duplicated: CustomAnkiTemplate = {
      ...template,
      id: `${template.id}-copy-${Date.now()}`,
      name: `${template.name}${t('copy_suffix')}`,
      author: t('copy_author'),
      is_built_in: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setEditingTemplate(duplicated);
    setActiveTab('create');
  };

  // 使用统一的预览渲染函数
  const renderTemplatePreview = (template: string, templateData: CustomAnkiTemplate, isBack = false) => {
    return renderCardPreview(template, templateData, undefined, isBack);
  };

  // 导入内置模板
  const handleImportBuiltinTemplates = async () => {
    setIsImporting(true);
    try {
      const result = await invoke<string>('import_builtin_templates');
      unifiedAlert(t('import_success', { result }));
      
      // 刷新模板列表
      await loadTemplates();
    } catch (error: unknown) {
      logError(t('import_builtin_failed'), error);
      setError(formatErrorMessage(t('import_builtin_failed'), error));
    } finally {
      setIsImporting(false);
    }
  };

  // 删除模板
  const handleDeleteTemplate = async (template: CustomAnkiTemplate) => {
    const confirmed = await Promise.resolve(unifiedConfirm(t('delete_confirmation', { name: template.name })));
    if (!confirmed) {
      return;
    }

    try {
      await templateManager.deleteTemplate(template.id);
      setError(null);
    } catch (err: unknown) {
      logError('删除模板失败', err);
      setError(formatErrorMessage(t('delete_failed'), err));
    }
  };

  // 更新滑块位置
  const updateIndicator = () => {
    const tabElement = tabsRef.current.get(activeTab);
    if (tabElement) {
      const tabsContainer = tabElement.parentElement?.parentElement; // .template-tabs
      const containerPaddingLeft = tabsContainer ? parseInt(getComputedStyle(tabsContainer).paddingLeft, 10) : 0;
      const offsetLeft = Math.max(0, tabElement.offsetLeft + containerPaddingLeft);
      setIndicatorStyle({ transform: `translateX(${offsetLeft}px)`, width: tabElement.offsetWidth });
    }
  };

  // 处理标签切换
  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId as any);
  };

  // 初始化和更新滑块位置
  useEffect(() => {
    updateIndicator();
  }, [activeTab]);

  useEffect(() => {
    const handleResize = () => updateIndicator();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <>
      <style>{`
        /* 模板管理页面滑块样式 */
        .template-tabs {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1.5rem;
          position: relative;
          background-color: var(--surface-panel-strong);
          padding: 0 24px;
          overflow: visible;
        }

        .template-tab-buttons {
          display: flex;
          position: relative;
          padding: 0;
          margin: 0;
          overflow-x: auto;
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        .template-tab-buttons::-webkit-scrollbar {
          display: none;
        }

        .template-tab-button {
          padding: 1rem 1.5rem;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: color 0.2s ease;
          position: relative;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          white-space: nowrap;
          margin: 0;
          border-bottom: none;
          flex-shrink: 0;
        }

        .template-tab-button:hover {
          color: var(--button-primary-foreground);
        }

        .template-tab-button.active {
          color: var(--button-primary-foreground);
          font-weight: 600;
        }

        .template-tab-button::after,
        .template-tab-button::before {
          display: none !important;
        }

        .template-tab-indicator {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 2px;
          background: hsl(var(--primary));
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 2;
          transform-origin: left center;
          border-radius: 0;
          will-change: transform, width;
          min-width: 20px;
          max-width: 100%;
          margin-left: 0;
        }

        .template-tab-icon {
          width: 1rem;
          height: 1rem;
        }
        .template-tabs-right {
          display: flex;
          align-items: center;
          gap: 16px;
        }
      `}</style>

      {/* 渲染侧边栏 */}
      {(() => {
        const sidebarContent = (
          <UnifiedSidebar
            showMacSafeZone={!isSmallScreen}
            searchQuery={searchTerm}
            onSearchQueryChange={setSearchTerm}
            displayMode="panel"
            autoResponsive={false}
            width={isSmallScreen ? 'full' : 200}
            onClose={() => setSidebarOpen(false)}
            collapsed={globalLeftPanelCollapsed}
          >
        <UnifiedSidebarHeader
          title={isSelectingMode ? t('page_title_select') : t('manager_title')}
          icon={Palette}
          showSearch={true}
          searchPlaceholder={t('search_placeholder')}
          showCreate={!isSelectingMode}
          createTitle={t('tab_create')}
          onCreateClick={() => handleTabChange('create')}
          showRefresh={!isSelectingMode}
          refreshTitle={t('refresh')}
          onRefreshClick={loadTemplates}
          isRefreshing={isLoading}
          showCollapse={true}
/>
        
        <UnifiedSidebarContent>
          {/* 编辑模式下显示返回按钮 */}
          {(activeTab === 'edit' || activeTab === 'create') && editingTemplate && (
            <div className="px-1 py-2">
              <UnifiedSidebarItem
                id="back-to-browse"
                isSelected={false}
                onClick={() => {
                  setActiveTab('browse');
                  setEditingTemplate(null);
                  setEditorTab('basic');
                }}
                icon={ArrowLeft}
                title={t('back_to_browse')}
/>
            </div>
          )}

          {/* 浏览模式下显示主导航项 */}
          {activeTab === 'browse' && (
            <div className="px-1 py-2">
              <UnifiedSidebarItem
                id="browse"
                isSelected={activeTab === 'browse'}
                onClick={() => setActiveTab('browse')}
                icon={BookOpen}
                title={t('tab_browse')}
                description={t('total_templates', { count: filteredTemplates.length })}
/>
            </div>
          )}

          {/* 编辑器导航 - 编辑/创建模式时显示 */}
          {(activeTab === 'edit' || activeTab === 'create') && editingTemplate && (
            <>
              <div className="px-2 py-1">
                <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
                  {activeTab === 'create' ? t('tab_create') : t('tab_edit')}: {editingTemplate.name}
                </div>
                <UnifiedSidebarItem
                  id="editor-basic"
                  isSelected={editorTab === 'basic'}
                  onClick={() => setEditorTab('basic')}
                  icon={FileText}
                  title={t('basic_info')}
/>
                <UnifiedSidebarItem
                  id="editor-templates"
                  isSelected={editorTab === 'templates' || editorTab === 'styles'}
                  onClick={() => setEditorTab('templates')}
                  icon={Code}
                  title={t('template_code')}
/>
                <UnifiedSidebarItem
                  id="editor-data"
                  isSelected={editorTab === 'data'}
                  onClick={() => setEditorTab('data')}
                  icon={Database}
                  title={t('preview_data')}
/>
                <UnifiedSidebarItem
                  id="editor-rules"
                  isSelected={editorTab === 'rules'}
                  onClick={() => setEditorTab('rules')}
                  icon={Gear}
                  title={t('extraction_rules')}
/>
                <UnifiedSidebarItem
                  id="editor-advanced"
                  isSelected={editorTab === 'advanced'}
                  onClick={() => setEditorTab('advanced')}
                  icon={Gear}
                  title={t('advanced_settings')}
/>
              </div>
            </>
          )}


          {/* 导入导出操作 - 仅浏览模式显示 */}
          {!isSelectingMode && activeTab === 'browse' && (
            <div className="px-2 py-1">
              <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
                {t('import_section')}
              </div>
              <UnifiedSidebarItem
                id="import-builtin"
                onClick={handleImportBuiltinTemplates}
                icon={Download}
                title={isImporting ? t('importing') : t('import_builtin_templates')}
/>
              <UnifiedSidebarItem
                id="import-external"
                onClick={handleImportExternalClick}
                icon={Upload}
                title={t('import_external_templates')}
/>
              <UnifiedSidebarItem
                id="export"
                onClick={handleOpenBatchExportDialog}
                icon={Download}
                title={t('export_templates_sidebar')}
/>
            </div>
          )}

          {/* 视图切换 - 仅浏览模式 + 桌面端显示 */}
          {activeTab === 'browse' && !isSmallScreen && (
            <div className="px-2 py-1 mt-2">
              <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
                {t('view_mode_section')}
              </div>
              <div className="flex gap-1 px-2">
                <NotionButton
                  variant="nav"
                  size="sm"
                  onClick={() => setViewMode('grid')}
                  className={viewMode === 'grid' ? 'bg-[color:var(--button-utility-surface)] text-foreground' : ''}
                >
                  <SquaresFour size={16} />
                </NotionButton>
                <NotionButton
                  variant="nav"
                  size="sm"
                  onClick={() => setViewMode('list')}
                  className={viewMode === 'list' ? 'bg-[color:var(--button-utility-surface)] text-foreground' : ''}
                >
                  <List size={16} />
                </NotionButton>
              </div>
            </div>
          )}
        </UnifiedSidebarContent>

        {/* 底部返回按钮 */}
        {(onBackToAnki || (isSelectingMode && onCancel)) && (
          <div className="mt-auto p-2 border-t border-border">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => {
                if (isSelectingMode && onCancel) onCancel();
                else if (onBackToAnki) onBackToAnki();
              }}
              className="w-full justify-start gap-2"
            >
              <ArrowLeft size={16} />
              {isSelectingMode ? t('back_button') : t('back_to_anki_button')}
            </NotionButton>
          </div>
        )}
          </UnifiedSidebar>
        );

        const mainContent = (
          <div className="study-shell-page flex-1 flex flex-col min-w-0 h-full">
        {/* 错误提示 */}
        {error && (
          <div className="study-shell-panel mx-4 mt-4 border-[color:var(--button-danger-border)] bg-[color:var(--button-danger-surface)] px-4 py-3 text-sm text-[color:var(--button-danger-foreground)] flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Warning size={16} />
              {error}
            </span>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setError(null)} className="text-[color:var(--button-danger-foreground)] hover:text-[color:var(--button-danger-foreground)]" aria-label="close">
              <X size={14} />
            </NotionButton>
          </div>
        )}

        {/* 主内容 - 代码编辑模式直接填满，其他模式用 ScrollArea */}
        {(editorTab === 'templates' || editorTab === 'styles') && !isSelectingMode && (activeTab === 'create' || activeTab === 'edit') ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === 'create' && (
              <MinimalTemplateEditor
                template={editingTemplate}
                mode="create"
                externalActiveTab={editorTab}
                onExternalTabChange={setEditorTab}
                hideSidebar={true}
                mobileEditorPortalTarget={editorPortalTarget}
                onSave={async (templateData) => {
                  try {
                    await templateManager.createTemplate(templateData);
                    setActiveTab('browse');
                    setEditingTemplate(null);
                    setEditorTab('basic');
                    setError(null);
                  } catch (err: unknown) {
                    logError('创建模板失败', err);
                    setError(formatErrorMessage(t('create_failed'), err));
                  }
                }}
                onCancel={() => {
                  setActiveTab('browse');
                  setEditingTemplate(null);
                  setEditorTab('basic');
                }}
/>
            )}
            {activeTab === 'edit' && editingTemplate && (
              <MinimalTemplateEditor
                template={editingTemplate}
                mode="edit"
                externalActiveTab={editorTab}
                onExternalTabChange={setEditorTab}
                hideSidebar={true}
                mobileEditorPortalTarget={editorPortalTarget}
                onSave={async (templateData) => {
                  try {
                    setIsLoading(true);
                    await templateManager.updateTemplate(editingTemplate.id, templateData);
                    setActiveTab('browse');
                    setEditingTemplate(null);
                    setEditorTab('basic');
                    setError(null);
                    const templates = templateManager.getAllTemplates();
                    setTemplates(templates);
                  } catch (err: unknown) {
                    logError('更新模板失败', err);
                    setError(formatErrorMessage(t('update_failed'), err));
                  } finally {
                    setIsLoading(false);
                  }
                }}
                onCancel={() => {
                  setActiveTab('browse');
                  setEditingTemplate(null);
                  setEditorTab('basic');
                }}
/>
            )}
          </div>
        ) : (
        <CustomScrollArea
          className="flex-1 min-h-0"
          viewportClassName={isSmallScreen ? 'py-2 px-0 pb-20' : 'p-4'}
          trackOffsetRight={isSmallScreen ? 0 : 6}
        >
        {(isSelectingMode || activeTab === 'browse') && (
          <div className="study-shell-pane animate-in fade-in slide-in-from-bottom-2 duration-200">
            <TemplateBrowser
              templates={filteredTemplates}
              selectedTemplate={selectedTemplate}
              onSelectTemplate={handleSelectTemplate}
              onEditTemplate={handleEditTemplate}
              onDuplicateTemplate={handleDuplicateTemplate}
              onDeleteTemplate={handleDeleteTemplate}
              onSetDefaultTemplate={handleSetDefaultTemplate}
              defaultTemplateId={defaultTemplateId}
              isLoading={isLoading}
              isSelectingMode={isSelectingMode}
              onTemplateSelected={onTemplateSelected}
              renderPreview={renderTemplatePreview}
              onExportTemplate={handleExportTemplate}
              viewMode={viewMode}
              isSmallScreen={isSmallScreen}
/>
          </div>
        )}

        {!isSelectingMode && activeTab === 'create' && (
          <div className="study-shell-pane animate-in fade-in slide-in-from-bottom-2 duration-200">
            <MinimalTemplateEditor
              template={editingTemplate}
              mode="create"
              externalActiveTab={editorTab}
              onExternalTabChange={setEditorTab}
              hideSidebar={true}
              onSave={async (templateData) => {
                try {
                  await templateManager.createTemplate(templateData);
                  setActiveTab('browse');
                  setEditingTemplate(null);
                  setEditorTab('basic');
                  setError(null);
                } catch (err: unknown) {
                  logError('创建模板失败', err);
                  setError(formatErrorMessage(t('create_failed'), err));
                }
              }}
              onCancel={() => {
                setActiveTab('browse');
                setEditingTemplate(null);
                setEditorTab('basic');
              }}
/>
          </div>
        )}

        {!isSelectingMode && activeTab === 'edit' && editingTemplate && (
          <div className="study-shell-pane animate-in fade-in slide-in-from-bottom-2 duration-200">
            <MinimalTemplateEditor
              template={editingTemplate}
              mode="edit"
              externalActiveTab={editorTab}
              onExternalTabChange={setEditorTab}
              hideSidebar={true}
              onSave={async (templateData) => {
                try {
                  setIsLoading(true);
                  await templateManager.updateTemplate(editingTemplate.id, templateData);
                  setActiveTab('browse');
                  setEditingTemplate(null);
                  setEditorTab('basic');
                  setError(null);
                  const templates = templateManager.getAllTemplates();
                  setTemplates(templates);
                } catch (err: unknown) {
                  logError('更新模板失败', err);
                  setError(formatErrorMessage(t('update_failed'), err));
                } finally {
                  setIsLoading(false);
                }
              }}
              onCancel={() => {
                setActiveTab('browse');
                setEditingTemplate(null);
                setEditorTab('basic');
              }}
/>
          </div>
        )}
        </CustomScrollArea>
        )}
          </div>
        );

        // ===== 移动端布局：MobileSlidingLayout =====
        if (isSmallScreen) {
          return (
            <div className="study-shell-page w-full h-full flex flex-col overflow-hidden">
              <MobileSlidingLayout
                sidebar={
                  <div
                    className="study-shell-sidebar-frame h-full flex flex-col"
                  >
                    {sidebarContent}
                  </div>
                }
                rightPanel={
                  isCodeMode ? (
                    <div ref={setEditorPortalTarget} className="h-full w-full" />
                  ) : undefined
                }
                rightPanelEnabled={isCodeMode}
                sidebarOpen={sidebarOpen}
                onSidebarOpenChange={setSidebarOpen}
                screenPosition={screenPosition}
                onScreenPositionChange={setScreenPosition}
                enableGesture={true}
                threshold={0.3}
                className="flex-1"
              >
                {mainContent}
              </MobileSlidingLayout>
            </div>
          );
        }

        // ===== 桌面端布局 =====
        return (
          <div className="study-shell-page w-full h-full flex flex-col overflow-hidden">
            <div className="flex-1 flex overflow-hidden min-h-0">
              {sidebarContent}
              {mainContent}
            </div>
          </div>
        );
      })()}

      {/* 导入外部模板 - 模态框 */}
      <NotionDialog open={showImportExternalDialog} onOpenChange={(o) => { if (!isImporting) setShowImportExternalDialog(o); }} maxWidth="max-w-3xl">
          <NotionDialogHeader>
            <NotionDialogTitle>{t('import_external_dialog_title')}</NotionDialogTitle>
            <NotionDialogDescription>
              {t('import_external_dialog_desc')}
            </NotionDialogDescription>
          </NotionDialogHeader>
          <NotionDialogBody>
          <div className="space-y-3 text-sm text-foreground">
            <ul className="list-disc pl-5 space-y-1">
              <li>{t('import_external_rule_1')}</li>
              <li>{t('import_external_rule_2')}</li>
              <li>{t('import_external_rule_3')}</li>
              <li>{t('import_external_rule_4')}</li>
              <li>{t('import_external_rule_5')}</li>
            </ul>
            
            <div className="flex items-center gap-2">
              <Checkbox id="overwriteExisting" checked={overwriteExisting} onCheckedChange={(v)=> setOverwriteExisting(Boolean(v))} />
              <label htmlFor="overwriteExisting" className="text-sm select-none">{t('overwrite_existing_label')}</label>
            </div>
            <div className="mt-2">
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleExternalFilesSelected} />
              {selectedImportFile && (
                <div className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('file_selected_prefix')}{selectedImportFile.name}</div>
              )}
            </div>
          </div>
          </NotionDialogBody>
          <NotionDialogFooter>
            <NotionButton variant="default" size="sm" onClick={() => setShowImportExternalDialog(false)} disabled={isImporting}>{t('cancel_button')}</NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleConfirmImportExternal} disabled={!selectedImportFile || isImporting}>
              {isImporting ? t('importing') : t('start_import_button')}
            </NotionButton>
          </NotionDialogFooter>
    </NotionDialog>

    <NotionDialog
      open={showBatchExportDialog}
      onOpenChange={(open) => {
        if (isExporting) return;
        setShowBatchExportDialog(open);
        if (!open) {
          setBatchExportSelection(new Set());
        }
      }}
      maxWidth="max-w-xl"
    >
      <NotionDialogHeader>
        <NotionDialogTitle>
          <Download size={16} className="mr-2 inline" /> {t('export_templates_sidebar')}
        </NotionDialogTitle>
        <NotionDialogDescription>
          {t('export_dialog_desc')}
        </NotionDialogDescription>
      </NotionDialogHeader>
      <NotionDialogBody>
        {templates.length === 0 && (
          <div className="text-sm text-muted-foreground">{t('no_exportable_templates')}</div>
        )}
        {templates.map(template => (
          <label
            key={template.id}
            className="study-shell-secondary-card flex items-start gap-3 p-3"
          >
            <Checkbox
              checked={batchExportSelection.has(template.id)}
              onCheckedChange={(checked) => handleToggleBatchExportSelection(template.id, checked === true)}
              disabled={isExporting}
/>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-foreground">{template.name}</span>
              <span className="text-xs text-muted-foreground line-clamp-2">{template.description}</span>
              <div className="text-[11px] text-muted-foreground flex gap-3">
                <span>{t('field_count_meta', { count: template.fields.length })}</span>
                <span>{t('type_meta', { type: template.note_type })}</span>
                {template.is_built_in && <span>{t('builtin_badge')}</span>}
              </div>
            </div>
          </label>
        ))}
      </NotionDialogBody>
        <NotionDialogFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <NotionButton variant="ghost" size="sm" onClick={handleSelectAllBatch} disabled={isExporting || templates.length === 0}>
              {t('select_all_button')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={handleClearBatchSelection} disabled={isExporting || batchExportSelection.size === 0}>
              {t('clear_selection_button')}
            </NotionButton>
          </div>
          <div className="flex items-center gap-2">
            <NotionButton variant="default" size="sm" onClick={() => setShowBatchExportDialog(false)} disabled={isExporting}>
              {t('cancel_button')}
            </NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleBatchExportConfirm} disabled={isExporting || batchExportSelection.size === 0}>
              {isExporting ? t('exporting') : t('export_count_button', { count: batchExportSelection.size })}
            </NotionButton>
          </div>
        </NotionDialogFooter>
    </NotionDialog>
  </>
);
};

// 模板浏览器组件
interface TemplateBrowserProps {
  templates: CustomAnkiTemplate[];
  selectedTemplate: CustomAnkiTemplate | null;
  onSelectTemplate: (template: CustomAnkiTemplate) => void;
  onEditTemplate: (template: CustomAnkiTemplate) => void;
  onDuplicateTemplate: (template: CustomAnkiTemplate) => void;
  onDeleteTemplate: (template: CustomAnkiTemplate) => void;
  onSetDefaultTemplate: (template: CustomAnkiTemplate) => void;
  defaultTemplateId: string | null;
  isLoading: boolean;
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: (template: string, templateData: CustomAnkiTemplate, isBack?: boolean) => string;
  onExportTemplate: (template: CustomAnkiTemplate) => void;
  viewMode: 'grid' | 'list';
  isSmallScreen?: boolean;
}

const TemplateBrowser: React.FC<TemplateBrowserProps> = ({
  templates,
  selectedTemplate,
  onSelectTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  onSetDefaultTemplate,
  defaultTemplateId,
  isLoading,
  isSelectingMode = false,
  onTemplateSelected,
  renderPreview,
  onExportTemplate,
  viewMode,
  isSmallScreen = false
}) => {
  const { t } = useTranslation('template');

  return (
    <div className={`template-browser ${isSmallScreen ? 'mobile-layout' : ''}`}>
      {/* 选择模式提示 */}
      {isSelectingMode && (
        <div className="selecting-mode-hint">
          <Lightbulb size={16} />
          <span>{t('mode_hint')}</span>
        </div>
      )}

      {/* 模板网格/列表 */}
      {isLoading ? (
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <span className="loading-text">{t('loading_text')}</span>
        </div>
      ) : viewMode === 'list' ? (
        <div className="templates-list">
          {templates.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              isSelected={selectedTemplate?.id === template.id}
              onSelect={() => onSelectTemplate(template)}
              onEdit={() => onEditTemplate(template)}
              onDuplicate={() => onDuplicateTemplate(template)}
              onDelete={() => onDeleteTemplate(template)}
              onSetDefaultTemplate={() => onSetDefaultTemplate(template)}
              defaultTemplateId={defaultTemplateId}
              isSelectingMode={isSelectingMode}
              onTemplateSelected={onTemplateSelected}
              renderPreview={renderPreview}
              onExportTemplate={() => onExportTemplate(template)}
              viewMode={viewMode}
/>
          ))}
        </div>
      ) : (
        <div className="masonry-grid">
          <div className="masonry-column">
            {templates.filter((_, i) => i % 2 === 0).map(template => (
              <TemplateCard
                key={template.id}
                template={template}
                isSelected={selectedTemplate?.id === template.id}
                onSelect={() => onSelectTemplate(template)}
                onEdit={() => onEditTemplate(template)}
                onDuplicate={() => onDuplicateTemplate(template)}
                onDelete={() => onDeleteTemplate(template)}
                onSetDefaultTemplate={() => onSetDefaultTemplate(template)}
                defaultTemplateId={defaultTemplateId}
                isSelectingMode={isSelectingMode}
                onTemplateSelected={onTemplateSelected}
                renderPreview={renderPreview}
                onExportTemplate={() => onExportTemplate(template)}
                viewMode={viewMode}
/>
            ))}
          </div>
          <div className="masonry-column">
            {templates.filter((_, i) => i % 2 === 1).map(template => (
              <TemplateCard
                key={template.id}
                template={template}
                isSelected={selectedTemplate?.id === template.id}
                onSelect={() => onSelectTemplate(template)}
                onEdit={() => onEditTemplate(template)}
                onDuplicate={() => onDuplicateTemplate(template)}
                onDelete={() => onDeleteTemplate(template)}
                onSetDefaultTemplate={() => onSetDefaultTemplate(template)}
                defaultTemplateId={defaultTemplateId}
                isSelectingMode={isSelectingMode}
                onTemplateSelected={onTemplateSelected}
                renderPreview={renderPreview}
                onExportTemplate={() => onExportTemplate(template)}
                viewMode={viewMode}
/>
            ))}
          </div>
        </div>
      )}

      {templates.length === 0 && !isLoading && (
        <div className="study-shell-empty-state">
          <div className="study-shell-empty-state__icon">
            <FileText size={64} />
          </div>
          <h3 className="study-shell-empty-state__title">{t('empty_title')}</h3>
          <p className="study-shell-empty-state__description">{t('empty_description')}</p>
        </div>
      )}
    </div>
  );
};

// 模板卡片组件
interface TemplateCardProps {
  template: CustomAnkiTemplate;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefaultTemplate: () => void;
  defaultTemplateId: string | null;
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  renderPreview: (template: string, templateData: CustomAnkiTemplate, isBack?: boolean) => string;
  onExportTemplate: () => void;
  viewMode: 'grid' | 'list';
}

const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  isSelected,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefaultTemplate,
  defaultTemplateId,
  isSelectingMode = false,
  onTemplateSelected,
  renderPreview,
  onExportTemplate,
  viewMode
}) => {
  const { t } = useTranslation('template');
  const isDefault = defaultTemplateId === template.id;

  // 操作按钮渲染函数
const renderActions = () => (
    <div className="template-shell-card-actions" onClick={e => e.stopPropagation()}>
      {isSelectingMode ? (
        <NotionButton
          variant="primary"
          size="sm"
          onClick={() => onTemplateSelected?.(template)}
        >
          {t('use_template')}
        </NotionButton>
      ) : (
        <>
          <NotionButton
            variant="shell"
            size="sm"
            className="flex-1 min-w-0"
            onClick={isDefault ? undefined : onSetDefaultTemplate}
            disabled={isDefault}
          >
            {isDefault ? t('default_template') : t('set_default')}
          </NotionButton>
          <div className="template-shell-action-buttons">
            <NotionButton variant="utility" size="icon" iconOnly onClick={onEdit} aria-label={t('edit_tooltip')} title={t('edit_tooltip')}>
              <PencilSimple size={16} />
            </NotionButton>
            <NotionButton variant="utility" size="icon" iconOnly onClick={onDuplicate} aria-label={t('duplicate_tooltip')} title={t('duplicate_tooltip')}>
              <Copy size={16} />
            </NotionButton>
            <NotionButton variant="utility" size="icon" iconOnly onClick={onExportTemplate} aria-label={t('export_tooltip')} title={t('export_tooltip')}>
              <Download size={16} />
            </NotionButton>
            <NotionButton variant="danger" size="icon" iconOnly onClick={onDelete} aria-label={t('delete_tooltip')} title={t('delete_tooltip')}>
              <Trash size={16} />
            </NotionButton>
          </div>
        </>
      )}
    </div>
  );

  // Notion 风格卡片 - 统一结构
  return (
    <div
      className={`template-shell-card ${isSelected ? 'selected' : ''} ${!template.is_active ? 'inactive' : ''} ${viewMode === 'list' ? 'list-view' : ''}`}
      data-selected={isSelected}
      onClick={onSelect}
    >
      {/* 卡片头部 */}
      <div className="template-shell-card-header">
        <div>
          <h4 className="template-shell-card-title">{template.name}</h4>
          <div className="template-shell-card-badges">
            {isDefault && <span className="study-shell-badge study-shell-badge--primary">{t('default_badge')}</span>}
            {template.is_built_in && <span className="study-shell-badge">{t('builtin_badge')}</span>}
            {!template.is_active && <span className="study-shell-badge study-shell-badge--danger">{t('inactive_badge')}</span>}
            <span className="study-shell-badge study-shell-badge--success">v{template.version}</span>
          </div>
        </div>
        {/* 列表视图：操作按钮放在 header 内 */}
        {viewMode === 'list' && renderActions()}
      </div>

      {/* 预览区域 - 固定高度，可滚动 */}
      <div className="template-shell-preview-container">
        <div className="template-shell-preview-section">
          <div className="template-shell-preview-label">{t('front_label')}</div>
          <div className="template-shell-preview-content">
            <IframePreview
              htmlContent={renderPreview(template.front_template || template.preview_front || '', template, false)}
              cssContent={template.css_style || ''}
/>
          </div>
        </div>
        <div className="template-shell-preview-section">
          <div className="template-shell-preview-label">{t('back_label')}</div>
          <div className="template-shell-preview-content">
            <IframePreview
              htmlContent={renderPreview(template.back_template || template.preview_back || '', template, true)}
              cssContent={template.css_style || ''}
/>
          </div>
        </div>
      </div>

      {/* 卡片信息 */}
      <div className="template-shell-card-info">
        <p className="template-shell-card-description">{template.description}</p>
        <div className="template-shell-card-meta">
          <span className="template-shell-meta-item">
            <User size={12} className="template-shell-meta-icon" />
            {template.author || t('author_unknown')}
          </span>
          <span className="template-shell-meta-item">
            <FileText size={12} className="template-shell-meta-icon" />
            {t('fields_count', { count: template.fields.length })}
          </span>
        </div>
        <div className="template-shell-fields">
          {template.fields.slice(0, 4).map(field => (
            <span key={field} className="template-shell-field-tag">{field}</span>
          ))}
          {template.fields.length > 4 && (
            <span className="template-shell-field-tag more">+{template.fields.length - 4}</span>
          )}
        </div>
      </div>

      {/* 操作按钮 - 只在非列表视图显示（列表视图在 header 内渲染） */}
      {viewMode !== 'list' && renderActions()}
    </div>
  );
};

export default TemplateManagementPage;
