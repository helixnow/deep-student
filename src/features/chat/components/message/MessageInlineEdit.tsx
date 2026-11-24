/**
 * MessageInlineEdit - 消息内联编辑组件
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';

export interface MessageInlineEditConfirmPrompt {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface MessageInlineEditProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  confirmPrompt?: MessageInlineEditConfirmPrompt | null;
}

export const MessageInlineEdit: React.FC<MessageInlineEditProps> = ({
  value,
  onChange,
  onConfirm,
  onCancel,
  isSubmitting,
  confirmPrompt = null,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // 光标定位到末尾
    const len = el.value.length;
    el.setSelectionRange(len, len);
    // 初始高度适配内容（上限 320px），保留 resize-y 手动调整能力
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 🔧 IME 修复：中文等输入法组合期间的 Enter/Escape 属于输入法操作，
    // 不能触发提交或取消（取消会直接丢弃整段编辑内容）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (confirmPrompt) {
        confirmPrompt.onConfirm();
      } else {
        onConfirm();
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (confirmPrompt) {
        confirmPrompt.onCancel();
      } else {
        onCancel();
      }
    }
  }, [confirmPrompt, onConfirm, onCancel]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border-2 border-primary focus-visible:ring-primary/50 resize-y"
        placeholder={t('chatV2:messageItem.actions.editPlaceholder')}
        onKeyDown={handleKeyDown}
        disabled={isSubmitting}
      />
      {confirmPrompt ? (
        <div
          role="alert"
          data-testid="edit-downstream-confirm"
          className="w-full flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--chat-radius-md,12px)] border border-border/60 bg-muted/40 px-3 py-2"
        >
          <span className="text-ui leading-relaxed text-foreground/85">
            {t('chatV2:messageItem.editConfirm.message', { count: confirmPrompt.count })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <DsButton
              variant="ghost"
              size="sm"
              className="[@media(pointer:coarse)]:!min-h-11"
              onClick={confirmPrompt.onCancel}
              disabled={isSubmitting}
              data-testid="edit-downstream-cancel"
            >
              {t('chatV2:messageItem.editConfirm.cancel')}
            </DsButton>
            <DsButton
              variant="primary"
              size="sm"
              className="!border-destructive !bg-destructive !text-destructive-foreground hover:!bg-destructive/90 [@media(pointer:coarse)]:!min-h-11"
              onClick={confirmPrompt.onConfirm}
              disabled={isSubmitting}
              data-testid="edit-downstream-confirm-button"
            >
              {t('chatV2:messageItem.editConfirm.confirm')}
            </DsButton>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={onConfirm}
            disabled={isSubmitting}
          >
            {t('chatV2:messageItem.actions.send')}
          </DsButton>
        </div>
      )}
    </div>
  );
};

export default MessageInlineEdit;
