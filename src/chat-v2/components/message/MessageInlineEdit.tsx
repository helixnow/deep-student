/**
 * MessageInlineEdit - 消息内联编辑组件
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface MessageInlineEditProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export const MessageInlineEdit: React.FC<MessageInlineEditProps> = ({
  value,
  onChange,
  onConfirm,
  onCancel,
  isSubmitting,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onConfirm();
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  }, [onConfirm, onCancel]);

  return (
    <div className="flex flex-col items-end gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[80px] rounded-lg px-3 py-2 text-sm
                   bg-background text-foreground text-left
                   border-2 border-primary
                   focus:outline-none focus:ring-2 focus:ring-primary/50
                   resize-y"
        placeholder={t('chatV2:messageItem.actions.editPlaceholder', '输入新内容...')}
        onKeyDown={handleKeyDown}
        disabled={isSubmitting}
      />
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {t('common:actions.cancel', '取消')}
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          onClick={onConfirm}
          disabled={isSubmitting}
        >
          {t('chatV2:messageItem.actions.editAndResend', '编辑并重发')}
        </button>
      </div>
    </div>
  );
};

export default MessageInlineEdit;
