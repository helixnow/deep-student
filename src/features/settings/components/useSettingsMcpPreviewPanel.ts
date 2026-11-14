import { useEffect } from 'react';
import type { ScreenPosition } from '@/components/layout';
import type { SettingsRightPanelType } from './hookDepsTypes';

/**
 * P0-4：移动端 MCP 工具/资源预览改走三屏右滑面板（替代 DsDialog）。
 *
 * mcpPreview.open 由 MCP 分区 hook 持有；外壳只把「打开状态」映射到右滑面板，
 * 关闭时回收到中屏。该映射保持改造前的 effect 语义（含 eslint 忽略依赖）。
 */
export function useSettingsMcpPreviewPanel({
  isSmallScreen,
  mcpPreviewOpen,
  rightPanelType,
  setRightPanelType,
  setScreenPosition,
  closeRightPanel,
}: {
  isSmallScreen: boolean;
  mcpPreviewOpen: boolean;
  rightPanelType: SettingsRightPanelType;
  setRightPanelType: (value: SettingsRightPanelType) => void;
  setScreenPosition: (value: ScreenPosition) => void;
  closeRightPanel: () => void;
}) {
  useEffect(() => {
    if (!isSmallScreen) return;
    if (mcpPreviewOpen) {
      setRightPanelType('mcpPreview');
      setScreenPosition('right');
    } else if (rightPanelType === 'mcpPreview') {
      closeRightPanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSmallScreen, mcpPreviewOpen]);
}
