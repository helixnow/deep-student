import React, { useCallback, useState, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Shield, Warning, CheckCircle, ArrowClockwise } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

interface SecurityStatus {
  keychain_available: boolean;
  migration_completed: boolean | null;
  sensitive_keys_count: number;
  last_migration_time?: string | null;
  storage_kind?: 'private_files';
  warnings?: string[];
}

interface SecurityStatusIndicatorProps {
  className?: string;
}

export const SecurityStatusIndicator: React.FC<SecurityStatusIndicatorProps> = ({
  className = '',
}) => {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSecurityStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await invoke<SecurityStatus>('get_security_status'));
    } catch (error: unknown) {
      setStatus(null);
      console.error('Failed to load security status:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSecurityStatus();
  }, [loadSecurityStatus]);

  if (loading) {
    return (
      <div className={`flex items-center space-x-2 p-3 bg-muted/50 rounded-lg ${className}`}>
        <ArrowClockwise size={16} className="animate-spin motion-reduce:animate-none text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('securityStatus.checking')}</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`flex items-center space-x-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg ${className}`}>
        <Warning size={16} className="text-destructive" />
        <span className="flex-1 text-sm text-destructive">{t('securityStatus.unavailable')}</span>
        <DsButton variant="ghost" size="icon" iconOnly onClick={loadSecurityStatus} title={t('securityStatus.refresh')} aria-label={t('securityStatus.refresh')}>
          <ArrowClockwise size={16} />
        </DsButton>
      </div>
    );
  }

  const usesPrivateFiles = status.storage_kind === 'private_files';
  const getStatusIcon = () => {
    if (!status.keychain_available) {
      return <Warning size={16} className="text-warning" />;
    }
    if (status.migration_completed) {
      return <CheckCircle size={16} className="text-success" />;
    }
    return <Shield size={16} className="text-info" />;
  };

  const statusTone = !status.keychain_available
    ? {
        bg: 'bg-warning/10',
        text: 'text-warning',
        border: 'border-warning/30',
      }
    : status.migration_completed
      ? {
          bg: 'bg-success/10',
          text: 'text-success',
          border: 'border-success/30',
        }
      : {
          bg: 'bg-info/10',
          text: 'text-info',
          border: 'border-info/30',
        };
  const bgClass = statusTone.bg;
  const textClass = statusTone.text;
  const borderClass = statusTone.border;

  return (
    <div className={`p-4 border rounded-lg ${bgClass} ${borderClass} ${className}`}>
      <div className="flex items-start space-x-3">
        <div className="shrink-0">
          {getStatusIcon()}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className={`text-sm font-medium ${textClass}`}>
              {t('securityStatus.title')}
            </h3>
            <DsButton variant="ghost" size="icon" iconOnly onClick={loadSecurityStatus} disabled={loading} className="hover:bg-[var(--overlay-control-hover)]" title={t('securityStatus.refresh')} aria-label={t('securityStatus.refresh')}>
              <ArrowClockwise className={`w-3.5 h-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''} ${textClass}`} />
            </DsButton>
          </div>

          <div className="mt-1 text-xs text-foreground/90 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('securityStatus.system_storage')}</span>
              <span className={`font-medium ${textClass}`}>
                {status.keychain_available
                  ? t('securityStatus.available')
                  : t('securityStatus.not_available')}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('securityStatus.data_migration')}</span>
              <span className={`font-medium ${textClass}`}>
                {status.migration_completed === null
                  ? t('securityStatus.on_access_migration')
                  : status.migration_completed
                    ? t('securityStatus.completed')
                    : t('securityStatus.pending_migration')}
              </span>
            </div>

            {(usesPrivateFiles || status.sensitive_keys_count > 0) && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{usesPrivateFiles
                  ? t('securityStatus.encrypted_settings_count')
                  : t('securityStatus.sensitive_keys')}</span>
                <span className="font-medium text-foreground">{status.sensitive_keys_count}</span>
              </div>
            )}

            {status.last_migration_time && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('securityStatus.last_migration')}</span>
                <span className="font-medium text-foreground">
                  {new Date(status.last_migration_time).toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {/* 警告信息 */}
          {status.warnings && status.warnings.length > 0 && (
            <div className="mt-2 p-2 bg-warning/10 border border-warning/30 rounded text-xs">
              <div className="font-medium text-warning mb-1">{t('securityStatus.warnings_title')}</div>
              {status.warnings.map((warning, index) => (
                <div key={index} className="text-foreground/90">• {warning}</div>
              ))}
            </div>
          )}

          {!status.keychain_available && (
            <div className="mt-3 text-xs text-warning">
              {usesPrivateFiles ? t('securityStatus.private_files_storage') : (
                <>
                  <div className="font-medium mb-1">{t('securityStatus.fallback_title')}</div>
                  <div>{t('securityStatus.fallback_line1')}</div>
                  <div>{t('securityStatus.fallback_line2')}</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
