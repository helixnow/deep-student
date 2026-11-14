import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import {
  SkillCandidateRepo, SkillUsageRepo, correctionTraceHash, trajectoryTraceHash,
  type CandidateStatus, type NewSkillCandidate,
} from '../repository/skill-usage.ts';
import {
  DEFAULT_LIST_LIMIT, DRIFT_ANCHOR_RUN_MISSING, DRIFT_ANCHOR_USER_MESSAGE_MISSING,
  DRIFT_ANCHOR_USAGE_MISSING, DRIFT_CORRECTION_MARK_MISSING, DRIFT_FAILURE_MARK_MISSING,
  DRIFT_OUTCOME_INVALIDATED, DRIFT_PAYLOAD_UNPARSEABLE, DRIFT_SKILLS_DIVERGED,
  DRIFT_TRACE_HASH_MISMATCH, DRIFT_USAGE_ROWS_MISSING, LEARNED_CORRECTION_PREFIX,
  LEARNED_WORKFLOW_PREFIX, MAX_LIST_LIMIT, SKILL_ARCHIVE_SUBDIR, SKILL_FILE_NAME,
  deriveLearnedSkillId, listCandidateSummaries, normalizeListLimit, normalizeListStatus,
  parseStatusFilter, promoteCandidateWithBase, recomputeTraceHash, replayCandidate,
  rollbackCandidateWithBase,
} from '../src/skill-replay.ts';
import { AGENT_INSTALLED_MARKER } from '../src/skill-taps.ts';

let storage: StorageServiceImpl;
let dbDir: string;
let sharedDb: DatabaseHandle;
const tempDirs: string[] = [];

beforeAll(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), 'agent-skills-replay-'));
  storage = createStorageService({ baseDir: dbDir, dataLocalDir: dbDir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  sharedDb = storage.database('chat_v2');
}, 120_000);

beforeEach(() => {
  sharedDb.exec(`DELETE FROM skill_usage;
    DELETE FROM skill_candidates;
    DELETE FROM chat_v2_messages;
    DELETE FROM chat_v2_sessions;`);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  storage.dispose();
  rmSync(dbDir, { recursive: true, force: true });
});

function database(): DatabaseHandle { return sharedDb; }

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function insertSession(db: DatabaseHandle, sessionId: string): void {
  db.run(
    `INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
     VALUES (?1, 'general_chat', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`,
    [sessionId],
  );
}

function insertMessage(db: DatabaseHandle, sessionId: string, messageId: string, role: string): void {
  db.run(
    `INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
     VALUES (?1, ?2, ?3, 1757000000000)`,
    [messageId, sessionId, role],
  );
}

function deleteMessage(db: DatabaseHandle, messageId: string): void {
  db.run('DELETE FROM chat_v2_messages WHERE id = ?1', [messageId]);
}

function insertToolLoad(db: DatabaseHandle, skillId: string, runId: string): void {
  new SkillUsageRepo(db).insert({
    skillId,
    taskSessionId: 'sess-1',
    runId,
    kind: 'tool_load',
    loads: 1,
    latencyMs: 100,
    tokens: 42,
  });
}

function trajectoryCandidate(
  sessionId: string,
  runId: string,
  userMessageId: string,
  tools: readonly string[],
  skills: readonly string[],
): NewSkillCandidate {
  const toolSequence = [...tools];
  const draftPayload = {
    kind: 'trajectory',
    tool_sequence: toolSequence,
    tool_call_count: tools.length,
    failed_tool_call_count: 0,
    skills_loaded: [...skills],
    duration_ms: 1200,
    total_tokens: 3456,
  };
  return {
    sourceKind: 'trajectory',
    sessionId,
    traceHash: trajectoryTraceHash(sessionId, toolSequence),
    draftPayloadJson: JSON.stringify(draftPayload),
    evidenceRefsJson: JSON.stringify({ run_id: runId, user_message_id: userMessageId }),
  };
}

function editCorrectionCandidate(sessionId: string, userMessageId: string): NewSkillCandidate {
  return {
    sourceKind: 'user_correction',
    sessionId,
    traceHash: correctionTraceHash(sessionId, 'edit_and_resend', userMessageId),
    draftPayloadJson: JSON.stringify({
      kind: 'user_correction',
      trigger: 'edit_and_resend',
      corrected_user_message_id: userMessageId,
    }),
    evidenceRefsJson: JSON.stringify({
      run_id: 'msg_run_edit',
      corrected_user_message_id: userMessageId,
    }),
  };
}

