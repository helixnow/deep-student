import { useEffect, useCallback, useMemo } from 'react';
import type { UseSettingsZoomFontDeps, McpToolConfig } from './hookDepsTypes';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getBuiltinServer } from '@/mcp/builtinMcpServer';
import { normalizeMcpToolList } from './mcpUtils';
import {
  UI_FONT_STORAGE_KEY, DEFAULT_UI_FONT, applyFontToDocument,
  UI_FONT_SIZE_STORAGE_KEY, DEFAULT_UI_FONT_SIZE, applyFontSizeToDocument, clampFontSize,
} from '@/config/fontConfig';
import {
  UI_ZOOM_STORAGE_KEY, DEFAULT_UI_ZOOM, clampZoom, formatZoomLabel,
} from './constants';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function useSettingsZoomFont(deps: UseSettingsZoomFontDeps) {
  const { isTauriEnvironment, setZoomLoading, setUiZoom, setZoomSaving, setZoomStatus, t, setFontLoading, setUiFont, setFontSaving, setFontSizeLoading, setUiFontSize, setFontSizeSaving, config } = deps;

  const applyZoomToWebview = useCallback(async (scale: number) => {
    if (!isTauriEnvironment) return;
    const webview = await getCurrentWebview();
    await webview.setZoom(scale);
  }, [isTauriEnvironment]);

  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setZoomLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_ZOOM_STORAGE_KEY }) as string;
        const parsed = clampZoom(parseFloat(storedValue));
        if (!disposed) {
          setUiZoom(parsed);
        }
        if (!disposed) {
          await applyZoomToWebview(parsed);
        }
      } catch {
        // 缩放设置读取失败，回退到默认值（首次使用或存储损坏）
        if (!disposed) {
          setUiZoom(DEFAULT_UI_ZOOM);
        }
      } finally {
        if (!disposed) {
          setZoomLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [applyZoomToWebview, isTauriEnvironment]);

  const handleZoomChange = useCallback(async (value: number) => {
    const normalized = clampZoom(value);
    setUiZoom(normalized);
    if (!isTauriEnvironment) {
      return;
    }
    setZoomSaving(true);
    setZoomStatus({ type: 'idle' });
    try {
      await applyZoomToWebview(normalized);
      await tauriInvoke('save_setting', { key: UI_ZOOM_STORAGE_KEY, value: normalized.toString() });
      setZoomStatus({
        type: 'success',
        message: t('settings:zoom.status_applied', { value: formatZoomLabel(normalized) }),
      });
    } catch (error) {
      setZoomStatus({
        type: 'error',
        message: t('settings:zoom.apply_error', { reason: getErrorMessage(error) }),
      });
    } finally {
      setZoomSaving(false);
    }
  }, [applyZoomToWebview, isTauriEnvironment, t]);

  const handleZoomReset = useCallback(() => {
    void handleZoomChange(DEFAULT_UI_ZOOM);
  }, [handleZoomChange]);

  // 字体设置：初始化加载（applyFontToDocument 从 fontConfig 导入）
  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setFontLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_FONT_STORAGE_KEY }) as string;
        const fontValue = storedValue || DEFAULT_UI_FONT;
        if (!disposed) {
          setUiFont(fontValue);
          applyFontToDocument(fontValue);
        }
      } catch {
        if (!disposed) {
          setUiFont(DEFAULT_UI_FONT);
          applyFontToDocument(DEFAULT_UI_FONT);
        }
      } finally {
        if (!disposed) {
          setFontLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isTauriEnvironment]);

  // 字体设置：处理变更
  const handleFontChange = useCallback(async (value: string) => {
    setUiFont(value);
    applyFontToDocument(value);
    if (!isTauriEnvironment) {
      return;
    }
    setFontSaving(true);
    try {
      await tauriInvoke('save_setting', { key: UI_FONT_STORAGE_KEY, value });
    } catch (error) {
      console.error('Failed to save font setting:', error);
    } finally {
      setFontSaving(false);
    }
  }, [isTauriEnvironment]);

  // 字体设置：重置为默认
  const handleFontReset = useCallback(() => {
    void handleFontChange(DEFAULT_UI_FONT);
  }, [handleFontChange]);

  // 字体大小设置：初始化加载
  useEffect(() => {
    if (!isTauriEnvironment) {
      return;
    }
    let disposed = false;
    setFontSizeLoading(true);
    (async () => {
      try {
        const storedValue = await tauriInvoke('get_setting', { key: UI_FONT_SIZE_STORAGE_KEY }) as string;
        const parsed = clampFontSize(parseFloat(storedValue));
        if (!disposed) {
          setUiFontSize(parsed);
          applyFontSizeToDocument(parsed);
        }
      } catch {
        if (!disposed) {
          setUiFontSize(DEFAULT_UI_FONT_SIZE);
          applyFontSizeToDocument(DEFAULT_UI_FONT_SIZE);
        }
      } finally {
        if (!disposed) {
          setFontSizeLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isTauriEnvironment]);

  // 字体大小设置：处理变更
  const handleFontSizeChange = useCallback(async (value: number) => {
    const normalized = clampFontSize(value);
    setUiFontSize(normalized);
    applyFontSizeToDocument(normalized);
    if (!isTauriEnvironment) {
      return;
    }
    setFontSizeSaving(true);
    try {
      await tauriInvoke('save_setting', { key: UI_FONT_SIZE_STORAGE_KEY, value: normalized.toString() });
    } catch {
      // 静默失败：避免控制台噪音
    } finally {
      setFontSizeSaving(false);
    }
  }, [isTauriEnvironment]);

  // 字体大小设置：重置为默认
  const handleFontSizeReset = useCallback(() => {
    void handleFontSizeChange(DEFAULT_UI_FONT_SIZE);
  }, [handleFontSizeChange]);

  // 🆕 将内置服务器添加到 MCP 服务器列表开头
  const normalizedMcpServers = useMemo((): McpToolConfig[] => {
    const userServers = normalizeMcpToolList(config.mcpTools) as McpToolConfig[];
    const builtinServer = getBuiltinServer();
    const builtinForSettings: McpToolConfig = {
      id: builtinServer.id,
      name: builtinServer.name,
      connected: true,
    };
    return [builtinForSettings, ...userServers];
  }, [config.mcpTools]);

  return { handleZoomChange, handleZoomReset, handleFontChange, handleFontReset, handleFontSizeChange, handleFontSizeReset, normalizedMcpServers };
}
