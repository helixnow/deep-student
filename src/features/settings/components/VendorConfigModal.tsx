import React, { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, LinkSimple, NotePencil, Trash } from '@phosphor-icons/react';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { NotionButton } from '@/components/ui/NotionButton';
import { Label } from '@/components/ui/shad/Label';
import { SecurePasswordInput } from '@/components/SecurePasswordInput';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { VendorConfig } from '@/types';
import { inferProviderTypeFromBaseUrl } from './modelConverters';

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

const providerTypeOptions = [
  { value: 'custom', labelKey: 'settings:vendor_modal.providers.custom', defaultLabel: 'Custom' },
  { value: 'openai', labelKey: 'settings:vendor_modal.providers.openai', defaultLabel: 'OpenAI' },
  { value: 'deepseek', labelKey: 'settings:vendor_modal.providers.deepseek', defaultLabel: 'DeepSeek' },
  { value: 'anthropic', labelKey: 'settings:vendor_modal.providers.anthropic', defaultLabel: 'Anthropic' },
  { value: 'google', labelKey: 'settings:vendor_modal.providers.google', defaultLabel: 'Google' },
  { value: 'general', labelKey: 'settings:vendor_modal.providers.general', defaultLabel: 'General Adapter' },
  { value: 'siliconflow', labelKey: 'settings:vendor_modal.providers.siliconflow', defaultLabel: 'SiliconFlow' },
  { value: 'qwen', labelKey: 'settings:vendor_modal.providers.qwen', defaultLabel: 'Qwen' },
  { value: 'zhipu', labelKey: 'settings:vendor_modal.providers.zhipu', defaultLabel: 'Zhipu' },
  { value: 'doubao', labelKey: 'settings:vendor_modal.providers.doubao', defaultLabel: 'Doubao' },
  { value: 'minimax', labelKey: 'settings:vendor_modal.providers.minimax', defaultLabel: 'MiniMax' },
  { value: 'moonshot', labelKey: 'settings:vendor_modal.providers.moonshot', defaultLabel: 'Moonshot' },
  { value: 'nvidia', labelKey: 'settings:vendor_modal.providers.nvidia', defaultLabel: 'NVIDIA' },
  { value: 'mimo', labelKey: 'settings:vendor_modal.providers.mimo', defaultLabel: 'Xiaomi MiMo' },
  { value: 'ollama', labelKey: 'settings:vendor_modal.providers.ollama', defaultLabel: 'Ollama' },
];

export const VendorConfigModal = forwardRef<VendorConfigModalRef, VendorConfigModalProps>(({ open, vendor, onClose, onSave, embeddedMode = false }, ref) => {
  const { t } = useTranslation(['settings', 'common']);
  const [formData, setFormData] = useState<VendorConfig>(vendor ?? defaultVendor);
  const [headersInput, setHeadersInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forceClearApiKey, setForceClearApiKey] = useState(false);
  const isEditing = Boolean(vendor && vendor.id);

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
    if (isEditing && !formData.baseUrl.trim()) {
      setError(t('settings:vendor_modal.validation_base_url'));
      return;
    }
    // 如果是编辑模式且API密钥为空，使用原有密钥
    const finalApiKey = forceClearApiKey
      ? ''
      : (formData.apiKey.trim() || (isEditing ? vendor?.apiKey || '' : ''));

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

    // 自动检测供应商类型
    let providerType = formData.providerType;
    if ((!providerType || providerType === 'custom') && formData.baseUrl.trim()) {
      providerType = inferProviderTypeFromBaseUrl(formData.baseUrl) ?? providerType;
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

  const nameInputId = 'vendor-config-name';
  const providerTypeSelectId = 'vendor-config-provider-type';
  const baseUrlInputId = 'vendor-config-base-url';

  // 表单内容
  const formContent = (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div>
        <Label htmlFor={nameInputId}>{t('settings:vendor_modal.name_label')}</Label>
        <Input
          id={nameInputId}
          value={formData.name}
          onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
          placeholder={t('settings:vendor_modal.name_placeholder')}
          className="mt-2"
        />
      </div>
      <div>
        <Label htmlFor={providerTypeSelectId}>{t('settings:vendor_modal.provider_label')}</Label>
        <select
          id={providerTypeSelectId}
          value={formData.providerType || 'custom'}
          onChange={e => setFormData(prev => ({ ...prev, providerType: e.target.value }))}
          className="mt-2 flex min-h-[var(--touch-target-size)] w-full rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--input-shell-surface)] px-3 py-2 text-sm text-foreground transition-colors hover:bg-[color:var(--surface-panel-strong)] focus-visible:border-[color:var(--input-shell-focus)] focus-visible:bg-[color:var(--surface-panel-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] lg:min-h-[var(--button-height)]"
        >
          {providerTypeOptions.map(option => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey, { defaultValue: option.defaultLabel })}
            </option>
          ))}
        </select>
      </div>
      {isEditing && (
        <>
          <div>
            <Label htmlFor={baseUrlInputId} className="inline-flex items-center gap-1.5">
              <LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('settings:vendor_modal.base_url_label')}</span>
            </Label>
            <Input
              id={baseUrlInputId}
              value={formData.baseUrl}
              onChange={e => setFormData(prev => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.openai.com/v1"
              className="mt-2 font-mono"
            />
          </div>
          <div>
            <Label className="inline-flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('settings:vendor_modal.api_key_label')}</span>
            </Label>
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
                  <Trash className="h-3.5 w-3.5" />
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
            <Label className="inline-flex items-center gap-1.5">
              <NotePencil className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('settings:vendor_modal.notes_label')}</span>
            </Label>
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
        </>
      )}
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
