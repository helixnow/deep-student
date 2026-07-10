/**
 * MessageInlineEdit - 消息内联编辑组件
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '@/components/ui/shad/Textarea';

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
      onConfirm();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }, [onConfirm, onCancel]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border-2 border-primary focus-visible:ring-primary/50 resize-y"
        placeholder={t('chatV2:messageItem.actions.editPlaceholder', '输入新内容...')}
        onKeyDown={handleKeyDown}
        disabled={isSubmitting}
      />
      <div className="flex gap-2">
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {t('common:actions.cancel', '取消')}
        </NotionButton>
        <NotionButton
          variant="primary"
          size="sm"
          onClick={onConfirm}
          disabled={isSubmitting}
        >
          {t('chatV2:messageItem.actions.send', '发送')}
        </NotionButton>
      </div>
    </div>
  );
};

export default MessageInlineEdit;
