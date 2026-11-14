import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ScreenPosition } from '@/components/layout';
import type { VendorConfig } from '@/types';
import type { SettingsRightPanelType } from './hookDepsTypes';
import type { McpPolicyModalState, McpToolModalState } from './mcp-editor/types';

/**
 * 右侧滑动面板的统一关闭路径。
 *
 * 返回键与手势滑回共用同一条清理链（避免 dismiss 后 mcpPreview/modelEditor
 * 等状态残留）；从 Settings.tsx 下沉，依赖通过参数注入以保持与改造前一致的
 * 回调顺序。
 */
export function useSettingsPanelDismiss({
  rightPanelType,
  screenPosition,
  setScreenPosition,
  closeRightPanel,
  handleCloseModelEditor,
  setVendorModalOpen,
  setEditingVendor,
  setMcpToolModal,
  setMcpPolicyModal,
  handleClosePreview,
}: {
  rightPanelType: SettingsRightPanelType;
  screenPosition: ScreenPosition;
  setScreenPosition: (value: ScreenPosition) => void;
  closeRightPanel: () => void;
  handleCloseModelEditor: () => void;
  setVendorModalOpen: (open: boolean) => void;
  setEditingVendor: Dispatch<SetStateAction<VendorConfig | null>>;
  setMcpToolModal: Dispatch<SetStateAction<McpToolModalState>>;
  setMcpPolicyModal: Dispatch<SetStateAction<McpPolicyModalState>>;
  handleClosePreview: () => void;
}) {
  const dismissRightPanel = useCallback(() => {
    switch (rightPanelType) {
      case 'modelEditor':
        handleCloseModelEditor();
        break;
      case 'vendorConfig':
        setVendorModalOpen(false);
        setEditingVendor(null);
        closeRightPanel();
        break;
      case 'mcpTool':
        setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
        closeRightPanel();
        break;
      case 'mcpPolicy':
        setMcpPolicyModal(prev => ({ ...prev, open: false }));
        closeRightPanel();
        break;
      case 'mcpPreview':
        handleClosePreview();
        closeRightPanel();
        break;
      default:
        closeRightPanel();
    }
  }, [
    rightPanelType,
    handleCloseModelEditor,
    setVendorModalOpen,
    setEditingVendor,
    closeRightPanel,
    setMcpToolModal,
    setMcpPolicyModal,
    handleClosePreview,
  ]);

  // 手势滑动切屏：从右滑面板滑回时执行与返回键一致的清理，
  // 否则 mcpPreview.open 残留为 true，再次点击「预览」时 effect 不重跑、面板无法滑出
  const handleScreenPositionChange = useCallback((next: ScreenPosition) => {
    if (screenPosition === 'right' && next !== 'right') {
      dismissRightPanel();
      return;
    }
    setScreenPosition(next);
  }, [screenPosition, dismissRightPanel, setScreenPosition]);

  return { dismissRightPanel, handleScreenPositionChange };
}
