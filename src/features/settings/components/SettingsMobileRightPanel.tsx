import React from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { TFunction } from 'i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { ApiConfig, VendorConfig } from '@/types';
import { ShadApiEditModal } from './ShadApiEditModal';
import { VendorConfigModal, type VendorConfigModalRef } from './VendorConfigModal';
import { SettingsMcpPreviewBody } from './SettingsMcpPreviewBody';
import type { SettingsRightPanelType } from './hookDepsTypes';
import type { McpPreviewState } from './mcp-editor/types';

const PANEL_SAFE_AREA_STYLE: React.CSSProperties = {
  paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
};

/**
 * 移动端三屏布局的右侧滑动面板内容。
 *
 * 由外壳的 rightPanelType 决定显示哪一个编辑器；各编辑器的表单状态仍由
 * vendor/MCP 分区 hook 持有，这里只负责承载与关闭路径（与改造前一致）。
 */
export function SettingsMobileRightPanel({
  rightPanelType,
  modelEditor,
  handleSaveModelProfileAndClose,
  handleCloseModelEditor,
  renderMcpToolEditorEmbedded,
  renderMcpPolicyEditorEmbedded,
  mcpPreview,
  stripMcpPrefix,
  t,
  vendorModalOpen,
  editingVendor,
  handleSaveVendorModal,
  closeRightPanel,
  setVendorModalOpen,
  setEditingVendor,
  vendorConfigModalRef,
}: {
  rightPanelType: SettingsRightPanelType;
  modelEditor: { vendor: VendorConfig; api: ApiConfig } | null;
  handleSaveModelProfileAndClose: (api: ApiConfig) => Promise<void>;
  handleCloseModelEditor: () => void;
  renderMcpToolEditorEmbedded: () => React.ReactNode;
  renderMcpPolicyEditorEmbedded: () => React.ReactNode;
  mcpPreview: McpPreviewState;
  stripMcpPrefix: (raw?: string | null) => string;
  t: TFunction;
  vendorModalOpen: boolean;
  editingVendor: VendorConfig | null;
  handleSaveVendorModal: (vendorData: VendorConfig) => Promise<void>;
  closeRightPanel: () => void;
  setVendorModalOpen: (open: boolean) => void;
  setEditingVendor: (vendor: VendorConfig | null) => void;
  vendorConfigModalRef: RefObject<VendorConfigModalRef>;
}) {
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
          className="flex h-full min-h-0 flex-col bg-background"
          style={PANEL_SAFE_AREA_STYLE}
        >
          <ShadApiEditModal
            // 表单内部状态在挂载时初始化：切换编辑目标必须重挂载，否则残留上一个模型的值
            key={modelEditor.api.id}
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
            mobilePanelMode={true}
          />
        </div>
      );

    case 'mcpTool':
      return renderMcpToolEditorEmbedded();

    case 'mcpPolicy':
      return renderMcpPolicyEditorEmbedded();

    case 'mcpPreview':
      // P0-4：MCP 工具/资源预览（移动端），标题由统一顶栏承载
      return (
        <div
          className="flex h-full min-h-0 flex-col bg-background"
          style={PANEL_SAFE_AREA_STYLE}
        >
          <CustomScrollArea
            className="flex-1 min-h-0 w-full"
            // 外层容器（--android-safe-area-bottom）已消费底部安全区；
            // Sheet 根现在重建了 --mobile-safe-area-bottom，这里再叠加会双倍留白。
            viewportClassName="px-4 py-4"
            trackOffsetTop={12}
            trackOffsetBottom={12}
          >
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{t('settings:mcp.preview.description')}</p>
              {mcpPreview.serverId && (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings:mcp.preview.id_label')}：{mcpPreview.serverId}
                </p>
              )}
              <SettingsMcpPreviewBody preview={mcpPreview} stripMcpPrefix={stripMcpPrefix} t={t} />
            </div>
          </CustomScrollArea>
        </div>
      );

    case 'vendorConfig':
      if (!vendorModalOpen) {
        return (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <p className="text-sm">{t('settings:vendor_panel.select_vendor_to_edit')}</p>
          </div>
        );
      }
      return (
        <div
          className="flex h-full min-h-0 flex-col bg-background"
          style={PANEL_SAFE_AREA_STYLE}
        >
          <VendorConfigModal
            ref={vendorConfigModalRef as MutableRefObject<VendorConfigModalRef>}
            open={vendorModalOpen}
            vendor={editingVendor}
            onClose={() => {
              setVendorModalOpen(false);
              setEditingVendor(null);
              closeRightPanel();
            }}
            onSave={handleSaveVendorModal}
            embeddedMode={true}
          />
        </div>
      );

    default:
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:vendor_panel.select_model_to_edit')}</p>
        </div>
      );
  }
}
