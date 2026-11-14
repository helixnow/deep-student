import { useState } from 'react';
import type { TFunction } from 'i18next';
import useTheme from '@/hooks/useTheme';
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
} from '@/config/fontConfig';
import {
  DEFAULT_UI_ZOOM,
  type ZoomStatusState,
} from './constants';
import type { SystemConfig } from './types';
import { useSettingsZoomFont } from './useSettingsZoomFont';

/**
 * 外观分区（appearance）自有的状态：主题、界面缩放、字体与字号。
 *
 * 这些状态只被 AppearanceTab 消费（主题本身由 useTheme 全局管理），
 * 从 Settings 外壳下沉到这里；useSettingsZoomFont 的读写时序不变。
 * normalizedMcpServers 仍由同一 hook 派生，外壳转交给 MCP 分区使用。
 */
export function useSettingsAppearanceSection({
  t,
  config,
  isTauriEnvironment,
}: {
  t: TFunction;
  config: SystemConfig;
  isTauriEnvironment: boolean;
}) {
  const [uiZoom, setUiZoom] = useState<number>(DEFAULT_UI_ZOOM);
  const [zoomLoading, setZoomLoading] = useState<boolean>(isTauriEnvironment);
  const [zoomSaving, setZoomSaving] = useState(false);
  const [zoomStatus, setZoomStatus] = useState<ZoomStatusState>({ type: 'idle' });
  const [uiFont, setUiFont] = useState<string>(DEFAULT_UI_FONT);
  const [fontLoading, setFontLoading] = useState<boolean>(isTauriEnvironment);
  const [fontSaving, setFontSaving] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<number>(DEFAULT_UI_FONT_SIZE);
  const [fontSizeLoading, setFontSizeLoading] = useState<boolean>(isTauriEnvironment);
  const [fontSizeSaving, setFontSizeSaving] = useState(false);

  const {
    mode: themeMode,
    isSystemDark,
    palette: themePalette,
    customColor,
    setThemeMode,
    setThemePalette,
    setCustomColor,
  } = useTheme();

  const { handleZoomChange, handleZoomReset, handleFontChange, handleFontReset, handleFontSizeChange, handleFontSizeReset, normalizedMcpServers } = useSettingsZoomFont({ isTauriEnvironment, setZoomLoading, setUiZoom, setZoomSaving, setZoomStatus, t, setFontLoading, setUiFont, setFontSaving, setFontSizeLoading, setUiFontSize, setFontSizeSaving, config });

  return {
    uiZoom,
    zoomLoading,
    zoomSaving,
    zoomStatus,
    handleZoomChange,
    handleZoomReset,
    uiFont,
    fontLoading,
    fontSaving,
    handleFontChange,
    handleFontReset,
    uiFontSize,
    fontSizeLoading,
    fontSizeSaving,
    handleFontSizeChange,
    handleFontSizeReset,
    themeMode,
    isSystemDark,
    setThemeMode,
    themePalette,
    setThemePalette,
    customColor,
    setCustomColor,
    normalizedMcpServers,
  };
}
