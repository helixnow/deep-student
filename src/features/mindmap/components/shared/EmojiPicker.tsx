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
        "bg-[var(--mm-bg-elevated)] border border-[var(--mm-border)] rounded-[var(--mm-radius-popup,8px)] shadow-[var(--mm-popover-shadow)] p-2 w-[220px]",
        // 📱 coarse：格子放大到 44px 后按内容自适应宽度，且不超出视口
        "[@media(pointer:coarse)]:w-auto [@media(pointer:coarse)]:max-w-[calc(100vw-24px)]",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tab headers */}
      <div className="flex gap-1 mb-2 border-b border-[var(--mm-border)] pb-1" role="tablist">
        {EMOJI_CATEGORIES.map((cat, i) => (
          <button
            key={cat.key}
            type="button"
            role="tab"
            aria-selected={activeTab === i}
            className={cn(
              "text-sm px-1.5 py-0.5 rounded transition-colors motion-reduce:transition-none",
              "[@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11",
              activeTab === i
                ? "bg-[var(--mm-bg-active)]"
                : "text-muted-foreground hover:bg-[var(--mm-bg-hover)]"
            )}
            onClick={() => setActiveTab(i)}
          >
            {cat.emojis[0]}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      {/* 📱 coarse：44px 触控格 + 6 列（8 列 × 44px 会超出窄屏视口） */}
      <div className="grid grid-cols-8 gap-0.5 [@media(pointer:coarse)]:grid-cols-6">
        {EMOJI_CATEGORIES[activeTab].emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            className={cn(
              "w-6 h-6 flex items-center justify-center rounded text-base hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none",
              "[@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-xl",
              value === emoji && "bg-[var(--mm-bg-active)] ring-1 ring-primary"
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
          type="button"
          className="w-full mt-2 text-xs text-muted-foreground hover:text-destructive py-1 rounded hover:bg-destructive/10 transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
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
