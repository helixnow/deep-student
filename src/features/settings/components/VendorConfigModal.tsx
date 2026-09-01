import React, { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, LinkSimple, NotePencil, Trash, Prohibit } from '@phosphor-icons/react';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { DsButton } from '@/components/ui/DsButton';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { SecurePasswordInput } from '@/components/SecurePasswordInput';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { ApiProtocol, VendorConfig } from '@/types';
import {
  defaultApiProtocolForProvider,
  getAllowedApiProtocolsForProviderType,
  inferProviderTypeFromBaseUrl,
  normalizeApiProtocolForProviderType,
} from './modelConverters';

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
  authMode: 'api_key',
  apiProtocol: 'openai_chat_completions',
  supportsOpenAIResponses: false,
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
  { value: 'grok', labelKey: 'settings:vendor_modal.providers.grok', defaultLabel: 'xAI (Grok)' },
  { value: 'ernie', labelKey: 'settings:vendor_modal.providers.ernie', defaultLabel: 'Baidu ERNIE' },
  { value: 'mistral', labelKey: 'settings:vendor_modal.providers.mistral', defaultLabel: 'Mistral' },
  { value: 'openrouter', labelKey: 'settings:vendor_modal.providers.openrouter', defaultLabel: 'OpenRouter' },
  { value: 'ollama', labelKey: 'settings:vendor_modal.providers.ollama', defaultLabel: 'Ollama' },
];

const protocolImpliesResponsesSupport = (protocol?: ApiProtocol | null) => protocol === 'openai_responses';


