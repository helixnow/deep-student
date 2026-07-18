/**
 * 模板管理应用（wb-tm-*）— Workbench 原生范式重构
 *
 * 自 `components/TemplateManagementPage`（legacy 大页面）迁移而来：
 * - Workbench 窗口 / 无壳侧栏时：顶部标签导航（对齐闪卡 wb-fc-nav），
 *   不再回退渲染内部 UnifiedSidebar；
 * - legacy 桌面壳：继续通过 useDesktopShellSidebarPortal 投送壳侧栏；
 * - 移动端：MobileSlidingLayout 统一抽屉（与 Chat / 学习资源同构）；
 * - 保留：选择模式、模板 CRUD、导入 / 批量导出对话框、AI 编辑器集成、
 *   Agent Surface、refreshToken 强制刷新。
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass, FileText, Plus, Warning, X,
  Gear, Palette, Upload, Download,
  ArrowClockwise, ArrowLeft, BookOpen, Code, Database, CaretRight,
} from '@phosphor-icons/react';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar/UnifiedSidebar';
import type { CustomAnkiTemplate, TemplateExportResponse } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { templateManager } from '@/data/ankiTemplates';
import { renderCardPreview } from '@/components/SharedPreview';
import MinimalTemplateEditor, { EditorTabType } from '@/components/MinimalTemplateEditor';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input as ShadInput } from '@/components/ui/shad/Input';
import {
  NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription,
  NotionDialogBody, NotionDialogFooter,
} from '@/components/ui/NotionDialog';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { getErrorMessage, formatErrorMessage, logError } from '@/utils/errorUtils';
import { templateService } from '@/services/templateService';
import { useUIStore } from '@/stores/uiStore';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { fileManager } from '@/utils/fileManager';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { cn } from '@/lib/utils';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
} from '@/components/layout/mobileDrawerStyles';
import { useDesktopShellSidebarPortal } from '@/app/shell/DesktopShellSidebarPortal';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  registerTemplateAgentSurface,
  type TemplateAgentSnapshot,
} from '@/features/workbench/apps/system/agentSurfaceRegistry';
import { TemplateBrowser } from './components/TemplateBrowser';
import './template-management.css';

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

export interface TemplateManagementAppProps {
  isSelectingMode?: boolean;
  onTemplateSelected?: (template: CustomAnkiTemplate) => void;
  onCancel?: () => void;
  // 从模板管理返回到 Anki 制卡
  onBackToAnki?: () => void;
  onOpenJsonPreview?: () => void;
  onDesktopShellBackVisibilityChange?: (visible: boolean) => void;
  refreshToken?: number;
  workbenchWindowId?: string;
}

export const TemplateManagementApp: React.FC<TemplateManagementAppProps> = ({
  isSelectingMode = false,
  onTemplateSelected,
  onCancel,
  onBackToAnki,
  onOpenJsonPreview: _onOpenJsonPreview,
  onDesktopShellBackVisibilityChange,
  refreshToken = 0,
  workbenchWindowId,
}) => {
  const { t } = useTranslation(['template', 'common']);
  const { t: tAnki } = useTranslation('anki');
  const { isSmallScreen } = useBreakpoint();
  const desktopShellSidebarTarget = useDesktopShellSidebarPortal('template-management');
  const usesDesktopShellSidebar = !isSmallScreen && Boolean(desktopShellSidebarTarget);
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  const sidebarOpen = screenPosition === 'left';
  const setSidebarOpen = useCallback((open: boolean) => setScreenPosition(open ? 'left' : 'center'), []);
  const [editorPortalTarget, setEditorPortalTarget] = useState<HTMLDivElement | null>(null);
  const globalLeftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);

  // 面包屑导航组件（移动端显示 "Anki 制卡 > 卡片模板管理"）
  const BreadcrumbNav = useMemo(() => {
    if (isSelectingMode) {
      return (
        <h1 className="text-base font-semibold truncate">
          {t('page_title_select')}
        </h1>
      );
    }
    return (
      <div className="flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap min-w-0">
        {/* 触屏无 hover，用颜色差标记面包屑父级可点击（当前页保持前景色形成对比） */}
        <NotionButton variant="ghost" size="sm" onClick={() => onBackToAnki?.()} className="hover:text-primary !p-0 !h-auto truncate max-w-[100px] text-muted-foreground [@media(pointer:coarse)]:text-primary">
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

  usePageMount('template-management', 'TemplateManagementApp');

  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'browse' | 'edit' | 'create'>('browse');
  const [selectedTemplate, setSelectedTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<CustomAnkiTemplate | null>(null);
  // 编辑器内部 tab 状态（集成到导航）
  const [editorTab, setEditorTab] = useState<EditorTabType>('basic');
  const isCodeEditorTab = editorTab === 'templates' || editorTab === 'styles';
  const isCodeMode = !isSelectingMode && isCodeEditorTab && (activeTab === 'create' || activeTab === 'edit');

  useEffect(() => {
    onDesktopShellBackVisibilityChange?.(!isSelectingMode && activeTab === 'browse');
    return () => {
      onDesktopShellBackVisibilityChange?.(true);
    };
  }, [activeTab, isSelectingMode, onDesktopShellBackVisibilityChange]);

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const agentTemplatesRef = useRef<CustomAnkiTemplate[]>([]);
  const agentSnapshotRef = useRef<TemplateAgentSnapshot>({
    activeTab: 'browse',
    selectedTemplateId: null,
    searchQuery: '',
    loading: true,
    error: null,
    templates: [],
    totalTemplates: 0,
  });

  agentTemplatesRef.current = templates;
  agentSnapshotRef.current = {
    activeTab,
    selectedTemplateId: editingTemplate?.id ?? selectedTemplate?.id ?? null,
    searchQuery: searchTerm,
    loading: isLoading,
    error,
    templates: templates.slice(0, 50).map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      updatedAt: template.updated_at,
    })),
    totalTemplates: templates.length,
  };

  useEffect(() => {
    if (!workbenchWindowId) return undefined;
    return registerTemplateAgentSurface(workbenchWindowId, {
      snapshot: () => agentSnapshotRef.current,
      openTemplate: (templateId) => {
        const template = agentTemplatesRef.current.find((item) => item.id === templateId);
        if (!template) return false;
        agentSnapshotRef.current = {
          ...agentSnapshotRef.current,
          activeTab: 'edit',
          selectedTemplateId: templateId,
        };
        setSelectedTemplate(template);
        setEditingTemplate({ ...template });
        setActiveTab('edit');
        return true;
      },
      search: (query) => {
        agentSnapshotRef.current = { ...agentSnapshotRef.current, searchQuery: query };
        setSearchTerm(query);
        return true;
      },
    });
  }, [workbenchWindowId]);

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
    pageLifecycleTracker.log('template-management', 'TemplateManagementApp', 'data_load', 'loadTemplates');
    const start = Date.now();
    Promise.all([loadTemplates(), loadDefaultTemplateId()]).then(() => {
      pageLifecycleTracker.log('template-management', 'TemplateManagementApp', 'data_ready', undefined, { duration: Date.now() - start });
    });

    // 订阅模板变化
    const unsubscribe = templateManager.subscribe(setTemplates);
    return unsubscribe;
  }, [loadTemplates, loadDefaultTemplateId]);

  // refreshToken > 0 时强制刷新模板列表（AI 工作室导入后触发）
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSelectAllBatch = () => {
    setBatchExportSelection(new Set(templates.map(item => item.id)));
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

      const selectedTemplates = templates.filter(item => batchExportSelection.has(item.id));
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
      // 后端签名为 request: TemplateBulkImportRequest，必须包一层 request
      const result = await invoke<string>('import_custom_templates_bulk', {
        request: {
          template_data: text,
          overwrite_existing: overwriteExisting,
          strict_builtin: strictBuiltin,
        },
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
      setDefaultTemplateId(template.id);
      setError(null);
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
      await loadTemplates();
    } catch (err: unknown) {
      logError(t('import_builtin_failed'), err);
      setError(formatErrorMessage(t('import_builtin_failed'), err));
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

  const isEditingMode = (activeTab === 'edit' || activeTab === 'create') && !!editingTemplate;

  const backToBrowse = useCallback(() => {
    setActiveTab('browse');
    setEditingTemplate(null);
    setEditorTab('basic');
  }, []);

  const editorNavItems: Array<{ id: EditorTabType; icon: React.ElementType; label: string; selected: boolean }> = [
    { id: 'basic', icon: FileText, label: t('basic_info'), selected: editorTab === 'basic' },
    { id: 'templates', icon: Code, label: t('template_code'), selected: editorTab === 'templates' || editorTab === 'styles' },
    { id: 'data', icon: Database, label: t('preview_data'), selected: editorTab === 'data' },
    { id: 'rules', icon: Gear, label: t('extraction_rules'), selected: editorTab === 'rules' },
    { id: 'advanced', icon: Gear, label: t('advanced_settings'), selected: editorTab === 'advanced' },
  ];

  // ===== 桌面壳侧栏（legacy shell portal 专用） =====
  const shellSidebarContent = (
    <UnifiedSidebar
      searchQuery={searchTerm}
      onSearchQueryChange={setSearchTerm}
      displayMode="panel"
      autoResponsive={false}
      width="full"
      onClose={() => setSidebarOpen(false)}
      collapsed={usesDesktopShellSidebar ? false : globalLeftPanelCollapsed}
      showMacSafeZone={false}
    >
      <UnifiedSidebarHeader
        title={isSelectingMode ? t('page_title_select') : t('manager_title')}
        icon={Palette}
        showSearch={true}
        searchPlaceholder={t('search_placeholder')}
        showCreate={!isSelectingMode}
        createTitle={t('tab_create')}
        onCreateClick={() => setActiveTab('create')}
        showRefresh={!isSelectingMode}
        refreshTitle={t('refresh')}
        onRefreshClick={loadTemplates}
        isRefreshing={isLoading}
        showCollapse={true}
      />

      <UnifiedSidebarContent>
        {/* 编辑模式下显示返回按钮 */}
        {isEditingMode && (
          <div className="px-1 py-2">
            <UnifiedSidebarItem
              id="back-to-browse"
              isSelected={false}
              onClick={backToBrowse}
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
        {isEditingMode && (
          <div className="px-2 py-1">
            <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
              {activeTab === 'create' ? t('tab_create') : t('tab_edit')}: {editingTemplate?.name}
            </div>
            {editorNavItems.map(({ id, icon, label, selected }) => (
              <UnifiedSidebarItem
                key={id}
                id={`editor-${id}`}
                isSelected={selected}
                onClick={() => setEditorTab(id)}
                icon={icon}
                title={label}
              />
            ))}
          </div>
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
      </UnifiedSidebarContent>

      {/* 选择模板弹窗模式保留取消入口 */}
      {isSelectingMode && onCancel && (
        <div className="mt-auto p-2 border-t border-border">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => {
              onCancel();
            }}
            className="w-full justify-start gap-2"
          >
            <ArrowLeft size={16} />
            {t('back_button')}
          </NotionButton>
        </div>
      )}
    </UnifiedSidebar>
  );

  // ===== 顶部导航（workbench 窗口 / 无壳侧栏的桌面布局） =====
  const workbenchNav = (
    <nav className="wb-tm-nav" aria-label={t('manager_title')}>
      {isEditingMode && !isSelectingMode ? (
        <>
          <button type="button" className="wb-tm-tab" onClick={backToBrowse}>
            <ArrowLeft size={16} weight="bold" />
            {t('back_to_browse')}
          </button>
          {editorNavItems.map(({ id, icon: Icon, label, selected }) => (
            <button
              key={id}
              type="button"
              className="wb-tm-tab"
              data-active={selected ? 'true' : undefined}
              aria-current={selected ? 'page' : undefined}
              onClick={() => setEditorTab(id)}
            >
              <Icon size={16} weight="duotone" />
              {label}
            </button>
          ))}
        </>
      ) : (
        <button
          type="button"
          className="wb-tm-tab"
          data-active="true"
          aria-current="page"
        >
          <BookOpen size={16} weight="duotone" />
          {isSelectingMode ? t('page_title_select') : t('tab_browse')}
          <span className="text-[11px] text-muted-foreground/60 tabular-nums">
            {filteredTemplates.length}
          </span>
        </button>
      )}

      <div className="wb-tm-nav-actions">
        {(isSelectingMode || activeTab === 'browse') && (
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
            <ShadInput
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('search_placeholder')}
              className="wb-tm-nav-search h-7 w-[170px] border-transparent pl-7 text-xs"
            />
          </div>
        )}
        {!isSelectingMode && activeTab === 'browse' && (
          <>
            <CommonTooltip content={t('tab_create')}>
              <NotionButton variant="utility" size="icon" iconOnly onClick={() => setActiveTab('create')} aria-label={t('tab_create')} className="h-7 w-7">
                <Plus size={14} />
              </NotionButton>
            </CommonTooltip>
            <CommonTooltip content={t('refresh')}>
              <NotionButton variant="utility" size="icon" iconOnly onClick={loadTemplates} disabled={isLoading} aria-label={t('refresh')} className="h-7 w-7">
                <ArrowClockwise size={14} className={cn(isLoading && 'animate-spin')} />
              </NotionButton>
            </CommonTooltip>
            <CommonTooltip content={isImporting ? t('importing') : t('import_builtin_templates')}>
              <NotionButton variant="utility" size="icon" iconOnly onClick={handleImportBuiltinTemplates} disabled={isImporting} aria-label={t('import_builtin_templates')} className="h-7 w-7">
                <Download size={14} />
              </NotionButton>
            </CommonTooltip>
            <CommonTooltip content={t('import_external_templates')}>
              <NotionButton variant="utility" size="icon" iconOnly onClick={handleImportExternalClick} aria-label={t('import_external_templates')} className="h-7 w-7">
                <Upload size={14} />
              </NotionButton>
            </CommonTooltip>
            <CommonTooltip content={t('export_templates_sidebar')}>
              <NotionButton variant="utility" size="icon" iconOnly onClick={handleOpenBatchExportDialog} aria-label={t('export_templates_sidebar')} className="h-7 w-7">
                <Download size={14} weight="bold" />
              </NotionButton>
            </CommonTooltip>
          </>
        )}
        {isSelectingMode && onCancel && (
          <NotionButton variant="default" size="sm" onClick={onCancel} className="h-7">
            <ArrowLeft size={14} />
            {t('back_button')}
          </NotionButton>
        )}
      </div>
    </nav>
  );

  // ===== 主内容 =====
  const mainContent = (
    <div className="flex-1 flex flex-col min-w-0 h-full min-h-0">
      {/* 错误提示 */}
      {error && (
        <div className="wb-tm-error" role="alert">
          <span className="flex items-center gap-2 min-w-0">
            <Warning size={16} className="flex-shrink-0" />
            <span className="truncate">{error}</span>
          </span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setError(null)} className="text-current hover:text-current" aria-label={t('common:a11y.close')}>
            <X size={14} />
          </NotionButton>
        </div>
      )}

      {/* 主内容 - 创建/编辑模式渲染单一编辑器实例；浏览模式用 ScrollArea。
          编辑器固定在同一 JSX 位置（key 只随 create/edit 与模板 id 变化），
          仅通过 className 切换代码模式（撑满）与表单模式的外层样式，
          避免切换导航 Tab 导致编辑器重挂载、未保存的编辑静默丢失。 */}
      {!isSelectingMode && (activeTab === 'create' || (activeTab === 'edit' && editingTemplate)) ? (
        <div
          className={cn(
            'flex-1 min-h-0 flex flex-col overflow-hidden',
            !isCodeEditorTab && (isSmallScreen ? 'py-2 px-0' : 'p-4')
          )}
        >
          <div className="flex-1 min-h-0 overflow-hidden">
            <MinimalTemplateEditor
              key={`${activeTab}-${editingTemplate?.id ?? 'blank'}`}
              template={editingTemplate}
              mode={activeTab === 'create' ? 'create' : 'edit'}
              externalActiveTab={editorTab}
              onExternalTabChange={setEditorTab}
              hideSidebar={true}
              mobileEditorPortalTarget={editorPortalTarget}
              onSave={async (templateData) => {
                if (activeTab === 'create') {
                  try {
                    await templateManager.createTemplate(templateData);
                    backToBrowse();
                    setError(null);
                  } catch (err: unknown) {
                    logError('创建模板失败', err);
                    setError(formatErrorMessage(t('create_failed'), err));
                  }
                } else if (editingTemplate) {
                  try {
                    setIsLoading(true);
                    await templateManager.updateTemplate(editingTemplate.id, templateData);
                    backToBrowse();
                    setError(null);
                    setTemplates(templateManager.getAllTemplates());
                  } catch (err: unknown) {
                    logError('更新模板失败', err);
                    setError(formatErrorMessage(t('update_failed'), err));
                  } finally {
                    setIsLoading(false);
                  }
                }
              }}
              onCancel={backToBrowse}
            />
          </div>
        </div>
      ) : (
        <CustomScrollArea
          className="flex-1 min-h-0"
          viewportClassName={isSmallScreen ? 'py-2 px-0 pb-0' : 'p-4'}
          trackOffsetRight={isSmallScreen ? 0 : 6}
        >
          {(isSelectingMode || activeTab === 'browse') && (
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
              isSmallScreen={isSmallScreen}
            />
          )}
        </CustomScrollArea>
      )}
    </div>
  );

  // ===== 移动端统一抽屉侧栏 =====
  // 不复用桌面 UnifiedSidebar（自带头部/卡片行会破坏统一抽屉视觉），
  // 改用 mobileDrawerStyles 契约，与 Chat/学习资源/待办抽屉同构
  const closeMobileDrawer = () => setScreenPosition('center');
  const renderMobileDrawerRow = (
    key: string,
    Icon: React.ElementType,
    label: string,
    onClick: () => void,
    active = false,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={mobileDrawerNavRowClassName(active, 'group gap-2.5')}
    >
      <span className={mobileDrawerRowIconWrapClassName}>
        <Icon size={18} />
      </span>
      <span className={mobileDrawerRowTitleClassName}>{label}</span>
    </button>
  );
  const mobileDrawerContent = (
    <div className="min-h-0 space-y-0.5 pb-1 pt-1 text-foreground">
      {/* 工具行：刷新 / 搜索 / 新建 —— 与学习资源抽屉同构 */}
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={loadTemplates}
          disabled={isLoading}
          className="shrink-0"
          title={t('refresh')}
          aria-label={t('refresh')}
        >
          <ArrowClockwise size={18} className={cn(isLoading && 'animate-spin')} />
        </NotionButton>
        <div className="group relative min-w-0 flex-1">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" size={16} />
          <ShadInput
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('search_placeholder')}
            className="sidebar-shell-search h-9 w-full pl-9 text-sm"
          />
        </div>
        {!isSelectingMode && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => {
              setActiveTab('create');
              closeMobileDrawer();
            }}
            className="shrink-0"
            title={t('tab_create')}
            aria-label={t('tab_create')}
          >
            <Plus size={18} />
          </NotionButton>
        )}
      </div>

      {isEditingMode ? (
        <>
          {renderMobileDrawerRow('back-to-browse', ArrowLeft, t('back_to_browse'), () => {
            backToBrowse();
            closeMobileDrawer();
          })}
          <span className={mobileDrawerSectionLabelClassName}>
            {activeTab === 'create' ? t('tab_create') : t('tab_edit')}
          </span>
          {editorNavItems.map(({ id, icon, label, selected }) =>
            renderMobileDrawerRow(`editor-${id}`, icon, label, () => {
              setEditorTab(id);
              closeMobileDrawer();
            }, selected),
          )}
        </>
      ) : (
        <>
          <span className={mobileDrawerSectionLabelClassName}>{t('manager_title')}</span>
          {renderMobileDrawerRow('browse', BookOpen, t('tab_browse'), () => {
            setActiveTab('browse');
            closeMobileDrawer();
          }, activeTab === 'browse')}
          {!isSelectingMode && (
            <>
              <span className={mobileDrawerSectionLabelClassName}>{t('import_section')}</span>
              {renderMobileDrawerRow('import-builtin', Download, isImporting ? t('importing') : t('import_builtin_templates'), () => {
                handleImportBuiltinTemplates();
                closeMobileDrawer();
              })}
              {renderMobileDrawerRow('import-external', Upload, t('import_external_templates'), () => {
                handleImportExternalClick();
                closeMobileDrawer();
              })}
              {renderMobileDrawerRow('export', Download, t('export_templates_sidebar'), () => {
                handleOpenBatchExportDialog();
                closeMobileDrawer();
              })}
            </>
          )}
        </>
      )}
    </div>
  );

  const sidebarPortal = usesDesktopShellSidebar && desktopShellSidebarTarget
    ? createPortal(shellSidebarContent, desktopShellSidebarTarget)
    : null;

  let layout: React.ReactNode;
  if (isSmallScreen) {
    // ===== 移动端布局：MobileSlidingLayout =====
    layout = (
      <div className="wb-tm-root overflow-hidden">
        <MobileSlidingLayout
          sidebar={mobileDrawerContent}
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
          showSidebarAppNavigation
          showContentOverlay
          className="flex-1"
        >
          {mainContent}
        </MobileSlidingLayout>
      </div>
    );
  } else if (usesDesktopShellSidebar) {
    // ===== legacy 桌面壳：侧栏投送到壳 portal =====
    layout = (
      <>
        {sidebarPortal}
        <div className="wb-tm-root overflow-hidden">
          <div className="wb-tm-body flex-row">
            {mainContent}
          </div>
        </div>
      </>
    );
  } else {
    // ===== workbench 窗口 / 无壳侧栏：顶部标签导航 =====
    layout = (
      <div className="wb-tm-root overflow-hidden">
        {workbenchNav}
        <div className="wb-tm-body">
          {mainContent}
        </div>
      </div>
    );
  }

  return (
    <>
      {layout}

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
              <Checkbox id="overwriteExisting" checked={overwriteExisting} onCheckedChange={(v) => setOverwriteExisting(Boolean(v))} />
              <label htmlFor="overwriteExisting" className="text-sm select-none">{t('overwrite_existing_label')}</label>
            </div>
            <div className="mt-2">
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleExternalFilesSelected} />
              {selectedImportFile && (
                <div className="mt-1 text-xs text-muted-foreground">{t('file_selected_prefix')}{selectedImportFile.name}</div>
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

      {/* 批量导出 - 模态框 */}
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

export default TemplateManagementApp;
