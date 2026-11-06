import React from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import {
  clearInkDiagnostics,
  getInkDiagnosticsSnapshot,
  isInkDiagnosticsEnabled,
  setInkDiagnosticsEnabled,
  subscribeInkDiagnostics,
} from './inkDiagnostics';

const EXPORT_FORMAT = 'deepstudent.ink-diagnostics';
const EXPORT_VERSION = 1;

interface DiagnosticsSummary {
  eventCount: number;
  truncated: boolean;
  droppedEvents: number;
}

interface DiagnosticsNotice {
  kind: 'info' | 'error';
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * The diagnostics core owns the exact snapshot shape. Keep this reader
 * tolerant so the UI can render bounded counts from an older/newer core
 * without assuming a single field name.
 */
export function summarizeInkDiagnosticsSnapshot(snapshot: unknown): DiagnosticsSummary {
  const record = asRecord(snapshot);
  if (!record) return { eventCount: 0, truncated: false, droppedEvents: 0 };

  const events = Array.isArray(record.events)
    ? record.events
    : Array.isArray(record.records)
      ? record.records
      : Array.isArray(record.entries)
        ? record.entries
        : null;
  const eventCount = events?.length
    ?? readNonNegativeInteger(record.retainedCount)
    ?? readNonNegativeInteger(record.eventCount)
    ?? readNonNegativeInteger(record.count)
    ?? readNonNegativeInteger(record.total)
    ?? 0;

  const droppedCandidates = [
    record.droppedEvents,
    record.dropped,
    record.droppedCount,
    record.truncatedCount,
    record.overflow,
  ];
  let droppedEvents = 0;
  for (const candidate of droppedCandidates) {
    const parsed = readNonNegativeInteger(candidate);
    if (parsed !== null) {
      droppedEvents = Math.max(droppedEvents, parsed);
    }
  }

  const explicitTruncated = record.truncated === true
    || record.isTruncated === true
    || record.truncation === true
    || (asRecord(record.truncation)?.truncated === true);

  return {
    eventCount,
    truncated: explicitTruncated || droppedEvents > 0,
    droppedEvents,
  };
}

/** Build the on-disk JSON envelope. `truncated` is always explicit. */
export function buildInkDiagnosticsExportPayload(
  snapshot: unknown,
  exportedAt: Date = new Date(),
): Record<string, unknown> {
  const summary = summarizeInkDiagnosticsSnapshot(snapshot);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    truncated: summary.truncated,
    truncation: {
      truncated: summary.truncated,
      droppedEvents: summary.droppedEvents,
    },
    eventCount: summary.eventCount,
    snapshot,
  };
}

function exportFileName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `ink-diagnostics-${stamp}.json`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

function readSnapshotSafely(): unknown {
  try {
    return getInkDiagnosticsSnapshot();
  } catch {
    return null;
  }
}

function useDiagnosticsEnabled(): boolean {
  return React.useSyncExternalStore(
    subscribeInkDiagnostics,
    isInkDiagnosticsEnabled,
    isInkDiagnosticsEnabled,
  );
}

export interface InkDiagnosticsControlsProps {
  className?: string;
}

/**
 * Small, opt-in entry point for the in-memory handwriting diagnostics log.
 * It intentionally has no per-event subscription: the count is refreshed only
 * when recording stops or when export/clear is requested.
 */
