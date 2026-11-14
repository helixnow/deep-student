import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiConfig, ModelAssignments, ModelProfile, VendorConfig } from '@/types';
import { Stack } from '@phosphor-icons/react';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsAlertDialog } from '@/components/ui/DsDialog';
import { AppMenuDemo } from '@/components/ui/app-menu';
import type { TFunction } from 'i18next';
import { ShadApiEditModal } from './ShadApiEditModal';
import { VendorConfigModal } from './VendorConfigModal';

type ModelEditorTarget = { vendor: VendorConfig; api: ApiConfig };

/** 菜单/组件演示弹窗（桌面与移动端共用）。 */
export function SettingsAppMenuDemoDialog({
  open,
  onOpenChange,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: TFunction;
}) {
  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-4xl">
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
}

/**
 * 桌面端设置页的全局编辑/确认弹窗。
 *
 * 与主内容区平级叠放（不进入滚动容器），承载模型编辑、供应商编辑与
 * 两个删除确认；状态仍由 vendor 分区 hook 持有。
 */
export function SettingsDesktopDialogs({
  modelEditor,
  handleSaveModelProfile,
  setModelEditor,
  vendorModalOpen,
  editingVendor,
  setVendorModalOpen,
  setEditingVendor,
  handleSaveVendorModal,
  modelDeleteDialog,
  setModelDeleteDialog,
  confirmDeleteModelProfile,
  vendorDeleteDialog,
  setVendorDeleteDialog,
  confirmDeleteVendor,
  t,
}: {
  modelEditor: ModelEditorTarget | null;
  handleSaveModelProfile: (api: ApiConfig) => Promise<void>;
  setModelEditor: (value: ModelEditorTarget | null) => void;
  vendorModalOpen: boolean;
  editingVendor: VendorConfig | null;
  setVendorModalOpen: (open: boolean) => void;
  setEditingVendor: (vendor: VendorConfig | null) => void;
  handleSaveVendorModal: (vendorData: VendorConfig) => Promise<void>;
  modelDeleteDialog: { profile: ModelProfile; referencingKeys: (keyof ModelAssignments)[] } | null;
  setModelDeleteDialog: Dispatch<SetStateAction<{ profile: ModelProfile; referencingKeys: (keyof ModelAssignments)[] } | null>>;
  confirmDeleteModelProfile: () => Promise<void>;
  vendorDeleteDialog: VendorConfig | null;
  setVendorDeleteDialog: Dispatch<SetStateAction<VendorConfig | null>>;
  confirmDeleteVendor: () => Promise<void>;
  t: TFunction;
}) {
  return (
    <>
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
      <DsAlertDialog
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
      </DsAlertDialog>
      <DsAlertDialog
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
      </DsAlertDialog>
    </>
  );
}
