import React, { useState, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Clock, 
  RefreshCw,
  Zap,
  Globe
} from 'lucide-react';

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
      error_message: engine.enabled ? undefined : t('searchEngine.notConfigured', '未配置API密钥'),
      response_time: undefined,
    }));
    setStatuses(initialStatuses as EngineStatus[]);
  }, [engines]);

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
        error_message: t('searchEngine.testFailed', '测试失败: {{error}}', { error: String(error) }),
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
        return <CheckCircle className={`${size} text-green-500`} />;
      case 'unavailable':
        return <XCircle className={`${size} text-red-500`} />;
      case 'testing':
        return <RefreshCw className={`${size} text-blue-500 animate-spin`} />;
      default:
        return <AlertTriangle className={`${size} text-muted-foreground`} />;
    }
  };

  const getStatusColor = (status: EngineStatus['status']) => {
    switch (status) {
      case 'available':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'unavailable':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'testing':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      default:
        return 'bg-muted text-muted-foreground border-border';
    }
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return t('searchEngine.justNow', '刚刚');
    if (diffMins < 60) return t('searchEngine.minutesAgo', '{{count}}分钟前', { count: diffMins });
    if (diffMins < 1440) return t('searchEngine.hoursAgo', '{{count}}小时前', { count: Math.floor(diffMins / 60) });
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      {/* 控制面板 */}
      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
        <div className="flex items-center space-x-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{t('searchEngine.title', '搜索引擎状态')}</span>
          {lastCheckTime && (
            <span className="text-xs text-muted-foreground">
              {t('searchEngine.lastCheck', '上次检测: {{time}}', { time: formatTime(lastCheckTime) })}
            </span>
          )}
        </div>
        
        <NotionButton variant="primary" size="sm" onClick={testAllEngines} disabled={testing || engines.filter(e => e.enabled).length === 0} className="!px-3 !py-1 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {testing ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          <span>{testing ? t('searchEngine.testing', '检测中...') : t('searchEngine.testAvailability', '检测可用性')}</span>
        </NotionButton>
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
                <Clock className="w-3 h-3" />
                <span>{formatTime(status.last_check)}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 摘要统计 */}
      <div className="flex items-center justify-center space-x-6 p-3 bg-gray-50 rounded-lg text-sm">
        <div className="flex items-center space-x-1">
          <CheckCircle className="w-4 h-4 text-green-500" />
          <span>{t('searchEngine.available', '可用')}: {statuses.filter(s => s.status === 'available').length}</span>
        </div>
        <div className="flex items-center space-x-1">
          <XCircle className="w-4 h-4 text-red-500" />
          <span>{t('searchEngine.unavailable', '不可用')}: {statuses.filter(s => s.status === 'unavailable').length}</span>
        </div>
        <div className="flex items-center space-x-1">
          <AlertTriangle className="w-4 h-4 text-muted-foreground" />
          <span>{t('searchEngine.untested', '未检测')}: {statuses.filter(s => s.status === 'unknown').length}</span>
        </div>
      </div>
    </div>
  );
};