export function InkDiagnosticsControls({ className }: InkDiagnosticsControlsProps) {
  const { t } = useTranslation('ink');
  const enabled = useDiagnosticsEnabled();
  const [summary, setSummary] = React.useState<DiagnosticsSummary | null>(null);
  const [notice, setNotice] = React.useState<DiagnosticsNotice | null>(null);
  const [exporting, setExporting] = React.useState(false);

  const refreshSummary = React.useCallback(() => {
    const next = summarizeInkDiagnosticsSnapshot(readSnapshotSafely());
    setSummary(next);
    return next;
  }, []);

  const toggleRecording = React.useCallback(() => {
    try {
      const next = !isInkDiagnosticsEnabled();
      setInkDiagnosticsEnabled(next);
      setNotice(null);
      if (next) {
        setSummary(null);
      } else {
        refreshSummary();
      }
    } catch {
      setNotice({ kind: 'error', text: t('diagnostics.actionFailed') });
    }
  }, [refreshSummary, t]);

  const clear = React.useCallback(() => {
    try {
      clearInkDiagnostics();
      const next = refreshSummary();
      setNotice({
        kind: 'info',
        text: t('diagnostics.cleared', { count: next.eventCount }),
      });
    } catch {
      setNotice({ kind: 'error', text: t('diagnostics.actionFailed') });
    }
  }, [refreshSummary, t]);

  const exportJson = React.useCallback(async () => {
    if (exporting || enabled) return;
    setExporting(true);
    setNotice(null);
    try {
      const snapshot = readSnapshotSafely();
      const exportedAt = new Date();
      const exported = buildInkDiagnosticsExportPayload(snapshot, exportedAt);
      const content = JSON.stringify(exported, null, 2);
      const { fileManager } = await import('@/utils/fileManager');
      const result = await fileManager.saveTextFile({
        title: t('diagnostics.title'),
        defaultFileName: exportFileName(exportedAt),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        content,
      });
      setSummary(summarizeInkDiagnosticsSnapshot(snapshot));
      if (result.canceled) {
        setNotice({ kind: 'info', text: t('diagnostics.exportCanceled') });
      } else {
        setNotice({ kind: 'info', text: t('diagnostics.exportSuccess') });
      }
    } catch (error) {
      setNotice({
        kind: 'error',
        text: t('diagnostics.exportFailed', { message: errorMessage(error) }),
      });
    } finally {
      setExporting(false);
    }
  }, [enabled, exporting, t]);

  const summaryText = summary
    ? t(summary.truncated ? 'diagnostics.summaryTruncated' : 'diagnostics.summary', {
      count: summary.eventCount,
    })
    : null;

  return (
    <div
      data-testid="ink-diagnostics-controls"
      data-enabled={enabled ? 'true' : 'false'}
      role="group"
      aria-label={t('diagnostics.title')}
      className={cn('flex w-full min-w-0 flex-col gap-1.5 border-t border-border/50 pt-2', className)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="mr-1 text-xs font-medium text-muted-foreground">{t('diagnostics.title')}</span>
        <DsButton
          data-testid="ink-diagnostics-toggle"
          size="sm"
          variant={enabled ? 'default' : 'ghost'}
          aria-pressed={enabled}
          onClick={toggleRecording}
        >
          {t(enabled ? 'diagnostics.stop' : 'diagnostics.start')}
        </DsButton>
        <DsButton
          data-testid="ink-diagnostics-export"
          size="sm"
          variant="ghost"
          disabled={enabled || exporting}
          title={enabled ? t('diagnostics.exportHint') : undefined}
          onClick={() => { void exportJson(); }}
        >
          {t(exporting ? 'diagnostics.exporting' : 'diagnostics.export')}
        </DsButton>
        <DsButton
          data-testid="ink-diagnostics-clear"
          size="sm"
          variant="ghost"
          onClick={clear}
        >
          {t('diagnostics.clear')}
        </DsButton>
      </div>

      <output
        data-testid="ink-diagnostics-summary"
        data-truncated={summary?.truncated ? 'true' : 'false'}
        className="text-xs text-muted-foreground"
      >
        {enabled ? t('diagnostics.recording') : (summaryText ?? t('diagnostics.idle'))}
      </output>

      <p data-testid="ink-diagnostics-privacy" className="text-xs leading-snug text-muted-foreground">
        {t('diagnostics.privacy')}
      </p>

      {notice && (
        <p
          data-testid="ink-diagnostics-notice"
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={cn('text-xs leading-snug', notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

export default InkDiagnosticsControls;