function retryCorrectionCandidate(sessionId: string, runId: string): NewSkillCandidate {
  return {
    sourceKind: 'user_correction',
    sessionId,
    traceHash: correctionTraceHash(sessionId, 'retry', runId),
    draftPayloadJson: JSON.stringify({
      kind: 'user_correction',
      trigger: 'retry',
      corrected_run_id: runId,
      corrected_skill_ids: ['skill-a'],
    }),
    evidenceRefsJson: JSON.stringify({ run_id: runId, corrected_run_id: runId }),
  };
}

function outcomeFailedCandidate(
  sessionId: string,
  runId: string,
  skills: readonly string[],
): NewSkillCandidate {
  return {
    sourceKind: 'user_correction',
    sessionId,
    traceHash: correctionTraceHash(sessionId, 'outcome_failed', runId),
    draftPayloadJson: JSON.stringify({
      kind: 'user_correction',
      trigger: 'outcome_failed',
      corrected_run_id: runId,
      corrected_skill_ids: [...skills],
      verdict: 'partial',
    }),
    evidenceRefsJson: JSON.stringify({ run_id: runId, corrected_run_id: runId }),
  };
}

function insertCandidate(db: DatabaseHandle, candidate: NewSkillCandidate): string {
  const repo = new SkillCandidateRepo(db);
  expect(repo.insertIfNew(candidate)).toBe(true);
  return repo.getByTraceHash(candidate.traceHash)!.candidateId;
}

function candidateStatus(db: DatabaseHandle, candidateId: string): CandidateStatus {
  return new SkillCandidateRepo(db).get(candidateId)!.status;
}

function getCandidate(db: DatabaseHandle, candidateId: string) {
  return new SkillCandidateRepo(db).get(candidateId)!;
}

function passedTrajectoryCandidate(
  db: DatabaseHandle,
  sessionId: string,
  runId: string,
  userMessageId: string,
  tools: readonly string[],
  skills: readonly string[],
): string {
  insertSession(db, sessionId);
  insertMessage(db, sessionId, runId, 'assistant');
  insertMessage(db, sessionId, userMessageId, 'user');
  for (const skillId of skills) insertToolLoad(db, skillId, runId);
  const candidateId = insertCandidate(
    db, trajectoryCandidate(sessionId, runId, userMessageId, tools, skills),
  );
  replayCandidate(db, candidateId);
  return candidateId;
}

