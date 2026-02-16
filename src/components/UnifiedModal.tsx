import React, { useEffect } from 'react';
import { NotionDialog } from './ui/NotionDialog';

export interface UnifiedModalProps {
  isOpen: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  contentClassName?: string;
  disableBodyScroll?: boolean;
  closeOnOverlayClick?: boolean;
  /** 可选标题，用于语义化 */
  title?: string;
}

/**
 * 统一模态容器
 * - 基于 shadcn Dialog 实现，默认启用淡入缩放动画
 * - 支持外部控制开关与遮罩点击关闭
 * - 保留原有 disableBodyScroll 行为
 */
export const UnifiedModal: React.FC<UnifiedModalProps> = ({
  isOpen,
  onClose,
  children,
  contentClassName,
  disableBodyScroll = true,
  closeOnOverlayClick = true,
}) => {
  useEffect(() => {
    if (!isOpen || !disableBodyScroll) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, disableBodyScroll]);

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
