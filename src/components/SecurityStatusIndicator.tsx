import React, { useState, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Shield, AlertTriangle, CheckCircle, RefreshCw, Settings } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

interface SecurityStatus {
  keychain_available: boolean;
  migration_completed: boolean;
  sensitive_keys_count: number;
  last_migration_time?: string;
  warnings?: string[];
}

interface SecurityStatusIndicatorProps {
  className?: string;
}

// 简单的状态缓存，避免频繁的后端调用
const statusCache = {
  data: null as SecurityStatus | null,
  timestamp: 0,
  isValid: () => Date.now() - statusCache.timestamp < 30000, // 30秒缓存
};

export const SecurityStatusIndicator: React.FC<SecurityStatusIndicatorProps> = ({
  className = '',
}) => {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSecurityStatus = async () => {
    try {
      setLoading(true);
      
      // 检查缓存
      if (statusCache.isValid() && statusCache.data) {
        setStatus(statusCache.data);
        setLoading(false);
        return;
      }
      
      const result = await invoke<SecurityStatus>('get_security_status');
      
      // 更新缓存
      statusCache.data = result;
      statusCache.timestamp = Date.now();
      
      setStatus(result);
    } catch (error: unknown) {
      console.error('Failed to load security status:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSecurityStatus();
  }, []);

  if (loading) {
    return (
      <div className={`flex items-center space-x-2 p-3 bg-gray-50 rounded-lg ${className}`}>
        <RefreshCw className="w-4 h-4 animate-spin text-gray-500" />
        <span className="text-sm text-gray-600">{t('securityStatus.checking', '检查安全状态...')}</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`flex items-center space-x-2 p-3 bg-red-50 rounded-lg ${className}`}>
        <AlertTriangle className="w-4 h-4 text-red-500" />
        <span className="text-sm text-red-600">{t('securityStatus.unavailable', '无法获取安全状态')}</span>
      </div>
    );
  }

  const getStatusIcon = () => {
    if (!status.keychain_available) {
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    }
    if (status.migration_completed) {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    return <Shield className="w-4 h-4 text-blue-500" />;
  };

  const getStatusColor = () => {
    if (!status.keychain_available) return 'yellow';
    if (status.migration_completed) return 'green';
    return 'blue';
  };

  const statusColor = getStatusColor();
  const bgClass = `bg-${statusColor}-50`;
  const textClass = `text-${statusColor}-700`;
  const borderClass = `border-${statusColor}-200`;

  return (
    <div className={`p-4 border rounded-lg ${bgClass} ${borderClass} ${className}`}>
      <div className="flex items-start space-x-3">
        <div className="flex-shrink-0">
          {getStatusIcon()}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className={`text-sm font-medium ${textClass}`}>
              {t('securityStatus.title', '安全存储状态')}
            </h3>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={loadSecurityStatus} disabled={loading} className="!p-1 hover:bg-white/50" title={t('securityStatus.refresh', '刷新状态')} aria-label="refresh">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''} ${textClass}`} />
            </NotionButton>
          </div>
          
          <div className={`mt-1 text-xs ${textClass} space-y-1`}>
            <div className="flex items-center justify-between">
              <span>{t('securityStatus.system_storage', '系统安全存储:')}</span>
              <span className="font-medium">
                {status.keychain_available
                  ? t('securityStatus.available', '✓ 可用')
                  : t('securityStatus.not_available', '✗ 不可用')}
              </span>
            </div>
            
            <div className="flex items-center justify-between">
              <span>{t('securityStatus.data_migration', '敏感数据迁移:')}</span>
              <span className="font-medium">
                {status.migration_completed
                  ? t('securityStatus.completed', '✓ 已完成')
                  : t('securityStatus.pending_migration', '⚠ 待迁移')}
              </span>
            </div>
            
            {status.sensitive_keys_count > 0 && (
              <div className="flex items-center justify-between">
                <span>{t('securityStatus.sensitive_keys', '敏感键数量:')}</span>
                <span className="font-medium">{status.sensitive_keys_count}</span>
              </div>
            )}
            
            {status.last_migration_time && (
              <div className="flex items-center justify-between">
                <span>{t('securityStatus.last_migration', '上次迁移:')}</span>
                <span className="font-medium">
                  {new Date(status.last_migration_time).toLocaleString()}
                </span>
              </div>
            )}
          </div>
          
          {/* 警告信息 */}
          {status.warnings && status.warnings.length > 0 && (
            <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs">
              <div className="font-medium text-yellow-800 mb-1">{t('securityStatus.warnings_title', '注意事项:')}</div>
              {status.warnings.map((warning, index) => (
                <div key={index} className="text-yellow-700">• {warning}</div>
              ))}
            </div>
          )}
          
          {!status.keychain_available && (
            <div className="mt-3 text-xs text-yellow-700">
              <div className="font-medium mb-1">{t('securityStatus.fallback_title', '解决方案:')}</div>
              <div>{t('securityStatus.fallback_line1', '• 系统安全存储不可用，将使用数据库回退存储')}</div>
              <div>{t('securityStatus.fallback_line2', '• API密钥将以加密形式存储在本地数据库中')}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
