import React, { useMemo } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { TFunction } from 'i18next';
import { ArrowSquareOut, Plus, Check } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { ScreenPosition } from '@/components/layout';
import type { ApiConfig, VendorConfig } from '@/types';
import { openUrl } from '@/utils/urlOpener';
import { getProviderWebsiteUrl } from './VendorDetailPanel';
import type { VendorConfigModalRef } from './VendorConfigModal';
import type { SettingsRightPanelType } from './hookDepsTypes';
import type { McpPreviewState, McpToolModalState } from './mcp-editor/types';

interface ModelEditorTarget { vendor: VendorConfig; api: ApiConfig }

/**
 * 移动端设置统一顶栏的内容：面包屑标题 + 右侧动作。
 *
 * 这两个块只依赖外壳导航状态与供应商/MCP 编辑目标，属于「顶栏展示」一件事，
 * 从 Settings.tsx 下沉到这里。注册调用仍留在 Settings（view id 契约在那边），
 * 本 hook 只返回 titleNode / rightActions / onMenuClick 与依赖数组。
 */
export function useSettingsMobileHeaderContent({
  t,
  activeTab,
  activeNavItem,
  activeCategory,
  screenPosition,
  mobileNavView,
  mobileVendorDetailOpen,
  isSmallScreen,
  rightPanelType,
  mcpPreview,
  mcpToolModal,
  modelEditor,
  editingVendor,
  selectedVendor,
  vendorConfigModalRef,
  mcpToolSubmitRef,
  mcpPolicySaveRef,
  handleOpenVendorModal,
  handleCreateMcpTool,
  onMenuClick,
}: {
  t: TFunction;
  activeTab: string;
  activeNavItem: { label?: string } | null;
  activeCategory: { label?: string } | null;
  screenPosition: ScreenPosition;
  mobileNavView: 'sections' | 'content';
  mobileVendorDetailOpen: boolean;
  isSmallScreen: boolean;
  rightPanelType: SettingsRightPanelType;
  mcpPreview: McpPreviewState;
  mcpToolModal: McpToolModalState;
  modelEditor: ModelEditorTarget | null;
  editingVendor: VendorConfig | null;
  selectedVendor: VendorConfig | null;
  vendorConfigModalRef: RefObject<VendorConfigModalRef>;
  mcpToolSubmitRef: MutableRefObject<(() => Promise<void>) | null>;
  mcpPolicySaveRef: MutableRefObject<(() => Promise<void>) | null>;
  handleOpenVendorModal: (vendor?: VendorConfig | null) => void;
  handleCreateMcpTool: () => void;
  onMenuClick: () => void;
}) {
  // 顶栏标题：分区列表态显示「系统设置」；分区内容态显示分区名；
  // API 详情态显示供应商名；右滑面板显示编辑/预览标题
  const settingsBreadcrumbText = useMemo(() => {
    let text = t('settings:title');
    if (screenPosition === 'right') {
      switch (rightPanelType) {
        case 'mcpPreview':
          text = mcpPreview.serverName || t('settings:mcp.preview.default_title');
          break;
        case 'mcpTool':
          text = mcpToolModal.draft.name?.trim()
            || (mcpToolModal.index == null
              ? t('settings:mcp_descriptions.add_tool_title')
              : t('settings:mcp_descriptions.edit_tool_title'));
          break;
        case 'mcpPolicy':
          text = t('settings:mcp.security_policy');
          break;
        case 'modelEditor':
          text = modelEditor?.api?.name || t('settings:title_edit');
          break;
        case 'vendorConfig':
          text = editingVendor?.name || t('settings:title_edit');
          break;
        default:
          text = t('settings:title_edit');
      }
    } else if (mobileNavView === 'content') {
      if (activeTab === 'apis' && mobileVendorDetailOpen && selectedVendor) {
        text = selectedVendor.name || activeNavItem?.label || t('settings:title');
      } else if (activeTab === 'apis') {
        // 列表态以分类名为标题；具体分区由下方二级 Tab 标明。
        text = activeCategory?.label ?? t('settings:vendor_panel.list_title');
      } else {
        text = activeCategory?.label ?? activeNavItem?.label ?? t('settings:title');
      }
    }
    return text;
  }, [
    screenPosition,
    rightPanelType,
    mcpPreview.serverName,
    mcpToolModal.draft.name,
    mcpToolModal.index,
    modelEditor,
    editingVendor,
    mobileNavView,
    activeTab,
    mobileVendorDetailOpen,
    selectedVendor,
    activeNavItem,
    activeCategory,
    t,
  ]);

  const SettingsBreadcrumb = useMemo(() => (
    <h1 className="truncate text-lg font-semibold">
      {settingsBreadcrumbText}
    </h1>
  ), [settingsBreadcrumbText]);

  const settingsHeaderRightActions = useMemo(() => {
    // 供应商详情态：官网入口收进顶栏右侧（页内名称行已随标题上收而移除）
    if (
      isSmallScreen
      && screenPosition !== 'right'
      && mobileNavView === 'content'
      && activeTab === 'apis'
      && mobileVendorDetailOpen
      && selectedVendor
    ) {
      const websiteUrl = selectedVendor.websiteUrl || getProviderWebsiteUrl(selectedVendor.providerType);
      if (websiteUrl) {
        return (
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => void openUrl(websiteUrl)} title={t('settings:vendor_panel.open_website')} aria-label={t('settings:vendor_panel.open_website')} className="!h-11 !w-11 text-primary">
            <ArrowSquareOut size={20} />
          </DsButton>
        );
      }
    }
    // 供应商列表态：新建供应商入口收进顶栏（页内标题行随之移除）
    if (
      isSmallScreen
      && screenPosition !== 'right'
      && mobileNavView === 'content'
      && activeTab === 'apis'
      && !mobileVendorDetailOpen
    ) {
      return (
        <DsButton variant="ghost" size="icon" iconOnly onClick={() => handleOpenVendorModal(null)} title={t('settings:vendor_panel.add_vendor_button')} aria-label={t('settings:vendor_panel.add_vendor_button')} className="!h-11 !w-11 text-primary">
          <Plus size={20} />
        </DsButton>
      );
    }
    // MCP 分区态：新增服务器入口收进顶栏（打开右滑面板编辑器，与编辑同一表单）
    if (
      isSmallScreen
      && screenPosition !== 'right'
      && mobileNavView === 'content'
      && activeTab === 'mcp'
    ) {
      return (
        <DsButton variant="ghost" size="icon" iconOnly onClick={handleCreateMcpTool} title={t('settings:mcp.add_server')} aria-label={t('settings:mcp.add_server')} className="!h-11 !w-11 text-primary">
          <Plus size={20} />
        </DsButton>
      );
    }
    if (screenPosition !== 'right') return undefined;
    if (rightPanelType === 'vendorConfig') {
      return (
        <DsButton variant="ghost" size="icon" iconOnly onClick={() => vendorConfigModalRef.current?.save()} title={t('common:actions.save')} aria-label={t('settings:a11y.save')} className="text-primary">
          <Check size={20} />
        </DsButton>
      );
    }
    if (rightPanelType === 'modelEditor') {
      return (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => {
            const form = document.getElementById('settings-model-editor-form');
            if (form instanceof HTMLFormElement) form.requestSubmit();
          }}
          title={t('common:actions.save')}
          aria-label={t('settings:a11y.save')}
          className="text-primary"
        >
          <Check size={20} />
        </DsButton>
      );
    }
    // MCP 工具/策略编辑器：保存出口同样收进顶栏（P1-7 统一；移动端底栏已移除，
    // 提交闭包由嵌入式编辑器每次渲染写入 ref）
    if (rightPanelType === 'mcpTool' || rightPanelType === 'mcpPolicy') {
      const submitRef = rightPanelType === 'mcpTool' ? mcpToolSubmitRef : mcpPolicySaveRef;
      return (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => { void submitRef.current?.(); }}
          title={t('common:actions.save')}
          aria-label={t('settings:a11y.save')}
          className="!h-11 !w-11 text-primary"
        >
          <Check size={20} />
        </DsButton>
      );
    }
    return undefined;
  }, [screenPosition, rightPanelType, t, isSmallScreen, mobileNavView, activeTab, mobileVendorDetailOpen, handleOpenVendorModal, selectedVendor, mcpToolSubmitRef, mcpPolicySaveRef, handleCreateMcpTool]);

  return {
    titleNode: SettingsBreadcrumb,
    rightActions: settingsHeaderRightActions,
    onMenuClick,
    deps: [SettingsBreadcrumb, settingsHeaderRightActions, onMenuClick],
  };
}
