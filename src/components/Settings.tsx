import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import './Settings.css';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { AppSelect } from './ui/app-menu';
import { CustomScrollArea } from './custom-scroll-area';
import UnifiedModal from './UnifiedModal';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter, NotionAlertDialog } from './ui/NotionDialog';
import { ShadApiEditModal, GENERAL_DEFAULT_MIN_P, GENERAL_DEFAULT_TOP_K } from './settings/ShadApiEditModal';
import { VendorConfigModal, type VendorConfigModalRef } from './settings/VendorConfigModal';
import { Input } from './ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { TauriAPI } from '../utils/tauriApi';
import { ModelAssignments, VendorConfig, ModelProfile, ApiConfig } from '../types';
import { Alert, AlertDescription, AlertTitle } from './ui/shad/Alert';
import { Popover, PopoverContent, PopoverTrigger } from './ui/shad/Popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/shad/Tabs';
import { Checkbox } from './ui/shad/Checkbox';
import { cn } from '../lib/utils';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';

import { isTauriStdioSupported } from '../mcp/tauriStdioTransport';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from './layout';
import { MOBILE_LAYOUT } from '../config/mobileLayout';
import { UnifiedSidebar, UnifiedSidebarHeader, UnifiedSidebarContent, UnifiedSidebarItem } from './ui/unified-sidebar/UnifiedSidebar';
import useTheme, { type ThemeMode, type ThemePalette } from '../hooks/useTheme';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useVendorModels } from '../hooks/useVendorModels';
import { consumePendingSettingsTab } from '@/utils/pendingSettingsTab';
import { isAndroid } from '../utils/platform';
import { ShortcutSettings } from '../command-palette';
import '../command-palette/styles/shortcut-settings.css';
import { AppMenuDemo } from './ui/app-menu';
import { McpToolsSection } from './settings/McpToolsSection';
import { ModelsTab } from './settings/ModelsTab';
import { AboutTab } from './settings/AboutTab';
import { AppTab } from './settings/AppTab';
import { ApisTab } from './settings/ApisTab';
import { ParamsTab } from './settings/ParamsTab';
import { ExternalSearchTab } from './settings/ExternalSearchTab';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { type UnifiedModelInfo } from './shared/UnifiedModelSelector';
import { useUIStore } from '@/stores/uiStore';
import {
  UI_FONT_STORAGE_KEY,
  DEFAULT_UI_FONT,
  applyFontToDocument,
  UI_FONT_SIZE_STORAGE_KEY,
  DEFAULT_UI_FONT_SIZE,
  applyFontSizeToDocument,
  clampFontSize,
} from '../config/fontConfig';
import { normalizeMcpToolList } from './settings/mcpUtils';
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
} from './settings/constants';
import {
  convertProfileToApiConfig,
  convertApiConfigToProfile,
  normalizeBaseUrl,
  providerTypeFromConfig,
} from './settings/modelConverters';
import type { SystemConfig, SettingsProps } from './settings/types';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

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
  Bot,
  FlaskConical,
  Plus,
  Trash2,
  X,
  Check,
  RefreshCcw,
  BookOpen,
  Palette,
  Globe,
  Plug,
  Wrench,
  Info as InfoIcon,
  BarChart3,
  Shield,
  Keyboard,
  Layers,
  ChevronRight,
} from 'lucide-react';
import { type McpStatusInfo } from '../mcp/mcpService';
import { testMcpSseFrontend, testMcpHttpFrontend, testMcpWebsocketFrontend } from '../mcp/mcpFrontendTester';
import { getBuiltinServer, BUILTIN_SERVER_ID } from '../mcp/builtinMcpServer';
import UnifiedErrorHandler, { useUnifiedErrorHandler } from './UnifiedErrorHandler';
import { DataImportExport } from './DataImportExport';
import { DataGovernanceDashboard } from './settings/DataGovernanceDashboard';
// Tauri 2.x API导入
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
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