describe('skill_replay.rs state machine and drift', () => {
  it('g09p1_replay_trajectory_passes_when_anchors_hold', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_run_1', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_1');
    const candidateId = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    ));

    const report = replayCandidate(db, candidateId);
    expect(report.stillValid).toBe(true);
    expect(report.driftReasons).toEqual([]);
    expect(report.traceHashMatches).toBe(true);
    expect(report.traceHashRecomputed).toBe(report.traceHashStored);
    expect(report.previousStatus).toBe('new');
    expect(report.resultingStatus).toBe('passed');
    expect(report.sourceKind).toBe('trajectory');
    expect(candidateStatus(db, candidateId)).toBe('passed');

    // 一次性对账语义：passed 之后不可重放
    expect(() => replayCandidate(db, candidateId)).toThrow('not replayable');
  });

  it('g09p1_replay_from_screened_also_works', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    const candidateId = insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u1'));
    expect(new SkillCandidateRepo(db).updateStatus(candidateId, 'new', 'screened')).toBe(true);

    const report = replayCandidate(db, candidateId);
    expect(report.stillValid).toBe(true);
    expect(report.previousStatus).toBe('screened');
    expect(report.resultingStatus).toBe('passed');
  });

  it('g09p1_promote_requires_validated_status', async () => {
    const db = database();
    const base = tempDir('agent-skills-replay-base-');
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    const candidateId = insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u1'));

    expect(() => promoteCandidateWithBase(db, candidateId, base)).toThrow('must be validated');
    expect(candidateStatus(db, candidateId)).toBe('new');

    replayCandidate(db, candidateId);
    const promotion = promoteCandidateWithBase(db, candidateId, base);
    expect(promotion.status).toBe('published');
    expect(candidateStatus(db, candidateId)).toBe('published');

    // 重复晋升：同 trace_hash 幂等返回既有文件
    const again = promoteCandidateWithBase(db, candidateId, base);
    expect(again.skillFileWritten).toBe(false);
    expect(() => replayCandidate(db, candidateId)).toThrow();
  });

  it('g09p1_promote_returns_draft_payload_without_user_content', async () => {
    const db = database();
    const base = tempDir('agent-skills-replay-base-');
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_run_1', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_1');
    const candidateId = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    ));
    replayCandidate(db, candidateId);

    const promotion = promoteCandidateWithBase(db, candidateId, base);
    const draft = promotion.draftPayload as Record<string, unknown>;
    expect(draft.tool_sequence).toEqual(['vfs_search', 'note_read', 'anki_add_cards']);
    expect(draft.skills_loaded).toEqual(['skill-a']);
    expect(Object.keys(draft)).toEqual([
      'kind',
      'tool_sequence',
      'tool_call_count',
      'failed_tool_call_count',
      'skills_loaded',
      'duration_ms',
      'total_tokens',
    ]);
  });

  it('g09p1_replay_trajectory_drifts_when_anchor_messages_deleted', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_run_1', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_1');
    deleteMessage(db, 'msg_run_1');
    const runDrifted = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1', ['a', 'b', 'c'], ['skill-a'],
    ));

    const report = replayCandidate(db, runDrifted);
    expect(report.stillValid).toBe(false);
    expect(report.driftReasons).toContain(DRIFT_ANCHOR_RUN_MISSING);
    expect(report.resultingStatus).toBe('failed');
    expect(candidateStatus(db, runDrifted)).toBe('failed');

    insertMessage(db, 'sess-1', 'msg_run_2', 'assistant');
    insertToolLoad(db, 'skill-a', 'msg_run_2');
    deleteMessage(db, 'msg_u1');
    const userDrifted = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_2', 'msg_u1', ['a', 'b', 'd'], ['skill-a'],
    ));
    const second = replayCandidate(db, userDrifted);
    expect(second.stillValid).toBe(false);
    expect(second.driftReasons).toContain(DRIFT_ANCHOR_USER_MESSAGE_MISSING);
  });

  it('g09p1_replay_trajectory_drifts_on_outcome_invalidation_and_skill_divergence', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_run_1', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_1');
    new SkillUsageRepo(db).markRunOutcome('msg_run_1', 'user_corrected');
    const invalidated = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1', ['a', 'b', 'c'], ['skill-a'],
    ));
    const invalidatedReport = replayCandidate(db, invalidated);
    expect(invalidatedReport.stillValid).toBe(false);
    expect(invalidatedReport.driftReasons).toContain(DRIFT_OUTCOME_INVALIDATED);

    insertMessage(db, 'sess-1', 'msg_run_2', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u2', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_2');
    insertToolLoad(db, 'skill-b', 'msg_run_2');
    const diverged = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_2', 'msg_u2', ['a', 'b', 'd'], ['skill-a'],
    ));
    const divergedReport = replayCandidate(db, diverged);
    expect(divergedReport.stillValid).toBe(false);
    expect(divergedReport.driftReasons).toContain(DRIFT_SKILLS_DIVERGED);

    insertMessage(db, 'sess-1', 'msg_run_3', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u3', 'user');
    const missing = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_3', 'msg_u3', ['a', 'b', 'e'], ['skill-z'],
    ));
    const missingReport = replayCandidate(db, missing);
    expect(missingReport.stillValid).toBe(false);
    expect(missingReport.driftReasons).toContain(DRIFT_USAGE_ROWS_MISSING);
  });

  it('g09p1_replay_edit_correction_drifts_after_anchor_delete', async () => {
    const db = database();
    const base = tempDir('agent-skills-replay-base-');
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_u_original', 'user');

    const ok = insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u_original'));
    const okReport = replayCandidate(db, ok);
    expect(okReport.stillValid).toBe(true);
    expect(okReport.resultingStatus).toBe('passed');

    insertMessage(db, 'sess-1', 'msg_u_gone', 'user');
    const drifted = insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u_gone'));
    deleteMessage(db, 'msg_u_gone');
    const report = replayCandidate(db, drifted);
    expect(report.stillValid).toBe(false);
    expect(report.driftReasons).toEqual([DRIFT_ANCHOR_USER_MESSAGE_MISSING]);
    expect(candidateStatus(db, drifted)).toBe('failed');
    expect(() => replayCandidate(db, drifted)).toThrow();
    expect(() => promoteCandidateWithBase(db, drifted, base)).toThrow();
  });

  it('g09p1_replay_retry_correction_checks_usage_anchors', async () => {
    const db = database();
    insertSession(db, 'sess-1');

    insertToolLoad(db, 'skill-a', 'msg_run_ok');
    new SkillUsageRepo(db).markRunOutcome('msg_run_ok', 'user_corrected');
    const ok = insertCandidate(db, retryCorrectionCandidate('sess-1', 'msg_run_ok'));
    const okReport = replayCandidate(db, ok);
    expect(okReport.stillValid).toBe(true);

    insertToolLoad(db, 'skill-a', 'msg_run_unmarked');
    const unmarked = insertCandidate(db, retryCorrectionCandidate('sess-1', 'msg_run_unmarked'));
    const unmarkedReport = replayCandidate(db, unmarked);
    expect(unmarkedReport.stillValid).toBe(false);
    expect(unmarkedReport.driftReasons).toEqual([DRIFT_CORRECTION_MARK_MISSING]);

    const missing = insertCandidate(db, retryCorrectionCandidate('sess-1', 'msg_run_vanished'));
    const missingReport = replayCandidate(db, missing);
    expect(missingReport.stillValid).toBe(false);
    expect(missingReport.driftReasons).toEqual([DRIFT_ANCHOR_USAGE_MISSING]);
  });

  it('g09p1_replay_unparseable_payload_fails_closed', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const candidate: NewSkillCandidate = {
      sourceKind: 'trajectory',
      sessionId: 'sess-1',
      traceHash: 'whatever',
      draftPayloadJson: '{not json',
      evidenceRefsJson: '{}',
    };
    const candidateId = insertCandidate(db, candidate);
    const report = replayCandidate(db, candidateId);
    expect(report.stillValid).toBe(false);
    expect(report.driftReasons).toEqual([DRIFT_PAYLOAD_UNPARSEABLE]);
    expect(report.traceHashRecomputed).toBeNull();
    expect(report.traceHashMatches).toBe(false);
    expect(candidateStatus(db, candidateId)).toBe('failed');
  });

  it('g09p1_trace_hash_recheck_is_deterministic', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const candidate = trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    const candidateId = insertCandidate(db, candidate);
    const row = getCandidate(db, candidateId);

    const first = recomputeTraceHash(row);
    const second = recomputeTraceHash(row);
    expect(first).toBe(second);
    expect(first).toBe(row.traceHash);
    expect(first).toBe(trajectoryTraceHash(
      'sess-1', ['vfs_search', 'note_read', 'anki_add_cards'],
    ));

    const correction = editCorrectionCandidate('sess-1', 'msg_u1');
    const correctionId = insertCandidate(db, correction);
    const correctionRow = getCandidate(db, correctionId);
    expect(recomputeTraceHash(correctionRow)).toBe(recomputeTraceHash(correctionRow));
    expect(recomputeTraceHash(correctionRow)).toBe(correctionRow.traceHash);
  });

  it('g09p1_replay_detects_trace_hash_tampering', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_run_1', 'assistant');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    insertToolLoad(db, 'skill-a', 'msg_run_1');
    const candidateId = insertCandidate(db, trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1', ['a', 'b', 'c'], ['skill-a'],
    ));
    db.run("UPDATE skill_candidates SET trace_hash = 'tampered' WHERE candidate_id = ?1", [candidateId]);

    const report = replayCandidate(db, candidateId);
    expect(report.stillValid).toBe(false);
    expect(report.traceHashMatches).toBe(false);
    expect(report.traceHashStored).toBe('tampered');
    expect(report.traceHashRecomputed).not.toBeNull();
    expect(report.driftReasons).toContain(DRIFT_TRACE_HASH_MISMATCH);
    expect(candidateStatus(db, candidateId)).toBe('failed');
  });
});