export const VendorConfigModal = forwardRef<VendorConfigModalRef, VendorConfigModalProps>(({ open, vendor, onClose, onSave, embeddedMode = false }, ref) => {
  const { t } = useTranslation(['settings', 'common']);
  const [formData, setFormData] = useState<VendorConfig>(vendor ?? defaultVendor);
  const [headersInput, setHeadersInput] = useState('');
  const [apiKeysInput, setApiKeysInput] = useState('');
  const [protocolManuallySelected, setProtocolManuallySelected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceClearApiKey, setForceClearApiKey] = useState(false);
  const isEditing = Boolean(vendor && vendor.id);
  const usesNoApiKey = formData.authMode === 'none' || formData.noApiKey === true;

  const effectiveProviderType =
    ((!formData.providerType || formData.providerType === 'custom') && formData.baseUrl.trim()
      ? inferProviderTypeFromBaseUrl(formData.baseUrl)
      : formData.providerType) ?? formData.providerType;
  const selectedProtocol = normalizeApiProtocolForProviderType(formData.apiProtocol, effectiveProviderType, {
    baseUrl: formData.baseUrl,
    supportsOpenAIResponses: formData.supportsOpenAIResponses,
  });
  const protocolOptions = getAllowedApiProtocolsForProviderType(effectiveProviderType).map(protocol => ({
    value: protocol,
    label: t(`settings:vendor_modal.protocols.${protocol}`, { defaultValue: protocol }),
  }));

  useEffect(() => {
    if (vendor) {
      // 如果是掩码的API密钥，清空它以便用户重新输入真实密钥
      const isMaskedKey = vendor.apiKey === '***' || /^\*+$/.test(vendor.apiKey);
      setFormData({
        ...vendor,
        authMode: vendor.authMode ?? (vendor.noApiKey ? 'none' : 'api_key'),
        noApiKey: vendor.authMode === 'none' || vendor.noApiKey === true,
        apiProtocol: normalizeApiProtocolForProviderType(vendor.apiProtocol, vendor.providerType, {
          baseUrl: vendor.baseUrl,
        }),
        supportsOpenAIResponses:
          vendor.supportsOpenAIResponses ?? protocolImpliesResponsesSupport(vendor.apiProtocol),
        apiKey: isMaskedKey ? '' : vendor.apiKey,
      });
      setHeadersInput(
        vendor.headers && Object.keys(vendor.headers).length > 0
          ? JSON.stringify(vendor.headers, null, 2)
          : ''
      );
      setApiKeysInput((vendor.apiKeys ?? []).join('\n'));
    } else {
      setFormData({
        ...defaultVendor,
        apiProtocol: defaultApiProtocolForProvider(defaultVendor.providerType, {
          baseUrl: defaultVendor.baseUrl,
        }),
      });
      setHeadersInput('');
      setApiKeysInput('');
    }
    setError(null);
    setForceClearApiKey(false);
    // 已持久化的协议属于用户选择；编辑 custom 网关 URL 时不得按推断默认值覆盖。
    setProtocolManuallySelected(Boolean(vendor?.apiProtocol));
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
    const finalApiKey = forceClearApiKey
      ? ''
      : (formData.apiKey.trim() || (isEditing ? vendor?.apiKey || '' : ''));

    let parsedHeaders: Record<string, string> | undefined;
    if (headersInput.trim()) {
      try {
        const parsed = JSON.parse(headersInput);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('headers must be a JSON object');
        }
        parsedHeaders = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, String(value)])
        );
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

    const normalizedProtocol = normalizeApiProtocolForProviderType(formData.apiProtocol, providerType, {
      baseUrl: formData.baseUrl,
      supportsOpenAIResponses: formData.supportsOpenAIResponses,
    });
    const supportsOpenAIResponses = protocolImpliesResponsesSupport(normalizedProtocol);
    const apiKeys = apiKeysInput
      .split(/[\n,]/)
      .map(key => key.trim());

    const payload: VendorConfig = {
      ...formData,
      providerType,
      authMode: usesNoApiKey ? 'none' : (formData.authMode === 'none' ? 'api_key' : formData.authMode ?? 'api_key'),
      // 兼容尚未迁移的前端状态；后端持久化以 authMode 为准。
      noApiKey: usesNoApiKey,
      apiProtocol: normalizedProtocol,
      supportsOpenAIResponses,
      apiKey: usesNoApiKey ? '' : finalApiKey,
      apiKeys: usesNoApiKey ? [] : apiKeys,
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
  const protocolSelectId = 'vendor-config-protocol';
  const baseUrlInputId = 'vendor-config-base-url';

  useEffect(() => {
    setFormData(prev => {
      const nextProviderType =
        ((!prev.providerType || prev.providerType === 'custom') && prev.baseUrl.trim()
          ? inferProviderTypeFromBaseUrl(prev.baseUrl)
          : prev.providerType) ?? prev.providerType;
      const nextProtocol = normalizeApiProtocolForProviderType(prev.apiProtocol, nextProviderType, {
        baseUrl: prev.baseUrl,
        supportsOpenAIResponses: prev.supportsOpenAIResponses,
      });
      const nextSupportsOpenAIResponses = protocolImpliesResponsesSupport(nextProtocol);
      if (nextProtocol === prev.apiProtocol && nextSupportsOpenAIResponses === !!prev.supportsOpenAIResponses) {
        return prev;
      }
      return {
        ...prev,
        apiProtocol: nextProtocol,
        supportsOpenAIResponses: nextSupportsOpenAIResponses,
      };
    });
  }, [formData.providerType, formData.baseUrl]);

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
        <Select
          value={formData.providerType || 'custom'}
          onValueChange={(val) => {
            const nextProtocol = defaultApiProtocolForProvider(val, { baseUrl: formData.baseUrl });
            setProtocolManuallySelected(false);
            setFormData(prev => ({
              ...prev,
              providerType: val,
              apiProtocol: nextProtocol,
              supportsOpenAIResponses: protocolImpliesResponsesSupport(nextProtocol),
            }));
          }}
        >
          <SelectTrigger className="mt-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerTypeOptions.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey, { defaultValue: option.defaultLabel })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={protocolSelectId}>{t('settings:vendor_modal.protocol_label')}</Label>
        <Select
          value={selectedProtocol ?? defaultApiProtocolForProvider(effectiveProviderType, { baseUrl: formData.baseUrl, supportsOpenAIResponses: formData.supportsOpenAIResponses })}
          onValueChange={(val) => {
            setProtocolManuallySelected(true);
            const nextProtocol = normalizeApiProtocolForProviderType(val as ApiProtocol, effectiveProviderType, {
              baseUrl: formData.baseUrl,
              supportsOpenAIResponses: protocolImpliesResponsesSupport(val as ApiProtocol),
            });
            setFormData(prev => ({
              ...prev,
              apiProtocol: nextProtocol,
              supportsOpenAIResponses: protocolImpliesResponsesSupport(nextProtocol),
            }));
          }}
        >
          <SelectTrigger className="mt-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {protocolOptions.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {protocolOptions.length > 1 && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('settings:vendor_modal.protocol_hint')}
          </p>
        )}
      </div>
      <div>
        <Label htmlFor={baseUrlInputId} className="inline-flex items-center gap-1.5">
          <LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('settings:vendor_modal.base_url_label')}</span>
        </Label>
        <Input
          id={baseUrlInputId}
          value={formData.baseUrl}
          onChange={e => {
            const baseUrl = e.target.value;
            setFormData(prev => {
              if (protocolManuallySelected || (prev.providerType && prev.providerType !== 'custom')) {
                return { ...prev, baseUrl };
              }
              const inferredProvider = inferProviderTypeFromBaseUrl(baseUrl) ?? prev.providerType;
              const nextProtocol = defaultApiProtocolForProvider(inferredProvider, { baseUrl });
              return {
                ...prev,
                baseUrl,
                apiProtocol: nextProtocol,
                supportsOpenAIResponses: protocolImpliesResponsesSupport(nextProtocol),
              };
            });
          }}
          placeholder="https://api.openai.com/v1"
          className="mt-2 font-mono"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="vendor-max-tokens-limit">
            {t('settings:vendor_modal.max_tokens_limit_label')}
          </Label>
          <Input
            id="vendor-max-tokens-limit"
            type="number"
            min={1}
            step={1}
            value={formData.maxTokensLimit ?? ''}
            onChange={event => setFormData(prev => ({
              ...prev,
              maxTokensLimit: event.target.value
                ? Math.max(1, Math.trunc(Number(event.target.value)))
                : undefined,
            }))}
            placeholder={t('settings:vendor_modal.optional_placeholder')}
            className="mt-2"
          />
        </div>
        <div>
          <Label htmlFor="vendor-default-timeout">
            {t('settings:vendor_modal.timeout_ms_label')}
          </Label>
          <Input
            id="vendor-default-timeout"
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={formData.defaultTimeoutMs ?? ''}
            onChange={event => setFormData(prev => ({
              ...prev,
              defaultTimeoutMs: event.target.value
                ? Math.min(120000, Math.max(1000, Math.trunc(Number(event.target.value))))
                : undefined,
            }))}
            placeholder="10000"
            className="mt-2"
          />
        </div>
      </div>
      {/* 无需密钥（自搭建后端） */}
      {!formData.isBuiltin && (
        <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Prohibit className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-0.5">
              <Label htmlFor="vendor-no-api-key" className="text-sm font-normal leading-none cursor-pointer">
                {t('settings:vendor_modal.no_api_key_label')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('settings:vendor_modal.no_api_key_desc')}
              </p>
            </div>
          </div>
          <Switch
            id="vendor-no-api-key"
            checked={usesNoApiKey}
            onCheckedChange={(checked) => setFormData(prev => ({
              ...prev,
              noApiKey: checked,
              authMode: checked ? 'none' : 'api_key',
            }))}
          />
        </div>
      )}
      <>
        {!usesNoApiKey && (
          <>
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
                <DsButton
                  type="button"
                  size="sm"
                  variant="outline"
                  className="!text-destructive"
                  onClick={() => {
                    setForceClearApiKey(true);
                    setFormData(prev => ({ ...prev, apiKey: '' }));
                  }}
                  title={t('settings:vendor_modal.clear_api_key_title')}
                >
                  <Trash className="h-3.5 w-3.5" />
                  {t('settings:vendor_modal.clear_api_key')}
                </DsButton>
                {forceClearApiKey && (
                  <div className="text-xs text-destructive">
                    {t('settings:vendor_modal.clear_api_key_warning')}
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <Label>{t('settings:vendor_modal.backup_api_keys_label', { defaultValue: 'Backup API keys' })}</Label>
            <Textarea
              value={apiKeysInput}
              onChange={event => setApiKeysInput(event.target.value)}
              placeholder={t('settings:vendor_modal.backup_api_keys_placeholder', {
                defaultValue: 'One API key per line',
              })}
              className="scroll-area--native mt-2 font-mono"
              rows={3}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('settings:vendor_modal.backup_api_keys_hint', {
                defaultValue: 'Used in order for failover. Masked entries keep the stored keys.',
              })}
            </p>
          </div>
          </>
        )}
        <div>
          <Label className="inline-flex items-center gap-1.5">
            <NotePencil className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('settings:vendor_modal.notes_label')}</span>
          </Label>
          <Textarea
            value={formData.notes ?? ''}
            onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
            placeholder={t('settings:vendor_modal.notes_placeholder')}
            className="scroll-area--native mt-2"
            rows={3}
          />
        </div>
        <div>
          <Label>{t('settings:vendor_modal.headers_label')}</Label>
          <Textarea
            value={headersInput}
            onChange={e => setHeadersInput(e.target.value)}
            placeholder={t('settings:vendor_modal.headers_placeholder')}
            className="scroll-area--native mt-2 font-mono"
            rows={3}
          />
        </div>
      </>
    </div>
  );

  // 嵌入模式：直接返回内容，不使用 Dialog 包裹（标题和保存按钮由全局移动端顶栏提供）
  if (embeddedMode) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-4 py-4 pb-safe">
          {formContent}
        </CustomScrollArea>
      </div>
    );
  }

  // 模态框模式
  return (
    <DsDialog open={open} onOpenChange={onClose} maxWidth="max-w-lg">
        <DsDialogHeader>
          <DsDialogTitle>
            {vendor ? t('settings:vendor_modal.title_edit') : t('settings:vendor_modal.title_new')}
          </DsDialogTitle>
          <DsDialogDescription>{t('settings:vendor_modal.subtitle')}</DsDialogDescription>
        </DsDialogHeader>
        <DsDialogBody overlayScroll>
          {formContent}
        </DsDialogBody>
        <DsDialogFooter className="!border-t-0">
          <DsButton variant="ghost" size="sm" onClick={onClose}>
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton variant="primary" size="sm" onClick={handleSave}>{t('common:actions.save')}</DsButton>
        </DsDialogFooter>
    </DsDialog>
  );
});

VendorConfigModal.displayName = 'VendorConfigModal';
