/**
 * Vendor API Key Management Section
 * 通用供应商API密钥管理组件
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FloppyDisk, Spinner, Trash, WarningCircle } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import type { VendorConfig } from '@/types';
import { ApiKeyField } from './ApiKeyField';

interface VendorApiKeySectionProps {
  vendor: VendorConfig;
  onSave: (apiKey: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  showMessage?: (type: 'success' | 'error' | 'info', message: string) => void;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export const VendorApiKeySection: React.FC<VendorApiKeySectionProps> = ({
  vendor,
  onSave,
  onClear,
  showMessage,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [maskedConfigured, setMaskedConfigured] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const lastSavedKeyRef = useRef('');
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVendorIdRef = useRef(vendor.id);

  const clearStatusTimer = () => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  };

  const scheduleStatusReset = (nextStatus: 'saved' | 'error', timeoutMs = 2200) => {
    clearStatusTimer();
    setSaveStatus(nextStatus);
    statusTimerRef.current = setTimeout(() => {
      setSaveStatus('idle');
      statusTimerRef.current = null;
    }, timeoutMs);
  };

  const isMaskedKey = (value: string | undefined | null) => {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed === '***') return true;
    return trimmed.split('').every(c => c === '*');
  };

  useEffect(() => {
    const vendorChanged = lastVendorIdRef.current !== vendor.id;
    lastVendorIdRef.current = vendor.id;

    const masked = isMaskedKey(vendor.apiKey);
    const nextApiKey = masked ? '' : vendor.apiKey?.trim() ?? '';
    const currentDraft = apiKey.trim();
    const shouldPreserveDraft = !vendorChanged && (
      saveStatus === 'dirty' ||
      (masked && currentDraft.length > 0 && currentDraft === lastSavedKeyRef.current)
    );

    setMaskedConfigured(masked);
    setConfirmingClear(false);

    if (shouldPreserveDraft) {
      return;
    }

    if (nextApiKey) {
      setApiKey(nextApiKey);
      lastSavedKeyRef.current = nextApiKey;
      setMaskedConfigured(false);
    } else {
      setApiKey('');
      if (vendorChanged || !masked) {
        lastSavedKeyRef.current = '';
      }
    }

    setShowApiKey(false);
    setSaveStatus('idle');
    clearStatusTimer();
  }, [vendor.apiKey, vendor.id]);

  useEffect(() => {
    return () => {
      clearStatusTimer();
    };
  }, []);

  const handleSaveApiKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed || trimmed === lastSavedKeyRef.current) {
      return;
    }

    try {
      setSaving(true);
      clearStatusTimer();
      setSaveStatus('saving');
      await onSave(trimmed);
      lastSavedKeyRef.current = trimmed;
      setMaskedConfigured(false);
      scheduleStatusReset('saved');
      if (showMessage) {
        showMessage('success', t('settings:vendor_panel.api_key_saved'));
      }
    } catch (error: unknown) {
      console.error('保存API密钥失败:', error);
      scheduleStatusReset('error', 3200);
      if (showMessage) {
        showMessage('error', t('settings:vendor_panel.api_key_save_failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleApiKeyChange = (value: string) => {
    const trimmed = value.trim();
    setApiKey(value);
    setConfirmingClear(false);
    clearStatusTimer();

    if (!trimmed) {
      setShowApiKey(false);
    }
    if (maskedConfigured) {
      setMaskedConfigured(false);
    }

    setSaveStatus(trimmed && trimmed !== lastSavedKeyRef.current ? 'dirty' : 'idle');
  };

  const handleClearApiKey = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }

    try {
      setSaving(true);
      await onClear();
      setApiKey('');
      lastSavedKeyRef.current = '';
      setMaskedConfigured(false);
      setConfirmingClear(false);
      setShowApiKey(false);
      clearStatusTimer();
      setSaveStatus('idle');
      if (showMessage) {
        showMessage('success', t('settings:vendor_panel.api_key_cleared'));
      }
    } catch (error: unknown) {
      console.error('清除API密钥失败:', error);
      if (showMessage) {
        showMessage('error', t('settings:vendor_panel.api_key_clear_failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const canRevealApiKey = apiKey.trim().length > 0;
  const canSave = apiKey.trim().length > 0 && apiKey.trim() !== lastSavedKeyRef.current && !saving;
  const canClearStoredKey = saving || maskedConfigured || lastSavedKeyRef.current.length > 0;
  const statusText =
    saveStatus === 'saving'
      ? t('settings:vendor_panel.api_key_saving', { defaultValue: '正在保存…' })
      : saveStatus === 'saved'
        ? t('settings:vendor_panel.api_key_saved')
        : saveStatus === 'error'
          ? t('settings:vendor_panel.api_key_save_failed')
          : saveStatus === 'dirty'
            ? t('settings:vendor_panel.api_key_unsaved', { defaultValue: '有未保存的更改' })
            : maskedConfigured && !apiKey.trim()
              ? t('settings:vendor_panel.api_key_securely_stored', { defaultValue: '已安全保存，下次无需重新输入' })
              : t('settings:vendor_panel.api_key_manual_save_hint', { defaultValue: '粘贴或输入后，点击保存' });
  const statusToneClassName =
    saveStatus === 'error'
      ? 'text-destructive'
      : saveStatus === 'saved'
        ? 'text-green-600 dark:text-green-400'
        : saveStatus === 'dirty'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-muted-foreground';

  return (
    <div className="space-y-3">
      <ApiKeyField
        value={apiKey}
        onChange={e => handleApiKeyChange(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void handleSaveApiKey();
          }
        }}
        placeholder={
          maskedConfigured
            ? t('settings:vendor_panel.api_key_configured')
            : t('settings:vendor_panel.api_key_placeholder')
        }
        inputClassName="font-mono"
        revealed={showApiKey}
        canReveal={canRevealApiKey}
        onToggle={() => setShowApiKey(v => !v)}
        showLabel={t('settings:vendor_panel.show_api_key')}
        hideLabel={t('settings:vendor_panel.hide_api_key')}
      />
      <div
        className={['flex items-center gap-2 text-xs transition-colors', statusToneClassName].join(' ')}
        aria-live="polite"
      >
        {saveStatus === 'saving' && <Spinner className="h-3.5 w-3.5 animate-spin" />}
        {saveStatus === 'saved' && <Check className="h-3.5 w-3.5" />}
        {saveStatus === 'error' && <WarningCircle className="h-3.5 w-3.5" />}
        <span>{statusText}</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <NotionButton
          variant="primary"
          size="sm"
          onClick={() => {
            void handleSaveApiKey();
          }}
          disabled={!canSave}
          title={t('common:actions.save')}
        >
          {saveStatus === 'saving' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <FloppyDisk className="h-3.5 w-3.5" />}
          {t('common:actions.save')}
        </NotionButton>
        <NotionButton
          variant="danger"
          size="sm"
          onClick={handleClearApiKey}
          disabled={!canClearStoredKey}
          title={t('settings:vendor_panel.clear_api_key_title')}
        >
          <Trash className="h-3.5 w-3.5" />
          {confirmingClear
            ? t('settings:vendor_panel.clear_api_key_confirm')
            : t('settings:vendor_panel.clear_api_key')}
        </NotionButton>
      </div>
    </div>
  );
};
