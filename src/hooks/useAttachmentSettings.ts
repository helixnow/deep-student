/**
 * 附件设置管理 Hook
 * 管理附件上传的大小限制和类型限制等设置
 * 
 * ★ SSOT 文档：docs/design/file-format-registry.md
 * 支持的文件格式定义请参考上述文档，
 * 修改格式支持时需同步更新文档和其他实现位置。
 */

import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_DOCUMENT_TYPES,
  ATTACHMENT_MAX_SIZE,
  ATTACHMENT_MAX_COUNT,
} from '../chat-v2/core/constants';

export interface AttachmentSettings {
  maxImageSize: number; // 最大图片大小（字节）
  maxFileSize: number; // 最大文件大小（字节）
  maxAttachments: number; // 最大附件数量
  allowedImageTypes: string[]; // 允许的图片类型
  allowedFileTypes: string[]; // 允许的文件类型
}

/**
 * 默认附件设置 - 与 chat-v2/core/constants.ts 保持同步
 * 
 * SSOT (Single Source of Truth) 原则：
 * - 图片类型：与 ATTACHMENT_IMAGE_TYPES 一致
 * - 文档类型：与 ATTACHMENT_DOCUMENT_TYPES 一致
 * - 大小限制：与 ATTACHMENT_MAX_SIZE (50MB) 一致
 */
const DEFAULT_SETTINGS: AttachmentSettings = {
  maxImageSize: 10 * 1024 * 1024, // 10MB
  maxFileSize: ATTACHMENT_MAX_SIZE, // 50MB - 与 constants.ts 和后端 VFS 保持一致
  maxAttachments: ATTACHMENT_MAX_COUNT,
  allowedImageTypes: ATTACHMENT_IMAGE_TYPES,
  allowedFileTypes: ATTACHMENT_DOCUMENT_TYPES,
};

export interface UseAttachmentSettingsReturn {
  settings: AttachmentSettings;
  loading: boolean;
  saveSettings: (settings: Partial<AttachmentSettings>) => Promise<boolean>;
  resetSettings: () => Promise<boolean>;
  getLimitsSummary: () => string;
  formatFileSize: (bytes: number) => string;
}

export function useAttachmentSettings(): UseAttachmentSettingsReturn {
  const [settings, setSettings] = useState<AttachmentSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  // 加载设置
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = await invoke<string | null>('get_setting', { key: 'attachment.settings' }).catch(() => null);
        if (disposed) return;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            setSettings({ ...DEFAULT_SETTINGS, ...parsed });
          } catch {
            setSettings(DEFAULT_SETTINGS);
          }
        }
      } catch {
        if (!disposed) setSettings(DEFAULT_SETTINGS);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, []);

  // 保存设置
  const saveSettings = useCallback(async (newSettings: Partial<AttachmentSettings>): Promise<boolean> => {
    try {
      const merged = { ...settings, ...newSettings };
      await invoke('save_setting', { 
        key: 'attachment.settings', 
        value: JSON.stringify(merged) 
      });
      setSettings(merged);
      return true;
    } catch (error: unknown) {
      console.error('Failed to save attachment settings:', error);
      return false;
    }
  }, [settings]);

  // 重置设置
  const resetSettings = useCallback(async (): Promise<boolean> => {
    try {
      await invoke('save_setting', { 
        key: 'attachment.settings', 
        value: JSON.stringify(DEFAULT_SETTINGS) 
      });
      setSettings(DEFAULT_SETTINGS);
      return true;
    } catch (error: unknown) {
      console.error('Failed to reset attachment settings:', error);
      return false;
    }
  }, []);

  // 格式化文件大小
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }, []);

  // 获取限制摘要
  const getLimitsSummary = useCallback((): string => {
    return `图片: ${formatFileSize(settings.maxImageSize)}, 文件: ${formatFileSize(settings.maxFileSize)}, 最多 ${settings.maxAttachments} 个附件`;
  }, [settings, formatFileSize]);

  return {
    settings,
    loading,
    saveSettings,
    resetSettings,
    getLimitsSummary,
    formatFileSize,
  };
}

export default useAttachmentSettings;
