/**
 * Vendor API Key Management Section
 * 通用供应商API密钥管理组件
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FloppyDisk, Spinner, Trash, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { VendorConfig } from '@/types';
import { ApiKeyField } from './ApiKeyField';
import { normalizePastedApiKey } from '../utils/apiKeyValidation';

interface VendorApiKeySectionProps {
  vendor: VendorConfig;
  onSave: (apiKey: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  showMessage?: (type: 'success' | 'error' | 'info', message: string) => void;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
const TEMPORARY_API_KEY_REVEAL_MS = 8000;

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
  const [hasConfiguredApiKey, setHasConfiguredApiKey] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [pasted, setPasted] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [viewingStoredKey, setViewingStoredKey] = useState(false);

  const lastSavedKeyRef = useRef('');
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVendorIdRef = useRef(vendor.id);

  const clearStatusTimer = () => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  };

  const clearRevealTimer = () => {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  };

  const hideRevealedApiKey = () => {
    clearRevealTimer();
    setShowApiKey(false);
    setViewingStoredKey(false);
    setApiKey(current => (
      current.trim() && current.trim() === lastSavedKeyRef.current
        ? ''
        : current
    ));
  };

  const scheduleRevealHide = () => {
    clearRevealTimer();
    revealTimerRef.current = setTimeout(() => {
      hideRevealedApiKey();
    }, TEMPORARY_API_KEY_REVEAL_MS);
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
    const nextHasConfiguredApiKey = masked || Boolean(nextApiKey);
    const currentDraft = apiKey.trim();
    const shouldPreserveDraft = !vendorChanged && (
      saveStatus === 'dirty' ||
      (masked && currentDraft.length > 0 && currentDraft === lastSavedKeyRef.current)
    );

    setMaskedConfigured(masked);
    setHasConfiguredApiKey(nextHasConfiguredApiKey || (!vendorChanged && lastSavedKeyRef.current.length > 0));
    setConfirmingClear(false);

    if (shouldPreserveDraft) {
      return;
    }

    if (nextApiKey) {
      lastSavedKeyRef.current = nextApiKey;
      setApiKey('');
      setMaskedConfigured(false);
    } else {
      setApiKey('');
      if (vendorChanged || !masked) {
        lastSavedKeyRef.current = '';
      }
    }

    setShowApiKey(false);
    setViewingStoredKey(false);
    setPasted(false);
    setSaveStatus('idle');
    clearStatusTimer();
    clearRevealTimer();
  }, [vendor.apiKey, vendor.id]);

  useEffect(() => {
    return () => {
      clearStatusTimer();
      clearRevealTimer();
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
      setHasConfiguredApiKey(true);
      setApiKey('');
      setShowApiKey(false);
      setViewingStoredKey(false);
      setPasted(false);
      clearRevealTimer();
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
    setViewingStoredKey(false);

    if (!trimmed) {
      setShowApiKey(false);
      clearRevealTimer();
    }

    const isDirty = trimmed && trimmed !== lastSavedKeyRef.current;
    setSaveStatus(isDirty ? 'dirty' : 'idle');

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
      setHasConfiguredApiKey(false);
      setConfirmingClear(false);
      setShowApiKey(false);
      setViewingStoredKey(false);
      setPasted(false);
      clearStatusTimer();
      clearRevealTimer();
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

  const handleRevealToggle = () => {
    if (showApiKey) {
      hideRevealedApiKey();
      return;
    }

    const savedApiKey = lastSavedKeyRef.current;
    if (!apiKey.trim() && savedApiKey) {
      setApiKey(savedApiKey);
      setViewingStoredKey(true);
    } else {
      setViewingStoredKey(false);
    }
    setShowApiKey(true);
    scheduleRevealHide();
  };

  const canRevealApiKey = apiKey.trim().length > 0 || lastSavedKeyRef.current.length > 0;
  const canSave = apiKey.trim().length > 0 && apiKey.trim() !== lastSavedKeyRef.current && !saving;
  const canClearStoredKey = !saving && hasConfiguredApiKey;
  const statusText =
    saveStatus === 'saving'
      ? t('settings:vendor_panel.api_key_saving')
      : saveStatus === 'saved'
        ? t('settings:vendor_panel.api_key_saved')
        : saveStatus === 'error'
          ? t('settings:vendor_panel.api_key_save_failed')
          : saveStatus === 'dirty'
            ? t('settings:vendor_panel.api_key_unsaved')
            : showApiKey && viewingStoredKey
              ? t('settings:vendor_panel.api_key_revealed_temporarily')
              : hasConfiguredApiKey && !apiKey.trim()
              ? t('settings:vendor_panel.api_key_securely_stored')
              : t('settings:vendor_panel.api_key_manual_save_hint');
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
        onPaste={e => {
          const raw = e.clipboardData.getData('text');
          const pasted = normalizePastedApiKey(raw);
          setPasted(true);
          if (pasted !== raw) {
            e.preventDefault();
            handleApiKeyChange(pasted);
          }
        }}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void handleSaveApiKey();
          }
        }}
        placeholder={
          hasConfiguredApiKey && !apiKey.trim()
            ? t('settings:vendor_panel.api_key_configured')
            : t('settings:vendor_panel.api_key_placeholder')
        }
        inputClassName="font-mono"
        revealed={showApiKey}
        canReveal={canRevealApiKey}
        onToggle={handleRevealToggle}
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
        <span>{saveStatus === 'dirty' && pasted ? t('settings:vendor_panel.api_key_pasted_ready') : statusText}</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => {
            void handleSaveApiKey();
          }}
          disabled={!canSave}
          title={t('settings:vendor_panel.save_api_key')}
        >
          {saveStatus === 'saving' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <FloppyDisk className="h-3.5 w-3.5" />}
          {t('settings:vendor_panel.save_api_key')}
        </DsButton>
        <DsButton
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
        </DsButton>
      </div>
    </div>
  );
};
