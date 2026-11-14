/**
 * SQL layer for the G09 skill usage ledger and candidate library
 * (`skill_usage.rs` + migration V20260909). All SQL lives here so the
 * electron-migration `sql-outside-repository` boundary stays green.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { now as currentInstant } from '../../../platform/time/index.ts';

export type SkillUsageKind = 'activation' | 'tool_load';
export const SkillUsageKind = {
  Activation: 'activation' as SkillUsageKind,
  ToolLoad: 'tool_load' as SkillUsageKind,
};

export function parseSkillUsageKind(raw: string): SkillUsageKind | undefined {
  return raw === 'activation' ? 'activation' : raw === 'tool_load' ? 'tool_load' : undefined;
}

export type SkillOutcome = 'success' | 'failed' | 'user_corrected' | 'unknown';
export const SkillOutcome = {
  Success: 'success' as SkillOutcome,
  Failed: 'failed' as SkillOutcome,
  UserCorrected: 'user_corrected' as SkillOutcome,
  Unknown: 'unknown' as SkillOutcome,
};

export function parseSkillOutcome(raw: string): SkillOutcome | undefined {
  return raw === 'success' || raw === 'failed' || raw === 'user_corrected' || raw === 'unknown' ? raw : undefined;
}

/** G07 finalization verdict → ledger outcome (`None` = do not mark). */
export function outcomeFromFinalizationVerdict(verdict: string): SkillOutcome | undefined {
  if (verdict === 'verified_complete' || verdict === 'complete_with_exceptions') return 'success';
  if (verdict === 'partial' || verdict === 'blocked') return 'failed';
  return undefined;
}

export interface SkillUsageRow {
  usageId: string;
  skillId: string;
  taskSessionId: string;
  runId: string | null;
  kind: SkillUsageKind;
  loads: number;
  outcome: SkillOutcome;
  latencyMs: number | null;
  tokens: number | null;
  createdAt: string;
}

