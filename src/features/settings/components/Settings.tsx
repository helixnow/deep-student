import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useState, useEffect, useRef, useMemo, useId, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/settings.css';
import '../styles/api-config-section.css';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody } from '@/components/ui/DsDialog';
import UnifiedErrorHandler from '@/components/UnifiedErrorHandler';
import { AppMenuDemo } from '@/components/ui/app-menu';
import { Stack } from '@phosphor-icons/react';
import { MacTopSafeDragZone } from '@/components/layout/MacTopSafeDragZone';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { ShellViewSwitch } from '@/components/ui/ShellViewSwitch';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { useVendorModels } from '@/hooks/useVendorModels';
import { consumePendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { isMobilePlatform } from '@/utils/platform';
import '@/command-palette/styles/shortcut-settings.css';
import type { AutomationListen } from './automationSettingsApi';
import { useSlot } from '@/ui-kernel/react';
import type { SettingsSection, SettingsSectionPropsFactories } from '@/ui-kernel/contracts/settings';
import { settingsNavigation } from '@/ui-plugins/official/settings/navigation';
import { SettingsMobileNavigation } from './SettingsMobileNavigation';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { APP_EVENTS, useAppEvent } from '@/events';
import { convertProfileToApiConfig } from './modelConverters';
import type { SystemConfig, SettingsProps } from './types';
import type { SettingsExtra, McpToolConfig } from './hookDepsTypes';
import type { McpStatusInfo } from '@/mcp/mcpService';
import type { VendorConfigModalRef } from './VendorConfigModal';
import { getBuiltinServer, BUILTIN_SERVER_ID } from '@/mcp/builtinMcpServer';
import { useSettingsVendorState } from './useSettingsVendorState';
import { useMcpEditorSection } from './McpEditorSection';
import { useSettingsConfig } from './useSettingsConfig';
import { createDefaultSystemConfig } from './settingsConfigDefaults';
import { useSettingsAppearanceSection } from './useSettingsAppearanceSection';
import { useSettingsGeneralSection } from './useSettingsGeneralSection';
import { useSettingsParamsSection } from './useSettingsParamsSection';
import { useSettingsConfigSources } from './useSettingsConfigSources';
import { useSettingsMcpBootstrap } from './useSettingsMcpBootstrap';
import { useSettingsMcpPreviewPanel } from './useSettingsMcpPreviewPanel';
import { useSettingsMobileShell } from './useSettingsMobileShell';
import { useSettingsMobileHeaderContent } from './useSettingsMobileHeaderContent';
import { useSettingsPanelDismiss } from './useSettingsPanelDismiss';
import { useSettingsTabIndicator } from './useSettingsTabIndicator';
import { SettingsMainContent } from './SettingsMainContent';
import { SettingsMobileRightPanel } from './SettingsMobileRightPanel';
import { SettingsDesktopDialogs } from './SettingsDesktopDialogs';
import { SettingsMobileLoadingSkeleton } from './SettingsMobileLoadingSkeleton';
import { resolveVoiceInputModelAssignment } from '@/voice-input/modelSelection';
// Tauri 2.x API导入
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE: React.CSSProperties = {
  background: 'var(--shell-workspace-panel)',
  borderBottom: 0,
};

// Tauri类型声明
declare global {
  interface Window {
    __TAURI_INTERNALS__?: any;
  }
}

// 检查是否在Tauri环境中
const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

export const Settings: React.FC<SettingsProps> = ({ onBack, isActive = true }) => {
  const { t } = useTranslation(['settings', 'common']);
  const { t: navigationT } = useTranslation(['settings', 'common', 'data', 'workbench']);
  const sectionEntries = useSlot<SettingsSection>('settings.sections');
  const isMobile = isMobilePlatform();
  const { isSmallScreen } = useBreakpoint();
  // 移动端设置以全屏 sheet 承载；桌面端继续使用独立工作区页面。
  const effectiveMobilePanelMode = isSmallScreen;
  const isTauriEnvironment = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

  // 移动端 Sheet header 标题（面包屑）所需状态
  // 获取当前标签页的显示名称（需要在 useMobileHeader 之前定义）
  const activeTab = useSettingsShellStore((state) => state.activeTab);
  const setActiveTab = useSettingsShellStore((state) => state.setActiveTab);
  const dataGovernanceTabTarget = useSettingsShellStore((state) => state.dataGovernanceTabTarget);
  const applySettingsRoute = useSettingsShellStore((state) => state.applySettingsRoute);
  const [settingsScrollElement, setSettingsScrollElement] = useState<HTMLDivElement | null>(null);

  const [config, setConfig] = useState<SystemConfig>(createDefaultSystemConfig);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // 🔧 修复：防止 loadConfig 失败时 auto-save 用空默认值覆写后端已有配置
  const configLoadedRef = useRef(false);
  const [extra, setExtra] = useState<SettingsExtra>({});
  const [showAppMenuDemo, setShowAppMenuDemo] = useState(false);
  // 供应商配置 Modal ref（用于移动端顶栏保存按钮调用）
  const vendorConfigModalRef = useRef<VendorConfigModalRef>(null);
  // MCP 连接状态快照（useMcpEditorSection 只读，订阅在 useSettingsMcpBootstrap）
  const [mcpStatusInfo, setMcpStatusInfo] = useState<McpStatusInfo | null>(null);
  const isMcpLoading = activeTab === 'mcp' && loading;

  const { sidebarCategories, sidebarNavItems, settingsSearchIndex } = useMemo(
    () => settingsNavigation(sectionEntries, navigationT, { isMobile }),
    [sectionEntries, navigationT, isMobile],
  );
  const activeSectionEntry = sectionEntries.find((entry) => entry.key === activeTab);
  // Keep legacy section IDs as the single navigation source of truth.
  const activeCategory = sidebarCategories.find((category) => category.items.some((item) => item.value === activeTab));
  const settingsNavigationId = useId();
  // 当前分区的导航项（分区内容态顶栏标题用）
  const activeNavItem = useMemo(
    () => sidebarNavItems.find((item) => item.value === activeTab) ?? null,
    [sidebarNavItems, activeTab]
  );

  // ========== 分区自包含状态（各 hook 只服务一个分区/一件事） ==========
  const {
    uiZoom, zoomLoading, zoomSaving, zoomStatus, handleZoomChange, handleZoomReset,
    uiFont, fontLoading, fontSaving, handleFontChange, handleFontReset,
    uiFontSize, fontSizeLoading, fontSizeSaving, handleFontSizeChange, handleFontSizeReset,
    themeMode, isSystemDark, setThemeMode, themePalette, setThemePalette, customColor, setCustomColor,
    normalizedMcpServers,
  } = useSettingsAppearanceSection({ t, config, isTauriEnvironment });
  const {
    topbarTopMargin, topbarTopMarginLoaded, setTopbarTopMargin,
    logTypeForOpen, setLogTypeForOpen, showRawRequest, setShowRawRequest,
  } = useSettingsGeneralSection({ invoke });

  const {
    vendors,
    modelProfiles,
    modelAssignments,
    resolvedApiConfigs,
    openAICodexAuthenticated,
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

  // 供应商/模型配置变更时从后端刷新 ApiConfig 列表（单一事实来源），
  // 并同步模型分配/主题/MCP 工具列表到 config。
  const refreshApiConfigsFromBackend = useSettingsConfigSources({ config, setConfig, modelAssignments, themeMode, themePalette });

  const updateIndicatorRaf = useSettingsTabIndicator({ loading, activeTab });

  const { loadConfig, handleSave, saveSingleAssignmentField } = useSettingsConfig({ setLoading, configLoadedRef, setExtra, setActiveTab, activeTab, modelAssignments, vendors, modelProfiles, resolvedApiConfigs, refreshVendors: undefined, refreshProfiles: undefined, refreshApiConfigsFromBackend, persistAssignments, saving, setSaving, t, config, setConfig, loading, updateIndicatorRaf });

  const { handleSaveChatStreamTimeout, handleToggleChatStreamAutoCancel } = useSettingsParamsSection({ extra, setExtra, invoke, t });

  const shell = useSettingsMobileShell({ isSmallScreen, isActive, activeTab, handleSave, loading, configLoadedRef, onBack });
  const {
    screenPosition, rightPanelType, setRightPanelType,
    mobileNavView, setMobileNavView, mobileSearchQuery, setMobileSearchQuery,
    mobileVendorDetailOpen, setMobileVendorDetailOpen,
    closeRightPanel, handleMobileHeaderBack,
  } = shell;

  const vendorState = useSettingsVendorState({ resolvedApiConfigs, vendorLoading, vendorSaving, vendors, modelProfiles, modelAssignments, config, t, loading, upsertVendor, upsertModelProfile, deleteModelProfile, persistAssignments, persistModelProfiles, persistVendors, closeRightPanel, refreshVendors: undefined, refreshProfiles: undefined, refreshApiConfigsFromBackend, isSmallScreen: effectiveMobilePanelMode, setScreenPosition: shell.setScreenPosition, setRightPanelType, activeTab, deleteVendorById: deleteVendor });
  const { selectedVendorId, setSelectedVendorId, vendorModalOpen, setVendorModalOpen, editingVendor, setEditingVendor, isEditingVendor, vendorFormData, setVendorFormData, modelEditor, setModelEditor, inlineEditState, setInlineEditState, isAddingNewModel, setIsAddingNewModel, modelDeleteDialog, setModelDeleteDialog, vendorDeleteDialog, setVendorDeleteDialog, testingApi, vendorBusy, sortedVendors, selectedVendor, selectedVendorModels, profileCountByVendor, selectedVendorIsSiliconflow, testApiConnection, handleOpenVendorModal, handleStartEditVendor, handleCancelEditVendor, handleSaveEditVendor, handleSaveVendorModal, handleDeleteVendor, handleSaveVendorApiKey, handleSaveVendorBaseUrl, handleReorderVendors, confirmDeleteVendor, handleOpenModelEditor, handleSaveModelProfile, handleSaveInlineEdit, handleAddModelInline, handleCloseModelEditor, handleSaveModelProfileAndClose, handleDeleteModelProfile, confirmDeleteModelProfile, handleToggleModelProfile, handleToggleFavorite, handleSiliconFlowConfig, handleAddVendorModels, getAllEnabledApis, getEmbeddingApis, getRerankerApis, getAsrApis, getImageGenerationApis, toUnifiedModelInfo, handleBatchCreateConfigs, handleApplyPreset, handleBatchConfigsCreated, handleClearVendorApiKey, triggerPostSaveAutoFlow, isSensitiveKey, maskApiKey, apiConfigsForApisTab } = vendorState;

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

  const mcpSection = useMcpEditorSection({ config, setConfig, isSmallScreen: effectiveMobilePanelMode, activeTab, setActiveTab, setScreenPosition: shell.setScreenPosition, setRightPanelType, t, extra, setExtra, handleSave, normalizedMcpServers, setMcpStatusInfo, mcpStatusInfo });
  const { mcpToolModal, setMcpToolModal, mcpPolicyModal, setMcpPolicyModal, mcpToolSubmitRef, mcpPolicySaveRef, mcpPreview, mcpTestStep, stripMcpPrefix, refreshSnapshots, handleDeleteMcpTool, handleSaveMcpServer, handleTestServer, handleReconnectClient, handleAddMcpTool, handleCreateMcpTool, handleEditMcpTool, handleOpenMcpPolicy, handleClosePreview, renderMcpToolEditor, renderMcpToolEditorEmbedded, renderMcpPolicyEditorEmbedded, mcpCachedDetails, mcpServers, serverStatusMap, lastError, cacheCapacity, lastCacheUpdatedAt, connectedServers, totalServers, totalCachedTools, promptsCount, resourcesCount, cacheUsagePercent, latestPrompts, latestResources, mcpErrors, clearMcpErrors, dismissMcpError, handleRunHealthCheck, handleClearCaches } = mcpSection;
  useRefreshOnReturn(() => refreshSnapshots({ reload: true }), isActive && activeTab === 'mcp');

  // P0-4：移动端 MCP 工具/资源预览改走三屏右滑面板（替代 DsDialog）
  useSettingsMcpPreviewPanel({ isSmallScreen, mcpPreviewOpen: mcpPreview.open, rightPanelType, setRightPanelType, setScreenPosition: shell.setScreenPosition, closeRightPanel });

  // MCP 分区数据引导（仅在 activeTab === 'mcp' 时工作）
  useSettingsMcpBootstrap({ activeTab, mcpTools: config.mcpTools, refreshSnapshots, setMcpStatusInfo });

  // 按 rightPanelType 关闭当前右滑面板并清理对应状态
  const { dismissRightPanel, handleScreenPositionChange } = useSettingsPanelDismiss({
    rightPanelType, screenPosition, setScreenPosition: shell.setScreenPosition, closeRightPanel,
    handleCloseModelEditor, setVendorModalOpen, setEditingVendor, setMcpToolModal, setMcpPolicyModal, handleClosePreview,
  });
  // 顶栏返回与手势共用分区清理，不能仅收起屏幕而残留 preview/editor.open。
  const handleHeaderBack = useCallback(() => handleMobileHeaderBack(dismissRightPanel), [handleMobileHeaderBack, dismissRightPanel]);

  // 顶栏标题与右侧动作（面包屑依赖供应商/MCP 编辑目标）
  const { titleNode: settingsTitleNode, rightActions: settingsHeaderRightActions, onMenuClick: settingsHeaderBack } = useSettingsMobileHeaderContent({
    t, activeTab, activeNavItem, activeCategory, screenPosition, mobileNavView, mobileVendorDetailOpen,
    isSmallScreen, rightPanelType, mcpPreview, mcpToolModal, modelEditor, editingVendor, selectedVendor,
    vendorConfigModalRef, mcpToolSubmitRef, mcpPolicySaveRef, handleOpenVendorModal, handleCreateMcpTool,
    onMenuClick: handleHeaderBack,
  });

  useMobileHeader('settings', {
    // 移动端设置按普通页面承载，统一顶栏即页面顶栏（标题面包屑 + 返回 + 右侧动作）。
    hidden: !isActive,
    titleNode: settingsTitleNode,
    onMenuClick: settingsHeaderBack,
    showBackArrow: true,
    rightActions: settingsHeaderRightActions,
  }, [settingsTitleNode, settingsHeaderRightActions, settingsHeaderBack, isActive]);

  // 挂载时、以及（经典壳保活）设置视图重新成为当前视图时消费 pending settings route。
  // 很多入口只写 pending route 再切视图、不派发 SETTINGS_NAVIGATE_TAB（迁移横幅、
  // 初始化失败通知、欢迎引导、恢复回执……）；设置页已保活挂载时只在挂载时读取会
  // 落在上次停留的分区。视图切回时补消费一次，所有这类入口一并修正。
  const { isActive: isSettingsViewActive } = useViewVisibility('settings');
  useEffect(() => {
    const pending = consumePendingSettingsRoute();
    if (pending) {
      applySettingsRoute(pending);
      // 程序化直达某分区：移动端跳过分区列表，直接进入内容态
      setMobileNavView('content');
    }
  }, [applySettingsRoute, isSettingsViewActive]);

  // P1-09: 监听命令面板的 tab 跳转事件
  useAppEvent(
    APP_EVENTS.SETTINGS_NAVIGATE_TAB,
    (detail) => {
      const tab = detail.tab;
      if (tab) {
        // 事件已直达：同时清掉配套写入的 pending route，免得下次挂载/切回时重复跳转
        consumePendingSettingsRoute();
        applySettingsRoute({
          tab,
          dataGovernanceTab: detail.dataGovernanceTab,
        });
        // 程序化直达某分区：移动端跳过分区列表，直接进入内容态
        setMobileNavView('content');
      }
    },
    [applySettingsRoute],
  );

  // Preserve section-specific redirects (workbench -> apis on mobile platforms).
  useEffect(() => {
    const redirect = activeSectionEntry?.value.redirect?.({ isMobile });
    if (redirect) {
      setActiveTab(redirect);
    }
  }, [activeTab, activeSectionEntry, isMobile, setActiveTab]);

  // 「插件管理」挂载后并入旧「插件」页签（微信渠道插件已内置进管理页）：
  // 历史入口、命令面板或搜索直达 'plugins' 时统一落到 'plugin-manager'，避免出现第二个插件页。
  const hasPluginManager = useMemo(
    () => sectionEntries.some((entry) => entry.key === 'plugin-manager'),
    [sectionEntries],
  );
  useEffect(() => {
    if (hasPluginManager && activeTab === 'plugins') {
      setActiveTab('plugin-manager');
    }
  }, [activeTab, hasPluginManager, setActiveTab]);

  // 从 API 配置页切换到其他页时，触发一次自动分配模型
  const prevActiveTabRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTab = prevActiveTabRef.current;
    prevActiveTabRef.current = activeTab;

    if (prevTab === 'apis' && activeTab !== 'apis') {
      (async () => {
        try {
          const { autoAssignAllModels } = await import('@/features/chat/readiness/autoAssignModel');
          const result = await autoAssignAllModels();
          if (result.assigned) {
            console.log(`[Settings] Auto-assigned ${result.assignedCount} model(s): ${result.assignedModelNames.join(', ')}`);
          } else {
            console.log(`[Settings] Auto-assign skipped: ${result.reason ?? 'no changes'}`);
          }
        } catch (err) {
          console.error('[Settings] Auto-assign failed:', err);
        }
      })();
    }
  }, [activeTab]);

  useEffect(() => {
    loadConfig();
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
    config.webSearchBochaKey, config.webSearchDeepseekKey, config.webSearchSearxngEndpoint, config.webSearchGoogleCx,
    config.webSearchDeepseekNeedContent,
  ]);

  if (loading && !isSmallScreen) {
    return (
      <div className="settings absolute inset-0 flex flex-col overflow-hidden bg-[color:var(--shell-workspace-panel)]">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted-foreground">{t('settings:loading')}</div>
        </div>
      </div>
    );
  }

  // P0-1 移动端分区导航：进入某分区内容态（替代旧 chip rail 的横滑切换）
  const openMobileSection = (tab: string) => {
    setActiveTab(tab);
    setMobileNavView('content');
    setMobileSearchQuery('');
  };

  const renderMobileSectionList = () => (
    <SettingsMobileNavigation
      categories={sidebarCategories}
      items={sidebarNavItems}
      searchIndex={settingsSearchIndex}
      query={mobileSearchQuery}
      onQueryChange={setMobileSearchQuery}
      onOpenTab={openMobileSection}
    />
  );

  // Props stay in the shell, and are evaluated only for the active section.
  const sectionProps: SettingsSectionPropsFactories = {
    apis: () => ({
      vendors, sortedVendors, selectedVendor, selectedVendorId, setSelectedVendorId,
      selectedVendorModels, selectedVendorIsSiliconflow, openAICodexAuthenticated,
      profileCountByVendor, vendorBusy, vendorSaving, isEditingVendor, vendorFormData,
      setVendorFormData, testingApi, handleOpenVendorModal, handleStartEditVendor,
      handleCancelEditVendor, handleSaveEditVendor, handleDeleteVendor, handleSaveVendorBaseUrl,
      handleSaveVendorApiKey, handleClearVendorApiKey, handleOpenModelEditor, inlineEditState,
      setInlineEditState, handleSaveInlineEdit, isAddingNewModel, handleAddModelInline,
      handleCancelAddModel: () => { setInlineEditState(null); setIsAddingNewModel(false); },
      convertProfileToApiConfig: (profile, vendor) => convertProfileToApiConfig(profile, vendor),
      handleToggleModelProfile, handleDeleteModelProfile, handleToggleFavorite, testApiConnection,
      handleSiliconFlowConfig, handleBatchCreateConfigs, handleBatchConfigsCreated,
      onReorderVendors: handleReorderVendors,
      onAddVendorModels: handleAddVendorModels,
      triggerPostSaveAutoFlow,
      isSmallScreen: effectiveMobilePanelMode,
      mobileVendorDetailOpen,
      onMobileVendorDetailOpenChange: setMobileVendorDetailOpen,
      scrollElement: settingsScrollElement,
      deepseekCapabilities: {
        config,
        changeConfig: updates => setConfig(prev => ({ ...prev, ...updates })),
        assignAsr: async id => {
          await saveSingleAssignmentField('voice_input_asr_model_config_id', id);
          setConfig(prev => ({ ...prev, voice_input_asr_model_config_id: id ?? '' }));
        },
        enableModel: async profile => { await upsertModelProfile({ ...profile, enabled: true, status: 'enabled' }); },
      },
    }),
    search: () => ({ config, setConfig, deepseekProviderConfigured: vendors.some(vendor =>
      vendor.id === 'builtin-deepseek' && Boolean(vendor.apiKey?.trim())) }),
    models: () => ({
      config, setConfig, apiConfigs: config.apiConfigs, toUnifiedModelInfo,
      getAllEnabledApis, getEmbeddingApis, getRerankerApis, getAsrApis,
      getImageGenerationApis, saveSingleAssignmentField,
    }),
    plugins: () => ({ models: toUnifiedModelInfo(getAllEnabledApis()) }),
    mcp: () => ({
      servers: mcpServers,
      serverStatusMap,
      toolsByServer: {
        // 为内置服务器添加工具列表
        [BUILTIN_SERVER_ID]: {
          items: getBuiltinServer().tools.map(t => ({ name: t.name, description: t.description })),
          at: Date.now()
        },
        ...mcpCachedDetails.toolsByServer
      },
      prompts: mcpCachedDetails.prompts,
      resources: mcpCachedDetails.resources,
      lastCacheUpdatedAt, cacheCapacity, isLoading: isMcpLoading, lastError,
      onAddServer: handleAddMcpTool,
      onSaveServer: handleSaveMcpServer,
      onDeleteServer: handleDeleteMcpTool,
      onTestServer: handleTestServer,
      testStep: mcpTestStep,
      onReconnect: handleReconnectClient,
      onHealthCheck: handleRunHealthCheck,
      onClearCache: handleClearCaches,
      onOpenPolicy: handleOpenMcpPolicy,
      onCreateServer: handleCreateMcpTool,
      onEditServer: isSmallScreen ? (server) => handleEditMcpTool(server as McpToolConfig, mcpServers.findIndex((s) => s.id === server.id)) : undefined,
      scrollElement: settingsScrollElement,
    }),
    statistics: () => ({ embedded: true, mode: 'stats' }),
    automation: () => ({ invoke, listen: isTauri ? tauriListen as unknown as AutomationListen : null }),
    'data-governance': () => ({ tabTarget: dataGovernanceTabTarget }),
    general: () => ({
      topbarTopMargin, topbarTopMarginLoaded, setTopbarTopMargin, logTypeForOpen, setLogTypeForOpen,
      showRawRequest: showRawRequest ?? false,
      showRawRequestLoaded: showRawRequest !== null,
      setShowRawRequest, invoke,
    }),
    appearance: () => ({
      uiZoom, zoomLoading, zoomSaving, zoomStatus, handleZoomChange, handleZoomReset,
      uiFont, fontLoading, fontSaving, handleFontChange, handleFontReset,
      uiFontSize, fontSizeLoading, fontSizeSaving, handleFontSizeChange, handleFontSizeReset,
      themeMode, isSystemDark, setThemeMode, themePalette, setThemePalette,
      customColor, setCustomColor, isTauriEnvironment, invoke,
    }),
    params: () => ({ extra, setExtra, invoke, handleSaveChatStreamTimeout, handleToggleChatStreamAutoCancel }),
    'voice-input': () => ({ voiceInputAssignedModel }),
    memory: () => ({}),
    workbench: () => ({}),
    'document-processing': () => ({}),
    shortcuts: () => ({ className: 'min-h-[500px]', scrollElement: settingsScrollElement }),
    about: () => ({}),
  };

  // 渲染主内容区域（mobilePageMode：移动端 sheet 内的二级内容页）
  const renderSettingsMainContent = ({ mobilePageMode = false }: { mobilePageMode?: boolean } = {}) => (
    <SettingsMainContent
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      activeCategory={activeCategory}
      activeSectionEntry={activeSectionEntry}
      settingsNavigationId={settingsNavigationId}
      mobilePageMode={mobilePageMode}
      mobileVendorDetailOpen={mobileVendorDetailOpen}
      effectiveMobilePanelMode={effectiveMobilePanelMode}
      isSmallScreen={isSmallScreen}
      isMobile={isMobile}
      setSettingsScrollElement={setSettingsScrollElement}
      sectionProps={sectionProps}
      t={t}
      mcpPreview={mcpPreview}
      stripMcpPrefix={stripMcpPrefix}
      handleClosePreview={handleClosePreview}
      mcpPolicyModal={mcpPolicyModal}
      setMcpPolicyModal={setMcpPolicyModal}
      renderMcpToolEditor={renderMcpToolEditor}
      invoke={invoke}
      setConfig={setConfig}
    />
  );

  const renderRightPanel = () => (
    <SettingsMobileRightPanel
      rightPanelType={rightPanelType}
      modelEditor={modelEditor}
      handleSaveModelProfileAndClose={handleSaveModelProfileAndClose}
      handleCloseModelEditor={handleCloseModelEditor}
      renderMcpToolEditorEmbedded={renderMcpToolEditorEmbedded}
      renderMcpPolicyEditorEmbedded={renderMcpPolicyEditorEmbedded}
      mcpPreview={mcpPreview}
      stripMcpPrefix={stripMcpPrefix}
      t={t}
      vendorModalOpen={vendorModalOpen}
      editingVendor={editingVendor}
      handleSaveVendorModal={handleSaveVendorModal}
      closeRightPanel={closeRightPanel}
      setVendorModalOpen={setVendorModalOpen}
      setEditingVendor={setEditingVendor}
      vendorConfigModalRef={vendorConfigModalRef}
    />
  );

  const appMenuDemoDialog = (
    <DsDialog open={showAppMenuDemo} onOpenChange={setShowAppMenuDemo} maxWidth="max-w-4xl">
      <DsDialogHeader>
        <DsDialogTitle className="flex items-center gap-2">
          <Stack size={20} />
          {t('acknowledgements.ui_components.app_menu')}
        </DsDialogTitle>
        <DsDialogDescription>
          {t('acknowledgements.ui_components.app_menu_desc')}
        </DsDialogDescription>
      </DsDialogHeader>
      <DsDialogBody overlayScroll>
        <AppMenuDemo />
      </DsDialogBody>
    </DsDialog>
  );

  if (isSmallScreen) {
    // 移动端设置按普通页面承载（2026-09 起不再使用底部 Sheet）：
    // 统一顶栏由上方 useMobileHeader('settings') 注册（标题面包屑 + 返回箭头 + 右侧动作），
    // 返回链 handleMobileHeaderBack：分区列表态退出设置，内容态逐级回退。
    const isSectionsLevel = mobileNavView === 'sections';

    return (
      <>
        <MacTopSafeDragZone className="settings-top-safe-drag-zone" style={SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE} />
        <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />
        <div
          className="settings relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--shell-workspace-panel)]"
          data-wb-settings-content-ready
          data-wb-settings-active-tab={activeTab}
          data-settings-mobile-sheet-level={isSectionsLevel ? 'sections' : 'content'}
          style={{
            paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
          }}
        >
          <ShellViewSwitch
            viewKey={loading ? 'loading' : isSectionsLevel ? 'sections' : 'content'}
            direction={isSectionsLevel ? -1 : 1}
            className="flex min-h-0 flex-1 flex-col"
          >
          {loading ? (
            <SettingsMobileLoadingSkeleton categories={sidebarCategories} />
          ) : isSectionsLevel ? (
            <MobileSlidingLayout
              sidebar={
                // 设置分区导航由分组列表首页承载；抽屉只保留统一应用导航，与其他页面同构
                <div aria-hidden className="h-0" />
              }
              showSidebarAppNavigation={false}
              showContentOverlay
              enableGesture={false}
              mainContentClassName="settings-mobile-sheet-layout-content"
              className="min-h-0 flex-1"
            >
              <div className="flex h-full min-h-0 flex-col overflow-hidden text-foreground" data-settings-mobile-level="sections">
                {renderMobileSectionList()}
              </div>
            </MobileSlidingLayout>
          ) : (
            <MobileSlidingLayout
              sidebar={
                // 设置分区导航由分组列表首页承载；抽屉只保留统一应用导航，与其他页面同构
                <div aria-hidden className="h-0" />
              }
              rightPanel={renderRightPanel()}
              screenPosition={screenPosition}
              onScreenPositionChange={handleScreenPositionChange}
              sidebarWidth="auto"
              rightPanelEnabled={rightPanelType !== 'none'}
              rightPanelSwipeEnabled={false}
              enableGesture={false}
              threshold={0.3}
              showSidebarAppNavigation={false}
              showContentOverlay
              mainContentClassName="settings-mobile-sheet-layout-content"
              className="min-h-0 flex-1"
            >
              <div className="flex h-full min-h-0 flex-col overflow-hidden text-foreground" data-settings-mobile-level="content">
                {renderSettingsMainContent({ mobilePageMode: true })}
              </div>
            </MobileSlidingLayout>
          )}
          </ShellViewSwitch>
        </div>

        {appMenuDemoDialog}
      </>
    );
  }

  // ===== 桌面端布局 =====
  return (
    <div
      className="settings absolute inset-0 flex flex-col overflow-hidden bg-[color:var(--shell-workspace-panel)]"
      data-wb-settings-content-ready
      data-wb-settings-active-tab={activeTab}
    >
      <UnifiedErrorHandler errors={mcpErrors} onDismiss={dismissMcpError} onClearAll={clearMcpErrors} />

      {/* 主内容区域 */}
      {renderSettingsMainContent()}

      <SettingsDesktopDialogs
        modelEditor={modelEditor}
        handleSaveModelProfile={handleSaveModelProfile}
        setModelEditor={setModelEditor}
        vendorModalOpen={vendorModalOpen}
        editingVendor={editingVendor}
        setVendorModalOpen={setVendorModalOpen}
        setEditingVendor={setEditingVendor}
        handleSaveVendorModal={handleSaveVendorModal}
        modelDeleteDialog={modelDeleteDialog}
        setModelDeleteDialog={setModelDeleteDialog}
        confirmDeleteModelProfile={confirmDeleteModelProfile}
        vendorDeleteDialog={vendorDeleteDialog}
        setVendorDeleteDialog={setVendorDeleteDialog}
        confirmDeleteVendor={confirmDeleteVendor}
        t={t}
      />

      {/* 现代化菜单演示对话框 */}
      {appMenuDemoDialog}
    </div>
  );
};
