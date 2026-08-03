import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';

export interface DesktopShellTitleEditorProps {
  sessionId: string;
  title: string;
  renameLabel: string;
  emptyTitleError: string;
  saveError: string;
  onSave: (sessionId: string, title: string) => Promise<void>;
  className?: string;
}

/** Inline editor for the active chat title in the desktop shell header. */
export function DesktopShellTitleEditor({
  sessionId,
  title,
  renameLabel,
  emptyTitleError,
  saveError,
  onSave,
  className,
}: DesktopShellTitleEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(title);
      setError(null);
    }
  }, [isEditing, title]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const beginEditing = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (isSaving) {
      return;
    }

    setDraftTitle(title);
    setError(null);
    setIsEditing(true);
  }, [isSaving, title]);

  const cancelEditing = useCallback(() => {
    if (savingRef.current) {
      return;
    }

    setDraftTitle(title);
    setError(null);
    setIsEditing(false);
  }, [title]);

  const saveEditing = useCallback(async () => {
    if (!isEditing || savingRef.current) {
      return;
    }

    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setError(emptyTitleError);
      return;
    }

    if (nextTitle === title.trim()) {
      cancelEditing();
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      await onSave(sessionId, nextTitle);
      setDraftTitle(nextTitle);
      setIsEditing(false);
    } catch {
      setError(saveError);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [cancelEditing, draftTitle, emptyTitleError, isEditing, onSave, saveError, sessionId, title]);

  if (!isEditing) {
    return (
      <div
        className={cn('min-w-0 max-w-full cursor-text truncate', className)}
        data-shell-hotzone-ignore="true"
        role="button"
        tabIndex={0}
        aria-label={renameLabel}
        title={title}
        onClick={beginEditing}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            beginEditing(event);
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="block max-w-full truncate">{title}</span>
      </div>
    );
  }

  return (
    <div
      className={cn('relative min-w-0 max-w-full', className)}
      data-shell-hotzone-ignore="true"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Input
        ref={inputRef}
        value={draftTitle}
        disabled={isSaving}
        aria-label={renameLabel}
        aria-invalid={error ? 'true' : undefined}
        title={error ?? renameLabel}
        autoComplete="off"
        className="desktop-shell-header-title-input h-7 min-h-7 border-primary/60 bg-background/80 px-2 py-0 shadow-sm"
        onChange={(event) => {
          setDraftTitle(event.target.value);
          if (error) {
            setError(null);
          }
        }}
        onBlur={() => {
          void saveEditing();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEditing();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            void saveEditing();
          }
        }}
      />
      {error ? (
        <span
          className="absolute left-0 top-full z-50 mt-1 max-w-[min(22rem,45vw)] rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground shadow-lg"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