describe('skill_replay.rs list summaries', () => {
  it('g09p1_list_summaries_never_leak_draft_payload', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const marker = 'PAYLOAD_MARKER_XYZ_NEVER_LEAK';
    const candidate = trajectoryCandidate(
      'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    candidate.draftPayloadJson = JSON.stringify({
      kind: 'trajectory',
      tool_sequence: ['vfs_search', 'note_read', 'anki_add_cards'],
      tool_call_count: 5,
      failed_tool_call_count: 1,
      skills_loaded: ['skill-a'],
      duration_ms: 1200,
      total_tokens: 3456,
      marker,
    });
    insertCandidate(db, candidate);
    insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u9'));

    const all = listCandidateSummaries(db, undefined, 50);
    expect(all).toHaveLength(2);
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('draftPayloadJson');
    expect(serialized).not.toContain('evidenceRefsJson');

    const trajectory = all.find(summary => summary.sourceKind === 'trajectory')!;
    expect(trajectory.skillIds).toEqual(['skill-a']);
    expect(trajectory.signals.distinctTools).toBe(3);
    expect(trajectory.signals.toolCalls).toBe(5);
    expect(trajectory.signals.failedToolCalls).toBe(1);
    expect(trajectory.signals.skillsLoaded).toBe(1);
    expect(trajectory.status).toBe('new');
    expect(trajectory.sessionId).toBe('sess-1');
    expect(trajectory.traceHash).not.toBe('');

    const correction = all.find(summary => summary.sourceKind === 'user_correction')!;
    expect(correction.skillIds).toEqual([]);
    expect(correction.signals.distinctTools).toBe(0);

    expect(listCandidateSummaries(db, 'new', 50)).toHaveLength(2);
    expect(listCandidateSummaries(db, 'passed', 50)).toHaveLength(0);
    expect(parseStatusFilter('pending')).toBe('new');
    expect(parseStatusFilter('validated')).toBe('passed');
    expect(parseStatusFilter('drifted')).toBe('failed');
    expect(parseStatusFilter('promoted')).toBe('published');
    expect(parseStatusFilter('rolled_back')).toBe('rolled_back');
    expect(parseStatusFilter('bogus')).toBeUndefined();

    expect(listCandidateSummaries(db, undefined, 1)).toHaveLength(1);
    expect(normalizeListStatus('  ')).toBeUndefined();
    expect(() => normalizeListStatus('bogus')).toThrow('unknown skill candidate status filter: bogus');
    expect(normalizeListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(normalizeListLimit(10_000)).toBe(MAX_LIST_LIMIT);
    expect(normalizeListLimit(-1)).toBe(0);
  });
});