function usageRowFromRow(row: Record<string, unknown>): SkillUsageRow {
  const kind = parseSkillUsageKind(String(row.kind));
  const outcome = parseSkillOutcome(String(row.outcome));
  if (kind === undefined) throw new Error(`invalid skill usage kind: ${String(row.kind)}`);
  if (outcome === undefined) throw new Error(`invalid skill usage outcome: ${String(row.outcome)}`);
  return {
    usageId: String(row.usage_id),
    skillId: String(row.skill_id),
    taskSessionId: String(row.task_session_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    kind,
    loads: Number(row.loads),
    outcome,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    tokens: row.tokens === null || row.tokens === undefined ? null : Number(row.tokens),
    createdAt: String(row.created_at),
  };
}

export interface NewSkillUsage {
  skillId: string;
  taskSessionId: string;
  runId?: string | null;
  kind: SkillUsageKind;
  loads: number;
  latencyMs?: number | null;
  tokens?: number | null;
}

export class SkillUsageRepo {
  _db: SqlExecutor;
  constructor(db: SqlExecutor) { this._db = db; }

  insert(usage: NewSkillUsage): string {
    const usageId = `susage_${globalThis.crypto.randomUUID()}`;
    this._db.run(
      `INSERT INTO skill_usage (
          usage_id, skill_id, task_session_id, run_id, kind, loads,
          outcome, latency_ms, tokens, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unknown', ?7, ?8, ?9)`,
      [usageId, usage.skillId, usage.taskSessionId, usage.runId ?? null, usage.kind,
        usage.loads, usage.latencyMs ?? null, usage.tokens ?? null, currentInstant().rfc3339],
    );
    return usageId;
  }

  recordActivation(skillId: string, sessionId?: string | null): string {
    return this.insert({
      skillId,
      taskSessionId: sessionId ?? '',
      runId: null,
      kind: 'activation',
      loads: 0,
      latencyMs: null,
      tokens: null,
    });
  }

  markRunOutcome(runId: string, outcome: SkillOutcome): number {
    const result = this._db.run(
      `UPDATE skill_usage SET outcome = ?2 WHERE run_id = ?1 AND outcome = 'unknown'`,
      [runId, outcome],
    );
    return result.changes;
  }

  runHasUsage(runId: string): boolean {
    const count = Number(this._db.pluck<number | bigint>(
      'SELECT COUNT(*) FROM skill_usage WHERE run_id = ?1', [runId],
    ) ?? 0);
    return count > 0;
  }

  skillIdsForRun(runId: string): string[] {
    return this._db.all<{ skill_id: string }>(
      'SELECT DISTINCT skill_id FROM skill_usage WHERE run_id = ?1 ORDER BY skill_id', [runId],
    ).map(row => row.skill_id);
  }

  listByRun(runId: string): SkillUsageRow[] {
    return this.listBy('run_id = ?1', [runId]);
  }

  listBySkill(skillId: string, limit: number): SkillUsageRow[] {
    return this._db.all<Record<string, unknown>>(
      `SELECT * FROM skill_usage WHERE skill_id = ?1
       ORDER BY created_at DESC, usage_id DESC LIMIT ?2`,
      [skillId, limit],
    ).map(usageRowFromRow);
  }

  listBy(whereClause: string, params: readonly (string | number | null)[]): SkillUsageRow[] {
    return this._db.all<Record<string, unknown>>(
      `SELECT * FROM skill_usage WHERE ${whereClause} ORDER BY created_at, usage_id`, params,
    ).map(usageRowFromRow);
  }
}

// ------------------------------------------------------------------ candidates

export type CandidateSourceKind = 'trajectory' | 'user_correction';
export const CandidateSourceKind = {
  Trajectory: 'trajectory' as CandidateSourceKind,
  UserCorrection: 'user_correction' as CandidateSourceKind,
};

export function parseCandidateSourceKind(raw: string): CandidateSourceKind | undefined {
  return raw === 'trajectory' || raw === 'user_correction' ? raw : undefined;
}

export type CandidateStatus = 'new' | 'screened' | 'replaying' | 'passed' | 'failed' | 'published' | 'rolled_back';
export const CandidateStatus = {
  New: 'new' as CandidateStatus,
  Screened: 'screened' as CandidateStatus,
  Replaying: 'replaying' as CandidateStatus,
  Passed: 'passed' as CandidateStatus,
  Failed: 'failed' as CandidateStatus,
  Published: 'published' as CandidateStatus,
  RolledBack: 'rolled_back' as CandidateStatus,
  All: ['new', 'screened', 'replaying', 'passed', 'failed', 'published', 'rolled_back'] as readonly CandidateStatus[],
};

export function parseCandidateStatus(raw: string): CandidateStatus | undefined {
  return CandidateStatus.All.find(status => status === raw);
}

/** Legal state transitions (no self loops; `rolled_back` is terminal). */
export function canTransitionCandidate(from: CandidateStatus, to: CandidateStatus): boolean {
  return (from === 'new' && to === 'screened')
    || (from === 'screened' && to === 'replaying')
    || (from === 'replaying' && to === 'passed')
    || (from === 'replaying' && to === 'failed')
    || (from === 'passed' && to === 'published')
    || (from === 'published' && to === 'rolled_back');
}

export interface SkillCandidateRow {
  candidateId: string;
  sourceKind: CandidateSourceKind;
  sessionId: string;
  traceHash: string;
  draftPayloadJson: string;
  evidenceRefsJson: string;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
}

function candidateRowFromRow(row: Record<string, unknown>): SkillCandidateRow {
  const sourceKind = parseCandidateSourceKind(String(row.source_kind));
  const status = parseCandidateStatus(String(row.status));
  if (sourceKind === undefined) throw new Error(`invalid skill candidate source_kind: ${String(row.source_kind)}`);
  if (status === undefined) throw new Error(`invalid skill candidate status: ${String(row.status)}`);
  return {
    candidateId: String(row.candidate_id),
    sourceKind,
    sessionId: String(row.session_id),
    traceHash: String(row.trace_hash),
    draftPayloadJson: String(row.draft_payload_json),
    evidenceRefsJson: String(row.evidence_refs_json),
    status,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface NewSkillCandidate {
  sourceKind: CandidateSourceKind;
  sessionId: string;
  traceHash: string;
  draftPayloadJson: string;
  evidenceRefsJson: string;
}

export function trajectoryTraceHash(sessionId: string, toolSequence: readonly string[]): string {
  return sha256HexSync(`trajectory\n${sessionId}\n${toolSequence.join(',')}`);
}

export function correctionTraceHash(sessionId: string, trigger: string, correctedRef: string): string {
  return sha256HexSync(`user_correction\n${sessionId}\n${trigger}\n${correctedRef}`);
}

export class SkillCandidateRepo {
  _db: SqlExecutor;
  constructor(db: SqlExecutor) { this._db = db; }

  insertIfNew(candidate: NewSkillCandidate): boolean {
    const candidateId = `cand_${globalThis.crypto.randomUUID()}`;
    const now = currentInstant().rfc3339;
    const result = this._db.run(
      `INSERT OR IGNORE INTO skill_candidates (
          candidate_id, source_kind, session_id, trace_hash,
          draft_payload_json, evidence_refs_json,
          status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?7)`,
      [candidateId, candidate.sourceKind, candidate.sessionId, candidate.traceHash,
        candidate.draftPayloadJson, candidate.evidenceRefsJson, now],
    );
    return result.changes > 0;
  }

  get(candidateId: string): SkillCandidateRow | undefined {
    const row = this._db.get<Record<string, unknown>>(
      'SELECT * FROM skill_candidates WHERE candidate_id = ?1', [candidateId],
    );
    return row === undefined ? undefined : candidateRowFromRow(row);
  }

  getByTraceHash(traceHash: string): SkillCandidateRow | undefined {
    const row = this._db.get<Record<string, unknown>>(
      'SELECT * FROM skill_candidates WHERE trace_hash = ?1', [traceHash],
    );
    return row === undefined ? undefined : candidateRowFromRow(row);
  }

  listByStatus(status: CandidateStatus, limit: number): SkillCandidateRow[] {
    return this._db.all<Record<string, unknown>>(
      `SELECT * FROM skill_candidates WHERE status = ?1
       ORDER BY created_at, candidate_id LIMIT ?2`,
      [status, limit],
    ).map(candidateRowFromRow);
  }

  updateStatus(candidateId: string, expected: CandidateStatus, next: CandidateStatus): boolean {
    if (!canTransitionCandidate(expected, next)) return false;
    const result = this._db.run(
      `UPDATE skill_candidates SET status = ?3, updated_at = ?4
       WHERE candidate_id = ?1 AND status = ?2`,
      [candidateId, expected, next, currentInstant().rfc3339],
    );
    return result.changes > 0;
  }

  listFiltered(status: CandidateStatus | null, limit: number): SkillCandidateRow[] {
    if (status !== null) return this.listByStatus(status, limit);
    return this._db.all<Record<string, unknown>>(
      'SELECT * FROM skill_candidates ORDER BY created_at, candidate_id LIMIT ?1', [limit],
    ).map(candidateRowFromRow);
  }
}

/** `message_exists`: retry/edit-anchor probe used by `process_correction`. */
export function messageExists(db: SqlExecutor, messageId: string): boolean {
  return db.get('SELECT 1 FROM chat_v2_messages WHERE id = ?1', [messageId]) !== undefined;
}
