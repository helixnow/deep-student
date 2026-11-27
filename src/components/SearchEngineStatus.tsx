import React, { useState, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  CircleNotch,
  XCircle,
  Warning,
  Clock,
  Lightning,
  Globe
} from '@phosphor-icons/react';

interface EngineStatus {
  id: string;
  name: string;
  status: 'available' | 'unavailable' | 'testing' | 'unknown';
  last_check?: string;
  error_message?: string;
  response_time?: number;
}

interface SearchEngineStatusProps {
  engines: Array<{
    id: string;
    name: string;
    enabled: boolean;
  }>;
  onStatusUpdate?: (statuses: EngineStatus[]) => void;
}

export const SearchEngineStatus: React.FC<SearchEngineStatusProps> = ({
  engines,
  onStatusUpdate
}) => {
  const { t } = useTranslation('settings');
  const [statuses, setStatuses] = useState<EngineStatus[]>([]);
  const [testing, setTesting] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState<string | null>(null);

  // 初始化状态
  useEffect(() => {
    const initialStatuses = engines.map(engine => ({
      id: engine.id,
      name: engine.name,
      status: engine.enabled ? 'unknown' : 'unavailable' as const,
      last_check: undefined,
      error_message: engine.enabled ? undefined : t('searchEngine.notConfigured'),
      response_time: undefined,
    }));
    setStatuses(initialStatuses as EngineStatus[]);
  }, [engines, t]);

  // 测试单个引擎
  const testEngine = async (engineId: string): Promise<EngineStatus> => {
    try {
      const result = await invoke<{ok: boolean, message: string, response_time?: number}>('test_search_engine', {
        engine: engineId
      });
      
      return {
        id: engineId,
        name: engines.find(e => e.id === engineId)?.name || engineId,
        status: result.ok ? 'available' : 'unavailable',
        last_check: new Date().toISOString(),
        error_message: result.ok ? undefined : result.message,
        response_time: result.response_time,
      };
    } catch (error: unknown) {
      return {
        id: engineId,
        name: engines.find(e => e.id === engineId)?.name || engineId,
        status: 'unavailable',
        last_check: new Date().toISOString(),
        error_message: t('searchEngine.testFailed', { error: String(error) }),
        response_time: undefined,
      };
    }
  };

  // 测试所有引擎
  const testAllEngines = async () => {
    setTesting(true);
    const enabledEngines = engines.filter(e => e.enabled);
    
    try {
      // 更新测试中状态
      setStatuses(prev => prev.map(status => ({
        ...status,
        status: enabledEngines.find(e => e.id === status.id) ? 'testing' : status.status
      })));

      // 并行测试所有引擎
      const testPromises = enabledEngines.map(engine => testEngine(engine.id));
      const testResults = await Promise.all(testPromises);
      
      // 更新状态
      const newStatuses = statuses.map(status => {
        const testResult = testResults.find(r => r.id === status.id);
        return testResult || status;
      });
      
      setStatuses(newStatuses);
      setLastCheckTime(new Date().toISOString());
      onStatusUpdate?.(newStatuses);
      
    } catch (error: unknown) {
      console.error('Failed to test engines:', error);
    } finally {
      setTesting(false);
    }
  };

  const getStatusIcon = (status: EngineStatus['status'], size = 'w-4 h-4') => {
    switch (status) {
      case 'available':
        return <CheckCircle className={`${size} text-success`} aria-hidden="true" />;
      case 'unavailable':
        return <XCircle className={`${size} text-destructive`} aria-hidden="true" />;
      case 'testing':
        return <CircleNotch className={`${size} text-info animate-spin motion-reduce:animate-none`} aria-hidden="true" />;
      default:
        return <Warning className={`${size} text-muted-foreground`} aria-hidden="true" />;
    }
  };

  const getStatusColor = (status: EngineStatus['status']) => {
    switch (status) {
      case 'available':
        return 'bg-success/10 text-success border-success/30';
      case 'unavailable':
        return 'bg-destructive/10 text-destructive border-destructive/30';
      case 'testing':
        return 'bg-info/10 text-info border-info/30';
      default:
        return 'bg-muted text-muted-foreground border-border';
    }
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return t('searchEngine.justNow');
    if (diffMins < 60) return t('searchEngine.minutesAgo', { count: diffMins });
    if (diffMins < 1440) return t('searchEngine.hoursAgo', { count: Math.floor(diffMins / 60) });
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      {/* 控制面板 */}
      <div className="flex items-center justify-between p-3 bg-muted/50 border border-border rounded-lg">
        <div className="flex items-center space-x-2">
          <Globe size={16} className="text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">{t('searchEngine.title')}</span>
          {lastCheckTime && (
            <span className="text-xs text-muted-foreground">
              {t('searchEngine.lastCheck', { time: formatTime(lastCheckTime) })}
            </span>
          )}
        </div>

        <DsButton
          variant="default"
          size="sm"
          onClick={testAllEngines}
          disabled={testing || engines.filter(e => e.enabled).length === 0}
        >
          {testing ? (
            <CircleNotch size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Lightning size={16} aria-hidden="true" />
          )}
          <span>{testing ? t('searchEngine.testing') : t('searchEngine.testAvailability')}</span>
        </DsButton>
      </div>

      {/* 引擎状态列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {statuses.map(status => (
          <div
            key={status.id}
            className={`p-3 border rounded-lg ${getStatusColor(status.status)}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                {getStatusIcon(status.status)}
                <span className="font-medium text-sm">{status.name}</span>
              </div>
              {status.response_time && (
                <span className="text-xs opacity-75">
                  {status.response_time}ms
                </span>
              )}
            </div>
            
            {status.error_message && (
              <div className="text-xs opacity-75 mb-1">
                {status.error_message}
              </div>
            )}
            
            {status.last_check && (
              <div className="flex items-center space-x-1 text-xs opacity-75">
                <Clock size={12} />
                <span>{formatTime(status.last_check)}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 摘要统计 */}
      <div className="flex items-center justify-center space-x-6 p-3 bg-muted/50 border border-border rounded-lg text-sm text-foreground">
        <div className="flex items-center space-x-1">
          <CheckCircle size={16} className="text-success" aria-hidden="true" />
          <span>{t('searchEngine.available')}: {statuses.filter(s => s.status === 'available').length}</span>
        </div>
        <div className="flex items-center space-x-1">
          <XCircle size={16} className="text-destructive" aria-hidden="true" />
          <span>{t('searchEngine.unavailable')}: {statuses.filter(s => s.status === 'unavailable').length}</span>
        </div>
        <div className="flex items-center space-x-1">
          <Warning size={16} className="text-muted-foreground" aria-hidden="true" />
          <span>{t('searchEngine.untested')}: {statuses.filter(s => s.status === 'unknown').length}</span>
        </div>
      </div>
    </div>
  );
};
