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
        <ArrowClockwise size={16} className="animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('securityStatus.checking')}</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`flex items-center space-x-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg ${className}`}>
        <Warning size={16} className="text-red-500 dark:text-red-400" />
        <span className="flex-1 text-sm text-red-700 dark:text-red-300">{t('securityStatus.unavailable')}</span>
        <DsButton variant="ghost" size="icon" iconOnly onClick={loadSecurityStatus} title={t('securityStatus.refresh')} aria-label={t('securityStatus.refresh')}>
          <ArrowClockwise size={16} />
        </DsButton>
      </div>
    );
  }

  const usesPrivateFiles = status.storage_kind === 'private_files';
  const getStatusIcon = () => {
    if (!status.keychain_available) {
      return <Warning size={16} className="text-amber-500 dark:text-amber-400" />;
    }
    if (status.migration_completed) {
      return <CheckCircle size={16} className="text-emerald-500 dark:text-emerald-400" />;
    }
    return <Shield size={16} className="text-blue-500 dark:text-blue-400" />;
  };

  const statusTone = !status.keychain_available
    ? {
        bg: 'bg-amber-50 dark:bg-amber-950/30',
        text: 'text-amber-800 dark:text-amber-200',
        border: 'border-amber-200 dark:border-amber-900/50',
      }
    : status.migration_completed
      ? {
          bg: 'bg-emerald-50 dark:bg-emerald-950/30',
          text: 'text-emerald-800 dark:text-emerald-200',
          border: 'border-emerald-200 dark:border-emerald-900/50',
        }
      : {
          bg: 'bg-blue-50 dark:bg-blue-950/30',
          text: 'text-blue-800 dark:text-blue-200',
          border: 'border-blue-200 dark:border-blue-900/50',
        };
  const bgClass = statusTone.bg;
  const textClass = statusTone.text;
  const borderClass = statusTone.border;

  return (
    <div className={`p-4 border rounded-lg ${bgClass} ${borderClass} ${className}`}>
      <div className="flex items-start space-x-3">
        <div className="flex-shrink-0">
          {getStatusIcon()}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className={`text-sm font-medium ${textClass}`}>
              {t('securityStatus.title')}
            </h3>
            <DsButton variant="ghost" size="icon" iconOnly onClick={loadSecurityStatus} disabled={loading} className="!p-1 hover:bg-[var(--overlay-control-hover)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11" title={t('securityStatus.refresh')} aria-label={t('securityStatus.refresh')}>
              <ArrowClockwise className={`w-3 h-3 ${loading ? 'animate-spin' : ''} ${textClass}`} />
            </DsButton>
          </div>
          
          <div className={`mt-1 text-xs ${textClass} space-y-1`}>
            <div className="flex items-center justify-between">
              <span>{t('securityStatus.system_storage')}</span>
              <span className="font-medium">
                {status.keychain_available
                  ? t('securityStatus.available')
                  : t('securityStatus.not_available')}
              </span>
            </div>
            
            <div className="flex items-center justify-between">
              <span>{t('securityStatus.data_migration')}</span>
              <span className="font-medium">
                {status.migration_completed === null
                  ? t('securityStatus.on_access_migration')
                  : status.migration_completed
                    ? t('securityStatus.completed')
                    : t('securityStatus.pending_migration')}
              </span>
            </div>
            
            {(usesPrivateFiles || status.sensitive_keys_count > 0) && (
              <div className="flex items-center justify-between">
                <span>{usesPrivateFiles
                  ? t('securityStatus.encrypted_settings_count')
                  : t('securityStatus.sensitive_keys')}</span>
                <span className="font-medium">{status.sensitive_keys_count}</span>
              </div>
            )}
            
            {status.last_migration_time && (
              <div className="flex items-center justify-between">
                <span>{t('securityStatus.last_migration')}</span>
                <span className="font-medium">
                  {new Date(status.last_migration_time).toLocaleString()}
                </span>
              </div>
            )}
          </div>
          
          {/* 警告信息 */}
          {status.warnings && status.warnings.length > 0 && (
            <div className="mt-2 p-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded text-xs">
              <div className="font-medium text-amber-800 dark:text-amber-200 mb-1">{t('securityStatus.warnings_title')}</div>
              {status.warnings.map((warning, index) => (
                <div key={index} className="text-amber-700 dark:text-amber-300">• {warning}</div>
              ))}
            </div>
          )}
          
          {!status.keychain_available && (
            <div className="mt-3 text-xs text-amber-700 dark:text-amber-300">
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
