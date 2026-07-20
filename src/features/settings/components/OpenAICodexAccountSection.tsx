import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  DeviceMobile,
  SignOut,
  Spinner,
  UserCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Progress } from '@/components/ui/shad/Progress';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { openUrl } from '@/utils/urlOpener';
import {
  OPENAI_CODEX_AUTH_CHANGED_EVENT,
  openaiCodexAuthClient,
  type OpenAICodexAuthChangedDetail,
  type OpenAICodexSafeAuthError,
  type OpenAICodexAuthStatus,
  type OpenAICodexLoginFlow,
  type OpenAICodexLoginStart,
  type OpenAICodexRateLimitWindow,
  type OpenAICodexUsage,
} from './openaiCodexAuthClient';

const STATUS_DEFAULT_LABELS: Record<OpenAICodexAuthStatus['state'], string> = {
  signed_out: 'Signed out',
  pending_browser: 'Waiting for browser',
  pending_device_code: 'Waiting for code',
  signed_in: 'Signed in',
  reauth_required: 'Sign-in required',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

const translate = (
  t: Translate,
  key: string,
  defaultValue: string,
  values?: Record<string, unknown>,
): string => t(`settings:vendor_panel.codex_oauth.${key}`, { defaultValue, ...values });

const toDate = (value?: string | number): Date | null => {
  if (value == null || value === '') return null;
  let timestamp: string | number = value;
  if (typeof timestamp === 'string' && /^\d+(?:\.\d+)?$/.test(timestamp)) {
    timestamp = Number(timestamp);
  }
  if (typeof timestamp === 'number' && timestamp < 1_000_000_000_000) {
    timestamp *= 1_000;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateTime = (value: string | number | undefined, locale?: string): string | null => {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(locale || undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const formatWindowDuration = (minutes: number | undefined, t: Translate): string | null => {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 10_080 === 0) {
    return translate(t, 'window_weeks', '{{count}} week window', { count: minutes / 10_080 });
  }
  if (minutes % 1_440 === 0) {
    return translate(t, 'window_days', '{{count}} day window', { count: minutes / 1_440 });
  }
  if (minutes % 60 === 0) {
    return translate(t, 'window_hours', '{{count}} hour window', { count: minutes / 60 });
  }
  return translate(t, 'window_minutes', '{{count}} minute window', { count: minutes });
};

const formatPlan = (planType: string | undefined, t: Translate): string | null => {
  if (!planType) return null;
  const fallback = `${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
  return translate(t, `plans.${planType.toLowerCase()}`, fallback);
};

interface UsageWindowRow {
  key: string;
  label: string;
  window: OpenAICodexRateLimitWindow;
}

const collectUsageWindows = (usage: OpenAICodexUsage | null, t: Translate): UsageWindowRow[] => {
  if (!usage) return [];
  const groups = usage.rateLimitsByLimitId && Object.keys(usage.rateLimitsByLimitId).length > 0
    ? Object.entries(usage.rateLimitsByLimitId)
    : usage.rateLimits
      ? [[usage.rateLimits.limitId ?? 'default', usage.rateLimits] as const]
      : [];
  const showGroupName = groups.length > 1;
  const rows: UsageWindowRow[] = [];

  for (const [groupKey, group] of groups) {
    const groupName = group.limitName || group.limitId || groupKey;
    if (group.primary) {
      rows.push({
        key: `${groupKey}-primary`,
        label: showGroupName
          ? `${groupName} · ${translate(t, 'primary_window', 'Primary window')}`
          : translate(t, 'primary_window', 'Primary window'),
        window: group.primary,
      });
    }
    if (group.secondary) {
      rows.push({
        key: `${groupKey}-secondary`,
        label: showGroupName
          ? `${groupName} · ${translate(t, 'secondary_window', 'Secondary window')}`
          : translate(t, 'secondary_window', 'Secondary window'),
        window: group.secondary,
      });
    }
  }
  return rows;
};

const getAccountIdentity = (status: OpenAICodexAuthStatus | null): string | undefined => (
  status?.accountId ?? status?.accountHint ?? status?.email
);

const getAuthErrorMessage = (error: OpenAICodexSafeAuthError | undefined, t: Translate): string => {
  switch (error?.code) {
    case 'login_busy':
      return translate(t, 'errors.login_busy', 'Another sign-in is already in progress. Cancel it or wait.');
    case 'callback_bind_failed':
      return translate(t, 'errors.callback_bind_failed', 'Browser sign-in could not start locally. Use device-code sign-in instead.');
    case 'timeout':
    case 'network_error':
      return translate(t, 'errors.network', 'Could not reach OpenAI. Check your network and try again.');
    case 'authorization_denied':
    case 'cancelled':
      return translate(t, 'errors.authorization_denied', 'Authorization was not completed. Start sign-in again.');
    case 'credential_store_failed':
      return translate(t, 'errors.credential_store', 'Secure credential storage is unavailable. Restart the app and try again.');
    case 'invalid_state':
      return translate(t, 'errors.security', 'The sign-in response could not be verified. Start sign-in again.');
    case 'account_changed':
    case 'reauthentication_required':
      return translate(t, 'errors.reauthentication', 'Your ChatGPT session changed or expired. Sign in again.');
    default:
      break;
  }

  switch (error?.class) {
    case 'transient':
      return translate(t, 'errors.network', 'Could not reach OpenAI. Check your network and try again.');
    case 'cancelled':
      return translate(t, 'errors.authorization_denied', 'Authorization was not completed. Start sign-in again.');
    case 'reauthentication_required':
      return translate(t, 'errors.reauthentication', 'Your ChatGPT session changed or expired. Sign in again.');
    case 'security':
      return translate(t, 'errors.security', 'The sign-in response could not be verified. Start sign-in again.');
    default:
      return translate(t, 'operation_failed', 'Could not update the Codex account. Try again.');
  }
};

export const OpenAICodexAccountSection: React.FC = () => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const [status, setStatus] = useState<OpenAICodexAuthStatus | null>(null);
  const [login, setLogin] = useState<OpenAICodexLoginStart | null>(null);
  const [usage, setUsage] = useState<OpenAICodexUsage | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<OpenAICodexLoginFlow | 'cancel' | 'logout' | null>(null);
  const [operationFailed, setOperationFailed] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const mountedRef = useRef(true);
  const usageRequestSequenceRef = useRef(0);
  const authSnapshotRef = useRef<{
    state?: OpenAICodexAuthStatus['state'];
    identity?: string;
    generation?: number;
  }>({});

  const applyStatus = useCallback((nextStatus: OpenAICodexAuthStatus) => {
    if (!mountedRef.current) return;
    const nextSnapshot = {
      state: nextStatus.state,
      identity: getAccountIdentity(nextStatus),
      generation: nextStatus.generation,
    };
    const currentSnapshot = authSnapshotRef.current;
    if (
      currentSnapshot.state !== nextSnapshot.state
      || currentSnapshot.identity !== nextSnapshot.identity
      || currentSnapshot.generation !== nextSnapshot.generation
    ) {
      usageRequestSequenceRef.current += 1;
      setUsageLoading(false);
    }
    authSnapshotRef.current = nextSnapshot;
    setStatus(nextStatus);
    if (
      (nextStatus.state === 'pending_browser' || nextStatus.state === 'pending_device_code')
      && nextStatus.loginId
    ) {
      setLogin(current => {
        const previous = current?.loginId === nextStatus.loginId ? current : undefined;
        return {
          loginId: nextStatus.loginId!,
          flow: nextStatus.state === 'pending_device_code' ? 'device_code' : 'browser',
          authUrl: nextStatus.authUrl ?? previous?.authUrl,
          verificationUrl: nextStatus.verificationUrl ?? previous?.verificationUrl,
          userCode: nextStatus.userCode ?? previous?.userCode,
          expiresAt: nextStatus.expiresAt ?? previous?.expiresAt,
          pollIntervalSeconds: nextStatus.pollIntervalSeconds ?? previous?.pollIntervalSeconds,
        };
      });
    }
    setOperationFailed(false);
  }, []);

  const refreshStatus = useCallback(async (showLoading = false): Promise<OpenAICodexAuthStatus | null> => {
    if (showLoading && mountedRef.current) setStatusLoading(true);
    try {
      const nextStatus = await openaiCodexAuthClient.status();
      applyStatus(nextStatus);
      return nextStatus;
    } catch {
      if (mountedRef.current) setOperationFailed(true);
      return null;
    } finally {
      if (mountedRef.current) setStatusLoading(false);
    }
  }, [applyStatus]);

  const refreshUsage = useCallback(async () => {
    const requestSequence = ++usageRequestSequenceRef.current;
    const requestedSnapshot = authSnapshotRef.current;
    if (mountedRef.current) setUsageLoading(true);
    try {
      const nextUsage = await openaiCodexAuthClient.usage();
      const currentSnapshot = authSnapshotRef.current;
      if (
        mountedRef.current
        && requestSequence === usageRequestSequenceRef.current
        && currentSnapshot.state === 'signed_in'
        && currentSnapshot.identity === requestedSnapshot.identity
        && currentSnapshot.generation === requestedSnapshot.generation
      ) {
        setUsage(nextUsage);
      }
    } catch {
      if (mountedRef.current && requestSequence === usageRequestSequenceRef.current) {
        setUsage(null);
        await refreshStatus(false);
      }
    } finally {
      if (mountedRef.current && requestSequence === usageRequestSequenceRef.current) {
        setUsageLoading(false);
      }
    }
  }, [refreshStatus]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus(true);
    return () => {
      mountedRef.current = false;
      usageRequestSequenceRef.current += 1;
    };
  }, [refreshStatus]);

  const handleAuthChanged = useCallback((event: Event) => {
    const detail = (event as CustomEvent<OpenAICodexAuthChangedDetail>).detail;
    if (detail?.source === 'openai_codex_auth' && detail.status) applyStatus(detail.status);
  }, [applyStatus]);
  useEventRegistry(
    [{
      target: 'window',
      type: OPENAI_CODEX_AUTH_CHANGED_EVENT,
      listener: handleAuthChanged,
    }],
    [handleAuthChanged],
  );

  const statusState = status?.state;
  const isPending = statusState === 'pending_browser' || statusState === 'pending_device_code';

  const accountIdentity = getAccountIdentity(status);
  const accountGeneration = status?.generation;
  useEffect(() => {
    if (statusState === 'signed_in') {
      setLogin(null);
      setCodeCopied(false);
      void refreshUsage();
    } else if (statusState && statusState !== 'pending_browser' && statusState !== 'pending_device_code') {
      setUsage(null);
    }
  }, [statusState, accountIdentity, accountGeneration, refreshUsage]);

  const handleLogin = async (flow: OpenAICodexLoginFlow) => {
    usageRequestSequenceRef.current += 1;
    setUsage(null);
    setUsageLoading(false);
    setBusyAction(flow);
    setOperationFailed(false);
    setCodeCopied(false);
    try {
      const result = await openaiCodexAuthClient.loginStart(flow);
      if (!mountedRef.current) return;
      setLogin(result);
      applyStatus({
        state: flow === 'browser' ? 'pending_browser' : 'pending_device_code',
        loginId: result.loginId,
        authUrl: result.authUrl,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: result.expiresAt,
        pollIntervalSeconds: result.pollIntervalSeconds,
      });
      const destination = flow === 'browser' ? result.authUrl : result.verificationUrl;
      if (destination) await openUrl(destination);
    } catch {
      if (mountedRef.current) setOperationFailed(true);
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    const attemptId = login?.loginId ?? status?.loginId;
    if (!attemptId) {
      setOperationFailed(true);
      return;
    }
    usageRequestSequenceRef.current += 1;
    setUsageLoading(false);
    setBusyAction('cancel');
    setOperationFailed(false);
    try {
      await openaiCodexAuthClient.loginCancel(attemptId);
      if (!mountedRef.current) return;
      setLogin(current => current?.loginId === attemptId ? null : current);
      setCodeCopied(false);
      await refreshStatus(false);
    } catch {
      if (mountedRef.current) setOperationFailed(true);
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleLogout = async () => {
    usageRequestSequenceRef.current += 1;
    setUsage(null);
    setUsageLoading(false);
    setBusyAction('logout');
    setOperationFailed(false);
    try {
      await openaiCodexAuthClient.logout();
      if (!mountedRef.current) return;
      setUsage(null);
      await refreshStatus(false);
    } catch {
      if (mountedRef.current) setOperationFailed(true);
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleCopyCode = async () => {
    if (!login?.userCode || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      if (mountedRef.current) setCodeCopied(true);
    } catch {
      // The code remains selectable when clipboard access is unavailable.
    }
  };

  const state = statusState;
  const stateLabel = state
    ? translate(t, `status.${state}`, STATUS_DEFAULT_LABELS[state])
    : translate(t, 'status.checking', 'Checking');
  const usageWindows = useMemo(() => collectUsageWindows(usage, t), [usage, t]);
  const pendingExpiry = formatDateTime(login?.expiresAt ?? status?.expiresAt, i18n.language);
  const planLabel = formatPlan(status?.planType, t);
  const disabled = busyAction !== null;
  const pendingAttemptId = login?.loginId ?? status?.loginId;

  return (
    <section
      aria-label={translate(t, 'title', 'ChatGPT account')}
      className="overflow-hidden rounded-lg border border-border/40"
      data-testid="openai-codex-account"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-foreground">
            <UserCircle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium text-foreground">
                {translate(t, 'title', 'ChatGPT account')}
              </h4>
              <Badge
                variant="secondary"
                role="status"
                aria-live="polite"
                className={state === 'signed_in' ? 'text-green-700 dark:text-green-300' : undefined}
              >
                {state === 'signed_in' && <Check className="mr-1 h-3 w-3" aria-hidden="true" />}
                {stateLabel}
              </Badge>
            </div>
            {state === 'signed_in' ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {(status.email || status.accountHint) && <span>{status.email || status.accountHint}</span>}
                {planLabel && <span>{planLabel}</span>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {state === 'reauth_required'
                  ? translate(t, 'reauth_description', 'Your ChatGPT session needs to be renewed.')
                  : isPending
                    ? translate(t, 'pending_description', 'Complete sign-in in the browser.')
                    : translate(t, 'signed_out_description', 'Sign in with ChatGPT to use your Codex plan allowance.')}
              </p>
            )}
          </div>
        </div>

        {state === 'signed_in' && (
          <div className="flex shrink-0 items-center gap-1">
            <NotionButton
              size="sm"
              variant="ghost"
              iconOnly
              onClick={() => void refreshUsage()}
              disabled={disabled || usageLoading}
              aria-label={translate(t, 'refresh_usage', 'Refresh usage')}
              title={translate(t, 'refresh_usage', 'Refresh usage')}
            >
              <ArrowClockwise className={`h-3.5 w-3.5 ${usageLoading ? 'animate-spin' : ''}`} />
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={() => void handleLogout()}
              disabled={disabled}
            >
              {busyAction === 'logout' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <SignOut className="h-3.5 w-3.5" />}
              {translate(t, 'sign_out', 'Sign out')}
            </NotionButton>
          </div>
        )}
      </div>

      {statusLoading && !status ? (
        <div className="flex items-center gap-2 border-t border-border/30 px-4 py-3 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5 animate-spin" />
          {translate(t, 'checking', 'Checking account status…')}
        </div>
      ) : (state === 'signed_out' || state === 'reauth_required' || (!status && operationFailed)) ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/30 px-4 py-3">
          <NotionButton
            size="sm"
            variant="primary"
            onClick={() => void handleLogin('browser')}
            disabled={disabled}
          >
            {busyAction === 'browser' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <ArrowSquareOut className="h-3.5 w-3.5" />}
            {state === 'reauth_required'
              ? translate(t, 'sign_in_again', 'Sign in again')
              : translate(t, 'sign_in_browser', 'Sign in with browser')}
          </NotionButton>
          <NotionButton
            size="sm"
            variant="ghost"
            onClick={() => void handleLogin('device_code')}
            disabled={disabled}
          >
            {busyAction === 'device_code' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <DeviceMobile className="h-3.5 w-3.5" />}
            {translate(t, 'sign_in_device', 'Use device code')}
          </NotionButton>
          {state === 'reauth_required' && (
            <NotionButton size="sm" variant="ghost" onClick={() => void handleLogout()} disabled={disabled}>
              {busyAction === 'logout' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <SignOut className="h-3.5 w-3.5" />}
              {translate(t, 'remove_account', 'Remove account')}
            </NotionButton>
          )}
          {!status && (
            <NotionButton size="sm" variant="ghost" onClick={() => void refreshStatus(true)} disabled={disabled}>
              <ArrowClockwise className="h-3.5 w-3.5" />
              {translate(t, 'retry', 'Retry')}
            </NotionButton>
          )}
        </div>
      ) : isPending ? (
        <div className="space-y-3 border-t border-border/30 px-4 py-3">
          {login?.userCode && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {translate(t, 'device_code', 'One-time code')}
              </span>
              <code className="select-all rounded bg-muted px-2 py-1 font-mono text-sm font-medium tracking-widest text-foreground">
                {login.userCode}
              </code>
              <NotionButton
                size="sm"
                variant="ghost"
                iconOnly
                onClick={() => void handleCopyCode()}
                aria-label={codeCopied
                  ? translate(t, 'code_copied', 'Code copied')
                  : translate(t, 'copy_code', 'Copy code')}
                title={translate(t, 'copy_code', 'Copy code')}
              >
                {codeCopied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </NotionButton>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {login?.authUrl && (
              <NotionButton size="sm" variant="ghost" onClick={() => void openUrl(login.authUrl!)}>
                <ArrowSquareOut className="h-3.5 w-3.5" />
                {translate(t, 'reopen_sign_in', 'Reopen sign-in page')}
              </NotionButton>
            )}
            {login?.verificationUrl && (
              <NotionButton size="sm" variant="ghost" onClick={() => void openUrl(login.verificationUrl!)}>
                <ArrowSquareOut className="h-3.5 w-3.5" />
                {translate(t, 'open_verification', 'Open verification page')}
              </NotionButton>
            )}
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={() => void handleCancel()}
              disabled={disabled || !pendingAttemptId}
            >
              {busyAction === 'cancel' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              {translate(t, 'cancel_sign_in', 'Cancel sign-in')}
            </NotionButton>
            {pendingExpiry && (
              <span className="text-xs text-muted-foreground">
                {translate(t, 'expires_at', 'Expires {{time}}', { time: pendingExpiry })}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {state === 'signed_in' && (
        <div className="space-y-3 border-t border-border/30 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h5 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {translate(t, 'usage_title', 'Codex allowance')}
            </h5>
            {usageLoading && <Spinner className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {!usageLoading && usageWindows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(t, 'usage_empty', 'Usage data is not available yet.')}
            </p>
          ) : (
            <div className="space-y-3">
              {usageWindows.map(row => {
                const usedPercent = row.window.usedPercent;
                const duration = formatWindowDuration(row.window.windowDurationMins, t);
                const reset = formatDateTime(row.window.resetsAt, i18n.language);
                return (
                  <div key={row.key} className="space-y-1.5" data-testid="codex-usage-window">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                      <span className="font-medium text-foreground">{row.label}</span>
                      <span className="text-muted-foreground">
                        {usedPercent == null
                          ? translate(t, 'usage_unknown', 'Usage unavailable')
                          : translate(t, 'usage_percent', '{{percent}}% used', { percent: Math.round(usedPercent) })}
                      </span>
                    </div>
                    {usedPercent != null && (
                      <Progress
                        value={usedPercent}
                        aria-label={`${row.label}: ${Math.round(usedPercent)}%`}
                      />
                    )}
                    {(duration || reset) && (
                      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{duration}</span>
                        {reset && <span>{translate(t, 'resets_at', 'Resets {{time}}', { time: reset })}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {(operationFailed || status?.error) && (
        <div className="flex items-start gap-2 border-t border-border/30 px-4 py-3 text-xs text-destructive" role="alert">
          <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{status?.error
            ? getAuthErrorMessage(status.error, t)
            : translate(t, 'operation_failed', 'Could not update the Codex account. Try again.')}</span>
        </div>
      )}
    </section>
  );
};

export default OpenAICodexAccountSection;
