import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  Clock,
  Database,
  Export,
  FolderOpen,
  HardDrive,
  ShieldCheck,
  Warning,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/types/dataGovernance';
import { getMaintenanceStatus } from '@/api/dataGovernance';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';
import {
  exportStartupRecoveryIncident,
  exportStartupRecoveryReport,
  getStartupRecoveryStatus,
  listStartupRecoveryIncidents,
  openStartupRecoveryIncidentFolder,
  resolveStartupRecovery,
  retryRecoveryStartup,
  retryStartupRecoveryPreflight,
  restartAfterRecovery,
  type RecoveryCandidateId,
  type RecoveryCandidateSummary,
  type ResolveStartupRecoveryResponse,
  type StartupRecoveryStatus,
} from './dataRecoveryApi';

interface RecoveryCenterProps {
  mode?: 'startup' | 'settings';
  initialStatus?: StartupRecoveryStatus | null;
  debugPreview?: boolean;
  onDebugExit?: () => void;
}

function candidateTitle(id: RecoveryCandidateId, t: ReturnType<typeof useTranslation>['t']) {
  if (id === 'legacy') return t('data:recovery.candidate_legacy');
  if (id === 'slotA') return t('data:recovery.candidate_slot_a');
  return t('data:recovery.candidate_slot_b');
}

function formatDate(value: string | null, locale?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

const CandidateCard: React.FC<{
  candidate: RecoveryCandidateSummary;
  selected: boolean;
  onSelect: () => void;
}> = ({ candidate, selected, onSelect }) => {
  const { t, i18n } = useTranslation(['data']);
    const unavailable = !candidate.selectable;

  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group min-w-0 rounded-[var(--radius-shell-panel)] border p-4 text-left ui-state-colors',
        'bg-[color:var(--surface-panel)] shadow-[var(--shadow-shell-soft)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--input-shell-focus)]',
        selected
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--surface-panel-strong)]'
          : 'border-[color:var(--shell-workspace-border)] hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--surface-panel-strong)]',
        unavailable && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-shell-control)]',
            selected ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground',
          )}>
            <Database size={18} weight={selected ? 'fill' : 'regular'} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {candidateTitle(candidate.id, t)}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {candidate.has_database
                ? t('data:recovery.database_count', { count: candidate.database_files.length })
                : t('data:recovery.no_database')}
            </div>
          </div>
        </div>
              {candidate.recommended && candidate.selectable && (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
            {t('data:recovery.recommended')}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-3 text-xs">
        <div>
          <div className="text-muted-foreground">{t('data:recovery.size')}</div>
          <div className="mt-1 font-medium text-foreground">{formatBytes(candidate.size_bytes)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('data:recovery.last_modified')}</div>
          <div className="mt-1 line-clamp-1 font-medium text-foreground">
            {formatDate(candidate.latest_modified_at, i18n.language)}
          </div>
        </div>
      </div>

              {unavailable && (
                <p className="mt-3 text-xs leading-5 text-warning">
                  {t('data:recovery.candidate_no_core_database')}
                </p>
              )}

              {candidate.recommended && candidate.selectable && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t('data:recovery.recommended_reason')}
        </p>
      )}
    </button>
  );
};

