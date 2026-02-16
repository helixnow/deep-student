import React, { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '../ui/NotionDialog';
import { Input } from '../ui/shad/Input';
import { Textarea } from '../ui/shad/Textarea';
import { NotionButton } from '../ui/NotionButton';
import { Label } from '../ui/shad/Label';
import { SecurePasswordInput } from '../SecurePasswordInput';
import { CustomScrollArea } from '../custom-scroll-area';
import type { VendorConfig } from '../../types';

interface VendorConfigModalProps {
  open: boolean;
  vendor?: VendorConfig | null;
  onClose: () => void;
  onSave: (vendor: VendorConfig) => void;
  /** 嵌入模式：不使用 Dialog 包裹，直接渲染内容（用于移动端三屏布局） */
  embeddedMode?: boolean;
}

/** 暴露给父组件的方法 */
export interface VendorConfigModalRef {
  save: () => void;
}

const defaultVendor: VendorConfig = {
  id: '',
  name: '',
  providerType: 'custom',
  baseUrl: '',
  apiKey: '',
  headers: {},
  rateLimitPerMinute: undefined,
  defaultTimeoutMs: undefined,
  notes: '',
  isBuiltin: false,
  isReadOnly: false,
};

export const VendorConfigModal = forwardRef<VendorConfigModalRef, VendorConfigModalProps>(({ open, vendor, onClose, onSave, embeddedMode = false }, ref) => {
  const { t } = useTranslation(['settings', 'common']);
  const [formData, setFormData] = useState<VendorConfig>(vendor ?? defaultVendor);
  const [headersInput, setHeadersInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forceClearApiKey, setForceClearApiKey] = useState(false);

  useEffect(() => {
    if (vendor) {
      // 如果是掩码的API密钥，清空它以便用户重新输入真实密钥
      const isMaskedKey = vendor.apiKey === '***' || /^\*+$/.test(vendor.apiKey);
      setFormData({
        ...vendor,
        apiKey: isMaskedKey ? '' : vendor.apiKey,
      });
      setHeadersInput(
        vendor.headers && Object.keys(vendor.headers).length > 0
          ? JSON.stringify(vendor.headers, null, 2)
          : ''
      );
    } else {
      setFormData(defaultVendor);
      setHeadersInput('');
    }
    setError(null);
    setForceClearApiKey(false);
  }, [vendor, open]);

  const handleSave = () => {
    if (!formData.name.trim()) {
      setError(t('settings:vendor_modal.validation_name'));
      return;
    }
    if (!formData.baseUrl.trim()) {
      setError(t('settings:vendor_modal.validation_base_url'));
      return;
    }
    // 如果是编辑模式且API密钥为空，使用原有密钥
    const isEditing = Boolean(vendor && vendor.id);
    const finalApiKey = forceClearApiKey
      ? ''
      : (formData.apiKey.trim() || (isEditing ? vendor?.apiKey || '' : ''));
    
    // 创建新供应商时，必须提供 API Key；编辑模式允许为空（表示未配置/已清除）
    if (!finalApiKey && !isEditing) {
      setError(t('settings:vendor_modal.validation_api_key'));
      return;
    }

    let parsedHeaders: Record<string, string> | undefined;
    if (headersInput.trim()) {
      try {
        const parsed = JSON.parse(headersInput);
        if (parsed && typeof parsed === 'object') {
          parsedHeaders = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, String(value)])
          );
        }
      } catch (parseError: unknown) {
        setError(t('settings:vendor_modal.headers_parse_error'));
        return;
      }
    }

    // 自动检测 SiliconFlow
    let providerType = formData.providerType;
    if (!providerType || providerType === 'custom') {
      const lowerBaseUrl = formData.baseUrl.toLowerCase();
      if (lowerBaseUrl.includes('siliconflow.cn') || lowerBaseUrl.includes('siliconflow.com')) {
        providerType = 'siliconflow';
      }
    }

    const payload: VendorConfig = {
      ...formData,
      providerType,
      apiKey: finalApiKey,
      headers: parsedHeaders,
      id: formData.id || '',
      isBuiltin: formData.isBuiltin ?? false,
      isReadOnly: formData.isReadOnly ?? false,
    };
    onSave(payload);
  };

  // 暴露 save 方法给父组件（用于移动端顶栏保存按钮）
  useImperativeHandle(ref, () => ({
    save: handleSave,
  }));

  // 表单内容
  const formContent = (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div>
        <Label>{t('settings:vendor_modal.name_label')}</Label>
        <Input
          value={formData.name}
          onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
          placeholder={t('settings:vendor_modal.name_placeholder')}
          className="mt-2"
        />
      </div>
      <div>
        <Label>{t('settings:vendor_modal.base_url_label')}</Label>
        <Input
          value={formData.baseUrl}
          onChange={e => setFormData(prev => ({ ...prev, baseUrl: e.target.value }))}
          placeholder="https://api.openai.com/v1"
          className="mt-2 font-mono"
        />
      </div>
      <div>
        <Label>{t('settings:vendor_modal.api_key_label')}</Label>
        <SecurePasswordInput
          value={formData.apiKey}
          placeholder={vendor && !formData.apiKey ? t('settings:vendor_modal.api_key_placeholder_keep_or_update') : "sk-..."}
          onChange={value => {
            setFormData(prev => ({ ...prev, apiKey: value }));
            if (forceClearApiKey) {
              setForceClearApiKey(false);
            }
          }}
          className="mt-2"
        />
        {vendor && vendor.id && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <NotionButton
              type="button"
              size="sm"
              variant="danger"
              onClick={() => {
                setForceClearApiKey(true);
                setFormData(prev => ({ ...prev, apiKey: '' }));
              }}
              title={t('settings:vendor_modal.clear_api_key_title')}
            >
              {t('settings:vendor_modal.clear_api_key')}
            </NotionButton>
            {forceClearApiKey && (
              <div className="text-xs text-destructive">
                {t('settings:vendor_modal.clear_api_key_warning')}
              </div>
            )}
          </div>
        )}
      </div>
      <div>
        <Label>{t('settings:vendor_modal.notes_label')}</Label>
        <Textarea
          value={formData.notes ?? ''}
          onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
          placeholder={t('settings:vendor_modal.notes_placeholder')}
          className="mt-2"
          rows={3}
        />
      </div>
      <div>
        <Label>{t('settings:vendor_modal.headers_label')}</Label>
        <Textarea
          value={headersInput}
          onChange={e => setHeadersInput(e.target.value)}
          placeholder={t('settings:vendor_modal.headers_placeholder')}
          className="mt-2 font-mono"
          rows={3}
        />
      </div>
    </div>
  );

  // 嵌入模式：直接返回内容，不使用 Dialog 包裹（标题和保存按钮由全局移动端顶栏提供）
  if (embeddedMode) {
    return (
      <div className="h-full flex flex-col bg-background">
        <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-4 py-4 pb-safe">
          {formContent}
        </CustomScrollArea>
      </div>
    );
  }

  // 模态框模式
  return (
    <NotionDialog open={open} onOpenChange={onClose} maxWidth="max-w-lg">
        <NotionDialogHeader>
          <NotionDialogTitle>
            {vendor ? t('settings:vendor_modal.title_edit') : t('settings:vendor_modal.title_new')}
          </NotionDialogTitle>
          <NotionDialogDescription>{t('settings:vendor_modal.subtitle')}</NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>
          {formContent}
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={onClose}>
            {t('common:actions.cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" onClick={handleSave}>{t('common:actions.save')}</NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
});

VendorConfigModal.displayName = 'VendorConfigModal';
