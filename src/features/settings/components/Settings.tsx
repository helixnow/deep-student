import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/settings.css';
import '../styles/api-config-section.css';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { AppSelect } from '@/components/ui/app-menu';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import UnifiedModal from '@/components/UnifiedModal';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter, NotionAlertDialog } from '@/components/ui/NotionDialog';
import { ShadApiEditModal, GENERAL_DEFAULT_MIN_P, GENERAL_DEFAULT_TOP_K } from './ShadApiEditModal';
import { VendorConfigModal, type VendorConfigModalRef } from './VendorConfigModal';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { TauriAPI } from '@/utils/tauriApi';
import { ModelAssignments, VendorConfig, ModelProfile, ApiConfig } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Switch } from '@/components/ui/shad/Switch';
import { cn } from '@/lib/utils';
import { UnifiedCodeEditor } from '@/components/shared/UnifiedCodeEditor';

import { isTauriStdioSupported } from '@/mcp/tauriStdioTransport';
import { MacTopSafeDragZone } from '@/components/layout/MacTopSafeDragZone';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { UnifiedSidebar, UnifiedSidebarHeader, UnifiedSidebarContent, UnifiedSidebarItem } from '@/components/ui/unified-sidebar/UnifiedSidebar';
import useTheme, { type ThemeMode, type ThemePalette } from '@/hooks/useTheme';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useVendorModels } from '@/hooks/useVendorModels';
import { consumePendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { isAndroid } from '@/utils/platform';
import { ShortcutSettings } from '@/command-palette';
import '@/command-palette/styles/shortcut-settings.css';
import { AppMenuDemo } from '@/components/ui/app-menu';
import { McpToolsSection } from './McpToolsSection';
import { ModelsTab } from './ModelsTab';
import { AboutTab } from './AboutTab';
import { AppearanceTab } from './AppearanceTab';
import { GeneralTab } from './GeneralTab';
import { ApisTab } from './ApisTab';
import { ParamsTab } from './ParamsTab';
import { ExternalSearchTab } from './ExternalSearchTab';
import { SettingsShellSidebar } from './SettingsShellSidebar';
import { useSettingsNavigation } from './useSettingsNavigation';
import { type UnifiedModelInfo } from '@/components/shared/UnifiedModelSelector';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import {
  UI_FONT_STORAGE_KEY,
  DEFAULT_UI_FONT,
  applyFontToDocument,
  UI_FONT_SIZE_STORAGE_KEY,
  DEFAULT_UI_FONT_SIZE,
  applyFontSizeToDocument,
  clampFontSize,
} from '@/config/fontConfig';
import { normalizeMcpToolList } from './mcpUtils';
import { inferCapabilities, getModelDefaultParameters, applyProviderSpecificAdjustments } from '@/utils/modelCapabilities';
import { inferApiCapabilities } from '@/utils/apiCapabilityEngine';
import {
  DEFAULT_STDIO_ARGS,
  DEFAULT_STDIO_ARGS_STORAGE,
  DEFAULT_STDIO_ARGS_PLACEHOLDER,
  CHAT_STREAM_SETTINGS_EVENT,
  UI_ZOOM_STORAGE_KEY,
  DEFAULT_UI_ZOOM,
  clampZoom,
  formatZoomLabel,
  type ZoomStatusState,
} from './constants';
import {
  convertProfileToApiConfig,
  convertApiConfigToProfile,
  normalizeBaseUrl,
  providerTypeFromConfig,
} from './modelConverters';
import type { SystemConfig, SettingsProps } from './types';
import type { SettingsExtra } from './hookDepsTypes';

import { useSettingsVendorState } from './useSettingsVendorState';
import { useSettingsZoomFont } from './useSettingsZoomFont';
import { useMcpEditorSection } from './McpEditorSection';
import { useSettingsConfig } from './useSettingsConfig';
import { resolveVoiceInputModelAssignment } from '@/voice-input/modelSelection';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE: React.CSSProperties = {
  background: 'var(--shell-workspace-panel)',
  borderBottom: 0,
};

const normalizeThemeMode = (value: unknown): ThemeMode => {
  if (value === 'dark' || value === 'auto') return value;
  return 'light';
};

const normalizeThemePalette = (value: unknown): ThemePalette => {
  // 迁移旧值：colorsafe -> muted（柔和色调，对色弱友好）
  if (value === 'colorsafe' || value === 'accessible') return 'muted';
  // 检查是否是有效的调色板值
  const validPalettes: ThemePalette[] = ['default', 'purple', 'green', 'orange', 'pink', 'teal', 'muted', 'paper', 'custom'];
  if (validPalettes.includes(value as ThemePalette)) return value as ThemePalette;
  return 'default';
};

import {
  Plus,
  Trash,
  X,
  Check,
  ArrowCounterClockwise,
  Info as InfoIcon,
  Stack,
  CaretRight,
} from '@phosphor-icons/react';
import { type McpStatusInfo } from '@/mcp/mcpService';
import { testMcpSseFrontend, testMcpHttpFrontend, testMcpWebsocketFrontend } from '@/mcp/mcpFrontendTester';
import { getBuiltinServer, BUILTIN_SERVER_ID } from '@/mcp/builtinMcpServer';
import UnifiedErrorHandler, { useUnifiedErrorHandler } from '@/components/UnifiedErrorHandler';
import { DataImportExport } from '@/components/DataImportExport';
import { DataGovernanceDashboard } from './DataGovernanceDashboard';
// Tauri 2.x API导入
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
// ★ 2025-01-03: userPreferenceProfile 已删除，由新的 User Memory 系统替代
// ★ 2026-01-15: 导师模式已迁移到 Skills 系统，不再需要自定义 prompt

// Tauri类型声明
declare global {
  interface Window {
    __TAURI_INTERNALS__?: any;
  }
}

// 检查是否在Tauri环境中
const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;



export const Settings: React.FC<SettingsProps> = ({ onBack, mobilePresentation = 'page' }) => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const isMobileSheetPresentation = isSmallScreen && mobilePresentation === 'sheet';
  const effectiveMobilePanelMode = isSmallScreen && !isMobileSheetPresentation;
  const {
    mode: themeMode,
    isDarkMode,
    isSystemDark,
    palette: themePalette,
    customColor,
    setThemeMode,
    setThemePalette,
    setCustomColor,
  } = useTheme();

  // 移动端三屏布局状态（需要在 useMobileHeader 之前定义）
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  // 右侧面板类型：用于统一管理移动端右侧滑动面板内容
  const [rightPanelType, setRightPanelType] = useState<'none' | 'modelEditor' | 'mcpTool' | 'mcpPolicy' | 'vendorConfig'>('none');
  // 供应商配置 Modal ref（用于移动端顶栏保存按钮调用）
  const vendorConfigModalRef = useRef<VendorConfigModalRef>(null);

  // 移动端统一顶栏配置 - 带面包屑导航
  // 获取当前标签页的显示名称（需要在 useMobileHeader 之前定义）
  const activeTab = useSettingsShellStore((state) => state.activeTab);
  const setActiveTab = useSettingsShellStore((state) => state.setActiveTab);
  const dataGovernanceTabTarget = useSettingsShellStore((state) => state.dataGovernanceTabTarget);
  const applySettingsRoute = useSettingsShellStore((state) => state.applySettingsRoute);
  
  // 标签页名称映射（用于面包屑显示）
  const getActiveTabLabel = useCallback(() => {
    const tabLabels: Record<string, string> = {
      'app': t('settings:tabs.app'),
      'general': t('settings:tabs.general'),
      'appearance': t('settings:tabs.appearance'),
      // UI 文案已统一为“模型服务”，内部 tab id 仍保持 apis 以最小化改动面
      'apis': t('settings:tabs.api_config'),
      'models': t('settings:tabs.model_assignment'),
      'mcp': t('settings:tabs.mcp_tools'),
      'search': t('settings:tabs.external_search'),
      'statistics': t('settings:tabs.statistics'),
      'data-governance': t('settings:tabs.data_governance'),
      'params': t('settings:tabs.params'),
      'shortcuts': t('settings:tabs.shortcuts'),
      'about': t('settings:tabs.about'),
    };
    return tabLabels[activeTab] || activeTab;
  }, [activeTab, t]);

  const activeTabDescription = useMemo(() => {
    const descriptions: Record<string, string> = {
      general: t('settings:study_ui_descriptions.general', '管理语言、交互习惯、输入方式和个人偏好。'),
      appearance: t('settings:study_ui_descriptions.appearance', '自定义主题、字体、缩放和界面视觉风格。'),
      app: t('settings:study_ui_descriptions.app', '管理主题、语言、界面缩放和工作区外观。'),
      apis: t('settings:study_ui_descriptions.apis', '配置模型服务、供应商和连接方式。'),
      models: t('settings:study_ui_descriptions.models', '把不同任务分配到合适的模型。'),
      mcp: t('settings:study_ui_descriptions.mcp', '管理工具连接、服务器和可用能力。'),
      search: t('settings:study_ui_descriptions.search', '设置联网搜索、外部检索和知识来源。'),
      statistics: t('settings:study_ui_descriptions.statistics', '查看学习、对话和使用统计。'),
      'data-governance': t('settings:study_ui_descriptions.data_governance', '处理备份、恢复、导入导出与数据治理。'),
      params: t('settings:study_ui_descriptions.params', '调整生成参数和默认行为。'),
      shortcuts: t('settings:study_ui_descriptions.shortcuts', '查看和整理快捷键入口。'),
      about: t('settings:study_ui_descriptions.about', '查看版本、协议和应用说明。'),
    };
    return descriptions[activeTab] || t('settings:study_ui_descriptions.default', '在这里整理应用偏好与工作流设置。');
  }, [activeTab, t]);

  // 面包屑导航组件（内联）
  const SettingsBreadcrumb = useMemo(() => {
    if (screenPosition === 'right') {
      // 右侧面板时显示简单标题
      return (
        <h1 className="text-base font-semibold truncate">
          {t('settings:title_edit')}
        </h1>
      );
    }
    // 中间视图：显示面包屑 "系统设置 > 当前标签"
    return (
      <div className="flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap">
        <span className="truncate max-w-[80px]">
          {t('settings:title')}
        </span>
        <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[120px]">
          {getActiveTabLabel()}
        </span>
      </div>
    );
  }, [screenPosition, t, getActiveTabLabel]);

  // 移动端顶栏右侧操作按钮
  const settingsHeaderRightActions = useMemo(() => {
    // 供应商配置面板：显示保存按钮
    if (screenPosition === 'right' && rightPanelType === 'vendorConfig') {
      return (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => vendorConfigModalRef.current?.save()} title={t('common:actions.save')} aria-label="save" className="text-primary">
          <Check size={20} />
        </NotionButton>
      );
    }
    return undefined;
  }, [screenPosition, rightPanelType, t]);

  useMobileHeader('settings', {
    // 使用 titleNode 渲染面包屑导航
    titleNode: SettingsBreadcrumb,
    showMenu: true,
    // 右侧面板时，左上角按钮返回主视图；其他情况切换左侧栏
    onMenuClick: screenPosition === 'right'
      ? () => setScreenPosition('center')
      : () => setScreenPosition(prev => prev === 'left' ? 'center' : 'left'),
    // 右侧面板时显示返回箭头
    showBackArrow: screenPosition === 'right',
    // 右侧操作按钮
    rightActions: settingsHeaderRightActions,
  }, [SettingsBreadcrumb, screenPosition, settingsHeaderRightActions]);

  const isTauriEnvironment = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  const [uiZoom, setUiZoom] = useState<number>(DEFAULT_UI_ZOOM);
  const [zoomLoading, setZoomLoading] = useState<boolean>(isTauriEnvironment);
  const [zoomSaving, setZoomSaving] = useState(false);
  const [zoomStatus, setZoomStatus] = useState<ZoomStatusState>({ type: 'idle' });
  const [uiFont, setUiFont] = useState<string>(DEFAULT_UI_FONT);
  const [fontLoading, setFontLoading] = useState<boolean>(isTauriEnvironment);
  const [fontSaving, setFontSaving] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<number>(DEFAULT_UI_FONT_SIZE);
  const [fontSizeLoading, setFontSizeLoading] = useState<boolean>(isTauriEnvironment);
  const [fontSizeSaving, setFontSizeSaving] = useState(false);
  const [logTypeForOpen, setLogTypeForOpen] = useState<string>('backend');
  const [config, setConfig] = useState<SystemConfig>({
    apiConfigs: [],
    model2ConfigId: '',
    ankiCardModelConfigId: '',
    qbank_ai_grading_model_config_id: '',
    // 嵌入模型通过维度管理设置
    rerankerModelConfigId: '',
    autoSave: true,
    theme: 'light',
    themePalette: 'default',
    debugMode: false,
    ragEnabled: false,
    ragTopK: 5,
    ankiConnectEnabled: false,
    exam_sheet_ocr_model_config_id: '', // 新增：题目集识别OCR专用模型配置ID
    translation_model_config_id: '', // 新增：翻译专用模型配置ID
    chat_title_model_config_id: '', // 新增：聊天标题生成模型配置ID
    // 多模态知识库模型配置（嵌入模型通过维度管理设置）
    vl_reranker_model_config_id: '', // 多模态重排序模型
    memory_decision_model_config_id: '', // 记忆决策模型
    voice_input_asr_model_config_id: '', // 语音输入 ASR 模型
    image_generation_model_config_id: '', // 生图模型
    translation_display_mode: 'aligned', // 聊天翻译显示模式：'aligned' 短语对照（默认）/ 'streaming' 流式纯译文

    // MCP 工具协议设置（默认保持可配置；启用与否由消息级选择决定）
    mcpCommand: 'npx',
    mcpArgs: DEFAULT_STDIO_ARGS_STORAGE,
    mcpTransportType: 'stdio',
    mcpUrl: 'ws://localhost:8000',
    mcpAdvertiseAll: false,
    mcpWhitelist: 'read_file, write_file, list_directory',
    mcpBlacklist: 'delete_file, execute_command, rm, sudo',
    mcpTimeoutMs: 15000,
    mcpRateLimit: 10,
    mcpCacheMax: 500,
    mcpCacheTtlMs: 300000,
    mcpTools: [],

    // 外部搜索设置（启用与否由消息级选择决定）
    webSearchEngine: '',  // 默认不使用
    webSearchTimeoutMs: 15000,
    webSearchGoogleKey: '',
    webSearchGoogleCx: '',
    webSearchSerpApiKey: '',
    webSearchTavilyKey: '',
    webSearchBraveKey: '',
    webSearchSearxngEndpoint: '',
    webSearchSearxngKey: '',
    webSearchZhipuKey: '',
    webSearchBochaKey: '',
    webSearchWhitelist: '',
    webSearchBlacklist: '',
    webSearchInjectSnippetMax: 180,
    webSearchInjectTotalMax: 1900,
  });
  const {
    vendors,
    modelProfiles,
    modelAssignments,
    resolvedApiConfigs,
    loading: vendorLoading,
    saving: vendorSaving,
    upsertVendor,
    deleteVendor,
    upsertModelProfile,
    deleteModelProfile,
    saveModelAssignments: persistAssignments,
    persistModelProfiles,
    persistVendors,
  } = useVendorModels();
  // 注意：模型分配页面使用 config.apiConfigs（从后端 get_api_configurations 获取，enabled 状态正确）
  // resolvedApiConfigs 仅用于 API 配置页面的编辑功能
  // 当供应商/模型配置变更时，从后端刷新 ApiConfig 列表（作为“单一事实来源”）
  const refreshApiConfigsFromBackend = useCallback(async () => {
    try {
      if (!invoke) return;
      const apiConfigs = (await invoke('get_api_configurations').catch(() => [])) as ApiConfig[];
      const mappedApiConfigs = (apiConfigs || []).map((c: ApiConfig) => ({
        ...c,
        maxOutputTokens: c.maxOutputTokens,
        temperature: c.temperature,
      }));
      setConfig((prev) => {
        if (prev.apiConfigs.length === mappedApiConfigs.length &&
            prev.apiConfigs.every((c, i) => c.id === mappedApiConfigs[i]?.id && c.enabled === mappedApiConfigs[i]?.enabled)) {
          return prev;
        }
        return { ...prev, apiConfigs: mappedApiConfigs };
      });
    } catch (e) {
      // 静默失败：不阻塞设置页、避免控制台警告噪音
    }
  }, [invoke, setConfig]);

  useEffect(() => {
    const onChanged = () => {
      void refreshApiConfigsFromBackend();
    };
    try {
      window.addEventListener('api_configurations_changed', onChanged);
    } catch {
      // Best-effort listener registration only.
    }
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', onChanged);
      } catch {
        // Best-effort listener cleanup only.
      }
    };
  }, [refreshApiConfigsFromBackend]);

  useEffect(() => {
    setConfig(prev => ({
      ...prev,
      model2ConfigId: modelAssignments.model2_config_id || '',
      ankiCardModelConfigId: modelAssignments.anki_card_model_config_id || '',
      qbank_ai_grading_model_config_id: modelAssignments.qbank_ai_grading_model_config_id || '',
      rerankerModelConfigId: modelAssignments.reranker_model_config_id || '',
      exam_sheet_ocr_model_config_id: modelAssignments.exam_sheet_ocr_model_config_id || '',
      translation_model_config_id: modelAssignments.translation_model_config_id || '',
      chat_title_model_config_id: modelAssignments.chat_title_model_config_id || '',
      // 多模态知识库模型（嵌入模型通过维度管理设置）
      vl_reranker_model_config_id: modelAssignments.vl_reranker_model_config_id || '',
      memory_decision_model_config_id: modelAssignments.memory_decision_model_config_id || '',
      voice_input_asr_model_config_id: modelAssignments.voice_input_asr_model_config_id || '',
      image_generation_model_config_id: modelAssignments.image_generation_model_config_id || '',
      translation_display_mode: (modelAssignments.translation_display_mode === 'streaming' ? 'streaming' : 'aligned'),
    }));
  }, [modelAssignments]);

  useEffect(() => {
    setConfig(prev => {
      if (prev.theme === themeMode && prev.themePalette === themePalette) {
        return prev;
      }
      return {
        ...prev,
        theme: themeMode,
        themePalette,
      };
    });
  }, [themeMode, themePalette]);

  useEffect(() => {
    if (!Array.isArray(config.mcpTools)) {
      const normalized = normalizeMcpToolList(config.mcpTools);
      setConfig(prev => ({ ...prev, mcpTools: normalized }));
    }
  }, [config.mcpTools]);

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // 🔧 修复：防止 loadConfig 失败时 auto-save 用空默认值覆写后端已有配置
  const configLoadedRef = useRef(false);
  const [extra, setExtra] = useState<SettingsExtra>({});
  const [showAppMenuDemo, setShowAppMenuDemo] = useState(false);
  const isMcpLoading = activeTab === 'mcp' && loading;
  const { sidebarNavItems } = useSettingsNavigation();

  // 顶部栏顶部边距高度设置（用于安卓状态栏等场景）
  const [topbarTopMargin, setTopbarTopMargin] = useState<string>('');
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        const v = await (invoke as typeof tauriInvoke)('get_setting', { key: 'topbar.top_margin' });
        const value = String(v ?? '').trim();
        if (value) {
          setTopbarTopMargin(value);
        } else {
          // 如果设置不存在，显示平台默认值（但不保存，让App.tsx使用默认值）
          const defaultValue = isAndroid() ? '30' : '0';
          setTopbarTopMargin(defaultValue);
        }
      } catch {
        // 出错时显示平台默认值
        const defaultValue = isAndroid() ? '30' : '0';
        setTopbarTopMargin(defaultValue);
      }
    })();
  }, []);

  // 开发者选项：显示消息请求体
  const [showRawRequest, setShowRawRequest] = useState<boolean>(false);
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        const v = await (invoke as typeof tauriInvoke)('get_setting', { key: 'dev.show_raw_request' });
        const value = String(v ?? '').trim().toLowerCase();
        setShowRawRequest(value === 'true' || value === '1');
      } catch {
        setShowRawRequest(false);
      }
    })();
  }, []);

  // 标签页指示器状态
  const [indicatorStyle, setIndicatorStyle] = useState({ transform: 'translateX(0)', width: 0 });
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const tabButtonsContainerRef = useRef<HTMLDivElement | null>(null);

  // MCP 状态
  const [mcpStatusInfo, setMcpStatusInfo] = useState<McpStatusInfo | null>(null);

  const closeRightPanel = useCallback(() => {
    setRightPanelType('none');
    setScreenPosition('center');
  }, []);

  // ========== Hook 调用 ==========
  const { handleZoomChange, handleZoomReset, handleFontChange, handleFontReset, handleFontSizeChange, handleFontSizeReset, normalizedMcpServers } = useSettingsZoomFont({ isTauriEnvironment, setZoomLoading, setUiZoom, setZoomSaving, setZoomStatus, t, setFontLoading, setUiFont, setFontSaving, setFontSizeLoading, setUiFontSize, setFontSizeSaving, config });

  const updateIndicatorRafRef = useRef<((tabId: string) => void) | null>(null);
  const { loadConfig, handleSave, saveSingleAssignmentField, handleTabChange } = useSettingsConfig({ setLoading, configLoadedRef, setExtra, setActiveTab, activeTab, modelAssignments, vendors, modelProfiles, resolvedApiConfigs, refreshVendors: undefined, refreshProfiles: undefined, refreshApiConfigsFromBackend, persistAssignments, saving, setSaving, t, config, setConfig, loading, updateIndicatorRaf: (tabId: string) => updateIndicatorRafRef.current?.(tabId) });

  const vendorState = useSettingsVendorState({ resolvedApiConfigs, vendorLoading, vendorSaving, vendors, modelProfiles, modelAssignments, config, t, loading, upsertVendor, upsertModelProfile, deleteModelProfile, persistAssignments, persistModelProfiles, persistVendors, closeRightPanel, refreshVendors: undefined, refreshProfiles: undefined, refreshApiConfigsFromBackend, isSmallScreen: effectiveMobilePanelMode, setScreenPosition, setRightPanelType, activeTab, deleteVendorById: deleteVendor });
  const { selectedVendorId, setSelectedVendorId, vendorModalOpen, setVendorModalOpen, editingVendor, setEditingVendor, isEditingVendor, vendorFormData, setVendorFormData, modelEditor, setModelEditor, inlineEditState, setInlineEditState, isAddingNewModel, setIsAddingNewModel, modelDeleteDialog, setModelDeleteDialog, vendorDeleteDialog, setVendorDeleteDialog, testingApi, vendorBusy, sortedVendors, selectedVendor, selectedVendorModels, profileCountByVendor, selectedVendorIsSiliconflow, testApiConnection, handleOpenVendorModal, handleStartEditVendor, handleCancelEditVendor, handleSaveEditVendor, handleSaveVendorModal, handleDeleteVendor, handleSaveVendorApiKey, handleSaveVendorBaseUrl, handleReorderVendors, confirmDeleteVendor, handleOpenModelEditor, handleSaveModelProfile, handleSaveInlineEdit, handleAddModelInline, handleCloseModelEditor, handleSaveModelProfileAndClose, handleDeleteModelProfile, confirmDeleteModelProfile, handleToggleModelProfile, handleToggleFavorite, handleSiliconFlowConfig, handleAddVendorModels, getAllEnabledApis, getEmbeddingApis, getRerankerApis, getAsrApis, getImageGenerationApis, toUnifiedModelInfo, handleBatchCreateConfigs, handleApplyPreset, handleBatchConfigsCreated, handleClearVendorApiKey, isSensitiveKey, maskApiKey, apiConfigsForApisTab } = vendorState;

  const voiceInputAssignedModel = useMemo(
    () =>
      resolveVoiceInputModelAssignment(
        {
          voice_input_asr_model_config_id: config.voice_input_asr_model_config_id || null,
        },
        config.apiConfigs
      ),
    [config.apiConfigs, config.voice_input_asr_model_config_id]
  );

  const mcpSection = useMcpEditorSection({ config, setConfig, isSmallScreen: effectiveMobilePanelMode, activeTab, setActiveTab, setScreenPosition, setRightPanelType, t, extra, setExtra, handleSave, normalizedMcpServers, setMcpStatusInfo });
  const { mcpPolicyModal, setMcpPolicyModal, mcpPreview, mcpTestStep, stripMcpPrefix, emitChatStreamSettingsUpdate, refreshSnapshots, handleDeleteMcpTool, handleSaveMcpServer, handleTestServer, handleReconnectClient, handleAddMcpTool, handleOpenMcpPolicy, handleClosePreview, renderMcpToolEditor, renderMcpToolEditorEmbedded, renderMcpPolicyEditorEmbedded, mcpCachedDetails, mcpServers, serverStatusMap, lastError, cacheCapacity, lastCacheUpdatedAt, lastCacheUpdatedText, connectedServers, totalServers, totalCachedTools, promptsCount, resourcesCount, cacheUsagePercent, latestPrompts, latestResources, mcpErrors, clearMcpErrors, dismissMcpError, handleRunHealthCheck, handleClearCaches, handleRefreshRegistry } = mcpSection;

  const handleSaveChatStreamTimeout = useCallback(async () => {
    const raw = String(extra?.chatStreamTimeoutSeconds ?? '').trim();
    if (!invoke) {
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_timeout', { error: 'invoke unavailable' }));
      return;
    }
    let payloadValue = '';
    let timeoutMs: number | null = null;
    if (raw) {
      const numericSeconds = Number(raw);
      if (!Number.isFinite(numericSeconds) || numericSeconds < 0) {
        showGlobalNotification('error', t('common:settings.chat_stream.invalid_timeout'));
        return;
      }
      const roundedSeconds = Math.round(numericSeconds);
      timeoutMs = roundedSeconds * 1000;
      payloadValue = String(timeoutMs);
    }
    try {
      await invoke('save_setting', { key: 'chat.stream.timeout_ms', value: payloadValue });
      showGlobalNotification('success', t('common:settings.chat_stream.save_success_timeout'));
      const savedValue = raw ? String(Math.round(Number(raw))) : '';
      setExtra(prev => ({
        ...prev,
        chatStreamTimeoutSeconds: savedValue,
        _lastSavedTimeoutSeconds: savedValue,
      }));
      emitChatStreamSettingsUpdate({ timeoutMs });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('[Settings] 保存聊天流式超时失败:', error);
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_timeout', { error: errorMessage }));
      setExtra(prev => ({
        ...prev,
        chatStreamTimeoutSeconds: prev._lastSavedTimeoutSeconds ?? '',
      }));
    }
  }, [emitChatStreamSettingsUpdate, extra, invoke, showGlobalNotification, t]);

  const handleToggleChatStreamAutoCancel = useCallback(async (checked: boolean) => {
    setExtra(prev => ({ ...prev, chatStreamAutoCancel: checked }));
    if (!invoke) {
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_auto_cancel', { error: 'invoke unavailable' }));
      return;
    }
    try {
      await invoke('save_setting', { key: 'chat.stream.auto_cancel_on_timeout', value: checked ? '1' : '0' });
      showGlobalNotification('success', t('common:settings.chat_stream.save_success_auto_cancel'));
      emitChatStreamSettingsUpdate({ autoCancel: checked });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('[Settings] 保存聊天流式自动取消失败:', error);
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_auto_cancel', { error: errorMessage }));
      setExtra(prev => ({ ...prev, chatStreamAutoCancel: !checked }));
    }
  }, [emitChatStreamSettingsUpdate, invoke, showGlobalNotification, t]);

  // 🔧 R2-9: 合并为单一 useEffect，避免竞态写入
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        // 并行加载所有参数调整相关设置
        const [ftsVal, rrfk, wfts, wvec, rawTimeout, rawAutoCancel] = await Promise.all([
          invoke<string | null>('get_setting', { key: 'search.chat.semantic.fts_prefilter.enabled' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'search.chat.rrf.k' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'search.chat.rrf.w_fts' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'search.chat.rrf.w_vec' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'chat.stream.timeout_ms' }).catch(() => null),
          invoke<string | null>('get_setting', { key: 'chat.stream.auto_cancel_on_timeout' }).catch(() => null),
        ]);

        const ftsEnabled = ftsVal ? (ftsVal === '1' || ftsVal.toLowerCase() === 'true') : true;

        const timeoutMs = (() => {
          if (!rawTimeout) return null;
          const trimmed = String(rawTimeout).trim();
          if (!trimmed) return null;
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        })();
        const secondsString = timeoutMs != null ? String(Math.round(timeoutMs / 1000)) : '';

        const autoCancel = (() => {
          if (!rawAutoCancel) return true;
          const lowered = String(rawAutoCancel).trim().toLowerCase();
          if (!lowered) return true;
          return !(lowered === '0' || lowered === 'false');
        })();

        // 一次性更新全部，避免竞态
        setExtra(prev => ({
          ...prev,
          chatSemanticFtsPrefilter: ftsEnabled,
          rrf_k: rrfk || '',
          rrf_w_fts: wfts || '',
          rrf_w_vec: wvec || '',
          chatStreamTimeoutSeconds: secondsString,
          chatStreamAutoCancel: autoCancel,
          _lastSavedTimeoutSeconds: secondsString,
        }));
      } catch (error) {
        console.warn('[Settings] 加载参数调整设置失败:', error);
      }
    })();
  }, [invoke]);

  // 处理返回按钮，确保在返回前保存配置
  // 🔧 修复：仅在 config 成功加载后才保存，防止 loadConfig 失败时覆写后端真实配置
  const handleBack = async () => {
    if (!loading && configLoadedRef.current) {
      await handleSave(true); // 静默保存
    }
    onBack();
  };

  // 启动时消费 pending settings tab（防止导航事件竞态丢失）
  useEffect(() => {
    const pending = consumePendingSettingsRoute();
    if (pending) {
      applySettingsRoute(pending);
    }
  }, [applySettingsRoute]);

  // P1-09: 监听命令面板的 tab 跳转事件
  useEffect(() => {
    const handleNavigateTab = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: string; dataGovernanceTab?: string }>;
      const tab = customEvent.detail?.tab;
      if (tab) {
        applySettingsRoute({
          tab,
          dataGovernanceTab: customEvent.detail?.dataGovernanceTab,
        });
      }
    };
    window.addEventListener('SETTINGS_NAVIGATE_TAB', handleNavigateTab);
    return () => {
      window.removeEventListener('SETTINGS_NAVIGATE_TAB', handleNavigateTab);
    };
  }, [applySettingsRoute]);

  // 当进入 MCP 标签或配置变化时刷新缓存快照
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    let disposed = false;
    (async () => {
      try {
        await refreshSnapshots();
      } catch (e) {
        console.warn('[Settings] MCP 快照刷新失败:', e);
      }
      if (disposed) return;
    })();
    return () => {
      disposed = true;
    };
  }, [activeTab, config.mcpTools, refreshSnapshots]);

  // 订阅 MCP 状态信息
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { McpService } = await import('@/mcp/mcpService');
        const status = await McpService.status().catch(() => null);
        if (!cancelled && status) setMcpStatusInfo(status);
        unsub = McpService.onStatus((s) => setMcpStatusInfo(s));
      } catch (e) {
        console.warn('[Settings] MCP 状态订阅初始化失败:', e);
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [activeTab]);

  const renderVendorConfigEmbedded = () => {
    if (!vendorModalOpen) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:vendor_panel.select_vendor_to_edit')}</p>
        </div>
      );
    }

    const handleClose = () => {
      setVendorModalOpen(false);
      setEditingVendor(null);
      closeRightPanel();
    };

    return (
      <div
        className="h-full flex flex-col bg-background"
        style={{
          paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <VendorConfigModal
          ref={vendorConfigModalRef}
          open={vendorModalOpen}
          vendor={editingVendor}
          onClose={handleClose}
          onSave={handleSaveVendorModal}
          embeddedMode={true}
        />
      </div>
    );
  };

  // 指示器位置更新（rAF 节流，避免同步强制回流）
  const indicatorRafId = useRef<number | null>(null);
  const updateIndicatorRaf = useCallback((tabId: string) => {
    if (indicatorRafId.current != null) return;
    indicatorRafId.current = requestAnimationFrame(() => {
      indicatorRafId.current = null;
      try {
        const tabElement = tabsRef.current.get(tabId);
        const buttonsEl = tabButtonsContainerRef.current;
        if (tabElement && buttonsEl) {
          const left = Math.max(0, tabElement.offsetLeft + buttonsEl.offsetLeft - buttonsEl.scrollLeft);
          setIndicatorStyle({
            transform: `translateX(${left}px)`,
            width: tabElement.offsetWidth,
          });
        }
      } catch (e) {
        console.warn('[Settings] updateIndicator skipped:', e);
      }
    });
  }, []);
  updateIndicatorRafRef.current = updateIndicatorRaf;
  
  // 初始化和窗口大小变化时更新指示器（使用 rAF 代替 setTimeout 延迟）
  useEffect(() => {
    if (!loading && activeTab) {
      // 使用双 rAF，等待布局稳定（下一帧之后再计算）
      let raf1 = 0, raf2 = 0;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => updateIndicatorRaf(activeTab));
      });

      const handleResize = debounce(() => updateIndicatorRaf(activeTab), 100);
      window.addEventListener('resize', handleResize);

      // 横向滚动时保持指示器与选中标签对齐
      const buttonsEl = tabButtonsContainerRef.current;
      const handleScroll = () => updateIndicatorRaf(activeTab);
      if (buttonsEl) buttonsEl.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        window.removeEventListener('resize', handleResize);
        if (buttonsEl) buttonsEl.removeEventListener('scroll', handleScroll);
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
  }, [loading, activeTab, updateIndicatorRaf]);

  // 添加防抖函数
  function debounce(func: (...args: unknown[]) => void, wait: number) {
    let timeout: ReturnType<typeof setTimeout>;
    return function(...args: unknown[]) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  useEffect(() => {
    loadConfig();
  }, []);

  // 监听模型分配变更事件（Chat V2 修改默认模型后广播）
  useEffect(() => {
    const reloadAssignments = async () => {
      try {
        const modelAssignments = await invoke<{
          model2_config_id: string | null;
          anki_card_model_config_id: string | null;
          qbank_ai_grading_model_config_id: string | null;
          reranker_model_config_id: string | null;
          exam_sheet_ocr_model_config_id: string | null;
          translation_model_config_id: string | null;
          chat_title_model_config_id: string | null;
          vl_reranker_model_config_id: string | null;
          memory_decision_model_config_id: string | null;
          voice_input_asr_model_config_id: string | null;
          image_generation_model_config_id: string | null;
          translation_display_mode: string | null;
        }>('get_model_assignments');
        setConfig(prev => ({
          ...prev,
          model2ConfigId: modelAssignments?.model2_config_id || '',
          ankiCardModelConfigId: modelAssignments?.anki_card_model_config_id || '',
          qbank_ai_grading_model_config_id: modelAssignments?.qbank_ai_grading_model_config_id || '',
          rerankerModelConfigId: modelAssignments?.reranker_model_config_id || '',
          chat_title_model_config_id: modelAssignments?.chat_title_model_config_id || '',
          exam_sheet_ocr_model_config_id: modelAssignments?.exam_sheet_ocr_model_config_id || '',
          translation_model_config_id: modelAssignments?.translation_model_config_id || '',
          vl_reranker_model_config_id: modelAssignments?.vl_reranker_model_config_id || '',
          memory_decision_model_config_id: modelAssignments?.memory_decision_model_config_id || '',
          voice_input_asr_model_config_id: modelAssignments?.voice_input_asr_model_config_id || '',
          image_generation_model_config_id: modelAssignments?.image_generation_model_config_id || '',
          translation_display_mode: (modelAssignments?.translation_display_mode === 'streaming' ? 'streaming' : 'aligned'),
        }));
      } catch {
        // Ignore malformed cached assignments and keep current settings state.
      }
    };
    window.addEventListener('model_assignments_changed', reloadAssignments);
    return () => window.removeEventListener('model_assignments_changed', reloadAssignments);
  }, []);

  // 自动保存配置（当配置发生变化时）
  // 注意：模型分配已经在onChange中立即保存，这里主要处理其他配置项
  // 🔧 使用 ref 持有 handleSave，避免 handleSave 引用变化（因 config 对象重建）导致 auto-save effect 无限重跑
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    // 🔧 修复：仅在 config 成功加载后才允许 auto-save
    // 防止 loadConfig 失败（setConfig 被跳过）时，用空默认值覆写后端真实配置
    if (!loading && config.autoSave && configLoadedRef.current) {
      const timeoutId = setTimeout(() => {
        // 只保存API配置和通用设置，模型分配已经立即保存了
        handleSaveRef.current(true); // 静默保存
      }, 1000); // 1秒后自动保存

      return () => clearTimeout(timeoutId);
    }
  }, [config.autoSave, config.theme, config.themePalette, loading,
    // 🔧 修复：搜索引擎 API key 变更也需触发自动保存，避免用户配置后未保存即离开
    config.webSearchGoogleKey, config.webSearchSerpApiKey, config.webSearchTavilyKey,
    config.webSearchBraveKey, config.webSearchSearxngKey, config.webSearchZhipuKey,
    config.webSearchBochaKey, config.webSearchSearxngEndpoint, config.webSearchGoogleCx,
  ]);

  if (loading) {
    if (isMobileSheetPresentation) {
      return (
        <div
          data-slot="mobile-settings-sheet-real-content"
          className="flex min-h-0 flex-1 flex-col bg-background text-foreground [--background:0_0%_100%] [--border:220_13%_90%] [--card:0_0%_100%] [--foreground:0_0%_7%] [--muted:220_14%_96%] [--muted-foreground:220_6%_44%] [--popover:0_0%_100%]"
        >
          <div className="flex gap-2 overflow-hidden border-b border-border px-5 py-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-11 w-24 shrink-0 rounded-[14px] bg-muted animate-pulse" />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t('settings:loading')}
          </div>
        </div>
      );
    }

    if (!isSmallScreen) {
      return (
        <div className="settings absolute inset-0 flex flex-col overflow-hidden bg-[color:var(--shell-workspace-panel)]">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-muted-foreground">{t('settings:loading')}</div>
          </div>
        </div>
      );
    }

    return (
      <div className="settings absolute inset-0 flex flex-row overflow-hidden bg-background">
        <MacTopSafeDragZone className="settings-top-safe-drag-zone" style={SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE} />
        <div className="h-full flex flex-col bg-background pt-[5px] border-r border-border/40 w-52">
          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg">
                <div className="w-4 h-4 rounded bg-muted animate-pulse" />
                <div className="h-4 rounded bg-muted animate-pulse flex-1" />
              </div>
            ))}
          </nav>
          <div className="shrink-0 h-11 flex items-center justify-center px-2 border-t border-border">
            <div className="w-4 h-4 rounded bg-muted/50 animate-pulse" />
          </div>
        </div>
        <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-background">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-muted-foreground">{t('settings:loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  // 渲染侧边栏内容 - 提取为独立组件
  const renderSettingsSidebar = () => (
    <SettingsShellSidebar
      isSmallScreen={effectiveMobilePanelMode}
      globalLeftPanelCollapsed={false}
      setSidebarOpen={(open) => setScreenPosition(open ? 'left' : 'center')}
      onBack={handleBack}
    />
  );

  const renderSettingsSheetTabRail = () => (
    <div className="shrink-0 border-b border-border bg-background py-2">
      <div className="flex snap-x gap-2 overflow-x-auto px-5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sidebarNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.value;

          return (
            <button
              key={item.value}
              ref={(el) => {
                if (el) tabsRef.current.set(item.value, el);
                else tabsRef.current.delete(item.value);
              }}
              type="button"
              onClick={() => setActiveTab(item.value)}
              className={cn(
                "inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-[14px] px-3.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  // 渲染主内容区域
  const renderSettingsMainContent = ({ sheetMode = false }: { sheetMode?: boolean } = {}) => (
    <div
      id="settings-main-content"
      className={cn(
        'flex-1 min-w-0 h-full flex flex-col overflow-hidden max-w-full relative bg-[color:var(--shell-workspace-panel)]',
        sheetMode && "bg-background text-foreground"
      )}
      data-slot={sheetMode ? 'mobile-settings-sheet-content' : undefined}
    >
        <CustomScrollArea
          className="flex-1 w-full max-w-full overflow-x-hidden"
          viewportClassName={cn(
            sheetMode
              ? "px-5 pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))] pt-4"
              : "px-6 pb-6 pt-4 sm:px-8 sm:pb-7 sm:pt-5",
            effectiveMobilePanelMode && !sheetMode && "px-4 py-3 pb-20"
          )}
          trackOffsetTop={16}
          trackOffsetBottom={16}
          trackOffsetRight={0}
          style={{ textAlign: 'left' }}
        >
          <div className="mx-auto w-full max-w-[72rem]">
            <div className="space-y-6">
        {/* API配置管理 */}
        {/* API配置管理 */}
        {activeTab === 'apis' && (
          <ApisTab
            vendors={vendors}
            sortedVendors={sortedVendors}
            selectedVendor={selectedVendor}
            selectedVendorId={selectedVendorId}
            setSelectedVendorId={setSelectedVendorId}
            selectedVendorModels={selectedVendorModels}
            selectedVendorIsSiliconflow={selectedVendorIsSiliconflow}
            profileCountByVendor={profileCountByVendor}
            vendorBusy={vendorBusy}
            vendorSaving={vendorSaving}
            isEditingVendor={isEditingVendor}
            vendorFormData={vendorFormData}
            setVendorFormData={setVendorFormData}
            testingApi={testingApi}
            handleOpenVendorModal={handleOpenVendorModal}
            handleStartEditVendor={handleStartEditVendor}
            handleCancelEditVendor={handleCancelEditVendor}
            handleSaveEditVendor={handleSaveEditVendor}
            handleDeleteVendor={handleDeleteVendor}
            handleSaveVendorBaseUrl={handleSaveVendorBaseUrl}
            handleSaveVendorApiKey={handleSaveVendorApiKey}
            handleClearVendorApiKey={handleClearVendorApiKey}
            handleOpenModelEditor={handleOpenModelEditor}
            inlineEditState={inlineEditState}
            setInlineEditState={setInlineEditState}
            handleSaveInlineEdit={handleSaveInlineEdit}
            isAddingNewModel={isAddingNewModel}
            handleAddModelInline={handleAddModelInline}
            handleCancelAddModel={() => { setInlineEditState(null); setIsAddingNewModel(false); }}
            convertProfileToApiConfig={(profile, vendor) => convertProfileToApiConfig(profile, vendor)}
            handleToggleModelProfile={handleToggleModelProfile}
            handleDeleteModelProfile={handleDeleteModelProfile}
            handleToggleFavorite={handleToggleFavorite}
            testApiConnection={testApiConnection}
            handleSiliconFlowConfig={handleSiliconFlowConfig}
            handleBatchCreateConfigs={handleBatchCreateConfigs}
            handleBatchConfigsCreated={handleBatchConfigsCreated}
            onReorderVendors={handleReorderVendors}
            onAddVendorModels={handleAddVendorModels}
            isSmallScreen={effectiveMobilePanelMode}
          />
        )}

        <NotionDialog open={mcpPreview.open} onOpenChange={(open) => { if (!open) handleClosePreview(); }} maxWidth="max-w-3xl">
          <NotionDialogHeader>
            <NotionDialogTitle>{mcpPreview.serverName || t('settings:mcp.preview.default_title')}</NotionDialogTitle>
            <NotionDialogDescription>{t('settings:mcp.preview.description')}</NotionDialogDescription>
            {mcpPreview.serverId && (
              <div className="mt-1 text-xs text-muted-foreground break-all">{t('settings:mcp.preview.id_label')}：{mcpPreview.serverId}</div>
            )}
          </NotionDialogHeader>
          <NotionDialogBody>
            <CustomScrollArea
              className="flex-1 min-h-0 px-6 py-6"
              viewportClassName="px-6 py-6"
              trackOffsetTop={12}
              trackOffsetBottom={12}
              viewportProps={{ style: { maxHeight: '60vh' } }}
            >
              {mcpPreview.loading ? (
                <div className="py-12 text-center text-sm text-muted-foreground">{t('settings:mcp.preview.loading')}</div>
              ) : mcpPreview.error ? (
                <div className="rounded-md border px-3 py-2 text-sm" style={{ background: 'hsl(var(--danger-bg))', color: 'hsl(var(--danger))', borderColor: 'hsl(var(--danger) / 0.3)' }}>
                  {mcpPreview.error}
                </div>
              ) : (
                <div className="grid gap-4">
                  <div className="flex flex-col rounded-lg border bg-muted p-3">
                    <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.tools_count', { count: mcpPreview.tools.length })}</div>
                    {mcpPreview.tools.length === 0 ? (
                      <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('settings:common_labels.no_data')}
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                        {mcpPreview.tools.map((tool, index) => {
                          const formattedName = stripMcpPrefix(tool?.name);
                          return (
                            <div
                              key={`${tool?.name || 'tool'}-${index}`}
                              className="rounded border bg-card px-2 py-2 shadow-sm"
                            >
                              <div
                                className="font-medium text-foreground break-all"
                                title={tool?.name || t('settings:status_labels.unnamed_tool')}
                              >
                                {formattedName || t('settings:status_labels.unnamed_tool')}
                              </div>
                              {tool?.description && (
                                <div className="mt-1 text-muted-foreground leading-5 break-words">
                                  {tool.description}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col rounded-lg border bg-muted p-3">
                    <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.prompts_count', { count: mcpPreview.prompts.length })}</div>
                    {mcpPreview.prompts.length === 0 ? (
                      <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('settings:common_labels.no_data')}
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                        {mcpPreview.prompts.map((prompt, index) => (
                          <div
                            key={`${prompt?.name || 'prompt'}-${index}`}
                            className="rounded border bg-card px-2 py-2 shadow-sm"
                          >
                            <div
                              className="font-medium text-foreground break-all"
                              title={prompt?.name || t('settings:status_labels.unnamed_prompt')}
                            >
                              {prompt?.name || t('settings:status_labels.unnamed_prompt')}
                            </div>
                            {prompt?.description && (
                              <div className="mt-1 text-muted-foreground leading-5 break-words">
                                {prompt.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col rounded-lg border bg-muted p-3">
                    <div className="text-sm font-semibold text-foreground">{t('settings:mcp_descriptions.resources_count', { count: mcpPreview.resources.length })}</div>
                    {mcpPreview.resources.length === 0 ? (
                      <div className="mt-3 rounded-md border border-dashed bg-background/70 px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('settings:common_labels.no_data')}
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                        {mcpPreview.resources.map((res, index) => (
                          <div
                            key={`${res?.uri || res?.name || 'resource'}-${index}`}
                            className="rounded border bg-card px-2 py-2 shadow-sm"
                          >
                            <div
                              className="font-medium text-foreground break-all"
                              title={res?.name || res?.uri || t('settings:status_labels.unnamed_resource')}
                            >
                              {res?.name || stripMcpPrefix(res?.uri) || t('settings:status_labels.unnamed_resource')}
                            </div>
                            {res?.description && (
                              <div className="mt-1 text-muted-foreground leading-5 break-words">
                                {res.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CustomScrollArea>
          </NotionDialogBody>
          <NotionDialogFooter>
            <NotionButton variant="default" size="sm" onClick={handleClosePreview}>{t('common:close')}</NotionButton>
          </NotionDialogFooter>
        </NotionDialog>
        {/* 外部搜索设置 */}
        {activeTab === 'search' && (
          <ExternalSearchTab config={config} setConfig={setConfig} />
        )}
        {/* 模型分配 */}
        {/* 模型分配 */}
        {activeTab === 'models' && (
          <ModelsTab
            config={config}
            setConfig={setConfig}
            apiConfigs={config.apiConfigs}
            toUnifiedModelInfo={toUnifiedModelInfo}
            getAllEnabledApis={getAllEnabledApis}
            getEmbeddingApis={getEmbeddingApis}
            getRerankerApis={getRerankerApis}
            getAsrApis={getAsrApis}
            getImageGenerationApis={getImageGenerationApis}
            saveSingleAssignmentField={saveSingleAssignmentField}
          />
        )}
        {activeTab === 'mcp' && (
          <McpToolsSection
            servers={mcpServers}
            serverStatusMap={serverStatusMap}
            toolsByServer={{
              // 为内置服务器添加工具列表
              [BUILTIN_SERVER_ID]: {
                items: getBuiltinServer().tools.map(t => ({ name: t.name, description: t.description })),
                at: Date.now()
              },
              ...mcpCachedDetails.toolsByServer
            }}
            prompts={mcpCachedDetails.prompts}
            resources={mcpCachedDetails.resources}
            lastCacheUpdatedAt={lastCacheUpdatedAt}
            cacheCapacity={cacheCapacity}
            isLoading={isMcpLoading}
            lastError={lastError}
            onAddServer={handleAddMcpTool}
            onSaveServer={handleSaveMcpServer}
            onDeleteServer={handleDeleteMcpTool}
            onTestServer={handleTestServer}
            testStep={mcpTestStep}
            onReconnect={handleReconnectClient}
            onRefreshRegistry={handleRefreshRegistry}
            onHealthCheck={handleRunHealthCheck}
            onClearCache={handleClearCaches}
            onOpenPolicy={handleOpenMcpPolicy}
          />
        )}
        {/* 数据统计 */}
        {activeTab === 'statistics' && (
          <DataImportExport embedded={true} mode="stats" />
        )}
        {/* 数据治理 */}
        {activeTab === 'data-governance' && (
          <div className="space-y-6">
            <DataGovernanceDashboard tabTarget={dataGovernanceTabTarget} />
          </div>
        )}
        {activeTab === 'general' && (
          <GeneralTab
            voiceInputAssignedModel={voiceInputAssignedModel}
            topbarTopMargin={topbarTopMargin}
            setTopbarTopMargin={setTopbarTopMargin}
            logTypeForOpen={logTypeForOpen}
            setLogTypeForOpen={setLogTypeForOpen}
            showRawRequest={showRawRequest}
            setShowRawRequest={setShowRawRequest}
            invoke={invoke}
          />
        )}
        {activeTab === 'appearance' && (
          <AppearanceTab
            uiZoom={uiZoom}
            zoomLoading={zoomLoading}
            zoomSaving={zoomSaving}
            zoomStatus={zoomStatus}
            handleZoomChange={handleZoomChange}
            handleZoomReset={handleZoomReset}
            uiFont={uiFont}
            fontLoading={fontLoading}
            fontSaving={fontSaving}
            handleFontChange={handleFontChange}
            handleFontReset={handleFontReset}
            uiFontSize={uiFontSize}
            fontSizeLoading={fontSizeLoading}
            fontSizeSaving={fontSizeSaving}
            handleFontSizeChange={handleFontSizeChange}
            handleFontSizeReset={handleFontSizeReset}
            themeMode={themeMode}
            isSystemDark={isSystemDark}
            setThemeMode={setThemeMode}
            themePalette={themePalette}
            setThemePalette={setThemePalette}
            customColor={customColor}
            setCustomColor={setCustomColor}
            isTauriEnvironment={isTauriEnvironment}
            invoke={invoke}
          />
        )}
        {/* 参数调整 */}
        {activeTab === 'params' && (
          <ParamsTab
            extra={extra}
            setExtra={setExtra}
            invoke={invoke}
            handleSaveChatStreamTimeout={handleSaveChatStreamTimeout}
            handleToggleChatStreamAutoCancel={handleToggleChatStreamAutoCancel}
          />
        )}
        {/* MCP 工具编辑模态 */}
        {renderMcpToolEditor()}
        {/* MCP 全局安全策略模态 - 移动端通过右侧滑动面板渲染 */}
        {!isSmallScreen && mcpPolicyModal.open && (
          <UnifiedModal 
            isOpen={true} 
            onClose={() => setMcpPolicyModal(prev => ({ ...prev, open: false }))}
            closeOnOverlayClick={false}
          >
            <div className="bg-popover text-popover-foreground rounded-2xl p-4 max-w-[500px] w-[90%] max-h-[85vh] mx-auto mt-10 overflow-hidden shadow-lg flex flex-col relative" style={{ animation: 'slideUp 0.3s ease' }}>
              {/* 头部 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '16px'
              }}>
                <h3 style={{ margin: '0', fontSize: '18px', fontWeight: '600' }}>{t('settings:mcp.security_policy')}</h3>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setMcpPolicyModal(prev => ({ ...prev, open: false }))} aria-label="close">
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </NotionButton>
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <Switch
                    checked={mcpPolicyModal.advertiseAll}
                    onCheckedChange={(checked) => setMcpPolicyModal(prev => ({ ...prev, advertiseAll: !!checked }))}
                  />
                  <span className="text-sm">{t('settings:mcp_policy.advertise_all')}</span>
                </label>
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                  {t('settings:mcp_policy.whitelist_mode_hint')}
                </div>

                {!mcpPolicyModal.advertiseAll && (
                  <>
                    <label className="text-xs text-foreground">{t('settings:mcp_policy.whitelist_label')}</label>
                    <Input
                      type="text"
                      value={mcpPolicyModal.whitelist}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, whitelist: e.target.value }))}
                      placeholder="read_file, write_file, list_directory"
                    />
                  </>
                )}

                <label className="text-xs text-foreground">{t('settings:mcp_policy.blacklist_label')}</label>
                <Input
                  type="text"
                  value={mcpPolicyModal.blacklist}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, blacklist: e.target.value }))}
                  placeholder="delete_file, execute_command, rm, sudo"
                />
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>{t('settings:mcp_policy.danger_hint')}</div>

                <div className="two-col-grid">
                  <div>
                    <label className="text-xs text-foreground">{t('settings:mcp_policy.timeout_label')}</label>
                    <Input
                      type="number"
                      min={1000}
                      value={mcpPolicyModal.timeoutMs}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-foreground">{t('settings:mcp_policy.rate_limit_label')}</label>
                    <Input
                      type="number"
                      min={1}
                      value={mcpPolicyModal.rateLimit}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_max_label')}</label>
                    <Input
                      type="number"
                      min={0}
                      value={mcpPolicyModal.cacheMax}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        setMcpPolicyModal(prev => ({
                          ...prev,
                          cacheMax: Number.isFinite(parsed) ? Math.max(0, parsed) : 100,
                        }));
                      }}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_ttl_label')}</label>
                    <Input
                      type="number"
                      min={0}
                      value={mcpPolicyModal.cacheTtlMs}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        setMcpPolicyModal(prev => ({
                          ...prev,
                          cacheTtlMs: Number.isFinite(parsed) ? Math.max(0, parsed) : 300000,
                        }));
                      }}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <NotionButton variant="ghost" onClick={() => setMcpPolicyModal(prev => ({ ...prev, open: false }))}>{t('common:actions.cancel')}</NotionButton>
                <NotionButton
                  onClick={async () => {
                    const nextPolicy = {
                      mcpAdvertiseAll: mcpPolicyModal.advertiseAll,
                      mcpWhitelist: mcpPolicyModal.whitelist,
                      mcpBlacklist: mcpPolicyModal.blacklist,
                      mcpTimeoutMs: mcpPolicyModal.timeoutMs,
                      mcpRateLimit: mcpPolicyModal.rateLimit,
                      mcpCacheMax: mcpPolicyModal.cacheMax,
                      mcpCacheTtlMs: mcpPolicyModal.cacheTtlMs,
                    };

                    try {
                      if (invoke) {
                        await Promise.all([
                          invoke('save_setting', { key: 'mcp.tools.advertise_all_tools', value: mcpPolicyModal.advertiseAll.toString() }),
                          invoke('save_setting', { key: 'mcp.tools.whitelist', value: mcpPolicyModal.whitelist }),
                          invoke('save_setting', { key: 'mcp.tools.blacklist', value: mcpPolicyModal.blacklist }),
                          invoke('save_setting', { key: 'mcp.performance.timeout_ms', value: String(mcpPolicyModal.timeoutMs) }),
                          invoke('save_setting', { key: 'mcp.performance.rate_limit_per_second', value: String(mcpPolicyModal.rateLimit) }),
                          invoke('save_setting', { key: 'mcp.performance.cache_max_size', value: String(mcpPolicyModal.cacheMax) }),
                          invoke('save_setting', { key: 'mcp.performance.cache_ttl_ms', value: String(mcpPolicyModal.cacheTtlMs) }),
                        ]);
                      }
                    } catch (err) {
                      const errorMessage = getErrorMessage(err);
                      console.error('保存MCP安全策略失败:', err);
                      showGlobalNotification('error', t('settings:mcp_descriptions.policy_save_failed', { error: errorMessage }));
                      return;
                    }

                    setConfig(prev => ({ ...prev, ...nextPolicy }));
                    showGlobalNotification('success', t('settings:mcp_descriptions.policy_saved'));
                    setMcpPolicyModal(prev => ({ ...prev, open: false }));
                  }}
                >{t('common:save')}</NotionButton>
              </div>
            </div>
          </UnifiedModal>
        )}
        {/* 快捷键设置 */}
        {activeTab === 'shortcuts' && (
          <ShortcutSettings className="min-h-[500px]" />
        )}

        {/* 关于页面 */}
        {/* 关于页面 */}
        {activeTab === 'about' && <AboutTab />}
            </div>
          </div>
        </CustomScrollArea>
    </div>
  );

  // ===== 移动端布局：三屏滑动布局（侧栏 ← 主视图 → 编辑面板） =====
  // 渲染右侧编辑面板内容
  const renderRightPanel = () => {
    // 根据面板类型渲染不同内容
    switch (rightPanelType) {
      case 'modelEditor':
        if (!modelEditor) {
          return (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <p className="text-sm">{t('settings:vendor_panel.select_model_to_edit')}</p>
            </div>
          );
        }
        return (
          <div
            className="h-full flex flex-col bg-background"
            style={{
              paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
            }}
          >
            <ShadApiEditModal
              api={modelEditor.api}
              onSave={handleSaveModelProfileAndClose}
              onCancel={handleCloseModelEditor}
              hideConnectionFields
              lockedVendorInfo={{
                name: modelEditor.vendor.name,
                baseUrl: modelEditor.vendor.baseUrl,
                providerType: modelEditor.vendor.providerType,
              }}
              embeddedMode={true}
            />
          </div>
        );

      case 'mcpTool':
        return renderMcpToolEditorEmbedded();

      case 'mcpPolicy':
        return renderMcpPolicyEditorEmbedded();

      case 'vendorConfig':
        return renderVendorConfigEmbedded();

      default:
        return (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <p className="text-sm">{t('settings:vendor_panel.select_model_to_edit')}</p>
          </div>
        );
    }
  };

  if (isMobileSheetPresentation) {
    return (
      <div
        data-slot="mobile-settings-sheet-real-content"
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground [--background:0_0%_100%] [--border:220_13%_90%] [--card:0_0%_100%] [--foreground:0_0%_7%] [--muted:220_14%_96%] [--muted-foreground:220_6%_44%] [--popover:0_0%_100%]"
      >
        <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />
        {renderSettingsSheetTabRail()}
        {renderSettingsMainContent({ sheetMode: true })}

        {modelEditor && (
          <ShadApiEditModal
            api={modelEditor.api}
            onSave={handleSaveModelProfile}
            onCancel={() => setModelEditor(null)}
            hideConnectionFields
            lockedVendorInfo={{
              name: modelEditor.vendor.name,
              baseUrl: modelEditor.vendor.baseUrl,
              providerType: modelEditor.vendor.providerType,
            }}
          />
        )}
        <VendorConfigModal
          open={vendorModalOpen}
          vendor={editingVendor}
          onClose={() => {
            setVendorModalOpen(false);
            setEditingVendor(null);
          }}
          onSave={handleSaveVendorModal}
        />
        <NotionAlertDialog
          open={Boolean(modelDeleteDialog)}
          onOpenChange={open => { if (!open) setModelDeleteDialog(null); }}
          title={t('settings:vendor_panel.delete_model_title')}
          description={t('settings:vendor_panel.delete_model_desc')}
          confirmText={t('common:actions.delete')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="danger"
          onConfirm={confirmDeleteModelProfile}
        >
          {modelDeleteDialog?.referencingKeys.length ? (
            <p className="text-sm text-muted-foreground">
              {t('settings:common_labels.confirm_delete_api_with_assignments', {
                count: modelDeleteDialog.referencingKeys.length,
              })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings:common_labels.confirm_delete_api')}</p>
          )}
        </NotionAlertDialog>
        <NotionAlertDialog
          open={Boolean(vendorDeleteDialog)}
          onOpenChange={open => { if (!open) setVendorDeleteDialog(null); }}
          title={t('settings:vendor_panel.delete_vendor_title')}
          description={t('settings:vendor_panel.delete_vendor_desc')}
          confirmText={t('common:actions.delete')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="danger"
          onConfirm={confirmDeleteVendor}
        >
          {vendorDeleteDialog && (
            <p className="text-sm text-muted-foreground">{t('settings:vendor_panel.confirm_delete', { name: vendorDeleteDialog.name })}</p>
          )}
        </NotionAlertDialog>

        <NotionDialog open={showAppMenuDemo} onOpenChange={setShowAppMenuDemo} maxWidth="max-w-4xl">
          <NotionDialogHeader>
            <NotionDialogTitle className="flex items-center gap-2">
              <Stack size={20} />
              {t('acknowledgements.ui_components.app_menu')}
            </NotionDialogTitle>
            <NotionDialogDescription>
              {t('acknowledgements.ui_components.app_menu_desc')}
            </NotionDialogDescription>
          </NotionDialogHeader>
          <NotionDialogBody>
            <AppMenuDemo />
          </NotionDialogBody>
        </NotionDialog>
      </div>
    );
  }

  if (isSmallScreen) {
    return (
      <div className="study-shell-page settings absolute inset-0 flex flex-col overflow-hidden">
        <MacTopSafeDragZone className="settings-top-safe-drag-zone" style={SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE} />
        <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />

        <MobileSlidingLayout
          sidebar={
            <div
              className="h-full flex flex-col bg-background"
              style={{
                paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
              }}
            >
              {renderSettingsSidebar()}
            </div>
          }
          rightPanel={renderRightPanel()}
          screenPosition={screenPosition}
          onScreenPositionChange={setScreenPosition}
          sidebarWidth="half"
          rightPanelEnabled={rightPanelType !== 'none'}
          enableGesture={true}
          threshold={0.3}
          className="flex-1"
        >
          {renderSettingsMainContent()}
        </MobileSlidingLayout>
        {/* VendorConfigModal 在移动端已通过右侧滑动面板渲染，这里不再重复渲染 */}
        <NotionAlertDialog
          open={Boolean(modelDeleteDialog)}
          onOpenChange={open => { if (!open) setModelDeleteDialog(null); }}
          title={t('settings:vendor_panel.delete_model_title')}
          description={t('settings:vendor_panel.delete_model_desc')}
          confirmText={t('common:actions.delete')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="danger"
          onConfirm={confirmDeleteModelProfile}
        >
          {modelDeleteDialog?.referencingKeys.length ? (
            <p className="text-sm text-muted-foreground">
              {t('settings:common_labels.confirm_delete_api_with_assignments', {
                count: modelDeleteDialog.referencingKeys.length,
              })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings:common_labels.confirm_delete_api')}</p>
          )}
        </NotionAlertDialog>
        <NotionAlertDialog
          open={Boolean(vendorDeleteDialog)}
          onOpenChange={open => { if (!open) setVendorDeleteDialog(null); }}
          title={t('settings:vendor_panel.delete_vendor_title')}
          description={t('settings:vendor_panel.delete_vendor_desc')}
          confirmText={t('common:actions.delete')}
          cancelText={t('common:actions.cancel')}
          confirmVariant="danger"
          onConfirm={confirmDeleteVendor}
        >
          {vendorDeleteDialog && (
            <p className="text-sm text-muted-foreground">{t('settings:vendor_panel.confirm_delete', { name: vendorDeleteDialog.name })}</p>
          )}
        </NotionAlertDialog>

        {/* 现代化菜单演示对话框 */}
        <NotionDialog open={showAppMenuDemo} onOpenChange={setShowAppMenuDemo} maxWidth="max-w-4xl">
          <NotionDialogHeader>
            <NotionDialogTitle className="flex items-center gap-2">
              <Stack size={20} />
              {t('acknowledgements.ui_components.app_menu')}
            </NotionDialogTitle>
            <NotionDialogDescription>
              {t('acknowledgements.ui_components.app_menu_desc')}
            </NotionDialogDescription>
          </NotionDialogHeader>
          <NotionDialogBody>
            <AppMenuDemo />
          </NotionDialogBody>
        </NotionDialog>
      </div>
    );
  }

  // ===== 桌面端布局 =====
  return (
    <div className="settings absolute inset-0 flex flex-col overflow-hidden bg-[color:var(--shell-workspace-panel)]">
      <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />

      {/* 主内容区域 */}
      {renderSettingsMainContent()}

      {modelEditor && (
        <ShadApiEditModal
          api={modelEditor.api}
          onSave={handleSaveModelProfile}
          onCancel={() => setModelEditor(null)}
          hideConnectionFields
          lockedVendorInfo={{
            name: modelEditor.vendor.name,
            baseUrl: modelEditor.vendor.baseUrl,
            providerType: modelEditor.vendor.providerType,
          }}
        />
      )}
      <VendorConfigModal
        open={vendorModalOpen}
        vendor={editingVendor}
        onClose={() => {
          setVendorModalOpen(false);
          setEditingVendor(null);
        }}
        onSave={handleSaveVendorModal}
      />
      <NotionAlertDialog
        open={Boolean(modelDeleteDialog)}
        onOpenChange={open => { if (!open) setModelDeleteDialog(null); }}
        title={t('settings:vendor_panel.delete_model_title')}
        description={t('settings:vendor_panel.delete_model_desc')}
        confirmText={t('common:actions.delete')}
        cancelText={t('common:actions.cancel')}
        confirmVariant="danger"
        onConfirm={confirmDeleteModelProfile}
      >
        {modelDeleteDialog?.referencingKeys.length ? (
          <p className="text-sm text-muted-foreground">
            {t('settings:common_labels.confirm_delete_api_with_assignments', {
              count: modelDeleteDialog.referencingKeys.length,
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('settings:common_labels.confirm_delete_api')}</p>
        )}
      </NotionAlertDialog>
      <NotionAlertDialog
        open={Boolean(vendorDeleteDialog)}
        onOpenChange={open => { if (!open) setVendorDeleteDialog(null); }}
        title={t('settings:vendor_panel.delete_vendor_title')}
        description={t('settings:vendor_panel.delete_vendor_desc')}
        confirmText={t('common:actions.delete')}
        cancelText={t('common:actions.cancel')}
        confirmVariant="danger"
        onConfirm={confirmDeleteVendor}
      >
        {vendorDeleteDialog && (
          <p className="text-sm text-muted-foreground">{t('settings:vendor_panel.confirm_delete', { name: vendorDeleteDialog.name })}</p>
        )}
      </NotionAlertDialog>

      {/* 现代化菜单演示对话框 */}
      <NotionDialog open={showAppMenuDemo} onOpenChange={setShowAppMenuDemo} maxWidth="max-w-4xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <Stack size={20} />
            {t('acknowledgements.ui_components.app_menu')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('acknowledgements.ui_components.app_menu_desc')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody>
          <AppMenuDemo />
        </NotionDialogBody>
      </NotionDialog>
    </div>
  );
};