export const RecoveryCenter: React.FC<RecoveryCenterProps> = ({
  mode = 'settings',
  initialStatus = null,
  debugPreview = false,
  onDebugExit,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const [status, setStatus] = useState<StartupRecoveryStatus | null>(initialStatus);
  const [loading, setLoading] = useState(initialStatus == null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecoveryCandidateId | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveStartupRecoveryResponse | null>(null);
  const [componentIssues, setComponentIssues] = useState<StartupComponentIssue[]>([]);
  const [history, setHistory] = useState<StartupRecoveryStatus['incident'][]>([]);
  const [retryingPreflight, setRetryingPreflight] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<string | null>(null);
  const [recoveryActionError, setRecoveryActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [next, maintenance, incidents] = await Promise.all([
        getStartupRecoveryStatus(),
        mode === 'settings' ? getMaintenanceStatus().catch(() => null) : Promise.resolve(null),
        mode === 'settings' ? listStartupRecoveryIncidents().catch(() => []) : Promise.resolve([]),
      ]);
      setStatus(next);
      setHistory(incidents);
      setComponentIssues(
        maintenance?.component_issues
        ?? maintenance?.component_health?.components?.filter((entry) => entry.status !== 'healthy')
        ?? [],
      );
        const recommended = next.incident?.candidates.find(
          (candidate) => candidate.recommended && candidate.selectable,
        );
      setSelected(recommended?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (initialStatus) {
      const recommended = initialStatus.incident?.candidates.find(
        (candidate) => candidate.recommended && candidate.selectable,
      );
      setSelected(recommended?.id ?? null);
      return;
    }
    void refresh();
  }, [initialStatus, refresh]);

  const selectedCandidate = useMemo(
    () => status?.incident?.candidates.find((candidate) => candidate.id === selected) ?? null,
    [selected, status],
  );

  const handleResolve = useCallback(async () => {
    if (!selected || resolving) return;
    setResolving(true);
    setResolveError(null);
    try {
      const next = debugPreview
        ? {
            resolved: true,
            restart_required: true,
            selected_candidate: selected,
            incident_id: status?.incident?.id ?? 'debug-preview',
          }
        : await resolveStartupRecovery(selected);
      setResult(next);
      setConfirming(false);
      try {
        localStorage.setItem('deep-student.pending-recovery-receipt', '1');
      } catch {
        // Navigation receipt is best-effort; the durable incident remains on disk.
      }
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : String(error));
    } finally {
      setResolving(false);
    }
  }, [debugPreview, resolving, selected, status?.incident?.id]);

  const handleRetryPreflight = useCallback(async () => {
    if (retryingPreflight) return;
    setRetryingPreflight(true);
    setLoadError(null);
    try {
      if (debugPreview) {
        setStatus({ recovery_required: false, incident: null });
        return;
      }
      if (status?.incident?.retry_requires_restart) {
        await retryRecoveryStartup();
        return;
      }
      const next = await retryStartupRecoveryPreflight();
      setStatus(next);
      const recommended = next.incident?.candidates.find(
        (candidate) => candidate.recommended && candidate.selectable,
      );
      setSelected(recommended?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingPreflight(false);
    }
  }, [debugPreview, retryingPreflight, status?.incident?.retry_requires_restart]);

  const runRecoveryAction = useCallback(async (key: string, action: () => Promise<unknown>) => {
    if (recoveryAction) return;
    setRecoveryAction(key);
    setRecoveryActionError(null);
    try {
      await action();
    } catch (error) {
      setRecoveryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveryAction(null);
    }
  }, [recoveryAction]);

  if (loading) {
    return (
      <div className="flex min-h-[280px] items-center justify-center text-sm text-muted-foreground">
        <CircleNotch className="mr-2 animate-spin" size={18} />
        {t('data:recovery.scanning')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-[var(--radius-shell-panel)] border border-destructive/30 bg-destructive/5 p-5">
        <div className="flex items-center gap-2 font-medium text-destructive">
          <Warning size={18} />
          {t('data:recovery.scan_failed')}
        </div>
        <p className="mt-2 break-words text-sm text-muted-foreground">{loadError}</p>
        <DsButton className="mt-4" variant="secondary" size="sm" onClick={() => void refresh()}>
          <ArrowClockwise size={15} className="mr-1.5" />
          {t('common:actions.retry')}
        </DsButton>
      </div>
    );
  }

  if (!status?.recovery_required || !status.incident) {
    if (componentIssues.length > 0) {
      return (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-shell-panel)] border border-warning/30 bg-warning/5 p-5">
            <div className="flex items-start gap-3">
              <Warning className="mt-0.5 shrink-0 text-warning" size={20} />
              <div>
                <h3 className="font-semibold text-foreground">
                  {t('data:recovery.component_recovery_title')}
                </h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {t('data:recovery.partial_component_description')}
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {componentIssues.map((issue) => (
              <div
                key={issue.component}
                className="rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{issue.component}</span>
                  <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                    {issue.status}
                  </span>
                </div>
                <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                  {issue.reason || t('data:recovery.component_unknown_reason')}
                </p>
              </div>
            ))}
          </div>
          <DsButton variant="secondary" onClick={() => void refresh()}>
            <ArrowClockwise size={15} className="mr-1.5" />
            {t('common:actions.refresh')}
          </DsButton>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <div className="rounded-[var(--radius-shell-panel)] border border-success/25 bg-success/5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
              <ShieldCheck size={21} weight="fill" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('data:recovery.healthy_title')}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t('data:recovery.healthy_description')}
              </p>
            </div>
          </div>
        </div>

        {history.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('data:recovery.history_title')}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('data:recovery.history_description')}
            </p>
            <div className="mt-3 space-y-2">
              {history.map((item) => item && (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {item.selected_candidate
                          ? candidateTitle(item.selected_candidate, t)
                          : t('data:recovery.history_unresolved')}
                      </span>
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        item.status === 'resolved'
                          ? 'bg-success/10 text-success'
                          : 'bg-warning/10 text-warning',
                      )}>
                        {item.status === 'resolved'
                          ? t('data:recovery.history_resolved')
                          : t('data:recovery.awaiting_selection')}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(item.resolved_at || item.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <DsButton
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(recoveryAction)}
                      onClick={() => void runRecoveryAction(
                        `open-${item.id}`,
                        () => openStartupRecoveryIncidentFolder(item.id),
                      )}
                    >
                      <FolderOpen size={14} className="mr-1.5" />
                      {t('data:recovery.open_incident_folder')}
                    </DsButton>
                    <DsButton
                      size="sm"
                      variant="secondary"
                      disabled={Boolean(recoveryAction)}
                      onClick={() => void runRecoveryAction(
                        `export-${item.id}`,
                        () => exportStartupRecoveryIncident(item.id),
                      )}
                    >
                      <Export size={14} className="mr-1.5" />
                      {t('data:recovery.export_incident')}
                    </DsButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
          {recoveryActionError && (
            <p className="break-words text-sm text-destructive">{recoveryActionError}</p>
          )}
      </div>
    );
  }

  const incident = status.incident;

  return (
    <div className="space-y-5">
        {incident.recovery_error && (
          <div className="rounded-[var(--radius-shell-panel)] border border-destructive/30 bg-destructive/5 p-5">
            <div className="flex items-start gap-3">
              <Warning className="mt-0.5 shrink-0 text-destructive" size={20} />
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-foreground">
                  {t('data:recovery.preflight_failed_title')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {t('data:recovery.preflight_failed_description')}
                </p>
                <p className="mt-2 break-words rounded-[var(--radius-shell-control)] bg-background/60 px-3 py-2 font-mono text-xs text-destructive">
                  {incident.recovery_error}
                </p>
                <DsButton
                  className="mt-4"
                  variant="secondary"
                  disabled={retryingPreflight}
                  onClick={() => void handleRetryPreflight()}
                >
                  <ArrowClockwise
                    size={15}
                    className={cn('mr-1.5', retryingPreflight && 'animate-spin')}
                  />
                  {incident.retry_requires_restart
                    ? t('data:recovery.retry_startup')
                    : t('data:recovery.retry_preflight')}
                </DsButton>
                {!debugPreview && (
                  <DsButton
                    className="mt-4 ml-2"
                    variant="ghost"
                    disabled={Boolean(recoveryAction)}
                    onClick={() => void runRecoveryAction('report', exportStartupRecoveryReport)}
                  >
                    <Export size={15} className="mr-1.5" />
                    {t('data:recovery.export_diagnostic')}
                  </DsButton>
                )}
              </div>
            </div>
          </div>
        )}

      <div className="rounded-[var(--radius-shell-panel)] border border-warning/30 bg-warning/5 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning">
            <ShieldCheck size={21} weight="fill" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {t('data:recovery.protected_title')}
              </h2>
              <span className="rounded-full border border-warning/25 bg-background/50 px-2 py-0.5 text-[11px] text-warning">
                {t('data:recovery.awaiting_selection')}
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t('data:recovery.protected_description', {
                count: incident.quarantined_entry_count,
              })}
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="choose">
        <TabsList>
          <TabsTrigger value="choose">{t('data:recovery.tab_choose')}</TabsTrigger>
          <TabsTrigger value="safety">{t('data:recovery.tab_safety')}</TabsTrigger>
        </TabsList>

        <TabsContent value="choose" className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('data:recovery.choose_title')}
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t('data:recovery.choose_description')}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {incident.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                selected={candidate.id === selected}
                onSelect={() => {
                  setSelected(candidate.id);
                  setConfirming(false);
                  setResolveError(null);
                }}
              />
            ))}
          </div>

          {selectedCandidate && !result && (
            <div className="rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {t('data:recovery.selected_timeline', {
                      name: candidateTitle(selectedCandidate.id, t),
                    })}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('data:recovery.selection_preserves_others')}
                  </p>
                </div>
                {!confirming && (
                  <DsButton onClick={() => setConfirming(true)}>
                    {t('data:recovery.continue')}
                  </DsButton>
                )}
              </div>

              {confirming && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <div className="flex items-start gap-2 text-sm text-foreground">
                    <Warning className="mt-0.5 shrink-0 text-warning" size={16} />
                    <span>
                      {t('data:recovery.confirm_inline', {
                        name: candidateTitle(selectedCandidate.id, t),
                      })}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <DsButton disabled={resolving} onClick={() => void handleResolve()}>
                      {resolving && <CircleNotch size={16} className="mr-1.5 animate-spin" />}
                      {t('data:recovery.confirm_activate')}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      disabled={resolving}
                      onClick={() => setConfirming(false)}
                    >
                      {t('common:actions.cancel')}
                    </DsButton>
                  </div>
                </div>
              )}

              {resolveError && (
                <p className="mt-3 break-words text-sm text-destructive">{resolveError}</p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-[var(--radius-shell-panel)] border border-success/30 bg-success/5 p-5">
              <div className="flex items-start gap-3">
                <CheckCircle className="mt-0.5 shrink-0 text-success" size={21} weight="fill" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-foreground">
                    {t('data:recovery.resolved_title')}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t('data:recovery.resolved_description')}
                  </p>
                  <DsButton
                    className="mt-4"
                    onClick={() => {
                      if (debugPreview) {
                        onDebugExit?.();
                      } else {
                        void restartAfterRecovery();
                      }
                    }}
                  >
                    <ArrowClockwise size={16} className="mr-1.5" />
                    {debugPreview
                      ? t('data:recovery.debug_exit_preview')
                      : t('data:recovery.restart_now')}
                  </DsButton>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="safety">
          <div className="grid gap-3 md:grid-cols-3">
            {[
              [ShieldCheck, 'data:recovery.safety_isolated_title', 'data:recovery.safety_isolated_desc'],
              [HardDrive, 'data:recovery.safety_preserved_title', 'data:recovery.safety_preserved_desc'],
              [Clock, 'data:recovery.safety_reversible_title', 'data:recovery.safety_reversible_desc'],
            ].map(([Icon, titleKey, descriptionKey]) => {
              const SafetyIcon = Icon as typeof ShieldCheck;
              return (
                <div
                  key={String(titleKey)}
                  className="rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] p-4"
                >
                  <SafetyIcon size={19} className="text-primary" />
                  <h3 className="mt-3 text-sm font-semibold text-foreground">
                    {t(String(titleKey))}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t(String(descriptionKey))}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            {mode === 'startup'
              ? t('data:recovery.startup_safety_note')
              : t('data:recovery.settings_safety_note')}
          </p>
          {!debugPreview && <div className="mt-4 flex flex-wrap gap-2">
            <DsButton
              size="sm"
              variant="ghost"
              disabled={Boolean(recoveryAction)}
              onClick={() => void runRecoveryAction(
                `open-${incident.id}`,
                () => openStartupRecoveryIncidentFolder(incident.id),
              )}
            >
              <FolderOpen size={14} className="mr-1.5" />
              {t('data:recovery.open_incident_folder')}
            </DsButton>
            <DsButton
              size="sm"
              variant="secondary"
              disabled={Boolean(recoveryAction)}
              onClick={() => void runRecoveryAction(
                `export-${incident.id}`,
                () => exportStartupRecoveryIncident(incident.id),
              )}
            >
              <Export size={14} className="mr-1.5" />
              {t('data:recovery.export_incident')}
            </DsButton>
            <DsButton
              size="sm"
              variant="secondary"
              disabled={Boolean(recoveryAction)}
              onClick={() => void runRecoveryAction('report', exportStartupRecoveryReport)}
            >
              <Export size={14} className="mr-1.5" />
              {t('data:recovery.export_diagnostic')}
            </DsButton>
          </div>}
        </TabsContent>
      </Tabs>
      {recoveryActionError && (
        <p className="break-words text-sm text-destructive">{recoveryActionError}</p>
      )}
    </div>
  );
};

export default RecoveryCenter;
