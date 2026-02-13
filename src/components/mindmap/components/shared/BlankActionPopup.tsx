import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { EyeOff, Eye } from 'lucide-react';

interface BlankActionPopupProps {
  x: number;
  y: number;
  isAlreadyBlanked: boolean;
  onBlank: () => void;
  onUnblank: () => void;
  onClose: () => void;
}

export const BlankActionPopup: React.FC<BlankActionPopupProps> = ({
  x,
  y,
  isAlreadyBlanked,
  onBlank,
  onUnblank,
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

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] flex items-center rounded-full shadow-xl animate-in fade-in-0 zoom-in-95 duration-150 backdrop-blur-sm"
      style={{
        left: `${x}px`,
        top: `${y - 36}px`,
        transform: 'translateX(-50%)',
      }}
    >
      {isAlreadyBlanked ? (
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-zinc-700/90 text-zinc-200 hover:bg-zinc-600 transition-colors whitespace-nowrap"
          onClick={(e) => {
            e.stopPropagation();
            onUnblank();
          }}
        >
          <Eye className="w-3 h-3" />
          {t('recite.unblank')}
        </button>
      ) : (
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-amber-500/90 text-white hover:bg-amber-500 transition-colors whitespace-nowrap"
          onClick={(e) => {
            e.stopPropagation();
            onBlank();
          }}
        >
          <EyeOff className="w-3 h-3" />
          {t('recite.blank')}
        </button>
      )}
    </div>,
    document.body,
  );
};
