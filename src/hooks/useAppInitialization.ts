import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  UI_FONT_STORAGE_KEY,
  DEFAULT_UI_FONT,
  applyFontToDocument,
  UI_FONT_SIZE_STORAGE_KEY,
  DEFAULT_UI_FONT_SIZE,
  applyFontSizeToDocument,
  clampFontSize,
} from '../config/fontConfig';
import { UI_ZOOM_STORAGE_KEY, clampZoom } from '../features/settings/components/constants';
import { t } from '../utils/i18n';
import { showGlobalNotification } from '../components/UnifiedNotification';
import { setPendingSettingsTab } from '../utils/pendingSettingsTab';
import { syncSystemNotificationPolicyFromBackend } from '../utils/systemNotification';
import { APP_EVENTS, dispatchAppEvent } from '../events';

// 初始化字体设置（应用启动时调用；轻量窗口入口也复用，见 main.tsx）
export const initializeFontSetting = async () => {
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

// 初始化 UI 缩放（应用启动时恢复保存的缩放值；webview.setZoom 仅在 Tauri 下可用）
const initializeZoomSetting = async () => {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const storedValue = await invoke('get_setting', { key: UI_ZOOM_STORAGE_KEY }) as string | null;
    if (storedValue == null || storedValue === '') return;
    const zoom = clampZoom(parseFloat(storedValue));
    const webview = await getCurrentWebview();
    await webview.setZoom(zoom);
  } catch {
    // 首次使用或读取失败：保持默认 100%
  }
};

// 初始化思维链自动折叠开关（消费方读取 <html> 上的 data-auto-collapse-thinking 属性，
// 之前只有打开设置页时才会写入该属性，导致关闭状态重启后不恢复）
const initializeThinkingAutoCollapseSetting = async () => {
  try {
    const raw = await invoke('get_setting', { key: 'thinking.auto_collapse' }) as string | null;
    const enabled = String(raw ?? '').trim() !== 'false';
    document.documentElement.setAttribute('data-auto-collapse-thinking', String(enabled));
    window.dispatchEvent(
      new CustomEvent('systemSettingsChanged', {
        detail: { settingKey: 'thinking.auto_collapse', value: enabled },
      }),
    );
  } catch {
    // 读取失败：属性缺失时消费方默认按 true 处理，与设置页默认值一致
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
  const cancelledRef = useRef(false);

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
    cancelledRef.current = false;

    const initializeApp = async () => {
      try {
        // 🚀 性能优化：移除所有人为延迟，快速完成初始化检查
        
        // Step 1: 配置（同步完成）
        updateStep('config', true);

        // 初始化字体设置（应用启动时加载保存的字体）
        initializeFontSetting().catch(console.warn);

        // 初始化 UI 缩放与思维链自动折叠（与字体一样从 save_setting 存储读回）
        initializeZoomSetting().catch(console.warn);
        initializeThinkingAutoCollapseSetting().catch(console.warn);

        // 系统通知策略：对齐 localStorage 快取与 settings 表
        // （Rust 侧自动化/驻留通知读 settings 表，旧版本只写过 localStorage）
        syncSystemNotificationPolicyFromBackend().catch(console.warn);

        // Step 2: 数据库连接检查（通过 get_setting 实际查询数据库验证连接可用性）
        // 🔧 时序修复：版本更新时数据库可能正在执行迁移，首次检查可能失败。
        // 添加重试机制，避免迁移期间的瞬态失败导致 banner 永久显示。
        let dbCheckOk = false;
        try {
          await invoke('get_setting', { key: 'app_initialized' });
          dbCheckOk = true;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn('[Init] Database check failed (will retry in background):', errMsg);
          updateStep('database', false, errMsg);
          setError(t('messages.error.init_failed'));
        }

        if (dbCheckOk) {
          updateStep('database', true);
        } else if (!cancelledRef.current) {
          // 后台重试：数据库可能正在迁移，等待迁移完成后自动清除错误
          const retryDelays = [1000, 2000, 3000, 5000, 8000]; // 递增退避，总等待约 19 秒
          (async () => {
            for (const delay of retryDelays) {
              if (cancelledRef.current) return;
              await new Promise(resolve => setTimeout(resolve, delay));
              if (cancelledRef.current) return;
              try {
                await invoke('get_setting', { key: 'app_initialized' });
                // 重试成功：清除错误状态
                console.log('[Init] Database check succeeded on retry, clearing error banner');
                updateStep('database', true);
                setError(null);
                return;
              } catch {
                // 继续重试
              }
            }
            // 所有重试均失败，显示通知提示用户
            if (!cancelledRef.current) {
              showGlobalNotification(
                'warning',
                t('init_steps.database'),
                t('messages.error.init_failed'),
                {
                  action: {
                    label: t('ui.buttons.go_to_settings', { defaultValue: '去设置' }),
                    onClick: () => {
                      setPendingSettingsTab('data-governance');
                      dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
                    },
                  },
                },
              );
            }
          })();
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

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return {
    isLoading,
    progress,
    currentStep,
    steps,
    error
  };
};
