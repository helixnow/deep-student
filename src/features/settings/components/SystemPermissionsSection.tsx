import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  Bell,
  FolderOpen,
  Microphone,
} from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getSystemAuthorizationSnapshot,
  openSystemPermissionSettings,
  requestMicrophoneAuthorization,
  requestNotificationAuthorization,
  type SystemAuthorizationSnapshot,
  type SystemAuthorizationStatus,
  type SystemPermissionSettingsTarget,
} from '@/features/settings/systemPermissions';
import { getErrorMessage } from '@/utils/errorUtils';
import { isMacOS, isMobilePlatform, isWindows } from '@/utils/platform';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { isTauriRuntime } from '@/api/tauriClient';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

import { SettingsGroup } from './settingsTabPrimitives';

const INITIAL_SNAPSHOT: SystemAuthorizationSnapshot = {
  notifications: 'checking',
  microphone: 'checking',
};

function mergeQueriedStatus(
  current: SystemAuthorizationStatus,
  queried: SystemAuthorizationStatus,
): SystemAuthorizationStatus {
  const currentIsDefinitive = current === 'granted' || current === 'denied';
  const queryIsAmbiguous = queried === 'unknown' || queried === 'not_requested';
  return currentIsDefinitive && queryIsAmbiguous ? current : queried;
}

type AuthorizationAction = 'open_settings' | 'refresh' | 'request';

function getAuthorizationAction(
  status: SystemAuthorizationStatus,
  canOpenPermissionSettings: boolean,
): AuthorizationAction | undefined {
  if (status === 'checking' || status === 'granted') return undefined;
  if (status === 'denied') {
    return canOpenPermissionSettings ? 'open_settings' : undefined;
  }
  if (status === 'unavailable') return 'refresh';
  return 'request';
}

function StatusBadge({
  status,
  title,
}: {
  status: SystemAuthorizationStatus;
  title: string;
}) {
  const { t } = useTranslation('settings');
  const label = t(`system_authorization.status.${status}`);
  const className = status === 'granted'
    ? 'border-success/25 bg-success/10 text-success'
    : status === 'denied'
      ? 'border-warning/30 bg-warning/10 text-warning'
      : 'border-border/50 bg-muted/40 text-muted-foreground';

  return (
    <span
      aria-label={`${title}: ${label}`}
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-2xs font-medium',
        className,
      )}
    >
      {label}
    </span>
  );
}

function AuthorizationRow({
  icon,
  title,
  description,
  status,
  actionLabel,
  actionBusy,
  actionDisabled,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: SystemAuthorizationStatus;
  actionLabel?: string;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="group flex flex-col gap-2 px-1 py-2.5 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/30 text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm leading-tight text-foreground/90">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
            {description}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-10 md:pl-0">
        <StatusBadge status={status} title={title} />
        {actionLabel && onAction ? (
          <NotionButton
            variant="default"
            size="sm"
            disabled={actionBusy || actionDisabled}
            aria-busy={actionBusy || undefined}
            onClick={onAction}
          >
            {actionBusy
              ? <ArrowClockwise aria-hidden="true" size={13} className="animate-spin" />
              : null}
            {actionLabel}
          </NotionButton>
        ) : null}
      </div>
    </div>
  );
}