describe('skill_replay.rs promotion', () => {
  it('g09p2_promote_writes_skill_file_with_lineage_frontmatter', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    const row = getCandidate(db, candidateId);

    const promotion = promoteCandidateWithBase(db, candidateId, skillsDir);
    expect(promotion.status).toBe('published');
    expect(promotion.skillFileWritten).toBe(true);
    expect(promotion.skillVersion).toBe(1);
    expect(promotion.skillId.startsWith(LEARNED_WORKFLOW_PREFIX)).toBe(true);

    const skillFile = promotion.skillFilePath;
    expect(existsSync(skillFile)).toBe(true);
    expect(path.basename(path.dirname(skillFile))).toBe(promotion.skillId);
    const content = readFileSync(skillFile, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain(`\nname: ${promotion.skillId}\n`);
    expect(content).toContain('\ndescription: "');
    expect(content).toContain('\nversion: 1\n');
    expect(content).toContain('\nsource: g09_candidate\n');
    expect(content).toContain('\nsource_kind: trajectory\n');
    expect(content).toContain(`\nsource_candidate_id: ${candidateId}\n`);
    expect(content).toContain(`\ntrace_hash: ${row.traceHash}\n`);
    expect(content).toContain('vfs_search → note_read → anki_add_cards');
    expect(content).toContain('`skill-a`');
    expect(content).toContain('成功 3 次');
    expect(content).not.toContain('sess-1');

    const markerPath = path.join(path.dirname(skillFile), AGENT_INSTALLED_MARKER);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    expect(marker.sourceKind).toBe('g09_candidate');
    expect(marker.proposalId).toBe(candidateId);
    expect(marker.packageVersion).toBe(1);
    expect(candidateStatus(db, candidateId)).toBe('published');
  });

  it('g09p2_promote_idempotent_returns_existing_file', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );

    const first = promoteCandidateWithBase(db, candidateId, skillsDir);
    const bytesFirst = readFileSync(first.skillFilePath);
    const second = promoteCandidateWithBase(db, candidateId, skillsDir);
    expect(second.skillFileWritten).toBe(false);
    expect(second.skillVersion).toBe(1);
    expect(second.skillFilePath).toBe(first.skillFilePath);
    expect(second.status).toBe('published');
    expect(readFileSync(second.skillFilePath)).toEqual(bytesFirst);
  });

  it('g09p2_promote_new_version_increments_for_same_workflow', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const firstId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1', ['a', 'b', 'c'], ['skill-a'],
    );
    const secondId = passedTrajectoryCandidate(
      db, 'sess-2', 'msg_run_2', 'msg_u2', ['a', 'b', 'c'], ['skill-a'],
    );
    const first = promoteCandidateWithBase(db, firstId, skillsDir);
    expect(first.skillVersion).toBe(1);

    const second = promoteCandidateWithBase(db, secondId, skillsDir);
    expect(second.skillId).toBe(first.skillId);
    expect(second.skillVersion).toBe(2);
    expect(second.skillFileWritten).toBe(true);

    const row2 = getCandidate(db, secondId);
    const content = readFileSync(second.skillFilePath, 'utf8');
    expect(content).toContain('\nversion: 2\n');
    expect(content).toContain(`\nsource_candidate_id: ${secondId}\n`);
    expect(content).toContain(`\ntrace_hash: ${row2.traceHash}\n`);
    expect(candidateStatus(db, firstId)).toBe('published');
    expect(candidateStatus(db, secondId)).toBe('published');
  });

  it('g09p2_promote_failure_leaves_no_partial_file_and_status_passed', async () => {
    const db = database();
    const workDir = tempDir('agent-skills-replay-work-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );

    const blockedBase = path.join(workDir, 'blocked-base');
    writeFileSync(blockedBase, 'not a directory');
    expect(() => promoteCandidateWithBase(db, candidateId, blockedBase))
      .toThrow('Failed to create skills base');
    expect(candidateStatus(db, candidateId)).toBe('passed');
    expect(readdirSync(workDir)).toEqual(['blocked-base']);

    const goodBase = path.join(workDir, 'skills');
    const promotion = promoteCandidateWithBase(db, candidateId, goodBase);
    expect(promotion.skillFileWritten).toBe(true);
    expect(candidateStatus(db, candidateId)).toBe('published');
  });

  it('g09p2_promote_refuses_foreign_skill_collision', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    const row = getCandidate(db, candidateId);
    const skillId = deriveLearnedSkillId(row);

    const foreignDir = path.join(skillsDir, skillId);
    mkdirSync(foreignDir, { recursive: true });
    const foreignContent = '---\nname: custom\n---\n用户自建技能。';
    writeFileSync(path.join(foreignDir, SKILL_FILE_NAME), foreignContent);

    expect(() => promoteCandidateWithBase(db, candidateId, skillsDir)).toThrow('collision');
    expect(candidateStatus(db, candidateId)).toBe('passed');
    expect(readFileSync(path.join(foreignDir, SKILL_FILE_NAME), 'utf8')).toBe(foreignContent);
  });

  it('g09p2_promote_correction_candidate_renders_counter_example_doc', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    insertSession(db, 'sess-1');
    insertToolLoad(db, 'skill-a', 'msg_run_ok');
    new SkillUsageRepo(db).markRunOutcome('msg_run_ok', 'user_corrected');
    const candidateId = insertCandidate(db, retryCorrectionCandidate('sess-1', 'msg_run_ok'));
    replayCandidate(db, candidateId);

    const promotion = promoteCandidateWithBase(db, candidateId, skillsDir);
    expect(promotion.skillId.startsWith(LEARNED_CORRECTION_PREFIX)).toBe(true);
    const content = readFileSync(promotion.skillFilePath, 'utf8');
    expect(content).toContain('\nsource_kind: user_correction\n');
    expect(content).toContain('习得反例');
    expect(content).toContain('`retry`');
    expect(content).toContain('`skill-a`');
  });
});

