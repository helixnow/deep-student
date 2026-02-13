import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  UI_FONT_STORAGE_KEY,
  DEFAULT_UI_FONT,
  applyFontToDocument,
  UI_FONT_SIZE_STORAGE_KEY,
  DEFAULT_UI_FONT_SIZE,
  applyFontSizeToDocument,
  clampFontSize,
} from '../config/fontConfig';
import { t } from '../utils/i18n';
import { showGlobalNotification } from '../components/UnifiedNotification';

// 初始化字体设置（应用启动时调用）
const initializeFontSetting = async () => {
  try {
    const storedValue = await invoke('get_setting', { key: UI_FONT_STORAGE_KEY }) as string;
    const fontValue = storedValue || DEFAULT_UI_FONT;
    applyFontToDocument(fontValue);
  } catch {
    applyFontToDocument(DEFAULT_UI_FONT);
  }
  try {
    const storedValue = await invoke('get_setting', { key: UI_FONT_SIZE_STORAGE_KEY }) as string;
    const fontSizeValue = clampFontSize(parseFloat(storedValue));
    applyFontSizeToDocument(fontSizeValue);
  } catch {
    applyFontSizeToDocument(DEFAULT_UI_FONT_SIZE);
  }
};

interface InitializationStep {
  key: string;
  name: string;
  completed: boolean;
  error?: string;
}

interface UseAppInitializationReturn {
  isLoading: boolean;
  progress: number;
  currentStep: string;
  steps: InitializationStep[];
  error: string | null;
}

export const useAppInitialization = (): UseAppInitializationReturn => {
  // 不再显示覆盖式载入页，但保留这些状态以供顶部状态栏或日志使用
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<InitializationStep[]>([
    { key: 'config', name: t('init_steps.config'), completed: false },
    { key: 'database', name: t('init_steps.database'), completed: false },
    { key: 'services', name: t('init_steps.services'), completed: false },
    { key: 'ui', name: t('init_steps.ui'), completed: false },
  ]);

  const updateStep = (key: string, completed: boolean, error?: string) => {
    setSteps(prev => prev.map(step => 
      step.key === key ? { ...step, completed, error } : step
    ));
  };

  const calculateProgress = (steps: InitializationStep[]) => {
    const completedCount = steps.filter(step => step.completed).length;
    return (completedCount / steps.length) * 100;
  };

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // 🚀 性能优化：移除所有人为延迟，快速完成初始化检查
        
        // Step 1: 配置（同步完成）
        updateStep('config', true);

        // 初始化字体设置（应用启动时加载保存的字体）
        initializeFontSetting().catch(console.warn);

        // Step 2: 数据库连接检查（通过 get_setting 实际查询数据库验证连接可用性）
        try {
          await invoke('get_setting', { key: 'app_initialized' });
          updateStep('database', true);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('Database initialization failed:', errMsg);
          updateStep('database', false, errMsg);
          setError(t('messages.error.init_failed'));
          showGlobalNotification(
            'warning',
            t('init_steps.database'),
            t('messages.error.init_failed') + ': ' + errMsg,
          );
        }

        // Step 3 & 4: 服务和 UI（立即完成）
        updateStep('services', true);
        updateStep('ui', true);
        setProgress(100);

        // 完成初始化
        setCurrentStep('');
        setIsLoading(false);

      } catch (err: unknown) {
        console.error('App initialization failed:', err);
        setError(err instanceof Error ? err.message : t('messages.error.init_failed'));
        setIsLoading(false);
      }
    };

    // 直接初始化，不阻塞首帧渲染
    initializeApp();
  }, []);

  return {
    isLoading,
    progress,
    currentStep,
    steps,
    error
  };
};