export function SystemPermissionsSection() {
  const { t } = useTranslation('settings');
  const supported = !isMobilePlatform() && isTauriRuntime();
  const canOpenPermissionSettings = isMacOS() || isWindows();
  const operationSequence = useRef(0);
  const busyPermissionRef = useRef<'notifications' | 'microphone' | null>(null);
  const [snapshot, setSnapshot] = useState<SystemAuthorizationSnapshot>(INITIAL_SNAPSHOT);
  const [busyPermission, setBusyPermission] = useState<'notifications' | 'microphone' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported || busyPermissionRef.current) return;
    const sequence = ++operationSequence.current;
    setRefreshing(true);
    try {
      const next = await getSystemAuthorizationSnapshot();
      if (sequence === operationSequence.current) {
        setSnapshot((current) => ({
          notifications: mergeQueriedStatus(current.notifications, next.notifications),
          microphone: mergeQueriedStatus(current.microphone, next.microphone),
        }));
      }
    } catch (error) {
      if (sequence === operationSequence.current) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    } finally {
      if (sequence === operationSequence.current) {
        setRefreshing(false);
      }
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return undefined;
    void refresh();
    return () => {
      operationSequence.current += 1;
      busyPermissionRef.current = null;
    };
  }, [refresh, supported]);

  const handleFocus = useCallback(() => {
    void refresh();
  }, [refresh]);
  useEventRegistry(
    supported
      ? [{ target: 'window', type: 'focus', listener: handleFocus }]
      : [],
    [handleFocus, supported],
  );

  const openSettings = useCallback(async (permission: SystemPermissionSettingsTarget) => {
    try {
      await openSystemPermissionSettings(permission);
    } catch (error) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, []);

  const requestNotifications = useCallback(async () => {
    const sequence = ++operationSequence.current;
    busyPermissionRef.current = 'notifications';
    setBusyPermission('notifications');
    try {
      const status = await requestNotificationAuthorization();
      if (sequence !== operationSequence.current) return;
      setSnapshot((current) => ({ ...current, notifications: status }));
      if (status === 'denied') {
        showGlobalNotification('warning', t('system_authorization.notifications.denied_hint'));
      }
    } catch (error) {
      if (sequence === operationSequence.current) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    } finally {
      if (sequence === operationSequence.current) {
        busyPermissionRef.current = null;
        setBusyPermission(null);
      }
    }
  }, [t]);

  const requestMicrophone = useCallback(async () => {
    const sequence = ++operationSequence.current;
    busyPermissionRef.current = 'microphone';
    setBusyPermission('microphone');
    try {
      const status = await requestMicrophoneAuthorization();
      if (sequence !== operationSequence.current) return;
      setSnapshot((current) => ({ ...current, microphone: status }));
      if (status === 'denied') {
        showGlobalNotification('warning', t('system_authorization.microphone.denied_hint'));
      }
    } catch (error) {
      if (sequence === operationSequence.current) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    } finally {
      if (sequence === operationSequence.current) {
        busyPermissionRef.current = null;
        setBusyPermission(null);
      }
    }
  }, [t]);

  const openDirectoryPermissions = useCallback(() => {
    setPendingSettingsTab('mcp');
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'mcp' });
    window.setTimeout(() => {
      document.getElementById('settings-tool-permissions')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 0);
  }, []);

  if (!supported) return null;

  const notificationAction = getAuthorizationAction(
    snapshot.notifications,
    canOpenPermissionSettings,
  );
  const microphoneAction = getAuthorizationAction(
    snapshot.microphone,
    canOpenPermissionSettings,
  );
  const actionLabel = (action: AuthorizationAction | undefined) => (
    action ? t(`system_authorization.${action}`) : undefined
  );

  return (
    <SettingsGroup
      title={t('system_authorization.title')}
      description={t('system_authorization.description')}
      className="mb-3"
    >
      <AuthorizationRow
        icon={<Bell size={15} />}
        title={t('system_authorization.notifications.title')}
        description={t('system_authorization.notifications.description')}
        status={snapshot.notifications}
        actionBusy={busyPermission === 'notifications'}
        actionDisabled={busyPermission !== null}
        actionLabel={actionLabel(notificationAction)}
        onAction={
          notificationAction === 'open_settings'
            ? () => void openSettings('notifications')
            : notificationAction === 'refresh'
              ? () => void refresh()
              : notificationAction === 'request'
                ? () => void requestNotifications()
                : undefined
        }
      />
      <AuthorizationRow
        icon={<Microphone size={15} />}
        title={t('system_authorization.microphone.title')}
        description={t('system_authorization.microphone.description')}
        status={snapshot.microphone}
        actionBusy={busyPermission === 'microphone'}
        actionDisabled={busyPermission !== null}
        actionLabel={actionLabel(microphoneAction)}
        onAction={
          microphoneAction === 'open_settings'
            ? () => void openSettings('microphone')
            : microphoneAction === 'refresh'
              ? () => void refresh()
              : microphoneAction === 'request'
                ? () => void requestMicrophone()
                : undefined
        }
      />
      <div className="group flex flex-col gap-2 px-1 py-2.5 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/30 text-muted-foreground">
            <FolderOpen size={15} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm leading-tight text-foreground/90">
              {t('system_authorization.files.title')}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
              {t('system_authorization.files.description')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-10 md:pl-0">
          <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-border/50 bg-muted/40 px-2 text-2xs font-medium text-muted-foreground">
            {t('system_authorization.files.status')}
          </span>
          <NotionButton variant="default" size="sm" onClick={openDirectoryPermissions}>
            {t('system_authorization.files.manage')}
          </NotionButton>
        </div>
      </div>
      <div className="flex justify-end border-t border-border/30 px-1 pt-2">
        <NotionButton
          variant="ghost"
          size="sm"
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          onClick={() => void refresh()}
        >
          <ArrowClockwise
            aria-hidden="true"
            size={13}
            className={refreshing ? 'animate-spin' : undefined}
          />
          {t('system_authorization.refresh')}
        </NotionButton>
      </div>
    </SettingsGroup>
  );
}

export default SystemPermissionsSection;
