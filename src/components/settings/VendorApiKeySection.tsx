/**
 * Vendor API Key Management Section
 * 通用供应商API密钥管理组件
 */

import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Eye, EyeOff } from 'lucide-react';
import { Input } from '../ui/shad/Input';
import { NotionButton } from '../ui/NotionButton';
import { useDebounce } from '../../hooks/useDebounce';
import type { VendorConfig } from '../../types';

interface VendorApiKeySectionProps {
  vendor: VendorConfig;
  onSave: (apiKey: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  showMessage?: (type: 'success' | 'error' | 'info', message: string) => void;
}

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
  
  // 防抖保存：用户停止输入 800ms 后才触发保存
  const debouncedApiKey = useDebounce(apiKey, 800);
  // 用于跳过初始化时的保存
  const isInitializedRef = useRef(false);
  const lastSavedKeyRef = useRef('');

  const isMaskedKey = (value: string | undefined | null) => {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed === '***') return true;
    return trimmed.split('').every(c => c === '*');
  };

  // 初始化：如果 vendor 有密钥则回填；若为掩码（***）则显示“已配置”但不回填明文
  useEffect(() => {
    const masked = isMaskedKey(vendor.apiKey);
    setMaskedConfigured(masked);
    if (vendor.apiKey && !masked) {
      setApiKey(vendor.apiKey);
      lastSavedKeyRef.current = vendor.apiKey;
    } else {
      // 掩码或空：不展示明文
      setApiKey('');
      lastSavedKeyRef.current = '';
    }
    // 重置初始化标记，并在下一个 tick 允许自动保存。
    // 不能延迟过久（例如 900ms），否则用户首次输入后若刚好在防抖窗口内结束，
    // 会被误判为“初始化阶段”而跳过保存，导致配置未持久化。
    isInitializedRef.current = false;
    const timer = setTimeout(() => {
      isInitializedRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [vendor.apiKey, vendor.id]);

  // 防抖后自动保存
  useEffect(() => {
    // 跳过初始化阶段
    if (!isInitializedRef.current) {
      return;
    }
    // 如果值为空或与上次保存的值相同，跳过
    if (!debouncedApiKey.trim() || debouncedApiKey === lastSavedKeyRef.current) {
      return;
    }
    
    const saveApiKey = async () => {
      try {
        setSaving(true);
        await onSave(debouncedApiKey.trim());
        lastSavedKeyRef.current = debouncedApiKey.trim();
      } catch (error: unknown) {
        console.error('保存API密钥失败:', error);
        if (showMessage) {
          showMessage('error', t('settings:vendor_panel.api_key_save_failed'));
        }
      } finally {
        setSaving(false);
      }
    };
    
    saveApiKey();
  }, [debouncedApiKey, onSave, showMessage, t]);

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    if (maskedConfigured) {
      setMaskedConfigured(false);
    }
  };

  const handleClearApiKey = async () => {
    try {
      setSaving(true);
      await onClear();
      setApiKey('');
      lastSavedKeyRef.current = ''; // 重置保存记录
      setMaskedConfigured(false);
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

  return (
    <div className="space-y-3">
      <div className="relative">
        <Input
          type={showApiKey ? 'text' : 'password'}
          value={apiKey}
          onChange={e => handleApiKeyChange(e.target.value)}
          placeholder={
            maskedConfigured
              ? t('settings:vendor_panel.api_key_configured')
              : t('settings:vendor_panel.api_key_placeholder')
          }
          className="pr-10 font-mono"
          disabled={saving}
        />
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowApiKey(v => !v)} disabled={saving} className="absolute inset-y-0 right-0 !rounded-none" title={showApiKey ? t('common:hide') : t('common:show')} aria-label={showApiKey ? t('settings:vendor_panel.hide_api_key') : t('settings:vendor_panel.show_api_key')}>
          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </NotionButton>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <NotionButton 
          variant="danger" 
          size="sm"
          onClick={handleClearApiKey} 
          disabled={saving || (!apiKey && !maskedConfigured)}
          title={t('settings:vendor_panel.clear_api_key_title')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('settings:vendor_panel.clear_api_key')}
        </NotionButton>
      </div>
    </div>
  );
};

