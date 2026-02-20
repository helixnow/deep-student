import React, { useState, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Eye, EyeOff, Shield, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface SecurePasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
  isSensitive?: boolean; // 是否为敏感键
  showSecurityIndicator?: boolean;
}

export const SecurePasswordInput: React.FC<SecurePasswordInputProps> = ({
  value,
  onChange,
  placeholder,
  label,
  description,
  className = '',
  disabled = false,
  isSensitive = false,
  showSecurityIndicator = true,
}) => {
  const { t } = useTranslation('common');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);

  // 如果是敏感键且有值，显示星号掩码
  const displayValue = isSensitive && value && !showPassword 
    ? '●'.repeat(Math.min(value.length, 16)) 
    : value;

  const handleCopy = useCallback(async () => {
    if (isSensitive && !showPassword) {
      // 敏感键在隐藏状态下不允许复制
      return;
    }
    
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.warn('Failed to copy to clipboard:', err);
    }
  }, [value, isSensitive, showPassword]);

  const toggleVisibility = useCallback(() => {
    setShowPassword(prev => !prev);
  }, []);

  return (
    <div className={`relative ${className}`}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          {isSensitive && showSecurityIndicator && (
            <span title={t('securePassword.secureStorage')}>
              <Shield className="w-3 h-3 text-green-600 inline ml-1" />
            </span>
          )}
        </label>
      )}
      
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={displayValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`
            w-full px-3 py-2 border border-gray-300 rounded-md
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500
            disabled:bg-gray-50 disabled:text-gray-500
            ${isSensitive ? 'pr-20' : 'pr-10'}
            font-mono text-sm
          `}
          autoComplete="new-password"
          inputMode={showPassword ? 'text' : undefined}
        />
        
        <div className="absolute inset-y-0 right-0 flex items-center space-x-1 pr-2">
          {/* 复制按钮 */}
          {value && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} disabled={disabled || (isSensitive && !showPassword)} className={`!p-1 ${(isSensitive && !showPassword) ? 'opacity-30 cursor-not-allowed' : 'hover:text-blue-600'}`} title={isSensitive && !showPassword ? t('securePassword.showToCopy') : copied ? t('securePassword.copied') : t('actions.copy')} aria-label="copy">
              {copied ? (
                <Check className="w-4 h-4 text-green-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </NotionButton>
          )}
          
          {/* 显示/隐藏按钮 */}
          {value && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={toggleVisibility} disabled={disabled} className="!p-1 hover:text-blue-600" title={showPassword ? t('securePassword.hidePassword') : t('securePassword.showPassword')} aria-label="toggle visibility">
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </NotionButton>
          )}
        </div>
      </div>
      
      {description && (
        <p className="mt-1 text-xs text-gray-500">
          {description}
          {isSensitive && showSecurityIndicator && (
            <span className="text-green-600 font-medium ml-1">
              • {t('securePassword.secureStorage')}
            </span>
          )}
        </p>
      )}
      
      {isSensitive && showSecurityIndicator && (
        <div className="mt-1 flex items-center text-xs text-green-600">
          <Shield className="w-3 h-3 mr-1" />
          <span>{t('securePassword.encryptedInSecureArea')}</span>
        </div>
      )}
    </div>
  );
};
