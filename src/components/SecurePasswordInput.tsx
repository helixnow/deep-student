import React, { useState, useCallback } from 'react';
import { Shield, Copy, Check } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { ApiKeyField } from '@/features/settings/components/ApiKeyField';

interface SecurePasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** 是否为敏感键：开启后显示加密徽章，并在隐藏状态下禁用复制 */
  isSensitive?: boolean;
}

export const SecurePasswordInput: React.FC<SecurePasswordInputProps> = ({
  value,
  onChange,
  placeholder,
  className,
  disabled = false,
  isSensitive = false,
}) => {
  const { t } = useTranslation('common');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);

  const canReveal = value.trim().length > 0;
  const copyBlockedBySensitivity = isSensitive && !showPassword;
  const copyDisabled = disabled || copyBlockedBySensitivity || !value;

  const handleCopy = useCallback(async () => {
    if (copyDisabled) return;
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.warn('Failed to copy to clipboard:', err);
    }
  }, [value, copyDisabled]);

  const copyTitle = copyBlockedBySensitivity
    ? t('securePassword.showToCopy')
    : copied
      ? t('securePassword.copied')
      : t('actions.copy');

  const copyButton = value ? (
    // eslint-disable-next-line ds-components/no-native-button -- Input adornment needs exact height/edge control to align with the reveal toggle inside ApiKeyField shell.
    <button
      type="button"
      onClick={handleCopy}
      disabled={copyDisabled}
      aria-label={t('actions.copy')}
      title={copyTitle}
      className="api-key-field__action"
    >
      {copied ? (
        <Check className="api-key-field__icon text-green-600" />
      ) : (
        <Copy className="api-key-field__icon" />
      )}
    </button>
  ) : null;

  return (
    <div className={className}>
      <ApiKeyField
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        revealed={showPassword}
        canReveal={canReveal}
        onToggle={() => setShowPassword((prev) => !prev)}
        showLabel={t('securePassword.showPassword')}
        hideLabel={t('securePassword.hidePassword')}
        inputClassName="font-mono"
        autoComplete="new-password"
        inputMode={showPassword ? 'text' : undefined}
        extraActions={copyButton}
/>

      {isSensitive && (
        <div className="mt-1 flex items-center text-xs text-green-600">
          <Shield size={12} className="mr-1" />
          <span>{t('securePassword.encryptedInSecureArea')}</span>
        </div>
      )}
    </div>
  );
};
