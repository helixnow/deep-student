/**
 * ChatSessionHeader - 会话顶栏标题与重命名入口
 *
 * 为常规对话模式提供可发现的「重命名会话」按钮与内联编辑交互，
 * 保存后同步到 ChatStore、后端设置及侧栏会话列表。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Check, PencilSimple, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import type { ChatStore } from '../core/types';
import { getSessionTitleText } from '../utils/sessionTitle';

export interface ChatSessionHeaderProps {
  store: StoreApi<ChatStore>;
}

export const ChatSessionHeader: React.FC<ChatSessionHeaderProps> = ({ store }) => {
  const { t } = useTranslation('chatV2');
  const title = useStore(store, (s) => s.title);
  const sessionId = useStore(store, (s) => s.sessionId);

  const displayTitle = getSessionTitleText(title, t('header.untitledSession'));

  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsEditing(false);
    setDraftTitle(title ?? '');
    setErrorMessage(null);
  }, [sessionId]);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(title ?? '');
    }
  }, [isEditing, title]);

  useEffect(() => {
    if (!isEditing) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [isEditing]);

  const startEditing = useCallback(() => {
    setDraftTitle(typeof title === 'string' ? title : displayTitle);
    setErrorMessage(null);
    setIsEditing(true);
  }, [displayTitle, title]);

  const cancelEditing = useCallback(() => {
    if (isSaving) return;
    setIsEditing(false);
    setDraftTitle(typeof title === 'string' ? title : '');
    setErrorMessage(null);
  }, [isSaving, title]);

  const saveTitle = useCallback(async () => {
    if (isSaving) return;
    const trimmed = draftTitle.trim();
    if (!trimmed) {
      setErrorMessage(t('page.renameEmptyError'));
      return;
    }

    if (trimmed === (typeof title === 'string' ? title.trim() : '')) {
      setIsEditing(false);
      setErrorMessage(null);
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      await store.getState().setTitle(trimmed);
      setIsEditing(false);
    } catch {
      setErrorMessage(t('page.renameFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [draftTitle, isSaving, store, t, title]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditing();
    }
  }, [cancelEditing, saveTitle]);

  return (
    <div
      data-slot="chat-session-header"
      data-testid="chat-session-header"
      className="flex-shrink-0 border-b border-border/35 px-4 md:px-8 py-2 bg-[color:var(--shell-workspace-panel)]"
    >
      <div className="mx-auto max-w-thread flex items-center justify-between gap-2 min-h-[28px]">
        {isEditing ? (
          <div
            data-testid="chat-header-rename-form"
            className="flex flex-col gap-1 flex-1 min-w-0"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Input
                ref={inputRef}
                type="text"
                value={draftTitle}
                onChange={(e) => {
                  setDraftTitle(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder={t('page.sessionNamePlaceholder')}
                aria-label={t('header.renameSession')}
                data-testid="chat-header-rename-input"
                disabled={isSaving}
                className="h-8 flex-1 min-w-0 text-sm [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
              />
              <DsButton
                variant="primary"
                size="sm"
                onClick={() => void saveTitle()}
                disabled={isSaving}
                data-testid="chat-header-rename-save"
                className="shrink-0 [@media(pointer:coarse)]:!min-h-11"
              >
                <Check size={14} aria-hidden="true" />
                <span>{isSaving ? t('page.renameSaving') : t('page.saveSessionName')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={cancelEditing}
                disabled={isSaving}
                data-testid="chat-header-rename-cancel"
                className="shrink-0 [@media(pointer:coarse)]:!min-h-11"
              >
                <X size={14} aria-hidden="true" />
                <span>{t('page.cancelEdit')}</span>
              </DsButton>
            </div>
            {errorMessage && (
              <p
                role="alert"
                data-testid="chat-header-rename-error"
                className="text-xs text-destructive"
              >
                {errorMessage}
              </p>
            )}
          </div>
        ) : (
          <>
            <span
              data-testid="chat-header-title"
              onDoubleClick={startEditing}
              title={displayTitle}
              className="text-sm font-medium text-foreground/90 truncate min-w-0"
            >
              {displayTitle}
            </span>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={startEditing}
              data-testid="chat-header-rename-button"
              aria-label={t('header.renameSession')}
              title={t('header.renameSession')}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
            >
              <PencilSimple size={14} aria-hidden="true" />
              <span>{t('header.renameSession')}</span>
            </DsButton>
          </>
        )}
      </div>
    </div>
  );
};

export default ChatSessionHeader;
