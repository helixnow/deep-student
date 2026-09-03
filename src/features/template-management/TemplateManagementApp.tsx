/**
 * 模板管理应用（wb-tm-*）— Workbench 原生范式重构
 *
 * 自 `components/TemplateManagementPage`（legacy 大页面）迁移而来：
 * - Workbench 窗口 / 无壳侧栏时：顶部标签导航（对齐闪卡 wb-fc-nav），
 *   不再回退渲染内部 UnifiedSidebar；
 * - legacy 桌面壳：继续通过 useDesktopShellSidebarPortal 投送壳侧栏；
 * - 移动端：MobileSlidingLayout 统一抽屉（与 Chat / 学习资源同构）；
 * - 保留：选择模式、模板 CRUD、AI 编辑器集成、Agent Surface、refreshToken 强制刷新。
 *
 * SOTA 浏览体验重构：
 * - 网格 / 列表双视图 + 防抖搜索 + 类型/来源筛选 chips + 排序；
 * - 导入 / 批量导出改为页内内联面板（不再使用模态框）；
 * - 删除改为卡片内联二次确认（内置模板如实提示"删除后保持停用、不会随升级恢复"）；
 * - 浏览态 ⇄ 编辑态页内平滑切换（尊重 prefers-reduced-motion）。
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass, FileText, Plus, Warning, X,
  Gear, Palette, Upload, Download,
  ArrowClockwise, ArrowLeft, BookOpen, Code, Database, CaretRight,
} from '@phosphor-icons/react';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar/UnifiedSidebar';
import type { CustomAnkiTemplate, TemplateExportResponse } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { templateManager } from '@/data/ankiTemplates';
import { TemplateRenderService } from '@/services/templateRenderService';
import MinimalTemplateEditor, { EditorTabType } from '@/components/MinimalTemplateEditor';
import { DsButton } from '@/components/ui/DsButton';
import { Input as ShadInput } from '@/components/ui/shad/Input';
import { getErrorMessage, formatErrorMessage, logError } from '@/utils/errorUtils';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
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
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  registerTemplateAgentSurface,
  type TemplateAgentSnapshot,
} from '@/features/workbench/apps/system/agentSurfaceRegistry';
import { TemplateBrowser } from './components/TemplateBrowser';
import { TemplateToolbar } from './components/TemplateToolbar';
import {
  TemplateImportPanel,
  TemplateExportPanel,
  type ImportPanelResult,
} from './components/TemplateInlinePanels';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import {
  classifyTemplateImportError,
  filterAndSortTemplates,
  hasActiveFilters,
  persistViewMode,
  readStoredViewMode,
  type TemplateLibraryQuery,
  type TemplateSortOrder,
  type TemplateSourceFilter,
  type TemplateTypeFilter,
  type TemplateViewMode,
} from './lib/templateLibrary';
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

type InlinePanel = 'import' | 'export' | null;

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
  onOpenJsonPreview,
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

  // 保活可见性守卫锚点：本视图在 ViewLayerRenderer 隐藏保活层里仍保持挂载
  // （visibility:hidden），返回键 handler 须先确认根节点可见才消费事件
  // （对照 EnhancedPdfViewer / TodoMainPanel 的同款守卫）
  const rootRef = useRef<HTMLDivElement>(null);

  // 离开编辑器的脏检查守卫（在下方编辑器状态就绪后赋值；面包屑点击时经 ref 调用，
  // 避免 useMemo 工厂在渲染期引用尚未声明的回调触发 TDZ）
  const leaveEditorGuardRef = useRef<() => boolean>(() => true);

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
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => {
            // 编辑中带未保存更改时先二次确认，防止面包屑误触静默丢稿
            if (!leaveEditorGuardRef.current()) return;
            onBackToAnki?.();
          }}
          className="hover:text-primary !p-0 !h-auto truncate max-w-[100px] text-muted-foreground [@media(pointer:coarse)]:text-primary max-lg:min-h-11 max-lg:min-w-11 max-lg:-my-2.5 max-lg:justify-center"
        >
          {tAnki('page_title')}
        </DsButton>
        <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
        <h1 className="truncate max-w-[120px] text-base font-semibold">
          {t('manager_title')}
        </h1>
      </div>
    );
  }, [isSelectingMode, t, tAnki, onBackToAnki]);

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

  // ===== 库浏览：视图 / 筛选 / 排序 =====
  const [viewMode, setViewMode] = useState<TemplateViewMode>(() => readStoredViewMode());
  const [typeFilter, setTypeFilter] = useState<TemplateTypeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<TemplateSourceFilter>('all');
  const [sortOrder, setSortOrder] = useState<TemplateSortOrder>('updated_desc');
  const debouncedSearch = useDebouncedValue(searchTerm, 200);

  const handleViewModeChange = useCallback((mode: TemplateViewMode) => {
    setViewMode(mode);
    persistViewMode(mode);
  }, []);

  const resetFilters = useCallback(() => {
    setSearchTerm('');
    setTypeFilter('all');
    setSourceFilter('all');
  }, []);

  // ===== 内联面板（导入 / 导出，替代原模态框） =====
  const [activePanel, setActivePanel] = useState<InlinePanel>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportPanelResult | null>(null);
  const [batchExportSelection, setBatchExportSelection] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [exportPanelError, setExportPanelError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSmallScreen || !activePanel) return;
    return registerBackHandler(() => {
      // 保活守卫：隐藏保活层中的导入/导出面板不吞其他视图的返回键。
      // visibility:hidden 不清除布局盒（getClientRects 仍有返回值），须单独查 computed visibility。
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      setActivePanel(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, activePanel]);

  // ⌘/Ctrl+F → 聚焦模板搜索（legacy 壳 / Anki 内嵌等非 workbench 承载）。
  // workbench 窗口承载时由 TemplatesAppWindow 的同款 handler 负责（带窗口
  // 聚焦门禁），这里让位避免双重消费；此前 ⌘F 只覆盖 workbench 窗口，
  // 独立模板页同一工具栏没有快捷键（评审缺口 #3）。
  // capture 阶段消费，抢在 WebView 原生查找之前；编辑视图不渲染搜索框
  // （querySelector 落空）时完全放行。
  useEffect(() => {
    if (workbenchWindowId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      const root = rootRef.current;
      // 保活守卫：本视图在隐藏保活层里仍保持挂载（visibility:hidden），
      // 不可见时不抢其他视图的 ⌘F（与本文件返回键守卫同款判定）
      if (!root || !root.isConnected || root.getClientRects().length === 0) return;
      if (window.getComputedStyle(root).visibility === 'hidden') return;
      // 兜底聚焦门禁：本组件若经其他宿主（如 Anki 内嵌选择模式）间接落在
      // workbench 窗壳内，仍要求该窗聚焦且事件发生在窗内（对齐 TemplatesAppWindow）
      const windowShell = root.closest<HTMLElement>('[data-wb-window]');
      if (windowShell) {
        if (!windowShell.hasAttribute('data-focused')) return;
        const target = e.target as HTMLElement | null;
        if (!target || !windowShell.contains(target)) return;
      }
      const input = root.querySelector<HTMLInputElement>('[data-template-search]');
      if (!input) return;
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [workbenchWindowId]);

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

  // 打开导入面板（重置上次状态）
  const handleImportExternalClick = useCallback(() => {
    setSelectedImportFile(null);
    setOverwriteExisting(true);
    setImportResult(null);
    setActiveTab('browse');
    setActivePanel((prev) => (prev === 'import' ? null : 'import'));
  }, []);

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
        showGlobalNotification('success', t('export_success', { path: result.path ?? defaultFile }));
        return;
      } catch (dialogError: unknown) {
        console.warn('保存模板文件失败，尝试复制到剪贴板', dialogError);
      }

      const copied = await copyJsonToClipboard(response.template_data);
      showGlobalNotification(
        copied ? 'info' : 'warning',
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
  }, [copyJsonToClipboard, getSuggestedFileName, t]);

  // 打开 / 收起批量导出面板
  const handleOpenBatchExportPanel = useCallback(() => {
    setBatchExportSelection(new Set());
    setExportPanelError(null);
    setActiveTab('browse');
    setActivePanel((prev) => (prev === 'export' ? null : 'export'));
  }, []);

  const closePanel = useCallback(() => setActivePanel(null), []);

  const handleToggleBatchExportSelection = useCallback((templateId: string, checked: boolean) => {
    setBatchExportSelection(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(templateId);
      } else {
        next.delete(templateId);
      }
      return next;
    });
  }, []);

  const handleSelectAllBatch = useCallback(() => {
    setBatchExportSelection(new Set(templates.map(item => item.id)));
  }, [templates]);

  const handleClearBatchSelection = useCallback(() => {
    setBatchExportSelection(new Set());
  }, []);

  const handleBatchExportConfirm = async () => {
    if (batchExportSelection.size === 0) {
      return;
    }
    setIsExporting(true);
    setExportPanelError(null);
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
          showGlobalNotification('success', t('export_success', { path: result.path ?? defaultFile }));
          saved = true;
          setActivePanel(null);
          setBatchExportSelection(new Set());
        } else {
          return;
        }
      } catch (dialogError: unknown) {
        console.warn('批量导出对话框不可用，尝试复制到剪贴板', dialogError);
      }

      if (!saved) {
        const copied = await copyJsonToClipboard(exportJson);
        showGlobalNotification(
          copied ? 'info' : 'warning',
          copied ? t('dialog_unavailable_batch') : t('dialog_unavailable_no_clipboard'),
        );
        if (!copied) {
          console.log('Templates JSON:', exportJson);
        }
        setActivePanel(null);
        setBatchExportSelection(new Set());
      }
    } catch (err: unknown) {
      logError(t('batch_export_failed'), err);
      setExportPanelError(buildExportErrorMessage(t('template:permission_denied'), t('batch_export_failed'), err));
    } finally {
      setIsExporting(false);
    }
  };

  // 导入失败可读化：按信号词归类 → 「怎么办」级主文案 + 原始报错降级为技术细节附注
  const buildImportFailureMessage = useCallback((error: unknown): string => {
    const raw = getErrorMessage(error);
    const kind = classifyTemplateImportError(raw);
    if (kind === 'unknown') {
      return formatErrorMessage(t('import_external_failed'), error);
    }
    return `${t(`templateMgmt.import_error_${kind}`)}\n${t('templateMgmt.import_error_detail', { detail: raw })}`;
  }, [t]);

  const handleConfirmImportExternal = async () => {
    if (!selectedImportFile) return;
    setIsImporting(true);
    setImportResult(null);

    let text: string;
    try {
      text = await selectedImportFile.text();
    } catch (err: unknown) {
      logError(t('import_external_failed'), err);
      setImportResult({
        ok: false,
        message: `${t('templateMgmt.import_error_read_file')}\n${t('templateMgmt.import_error_detail', { detail: getErrorMessage(err) })}`,
      });
      setIsImporting(false);
      return;
    }

    // JSON 语法错误在前端即可确定：直接给可读错误，不再把坏文件送去后端
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      setImportResult({
        ok: false,
        message: `${t('templateMgmt.import_error_invalid_json')}\n${t('templateMgmt.import_error_detail', { detail: getErrorMessage(err) })}`,
      });
      setIsImporting(false);
      return;
    }

    try {
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const strictBuiltin = items.every(item => item && typeof item === 'object' && ('fields_json' in item || 'field_extraction_rules_json' in item));
      // 后端签名为 request: TemplateBulkImportRequest，必须包一层 request
      const result = await invoke<string>('import_custom_templates_bulk', {
        request: {
          template_data: text,
          overwrite_existing: overwriteExisting,
          strict_builtin: strictBuiltin,
        },
      });
      setImportResult({ ok: true, message: result });
      setSelectedImportFile(null);
      await loadTemplates();
    } catch (err: unknown) {
      logError(t('import_external_failed'), err);
      setImportResult({ ok: false, message: buildImportFailureMessage(err) });
    } finally {
      setIsImporting(false);
    }
  };

  // ===== 过滤 + 排序（防抖搜索） =====
  const libraryQuery = useMemo<TemplateLibraryQuery>(() => ({
    search: debouncedSearch,
    typeFilter,
    sourceFilter,
    sortOrder,
  }), [debouncedSearch, typeFilter, sourceFilter, sortOrder]);

  const filteredTemplates = useMemo(
    () => filterAndSortTemplates(templates, libraryQuery),
    [templates, libraryQuery],
  );

  const filtersActive = hasActiveFilters({ ...libraryQuery, search: searchTerm });

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
      showGlobalNotification('success', t('templateMgmt.default_set_toast', { name: template.name }));
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

  // 使用统一渲染引擎（支持 {{FrontSide}}/{{hint:}}/{{type:}} 等 Anki 语法）渲染缩略预览；
  // 示例数据取模板自带的 preview_data_json
  const renderTemplatePreview = (template: string, templateData: CustomAnkiTemplate, isBack = false) => {
    let sampleData: Record<string, unknown> = {};
    if (templateData.preview_data_json) {
      try {
        const parsed: unknown = JSON.parse(templateData.preview_data_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          sampleData = parsed as Record<string, unknown>;
        }
      } catch {
        // 预览数据损坏时按空数据渲染
      }
    }
    // 调用方可能传入 preview_front/preview_back 兜底内容作为当前面的模板串，按面覆盖
    const effectiveTemplate: CustomAnkiTemplate = isBack
      ? { ...templateData, back_template: template }
      : { ...templateData, front_template: template };
    const detailed = TemplateRenderService.renderCardDetailed(
      { fields: sampleData, tags: sampleData.Tags ?? sampleData.tags },
      effectiveTemplate,
    );
    return isBack ? detailed.back.html : detailed.front.html;
  };

  // 导入内置模板
  const handleImportBuiltinTemplates = async () => {
    setIsImporting(true);
    try {
      const result = await invoke<string>('import_builtin_templates');
      showGlobalNotification('success', t('import_success', { result }));
      await loadTemplates();
    } catch (err: unknown) {
      logError(t('import_builtin_failed'), err);
      setError(formatErrorMessage(t('import_builtin_failed'), err));
    } finally {
      setIsImporting(false);
    }
  };

  // 删除模板（二次确认已由卡片内联确认完成，此处直接执行）
  const handleDeleteTemplate = async (template: CustomAnkiTemplate) => {
    try {
      const result = await templateManager.deleteTemplate(template.id);
      setError(null);
      if (selectedTemplate?.id === template.id) {
        setSelectedTemplate(null);
      }
      showGlobalNotification(
        template.is_built_in ? 'info' : 'success',
        template.is_built_in
          ? t('templateMgmt.deleted_builtin_toast', { name: template.name })
          : t('templateMgmt.deleted_toast', { name: template.name }),
      );
      // 后端返回仍引用该模板的存量卡片数：>0 时提示这些卡片的渲染影响
      const referencingCards = result?.referencingCards ?? 0;
      if (referencingCards > 0) {
        showGlobalNotification(
          'warning',
          t('templateMgmt.deleted_referencing_toast', { count: referencingCards }),
        );
      }
    } catch (err: unknown) {
      logError('删除模板失败', err);
      setError(formatErrorMessage(t('delete_failed'), err));
    }
  };

  const isEditingMode = (activeTab === 'edit' || activeTab === 'create') && !!editingTemplate;

  // 编辑器未保存更改标记（由 MinimalTemplateEditor 通过 onDirtyChange 同步）。
  // 保存路径走 backToBrowse（不确认）；取消/返回浏览/面包屑离开走带二次确认的出口。
  const editorDirtyRef = useRef(false);
  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
  }, []);

  const backToBrowse = useCallback(() => {
    editorDirtyRef.current = false;
    setActiveTab('browse');
    setEditingTemplate(null);
    setEditorTab('basic');
  }, []);

  // 带脏检查的离开确认：首次触发提示，确认窗口内再次触发才放行（unifiedConfirm 两击语义）
  const confirmDiscardEditorChanges = useCallback(() => {
    if (!editorDirtyRef.current) return true;
    return unifiedConfirm(t('templateMgmt.unsaved_changes_confirm'));
  }, [t]);

  const handleCancelEdit = useCallback(() => {
    if (!confirmDiscardEditorChanges()) return;
    backToBrowse();
  }, [confirmDiscardEditorChanges, backToBrowse]);

  // 编辑态返回统一语义（顶栏返回箭头与 Android 系统返回共用）：
  // 停留在左/右屏时先回中屏，已在中屏才走脏检查退出编辑。
  const handleEditorBack = useCallback(() => {
    if (screenPosition !== 'center') {
      setScreenPosition('center');
      return;
    }
    handleCancelEdit();
  }, [screenPosition, handleCancelEdit]);

  // 选择模式小屏顶栏直接作为「返回制卡」出口（有 onCancel 才启用）
  const selectingHeaderBack = isSelectingMode && Boolean(onCancel);

  // 浏览态保留面包屑 + 菜单；编辑态切换为明确返回，并在右侧保留编辑器导航入口。
  useMobileHeader('template-management', {
    title: isEditingMode
      ? (activeTab === 'create' ? t('tab_create') : editingTemplate?.name || t('tab_edit'))
      : undefined,
    titleNode: isEditingMode ? undefined : BreadcrumbNav,
    showMenu: !isEditingMode && !selectingHeaderBack,
    showBackArrow: isEditingMode || selectingHeaderBack,
    onMenuClick: isEditingMode
      ? handleEditorBack
      : selectingHeaderBack
        ? onCancel
        : () => setScreenPosition(prev => prev === 'left' ? 'center' : 'left'),
    rightActions: isEditingMode ? (
      <>
        {isCodeMode && (
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('template_code')}
            title={t('template_code')}
            aria-pressed={screenPosition === 'right'}
            onClick={() => setScreenPosition(prev => (prev === 'right' ? 'center' : 'right'))}
           
          >
            <Code size={18} />
          </DsButton>
        )}
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('manager_title')}
          title={t('manager_title')}
          onClick={() => setScreenPosition(prev => prev === 'left' ? 'center' : 'left')}
         
        >
          <Gear size={18} />
        </DsButton>
      </>
    ) : undefined,
  }, [isEditingMode, activeTab, editingTemplate?.name, BreadcrumbNav, handleEditorBack, isCodeMode, screenPosition, selectingHeaderBack, onCancel, t]);

  // Android 返回优先收起编辑器左右屏，其次走与顶栏相同的脏检查返回路径。
  useEffect(() => {
    if (!isSmallScreen || !isEditingMode) return;
    return registerBackHandler(() => {
      // 保活守卫：隐藏保活层中滞留的编辑态不吞返回键，也不为不可见编辑器弹脏检查
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      handleEditorBack();
      return true;
    }, BACK_PRIORITY.view);
  }, [isSmallScreen, isEditingMode, handleEditorBack]);

  // 选择模式小屏：Android 系统返回与顶栏返回箭头一致，直接取消选择返回制卡。
  useEffect(() => {
    if (!isSmallScreen || !isSelectingMode || !onCancel) return;
    return registerBackHandler(() => {
      // 保活守卫：隐藏保活层中滞留的选择模式不消费返回键，交还当前活跃视图
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      onCancel();
      return true;
    }, BACK_PRIORITY.view);
  }, [isSmallScreen, isSelectingMode, onCancel]);

  // 面包屑「Anki 制卡」离开守卫与取消编辑共用同一脏检查
  leaveEditorGuardRef.current = confirmDiscardEditorChanges;

  const startCreateTemplate = useCallback(() => {
    setEditingTemplate(null);
    setActivePanel(null);
    setActiveTab('create');
  }, []);

  const editorNavItems: Array<{ id: EditorTabType; icon: React.ElementType; label: string; selected: boolean }> = [
    { id: 'basic', icon: FileText, label: t('basic_info'), selected: editorTab === 'basic' },
    { id: 'templates', icon: Code, label: t('template_code'), selected: editorTab === 'templates' || editorTab === 'styles' },
    { id: 'data', icon: Database, label: t('preview_data'), selected: editorTab === 'data' },
    { id: 'rules', icon: Gear, label: t('extraction_rules'), selected: editorTab === 'rules' },
    { id: 'advanced', icon: Gear, label: t('advanced_settings'), selected: editorTab === 'advanced' },
  ];
  const templateSidebarRowClassName = (isSelected = false) => cn(
    'desktop-shell-nav-row',
    isSelected && 'desktop-shell-nav-row--active',
  );

  // ===== 桌面壳侧栏（legacy shell portal 专用） =====
  const shellSidebarContent = (
    <UnifiedSidebar
      className="wb-tm-sidebar"
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
        onCreateClick={startCreateTemplate}
        showRefresh={!isSelectingMode}
        refreshTitle={t('refresh')}
        onRefreshClick={loadTemplates}
        isRefreshing={isLoading}
        showCollapse={true}
      />

      <UnifiedSidebarContent>
        {/* 编辑模式下显示返回按钮 */}
        {isEditingMode && (
          <div className="wb-tm-sidebar-group">
            <UnifiedSidebarItem
              id="back-to-browse"
              isSelected={false}
              onClick={handleCancelEdit}
              icon={ArrowLeft}
              title={t('back_to_browse')}
              className={templateSidebarRowClassName()}
            />
          </div>
        )}

        {/* 浏览模式下显示主导航项 */}
        {activeTab === 'browse' && (
          <div className="wb-tm-sidebar-group">
            <UnifiedSidebarItem
              id="browse"
              isSelected={activeTab === 'browse'}
              onClick={() => setActiveTab('browse')}
              icon={BookOpen}
              title={t('tab_browse')}
              description={t('total_templates', { count: filteredTemplates.length })}
              className={templateSidebarRowClassName(activeTab === 'browse')}
            />
            {!isSelectingMode && onOpenJsonPreview && (
              <UnifiedSidebarItem
                id="json-preview"
                isSelected={false}
                onClick={onOpenJsonPreview}
                icon={Code}
                title={t('json_preview.open_button')}
                description={t('json_preview.open_button_hint')}
                className={templateSidebarRowClassName()}
              />
            )}
          </div>
        )}

        {/* 编辑器导航 - 编辑/创建模式时显示 */}
        {isEditingMode && (
          <div className="wb-tm-sidebar-group">
            <div className="wb-tm-sidebar-section-label">
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
                className={templateSidebarRowClassName(selected)}
              />
            ))}
          </div>
        )}

        {/* 导入导出操作 - 仅浏览模式显示 */}
        {!isSelectingMode && activeTab === 'browse' && (
          <div className="wb-tm-sidebar-group">
            <div className="wb-tm-sidebar-section-label">
              {t('import_section')}
            </div>
            <UnifiedSidebarItem
              id="import-builtin"
              onClick={handleImportBuiltinTemplates}
              icon={Download}
              title={isImporting ? t('importing') : t('import_builtin_templates')}
              className={templateSidebarRowClassName()}
            />
            <UnifiedSidebarItem
              id="import-external"
              onClick={handleImportExternalClick}
              icon={Upload}
              title={t('import_external_templates')}
              className={templateSidebarRowClassName()}
            />
            <UnifiedSidebarItem
              id="export"
              onClick={handleOpenBatchExportPanel}
              icon={Download}
              title={t('export_templates_sidebar')}
              className={templateSidebarRowClassName()}
            />
          </div>
        )}
      </UnifiedSidebarContent>

      {/* 选择模板模式保留取消入口 */}
      {isSelectingMode && onCancel && (
        <div className="mt-auto p-2 border-t border-border">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => {
              onCancel();
            }}
            className="w-full justify-start gap-2"
          >
            <ArrowLeft size={16} />
            {t('back_button')}
          </DsButton>
        </div>
      )}
    </UnifiedSidebar>
  );

  // ===== 顶部导航（workbench 窗口 / 无壳侧栏的桌面布局） =====
  const workbenchNav = (
    <nav className="wb-tm-nav" aria-label={t('manager_title')}>
      {isEditingMode && !isSelectingMode ? (
        <>
          <button type="button" className="wb-tm-tab [@media(pointer:coarse)]:min-h-11" onClick={handleCancelEdit}>
            <ArrowLeft size={16} weight="bold" />
            {t('back_to_browse')}
          </button>
          {editorNavItems.map(({ id, icon: Icon, label, selected }) => (
            <button
              key={id}
              type="button"
              className="wb-tm-tab [@media(pointer:coarse)]:min-h-11"
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
          className="wb-tm-tab [@media(pointer:coarse)]:min-h-11"
          data-active="true"
          aria-current="page"
        >
          <BookOpen size={16} weight="duotone" />
          {isSelectingMode ? t('page_title_select') : t('tab_browse')}
          <span className="text-xs text-muted-foreground/60 tabular-nums">
            {filteredTemplates.length}
          </span>
        </button>
      )}

      <div className="wb-tm-nav-actions">
        {!isSelectingMode && activeTab === 'browse' && (
          <>
            <CommonTooltip content={t('tab_create')}>
              <DsButton variant="utility" size="icon" iconOnly onClick={startCreateTemplate} aria-label={t('tab_create')} className="h-7 w-7">
                <Plus size={14} />
              </DsButton>
            </CommonTooltip>
            <CommonTooltip content={t('refresh')}>
              <DsButton variant="utility" size="icon" iconOnly onClick={loadTemplates} disabled={isLoading} aria-label={t('refresh')} className="h-7 w-7">
                <ArrowClockwise size={14} className={cn(isLoading && 'animate-spin')} />
              </DsButton>
            </CommonTooltip>
            <CommonTooltip content={isImporting ? t('importing') : t('import_builtin_templates')}>
              <DsButton variant="utility" size="icon" iconOnly onClick={handleImportBuiltinTemplates} disabled={isImporting} aria-label={t('import_builtin_templates')} className="h-7 w-7">
                <Download size={14} />
              </DsButton>
            </CommonTooltip>
            <CommonTooltip content={t('import_external_templates')}>
              <DsButton
                variant="utility"
                size="icon"
                iconOnly
                onClick={handleImportExternalClick}
                aria-label={t('import_external_templates')}
                aria-pressed={activePanel === 'import'}
                data-active={activePanel === 'import' ? 'true' : undefined}
                className="h-7 w-7 wb-tm-nav-toggle"
              >
                <Upload size={14} />
              </DsButton>
            </CommonTooltip>
            <CommonTooltip content={t('export_templates_sidebar')}>
              <DsButton
                variant="utility"
                size="icon"
                iconOnly
                onClick={handleOpenBatchExportPanel}
                aria-label={t('export_templates_sidebar')}
                aria-pressed={activePanel === 'export'}
                data-active={activePanel === 'export' ? 'true' : undefined}
                className="h-7 w-7 wb-tm-nav-toggle"
              >
                <Download size={14} weight="bold" />
              </DsButton>
            </CommonTooltip>
            {onOpenJsonPreview && (
              <CommonTooltip content={t('json_preview.open_button_hint')}>
                <DsButton
                  variant="utility"
                  size="icon"
                  iconOnly
                  onClick={onOpenJsonPreview}
                  aria-label={t('json_preview.open_button')}
                  className="h-7 w-7"
                >
                  <Code size={14} />
                </DsButton>
              </CommonTooltip>
            )}
          </>
        )}
        {isSelectingMode && onCancel && (
          <DsButton
            variant="default"
            size="sm"
            onClick={onCancel}
            className="h-7"
          >
            <ArrowLeft size={14} />
            {t('back_button')}
          </DsButton>
        )}
      </div>
    </nav>
  );

  // ===== 浏览视图内容（内联面板 + 工具栏 + 模板库） =====
  const browseContent = (
    <>
      {!isSelectingMode && activePanel === 'import' && (
        <TemplateImportPanel
          selectedFile={selectedImportFile}
          onFileChange={setSelectedImportFile}
          overwriteExisting={overwriteExisting}
          onOverwriteChange={setOverwriteExisting}
          isImporting={isImporting}
          onConfirm={handleConfirmImportExternal}
          onClose={closePanel}
          result={importResult}
        />
      )}
      {!isSelectingMode && activePanel === 'export' && (
        <TemplateExportPanel
          templates={templates}
          selection={batchExportSelection}
          onToggleSelection={handleToggleBatchExportSelection}
          onSelectAll={handleSelectAllBatch}
          onClearSelection={handleClearBatchSelection}
          isExporting={isExporting}
          onConfirm={handleBatchExportConfirm}
          onClose={closePanel}
          error={exportPanelError}
        />
      )}

      <TemplateToolbar
        searchInput={searchTerm}
        onSearchInputChange={setSearchTerm}
        query={libraryQuery}
        onTypeFilterChange={setTypeFilter}
        onSourceFilterChange={setSourceFilter}
        onSortOrderChange={setSortOrder}
        onResetFilters={resetFilters}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        resultCount={filteredTemplates.length}
        totalCount={templates.length}
      />

      <TemplateBrowser
        templates={filteredTemplates}
        totalCount={templates.length}
        hasFilters={filtersActive}
        viewMode={viewMode}
        selectedTemplate={selectedTemplate}
        onSelectTemplate={handleSelectTemplate}
        onEditTemplate={handleEditTemplate}
        onDuplicateTemplate={handleDuplicateTemplate}
        onDeleteTemplate={handleDeleteTemplate}
        onSetDefaultTemplate={handleSetDefaultTemplate}
        onExportTemplate={handleExportTemplate}
        onCreateTemplate={isSelectingMode ? undefined : startCreateTemplate}
        onResetFilters={resetFilters}
        defaultTemplateId={defaultTemplateId}
        isLoading={isLoading}
        isSelectingMode={isSelectingMode}
        onTemplateSelected={onTemplateSelected}
        renderPreview={renderTemplatePreview}
        isSmallScreen={isSmallScreen}
      />
    </>
  );

  // ===== 主内容 =====
  const isEditorView = !isSelectingMode && (activeTab === 'create' || (activeTab === 'edit' && Boolean(editingTemplate)));
  const mainContent = (
    <div className="flex-1 flex flex-col min-w-0 h-full min-h-0">
      {/* 错误提示 */}
      {error && (
        <div className="wb-tm-error" role="alert">
          <span className="flex items-center gap-2 min-w-0">
            <Warning size={16} className="flex-shrink-0" />
            <span className="truncate">{error}</span>
          </span>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setError(null)} className="text-current hover:text-current" aria-label={t('common:a11y.close')}>
            <X size={14} />
          </DsButton>
        </div>
      )}

      {/* 主内容 - 创建/编辑模式渲染单一编辑器实例；浏览模式用 ScrollArea。
          编辑器固定在同一 JSX 位置（key 只随 create/edit 与模板 id 变化），
          仅通过 className 切换代码模式（撑满）与表单模式的外层样式，
          避免切换导航 Tab 导致编辑器重挂载、未保存的编辑静默丢失。
          浏览态 ⇄ 编辑态用 wb-tm-view 做页内淡入过渡（key 触发重放动画）。 */}
      {isEditorView ? (
        <div
          key="editor-view"
          data-agent-entity={activeTab === 'edit' && editingTemplate ? `templates:${editingTemplate.id}` : undefined}
          className={cn(
            'wb-tm-view flex-1 min-h-0 flex flex-col overflow-hidden',
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
              onDirtyChange={handleEditorDirtyChange}
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
              onCancel={handleCancelEdit}
            />
          </div>
        </div>
      ) : (
        <CustomScrollArea
          key="browse-view"
          className="wb-tm-view flex-1 min-h-0"
          viewportClassName="h-full min-h-0 w-full min-w-0"
          trackOffsetRight={isSmallScreen ? 0 : 6}
        >
          {/* OverlayScrollbars 会把视口内联 padding 归零，内边距必须放在内容包装上 */}
          <div className={cn('wb-tm-scroll-content', isSmallScreen && 'wb-tm-scroll-content--mobile')}>
            {(isSelectingMode || activeTab === 'browse') && browseContent}
          </div>
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
        <DsButton
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
        </DsButton>
        <div className="group relative min-w-0 flex-1">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" size={16} />
          <ShadInput
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('search_placeholder')}
            className="sidebar-shell-search h-9 w-full pl-9 text-sm [@media(pointer:coarse)]:h-[var(--touch-target-size)]"
          />
        </div>
        {!isSelectingMode && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => {
              startCreateTemplate();
              closeMobileDrawer();
            }}
            className="shrink-0"
            title={t('tab_create')}
            aria-label={t('tab_create')}
          >
            <Plus size={18} />
          </DsButton>
        )}
      </div>

      {isEditingMode ? (
        <>
          {renderMobileDrawerRow('back-to-browse', ArrowLeft, t('back_to_browse'), () => {
            // 有未保存更改时先二次确认；确认未通过则保留抽屉当前状态
            if (!confirmDiscardEditorChanges()) return;
            backToBrowse();
            closeMobileDrawer();
          })}
          <span className={mobileDrawerSectionLabelClassName}>
            {activeTab === 'create' ? t('tab_create') : t('tab_edit')}
          </span>
          {editorNavItems.map(({ id, icon, label, selected }) =>
            renderMobileDrawerRow(`editor-${id}`, icon, label, () => {
              setEditorTab(id);
              // 代码编辑在小屏由右屏全屏承载，选中「模板代码」直接滑到右屏
              if (id === 'templates') {
                setScreenPosition('right');
              } else {
                closeMobileDrawer();
              }
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
          {!isSelectingMode && onOpenJsonPreview && renderMobileDrawerRow('json-preview', Code, t('json_preview.open_button'), () => {
            onOpenJsonPreview();
            closeMobileDrawer();
          })}
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
              }, activePanel === 'import')}
              {renderMobileDrawerRow('export', Download, t('export_templates_sidebar'), () => {
                handleOpenBatchExportPanel();
                closeMobileDrawer();
              }, activePanel === 'export')}
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
      <div ref={rootRef} className="wb-tm-root overflow-hidden">
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
        <div ref={rootRef} className="wb-tm-root overflow-hidden">
          <div className="wb-tm-body flex-row">
            {mainContent}
          </div>
        </div>
      </>
    );
  } else {
    // ===== workbench 窗口 / 无壳侧栏：顶部标签导航 =====
    layout = (
      <div ref={rootRef} className="wb-tm-root overflow-hidden">
        {workbenchNav}
        <div className="wb-tm-body">
          {mainContent}
        </div>
      </div>
    );
  }

  return layout;
};

export default TemplateManagementApp;