describe('skill_replay.rs rollback', () => {
  it('g09p2_rollback_retires_skill_file_into_archive', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    const promotion = promoteCandidateWithBase(db, candidateId, skillsDir);
    const skillDir = path.dirname(promotion.skillFilePath);
    expect(existsSync(skillDir)).toBe(true);

    const rollback = rollbackCandidateWithBase(db, candidateId, skillsDir);
    expect(rollback.status).toBe('rolled_back');
    expect(rollback.skillId).toBe(promotion.skillId);
    expect(rollback.retiredFrom).not.toBeNull();

    const archived = rollback.archivedTo!;
    expect(existsSync(archived)).toBe(true);
    expect(existsSync(path.join(archived, SKILL_FILE_NAME))).toBe(true);
    expect(existsSync(path.join(archived, AGENT_INSTALLED_MARKER))).toBe(true);
    expect(path.basename(path.dirname(archived))).toBe(SKILL_ARCHIVE_SUBDIR);
    expect(existsSync(skillDir)).toBe(false);
    expect(candidateStatus(db, candidateId)).toBe('rolled_back');

    expect(() => rollbackCandidateWithBase(db, candidateId, skillsDir))
      .toThrow("must be 'published'");
    expect(() => promoteCandidateWithBase(db, candidateId, skillsDir)).toThrow();
  });

  it('g09p2_rollback_requires_published_status', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    insertSession(db, 'sess-1');
    insertMessage(db, 'sess-1', 'msg_u1', 'user');
    const candidateId = insertCandidate(db, editCorrectionCandidate('sess-1', 'msg_u1'));

    expect(() => rollbackCandidateWithBase(db, candidateId, skillsDir))
      .toThrow("must be 'published'");
    expect(candidateStatus(db, candidateId)).toBe('new');

    replayCandidate(db, candidateId);
    expect(() => rollbackCandidateWithBase(db, candidateId, skillsDir)).toThrow();
    expect(candidateStatus(db, candidateId)).toBe('passed');
    expect(existsSync(path.join(skillsDir, SKILL_ARCHIVE_SUBDIR))).toBe(false);
  });

  it('g09p2_rollback_tolerates_missing_skill_dir', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    const candidateId = passedTrajectoryCandidate(
      db, 'sess-1', 'msg_run_1', 'msg_u1',
      ['vfs_search', 'note_read', 'anki_add_cards'], ['skill-a'],
    );
    const promotion = promoteCandidateWithBase(db, candidateId, skillsDir);
    const skillDir = path.dirname(promotion.skillFilePath);
    rmSync(skillDir, { recursive: true, force: true });

    const rollback = rollbackCandidateWithBase(db, candidateId, skillsDir);
    expect(rollback.status).toBe('rolled_back');
    expect(rollback.retiredFrom).toBeNull();
    expect(rollback.archivedTo).toBeNull();
    expect(candidateStatus(db, candidateId)).toBe('rolled_back');
  });
});

