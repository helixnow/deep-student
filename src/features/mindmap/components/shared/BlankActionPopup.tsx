import React, { useEffect, useRef, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { EyeSlash, Eye, TextB } from '@phosphor-icons/react';

export interface BlankActionPopupProps {
  x: number;
  y: number;
  isAlreadyBlanked: boolean;
  /** 背诵模式：仅挖空；编辑选区：加粗 + 标记挖空 */
  mode?: 'recite' | 'edit';
  /** 当前节点是否已加粗（编辑模式） */
  isBold?: boolean;
  onBlank: () => void;
  onUnblank: () => void;
  onToggleBold?: () => void;
  onClose: () => void;
}

export const BlankActionPopup: React.FC<BlankActionPopupProps> = ({
  x,
  y,
  isAlreadyBlanked,
  mode = 'recite',
  isBold = false,
  onBlank,
  onUnblank,
  onToggleBold,
  onClose,
}) => {
  const { t } = useTranslation('mindmap');
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClickOutside, handleKeyDown]);

  const btnClass =
    '!px-2 !h-7 !rounded text-xs font-medium whitespace-nowrap text-[var(--mm-text-secondary)] hover:text-[var(--mm-text)] hover:bg-[var(--mm-bg-hover)]';

  return createPortal(
    <div
      ref={ref}
      className="mindmap-container fixed z-[9999] flex items-center gap-0.5 rounded-md border border-[var(--mm-border)] shadow-[var(--mm-popover-shadow)] ui-zoom-fade-in bg-[var(--mm-bg-elevated)] p-1"
      style={{
        left: `${x}px`,
        top: `${y - 36}px`,
        transform: 'translateX(-50%)',
      }}
      // 阻止 mousedown 抢先让编辑框 blur，否则加粗/挖空点击会失效
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === 'edit' && onToggleBold && (
        <NotionButton
          variant="ghost"
          size="sm"
          className={`${btnClass} ${isBold ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleBold();
          }}
        >
          <TextB size={12} />
          {t('contextMenu.bold')}
        </NotionButton>
      )}
      {isAlreadyBlanked ? (
        <NotionButton
          variant="ghost"
          size="sm"
          className={btnClass}
          onClick={(e) => {
            e.stopPropagation();
            onUnblank();
          }}
        >
          <Eye size={12} />
          {t('recite.unblank')}
        </NotionButton>
      ) : (
        <NotionButton
          variant="ghost"
          size="sm"
          className={`${btnClass} bg-[var(--mm-warning-soft)] text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]`}
          onClick={(e) => {
            e.stopPropagation();
            onBlank();
          }}
        >
          <EyeSlash size={12} />
          {mode === 'edit' ? t('recite.markBlank') : t('recite.blank')}
        </NotionButton>
      )}
    </div>,
    document.body,
  );
};
