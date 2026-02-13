/**
 * Custom hook for managing system settings
 * Extracted from Settings component to reduce complexity
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

// 系统设置接口
export interface SystemSettings {
  autoSave: boolean;
  theme: string;
  language: string;
  enableNotifications: boolean;
  maxChatHistory: number;
  debugMode: boolean;
  enableAnkiConnect: boolean;
  markdownRendererMode: 'legacy' | 'enhanced';
}

// 检查是否在Tauri环境中
const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

// 默认设置 - 强制亮色主题
const DEFAULT_SETTINGS: SystemSettings = {
  autoSave: true,
  theme: 'light', // 强制亮色主题
  language: 'zh-CN',
  enableNotifications: true,
  maxChatHistory: 100,
  debugMode: false,
  enableAnkiConnect: true,
  markdownRendererMode: 'legacy',
};

export const useSystemSettings = () => {
  const [settings, setSettings] = useState<SystemSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载系统设置
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      if (invoke) {
        const settingsKeys = [
          'autoSave',
          'theme',
          'language',
          'enableNotifications',
          'maxChatHistory',
          'debugMode',
          'enableAnkiConnect',
          'markdownRendererMode'
        ];
        
        const settingsPromises = settingsKeys.map(async (key) => {
          try {
            const value = await invoke('get_setting', { key }) as string;
            return { key, value };
          } catch {
            return { key, value: String(DEFAULT_SETTINGS[key as keyof SystemSettings]) };
          }
        });

        const settingsResults = await Promise.all(settingsPromises);
        const loadedSettings: SystemSettings = { ...DEFAULT_SETTINGS };

        for (const { key, value } of settingsResults) {
          const settingKey = key as keyof SystemSettings;
          
          // 类型转换
          switch (settingKey) {
            case 'autoSave':
            case 'enableNotifications':
            case 'debugMode':
            case 'enableAnkiConnect':
              loadedSettings[settingKey] = !['0', 'false', 'False', 'FALSE', 'null', 'undefined', ''].includes((value ?? '').toString());
              break;
            
            case 'maxChatHistory':
              loadedSettings[settingKey] = parseInt(value, 10) || DEFAULT_SETTINGS[settingKey];
              break;

            case 'markdownRendererMode':
              loadedSettings[settingKey] = (value === 'enhanced' ? 'enhanced' : 'legacy');
              break;
            default:
              (loadedSettings as any)[settingKey] = value;
          }
        }

        setSettings(loadedSettings);
      }
    } catch (error: unknown) {
      console.error('加载系统设置失败:', error);
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setLoading(false);
    }
  }, []);

  // 保存单个设置
  const saveSetting = useCallback(async (key: keyof SystemSettings, value: any) => {
    setSaving(true);
    try {
      if (invoke) {
        await invoke('save_setting', { key: key as string, value: String(value) });
        setSettings(prev => ({ ...prev, [key]: value }));
        return true;
      }
      return false;
    } catch (error: unknown) {
      console.error(`保存设置 ${key} 失败:`, error);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // 保存所有设置
  const saveAllSettings = useCallback(async (newSettings: SystemSettings) => {
    setSaving(true);
    try {
      if (invoke) {
        const savePromises = Object.entries(newSettings).map(([key, value]) =>
          invoke('save_setting', { key, value: String(value) })
        );
        
        await Promise.all(savePromises);
        setSettings(newSettings);
        return true;
      }
      return false;
    } catch (error: unknown) {
      console.error('保存系统设置失败:', error);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // 重置设置为默认值
  const resetSettings = useCallback(async () => {
    return await saveAllSettings(DEFAULT_SETTINGS);
  }, [saveAllSettings]);

  // 更新设置（本地状态，不保存）
  const updateSetting = useCallback(<K extends keyof SystemSettings>(
    key: K, 
    value: SystemSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  // 批量更新设置（本地状态，不保存）
  const updateSettings = useCallback((updates: Partial<SystemSettings>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  }, []);

  // 应用主题
  const applyTheme = useCallback(async (theme: string) => {
    const success = await saveSetting('theme', theme);
    // 注意：实际的DOM主题应用由 useTheme hook 统一管理
    return success;
  }, [saveSetting]);

  // 验证设置
  const validateSettings = useCallback((settingsToValidate: Partial<SystemSettings>) => {
    const errors: string[] = [];
    
    if (settingsToValidate.maxChatHistory !== undefined) {
      if (settingsToValidate.maxChatHistory < 10 || settingsToValidate.maxChatHistory > 1000) {
        errors.push('最大聊天历史记录数量必须在10-1000之间');
      }
    }
    
    if (settingsToValidate.theme !== undefined) {
      // 支持所有主题模式
      if (!['light', 'dark', 'auto'].includes(settingsToValidate.theme)) {
        errors.push('主题必须是 light、dark 或 auto');
      }
    }
    
    if (settingsToValidate.language !== undefined) {
      if (!['zh-CN', 'en-US'].includes(settingsToValidate.language)) {
        errors.push('语言必须是zh-CN或en-US');
      }
    }

    if (settingsToValidate.markdownRendererMode !== undefined) {
      if (!['legacy', 'enhanced'].includes(settingsToValidate.markdownRendererMode)) {
        errors.push('Markdown 渲染模式必须是 legacy 或 enhanced');
      }
    }
    
    return errors;
  }, []);

  // 获取设置摘要（用于显示）
  const getSettingsSummary = useCallback(() => {
    return {
      configuredItems: Object.keys(settings).length,
      autoSaveEnabled: settings.autoSave,
      currentTheme: settings.theme,
      debugModeEnabled: settings.debugMode,
      maxHistorySize: settings.maxChatHistory,
      markdownRendererMode: settings.markdownRendererMode
    };
  }, [settings]);

  // 初始化时加载设置
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // 🔧 修复：移除强制亮色主题的逻辑，让 useTheme hook 完全接管主题管理
  // 注意：主题管理现在由 src/hooks/useTheme.ts 统一处理

  return {
    // 状态
    settings,
    loading,
    saving,
    
    // 方法
    loadSettings,
    saveSetting,
    saveAllSettings,
    resetSettings,
    updateSetting,
    updateSettings,
    applyTheme,
    validateSettings,
    getSettingsSummary,
    
    // 便利属性
    isAutoSaveEnabled: settings.autoSave,
    isDarkTheme: false, // 强制禁用暗色主题
    isDebugMode: settings.debugMode,
    markdownRendererMode: settings.markdownRendererMode
  };
};
