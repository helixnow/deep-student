import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

interface ConfigStatus {
  config_count: number;
  enabled_count: number;
  has_assignments: boolean;
  needs_recovery: boolean;
}

const ApiConfigRecovery: React.FC = () => {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const result = await invoke<ConfigStatus>('check_api_config_status');
      setStatus(result);
    } catch (error: unknown) {
      console.error(t('check_config_failed'), error);
      setMessage(t('unable_check_status'));
    }
  };

  const handleRestore = async () => {
    setIsRecovering(true);
    setMessage(t('recovering_config'));

    try {
      const result = await invoke<string>('restore_default_api_configs');
      setMessage(result);
      
      // 恢复成功后重新检查状态
      setTimeout(() => {
        checkStatus();
      }, 1000);
      
    } catch (error: unknown) {
      console.error(t('check_config_failed'), error);
      setMessage(t('restore_failed', { error: String(error) }));
    } finally {
      setIsRecovering(false);
    }
  };

  if (!status) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg">
        <div className="animate-pulse">{t('checking_config_status')}</div>
      </div>
    );
  }

  if (!status.needs_recovery) {
    return (
      <div className="p-4 bg-green-50 rounded-lg border border-green-200">
        <h3 className="text-green-800 font-semibold mb-2">{t('config_status_normal')}</h3>
        <div className="text-green-700 text-sm space-y-1">
          <p>{t('labels.configured')}: {status.config_count} {t('labels.api_count')}</p>
          <p>{t('labels.enabled')}: {status.enabled_count} {t('labels.api_count')}</p>
          <p>{t('labels.model_assignment')}: {status.has_assignments ? t('labels.configured') : t('labels.not_configured')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 bg-orange-50 rounded-lg border border-orange-200">
      <h3 className="text-orange-800 font-semibold mb-4 flex items-center">
        <span className="mr-2">⚠️</span>
        {t('config_lost_detected')}
      </h3>
      
      <div className="mb-4 text-orange-700 text-sm space-y-2">
        <p>{t('config_lost_message')}</p>
        <p>{t('restore_templates_intro')}</p>
        <ul className="list-disc list-inside ml-4 space-y-1">
          <li>{t('openai_gpt4')}</li>
          <li>{t('claude_sonnet')}</li>
        </ul>
        <p className="text-xs text-orange-600">
          {t('recovery_warning')}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          onClick={handleRestore}
          disabled={isRecovering}
          className={`px-4 py-2 rounded font-semibold text-white transition-colors ${
            isRecovering 
              ? 'bg-gray-400 cursor-not-allowed' 
              : 'bg-orange-600 hover:bg-orange-700'
          }`}
        >
          {isRecovering ? t('restoring') : t('restore_default_config')}
        </button>
        
        <button
          onClick={checkStatus}
          className="px-4 py-2 rounded border border-orange-300 text-orange-700 hover:bg-orange-100 transition-colors"
        >
          {t('recheck_status')}
        </button>
      </div>

      {message && (
        <div className={`mt-4 p-3 rounded text-sm ${
          message.startsWith('✅') 
            ? 'bg-green-100 text-green-800 border border-green-200'
            : message.startsWith('❌')
            ? 'bg-red-100 text-red-800 border border-red-200'
            : 'bg-blue-100 text-blue-800 border border-blue-200'
        }`}>
          {message}
        </div>
      )}

      <div className="mt-4 text-xs text-orange-600 bg-orange-100 p-3 rounded">
        <p><strong>{t('next_steps')}</strong></p>
        <ol className="list-decimal list-inside mt-1 space-y-1">
          <li>{t('step_1')}</li>
          <li>{t('step_2')}</li>
          <li>{t('step_3')}</li>
          <li>{t('step_4')}</li>
          <li>{t('step_5')}</li>
        </ol>
      </div>
    </div>
  );
};

export default ApiConfigRecovery;
