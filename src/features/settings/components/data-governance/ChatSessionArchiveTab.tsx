import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Warning,
  Archive,
  Clock,
  CircleNotch,
  Chat,
  ArrowClockwise,
  ArrowCounterClockwise,
  Trash,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatSession } from '@/features/chat/types/session';
import type { SessionGroup } from '@/features/chat/types/group';

const ARCHIVED_SESSIONS_PAGE_SIZE = 200;

function formatSessionTime(value: string | undefined) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export const ChatSessionArchiveTab: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [knownGroups, setKnownGroups] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [actionGroupId, setActionGroupId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingPermanentDeleteId, setConfirmingPermanentDeleteId] = useState<string | null>(null);
  const [confirmingPermanentDeleteGroupId, setConfirmingPermanentDeleteGroupId] = useState<string | null>(null);

  const archivedCount = sessions.length;
  const hasArchivedItems = archivedCount > 0 || groups.length > 0;

  const loadArchivedSessions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loadAllArchivedSessions = async (): Promise<ChatSession[]> => {
        const allSessions: ChatSession[] = [];
        let offset = 0;
        while (true) {
          const page = await invoke<ChatSession[]>('chat_v2_list_sessions', {
            status: 'archived',
            limit: ARCHIVED_SESSIONS_PAGE_SIZE,
            offset,
          });
          if (!Array.isArray(page) || page.length === 0) break;
          allSessions.push(...page);
          if (page.length < ARCHIVED_SESSIONS_PAGE_SIZE) break;
          offset += page.length;
        }
        return allSessions;
      };

      const [sessionsResult, groupsResult, allGroupsResult] = await Promise.allSettled([
        loadAllArchivedSessions(),
        invoke<SessionGroup[]>('chat_v2_list_groups', {
          status: 'archived',
        }),
        Promise.all([
          invoke<SessionGroup[]>('chat_v2_list_groups', { status: 'active' }),
          invoke<SessionGroup[]>('chat_v2_list_groups', { status: 'archived' }),
        ]),
      ]);

      if (sessionsResult.status === 'fulfilled') {
        setSessions(Array.isArray(sessionsResult.value) ? sessionsResult.value : []);
      } else {
        throw sessionsResult.reason;
      }

      if (groupsResult.status === 'fulfilled') {
        setGroups(Array.isArray(groupsResult.value) ? groupsResult.value : []);
      } else {
        console.warn('[ChatSessionArchiveTab] Failed to load archived groups:', groupsResult.reason);
        setGroups([]);
      }

      if (allGroupsResult.status === 'fulfilled') {
        const [activeGroups, archivedGroups] = allGroupsResult.value;
        const mergedGroups = new Map<string, SessionGroup>();
        [...activeGroups, ...archivedGroups].forEach((group) => mergedGroups.set(group.id, group));
        setKnownGroups(Array.from(mergedGroups.values()));
      } else {
        console.warn('[ChatSessionArchiveTab] Failed to load full group index:', allGroupsResult.reason);
        setKnownGroups(groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value) ? groupsResult.value : []);
      }
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

  const groupedSessions = useMemo(() => {
    const visibleGroups = new Map<string, SessionGroup>();

    groups.forEach((group) => visibleGroups.set(group.id, group));
    sessions.forEach((session) => {
      if (!session.groupId || visibleGroups.has(session.groupId)) return;
      const knownGroup = knownGroups.find((group) => group.id === session.groupId);
      if (knownGroup) {
        visibleGroups.set(knownGroup.id, knownGroup);
      }
    });

    const sortedGroups = Array.from(visibleGroups.values()).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const sessionMap = new Map<string, ChatSession[]>();

    sessions.forEach((session) => {
      if (!session.groupId) return;
      const groupSessions = sessionMap.get(session.groupId) ?? [];
      groupSessions.push(session);
      sessionMap.set(session.groupId, groupSessions);
    });

    const grouped = sortedGroups.map((group) => ({
      group,
      sessions: [...(sessionMap.get(group.id) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));

    const groupIds = new Set(sortedGroups.map((group) => group.id));
    const ungrouped = sessions
      .filter((session) => !session.groupId || !groupIds.has(session.groupId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { grouped, ungrouped };
  }, [groups, knownGroups, sessions]);

  const restoreSession = useCallback(async (sessionId: string) => {
    setActionSessionId(sessionId);
    try {
      await invoke('chat_v2_restore_session', { sessionId });
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      showGlobalNotification('success', t('data:governance.archive_restore_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('data:governance.archive_restore_failed'), getErrorMessage(error));
    } finally {
      setActionSessionId(null);
    }
  }, [t]);

  const restoreGroup = useCallback(async (groupId: string) => {
    setActionGroupId(groupId);
    try {
      await invoke('chat_v2_restore_group', { groupId });
      window.dispatchEvent(new CustomEvent('chat-v2:groups-updated'));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      await loadArchivedSessions();
      showGlobalNotification('success', t('data:governance.archive_restore_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('data:governance.archive_restore_failed'), getErrorMessage(error));
    } finally {
      setActionGroupId(null);
    }
  }, [loadArchivedSessions, t]);

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

  const permanentlyDeleteGroup = useCallback(async (groupId: string) => {
    if (confirmingPermanentDeleteGroupId !== groupId) {
      setConfirmingPermanentDeleteGroupId(groupId);
      return;
    }

    setActionGroupId(groupId);
    try {
      await invoke('chat_v2_delete_group', { groupId });
      setConfirmingPermanentDeleteGroupId(null);
      window.dispatchEvent(new CustomEvent('chat-v2:groups-updated'));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      await loadArchivedSessions();
      showGlobalNotification('success', t('data:governance.archive_delete_group_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('data:governance.archive_delete_group_failed'), getErrorMessage(error));
    } finally {
      setActionGroupId(null);
    }
  }, [confirmingPermanentDeleteGroupId, loadArchivedSessions, t]);

  const renderSessionRow = useCallback((session: ChatSession, ownerGroup?: SessionGroup) => {
    const busy = actionSessionId === session.id;
    const groupBusy = Boolean(ownerGroup && actionGroupId === ownerGroup.id);
    const confirmingDelete = confirmingPermanentDeleteId === session.id;
    const restoreArchivedGroup = ownerGroup?.persistStatus === 'archived';
    const restoreLabel = restoreArchivedGroup
      ? t('data:governance.archive_restore_group')
      : t('data:governance.archive_restore');

    return (
      <div key={session.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <Chat size={16} className="shrink-0 text-muted-foreground" />
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
              <Clock size={12} />
              {formatSessionTime(session.updatedAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <DsButton
            variant="outline"
            size="sm"
            onClick={() => {
              if (restoreArchivedGroup && ownerGroup) {
                void restoreGroup(ownerGroup.id);
                return;
              }
              void restoreSession(session.id);
            }}
            disabled={busy || groupBusy}
            aria-label={restoreLabel}
          >
            {busy || groupBusy ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <ArrowCounterClockwise size={14} />
            )}
            <span>{restoreLabel}</span>
          </DsButton>
          <DsButton
            variant={confirmingDelete ? 'danger' : 'outline'}
            size="sm"
            className={confirmingDelete ? undefined : '!text-destructive'}
            onClick={() => permanentlyDeleteSession(session.id)}
            disabled={busy}
            aria-label={confirmingDelete
              ? t('data:governance.archive_delete_confirm')
              : t('data:governance.archive_delete')}
          >
            {busy ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <Trash size={14} />
            )}
            <span>
              {confirmingDelete
                ? t('data:governance.archive_delete_confirm')
                : t('data:governance.archive_delete')}
            </span>
          </DsButton>
        </div>
      </div>
    );
  }, [actionGroupId, actionSessionId, confirmingPermanentDeleteId, permanentlyDeleteSession, restoreGroup, restoreSession, t]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Archive size={16} className="text-muted-foreground" />
            {t('data:governance.archive_title')}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('data:governance.archive_description')}
          </p>
          <p className="text-xs text-muted-foreground">
            {sessionCountLabel}
          </p>
        </div>

        <DsButton
          variant="outline"
          size="sm"
          onClick={loadArchivedSessions}
          disabled={loading || actionSessionId !== null || actionGroupId !== null}
        >
          {loading ? (
            <CircleNotch size={14} className="animate-spin" />
          ) : (
            <ArrowClockwise size={14} />
          )}
          <span>{t('common:actions.refresh')}</span>
        </DsButton>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-2 text-sm text-destructive">
            <Warning className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{t('data:governance.archive_load_failed')}</p>
              <p className="text-destructive/80">{loadError}</p>
            </div>
          </div>
        </div>
      ) : null}

      {loading && !hasArchivedItems ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border/40 bg-muted/10 text-sm text-muted-foreground">
          <CircleNotch size={16} className="mr-2 animate-spin" />
          {t('data:governance.archive_loading')}
        </div>
      ) : !hasArchivedItems ? (
        <div className="flex min-h-40 flex-col items-start justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 py-6">
          <Archive size={32} className="mb-3 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">{t('data:governance.archive_empty_state')}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {t('data:governance.archive_empty_state_desc')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedSessions.grouped.map(({ group, sessions: groupSessions }) => {
            const isArchivedGroup = group.persistStatus === 'archived';
            const confirmingDeleteGroup = confirmingPermanentDeleteGroupId === group.id;
            return (
            <section key={group.id} className="overflow-hidden rounded-lg border border-border/40 bg-background/70">
              <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-muted/20 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{group.name}</p>
                  <p className="text-xs text-muted-foreground">{groupSessions.length} / {archivedCount}</p>
                </div>
                {isArchivedGroup ? (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => restoreGroup(group.id)}
                      disabled={actionGroupId === group.id || actionSessionId !== null}
                      aria-label={t('data:governance.archive_restore_group')}
                    >
                      {actionGroupId === group.id ? (
                        <CircleNotch size={14} className="animate-spin" />
                      ) : (
                        <ArrowCounterClockwise size={14} />
                      )}
                      <span>{t('data:governance.archive_restore_group')}</span>
                    </DsButton>
                    <DsButton
                      variant={confirmingDeleteGroup ? 'danger' : 'ghost'}
                      size="sm"
                      onClick={() => permanentlyDeleteGroup(group.id)}
                      disabled={actionGroupId === group.id || actionSessionId !== null}
                      aria-label={confirmingDeleteGroup
                        ? t('data:governance.archive_delete_group_confirm')
                        : t('data:governance.archive_delete_group')}
                    >
                      {actionGroupId === group.id ? (
                        <CircleNotch size={14} className="animate-spin" />
                      ) : (
                        <Trash size={14} />
                      )}
                      <span>
                        {confirmingDeleteGroup
                          ? t('data:governance.archive_delete_group_confirm')
                          : t('data:governance.archive_delete_group')}
                      </span>
                    </DsButton>
                  </div>
                ) : null}
              </div>
              {groupSessions.length > 0 ? (
                <div className="divide-y divide-border/40">
                  {groupSessions.map((session) => renderSessionRow(session, group))}
                </div>
              ) : (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  {t('data:governance.archive_empty_group_hint')}
                </p>
              )}
            </section>
            );
          })}

          {groupedSessions.ungrouped.length > 0 ? (
            <section className="overflow-hidden rounded-lg border border-border/40 bg-background/70">
              <div className="border-b border-border/40 bg-muted/20 px-4 py-3">
                <p className="text-sm font-medium text-foreground">{t('data:governance.archive_ungrouped_title')}</p>
              </div>
              <div className="divide-y divide-border/40">
                {groupedSessions.ungrouped.map((session) => renderSessionRow(session))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default ChatSessionArchiveTab;
