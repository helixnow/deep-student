import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  Archive,
  Clock3,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatSession } from '@/features/chat/types/session';

function formatSessionTime(value: string | undefined) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export const ChatSessionArchiveTab: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingPermanentDeleteId, setConfirmingPermanentDeleteId] = useState<string | null>(null);

  const archivedCount = sessions.length;
  const hasArchivedSessions = archivedCount > 0;

  const loadArchivedSessions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'archived',
        limit: 100,
        offset: 0,
      });
      setSessions(Array.isArray(result) ? result : []);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      setLoadError(message);
      showGlobalNotification('error', t('data:governance.archive_load_failed'), message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadArchivedSessions();
  }, [loadArchivedSessions]);

  const sessionCountLabel = useMemo(() => {
    return t('data:governance.archive_session_count', { count: archivedCount });
  }, [archivedCount, t]);

  const restoreSession = useCallback(async (sessionId: string) => {
    setActionSessionId(sessionId);
    try {
      await invoke('chat_v2_restore_session', { sessionId });
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      showGlobalNotification('success', t('data:governance.archive_restore_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('data:governance.archive_restore_failed'), getErrorMessage(error));
    } finally {
      setActionSessionId(null);
    }
  }, [t]);

  const permanentlyDeleteSession = useCallback(async (sessionId: string) => {
    if (confirmingPermanentDeleteId !== sessionId) {
      setConfirmingPermanentDeleteId(sessionId);
      return;
    }

    setActionSessionId(sessionId);
    try {
      await invoke('chat_v2_delete_session', { sessionId });
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setConfirmingPermanentDeleteId(null);
      showGlobalNotification('success', t('data:governance.archive_delete_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('data:governance.archive_delete_failed'), getErrorMessage(error));
    } finally {
      setActionSessionId(null);
    }
  }, [confirmingPermanentDeleteId, t]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Archive className="h-4 w-4 text-muted-foreground" />
            {t('data:governance.archive_title')}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('data:governance.archive_description')}
          </p>
          <p className="text-xs text-muted-foreground">
            {sessionCountLabel}
          </p>
        </div>

        <NotionButton
          variant="ghost"
          size="sm"
          onClick={loadArchivedSessions}
          disabled={loading || actionSessionId !== null}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>{t('common:actions.refresh')}</span>
        </NotionButton>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{t('data:governance.archive_load_failed')}</p>
              <p className="text-destructive/80">{loadError}</p>
            </div>
          </div>
        </div>
      ) : null}

      {loading && !hasArchivedSessions ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border/40 bg-muted/10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('data:governance.archive_loading')}
        </div>
      ) : !hasArchivedSessions ? (
        <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 text-center">
          <Archive className="mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">{t('data:governance.archive_empty_state')}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {t('data:governance.archive_empty_state_desc')}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/40 rounded-lg border border-border/40">
          {sessions.map((session) => {
            const busy = actionSessionId === session.id;
            const confirmingDelete = confirmingPermanentDeleteId === session.id;
            return (
              <div key={session.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <p className="truncate text-sm font-medium text-foreground">
                      {session.title || t('data:governance.archive_untitled')}
                    </p>
                  </div>
                  {session.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {session.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{session.mode}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3 w-3" />
                      {formatSessionTime(session.updatedAt)}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => restoreSession(session.id)}
                    disabled={busy}
                    aria-label={t('data:governance.archive_restore')}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    <span>{t('data:governance.archive_restore')}</span>
                  </NotionButton>
                  <NotionButton
                    variant={confirmingDelete ? 'danger' : 'ghost'}
                    size="sm"
                    onClick={() => permanentlyDeleteSession(session.id)}
                    disabled={busy}
                    aria-label={confirmingDelete
                      ? t('data:governance.archive_delete_confirm')
                      : t('data:governance.archive_delete')}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {confirmingDelete
                        ? t('data:governance.archive_delete_confirm')
                        : t('data:governance.archive_delete')}
                    </span>
                  </NotionButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChatSessionArchiveTab;
