import React from 'react';
import { NotionDialog } from './ui/NotionDialog';

export interface UnifiedModalProps {
  isOpen: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  contentClassName?: string;
  /**
   * @deprecated 无效开关（L-4）：body 在 app.css 已全局 overflow:hidden，
   * 此前的 effect 是纯冗余且多模态并发时会互相覆盖恢复值。保留仅为兼容
   * 既有调用方签名，值被忽略。
   */
  disableBodyScroll?: boolean;
  closeOnOverlayClick?: boolean;
  /** 可选标题，用于语义化 */
  title?: string;
}

/**
 * 统一模态容器
 * - 基于 NotionDialog 实现，默认启用淡入缩放动画（移动端自动 bottom-sheet 化）
 * - 支持外部控制开关与遮罩点击关闭
 */
export const UnifiedModal: React.FC<UnifiedModalProps> = ({
  isOpen,
  onClose,
  children,
  contentClassName,
  closeOnOverlayClick = true,
}) => {
  return (
    <NotionDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && onClose) {
          onClose();
        }
      }}
      closeOnOverlay={closeOnOverlayClick}
      className={contentClassName}
    >
      {children}
    </NotionDialog>
  );
};

export default UnifiedModal;
