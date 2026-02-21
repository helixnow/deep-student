import React, { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

const EMOJI_CATEGORIES = [
  {
    key: 'common',
    emojis: ['📌', '⭐', '❤️', '🔥', '✅', '❌', '⚠️', '💡', '🎯', '🏆', '📝', '📚', '🔑', '💎', '🚀', '🎉'],
  },
  {
    key: 'faces',
    emojis: ['😀', '😊', '🤔', '😎', '🥳', '😍', '🤩', '😱', '😤', '🥺', '😴', '🤯', '🧐', '😈', '👻', '🤖'],
  },
  {
    key: 'objects',
    emojis: ['📁', '📂', '📄', '📊', '📈', '📉', '🗂️', '📎', '✏️', '🖊️', '📐', '🔍', '🔒', '🔓', '🏷️', '📮'],
  },
  {
    key: 'symbols',
    emojis: ['✨', '💫', '⚡', '🌟', '🔔', '💬', '🗨️', '♻️', '🔗', '📢', '🛑', '🟢', '🟡', '🔴', '🔵', '⬛'],
  },
  {
    key: 'nature',
    emojis: ['🌸', '🌺', '🍀', '🌿', '🌳', '🌈', '☀️', '🌙', '⛅', '🌊', '🍎', '🍊', '🫐', '🥑', '🌶️', '🍄'],
  },
];

interface EmojiPickerProps {
  value?: string;
  onChange: (emoji: string | undefined) => void;
  onClose?: () => void;
  className?: string;
}

export const EmojiPicker: React.FC<EmojiPickerProps> = ({
  value,
  onChange,
  onClose,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const [activeTab, setActiveTab] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={cn(
        "bg-popover border border-border rounded-lg shadow-lg p-2 w-[220px]",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tab headers */}
      <div className="flex gap-1 mb-2 border-b border-border pb-1">
        {EMOJI_CATEGORIES.map((cat, i) => (
          <button
            key={cat.key}
            className={cn(
              "text-sm px-1.5 py-0.5 rounded transition-colors",
              activeTab === i
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setActiveTab(i)}
          >
            {cat.emojis[0]}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJI_CATEGORIES[activeTab].emojis.map((emoji) => (
          <button
            key={emoji}
            className={cn(
              "w-6 h-6 flex items-center justify-center rounded text-base hover:bg-accent transition-colors",
              value === emoji && "bg-accent ring-1 ring-primary"
            )}
            onClick={() => {
              onChange(emoji);
              onClose?.();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Remove button */}
      {value && (
        <button
          className="w-full mt-2 text-xs text-muted-foreground hover:text-destructive py-1 rounded hover:bg-destructive/10 transition-colors"
          onClick={() => {
            onChange(undefined);
            onClose?.();
          }}
        >
          {t('contextMenu.removeIcon')}
        </button>
      )}
    </div>
  );
};
