import { useState, useEffect, useRef } from 'react';
import { getSetting } from '@/utils/settingsApi';
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
import {
  CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY,
  DEFAULT_CHAT_THREAD_WIDTH_RATIO,
  applyThreadWidthRatioToDocument,
  normalizeThreadWidthRatio,
} from '../config/threadWidthConfig';
import { UI_ZOOM_STORAGE_KEY, clampZoom } from '../features/settings/components/constants';
import { t } from '../utils/i18n';
import { showGlobalNotification } from '../components/UnifiedNotification';
import { setPendingSettingsTab } from '../utils/pendingSettingsTab';
import { syncSystemNotificationPolicyFromBackend } from '../utils/systemNotification';
import { APP_EVENTS, dispatchAppEvent } from '../events';

let inFlightFontSettingInit: Promise<void> | null = null;

// 初始化字体设置（应用启动时调用；轻量窗口入口也复用，见 main.tsx）
// 并行读取字体与字号设置，并合并并发调用，避免串行 IPC 瀑布。
export const initializeFontSetting = (): Promise<void> => {
  if (inFlightFontSettingInit) return inFlightFontSettingInit;
  const task = (async () => {
    const [fontResult, sizeResult] = await Promise.allSettled([
      getSetting(UI_FONT_STORAGE_KEY),
      getSetting(UI_FONT_SIZE_STORAGE_KEY),
    ]);

    if (fontResult.status === 'fulfilled') {
      applyFontToDocument(fontResult.value || DEFAULT_UI_FONT);
    } else {
      applyFontToDocument(DEFAULT_UI_FONT);
    }

    if (sizeResult.status === 'fulfilled') {
      const parsed = sizeResult.value == null ? NaN : parseFloat(sizeResult.value);
      applyFontSizeToDocument(clampFontSize(parsed));
    } else {
      applyFontSizeToDocument(DEFAULT_UI_FONT_SIZE);
    }
  })().finally(() => {
    if (inFlightFontSettingInit === task) {
      inFlightFontSettingInit = null;
    }
  });
  inFlightFontSettingInit = task;
  return task;
};

// 初始化会话宽度比例（覆写数字变量 --chat-thread-ratio；读取失败保持 :root 默认 80）
const initializeThreadWidthRatio = async () => {
  try {
    const raw = await getSetting(CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY);
    if (raw == null || raw === '') return;
    applyThreadWidthRatioToDocument(normalizeThreadWidthRatio(raw));
  } catch {
    // 首次使用或读取失败：保持 :root 默认值
  }
};

// 初始化 UI 缩放（应用启动时恢复保存的缩放值；webview.setZoom 仅在 Tauri 下可用）
const initializeZoomSetting = async () => {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const storedValue = await getSetting(UI_ZOOM_STORAGE_KEY);
    if (storedValue == null || storedValue === '') return;
    const zoom = clampZoom(parseFloat(storedValue));
    const webview = await getCurrentWebview();
    await webview.setZoom(zoom);
  } catch {
    // 首次使用或读取失败：保持默认 100%
  }
};

const applyThinkingAutoCollapseFromRaw = (raw: string | null | undefined): void => {
  const enabled = String(raw ?? '').trim() !== 'false';
  document.documentElement.setAttribute('data-auto-collapse-thinking', String(enabled));
  window.dispatchEvent(
    new CustomEvent('systemSettingsChanged', {
      detail: { settingKey: 'thinking.auto_collapse', value: enabled },
    }),
  );
};

// 初始化思维链自动折叠开关（消费方读取 <html> 上的 data-auto-collapse-thinking 属性，
// 之前只有打开设置页时才会写入该属性，导致关闭状态重启后不恢复）
const initializeThinkingAutoCollapseSetting = async () => {
  try {
    const raw = await getSetting('thinking.auto_collapse');
    applyThinkingAutoCollapseFromRaw(raw);
  } catch {
    // 读取失败：属性缺失时消费方默认按 true 处理，与设置页默认值一致
  }
};

const FONT_SCALE_FALLBACK_STORAGE_KEY = 'app-font-size-scale';

/**
 * 监听其他标签页对 localStorage 中外观/排版设置的改动并实时应用到当前文档
 * （主题模式/色板由 useTheme.ts 的 storage 监听负责）。
 */