describe('skill_replay.rs outcome_failed anchor', () => {
  it('g09p2_replay_outcome_failed_candidate_checks_failure_anchor', async () => {
    const db = database();
    const skillsDir = tempDir('agent-skills-replay-skills-');
    insertSession(db, 'sess-1');

    insertToolLoad(db, 'skill-a', 'msg_run_bad');
    new SkillUsageRepo(db).markRunOutcome('msg_run_bad', 'failed');
    const ok = insertCandidate(db, outcomeFailedCandidate('sess-1', 'msg_run_bad', ['skill-a']));
    const report = replayCandidate(db, ok);
    expect(report.stillValid).toBe(true);
    expect(report.resultingStatus).toBe('passed');

    const promotion = promoteCandidateWithBase(db, ok, skillsDir);
    const content = readFileSync(promotion.skillFilePath, 'utf8');
    expect(content).toContain('\nsource_kind: user_correction\n');
    expect(content).toContain('`outcome_failed`');
    expect(content).toContain('验收终态：`partial`');

    insertToolLoad(db, 'skill-a', 'msg_run_unmarked');
    const unmarked = insertCandidate(
      db, outcomeFailedCandidate('sess-1', 'msg_run_unmarked', ['skill-a']),
    );
    const unmarkedReport = replayCandidate(db, unmarked);
    expect(unmarkedReport.stillValid).toBe(false);
    expect(unmarkedReport.driftReasons).toEqual([DRIFT_FAILURE_MARK_MISSING]);

    const missing = insertCandidate(
      db, outcomeFailedCandidate('sess-1', 'msg_run_vanished', ['skill-a']),
    );
    const missingReport = replayCandidate(db, missing);
    expect(missingReport.stillValid).toBe(false);
    expect(missingReport.driftReasons).toEqual([DRIFT_ANCHOR_USAGE_MISSING]);
  });
});
