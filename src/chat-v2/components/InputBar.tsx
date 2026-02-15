/**
 * Chat V2 - InputBar 输入框组件
 *
 * 职责：订阅 canSend/sessionStatus，控制发送/停止按钮
 */

import React, { useCallback, useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { Send, Square, Loader2, Paperclip } from 'lucide-react';
import { useSessionStatus, useInputValue, useCanSend, useAttachments } from '../hooks/useChatStore';
import type { ChatStore } from '../core/types';
import { ATTACHMENT_MAX_COUNT } from '../core/constants';
import AttachmentPreview from './AttachmentPreview';
import AttachmentUploader from './AttachmentUploader';

// ============================================================================
// Props 定义
// ============================================================================

export interface InputBarProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 自定义类名 */
  className?: string;
  /** 占位符文本 */
  placeholder?: string;
  /** 是否启用附件 */
  enableAttachments?: boolean;
  /** 最大附件数 */
  maxAttachments?: number;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * InputBar 输入框组件
 *
 * 功能：
 * 1. 文本输入（支持多行）
 * 2. 发送/停止按钮（根据状态切换）
 * 3. 附件管理（添加/删除）
 * 4. 快捷键支持（Ctrl/Cmd + Enter 发送）
 */
export const InputBar: React.FC<InputBarProps> = ({
  store,
  className,
  placeholder,
  enableAttachments = true,
  maxAttachments = ATTACHMENT_MAX_COUNT,
}) => {
  const { t } = useTranslation('chatV2');

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 本地输入状态（性能优化：避免每次输入都触发 Store 更新）
  const [localValue, setLocalValue] = useState('');

  // 订阅 Store 状态
  const sessionStatus = useSessionStatus(store);
  const storeInputValue = useInputValue(store);
  const canSend = useCanSend(store);
  const attachments = useAttachments(store);

  // 派生状态
  const isStreaming = sessionStatus === 'streaming';
  const isAborting = sessionStatus === 'aborting';
  const isDisabled = !canSend && !isStreaming;

  // 同步 Store 输入值到本地
  useEffect(() => {
    setLocalValue(storeInputValue);
  }, [storeInputValue]);

  // 自动调整高度
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  // 输入变化
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setLocalValue(value);
      // 延迟同步到 Store（防抖）
      store.getState().setInputValue(value);
      adjustTextareaHeight();
    },
    [store, adjustTextareaHeight]
  );

  // 发送消息
  const handleSend = useCallback(async () => {
    const trimmedValue = localValue.trim();
    if (!trimmedValue && attachments.length === 0) return; // 允许仅发送附件
    if (!canSend) return;

    try {
      await store.getState().sendMessage(trimmedValue, attachments);
      setLocalValue('');
      store.getState().setInputValue('');
      store.getState().clearAttachments();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (error: unknown) {
      console.error('[InputBar] Send failed:', error);
    }
  }, [localValue, canSend, store, attachments]);

  // 停止流式
  const handleStop = useCallback(async () => {
    if (!isStreaming) return;
    try {
      await store.getState().abortStream();
    } catch (error: unknown) {
      console.error('[InputBar] Abort failed:', error);
    }
  }, [isStreaming, store]);

  // 键盘事件
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd + Enter 发送
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (isStreaming) {
          handleStop();
        } else {
          handleSend();
        }
        return;
      }

      // Enter 发送（非 Shift）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) {
          handleStop();
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, handleSend, handleStop]
  );

  return (
    <div className={cn('p-4 relative', className)}>
      {/* 附件预览 - 使用 AttachmentPreview 组件 */}
      <AttachmentPreview 
        store={store} 
        className="mb-3"
        size="sm" // 输入框上方用小尺寸
      />

      {/* 输入区域 */}
      <div className="flex items-end gap-2">
        {/* 附件按钮 - 使用 AttachmentUploader 组件 */}
        {enableAttachments && (
          <AttachmentUploader 
            store={store} 
            maxCount={maxAttachments}
            // 使用 children 模式，不显示 DropZone
            className="flex-shrink-0"
          >
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              disabled={attachments.length >= maxAttachments}
              className={cn(
                '!rounded-full bg-muted/50 hover:bg-muted active:scale-95',
                attachments.length >= maxAttachments
                  ? 'opacity-50 text-muted-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={t('inputBar.addAttachment')}
              title={t('inputBar.addAttachment')}
            >
              <Paperclip className="w-5 h-5" />
            </NotionButton>
          </AttachmentUploader>
        )}

        {/* 输入框 */}
        <div className="flex-1 relative group">
          <textarea
            ref={textareaRef}
            value={localValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || t('inputBar.placeholder')}
            disabled={isDisabled}
            rows={1}
            className={cn(
              'w-full px-4 py-3 pr-12',
              'bg-muted/30 border border-border/50 rounded-2xl', // 更圆润
              'resize-none overflow-hidden transition-all duration-200',
              'focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 focus:bg-background',
              'placeholder:text-muted-foreground/70',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'text-[15px] leading-relaxed' // 调整字号和行高
            )}
            style={{ minHeight: '48px', maxHeight: '200px' }}
          />
        </div>

        {/* 发送/停止按钮 */}
        <NotionButton
          variant={isStreaming ? 'danger' : 'primary'}
          size="icon"
          iconOnly
          onClick={isStreaming ? handleStop : handleSend}
          disabled={isAborting || (!isStreaming && !canSend)}
          className={cn(
            '!rounded-full shadow-sm hover:shadow-md active:scale-95',
            isStreaming
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
            (isAborting || (!isStreaming && !canSend)) &&
              'opacity-50 shadow-none'
          )}
          aria-label={isStreaming ? t('inputBar.stop') : t('inputBar.send')}
          title={isStreaming ? t('inputBar.stop') : t('inputBar.send')}
        >
          {isAborting ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : isStreaming ? (
            <Square className="w-5 h-5 fill-current" />
          ) : (
            <Send className="w-5 h-5 ml-0.5" />
          )}
        </NotionButton>
      </div>

      {/* 快捷键提示 */}
      <div className="mt-2 text-[10px] text-muted-foreground/60 text-center select-none">
        {t('inputBar.shortcut')}
      </div>
    </div>
  );
};

export default InputBar;
