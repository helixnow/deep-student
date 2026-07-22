import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

export type RecoveryCandidateId = 'legacy' | 'slotA' | 'slotB';

export interface RecoveryCandidateSummary {
  id: RecoveryCandidateId;
  has_data: boolean;
  has_database: boolean;
  size_bytes: number;
  latest_modified_at: string | null;
  database_files: string[];
  core_database_files: string[];
  valid_core_database_files: string[];
  selectable: boolean;
  selection_block_reason: string | null;
  recommended: boolean;
  recommendation_reason: string | null;
}

export interface StartupRecoveryIncident {
  id: string;
  kind: string;
  created_at: string;
  status: 'preparing' | 'awaiting_selection' | 'resolving' | 'resolved' | 'failed';
  reason: string;
  quarantined_entry_count: number;
  candidates: RecoveryCandidateSummary[];
  selected_candidate: RecoveryCandidateId | null;
  resolved_at: string | null;
  recovery_error: string | null;
  failed_operation: string | null;
  retry_requires_restart: boolean;
}

export interface StartupRecoveryStatus {
  recovery_required: boolean;
  incident: StartupRecoveryIncident | null;
}

export interface ResolveStartupRecoveryResponse {
  resolved: boolean;
  restart_required: boolean;
  selected_candidate: RecoveryCandidateId;
  incident_id: string;
}

function normalizeStartupRecoveryIncident(
  rawIncident: Record<string, unknown>,
): StartupRecoveryIncident {
  const rawCandidates = Array.isArray(rawIncident.candidates)
    ? rawIncident.candidates as Array<Record<string, unknown>>
    : [];
  const resolved = Boolean(rawIncident.resolved);

  return {
    id: String(rawIncident.id ?? rawIncident.incident_id ?? ''),
    kind: String(rawIncident.kind ?? 'timeline_conflict'),
    created_at: String(rawIncident.created_at ?? ''),
    status: resolved ? 'resolved' : 'awaiting_selection',
    reason: String(rawIncident.reason ?? ''),
    quarantined_entry_count: Number(rawIncident.quarantined_entry_count ?? 0),
    selected_candidate: (rawIncident.selected_candidate ?? null) as RecoveryCandidateId | null,
    resolved_at: typeof rawIncident.resolved_at === 'string' ? rawIncident.resolved_at : null,
    recovery_error:
      typeof rawIncident.recovery_error === 'string' ? rawIncident.recovery_error : null,
    failed_operation:
      typeof rawIncident.failed_operation === 'string' ? rawIncident.failed_operation : null,
    retry_requires_restart: Boolean(rawIncident.retry_requires_restart),
    candidates: rawCandidates.map((candidate) => ({
      id: String(candidate.id) as RecoveryCandidateId,
      has_data: Boolean(candidate.has_data),
      has_database: Boolean(candidate.has_database),
      size_bytes: Number(candidate.size_bytes ?? 0),
      latest_modified_at:
        typeof (candidate.latest_modified_at ?? candidate.latest_modified) === 'string'
          ? String(candidate.latest_modified_at ?? candidate.latest_modified)
          : null,
      database_files: Array.isArray(candidate.database_files ?? candidate.database_filenames)
        ? (candidate.database_files ?? candidate.database_filenames) as string[]
        : [],
      core_database_files: Array.isArray(candidate.core_database_files ?? candidate.core_database_filenames)
        ? (candidate.core_database_files ?? candidate.core_database_filenames) as string[]
        : [],
      valid_core_database_files: Array.isArray(
        candidate.valid_core_database_files ?? candidate.valid_core_database_filenames,
      )
        ? (candidate.valid_core_database_files ?? candidate.valid_core_database_filenames) as string[]
        : [],
      selectable: candidate.selectable === undefined
        ? Boolean(candidate.has_database)
        : Boolean(candidate.selectable),
      selection_block_reason:
        typeof candidate.selection_block_reason === 'string'
          ? candidate.selection_block_reason
          : null,
      recommended: Boolean(candidate.recommended),
      recommendation_reason:
        typeof candidate.recommendation_reason === 'string' && candidate.recommendation_reason
          ? candidate.recommendation_reason
          : null,
    })),
  };
}

export async function getStartupRecoveryStatus(): Promise<StartupRecoveryStatus> {
  const raw = await invoke<Record<string, unknown>>('get_startup_recovery_status');
  const rawIncident = raw.incident as Record<string, unknown> | null | undefined;
  if (!rawIncident) {
    return {
      recovery_required: Boolean(raw.recovery_required),
      incident: null,
    };
  }

  return {
    recovery_required: Boolean(raw.recovery_required),
    incident: normalizeStartupRecoveryIncident(rawIncident),
  };
}

export async function listStartupRecoveryIncidents(): Promise<StartupRecoveryIncident[]> {
  const raw = await invoke<Array<Record<string, unknown>>>('list_startup_recovery_incidents');
  return raw.map(normalizeStartupRecoveryIncident);
}

export async function openStartupRecoveryIncidentFolder(incidentId: string): Promise<void> {
  return invoke<void>('open_startup_recovery_incident_folder', { incidentId });
}

export async function exportStartupRecoveryIncident(
  incidentId: string,
): Promise<string | null> {
  const destination = await save({
    defaultPath: `deep-student-recovery-${incidentId}.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (!destination) return null;
  return invoke<string>('export_startup_recovery_incident', {
    incidentId,
    destination,
  });
}

export async function exportStartupRecoveryReport(): Promise<string | null> {
  const destination = await save({
    defaultPath: `deep-student-recovery-diagnostic-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (!destination) return null;
  return invoke<string>('export_startup_recovery_report', { destination });
}

export async function resolveStartupRecovery(
  candidateId: RecoveryCandidateId,
): Promise<ResolveStartupRecoveryResponse> {
  return invoke<ResolveStartupRecoveryResponse>('resolve_startup_recovery', {
    candidateId,
  });
}

export async function retryStartupRecoveryPreflight(): Promise<StartupRecoveryStatus> {
  const raw = await invoke<Record<string, unknown>>('retry_startup_recovery_preflight');
  const rawIncident = raw.incident as Record<string, unknown> | null | undefined;
  return {
    recovery_required: Boolean(raw.recovery_required),
    incident: rawIncident ? normalizeStartupRecoveryIncident(rawIncident) : null,
  };
}

export async function restartAfterRecovery(): Promise<void> {
  try {
    localStorage.setItem('deep-student.pending-recovery-receipt', '1');
  } catch {
    // Storage can be unavailable in hardened webviews; restart still proceeds.
  }
  return invoke<void>('restart_app');
}

export async function retryRecoveryStartup(): Promise<void> {
  return invoke<void>('restart_app');
}