export function installCrossTabSettingsSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    const key = event.key;
    const readValue = (storageKey: string): string | null => {
      if (key === storageKey) return event.newValue;
      try {
        return window.localStorage.getItem(storageKey);
      } catch {
        return null;
      }
    };
    if (key === null || key === UI_FONT_STORAGE_KEY) {
      applyFontToDocument(readValue(UI_FONT_STORAGE_KEY) || DEFAULT_UI_FONT);
    }
    if (key === null || key === UI_FONT_SIZE_STORAGE_KEY || key === FONT_SCALE_FALLBACK_STORAGE_KEY) {
      const rawScale =
        key === FONT_SCALE_FALLBACK_STORAGE_KEY
          ? event.newValue
          : (readValue(UI_FONT_SIZE_STORAGE_KEY) ?? readValue(FONT_SCALE_FALLBACK_STORAGE_KEY));
      const parsed = rawScale == null ? DEFAULT_UI_FONT_SIZE : clampFontSize(parseFloat(rawScale));
      applyFontSizeToDocument(parsed);
    }
    if (key === null || key === CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY) {
      const rawRatio = readValue(CHAT_THREAD_WIDTH_RATIO_STORAGE_KEY);
      applyThreadWidthRatioToDocument(
        rawRatio == null || rawRatio === '' ? DEFAULT_CHAT_THREAD_WIDTH_RATIO : normalizeThreadWidthRatio(rawRatio),
      );
    }
    if (key === null || key === 'thinking.auto_collapse') {
      applyThinkingAutoCollapseFromRaw(readValue('thinking.auto_collapse'));
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

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

function scheduleDeferredStartupTask(task: () => void, timeoutMs = 1500): () => void {
  if (typeof window === 'undefined') {
    const timer = setTimeout(task, 0);
    return () => clearTimeout(timer);
  }
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof win.requestIdleCallback === 'function') {
    const idleId = win.requestIdleCallback(task, { timeout: timeoutMs });
    return () => {
      win.cancelIdleCallback?.(idleId);
    };
  }
  const timer = window.setTimeout(task, 0);
  return () => window.clearTimeout(timer);
}

export const useAppInitialization = (): UseAppInitializationReturn => {
  // 不再显示覆盖式载入页，但保留这些状态以供顶部状态栏或日志使用
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(100);
  const [currentStep, setCurrentStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<InitializationStep[]>(() => [
    { key: 'config', name: t('init_steps.config'), completed: true },
    { key: 'database', name: t('init_steps.database'), completed: false },
    { key: 'services', name: t('init_steps.services'), completed: true },
    { key: 'ui', name: t('init_steps.ui'), completed: true },
  ]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let activeRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const markDatabaseStep = (completed: boolean, stepError?: string) => {
      if (cancelledRef.current) return;
      setSteps((prev) =>
        prev.map((step) =>
          step.key === 'database' ? { ...step, completed, error: stepError } : step,
        ),
      );
    };

    // 视觉排版设置并行拉取，不阻塞首帧渲染也不触发 App 级联重渲染
    void Promise.allSettled([
      initializeFontSetting(),
      initializeZoomSetting(),
      initializeThinkingAutoCollapseSetting(),
      initializeThreadWidthRatio(),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(result.reason);
        }
      }
    });

    // 非首屏关键检查（通知策略对齐与数据库健康探测）延后到浏览器空闲窗口，
    // 避免与首屏核心数据水合争抢 IPC 通道与主线程。
    const cancelDeferred = scheduleDeferredStartupTask(() => {
      if (cancelledRef.current) return;

      // 系统通知策略：对齐 localStorage 快取与 settings 表
      // （Rust 侧自动化/驻留通知读 settings 表，旧版本只写过 localStorage）
      syncSystemNotificationPolicyFromBackend().catch(console.warn);

      // Step 2: 数据库连接检查（通过 get_setting 实际查询数据库验证连接可用性）
      // 🔧 时序修复：版本更新时数据库可能正在执行迁移，首次检查可能失败。
      // 添加重试机制，避免迁移期间的瞬态失败导致 banner 永久显示。
      void (async () => {
        try {
          await getSetting('app_initialized');
          if (cancelledRef.current) return;
          markDatabaseStep(true);
          setProgress(100);
          setCurrentStep('');
          setIsLoading(false);
          return;
        } catch (err: unknown) {
          if (cancelledRef.current) return;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn('[Init] Database check failed (will retry in background):', errMsg);
          markDatabaseStep(false, errMsg);
          setError(t('messages.error.init_failed'));
        }

        // 后台重试：数据库可能正在迁移，等待迁移完成后自动清除错误
        const retryDelays = [1000, 2000, 3000, 5000, 8000]; // 递增退避，总等待约 19 秒
        for (const delay of retryDelays) {
          if (cancelledRef.current) return;
          await new Promise<void>((resolve) => {
            activeRetryTimer = setTimeout(() => {
              activeRetryTimer = null;
              resolve();
            }, delay);
          });
          if (cancelledRef.current) return;
          try {
            await getSetting('app_initialized');
            if (cancelledRef.current) return;
            // 重试成功：清除错误状态
            console.log('[Init] Database check succeeded on retry, clearing error banner');
            markDatabaseStep(true);
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
                  // 设置页已保活挂载时 pending tab 不会被重新读取：同时直达
                  dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'data-governance' });
                },
              },
            },
          );
        }
      })();
    });

    return () => {
      cancelledRef.current = true;
      cancelDeferred();
      if (activeRetryTimer !== null) {
        clearTimeout(activeRetryTimer);
        activeRetryTimer = null;
      }
    };
  }, []);

  return {
    isLoading,
    progress,
    currentStep,
    steps,
    error,
  };
};