export const Settings: React.FC<SettingsProps> = ({ onBack }) => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { isSmallScreen } = useBreakpoint();
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
  const [activeTab, setActiveTab] = useState('apis');
  
  // 标签页名称映射（用于面包屑显示）
  const getActiveTabLabel = useCallback(() => {
    const tabLabels: Record<string, string> = {
      'app': t('settings:tabs.app'),
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
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
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
          <Check className="w-5 h-5" />
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
    question_parsing_model_config_id: '', // 两阶段题目集识别：专用题目解析模型

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
  const apiConfigsForApisTab = resolvedApiConfigs;
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<VendorConfig | null>(null);
  const [isEditingVendor, setIsEditingVendor] = useState(false);
  const [vendorFormData, setVendorFormData] = useState<Partial<VendorConfig>>({});
  const [modelEditor, setModelEditor] = useState<{ vendor: VendorConfig; profile?: ModelProfile; api: ApiConfig } | null>(null);
  // 内联编辑状态（用于卡片展开编辑）
  const [inlineEditState, setInlineEditState] = useState<{ profileId: string; api: ApiConfig } | null>(null);
  // 标记当前是否正在内联新增模型
  const [isAddingNewModel, setIsAddingNewModel] = useState(false);
  const [modelDeleteDialog, setModelDeleteDialog] = useState<{
    profile: ModelProfile;
    referencingKeys: Array<keyof ModelAssignments>;
  } | null>(null);
  const [vendorDeleteDialog, setVendorDeleteDialog] = useState<VendorConfig | null>(null);
  const [testingApi, setTestingApi] = useState<string | null>(null);
  const vendorBusy = vendorLoading || vendorSaving;
  const sortedVendors = useMemo(() => {
    const sorted = [...vendors];
    sorted.sort((a, b) => {
      // SiliconFlow 始终置顶
      const aSilicon = (a.providerType ?? '').toLowerCase() === 'siliconflow';
      const bSilicon = (b.providerType ?? '').toLowerCase() === 'siliconflow';
      if (aSilicon !== bSilicon) {
        return aSilicon ? -1 : 1;
      }
      // 按 sortOrder 排序，没有 sortOrder 的放到最后
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      // sortOrder 相同则按名称排序
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [vendors]);
  const selectedVendor = useMemo(() => {
    if (sortedVendors.length === 0) {
      return null;
    }
    if (!selectedVendorId) {
      return sortedVendors[0];
    }
    return sortedVendors.find(v => v.id === selectedVendorId) ?? sortedVendors[0];
  }, [sortedVendors, selectedVendorId]);
  const selectedVendorProfiles = useMemo(
    () => (selectedVendor ? modelProfiles.filter(mp => mp.vendorId === selectedVendor.id) : []),
    [modelProfiles, selectedVendor]
  );
  const selectedVendorModels = useMemo(
    () =>
      selectedVendor
        ? selectedVendorProfiles
            .map(profile => {
              const api = convertProfileToApiConfig(profile, selectedVendor);
              return api ? { profile, api } : null;
            })
            .filter((row): row is { profile: ModelProfile; api: ApiConfig } => Boolean(row))
            // 收藏的模型置顶
            .sort((a, b) => {
              if (a.profile.isFavorite && !b.profile.isFavorite) return -1;
              if (!a.profile.isFavorite && b.profile.isFavorite) return 1;
              return 0;
            })
        : [],
    [selectedVendorProfiles, selectedVendor]
  );
  const profileCountByVendor = useMemo(() => {
    const map = new Map<string, number>();
    modelProfiles.forEach(profile => {
      map.set(profile.vendorId, (map.get(profile.vendorId) ?? 0) + 1);
    });
    return map;
  }, [modelProfiles]);
  const selectedVendorIsSiliconflow = ((selectedVendor?.providerType ?? '').toLowerCase() === 'siliconflow');
  useEffect(() => {
    if (sortedVendors.length === 0) {
      setSelectedVendorId(null);
      return;
    }
    if (!selectedVendorId || !sortedVendors.some(v => v.id === selectedVendorId)) {
      setSelectedVendorId(sortedVendors[0].id);
    }
  }, [sortedVendors, selectedVendorId]);

  // 切换供应商时退出编辑模式
  useEffect(() => {
    setIsEditingVendor(false);
    setVendorFormData({});
  }, [selectedVendorId]);

  // 当供应商/模型配置变更时，从后端刷新 ApiConfig 列表（作为“单一事实来源”）
  const refreshApiConfigsFromBackend = useCallback(async () => {
    try {
      if (!invoke) return;
      const apiConfigs = (await invoke('get_api_configurations').catch(() => [])) as any[];
      const mappedApiConfigs = (apiConfigs || []).map((config: any) => ({
        ...config,
        maxOutputTokens: config.maxOutputTokens,
        temperature: config.temperature,
      }));
      setConfig((prev) => ({ ...prev, apiConfigs: mappedApiConfigs }));
    } catch (e) {
      // 静默失败：不阻塞设置页、避免控制台警告噪音
    }
  }, [invoke, setConfig]);

  useEffect(() => {
    const onChanged = () => {
      void refreshApiConfigsFromBackend();
    };
    try {
      window.addEventListener('api_configurations_changed', onChanged as any);
    } catch {}
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', onChanged as any);
      } catch {}
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
      // 两阶段题目集识别
      question_parsing_model_config_id: modelAssignments.question_parsing_model_config_id || '',
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

  const applyZoomToWebview = useCallback(async (scale: number) => {
    if (!isTauriEnvironment) return;
    const webview = await getCurrentWebview();
    await webview.setZoom(scale);
  }, [isTauriEnvironment]);

  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setZoomLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_ZOOM_STORAGE_KEY }) as string;
        const parsed = clampZoom(parseFloat(storedValue));
        if (!disposed) {
          setUiZoom(parsed);
        }
        if (!disposed) {
          await applyZoomToWebview(parsed);
        }
      } catch {
        // 缩放设置读取失败，回退到默认值（首次使用或存储损坏）
        if (!disposed) {
          setUiZoom(DEFAULT_UI_ZOOM);
        }
      } finally {
        if (!disposed) {
          setZoomLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [applyZoomToWebview, isTauriEnvironment, tauriInvoke]);

  const handleZoomChange = useCallback(async (value: number) => {
    const normalized = clampZoom(value);
    setUiZoom(normalized);
    if (!isTauriEnvironment) {
      return;
    }
    setZoomSaving(true);
    setZoomStatus({ type: 'idle' });
    try {
      await applyZoomToWebview(normalized);
      await tauriInvoke('save_setting', { key: UI_ZOOM_STORAGE_KEY, value: normalized.toString() });
      setZoomStatus({
        type: 'success',
        message: t('settings:zoom.status_applied', { value: formatZoomLabel(normalized) }),
      });
    } catch (error) {
      setZoomStatus({
        type: 'error',
        message: t('settings:zoom.apply_error', { reason: getErrorMessage(error) }),
      });
    } finally {
      setZoomSaving(false);
    }
  }, [applyZoomToWebview, isTauriEnvironment, t, tauriInvoke]);

  const handleZoomReset = useCallback(() => {
    void handleZoomChange(DEFAULT_UI_ZOOM);
  }, [handleZoomChange]);

  // 字体设置：初始化加载（applyFontToDocument 从 fontConfig 导入）
  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setFontLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_FONT_STORAGE_KEY }) as string;
        const fontValue = storedValue || DEFAULT_UI_FONT;
        if (!disposed) {
          setUiFont(fontValue);
          applyFontToDocument(fontValue);
        }
      } catch {
        if (!disposed) {
          setUiFont(DEFAULT_UI_FONT);
          applyFontToDocument(DEFAULT_UI_FONT);
        }
      } finally {
        if (!disposed) {
          setFontLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isTauriEnvironment, tauriInvoke]);

  // 字体设置：处理变更
  const handleFontChange = useCallback(async (value: string) => {
    setUiFont(value);
    applyFontToDocument(value);
    if (!isTauriEnvironment) {
      return;
    }
    setFontSaving(true);
    try {
      await tauriInvoke('save_setting', { key: UI_FONT_STORAGE_KEY, value });
    } catch (error) {
      console.error('Failed to save font setting:', error);
    } finally {
      setFontSaving(false);
    }
  }, [isTauriEnvironment, tauriInvoke]);

  // 字体设置：重置为默认
  const handleFontReset = useCallback(() => {
    void handleFontChange(DEFAULT_UI_FONT);
  }, [handleFontChange]);

  // 字体大小设置：初始化加载
  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setFontSizeLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_FONT_SIZE_STORAGE_KEY }) as string;
        const parsed = clampFontSize(parseFloat(storedValue));
        if (!disposed) {
          setUiFontSize(parsed);
          applyFontSizeToDocument(parsed);
        }
      } catch {
        if (!disposed) {
          setUiFontSize(DEFAULT_UI_FONT_SIZE);
          applyFontSizeToDocument(DEFAULT_UI_FONT_SIZE);
        }
      } finally {
        if (!disposed) {
          setFontSizeLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isTauriEnvironment, tauriInvoke]);

  // 字体大小设置：处理变更
  const handleFontSizeChange = useCallback(async (value: number) => {
    const normalized = clampFontSize(value);
    setUiFontSize(normalized);
    applyFontSizeToDocument(normalized);
    if (!isTauriEnvironment) {
      return;
    }
    setFontSizeSaving(true);
    try {
      await tauriInvoke('save_setting', { key: UI_FONT_SIZE_STORAGE_KEY, value: normalized.toString() });
    } catch {
      // 静默失败：避免控制台噪音
    } finally {
      setFontSizeSaving(false);
    }
  }, [isTauriEnvironment, tauriInvoke]);

  // 字体大小设置：重置为默认
  const handleFontSizeReset = useCallback(() => {
    void handleFontSizeChange(DEFAULT_UI_FONT_SIZE);
  }, [handleFontSizeChange]);

  // 🆕 将内置服务器添加到 MCP 服务器列表开头
  const normalizedMcpServers = useMemo(() => {
    const userServers = normalizeMcpToolList((config as any).mcpTools);
    const builtinServer = getBuiltinServer();
    // 转换为设置页面期望的格式
    const builtinForSettings = {
      id: builtinServer.id,
      name: builtinServer.name,
      transportType: 'builtin' as const,
      connected: true,
    };
    return [builtinForSettings, ...userServers];
  }, [config.mcpTools]);

  useEffect(() => {
    if (!Array.isArray(config.mcpTools)) {
      const normalized = normalizeMcpToolList((config as any).mcpTools);
      setConfig(prev => ({ ...prev, mcpTools: normalized }));
    }
  }, [config.mcpTools]);

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [extra, setExtra] = useState<any>({});
  const globalLeftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [sidebarSearchFocused, setSidebarSearchFocused] = useState(false);
  const [showAppMenuDemo, setShowAppMenuDemo] = useState(false);
  const isMcpLoading = activeTab === 'mcp' && loading;

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

  // MCP 工具编辑模态
  const [mcpToolModal, setMcpToolModal] = useState<{
    open: boolean;
    index: number | null; // null 表示新增
    mode: 'form' | 'json'; // 编辑模式
    jsonInput: string; // JSON输入内容
    draft: { 
      id: string; 
      name: string; 
      transportType: 'stdio'|'websocket'|'sse'|'streamable_http'; 
      // SSE/Streamable HTTP 配置
      fetch?: {
        type: 'sse'|'streamable_http';
        url: string;
      };
      // WebSocket 配置
      url?: string; 
      // Stdio 配置
      command?: string; 
      args?: string[] | string; 
      // 环境变量
      env?: Record<string, string>; 
      // HTTP 请求头
      headers?: Record<string, string>;
      // 旧版兼容字段
      endpoint?: string; 
      apiKey?: string; 
      serverId?: string; 
      region?: string; 
      hosted?: boolean; 
      cwd?: string; 
      framing?: 'jsonl' | 'content_length'; 
      // 新增字段支持
      mcpServers?: Record<string, any>;
      namespace?: string;
    };
    error?: string | null;
  }>({ open: false, index: null, mode: 'json', jsonInput: '', draft: { id: '', name: '', transportType: 'stdio', command: 'npx', args: [...DEFAULT_STDIO_ARGS], env: {}, cwd: '', framing: 'jsonl' }, error: null });
  // MCP 全局策略模态（白/黑名单等）
  const [mcpPolicyModal, setMcpPolicyModal] = useState<{ open: boolean; advertiseAll: boolean; whitelist: string; blacklist: string; timeoutMs: number; rateLimit: number; cacheMax: number; cacheTtlMs: number }>({
    open: false,
    advertiseAll: false,
    whitelist: '',
    blacklist: '',
    timeoutMs: 15000,
    rateLimit: 10,
    cacheMax: 100,
    cacheTtlMs: 300000
  });
  // MCP 快速体检/预览状态
  const [mcpPreview, setMcpPreview] = useState<{ open: boolean; loading: boolean; serverId?: string; serverName?: string; error?: string; tools: any[]; prompts: any[]; resources: any[] }>({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  // 缓存详情（不触发新体检）：按照服务器聚合的工具清单 + 全局提示/资源
  const [mcpCachedDetails, setMcpCachedDetails] = useState<{
    toolsByServer: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }>;
    prompts: { items: Array<{ name: string; description?: string }>; at?: number };
    resources: { items: Array<{ uri: string; name?: string; description?: string; mime_type?: string }>; at?: number };
  }>({ toolsByServer: {}, prompts: { items: [], at: undefined }, resources: { items: [], at: undefined } });
  const MCP_BACKEND_DISABLED_CODE = 'backend_mcp_disabled';
  const MCP_BACKEND_DISABLED_HINT = t('settings:mcp.backend_disabled_hint');

  const isBackendDisabled = (value: any): boolean => {
    if (value && typeof value === 'object') {
      if (value.error === MCP_BACKEND_DISABLED_CODE) return true;
    }
    const msg = getErrorMessage(value);
    return typeof msg === 'string' && msg.includes(MCP_BACKEND_DISABLED_CODE);
  };

  const normalizeFrontendResult = (r: any) => ({ success: !!r?.success, tools_count: typeof r?.tools_count === 'number' ? r.tools_count : (Array.isArray(r?.tools) ? r.tools.length : undefined), tools: r?.tools });

  const describeToolCount = (res: any): string => {
    const count = typeof res?.tools_count === 'number'
      ? res.tools_count
      : Array.isArray(res?.tools) ? res.tools.length : undefined;
    return typeof count === 'number' ? `, ${t('settings:mcp_descriptions.tools_count', { count })}` : '';
  };

  const handleMcpTestResult = (res: any, failureLabel: string): boolean => {
    if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
      if (res.success) {
        return true;
      }
      if (res.error === MCP_BACKEND_DISABLED_CODE) {
        showGlobalNotification('warning', MCP_BACKEND_DISABLED_HINT);
        return false;
      }
      const errorMessage = res.error !== undefined ? getErrorMessage(res.error) || t('common:error.unknown_error') : t('common:error.unknown_error');
      showGlobalNotification('error', `${failureLabel}: ${errorMessage}`);
      return false;
    }
    return true;
  };

  const handleMcpTestError = (error: any, failureLabel: string) => {
    const message = getErrorMessage(error) || t('common:error.unknown_error');
    if (message.includes(MCP_BACKEND_DISABLED_CODE)) {
      showGlobalNotification('warning', MCP_BACKEND_DISABLED_HINT);
      return;
    }
    showGlobalNotification('error', `${failureLabel}: ${message}`);
  };
  const renderInfoPopover = React.useCallback(
    (label: string, description: string) => (
      <div className="flex items-center gap-2">
        <span>{label}</span>
        <Popover>
          <PopoverTrigger asChild>
            <NotionButton type="button" variant="ghost" iconOnly size="sm" className="h-6 w-6 text-muted-foreground">
              <InfoIcon className="h-4 w-4" />
            </NotionButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-sm text-xs leading-relaxed">
            {description}
          </PopoverContent>
        </Popover>
      </div>
    ),
    []
  );
  const [mcpStatusInfo, setMcpStatusInfo] = useState<McpStatusInfo | null>(null);
  const rebuildCachedDetailsFromSnapshots = useCallback((
    toolSnap: Record<string, { at: number; tools: Array<{ name: string; description?: string; input_schema?: any }> }> = {},
    promptSnap: Record<string, { at: number; prompts: Array<{ name: string; description?: string; arguments?: any }> }> = {},
    resourceSnap: Record<string, { at: number; resources: Array<{ uri: string; name?: string; description?: string; mime_type?: string }> }> = {}
  ) => {
    const toolMap: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }> = {};
    Object.entries(toolSnap).forEach(([sid, snap]) => {
      toolMap[sid] = {
        at: snap.at,
        items: (snap.tools || []).map(t => ({ name: t.name, description: t.description })),
      };
    });

    const promptItems = Object.values(promptSnap)
      .flatMap(snap => snap.prompts || [])
      .map(p => ({ name: p.name, description: p.description }));
    const promptAt = Object.values(promptSnap).reduce<number | undefined>((acc, snap) => {
      if (!snap.at) return acc;
      if (!acc || snap.at > acc) return snap.at;
      return acc;
    }, undefined);

    const resourceItems = Object.values(resourceSnap)
      .flatMap(snap => snap.resources || [])
      .map(r => ({ uri: r.uri, name: r.name, description: r.description, mime_type: r.mime_type }));
    const resourceAt = Object.values(resourceSnap).reduce<number | undefined>((acc, snap) => {
      if (!snap.at) return acc;
      if (!acc || snap.at > acc) return snap.at;
      return acc;
    }, undefined);

    setMcpCachedDetails({
      toolsByServer: toolMap,
      prompts: { items: promptItems, at: promptAt },
      resources: { items: resourceItems, at: resourceAt },
    });
  }, []);

  const refreshSnapshots = useCallback(async (options?: { reload?: boolean }) => {
    const { McpService } = await import('../mcp/mcpService');
    if (options?.reload) {
      await Promise.allSettled([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
    }
    const toolSnap = McpService.getCachedToolsSnapshot();
    const promptSnap = McpService.getCachedPromptsSnapshot();
    const resourceSnap = McpService.getCachedResourcesSnapshot();
    rebuildCachedDetailsFromSnapshots(toolSnap, promptSnap, resourceSnap);
  }, [rebuildCachedDetailsFromSnapshots]);
  // 添加状态来存储指示器的transform和宽度
  const [indicatorStyle, setIndicatorStyle] = useState({ transform: 'translateX(0)', width: 0 });
  // 添加对标签按钮的引用
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  // 标签按钮容器引用（用于处理横向滚动对指示器的位置影响）
  const tabButtonsContainerRef = useRef<HTMLDivElement | null>(null);

  const stripMcpPrefix = useCallback((raw?: string | null) => {
    if (typeof raw !== 'string') return raw ?? '';
    const idx = raw.indexOf(':');
    return idx > 0 ? raw.slice(idx + 1) : raw;
  }, []);

  // ★ 2026-01-15: 导师模式已迁移到 Skills 系统，相关状态和处理函数已删除
  // ★ 2026-01-19: Irec 模块已废弃，相关预设加载/保存逻辑已删除

  const emitChatStreamSettingsUpdate = useCallback((payload: { timeoutMs?: number | null; autoCancel?: boolean }) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CHAT_STREAM_SETTINGS_EVENT, { detail: payload }));
    }
  }, []);

  const handleSaveChatStreamTimeout = useCallback(async () => {
    const raw = String((extra as any)?.chatStreamTimeoutSeconds ?? '').trim();
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
      setExtra((prev: any) => ({
        ...prev,
        chatStreamTimeoutSeconds: savedValue,
        _lastSavedTimeoutSeconds: savedValue,
      }));
      emitChatStreamSettingsUpdate({ timeoutMs });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('[Settings] 保存聊天流式超时失败:', error);
      showGlobalNotification('error', t('common:settings.chat_stream.save_error_timeout', { error: errorMessage }));
      // 🔧 R2-5: 保存失败时恢复输入框为上一次成功值
      setExtra((prev: any) => ({
        ...prev,
        chatStreamTimeoutSeconds: prev._lastSavedTimeoutSeconds ?? '',
      }));
    }
  }, [emitChatStreamSettingsUpdate, extra, invoke, showGlobalNotification, t]);

  const handleToggleChatStreamAutoCancel = useCallback(async (checked: boolean) => {
    setExtra((prev: any) => ({ ...prev, chatStreamAutoCancel: checked }));
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
      setExtra((prev: any) => ({ ...prev, chatStreamAutoCancel: !checked }));
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
        setExtra((prev: any) => ({
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
  const handleBack = async () => {
    if (!loading) {
      await handleSave(true); // 静默保存
    }
    onBack();
  };

  // 启动时消费 pending settings tab（防止导航事件竞态丢失）
  useEffect(() => {
    const pending = consumePendingSettingsTab();
    if (pending) {
      setActiveTab(pending);
    }
  }, []);

  // P1-09: 监听命令面板的 tab 跳转事件
  useEffect(() => {
    const handleNavigateTab = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: string }>;
      const tab = customEvent.detail?.tab;
      if (tab) {
        // 映射命令面板 tab 名称到设置页面内部 tab 名称
        const tabMapping: Record<string, string> = {
          'api': 'apis',
          'apis': 'apis',
          'search': 'search',
          'models': 'models',
          'mcp': 'mcp',
          'statistics': 'statistics',
          'data': 'data-governance',
          'data-governance': 'data-governance',
          'params': 'params',
          'shortcuts': 'shortcuts',
          'about': 'about',
        };
        const mappedTab = tabMapping[tab] || tab;
        setActiveTab(mappedTab);
      }
    };
    window.addEventListener('SETTINGS_NAVIGATE_TAB', handleNavigateTab);
    return () => {
      window.removeEventListener('SETTINGS_NAVIGATE_TAB', handleNavigateTab);
    };
  }, []);

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
        const { McpService } = await import('../mcp/mcpService');
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

  const resolveServerId = (tool: any, idx: number): string => {
    const transport = (tool?.transportType || tool?.draft?.transportType || 'sse') as string;
    const directId = tool?.id || tool?.name;
    if (directId) return String(directId);
    const fromServers = tool?.mcpServers ? Object.values(tool.mcpServers).find((srv: any) => (srv as any)?.url) as any : undefined;
    if (transport === 'websocket') {
      if (tool?.url) return String(tool.url);
    } else if (transport === 'streamable_http') {
      const httpUrl = tool?.fetch?.url || tool?.endpoint || tool?.url || (fromServers ? (fromServers as any).url : undefined);
      if (httpUrl) return String(httpUrl);
    } else if (transport === 'sse') {
      const sseUrl = tool?.fetch?.url || tool?.endpoint || (fromServers ? (fromServers as any).url : undefined) || tool?.url;
      if (sseUrl) return String(sseUrl);
    }
    if (tool?.command) {
      const args = Array.isArray(tool.args) ? tool.args.join(',') : (tool.args || '');
      return `${tool.command}:${args}`;
    }
    return `mcp_${idx}`;
  };

  const findSnapshotKey = (tool: any, idx: number): string | undefined => {
    const candidates = [
      tool?.id,
      tool?.name,
      tool?.serverId,
      tool?.fetch?.url,
      tool?.endpoint,
      tool?.url,
      tool?.namespace,
      tool?.mcpServers ? Object.keys(tool.mcpServers)[0] : undefined,
      resolveServerId(tool, idx),
    ]
      .map(candidate => (candidate != null && candidate !== '' ? String(candidate) : undefined));
    for (const candidate of candidates) {
      if (candidate && mcpCachedDetails.toolsByServer[candidate]) {
        return candidate;
      }
    }
    return undefined;
  };
  const buildToolJson = (tool: any) => {
    if (tool?.mcpServers) {
      return JSON.stringify({ mcpServers: tool.mcpServers }, null, 2);
    }
    const serverKey = tool?.name || tool?.id || 'mcp_server';
    const config: any = {};
    if (tool?.fetch) {
      config.mcpServers = {
        [serverKey]: {
          type: tool.fetch.type,
          url: tool.fetch.url,
        },
      };
    } else if (tool?.transportType === 'websocket') {
      config.mcpServers = {
        [serverKey]: {
          type: 'websocket',
          url: tool.url,
        },
      };
    } else if (tool?.transportType === 'sse' || tool?.transportType === 'streamable_http') {
      config.mcpServers = {
        [serverKey]: {
          type: tool.transportType,
          url: tool.endpoint || tool.url || '',
        },
      };
    } else if (tool?.transportType === 'stdio') {
      config.mcpServers = {
        [serverKey]: {
          command: tool.command,
      args: Array.isArray(tool.args) ? tool.args : (typeof tool.args === 'string' && tool.args.includes(',') ? tool.args.split(',').map((item: string) => item.trim()).filter((item: string) => item.length > 0) : (typeof tool.args === 'string' && tool.args.length > 0 ? [tool.args.trim()] : [])),
        },
      };
    }
    if (tool?.apiKey && typeof tool.apiKey === 'string') {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].apiKey = tool.apiKey;
    }
    if (tool?.namespace && typeof tool.namespace === 'string') {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].namespace = tool.namespace;
    }
    if (tool?.env && Object.keys(tool.env).length > 0) {
      if (!config.mcpServers) {
        config.mcpServers = { [serverKey]: {} };
      }
      config.mcpServers[serverKey].env = tool.env;
    }
    if (tool?.cwd) {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].cwd = tool.cwd;
    }
    if (tool?.framing) {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].framing = tool.framing;
    }
    return JSON.stringify(config, null, 2);
  };
  const handleAddMcpTool = async (newServer: Partial<any>): Promise<boolean> => {
    try {
      // 构建要保存的服务器数据
      const toolToSave: any = {
        id: newServer.id || `mcp_${Date.now()}`,
        name: newServer.name || t('common:new_mcp_server'),
        transportType: newServer.transportType || 'sse',
        ...newServer,
      };

      // 处理传输类型特定的字段
      if (toolToSave.transportType === 'sse' || toolToSave.transportType === 'streamable_http') {
        toolToSave.fetch = {
          type: toolToSave.transportType,
          url: toolToSave.url || '',
        };
      }

      // 先构建新列表用于持久化，再更新 React 状态（避免竞态）
      const currentList = [...(config.mcpTools || [])];
      currentList.push(toolToSave);
      const newList = currentList;

      // 先持久化
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(newList) });
      }
      // 再更新状态
      setConfig(prev => ({ ...prev, mcpTools: newList }));
      try {
        await refreshSnapshots({ reload: true });
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('common:mcp_tool_saved'));

      // 添加后自动运行一次连通性测试以获取工具列表
      handleTestServer(toolToSave).catch(() => { /* 静默处理测试失败 */ });

      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
      return false;
    }
  };

  const handleEditMcpTool = (tool: any, idx: number) => {
    const jsonInput = buildToolJson(tool) || '{}';
    const transportType = (tool as any).transportType || 'stdio';
    const rawCommand = (tool as any).command || 'npx';
    const deriveArgs = (): string[] | undefined => {
      const rawArgs = (tool as any).args;
      if (Array.isArray(rawArgs)) {
        return rawArgs;
      }
      if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
        return rawArgs
          .split(',')
          .map((segment: string) => segment.trim())
          .filter((segment: string) => segment.length > 0);
      }
      return undefined;
    };

    let normalizedCommand = rawCommand;
    let normalizedArgs = deriveArgs() ?? [];

    if (transportType === 'stdio') {
      const shouldMigrateInlineArgs =
        (!Array.isArray((tool as any).args) || ((tool as any).args || []).length === 0) &&
        /@modelcontextprotocol\//.test(rawCommand);
      if (shouldMigrateInlineArgs) {
        const pieces = rawCommand.split(' ').filter(Boolean);
        if (pieces.length > 1) {
          normalizedCommand = pieces.shift() ?? rawCommand;
          normalizedArgs = pieces;
        }
      }
      if (!normalizedArgs || normalizedArgs.length === 0) {
        normalizedArgs = [...DEFAULT_STDIO_ARGS];
      }
    }

    setMcpToolModal({
      open: true,
      index: idx,
      mode: 'json',
      jsonInput,
      draft: {
        id: tool.id,
        name: tool.name,
        transportType,
        url: (tool as any).url || '',
        command: normalizedCommand,
        args: normalizedArgs,
        env: (tool as any).env || {},
        fetch: (tool as any).fetch,
        endpoint: (tool as any).endpoint || '',
        apiKey: (tool as any).apiKey || '',
        serverId: (tool as any).serverId || '',
        region: (tool as any).region || 'cn-hangzhou',
        hosted: (tool as any).hosted !== undefined ? (tool as any).hosted : true,
        mcpServers: (tool as any).mcpServers,
        namespace: (tool as any).namespace || '',
        cwd: (tool as any).cwd || '',
        framing: (tool as any).framing?.toLowerCase() === 'content_length' ? 'content_length' : 'jsonl',
      },
      error: null,
    });
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('mcpTool');
      setScreenPosition('right');
    }
  };

  const handleDeleteMcpTool = async (serverId: string): Promise<boolean> => {
    const next = (config.mcpTools || []).filter((tool: any) => tool.id !== serverId);
    try {
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(next) });
      }
      setConfig(prev => ({ ...prev, mcpTools: next }));
      try {
        await refreshSnapshots();
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('settings:common_labels.mcp_tool_deleted'));
      return true;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.delete_failed', { error: errorMessage }));
      return false;
    }
  };

  // 内联编辑保存 MCP 服务器
  const handleSaveMcpServer = async (updatedData: Partial<any>, serverId: string): Promise<boolean> => {
    try {
      const currentList = [...(config.mcpTools || [])];
      const idx = currentList.findIndex((tool: any) => tool.id === serverId);
      
      if (idx === -1) {
        showGlobalNotification('error', t('settings:mcp_descriptions.server_not_found'));
        return false;
      }
      
      const existing = currentList[idx];

      // 合并更新数据，但清理非标准字段（如 mcpServers 残留）
      const { mcpServers: _discardMcpServers, ...cleanUpdatedData } = updatedData as any;

      const updated = {
        ...existing,
        ...cleanUpdatedData,
        id: existing.id || updatedData.id || `mcp_${Date.now()}`,
      };

      // 处理传输类型特定的字段
      if (updatedData.transportType === 'sse' || updatedData.transportType === 'streamable_http') {
        updated.fetch = {
          type: updatedData.transportType,
          url: updatedData.url || '',
        };
      }

      // 清理存储中的 mcpServers 残留
      delete updated.mcpServers;

      currentList[idx] = updated;
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(currentList) });
      }
      setConfig(prev => ({ ...prev, mcpTools: currentList }));
      try {
        await refreshSnapshots({ reload: true });
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('common:mcp_tool_saved'));

      // 编辑保存后自动运行一次连通性测试以刷新工具列表
      handleTestServer(updated).catch(() => { /* 静默处理测试失败 */ });

      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      showGlobalNotification('error', t('settings:mcp_descriptions.save_tool_failed', { error: message }));
      return false;
    }
  };

  const handleOpenMcpPolicy = () => {
    const normalizePositiveNumber = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : fallback;
    };
    const normalizeNonNegativeNumber = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed) : fallback;
    };
    setMcpPolicyModal({
      open: true,
      advertiseAll: config.mcpAdvertiseAll,
      whitelist: config.mcpWhitelist,
      blacklist: config.mcpBlacklist,
      timeoutMs: normalizePositiveNumber(config.mcpTimeoutMs, 15000),
      rateLimit: normalizePositiveNumber(config.mcpRateLimit, 10),
      cacheMax: normalizeNonNegativeNumber(config.mcpCacheMax, 500),
      cacheTtlMs: normalizeNonNegativeNumber(config.mcpCacheTtlMs, 300000),
    });
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('mcpPolicy');
      setScreenPosition('right');
    }
  };
  const renderMcpToolEditor = () => {
    // 移动端使用右侧滑动面板，不渲染模态框
    if (isSmallScreen) return null;
    if (!mcpToolModal.open) return null;

    const isEditing = mcpToolModal.index != null;
    const draft = mcpToolModal.draft;
    const transport = draft.transportType ?? 'stdio';
    const envEntries = Object.entries(draft.env || {});
    const argsInput = Array.isArray(draft.args)
      ? draft.args.join(', ')
      : typeof draft.args === 'string'
        ? draft.args
        : draft.args != null
          ? String(draft.args)
          : '';

    const handleClose = () => {
      setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
    };

    const updateDraft = (patch: Partial<typeof draft>) => {
      setMcpToolModal(prev => ({ ...prev, draft: { ...prev.draft, ...patch } }));
    };

    const convertDraftToJson = () => {
      const name = draft.name || t('common:unnamed_mcp_tool');
      const config: Record<string, any> = { mcpServers: {} };
      const server: Record<string, any> = {};
      if (transport === 'sse' || transport === 'streamable_http') {
        server.type = transport;
        server.url = draft.endpoint || draft.fetch?.url || '';
      } else if (transport === 'websocket') {
        server.type = 'websocket';
        server.url = draft.url || '';
      } else {
        server.command = (draft.command || '').trim();
        const argsSource = draft.args;
        const normalizedArgs = Array.isArray(argsSource)
          ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
          : typeof argsSource === 'string'
            ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
            : [];
        server.args = normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS];
        server.framing = draft.framing || 'jsonl';
        if (draft.cwd) server.cwd = draft.cwd;
      }
      if (draft.apiKey) server.apiKey = draft.apiKey;
      if (draft.namespace) server.namespace = draft.namespace;
      if (draft.env && Object.keys(draft.env).length > 0) server.env = draft.env;
      config.mcpServers[name] = server;
      setMcpToolModal(prev => ({ ...prev, jsonInput: JSON.stringify(config, null, 2) }));
    };

    const handleModeChange = (value: string) => {
      if (value === 'json' && mcpToolModal.mode !== 'json') {
        convertDraftToJson();
      }
      setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
    };

    const handleEnvKeyChange = (key: string, nextKey: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      const val = next[key];
      delete next[key];
      if (nextKey) {
        next[nextKey] = val ?? '';
      }
      updateDraft({ env: next });
    };

    const handleEnvValueChange = (key: string, value: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      next[key] = value;
      updateDraft({ env: next });
    };

    const addEnvRow = () => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      let index = 1;
      let candidate = `ENV_${index}`;
      while (candidate in next) {
        index += 1;
        candidate = `ENV_${index}`;
      }
      next[candidate] = '';
      updateDraft({ env: next });
    };

    const removeEnvRow = (key: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      delete next[key];
      updateDraft({ env: next });
    };

    const buildTestHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = {};
      const merge = (source?: Record<string, any>) => {
        if (!source) return;
        Object.entries(source).forEach(([key, value]) => {
          if (value == null) return;
          headers[key] = typeof value === 'string' ? value : String(value);
        });
      };
      // 仅合并 HTTP headers，不合并 env（env 是进程环境变量，不应发送给远程服务器）
      merge(draft.headers as Record<string, string> | undefined);
      return headers;
    };

    const handleTestConnection = async () => {
      try {
        // 改为纯前端体检：不再调用后端 Tauri MCP 测试
        if (transport === 'websocket') {
          const url = (draft.url || '').trim();
          if (!url) {
            showGlobalNotification('error', t('settings:notifications.websocket_url_required'));
            return;
          }
          const fr = await testMcpWebsocketFrontend(url, draft.apiKey || '', buildTestHeaders());
          const res = normalizeFrontendResult(fr);
          if (!handleMcpTestResult(res, t('settings:test_labels.websocket_failed'))) return;
          showGlobalNotification('success', t('settings:mcp_descriptions.test_success', { name: 'WebSocket', toolInfo: describeToolCount(res) }));
        } else if (transport === 'sse' || transport === 'streamable_http') {
          const endpoint = (draft.endpoint || draft.fetch?.url || '').trim();
          if (!endpoint) {
            showGlobalNotification('error', t('settings:notifications.sse_endpoint_required'));
            return;
          }
          const headersForTest = buildTestHeaders();
          const fr = transport === 'streamable_http'
            ? await testMcpHttpFrontend(endpoint, draft.apiKey || '', headersForTest)
            : await testMcpSseFrontend(endpoint, draft.apiKey || '', headersForTest);
          const res = normalizeFrontendResult(fr);
          const failure = transport === 'streamable_http' ? t('settings:test_labels.http_failed') : t('settings:test_labels.sse_failed');
          if (!handleMcpTestResult(res, failure)) return;
          showGlobalNotification('success', t('settings:mcp_descriptions.sse_http_success', { transport: transport === 'streamable_http' ? 'HTTP' : 'SSE', toolCount: describeToolCount(res) }));
        } else {
          // stdio - 检测包管理器环境
          const command = (draft.command || '').trim();
          if (!command) {
            showGlobalNotification('error', t('settings:mcp_descriptions.command_required'));
            return;
          }
          
          try {
            const check = await TauriAPI.checkPackageManager(command);
            if (!check.detected) {
              showGlobalNotification('info', check.message || t('settings:mcp_descriptions.unrecognized_package_manager'));
              return;
            }
            
            if (!check.is_available) {
              // 包管理器不可用，显示安装提示
              const hints = check.install_hints?.join('\n') || t('settings:mcp_descriptions.install_env_manually');
              showGlobalNotification('warning', t('settings:mcp_descriptions.package_manager_not_installed', { manager: check.manager_type, hints }));
              return;
            }
            
            // 包管理器可用，显示成功信息
            showGlobalNotification(
              'success', 
              t('settings:mcp_descriptions.package_manager_ready', { manager: check.manager_type, version: check.version || t('settings:mcp_descriptions.unknown_version') })
            );
          } catch (e) {
            showGlobalNotification('error', t('settings:mcp_descriptions.check_package_manager_failed', { error: e }));
          }
        }
      } catch (error) {
        handleMcpTestError(error, t('settings:messages.connection_test_error'));
      }
    };

    const handleSubmit = async () => {
      try {
        let toolToSave: any;
        if (mcpToolModal.mode === 'json') {
          try {
            const jsonConfig = JSON.parse(mcpToolModal.jsonInput || '{}');
            if (jsonConfig?.mcpServers && typeof jsonConfig.mcpServers === 'object') {
              const [serverName, serverConfig] = Object.entries(jsonConfig.mcpServers)[0] as [string, any];
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: serverName || draft.name || t('common:unnamed_mcp_tool'),
                mcpServers: jsonConfig.mcpServers,
              };
              if (serverConfig?.type === 'sse' || serverConfig?.type === 'streamable_http') {
                toolToSave.transportType = serverConfig.type;
                toolToSave.fetch = { type: serverConfig.type, url: serverConfig.url };
              } else if (serverConfig?.url && typeof serverConfig.url === 'string' && serverConfig.url.startsWith('ws')) {
                toolToSave.transportType = 'websocket';
                toolToSave.url = serverConfig.url;
              } else if (serverConfig?.command) {
                toolToSave.transportType = 'stdio';
                toolToSave.command = serverConfig.command;
                toolToSave.args = serverConfig.args || [];
              }
              if (serverConfig?.env) toolToSave.env = serverConfig.env;
              if (serverConfig?.apiKey) toolToSave.apiKey = serverConfig.apiKey;
              if (serverConfig?.namespace) toolToSave.namespace = serverConfig.namespace;
            } else {
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: jsonConfig.name || draft.name || t('common:unnamed_mcp_tool'),
                ...jsonConfig,
              };
            }
          } catch (err) {
            setMcpToolModal(prev => ({ ...prev, error: t('settings:mcp_errors.json_format_error') + (err as Error).message }));
            return;
          }
        } else {
          if (!draft.name.trim()) {
            showGlobalNotification('error', t('settings:validations.enter_tool_name'));
            return;
          }
          if (transport === 'websocket' && !draft.url?.trim()) {
            showGlobalNotification('error', t('settings:mcp_descriptions.websocket_url_required'));
            return;
          }
          if ((transport === 'sse' || transport === 'streamable_http') && !(draft.endpoint || draft.fetch?.url)?.trim()) {
            showGlobalNotification('error', transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *'));
            return;
          }
          if (transport === 'stdio' && !draft.command?.trim()) {
            showGlobalNotification('error', t('settings:validations.enter_command'));
            return;
          }

          const normalizedDraft: any = { ...draft };
          if (transport === 'sse' || transport === 'streamable_http') {
            normalizedDraft.fetch = {
              type: transport,
              url: draft.endpoint || draft.fetch?.url || '',
            };
          }
          if (transport === 'stdio') {
            const trimmedCommand = draft.command?.trim() ?? '';
            normalizedDraft.command = trimmedCommand;
            const argsSource = draft.args;
            normalizedDraft.args = Array.isArray(argsSource)
              ? argsSource.map(arg => (typeof arg === 'string' ? arg.trim() : String(arg))).filter(Boolean)
              : typeof argsSource === 'string'
                ? argsSource.split(',').map(segment => segment.trim()).filter(Boolean)
                : [];
            if (!Array.isArray(normalizedDraft.args) || normalizedDraft.args.length === 0) {
              normalizedDraft.args = [...DEFAULT_STDIO_ARGS];
            }
          }
          toolToSave = normalizedDraft;
        }

        const nextList = [...(config.mcpTools || [])];
        if (mcpToolModal.index == null) {
          nextList.push(toolToSave);
        } else {
          nextList[mcpToolModal.index] = toolToSave;
        }
        try {
          if (invoke) {
            await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(nextList) });
          }
          setConfig(prev => ({ ...prev, mcpTools: nextList }));
        } catch (error) {
          const message = getErrorMessage(error);
          showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
          return;
        }
        try {
          await refreshSnapshots({ reload: true });
        } catch (e) {
          const errMsg = getErrorMessage(e);
          showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
        }
        setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
        showGlobalNotification('success', t('common:mcp_tool_saved'));
      } catch (error) {
        setMcpToolModal(prev => ({ ...prev, error: getErrorMessage(error) }));
      }
    };

    const modalContentClassName = 'flex w-[min(96vw,960px)] max-h-[85vh] flex-col overflow-hidden p-0';

    return (
      <UnifiedModal isOpen={true} onClose={handleClose} closeOnOverlayClick={false} contentClassName={modalContentClassName}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <NotionDialogHeader>
            <NotionDialogTitle>{isEditing ? t('settings:mcp_descriptions.edit_tool_title') : t('settings:mcp_descriptions.add_tool_title')}</NotionDialogTitle>
            <NotionDialogDescription>{t('settings:mcp_descriptions.tool_modal_hint')}</NotionDialogDescription>
          </NotionDialogHeader>
          <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="mt-1.5 flex flex-1 flex-col justify-start px-3 pb-0 min-h-0">
            <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
            <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
            <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
          </TabsList>
            <div className="mt-1.5 flex-1 overflow-hidden min-h-0">
          <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
            <CustomScrollArea
              className="h-full"
              viewportClassName="pr-2"
              trackOffsetTop={8}
              trackOffsetBottom={8}
              viewportProps={{ style: { maxHeight: 'calc(85vh - 180px)' } }}
            >
            <div className="space-y-2">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:placeholders.server_name')} *</label>
                <Input value={draft.name} onChange={e => updateDraft({ name: e.target.value })} placeholder={t('settings:placeholders.server_name')} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">ID</label>
                <Input value={draft.id} onChange={e => updateDraft({ id: e.target.value })} placeholder="mcp_filesystem" />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.transport_type')}</label>
                <AppSelect value={transport} onValueChange={value => {
                  const nextTransport = value as 'stdio' | 'websocket' | 'sse' | 'streamable_http';
                  const nextDraft: any = { ...draft, transportType: nextTransport };
                  if (nextTransport === 'sse' || nextTransport === 'streamable_http') {
                    nextDraft.fetch = { type: nextTransport, url: draft.fetch?.url || draft.endpoint || '' };
                  } else {
                    delete nextDraft.fetch;
                  }
                  updateDraft(nextDraft);
                }}
                  placeholder={t('settings:mcp_descriptions.transport_type')}
                  options={[
                    { value: 'stdio', label: t('settings:mcp.transport.stdio') },
                    { value: 'websocket', label: t('settings:mcp.transport.websocket') },
                    { value: 'sse', label: t('settings:mcp.transport.sse') },
                    { value: 'streamable_http', label: t('settings:mcp.transport.streamable_http') },
                  ]}
                  variant="outline"
                  size="sm"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp.namespace')}</label>
                <Input value={draft.namespace || ''} onChange={e => updateDraft({ namespace: e.target.value })} placeholder={t('common:optional')} />
              </div>
            </div>

            {transport === 'websocket' && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp.websocket_url')}</label>
                <Input value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
              </div>
            )}

            {(transport === 'sse' || transport === 'streamable_http') && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                  <Input
                    value={draft.endpoint || draft.fetch?.url || ''}
                    onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                    placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp.api_key')}</label>
                  <Input type="password" value={draft.apiKey || ''} onChange={e => updateDraft({ apiKey: e.target.value })} placeholder={t('settings:placeholders.api_key')} />
                </div>
              </div>
            )}

            {transport === 'stdio' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.command_label')}</label>
                  <Input
                    value={draft.command || ''}
                    onChange={e => updateDraft({ command: e.target.value })}
                    placeholder={t('settings:mcp_descriptions.command_placeholder', 'npx')}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings:mcp_descriptions.command_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.args_label')}</label>
                  <Input
                    value={argsInput}
                    onChange={e => updateDraft({ args: e.target.value })}
                    placeholder={t('settings:mcp_descriptions.args_placeholder', DEFAULT_STDIO_ARGS_PLACEHOLDER)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings:mcp_descriptions.args_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm font-medium text-foreground">
                    {renderInfoPopover(t('settings:mcp_descriptions.cwd_label'), t('settings:mcp_descriptions.cwd_hint'))}
                  </div>
                  <Input value={draft.cwd || ''} onChange={e => updateDraft({ cwd: e.target.value })} placeholder="/Users/you/projects" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm font-medium text-foreground">
                    {renderInfoPopover(t('settings:mcp_descriptions.framing_label'), t('settings:mcp_descriptions.framing_hint'))}
                  </div>
                  <AppSelect
                    value={draft.framing || 'jsonl'}
                    onValueChange={value => updateDraft({ framing: value as 'jsonl' | 'content_length' })}
                    options={[
                      { value: 'jsonl', label: t('settings:mcp.framing.json_lines') },
                      { value: 'content_length', label: 'Content-Length' },
                    ]}
                    variant="outline"
                    size="sm"
                  />
                </div>
                {!isTauriStdioSupported() && (
                  <Alert variant="warning" style={{ background: 'hsl(var(--warning-bg))', color: 'hsl(var(--warning))', borderColor: 'hsl(var(--warning) / 0.3)' }}>
                    <AlertTitle>{t('settings:mcp_descriptions.stdio_warning_title')}</AlertTitle>
                    <AlertDescription>{t('settings:mcp_descriptions.stdio_warning_desc')}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.env_title')}</span>
                <NotionButton variant="ghost" size="sm" onClick={addEnvRow}>+ {t('settings:mcp_descriptions.add_env')}</NotionButton>
              </div>
              <div className="space-y-2">
                {envEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('settings:mcp_descriptions.env_hint')}</p>
                )}
                {envEntries.map(([key, value], index) => (
                  <div key={`${key}-${index}`} className="flex items-center gap-2">
                    <Input
                      value={key}
                      onChange={e => handleEnvKeyChange(key, e.target.value)}
                      placeholder={t('settings:placeholders.env_key')}
                      className="max-w-[160px]"
                    />
                    <Input
                      value={value}
                      onChange={e => handleEnvValueChange(key, e.target.value)}
                      placeholder={t('settings:placeholders.env_value')}
                    />
                    <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8" onClick={() => removeEnvRow(key)}>
                      <Trash2 className="h-4 w-4" />
                    </NotionButton>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border bg-muted p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.connection_test_title')}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('settings:mcp_descriptions.connection_test_desc')}</p>
                </div>
                <NotionButton variant="ghost" onClick={handleTestConnection}>{t('settings:mcp_descriptions.run_test')}</NotionButton>
              </div>
            </div>
            </div>
            </CustomScrollArea>
          </TabsContent>
          <TabsContent value="json" className="h-full min-h-0 data-[state=inactive]:hidden">
            <div className="space-y-1.5 flex flex-col h-full">
              <UnifiedCodeEditor
                value={mcpToolModal.jsonInput}
                onChange={(value) => setMcpToolModal(prev => ({ ...prev, jsonInput: value }))}
                language="json"
                height="calc(85vh - 200px)"
                lineNumbers
                foldGutter
                highlightActiveLine
                className="rounded-md border border-border"
              />
              <p className="text-xs text-muted-foreground">{t('settings:mcp_descriptions.json_mode_hint')}</p>
            </div>
          </TabsContent>
            </div>
          </Tabs>

          {mcpToolModal.error && (
            <Alert variant="destructive" className="mx-3 mt-1.5 flex-shrink-0">
              <AlertTitle>{t('common:messages.error.title')}</AlertTitle>
              <AlertDescription>{mcpToolModal.error}</AlertDescription>
            </Alert>
          )}

          <NotionDialogFooter>
            <NotionButton variant="ghost" size="sm" onClick={handleClose}>{t('common:actions.cancel')}</NotionButton>
            <NotionButton size="sm" onClick={handleSubmit}>{isEditing ? t('common:actions.save') : t('common:actions.create')}</NotionButton>
          </NotionDialogFooter>
        </div>
      </UnifiedModal>
    );
  };

  // ===== 移动端嵌入式 MCP 工具编辑器 =====
  const renderMcpToolEditorEmbedded = () => {
    if (!mcpToolModal.open) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:mcp_descriptions.select_tool_to_edit')}</p>
        </div>
      );
    }

    const isEditing = mcpToolModal.index != null;
    const draft = mcpToolModal.draft;
    const transport = draft.transportType ?? 'stdio';
    const envEntries = Object.entries(draft.env || {});
    const argsInput = Array.isArray(draft.args)
      ? draft.args.join(', ')
      : typeof draft.args === 'string'
        ? draft.args
        : draft.args != null
          ? String(draft.args)
          : '';

    const handleClose = () => {
      setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
      closeRightPanel();
    };

    const updateDraft = (patch: Partial<typeof draft>) => {
      setMcpToolModal(prev => ({ ...prev, draft: { ...prev.draft, ...patch } }));
    };

    const handleModeChange = (value: string) => {
      if (value === 'json' && mcpToolModal.mode !== 'json') {
        // 转换为 JSON
        const name = draft.name || t('common:unnamed_mcp_tool');
        const config: Record<string, any> = { mcpServers: {} };
        const server: Record<string, any> = {};
        if (transport === 'sse' || transport === 'streamable_http') {
          server.type = transport;
          server.url = draft.endpoint || draft.fetch?.url || '';
        } else if (transport === 'websocket') {
          server.type = 'websocket';
          server.url = draft.url || '';
        } else {
          server.command = (draft.command || '').trim();
          const argsSource = draft.args;
          const normalizedArgs = Array.isArray(argsSource)
            ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
            : typeof argsSource === 'string'
              ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
              : [];
          server.args = normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS];
          server.framing = draft.framing || 'jsonl';
          if (draft.cwd) server.cwd = draft.cwd;
        }
        if (draft.apiKey) server.apiKey = draft.apiKey;
        if (draft.namespace) server.namespace = draft.namespace;
        if (draft.env && Object.keys(draft.env).length > 0) server.env = draft.env;
        config.mcpServers[name] = server;
        setMcpToolModal(prev => ({ ...prev, jsonInput: JSON.stringify(config, null, 2) }));
      }
      setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
    };

    const handleSubmit = async () => {
      try {
        let toolToSave: any;
        if (mcpToolModal.mode === 'json') {
          try {
            const jsonConfig = JSON.parse(mcpToolModal.jsonInput || '{}');
            if (jsonConfig?.mcpServers && typeof jsonConfig.mcpServers === 'object') {
              const [serverName, serverConfig] = Object.entries(jsonConfig.mcpServers)[0] as [string, any];
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: serverName,
                transportType: serverConfig.type || serverConfig.transportType || (serverConfig.command ? 'stdio' : 'sse'),
                command: serverConfig.command,
                args: serverConfig.args,
                env: serverConfig.env,
                url: serverConfig.url,
                endpoint: serverConfig.url,
                fetch: serverConfig.type === 'sse' || serverConfig.type === 'streamable_http' ? { type: serverConfig.type, url: serverConfig.url } : undefined,
                apiKey: serverConfig.apiKey,
                namespace: serverConfig.namespace,
                cwd: serverConfig.cwd,
                framing: serverConfig.framing,
              };
            } else {
              // 兼容非 mcpServers 格式的 JSON — 防止 toolToSave 为 undefined
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: jsonConfig.name || draft.name || t('common:unnamed_mcp_tool'),
                transportType: jsonConfig.transportType || jsonConfig.type || 'sse',
                url: jsonConfig.url,
                command: jsonConfig.command,
                args: jsonConfig.args,
                env: jsonConfig.env,
                apiKey: jsonConfig.apiKey,
                namespace: jsonConfig.namespace,
              };
            }
          } catch (err) {
            setMcpToolModal(prev => ({ ...prev, error: t('settings:mcp_errors.json_format_error') + (err as Error).message }));
            return;
          }
        } else {
          const argsSource = draft.args;
          const normalizedArgs = Array.isArray(argsSource)
            ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
            : typeof argsSource === 'string'
              ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
              : [];
          toolToSave = {
            id: draft.id || `mcp_${Date.now()}`,
            name: draft.name,
            transportType: transport,
            command: transport === 'stdio' ? draft.command : undefined,
            args: transport === 'stdio' ? (normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS]) : undefined,
            env: draft.env,
            url: transport === 'websocket' ? draft.url : undefined,
            endpoint: (transport === 'sse' || transport === 'streamable_http') ? (draft.endpoint || draft.fetch?.url) : undefined,
            fetch: (transport === 'sse' || transport === 'streamable_http') ? { type: transport, url: draft.endpoint || draft.fetch?.url || '' } : undefined,
            apiKey: draft.apiKey,
            namespace: draft.namespace,
            cwd: draft.cwd,
            framing: draft.framing,
          };
        }

        const nextList = [...(config.mcpTools || [])];
        if (mcpToolModal.index == null) {
          nextList.push(toolToSave);
        } else {
          nextList[mcpToolModal.index] = toolToSave;
        }
        try {
          if (invoke) {
            await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(nextList) });
          }
          setConfig(prev => ({ ...prev, mcpTools: nextList }));
        } catch (e) {
          const message = getErrorMessage(e);
          showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
          return;
        }
        try {
          await refreshSnapshots({ reload: true });
        } catch (e) {
          const errMsg = getErrorMessage(e);
          showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
        }
        setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
        closeRightPanel();
        showGlobalNotification('success', t('common:mcp_tool_saved'));
      } catch (error) {
        setMcpToolModal(prev => ({ ...prev, error: getErrorMessage(error) }));
      }
    };

    return (
      <div
        className="h-full flex flex-col bg-background"
        style={{
          paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
        }}
      >
        <div className="px-4 pt-4 pb-2 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold">{isEditing ? t('settings:mcp_descriptions.edit_tool_title') : t('settings:mcp_descriptions.add_tool_title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('settings:mcp_descriptions.tool_modal_hint')}</p>
        </div>

        <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="flex-1 flex flex-col min-h-0 px-4 pt-3">
          <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
            <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
            <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-hidden min-h-0 mt-3">
            <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
              <CustomScrollArea className="h-full" viewportClassName="pr-2">
                <div className="space-y-4 pb-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:placeholders.server_name')} *</label>
                    <Input value={draft.name} onChange={e => updateDraft({ name: e.target.value })} placeholder={t('settings:placeholders.server_name')} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">ID</label>
                    <Input value={draft.id} onChange={e => updateDraft({ id: e.target.value })} placeholder="mcp_filesystem" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp_descriptions.transport_type')}</label>
                    <AppSelect value={transport} onValueChange={value => {
                      const nextTransport = value as 'stdio' | 'websocket' | 'sse' | 'streamable_http';
                      const nextDraft: any = { ...draft, transportType: nextTransport };
                      if (nextTransport === 'sse' || nextTransport === 'streamable_http') {
                        nextDraft.fetch = { type: nextTransport, url: draft.fetch?.url || draft.endpoint || '' };
                      } else {
                        delete nextDraft.fetch;
                      }
                      updateDraft(nextDraft);
                    }}
                      placeholder={t('settings:mcp_descriptions.transport_type')}
                      options={[
                        { value: 'stdio', label: t('settings:mcp.transport.stdio') },
                        { value: 'websocket', label: t('settings:mcp.transport.websocket') },
                        { value: 'sse', label: t('settings:mcp.transport.sse') },
                        { value: 'streamable_http', label: t('settings:mcp.transport.streamable_http') },
                      ]}
                      variant="outline"
                      size="sm"
                    />
                  </div>

                  {transport === 'websocket' && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{t('settings:mcp.websocket_url')}</label>
                      <Input value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
                    </div>
                  )}

                  {(transport === 'sse' || transport === 'streamable_http') && (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                        <Input
                          value={draft.endpoint || draft.fetch?.url || ''}
                          onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                          placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp.api_key')}</label>
                        <Input type="password" value={draft.apiKey || ''} onChange={e => updateDraft({ apiKey: e.target.value })} placeholder={t('settings:placeholders.api_key')} />
                      </div>
                    </>
                  )}

                  {transport === 'stdio' && (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.command_label')}</label>
                        <Input
                          value={draft.command || ''}
                          onChange={e => updateDraft({ command: e.target.value })}
                          placeholder={t('settings:mcp_descriptions.command_placeholder', 'npx')}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.args_label')}</label>
                        <Input
                          value={argsInput}
                          onChange={e => updateDraft({ args: e.target.value })}
                          placeholder={t('settings:mcp_descriptions.args_placeholder', DEFAULT_STDIO_ARGS_PLACEHOLDER)}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.cwd_label')}</label>
                        <Input value={draft.cwd || ''} onChange={e => updateDraft({ cwd: e.target.value })} placeholder="/Users/you/projects" />
                      </div>
                    </>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp.namespace')}</label>
                    <Input value={draft.namespace || ''} onChange={e => updateDraft({ namespace: e.target.value })} placeholder={t('common:optional')} />
                  </div>

                  {/* 环境变量 */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp_descriptions.env_label')}</label>
                    {envEntries.map(([key, value], idx) => (
                      <div key={idx} className="flex gap-2">
                        <Input
                          value={key}
                          onChange={e => {
                            const newEnv = { ...draft.env };
                            delete newEnv[key];
                            newEnv[e.target.value] = value;
                            updateDraft({ env: newEnv });
                          }}
                          placeholder={t('settings:placeholders.env_key')}
                          className="flex-1"
                        />
                        <Input
                          value={value}
                          onChange={e => updateDraft({ env: { ...draft.env, [key]: e.target.value } })}
                          placeholder={t('settings:placeholders.env_value')}
                          className="flex-1"
                        />
                        <NotionButton
                          variant="ghost"
                          iconOnly size="sm"
                          onClick={() => {
                            const newEnv = { ...draft.env };
                            delete newEnv[key];
                            updateDraft({ env: newEnv });
                          }}
                        >
                          <X className="h-4 w-4" />
                        </NotionButton>
                      </div>
                    ))}
                    <NotionButton
                      variant="default"
                      size="sm"
                      onClick={() => updateDraft({ env: { ...draft.env, '': '' } })}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      {t('settings:mcp_descriptions.add_env')}
                    </NotionButton>
                  </div>
                </div>
              </CustomScrollArea>
            </TabsContent>

            <TabsContent value="json" className="h-full min-h-0 data-[state=inactive]:hidden">
              <div className="h-full flex flex-col">
                <UnifiedCodeEditor
                  value={mcpToolModal.jsonInput}
                  onChange={(value) => setMcpToolModal(prev => ({ ...prev, jsonInput: value }))}
                  language="json"
                  height="100%"
                  lineNumbers
                  foldGutter
                  highlightActiveLine
                  className="flex-1 rounded-md border border-border"
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {mcpToolModal.error && (
          <Alert variant="destructive" className="mx-4 mt-2 flex-shrink-0">
            <AlertTitle>{t('common:messages.error.title')}</AlertTitle>
            <AlertDescription>{mcpToolModal.error}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <NotionButton variant="ghost" onClick={handleClose} className="flex-1">{t('common:actions.cancel')}</NotionButton>
          <NotionButton onClick={handleSubmit} className="flex-1">{isEditing ? t('common:actions.save') : t('common:actions.create')}</NotionButton>
        </div>
      </div>
    );
  };

  // ===== 移动端嵌入式 MCP 策略编辑器 =====
  const renderMcpPolicyEditorEmbedded = () => {
    if (!mcpPolicyModal.open) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:mcp_descriptions.select_policy_to_edit')}</p>
        </div>
      );
    }

    const handleClose = () => {
      setMcpPolicyModal(prev => ({ ...prev, open: false }));
      closeRightPanel();
    };

    const handleSave = async () => {
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
      handleClose();
    };

    return (
      <div
        className="h-full flex flex-col bg-background"
        style={{
          paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
        }}
      >
        <div className="px-4 pt-4 pb-2 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold">{t('settings:mcp_descriptions.policy_title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('settings:mcp_descriptions.policy_subtitle')}</p>
        </div>

        <CustomScrollArea className="flex-1" viewportClassName="px-4 py-4">
          <div className="space-y-4">
            {/* 广告所有工具 */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="advertiseAll"
                checked={mcpPolicyModal.advertiseAll}
                onCheckedChange={(checked) => setMcpPolicyModal(prev => ({ ...prev, advertiseAll: checked === true }))}
              />
              <label htmlFor="advertiseAll" className="text-sm font-medium cursor-pointer">
                {t('settings:mcp_descriptions.advertise_all')}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings:mcp_descriptions.advertise_all_hint')}
            </p>

            {/* 白名单 */}
            {!mcpPolicyModal.advertiseAll && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.whitelist_label')}</label>
                <Input
                  value={mcpPolicyModal.whitelist}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, whitelist: e.target.value }))}
                  placeholder="read_file, write_file, list_directory"
                />
              </div>
            )}

            {/* 黑名单 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.blacklist_label')}</label>
              <Input
                value={mcpPolicyModal.blacklist}
                onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, blacklist: e.target.value }))}
                placeholder="delete_file, execute_command, rm, sudo"
              />
            </div>

            {/* 性能参数 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.timeout_label')}</label>
                <Input
                  type="number"
                  min={1000}
                  value={mcpPolicyModal.timeoutMs}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.rate_limit_label')}</label>
                <Input
                  type="number"
                  min={1}
                  value={mcpPolicyModal.rateLimit}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_max_label')}</label>
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
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_ttl_label')}</label>
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
                />
              </div>
            </div>
          </div>
        </CustomScrollArea>

        <div className="flex gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <NotionButton variant="ghost" onClick={handleClose} className="flex-1">{t('common:actions.cancel')}</NotionButton>
          <NotionButton onClick={handleSave} className="flex-1">{t('common:actions.save')}</NotionButton>
        </div>
      </div>
    );
  };

  // ===== 移动端嵌入式供应商配置编辑器 =====
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
          paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
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

  const handleReconnectClient = async () => {
    try {
      // 重新从设置初始化（确保新增/删除的服务器生效），而不仅仅 connectAll
      const { bootstrapMcpFromSettings } = await import('../mcp/mcpService');
      await bootstrapMcpFromSettings({ force: true });
      try {
        await invoke('preheat_mcp_tools');
      } catch (e) {
        console.warn('[MCP] 预热工具缓存失败:', e);
      }
      await refreshSnapshots({ reload: true });
      try {
        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { mcpReloaded: true } }));
      } catch {
        // 事件派发失败不影响主流程，重连已完成
      }
      showGlobalNotification('success', t('settings:mcp_descriptions.reconnected'));
    } catch (e: any) {
      try {
        addMcpError('network', e, {
          title: t('settings:mcp_descriptions.frontend_connect_failed'),
          recoveryActions: [
            {
              type: 'retry',
              label: t('settings:mcp_descriptions.retry_connect'),
              icon: <RefreshCcw size={12} />,
              variant: 'primary',
              action: async () => {
                try {
                  const { bootstrapMcpFromSettings } = await import('../mcp/mcpService');
                  await bootstrapMcpFromSettings({ force: true });
                  await invoke('preheat_mcp_tools').catch(() => undefined);
                  await refreshSnapshots({ reload: true });
                  showGlobalNotification('success', t('settings:mcp_descriptions.reconnected_preheated'));
                } catch (err) {
                  console.error('重试连接失败:', err);
                }
              },
            },
            {
              type: 'cancel',
              label: t('common:close'),
              icon: <X size={12} />,
              variant: 'secondary',
              action: () => {},
            },
          ],
          additionalContext: { at: new Date().toISOString() },
        });
      } catch (innerErr) {
        console.warn('[Settings] 记录 MCP 连接错误时自身也失败:', innerErr);
      }
      showGlobalNotification('error', t('settings:mcp_descriptions.reconnect_failed', { error: e?.message || e }));
    }
  };

  const handleRefreshRegistry = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      const [tools, prompts, resources] = await Promise.all([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.refreshed_summary', { tools: tools.length, prompts: prompts.length, resources: resources.length }));
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.refresh_failed', { error: e?.message || e }));
    }
  };
  const handleRunHealthCheck = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      await McpService.connectAll().catch(() => undefined);
      const status = await McpService.status();
      if (!status.servers.length) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.no_servers_configured'));
        return;
      }
      const summaries: string[] = [];
      const failures: string[] = [];
      const configured = normalizedMcpServers.map((item: any, index: number) => ({ item, index }));
      for (const server of status.servers) {
        try {
          if (!server.connected) {
            await McpService.connectServerById(server.id).catch(() => undefined);
          }
          const [tools, prompts, resources] = await Promise.all([
            McpService.fetchServerTools(server.id).catch(() => []),
            McpService.fetchServerPrompts(server.id).catch(() => []),
            McpService.fetchServerResources(server.id).catch(() => []),
          ]);
          const match = configured.find(({ item, index }) => {
            const candidateId = resolveServerId(item, index);
            return candidateId === server.id || item?.id === server.id || item?.name === server.id;
          });
          const label = match?.item?.name || server.id;
          summaries.push(`✅ ${t('settings:mcp_descriptions.health_check_item', { label, tools: tools.length, prompts: prompts.length, resources: resources.length })}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`❌ ${server.id}: ${message}`);
        }
      }
      await refreshSnapshots();
      const message = [...summaries, ...failures].join('\n');
      if (failures.length > 0) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.health_partial_failed', { message }));
      } else {
        showGlobalNotification('success', t('settings:mcp_descriptions.health_complete', { message }));
      }
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.health_failed', { error: e?.message || e }));
    }
  };

  const handleClearCaches = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      McpService.clearCaches();
      // 清缓存后自动重新获取，避免统计卡片归零让用户困惑
      await Promise.allSettled([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.cache_cleared'));
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.clear_cache_failed', { error: e?.message || e }));
    }
  };

  const handlePreviewServer = async (tool: any, idx: number) => {
    const serverId = resolveServerId(tool, idx);
    const serverName = tool?.name || tool?.id || serverId;
    setMcpPreview({ open: true, loading: true, serverId, serverName, tools: [], prompts: [], resources: [] });
    try {
      const { McpService } = await import('../mcp/mcpService');
      const [toolList, promptList, resourceList] = await Promise.all([
        McpService.fetchServerTools(serverId).catch(() => []),
        McpService.fetchServerPrompts(serverId).catch(() => []),
        McpService.fetchServerResources(serverId).catch(() => []),
      ]);
      await refreshSnapshots();
      setMcpPreview(prev => ({ ...prev, loading: false, tools: toolList, prompts: promptList, resources: resourceList }));
    } catch (e: any) {
      setMcpPreview(prev => ({ ...prev, loading: false, error: e?.message || String(e) }));
    }
  };
  const handleTestServer = async (tool: any) => {
    try {
      const transport = (tool?.transportType || 'sse') as string;
      let failureLabel = t('settings:test_labels.connectivity_test_failed');
      let res: any = null;
      const headerCandidates: Record<string, string> = {};
      const mergeHeaders = (source?: Record<string, any>) => {
        if (!source) return;
        Object.entries(source).forEach(([key, value]) => {
          if (value == null) return;
          headerCandidates[key] = typeof value === 'string' ? value : String(value);
        });
      };
      // 仅合并 headers，不合并 env（env 是进程环境变量，不应发送到远程服务器）
      mergeHeaders(tool?.headers as Record<string, any> | undefined);
      // 改为仅使用前端体检
      if (transport === 'websocket') {
        failureLabel = t('settings:test_labels.websocket_failed');
        const fr = await testMcpWebsocketFrontend(String(tool?.url || ''), String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'streamable_http') {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.http_failed');
        const fr = await testMcpHttpFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'stdio') {
        // 前端不支持 stdio
        showGlobalNotification('warning', t('settings:messages.frontend_test_stdio_unsupported'));
        return;
      } else {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.sse_failed');
        const fr = await testMcpSseFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      }
      if (!handleMcpTestResult(res, failureLabel)) return;
      showGlobalNotification('success', t('settings:mcp_descriptions.test_success', { name: tool?.name || tool?.id || 'MCP', toolInfo: describeToolCount(res) }));

      // 将连通性测试发现的工具写回缓存，让 UI 立即显示正确的工具数量
      const serverId = tool?.id || tool?.name;
      if (serverId && Array.isArray(res?.tools) && res.tools.length > 0) {
        setMcpCachedDetails(prev => ({
          ...prev,
          toolsByServer: {
            ...prev.toolsByServer,
            [serverId]: {
              items: res.tools.map((t: any) => ({ name: t.name, description: t.description })),
              at: Date.now(),
            },
          },
        }));
      }
    } catch (e: any) {
      handleMcpTestError(e, t('settings:messages.connection_test_error'));
    }
  };

  const handleClosePreview = () => {
    setMcpPreview({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  };

  const mcpServers = normalizedMcpServers;
  const serverStatusMap = useMemo(() => {
    const map = new Map<string, { connected: boolean; error?: string }>();
    (mcpStatusInfo?.servers || []).forEach(s => {
      map.set(s.id, { connected: s.connected, error: s.error });
    });
    return map;
  }, [mcpStatusInfo]);
  const totalServers = mcpServers.length;
  const connectedServers = useMemo(() => {
    if (!totalServers) return 0;
    const entries = Array.from(serverStatusMap.values()).filter(s => s.connected);
    return entries.length;
  }, [serverStatusMap, totalServers]);
  const totalCachedTools = useMemo(() => {
    return Object.values(mcpCachedDetails.toolsByServer).reduce((acc, entry) => acc + (entry?.items?.length || 0), 0);
  }, [mcpCachedDetails.toolsByServer]);
  const promptsCount = mcpCachedDetails.prompts.items.length;
  const resourcesCount = mcpCachedDetails.resources.items.length;
  const lastCacheUpdatedAt = useMemo(() => {
    const toolTs = Object.values(mcpCachedDetails.toolsByServer)
      .map(entry => entry?.at)
      .filter((v): v is number => typeof v === 'number');
    const overviews = [mcpCachedDetails.prompts.at, mcpCachedDetails.resources.at].filter(
      (v): v is number => typeof v === 'number'
    );
    const all = [...toolTs, ...overviews];
    if (!all.length) return undefined;
    return Math.max(...all);
  }, [mcpCachedDetails]);
  const lastCacheUpdatedText = lastCacheUpdatedAt
    ? new Date(lastCacheUpdatedAt).toLocaleString()
    : '—';
  const lastError = mcpStatusInfo?.lastError;
  const displayedLastError = lastError && lastError.length > 96 ? `${lastError.slice(0, 96)}…` : lastError;
  const cacheCapacity = useMemo(() => {
    const candidate = Number(config.mcpCacheMax ?? 500);
    if (Number.isNaN(candidate) || candidate < 0) return 500;
    return candidate;
  }, [config.mcpCacheMax]);
  const cacheUsagePercent = useMemo(() => {
    if (!cacheCapacity) return 0;
    const ratio = (totalCachedTools / cacheCapacity) * 100;
    if (!Number.isFinite(ratio)) return 0;
    return Math.max(0, Math.min(100, Math.round(ratio)));
  }, [cacheCapacity, totalCachedTools]);
  const latestPrompts = useMemo(() => mcpCachedDetails.prompts.items.slice(0, 5), [mcpCachedDetails.prompts.items]);
  const latestResources = useMemo(() => mcpCachedDetails.resources.items.slice(0, 5), [mcpCachedDetails.resources.items]);

  // 侧边栏导航项配置：按「类型」分组，渲染时用分割线隔开（搜索时不显示分割线）
  const sidebarNavGroups = useMemo(() => ([
    [
      // 模型相关：放在一起（用户期望“模型服务”和“模型分配”相邻）
      { value: 'apis', icon: Bot, label: t('settings:tabs.api_config'), tourId: 'settings-tab-apis' },
      { value: 'models', icon: FlaskConical, label: t('settings:tabs.model_assignment'), tourId: 'settings-tab-models' },
    ],
    [
      { value: 'app', icon: Palette, label: t('settings:tabs.app') },
    ],
    [
      // 工具相关
      { value: 'mcp', icon: Plug, label: t('settings:tabs.mcp_tools') },
      { value: 'search', icon: Globe, label: t('settings:tabs.external_search') },
    ],
    [
      { value: 'statistics', icon: BarChart3, label: t('settings:tabs.statistics') },
      { value: 'data-governance', icon: Shield, label: t('settings:tabs.data_governance') },
    ],
    [
      { value: 'params', icon: Wrench, label: t('settings:tabs.params') },
      { value: 'shortcuts', icon: Keyboard, label: t('settings:tabs.shortcuts') },
      { value: 'about', icon: BookOpen, label: t('settings:tabs.about') },
    ],
  ]), [t]);

  const sidebarNavItems = useMemo(() => sidebarNavGroups.flat(), [sidebarNavGroups]);

  // 设置项搜索索引 - 包含所有可搜索的具体设置项
  const settingsSearchIndex = useMemo(() => [
    // App settings
    { tab: 'app', label: t('settings:appearance.theme.title'), keywords: ['theme', 'dark', 'light', 'appearance'] },
    { tab: 'app', label: t('settings:appearance.font.title'), keywords: ['font', 'typeface'] },
    { tab: 'app', label: t('settings:appearance.font.size_label'), keywords: ['font size'] },
    { tab: 'app', label: t('settings:appearance.font.heading_label'), keywords: ['heading font'] },
    { tab: 'app', label: t('settings:appearance.font.body_label'), keywords: ['body font'] },
    { tab: 'app', label: t('settings:language.title'), keywords: ['language'] },
    { tab: 'app', label: t('settings:appearance.sidebar.title'), keywords: ['sidebar', 'navigation'] },
    { tab: 'app', label: t('settings:appearance.sidebar.position'), keywords: ['sidebar position'] },
    // API config
    { tab: 'apis', label: t('settings:api.add_api_config'), keywords: ['API', 'add', 'config'] },
    { tab: 'apis', label: t('settings:api.modal.basic_info'), keywords: ['basic', 'API name', 'endpoint'] },
    { tab: 'apis', label: t('settings:api.modal.fields.api_key'), keywords: ['apikey', 'api key', 'key'] },
    { tab: 'apis', label: t('settings:api.modal.model_adapter'), keywords: ['adapter', 'openai', 'azure', 'gemini', 'claude'] },
    // Model assignment
    { tab: 'models', label: t('settings:api.model2_title'), keywords: ['chat model', 'conversation', 'reasoning'] },
    { tab: 'models', label: t('settings:api.embedding_title'), keywords: ['embedding', 'RAG', 'vector'] },
    { tab: 'models', label: t('settings:api.reranker_title'), keywords: ['reranker', 'RAG'] },
    { tab: 'models', label: t('settings:api.anki_card_title'), keywords: ['anki', 'card'] },
    // MCP tools
    { tab: 'mcp', label: t('settings:mcp.server'), keywords: ['mcp', 'server', 'tool'] },
    { tab: 'mcp', label: t('settings:mcp.add_server'), keywords: ['add server', 'mcp'] },
    // External search
    { tab: 'search', label: t('settings:search_engine.title'), keywords: ['search engine', 'google', 'bing', 'tavily', 'searxng'] },
    { tab: 'search', label: 'SearXNG', keywords: ['searxng', 'search'] },
    { tab: 'search', label: 'Tavily', keywords: ['tavily', 'search', 'api'] },
    { tab: 'search', label: 'Exa', keywords: ['exa', 'search'] },
    // Statistics
    { tab: 'statistics', label: t('settings:statistics.learning_time'), keywords: ['learning time', 'statistics'] },
    { tab: 'statistics', label: t('settings:statistics.chat_stats'), keywords: ['chat stats', 'session'] },
    { tab: 'statistics', label: t('settings:statistics.heatmap'), keywords: ['heatmap', 'activity'] },
    // Data governance
    { tab: 'data-governance', label: t('data:governance.title'), keywords: ['data governance', 'import', 'export'] },
    { tab: 'data-governance', label: t('data:governance.backup'), keywords: ['backup', 'export'] },
    { tab: 'data-governance', label: t('data:governance.restore'), keywords: ['restore', 'import'] },
    // Parameters
    { tab: 'params', label: t('settings:params.temperature'), keywords: ['temperature', 'parameter'] },
    { tab: 'params', label: t('settings:params.max_tokens'), keywords: ['token', 'max tokens', 'length'] },
    { tab: 'params', label: t('settings:params.top_p'), keywords: ['top p', 'parameter'] },
    { tab: 'params', label: t('settings:params.frequency_penalty'), keywords: ['frequency penalty'] },
    { tab: 'params', label: t('settings:params.presence_penalty'), keywords: ['presence penalty'] },
    // Shortcuts
    { tab: 'shortcuts', label: t('settings:shortcuts.title'), keywords: ['shortcuts', 'keyboard'] },
    { tab: 'shortcuts', label: t('settings:shortcuts.new_chat'), keywords: ['new chat', 'shortcuts'] },
    { tab: 'shortcuts', label: t('settings:shortcuts.search'), keywords: ['search', 'shortcuts'] },
    { tab: 'shortcuts', label: t('settings:shortcuts.toggle_sidebar'), keywords: ['toggle sidebar', 'shortcuts'] },
    // About
    { tab: 'about', label: t('settings:about.version'), keywords: ['version', 'about'] },
    { tab: 'about', label: t('settings:about.license'), keywords: ['license', 'open source'] },
    { tab: 'about', label: t('settings:about.acknowledgements'), keywords: ['acknowledgements', 'credits'] },
  ], [t]);

  const loadConfig = async () => {
    setLoading(true);
    try {
      if (invoke) {
        // 使用新的专用API配置管理命令
        const results = await Promise.all([
          invoke('get_api_configurations').catch(() => []) as Promise<ApiConfig[]>,
          invoke('get_model_assignments').catch(() => ({
            model2_config_id: null,
            anki_card_model_config_id: null,
            qbank_ai_grading_model_config_id: null,
            reranker_model_config_id: null,
            exam_sheet_ocr_model_config_id: null,
            translation_model_config_id: null,
            chat_title_model_config_id: null,
            // 多模态知识库模型（嵌入模型通过维度管理设置）
            vl_reranker_model_config_id: null,
          })) as Promise<{
            model2_config_id: string | null,
            anki_card_model_config_id: string | null,
            qbank_ai_grading_model_config_id: string | null,
            reranker_model_config_id: string | null,
            exam_sheet_ocr_model_config_id: string | null,
            translation_model_config_id: string | null,
            chat_title_model_config_id: string | null,
            // 多模态知识库模型（嵌入模型通过维度管理设置）
            vl_reranker_model_config_id: string | null,
          }>,
          invoke('get_setting', { key: 'auto_save' }).catch(() => 'true') as Promise<string>,
          invoke('get_setting', { key: 'theme' }).catch(() => 'light') as Promise<string>,
          invoke('get_setting', { key: 'theme_palette' }).catch(() => 'default') as Promise<string>,
          invoke('get_setting', { key: 'debug_mode' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'rag_enabled' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'rag_top_k' }).catch(() => '5') as Promise<string>,
          invoke('get_setting', { key: 'anki_connect_enabled' }).catch(() => 'false') as Promise<string>,

          // MCP 工具协议设置（移除全局启用项）
          invoke('get_setting', { key: 'mcp.transport.command' }).catch(() => 'npx') as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.args' }).catch(() => DEFAULT_STDIO_ARGS_STORAGE) as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.type' }).catch(() => 'stdio') as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.url' }).catch(() => 'ws://localhost:8000') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.advertise_all_tools' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.whitelist' }).catch(() => 'read_file, write_file, list_directory') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.blacklist' }).catch(() => 'delete_file, execute_command, rm, sudo') as Promise<string>,
          // 多工具配置（JSON）
          invoke('get_setting', { key: 'mcp.tools.list' }).catch(() => '[]') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.timeout_ms' }).catch(() => '15000') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.rate_limit_per_second' }).catch(() => '10') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.cache_max_size' }).catch(() => '500') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.cache_ttl_ms' }).catch(() => '300000') as Promise<string>,

          // Web Search 设置（移除全局启用项）
          invoke('get_setting', { key: 'web_search.engine' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.timeout_ms' }).catch(() => '15000') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.google_cse' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.google_cse.cx' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.serpapi' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.tavily' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.brave' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.searxng.endpoint' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.searxng.api_key' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.zhipu' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.bocha' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.site_whitelist' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.site_blacklist' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.inject.snippet_max_chars' }).catch(() => '180') as Promise<string>,
          invoke('get_setting', { key: 'web_search.inject.total_max_chars' }).catch(() => '1900') as Promise<string>,
        ]);

        // 解构赋值
        const [
          apiConfigs, 
          modelAssignments, 
          autoSave, 
          theme, 
          themePaletteSetting,
          debugMode, 
          ragEnabled, 
          ragTopK, 
          ankiConnectEnabled, 

          // MCP 工具协议设置（无全局启用项）
          mcpCommand,
          mcpArgs,
          mcpTransportType,
          mcpUrl,
          mcpAdvertiseAll,
          mcpWhitelist,
          mcpBlacklist,
          mcpToolsJson,
          mcpTimeoutMs,
          mcpRateLimit,
          mcpCacheMax,
          mcpCacheTtlMs,
          // Web Search 设置（无全局启用项）
          webEngine,
          webTimeoutMs,
          webGoogleKey,
          webGoogleCx,
          webSerpKey,
          webTavilyKey,
          webBraveKey,
          webSearxngEndpoint,
          webSearxngKey,
          webZhipuKey,
          webBochaKey,
          webWhitelist,
          webBlacklist,
          webInjectSnippet,
          webInjectTotal,
        ] = results;

        // 处理API配置的字段映射（snake_case to camelCase）
        const mappedApiConfigs = (apiConfigs || []).map((config: any) => ({
          ...config,
          maxOutputTokens: config.maxOutputTokens,
          temperature: config.temperature,
        }));

        const parsedMcpTimeout = (() => {
          const parsed = parseInt(mcpTimeoutMs || '15000', 10);
          return Number.isFinite(parsed) ? parsed : 15000;
        })();
        const parsedMcpRateLimit = (() => {
          const parsed = parseInt(mcpRateLimit || '10', 10);
          return Number.isFinite(parsed) ? parsed : 10;
        })();
        const parsedMcpCacheMax = (() => {
          const parsed = parseInt(mcpCacheMax || '100', 10);
          return Number.isFinite(parsed) ? parsed : 100;
        })();
        const parsedMcpCacheTtl = (() => {
          const parsed = parseInt(mcpCacheTtlMs || '300000', 10);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
        })();

        const parsedMcpTools = (() => {
          try {
            return JSON.parse(mcpToolsJson || '[]');
          } catch {
            return [];
          }
        })();
        const normalizedMcpTools = normalizeMcpToolList(parsedMcpTools);

        const migratedCommandSegments = (() => {
          if (typeof mcpCommand === 'string' && /@modelcontextprotocol\//.test(mcpCommand || '')) {
            const pieces = mcpCommand.split(' ').filter(Boolean);
            if (pieces.length > 1) {
              return pieces;
            }
          }
          return null;
        })();
        const normalizedMcpCommand = (() => {
          if (migratedCommandSegments && migratedCommandSegments.length > 0) {
            return migratedCommandSegments[0];
          }
          if (typeof mcpCommand === 'string' && mcpCommand.trim().length > 0) {
            return mcpCommand.trim();
          }
          return 'npx';
        })();
        const normalizedMcpArgsString = (() => {
          let argsArray: string[] = [];
          if (migratedCommandSegments && migratedCommandSegments.length > 1) {
            argsArray = migratedCommandSegments.slice(1);
          } else if (typeof mcpArgs === 'string' && mcpArgs.trim().length > 0) {
            argsArray = mcpArgs
              .split(',')
              .map(segment => segment.trim())
              .filter(Boolean);
          }
          if (argsArray.length === 0) {
            argsArray = [...DEFAULT_STDIO_ARGS];
          }
          return argsArray.join(',');
        })();

        const newConfig = {
          apiConfigs: mappedApiConfigs,
          model2ConfigId: modelAssignments?.model2_config_id || '',
          ankiCardModelConfigId: modelAssignments?.anki_card_model_config_id || '',
          qbank_ai_grading_model_config_id: modelAssignments?.qbank_ai_grading_model_config_id || '',
          rerankerModelConfigId: modelAssignments?.reranker_model_config_id || '',
          chat_title_model_config_id: modelAssignments?.chat_title_model_config_id || '',
          exam_sheet_ocr_model_config_id: modelAssignments?.exam_sheet_ocr_model_config_id || '',
          translation_model_config_id: modelAssignments?.translation_model_config_id || '',
          // 多模态知识库模型配置（嵌入模型通过维度管理设置）
          vl_reranker_model_config_id: modelAssignments?.vl_reranker_model_config_id || '',
          autoSave: (autoSave || 'true') === 'true',
          theme: normalizeThemeMode(theme),
          themePalette: normalizeThemePalette(themePaletteSetting),
          debugMode: (debugMode || 'false') === 'true',
          ragEnabled: (ragEnabled || 'false') === 'true',
          ragTopK: parseInt(ragTopK || '5', 10),
          ankiConnectEnabled: (ankiConnectEnabled || 'false') === 'true',

          // MCP 工具协议设置（不再设置全局启用项）
          mcpCommand: normalizedMcpCommand,
          mcpTransportType: (mcpTransportType === 'websocket' ? 'websocket' : 'stdio') as 'stdio' | 'websocket',
          mcpUrl: mcpUrl || 'ws://localhost:8000',
          mcpArgs: normalizedMcpArgsString,
          mcpAdvertiseAll: (mcpAdvertiseAll || 'false') === 'true',
          mcpWhitelist: mcpWhitelist || 'read_file, write_file, list_directory',
          mcpBlacklist: mcpBlacklist || 'delete_file, execute_command, rm, sudo',
          mcpTimeoutMs: parsedMcpTimeout,
          mcpRateLimit: parsedMcpRateLimit,
          mcpCacheMax: parsedMcpCacheMax,
          mcpCacheTtlMs: parsedMcpCacheTtl,
          mcpTools: normalizedMcpTools,

          // Web Search 设置（UI 层存储，仅供保存使用）
          // 为保持与其他页面一致，全部使用简单原生控件，不在此定义专门类型
          // 外部搜索设置（不再设置全局启用项）
          webSearchEngine: webEngine || '',
          webSearchTimeoutMs: parseInt(webTimeoutMs || '15000', 10),
          webSearchGoogleKey: webGoogleKey || '',
          webSearchGoogleCx: webGoogleCx || '',
          webSearchSerpApiKey: webSerpKey || '',
          webSearchTavilyKey: webTavilyKey || '',
          webSearchBraveKey: webBraveKey || '',
          webSearchSearxngEndpoint: webSearxngEndpoint || '',
          webSearchSearxngKey: webSearxngKey || '',
          webSearchZhipuKey: webZhipuKey || '',
          webSearchBochaKey: webBochaKey || '',
          webSearchWhitelist: webWhitelist || '',
          webSearchBlacklist: webBlacklist || '',
          webSearchInjectSnippetMax: parseInt(webInjectSnippet || '180', 10) || 180,
          webSearchInjectTotalMax: parseInt(webInjectTotal || '1900', 10) || 1900,
          // 两阶段题目集识别（从 modelAssignments 同步，此处占位）
          question_parsing_model_config_id: '',
        };
        
        console.log('加载的配置:', {
          apiConfigs: newConfig.apiConfigs.length,
          model2ConfigId: newConfig.model2ConfigId,
          modelAssignments
        });
        
        setConfig(newConfig);

        // 注意：不要用后端存储的 theme/themePalette 覆盖前端 useTheme 的状态
        // useTheme 使用 localStorage 作为主题的 single source of truth
        // 后端存储可能是旧值，会导致从暗色模式意外切换回亮色模式
        // 相反，我们应该将前端的主题状态同步到 config 中（已在 useEffect 中处理）
      } else {
        // 浏览器环境 - 支持从旧键名迁移
        let savedConfig = localStorage.getItem('deep-student-config');
        if (!savedConfig) {
          // 尝试从旧键名迁移
          const oldConfig = localStorage.getItem('ai-mistake-manager-config');
          if (oldConfig) {
            savedConfig = oldConfig;
            // 保存到新键名
            localStorage.setItem('deep-student-config', oldConfig);
            // 删除旧键名
            localStorage.removeItem('ai-mistake-manager-config');
            console.log('✅ 已自动迁移配置从旧键名到新键名');
          }
        }
        if (savedConfig) {
          try {
            const parsed = JSON.parse(savedConfig);
            const normalized = normalizeMcpToolList((parsed as any)?.mcpTools ?? (parsed as any)?.mcpServers);
            setConfig(prev => ({
              ...prev,
              ...parsed,
              theme: normalizeThemeMode((parsed as any)?.theme),
              themePalette: normalizeThemePalette((parsed as any)?.themePalette),
              mcpTools: normalized,
            }));
          } catch (e) {
            console.error('Browser config load failed:', e);
          }
        }
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Config load failed:', error);
      showGlobalNotification('error', t('settings:mcp.load_config_failed', { error: errorMessage }));
    } finally {
      setLoading(false);
    }
  };
  const handleSave = useCallback(async (silent = false) => {
    setSaving(true);
    try {
      if (invoke) {
        await Promise.all([
          invoke('save_setting', { key: 'auto_save', value: config.autoSave.toString() }),
          invoke('save_setting', { key: 'theme', value: config.theme }),
          invoke('save_setting', { key: 'theme_palette', value: config.themePalette ?? 'default' }),
          invoke('save_setting', { key: 'rag_enabled', value: config.ragEnabled.toString() }),
          invoke('save_setting', { key: 'rag_top_k', value: config.ragTopK.toString() }),
          invoke('save_setting', { key: 'anki_connect_enabled', value: config.ankiConnectEnabled.toString() }),
          invoke('save_setting', { key: 'debug_mode', value: config.debugMode.toString() }),
          // MCP 工具协议设置保存（移除全局启用项）
          invoke('save_setting', { key: 'mcp.transport.type', value: String(config.mcpTransportType || 'stdio') }),
          invoke('save_setting', { key: 'mcp.transport.command', value: config.mcpCommand }),
          invoke('save_setting', { key: 'mcp.transport.args', value: config.mcpArgs }),
          invoke('save_setting', { key: 'mcp.transport.url', value: String(config.mcpUrl || '') }),
          invoke('save_setting', { key: 'mcp.tools.advertise_all_tools', value: config.mcpAdvertiseAll.toString() }),
          invoke('save_setting', { key: 'mcp.tools.whitelist', value: config.mcpWhitelist }),
          invoke('save_setting', { key: 'mcp.tools.blacklist', value: config.mcpBlacklist }),
          invoke('save_setting', { key: 'mcp.performance.timeout_ms', value: String(config.mcpTimeoutMs ?? 15000) }),
          invoke('save_setting', { key: 'mcp.performance.rate_limit_per_second', value: String(config.mcpRateLimit ?? 10) }),
          invoke('save_setting', { key: 'mcp.performance.cache_max_size', value: String(config.mcpCacheMax ?? 500) }),
          invoke('save_setting', { key: 'mcp.performance.cache_ttl_ms', value: String(config.mcpCacheTtlMs ?? 300000) }),
          // 保存多工具配置（过滤掉内置服务器）
          invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify((normalizedMcpServers || []).filter((s: any) => s.id !== BUILTIN_SERVER_ID)) }),
          // 强制使用前端SDK模式
          invoke('save_setting', { key: 'mcp.mode', value: 'frontend' }),

          // Web Search 设置保存
          // 外部搜索保存（移除全局启用项）
          invoke('save_setting', { key: 'web_search.engine', value: (config as any).webSearchEngine ?? '' }),
          invoke('save_setting', { key: 'web_search.timeout_ms', value: String((config as any).webSearchTimeoutMs ?? 15000) }),
          invoke('save_setting', { key: 'web_search.api_key.google_cse', value: (config as any).webSearchGoogleKey ?? '' }),
          invoke('save_setting', { key: 'web_search.google_cse.cx', value: (config as any).webSearchGoogleCx ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.serpapi', value: (config as any).webSearchSerpApiKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.tavily', value: (config as any).webSearchTavilyKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.brave', value: (config as any).webSearchBraveKey ?? '' }),
          invoke('save_setting', { key: 'web_search.searxng.endpoint', value: (config as any).webSearchSearxngEndpoint ?? '' }),
          invoke('save_setting', { key: 'web_search.searxng.api_key', value: (config as any).webSearchSearxngKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.zhipu', value: (config as any).webSearchZhipuKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.bocha', value: (config as any).webSearchBochaKey ?? '' }),
          invoke('save_setting', { key: 'web_search.site_whitelist', value: (config as any).webSearchWhitelist ?? '' }),
          invoke('save_setting', { key: 'web_search.site_blacklist', value: (config as any).webSearchBlacklist ?? '' }),
          invoke('save_setting', { key: 'web_search.inject.snippet_max_chars', value: String((config as any).webSearchInjectSnippetMax ?? 180) }),
          invoke('save_setting', { key: 'web_search.inject.total_max_chars', value: String((config as any).webSearchInjectTotalMax ?? 1900) }),
      ]);
        if (!silent) {
          showGlobalNotification('success', t('settings:notifications.config_save_success'));
        }
        
        // 广播：API 配置已变更
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('api_configurations_changed'));
          }
        } catch {}

        // 触发设置变更事件，通知其他组件
        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { 
          detail: { 
            ankiConnectEnabled: config.ankiConnectEnabled,
            theme: config.theme,
            themePalette: config.themePalette,
            debugMode: config.debugMode,
            mcpChanged: true,
          } 
        }));
      } else {
        localStorage.setItem('deep-student-config', JSON.stringify(config));
        if (!silent) {
          showGlobalNotification('success', t('settings:notifications.config_save_success_browser'));
        }
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存配置失败:', error);
      if (silent) {
        showGlobalNotification('warning', t('settings:notifications.silent_save_failed'));
      } else {
        showGlobalNotification('error', t('settings:notifications.config_save_failed', { error: errorMessage }));
      }
    } finally {
      setSaving(false);
    }
  }, [config, invoke]);

  // 仅更新模型分配的某一个字段：读取后端当前 assignments 合并，再保存，避免空字段覆盖。
  const saveSingleAssignmentField = useCallback(
    async (field: keyof ModelAssignments, value: string | null) => {
      const merged: ModelAssignments = { ...modelAssignments, [field]: value };
      try {
        await persistAssignments(merged);
        return merged;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error('Save model assignment failed:', error);
        showGlobalNotification('error', t('settings:mcp.save_model_assignment_failed', { error: errorMessage }));
        throw error;
      }
    },
    [modelAssignments, persistAssignments]
  );

  // 更新标签页切换处理函数，添加动画效果
  const handleTabChange = async (newTab: string) => {
    if (!loading) {
      // 在切换标签页前先保存当前配置
      await handleSave(true);
    }
    setActiveTab(newTab);
    
    // 更新指示器位置
    updateIndicatorRaf(newTab);
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
          const left = Math.max(0, tabElement.offsetLeft + buttonsEl.offsetLeft - (buttonsEl as any).scrollLeft);
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
  function debounce(func: Function, wait: number) {
    let timeout: ReturnType<typeof setTimeout>;
    return function(...args: any[]) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  useEffect(() => {
    loadConfig();
  }, []);

  // 自动保存配置（当配置发生变化时）
  // 注意：模型分配已经在onChange中立即保存，这里主要处理其他配置项
  useEffect(() => {
    if (!loading && config.autoSave) {
      const timeoutId = setTimeout(() => {
        // 只保存API配置和通用设置，模型分配已经立即保存了
        handleSave(true); // 静默保存
      }, 1000); // 1秒后自动保存

      return () => clearTimeout(timeoutId);
    }
  }, [config.autoSave, config.theme, config.themePalette, loading, handleSave]);

  const testApiConnection = async (api: ApiConfig) => {
    if (api.isBuiltin) {
      // 内置模型同样允许测试（后端可通过 vendor_id 从安全存储读取真实密钥）
      showGlobalNotification('info', t('settings:notifications.api_test_start', { name: api.name }));
    }

    // 注意：API 密钥可能是 *** 占位符（安全遮蔽），后端会从安全存储获取真实密钥
    // 前端只检查是否完全没有配置（空字符串且没有 vendorId）
    const apiKeyTrimmed = (api.apiKey || '').trim();
    const hasVendorId = !!(api.vendorId || (api as any).vendor_id);
    
    // 如果 apiKey 是空且没有 vendorId，才报错（占位符如 *** 由后端处理）
    if (!apiKeyTrimmed && !hasVendorId) {
      showGlobalNotification('error', t('settings:notifications.api_key_required'));
      return;
    }

    if (!api.model.trim()) {
      showGlobalNotification('error', t('common:model_name_required'));
      return;
    }

    setTestingApi(api.id);

    try {
      if (invoke) {
        // 使用用户指定的模型名称进行测试
        // 传递 vendor_id 以便后端从安全存储获取真实密钥
        const vendorId = api.vendorId || (api as any).vendor_id;
        const result = await invoke('test_api_connection', {
          // 双写兼容：后端参数为 snake_case（api_key, api_base），某些桥接层可能校验 camelCase
          api_key: api.apiKey,
          apiKey: api.apiKey,
          api_base: api.baseUrl,
          apiBase: api.baseUrl,
          model: api.model, // 传递用户指定的模型名称
          vendor_id: vendorId, // 传递供应商 ID 以便后端获取真实密钥
          vendorId: vendorId,
        });
        
        if (result) {
          showGlobalNotification('success', t('settings:notifications.api_test_success', { name: api.name, model: api.model }));
        } else {
          showGlobalNotification('error', t('settings:notifications.api_test_failed', { name: api.name, model: api.model }));
        }
      } else {
        // 浏览器环境模拟
        await new Promise(resolve => setTimeout(resolve, 2000));
        showGlobalNotification('success', t('settings:notifications.api_test_success_mock', { name: api.name }));
      }
    } catch (error) {
      console.error('连接测试失败:', error);
      console.log('🔍 [前端调试] API配置:', {
        name: api.name,
        baseUrl: api.baseUrl,
        model: api.model,
        modelAdapter: (api as any).modelAdapter || 'unknown',
        apiKeyLength: api.apiKey.length,
        vendorId: api.vendorId || (api as any).vendor_id,
      });
      
      // 提取更详细的错误信息
      let errorMessage = '';
      if (typeof error === 'string') {
        errorMessage = error;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        errorMessage = JSON.stringify(error, null, 2);
      } else {
        errorMessage = String(error);
      }
      
      console.error('🔍 [前端调试] 详细错误信息:', errorMessage);
      showGlobalNotification('error', t('settings:notifications.api_test_error', { name: api.name, error: errorMessage }));
    } finally {
      setTestingApi(null);
    }
  };

  const ensureVendorForConfig = useCallback(
    async (configData: Omit<ApiConfig, 'id'>) => {
      const normalizedBase = normalizeBaseUrl(configData.baseUrl || '');
      const normalizedKey = (configData.apiKey || '').trim();
      const providerType = providerTypeFromConfig(configData.providerType, configData.modelAdapter);
      const existing =
        vendors.find(
          vendor =>
            normalizeBaseUrl(vendor.baseUrl || '') === normalizedBase &&
            (vendor.providerType === providerType || (!vendor.providerType && providerType === 'openai'))
        ) ?? null;
      if (existing) {
        let needsUpdate = false;
        const updated: VendorConfig = { ...existing };
        if (normalizedKey && normalizedKey !== (existing.apiKey || '').trim()) {
          updated.apiKey = normalizedKey;
          needsUpdate = true;
        }
        if (configData.vendorName && configData.vendorName !== existing.name) {
          updated.name = configData.vendorName;
          needsUpdate = true;
        }
        if (needsUpdate) {
          return upsertVendor(updated);
        }
        return existing;
      }
      const newVendor: VendorConfig = {
        id: '',
        name: configData.vendorName || configData.name || `${providerType.toUpperCase()} Vendor`,
        providerType,
        baseUrl: configData.baseUrl,
        apiKey: configData.apiKey,
        headers: (configData.headers as Record<string, string>) ?? {},
        rateLimitPerMinute: undefined,
        defaultTimeoutMs: undefined,
        notes: undefined,
        isBuiltin: false,
        isReadOnly: false,
      };
      return upsertVendor(newVendor);
    },
    [upsertVendor, vendors]
  );

  const maskApiKey = (key?: string | null) => {
    if (!key) return '***';
    const length = key.length;
    if (length <= 6) {
      return `${'*'.repeat(Math.max(length - 2, 0))}${key.slice(-2)}`;
    }
    return `${key.slice(0, 3)}****${key.slice(-3)}`;
  };

  const getProviderDisplayName = useCallback(
    (providerType?: string | null) =>
      t(`settings:vendor_modal.providers.${providerType ?? 'openai'}`, {
        defaultValue: providerType ?? 'openai',
      }),
    [t]
  );

  const handleOpenVendorModal = (vendor?: VendorConfig | null) => {
    if (!vendor) {
      void (async () => {
        try {
          const created = await upsertVendor({
            id: '',
            name: t('settings:vendor_panel.default_new_vendor_name'),
            providerType: 'custom',
            baseUrl: '',
            apiKey: '',
            headers: {},
            rateLimitPerMinute: undefined,
            defaultTimeoutMs: undefined,
            notes: '',
            isBuiltin: false,
            isReadOnly: false,
            sortOrder: vendors.length,
          });
          setSelectedVendorId(created.id);
          setVendorFormData({
            ...created,
            headers: created.headers || {},
          });
          setIsEditingVendor(true);
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
        }
      })();
      return;
    }
    setEditingVendor(vendor ?? null);
    setVendorModalOpen(true);
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('vendorConfig');
      setScreenPosition('right');
    }
  };

  const handleStartEditVendor = (vendor: VendorConfig) => {
    setVendorFormData({
      ...vendor,
      headers: vendor.headers || {},
    });
    setIsEditingVendor(true);
  };

  const handleCancelEditVendor = () => {
    setIsEditingVendor(false);
    setVendorFormData({});
  };

  const handleSaveEditVendor = async () => {
    try {
      if (!vendorFormData.name?.trim()) {
        showGlobalNotification('error', t('settings:vendor_modal.validation_name'));
        return;
      }
      if (!vendorFormData.baseUrl?.trim()) {
        showGlobalNotification('error', t('settings:vendor_modal.validation_base_url'));
        return;
      }

      const saved = await upsertVendor({
        ...selectedVendor!,
        ...vendorFormData,
        id: selectedVendor!.id,
      } as VendorConfig);
      setIsEditingVendor(false);
      setVendorFormData({});
      setSelectedVendorId(saved.id);
      showGlobalNotification('success', t('common:config_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
    }
  };

  const handleSaveVendorModal = async (vendorData: VendorConfig) => {
    try {
      const saved = await upsertVendor(vendorData);
      setVendorModalOpen(false);
      setEditingVendor(null);
      setSelectedVendorId(saved.id);
      // 移动端：关闭右侧面板
      if (isSmallScreen) {
        closeRightPanel();
      }
      showGlobalNotification('success', t('common:config_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_save_failed', { error: errorMessage }));
    }
  };

  const handleDeleteVendor = (vendor: VendorConfig) => {
    if (vendor.isBuiltin) {
      showGlobalNotification('error', t('settings:vendor_panel.cannot_delete_builtin'));
      return;
    }
    setVendorDeleteDialog(vendor);
  };

  const handleSaveVendorApiKey = async (vendorId: string, apiKey: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, apiKey };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(errorMessage);
    }
  };

  const handleSaveVendorBaseUrl = async (vendorId: string, baseUrl: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, baseUrl };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存接口地址失败:', errorMessage);
      showGlobalNotification('error', t('settings:vendor_panel.base_url_save_failed'));
    }
  };

  const handleClearVendorApiKey = async (vendorId: string) => {
    try {
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor) {
        throw new Error(t('settings:mcp.vendor_not_found'));
      }
      const updated = { ...vendor, apiKey: '' };
      await upsertVendor(updated);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(errorMessage);
    }
  };

  const handleReorderVendors = async (reorderedVendors: VendorConfig[]) => {
    try {
      // 更新所有供应商的 sortOrder
      const updatedVendors = reorderedVendors.map((v, index) => ({
        ...v,
        sortOrder: index,
      }));
      await persistVendors(updatedVendors);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存供应商排序失败:', errorMessage);
      showGlobalNotification('error', t('settings:vendor_panel.reorder_failed'));
    }
  };

  const confirmDeleteVendor = async () => {
    if (!vendorDeleteDialog) return;
    try {
      await deleteVendor(vendorDeleteDialog.id);
      showGlobalNotification('success', t('settings:notifications.vendor_deleted'));
      if (selectedVendorId === vendorDeleteDialog.id) {
        setSelectedVendorId(null);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.vendor_delete_failed', { error: errorMessage }));
    } finally {
      setVendorDeleteDialog(null);
    }
  };

  const handleOpenModelEditor = (vendor: VendorConfig, profile?: ModelProfile) => {
    const baseAdapter = providerTypeFromConfig(vendor.providerType, vendor.providerType);
    const isGeneralAdapter = baseAdapter === 'general';
    const draftApi: ApiConfig = profile
      ? convertProfileToApiConfig(profile, vendor)
      : {
          id: `model_${Date.now()}`,
          name: `${vendor.name} Model`,
          vendorId: vendor.id,
          vendorName: vendor.name,
          providerType: vendor.providerType,
          apiKey: vendor.apiKey ?? '',
          baseUrl: vendor.baseUrl,
          model: '',
          isMultimodal: false,
          isReasoning: false,
          isEmbedding: false,
          isReranker: false,
          enabled: true,
          modelAdapter: baseAdapter,
          maxOutputTokens: 8192,
          temperature: 0.7,
          supportsTools: true,
          geminiApiVersion: 'v1',
          isBuiltin: false,
          isReadOnly: profile?.isBuiltin ?? false,
          reasoningEffort: undefined,
          thinkingEnabled: false,
          thinkingBudget: undefined,
          includeThoughts: false,
          enableThinking: false,
          minP: isGeneralAdapter ? GENERAL_DEFAULT_MIN_P : undefined,
          topK: isGeneralAdapter ? GENERAL_DEFAULT_TOP_K : undefined,
          supportsReasoning: false,
          headers: vendor.headers,
        };
    setModelEditor({ vendor, profile, api: draftApi });
  };

  const handleSaveModelProfile = async (api: ApiConfig) => {
    if (!modelEditor) return;
    const vendor = modelEditor.vendor;
    const toSave = convertApiConfigToProfile(api, vendor.id);
    toSave.enabled = api.enabled;
    toSave.status = api.enabled ? 'enabled' : 'disabled';
    try {
      await upsertModelProfile(toSave);
      showGlobalNotification('success', t('common:config_saved'));
      setModelEditor(null);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  // 内联编辑保存处理（用于卡片展开编辑）
  const handleSaveInlineEdit = async (api: ApiConfig) => {
    if (!selectedVendor) return;
    const toSave = convertApiConfigToProfile(api, selectedVendor.id);
    toSave.enabled = api.enabled;
    toSave.status = api.enabled ? 'enabled' : 'disabled';
    try {
      await upsertModelProfile(toSave);
      showGlobalNotification('success', t('common:config_saved'));
      setInlineEditState(null);
      setIsAddingNewModel(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  // 桌面端内联新增模型
  const handleAddModelInline = (vendor: VendorConfig) => {
    const baseAdapter = providerTypeFromConfig(vendor.providerType, vendor.providerType);
    const isGeneralAdapter = baseAdapter === 'general';
    const tempId = `new_model_${Date.now()}`;
    const draftApi: ApiConfig = {
      id: tempId,
      name: `${vendor.name} Model`,
      vendorId: vendor.id,
      vendorName: vendor.name,
      providerType: vendor.providerType,
      apiKey: vendor.apiKey ?? '',
      baseUrl: vendor.baseUrl,
      model: '',
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
      enabled: true,
      modelAdapter: baseAdapter,
      maxOutputTokens: 8192,
      temperature: 0.7,
      supportsTools: true,
      geminiApiVersion: 'v1',
      isBuiltin: false,
      isReadOnly: false,
      reasoningEffort: undefined,
      thinkingEnabled: false,
      thinkingBudget: undefined,
      includeThoughts: false,
      enableThinking: false,
      minP: isGeneralAdapter ? GENERAL_DEFAULT_MIN_P : undefined,
      topK: isGeneralAdapter ? GENERAL_DEFAULT_TOP_K : undefined,
      supportsReasoning: false,
      headers: vendor.headers,
    };
    setInlineEditState({ profileId: tempId, api: draftApi });
    setIsAddingNewModel(true);
  };

  // ===== 移动端三屏布局相关 hooks =====
  // 关闭右侧面板的通用函数
  const closeRightPanel = useCallback(() => {
    setRightPanelType('none');
    setScreenPosition('center');
  }, []);

  // 当打开编辑器时自动切换到右侧面板
  useEffect(() => {
    if (isSmallScreen && modelEditor) {
      setRightPanelType('modelEditor');
      setScreenPosition('right');
    }
  }, [isSmallScreen, modelEditor]);

  // 关闭编辑器时返回中间视图
  const handleCloseModelEditor = useCallback(() => {
    setModelEditor(null);
    if (isSmallScreen) {
      closeRightPanel();
    }
  }, [isSmallScreen, closeRightPanel]);

  // 保存模型配置后关闭编辑器
  const handleSaveModelProfileAndClose = useCallback(async (api: ApiConfig) => {
    await handleSaveModelProfile(api);
    handleCloseModelEditor();
  }, [handleSaveModelProfile, handleCloseModelEditor]);

  const handleDeleteModelProfile = (profile: ModelProfile) => {
    if (profile.isBuiltin) {
      showGlobalNotification('error', t('settings:common_labels.builtin_cannot_delete'));
      return;
    }
    const referencingKeys = (Object.keys(modelAssignments) as Array<keyof ModelAssignments>).filter(
      key => modelAssignments[key] === profile.id
    );
    setModelDeleteDialog({ profile, referencingKeys });
  };

  const confirmDeleteModelProfile = async () => {
    if (!modelDeleteDialog) return;
    const { profile, referencingKeys } = modelDeleteDialog;
    try {
      if (referencingKeys.length > 0) {
        const clearedAssignments: ModelAssignments = { ...modelAssignments };
        referencingKeys.forEach(key => {
          clearedAssignments[key] = null;
        });
        await persistAssignments(clearedAssignments);
      }
      await deleteModelProfile(profile.id);
      showGlobalNotification('success', t('settings:notifications.api_deleted'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.api_delete_failed', { error: errorMessage }));
    } finally {
      setModelDeleteDialog(null);
    }
  };

  const handleToggleModelProfile = async (profile: ModelProfile, enabled: boolean) => {
    try {
      await upsertModelProfile({
        ...profile,
        enabled,
        status: enabled ? 'enabled' : 'disabled',
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  };

  const handleToggleFavorite = useCallback(async (profile: ModelProfile) => {
    try {
      await upsertModelProfile({
        ...profile,
        isFavorite: !profile.isFavorite,
      });
      // 收藏操作不再显示toast，避免打扰用户
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
    }
  }, [upsertModelProfile, t]);

  const handleSiliconFlowConfig = async (configData: Omit<ApiConfig, 'id'>): Promise<string | null> => {
    try {
      const vendor = await ensureVendorForConfig(configData);
      const newProfile = convertApiConfigToProfile(
        { ...configData, id: `sf_${Date.now()}` } as ApiConfig,
        vendor.id
      );
      newProfile.enabled = configData.enabled ?? true;
      newProfile.status = newProfile.enabled ? 'enabled' : 'disabled';
      const saved = await upsertModelProfile(newProfile);
      return saved.id;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
      return null;
    }
  };

  // 获取所有启用的对话模型，支持包含当前已分配但被禁用的模型
  const getAllEnabledApis = (currentValue?: string) => {
    const enabledApis = config.apiConfigs.filter(api => api.enabled && !api.isEmbedding && !api.isReranker);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && !api.isEmbedding && !api.isReranker);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 获取嵌入模型，支持包含当前已分配但被禁用的模型
  const getEmbeddingApis = (currentValue?: string) => {
    // 只返回嵌入模型，不包含重排序模型（优先级：isEmbedding 且非 isReranker）
    const enabledApis = config.apiConfigs.filter(api => api.enabled && api.isEmbedding === true && api.isReranker !== true);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && api.isEmbedding === true && api.isReranker !== true);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 获取重排序模型，支持包含当前已分配但被禁用的模型
  const getRerankerApis = (currentValue?: string) => {
    // 只返回重排序模型（优先级：isReranker）
    const enabledApis = config.apiConfigs.filter(api => api.enabled && api.isReranker === true);
    if (currentValue && !enabledApis.some(api => api.id === currentValue)) {
      const disabledApi = config.apiConfigs.find(api => api.id === currentValue && api.isReranker === true);
      if (disabledApi) {
        return [...enabledApis, { ...disabledApi, _isDisabledInList: true }];
      }
    }
    return enabledApis;
  };

  // 转换 ApiConfig 到 UnifiedModelInfo 格式
  const toUnifiedModelInfo = (apis: (ApiConfig & { _isDisabledInList?: boolean })[]): UnifiedModelInfo[] => {
    return apis.map(api => ({
      id: api.id,
      name: api.name,
      model: api.model,
      isMultimodal: api.isMultimodal,
      isReasoning: api.isReasoning,
      isDisabled: api._isDisabledInList || false,
      isFavorite: api.isFavorite || false,
    }));
  };

  // 批量创建硅基流动配置，一次性保存多条
  const handleBatchCreateConfigs = async (
    configs: Array<Omit<ApiConfig, 'id'> & { tempId: string }>
  ): Promise<{ success: boolean; idMap: { [tempId: string]: string } }> => {
    const idMap: { [tempId: string]: string } = {};
    try {
      let nextProfiles = [...modelProfiles];
      let changed = false;
      for (const configItem of configs) {
        const vendor = await ensureVendorForConfig(configItem);
        const normalizedModel = configItem.model.trim().toLowerCase();
        const existingProfile = nextProfiles.find(
          profile =>
            profile.vendorId === vendor.id && profile.model.trim().toLowerCase() === normalizedModel
        );
        if (existingProfile) {
          idMap[configItem.tempId] = existingProfile.id;
          continue;
        }
        const profile = convertApiConfigToProfile(
          { ...configItem, id: configItem.tempId } as ApiConfig,
          vendor.id
        );
        profile.enabled = configItem.enabled ?? true;
        profile.status = profile.enabled ? 'enabled' : 'disabled';
        nextProfiles = nextProfiles.filter(mp => mp.id !== profile.id);
        nextProfiles.push(profile);
        idMap[configItem.tempId] = profile.id;
        changed = true;
      }
      if (changed) {
        await persistModelProfiles(nextProfiles);
      }
      return { success: true, idMap };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.model_save_failed', { error: errorMessage }));
      return { success: false, idMap };
    }
  };
  // 应用模型分配预设封装逻辑
  const handleApplyPreset = async (assignments: ModelAssignments) => {
    try {
      const merged: ModelAssignments = { ...modelAssignments };
      (Object.keys(assignments) as Array<keyof ModelAssignments>).forEach(key => {
        const value = assignments[key];
        if (value !== null && value !== undefined && value !== '') {
          merged[key] = value;
        }
      });
      await persistAssignments(merged);
      showGlobalNotification('success', t('settings:mcp_descriptions.preset_applied_saved'));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('应用预设失败:', error);
      showGlobalNotification('error', t('settings:messages.preset_apply_failed', { error: errorMessage }));
    }
  };

  // 批量创建完成后，自动更新模型分配
  const handleBatchConfigsCreated = (mapping: { [key: string]: string }) => {
    const assignments: ModelAssignments = {
      model2_config_id: mapping[t('settings:mapping_keys.model2_configured')] || null,
      anki_card_model_config_id: mapping[t('settings:mapping_keys.anki_configured')] || null,
      qbank_ai_grading_model_config_id: mapping[t('settings:mapping_keys.qbank_ai_grading_configured')] || null,
      // 嵌入模型通过维度管理设置，不在此处分配
      embedding_model_config_id: null,
      reranker_model_config_id: mapping[t('settings:mapping_keys.reranker_configured')] || null,
      chat_title_model_config_id: mapping[t('settings:mapping_keys.chat_title_configured')] || null,
      exam_sheet_ocr_model_config_id: mapping[t('settings:mapping_keys.exam_sheet_ocr_configured')] || null,
      translation_model_config_id: mapping[t('settings:mapping_keys.translation_configured')] || null,
      question_parsing_model_config_id: mapping[t('settings:mapping_keys.question_parsing_configured')] || null,
      // 多模态知识库模型（嵌入模型通过维度管理设置）
      vl_embedding_model_config_id: null,
      vl_reranker_model_config_id: null,
    };
    handleApplyPreset(assignments);
  };
  // 设置页内 MCP 错误呈现
  // Hooks 必须在每次渲染按相同顺序调用；
  // 将此 Hook 前置，避免被下方的 early-return 跳过导致顺序变化。
  const { errors: mcpErrors, addError: addMcpError, dismissError: dismissMcpError, clearAllErrors: clearMcpErrors } = useUnifiedErrorHandler();

  if (loading) {
    // 加载状态使用与正常状态一致的布局结构，避免布局闪烁
    return (
      <div className="settings absolute inset-0 flex flex-row overflow-hidden bg-background">
        <MacTopSafeDragZone className="settings-top-safe-drag-zone" />
        
        {/* 骨架屏侧边栏 */}
        <div className="h-full flex flex-col bg-background pt-[5px] border-r border-border/40 w-52">
          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {/* 骨架屏导航项 */}
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg">
                <div className="w-4 h-4 rounded bg-muted animate-pulse" />
                <div className="h-4 rounded bg-muted animate-pulse flex-1" />
              </div>
            ))}
          </nav>
          {/* 底部收起按钮骨架 */}
          <div className="shrink-0 h-11 flex items-center justify-center px-2 border-t border-border">
            <div className="w-4 h-4 rounded bg-muted/50 animate-pulse" />
          </div>
        </div>
        
        {/* 骨架屏主内容区 */}
        <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-background">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-muted-foreground">{t('settings:loading')}</div>
          </div>
        </div>
      </div>
    );
  }
  // 检查键是否为敏感键
  const isSensitiveKey = (key: string): boolean => {
    const sensitivePatterns = [
      'web_search.api_key.',
      'api_configs',
      'mcp.transport.',
      '.api_key',
      '.secret',
      '.password',
      '.token'
    ];
    return sensitivePatterns.some(pattern => key.includes(pattern));
  };
  // 简易密码输入带明文切换
  const PasswordInputWithToggle: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string; widthClass?: string }>
    = ({ value, onChange, placeholder, widthClass }) => {
    const [show, setShow] = useState(false);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className={`${widthClass || 'w-80'} rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent`}
            />
        <NotionButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShow(s => !s)}
          title={show ? t('common:actions.hide') : t('common:actions.show')}
        >{show ? t('common:actions.hide') : t('common:actions.show')}</NotionButton>
      </div>
    );
  };

  // 渲染侧边栏内容 - 提取为独立组件
  const renderSettingsSidebar = () => (
    <SettingsSidebar
      isSmallScreen={isSmallScreen}
      globalLeftPanelCollapsed={globalLeftPanelCollapsed}
      sidebarSearchQuery={sidebarSearchQuery}
      setSidebarSearchQuery={setSidebarSearchQuery}
      sidebarSearchFocused={sidebarSearchFocused}
      setSidebarSearchFocused={setSidebarSearchFocused}
      settingsSearchIndex={settingsSearchIndex}
      sidebarNavItems={sidebarNavItems}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      setSidebarOpen={setSidebarOpen}
    />
  );

  // 渲染主内容区域
  const renderSettingsMainContent = () => (
    <div id="settings-main-content" className="flex-1 min-w-0 h-full flex flex-col overflow-hidden max-w-full bg-background relative">
        <CustomScrollArea className="flex-1 w-full max-w-full overflow-x-hidden" viewportClassName={cn("px-8 py-6 lg:px-10", isSmallScreen && "px-4 py-3 pb-20")} trackOffsetTop={16} trackOffsetBottom={16} trackOffsetRight={0} style={{ textAlign: 'left' }}>
          <div>
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
            isSmallScreen={isSmallScreen}
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
          <NotionDialogBody nativeScroll>
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
                        {mcpPreview.tools.map((tool: any, index: number) => {
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
                        {mcpPreview.prompts.map((prompt: any, index: number) => (
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
                        {mcpPreview.resources.map((res: any, index: number) => (
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
            <DataGovernanceDashboard />
          </div>
        )}
        {/* 应用设置 */}
        {/* 应用设置 */}
        {activeTab === 'app' && (
          <AppTab
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
            themePalette={themePalette}
            setThemePalette={setThemePalette}
            customColor={customColor}
            setCustomColor={setCustomColor}
            topbarTopMargin={topbarTopMargin}
            setTopbarTopMargin={setTopbarTopMargin}
            logTypeForOpen={logTypeForOpen}
            setLogTypeForOpen={setLogTypeForOpen}
            showRawRequest={showRawRequest}
            setShowRawRequest={setShowRawRequest}
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
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={mcpPolicyModal.advertiseAll}
                    onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, advertiseAll: e.target.checked }))}
                  />
                  {t('settings:mcp_policy.advertise_all')}
                </label>
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                  {t('settings:mcp_policy.whitelist_mode_hint')}
                </div>

                {!mcpPolicyModal.advertiseAll && (
                  <>
                    <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.whitelist_label')}</label>
                    <input
                      type="text"
                      value={mcpPolicyModal.whitelist}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, whitelist: e.target.value }))}
                      placeholder="read_file, write_file, list_directory"
                      className="bg-background text-foreground placeholder:text-muted-foreground"
                      style={{ padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
                    />
                  </>
                )}

                <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.blacklist_label')}</label>
                <input
                  type="text"
                  value={mcpPolicyModal.blacklist}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, blacklist: e.target.value }))}
                  placeholder="delete_file, execute_command, rm, sudo"
                  className="bg-background text-foreground placeholder:text-muted-foreground"
                  style={{ padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
                />
                <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>{t('settings:mcp_policy.danger_hint')}</div>

                <div className="two-col-grid">
                  <div>
                    <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.timeout_label')}</label>
                    <input
                      type="number"
                      min={1000}
                      value={mcpPolicyModal.timeoutMs}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
                      className="bg-background text-foreground placeholder:text-muted-foreground"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.rate_limit_label')}</label>
                    <input
                      type="number"
                      min={1}
                      value={mcpPolicyModal.rateLimit}
                      onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
                      className="bg-background text-foreground placeholder:text-muted-foreground"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.cache_max_label')}</label>
                    <input
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
                      className="bg-background text-foreground placeholder:text-muted-foreground"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'hsl(var(--foreground))' }}>{t('settings:mcp_policy.cache_ttl_label')}</label>
                    <input
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
                      className="bg-background text-foreground placeholder:text-muted-foreground"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid hsl(var(--border))', borderRadius: 6 }}
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
              paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
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

  if (isSmallScreen) {
    return (
      <div className="settings absolute inset-0 flex flex-col overflow-hidden bg-background">
        <MacTopSafeDragZone className="settings-top-safe-drag-zone" />
        <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />

        <MobileSlidingLayout
          sidebar={
            <div
              className="h-full flex flex-col bg-background"
              style={{
                paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
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
              <Layers className="h-5 w-5" />
              {t('acknowledgements.ui_components.app_menu')}
            </NotionDialogTitle>
            <NotionDialogDescription>
              {t('acknowledgements.ui_components.app_menu_desc')}
            </NotionDialogDescription>
          </NotionDialogHeader>
          <NotionDialogBody nativeScroll>
            <AppMenuDemo />
          </NotionDialogBody>
        </NotionDialog>
      </div>
    );
  }

  // ===== 桌面端布局 =====
  return (
    <div className="settings absolute inset-0 flex flex-row overflow-hidden bg-background">
      <MacTopSafeDragZone className="settings-top-safe-drag-zone" />
      <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />

      {/* 侧边栏 */}
      {renderSettingsSidebar()}

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
            <Layers className="h-5 w-5" />
            {t('acknowledgements.ui_components.app_menu')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('acknowledgements.ui_components.app_menu_desc')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>
          <AppMenuDemo />
        </NotionDialogBody>
      </NotionDialog>
    </div>
  );
};
