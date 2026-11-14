import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import {
  CandidateSourceKind, CandidateStatus, correctionTraceHash, detectCorrectionHint,
  onTaskFinalizedInner, outcomeFromFinalizationVerdict, processTurn, recordSkillActivation,
  SkillCandidateRepo, type SkillCandidateRow, type SkillPipelineContext, SkillUsageKind,
  SkillUsageRepo, type SkillToolResultInfo, type ToolCallTrace, toolTrace,
  trajectoryTraceHash, turnUsageSummaryFromCtx, type TurnUsageSummary,
} from '../src/skill-usage.ts';

let storage: StorageServiceImpl;
let dir: string;
let sharedDb: DatabaseHandle;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-skills-usage-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  sharedDb = storage.database('chat_v2');
}, 120_000);

beforeEach(() => {
  // 表级隔离等价 Rust 每个测试的 TempDir：只清空被测表与会话/消息锚点。
  sharedDb.exec(`DELETE FROM skill_usage;
    DELETE FROM skill_candidates;
    DELETE FROM chat_v2_messages;
    DELETE FROM chat_v2_sessions;`);
});

afterAll(() => {
  storage.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function database(): DatabaseHandle {
  return sharedDb;
}

function insertSession(db: DatabaseHandle, sessionId: string): void {
  db.run(
    `INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
     VALUES (?1, 'general_chat', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`,
    [sessionId],
  );
}

function insertUserMessage(db: DatabaseHandle, sessionId: string, messageId: string): void {
  db.run(
    `INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
     VALUES (?1, ?2, 'user', 1757000000000)`,
    [messageId, sessionId],
  );
}

function toolResult(name: string, success: boolean): SkillToolResultInfo {
  return { toolName: name, success, input: {}, output: {} };
}

function loadSkillsResult(skills: readonly string[], rejected: readonly string[]): SkillToolResultInfo {
  const rejectedMap: Record<string, string> = {};
  for (const id of rejected) rejectedMap[id] = 'untrusted';
  return {
    toolName: 'load_skills',
    success: true,
    input: { skills: [...skills] },
    output: {
      result: {
        status: 'success',
        loaded_skill_ids: [...skills],
        rejected_skills: rejectedMap,
      },
      durationMs: 5,
    },
  };
}

function summaryFor(
  sessionId: string,
  runId: string,
  userMessageId: string,
  correctionHint: boolean,
  tools: readonly ToolCallTrace[],
): TurnUsageSummary {
  return {
    sessionId,
    runId,
    userMessageId,
    latencyMs: 1200,
    totalTokens: 3456,
    correctionHint,
    tools: [...tools],
  };
}

function traces(results: readonly SkillToolResultInfo[]): ToolCallTrace[] {
  return results.map(toolTrace);
}

function listAllCandidates(db: DatabaseHandle): SkillCandidateRow[] {
  return new SkillCandidateRepo(db).listFiltered(null, 1000);
}

function completionToolResult(verdict: string): SkillToolResultInfo {
  return {
    toolName: 'attempt_completion',
    success: true,
    input: {},
    output: { task_completed: true, finalization: { verdict } },
  };
}

describe('skill_usage.rs migration and usage repo', () => {
  it('g09_migration_creates_skill_tables', async () => {
    const db = database();
    for (const table of ['skill_usage', 'skill_candidates']) {
      const found = db.pluck<string | null>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1", [table],
      );
      expect(found).toBe(table);
    }
    for (const index of [
      'idx_skill_usage_skill_created',
      'idx_skill_usage_session_created',
      'idx_skill_usage_run',
      'idx_skill_usage_outcome',
      'idx_skill_candidates_trace_hash',
      'idx_skill_candidates_status_created',
      'idx_skill_candidates_session_created',
    ]) {
      const found = db.pluck<string | null>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1", [index],
      );
      expect(found).toBe(index);
    }
  });

  it('g09_usage_insert_and_read_roundtrip', async () => {
    const db = database();
    const repo = new SkillUsageRepo(db);
    const runId = 'msg_run_1';
    repo.insert({
      skillId: 'skill-a',
      taskSessionId: 'sess-1',
      runId,
      kind: SkillUsageKind.ToolLoad,
      loads: 2,
      latencyMs: 800,
      tokens: 1234,
    });
    repo.recordActivation('skill-b', 'sess-1');
    repo.recordActivation('skill-c', null);

    const runRows = repo.listByRun(runId);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.skillId).toBe('skill-a');
    expect(runRows[0]!.kind).toBe(SkillUsageKind.ToolLoad);
    expect(runRows[0]!.loads).toBe(2);
    expect(runRows[0]!.outcome).toBe('unknown');
    expect(runRows[0]!.latencyMs).toBe(800);
    expect(runRows[0]!.tokens).toBe(1234);

    const skillB = repo.listBySkill('skill-b', 10);
    expect(skillB).toHaveLength(1);
    expect(skillB[0]!.kind).toBe(SkillUsageKind.Activation);
    expect(skillB[0]!.runId).toBeNull();
    expect(skillB[0]!.taskSessionId).toBe('sess-1');

    // 无会话上下文的激活落空串
    const skillC = repo.listBySkill('skill-c', 10);
    expect(skillC[0]!.taskSessionId).toBe('');
  });

  it('g09_mark_run_outcome_is_guarded', async () => {
    const db = database();
    const repo = new SkillUsageRepo(db);
    repo.insert({
      skillId: 'skill-a',
      taskSessionId: 'sess-1',
      runId: 'msg_run_1',
      kind: SkillUsageKind.ToolLoad,
      loads: 1,
      latencyMs: null,
      tokens: null,
    });

    expect(repo.markRunOutcome('msg_run_1', 'user_corrected')).toBe(1);
    // 已收敛的行不会被重复覆盖
    expect(repo.markRunOutcome('msg_run_1', 'success')).toBe(0);
    expect(repo.listByRun('msg_run_1')[0]!.outcome).toBe('user_corrected');
    expect(repo.runHasUsage('msg_run_1')).toBe(true);
    expect(repo.runHasUsage('msg_run_other')).toBe(false);
    expect(repo.skillIdsForRun('msg_run_1')).toEqual(['skill-a']);
  });

  it('chat_v2_record_skill_activation trims and validates byte length', async () => {
    const db = database();
    recordSkillActivation(db, '  skill-a  ', 'sess-1');
    const rows = new SkillUsageRepo(db).listBySkill('skill-a', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('activation');
    expect(rows[0]!.runId).toBeNull();

    expect(() => recordSkillActivation(db, '   ', null)).toThrow('invalid skill_id length: 0');
    // Rust `String::len` 是 UTF-8 字节数，不是字符数。
    expect(() => recordSkillActivation(db, '技'.repeat(86), null))
      .toThrow('invalid skill_id length: 258');
    expect(new SkillUsageRepo(db).listBySkill('技'.repeat(86), 10)).toHaveLength(0);
  });
});

describe('skill_usage.rs candidate repo', () => {
  function trajectoryCandidate(sessionId: string, tools: readonly string[]) {
    return {
      sourceKind: CandidateSourceKind.Trajectory,
      sessionId,
      traceHash: trajectoryTraceHash(sessionId, [...tools]),
      draftPayloadJson: '{"kind":"trajectory"}',
      evidenceRefsJson: '{"run_id":"msg_r"}',
    };
  }

  it('g09_candidate_insert_dedupes_by_trace_hash', async () => {
    const db = database();
    const repo = new SkillCandidateRepo(db);

    const candidate = trajectoryCandidate('sess-1', ['a', 'b', 'c']);
    expect(repo.insertIfNew(candidate)).toBe(true);
    // 相同 session + 相同工具序列 → 相同 trace_hash → 去重
    expect(repo.insertIfNew(candidate)).toBe(false);
    // 不同 session 的相同序列不去重
    expect(repo.insertIfNew(trajectoryCandidate('sess-2', ['a', 'b', 'c']))).toBe(true);
    // 同 session 不同序列不去重
    expect(repo.insertIfNew(trajectoryCandidate('sess-1', ['a', 'b', 'd']))).toBe(true);

    const stored = repo.getByTraceHash(candidate.traceHash);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe(CandidateStatus.New);
    expect(stored!.sourceKind).toBe(CandidateSourceKind.Trajectory);
    expect(repo.get(stored!.candidateId)).toEqual(stored);
  });

  it('g09_candidate_status_transitions_are_guarded', async () => {
    const db = database();
    const repo = new SkillCandidateRepo(db);
    const candidate = trajectoryCandidate('sess-1', ['a', 'b', 'c']);
    repo.insertIfNew(candidate);
    const stored = repo.getByTraceHash(candidate.traceHash)!;

    expect(repo.updateStatus(stored.candidateId, 'new', 'screened')).toBe(true);
    expect(repo.updateStatus(stored.candidateId, 'screened', 'replaying')).toBe(true);
    // 非法迁移被拒绝（new 不能直达 passed；状态不是期望前驱也被拒）
    expect(repo.updateStatus(stored.candidateId, 'new', 'passed')).toBe(false);
    expect(repo.updateStatus(stored.candidateId, 'replaying', 'published')).toBe(false);
    expect(repo.updateStatus(stored.candidateId, 'replaying', 'passed')).toBe(true);
    expect(repo.updateStatus(stored.candidateId, 'passed', 'published')).toBe(true);
    expect(repo.updateStatus(stored.candidateId, 'published', 'rolled_back')).toBe(true);
    // 终态不允许外向转换
    expect(repo.updateStatus(stored.candidateId, 'rolled_back', 'new')).toBe(false);

    expect(repo.listByStatus('rolled_back', 10)).toHaveLength(1);
    expect(repo.listByStatus('new', 10)).toHaveLength(0);
  });
});

describe('skill_usage.rs turn-end detection', () => {
  it('g09_turn_with_3_distinct_tools_writes_trajectory_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const results = [
      loadSkillsResult(['skill-a'], []),
      toolResult('vfs_search', true),
      toolResult('note_read', true),
      toolResult('anki_add_cards', true),
      toolResult('note_read', true),    // 重复工具只计一次
      toolResult('broken_tool', false), // 失败工具不进序列
    ];
    const summary = summaryFor('sess-1', 'msg_run_1', 'msg_u1', false, traces(results));
    processTurn(db, summary);

    const usageRepo = new SkillUsageRepo(db);
    const rows = usageRepo.listByRun('msg_run_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skillId).toBe('skill-a');
    expect(rows[0]!.kind).toBe(SkillUsageKind.ToolLoad);
    expect(rows[0]!.outcome).toBe('unknown');
    expect(rows[0]!.latencyMs).toBe(1200);
    expect(rows[0]!.tokens).toBe(3456);

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.sourceKind).toBe(CandidateSourceKind.Trajectory);
    expect(candidate.status).toBe(CandidateStatus.New);
    const payload = JSON.parse(candidate.draftPayloadJson) as Record<string, unknown>;
    expect(payload.tool_sequence).toEqual(['vfs_search', 'note_read', 'anki_add_cards']);
    expect(payload.skills_loaded).toEqual(['skill-a']);
    expect(payload.tool_call_count).toBe(5);
    expect(payload.failed_tool_call_count).toBe(1);
    expect(JSON.parse(candidate.evidenceRefsJson).run_id).toBe('msg_run_1');

    // 同序列再来一轮 → trace_hash 去重，不重复写候选
    processTurn(db, summary);
    expect(listAllCandidates(db)).toHaveLength(1);
  });

  it('g09_turn_below_tool_threshold_writes_no_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');

    // 只有 2 个不同成功工具 → 不写 trajectory 候选
    const results = [toolResult('vfs_search', true), toolResult('note_read', true)];
    processTurn(db, summaryFor('sess-1', 'msg_run_1', 'msg_u1', false, traces(results)));
    expect(listAllCandidates(db)).toHaveLength(0);

    // 无工具回合 → 既不写候选也不写 usage
    processTurn(db, summaryFor('sess-1', 'msg_run_2', 'msg_u2', false, []));
    expect(listAllCandidates(db)).toHaveLength(0);
    expect(new SkillUsageRepo(db).listByRun('msg_run_2')).toHaveLength(0);
  });

  it('g09_retry_marks_prior_run_and_writes_correction_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const usageRepo = new SkillUsageRepo(db);

    // 被推翻的 run：使用了 skill-a（run_id 与重试轮相同——retry 复用被删助手消息 id）
    processTurn(db, summaryFor(
      'sess-1', 'msg_run_retry', 'msg_u1', false,
      traces([loadSkillsResult(['skill-a'], [])]),
    ));
    expect(usageRepo.listByRun('msg_run_retry')[0]!.outcome).toBe('unknown');

    // 重试轮：correction_hint=true，user_message_id 是新生成的（库中不存在）
    const retry = summaryFor(
      'sess-1', 'msg_run_retry', 'msg_u_new', true,
      traces([loadSkillsResult(['skill-a', 'skill-b'], [])]),
    );
    processTurn(db, retry);

    // 被推翻 run 的旧行收敛为 user_corrected；本轮新行保持 unknown
    const rows = usageRepo.listByRun('msg_run_retry');
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.outcome === 'user_corrected')).toHaveLength(1);
    expect(rows.filter(row => row.outcome === 'unknown')).toHaveLength(2);

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.sourceKind).toBe(CandidateSourceKind.UserCorrection);
    const payload = JSON.parse(candidate.draftPayloadJson) as Record<string, unknown>;
    expect(payload.trigger).toBe('retry');
    expect(payload.corrected_run_id).toBe('msg_run_retry');
    expect(payload.corrected_skill_ids).toEqual(['skill-a']);

    // 再次重试同一 run → 候选按 trace_hash 去重
    processTurn(db, retry);
    expect(listAllCandidates(db)).toHaveLength(1);
  });

  it('g09_edit_and_resend_writes_correction_candidate_via_user_message_anchor', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    // edit_and_resend 复用原用户消息 id → 消息行在库中存在
    insertUserMessage(db, 'sess-1', 'msg_u_original');

    processTurn(db, summaryFor(
      'sess-1', 'msg_run_edit', 'msg_u_original', true,
      traces([toolResult('vfs_search', true)]),
    ));

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    const payload = JSON.parse(candidates[0]!.draftPayloadJson) as Record<string, unknown>;
    expect(payload.trigger).toBe('edit_and_resend');
    expect(payload.corrected_user_message_id).toBe('msg_u_original');
    // edit 路径锚点是用户消息，不回标任何 usage 行
  });

  it('g09_wake_turn_without_anchor_writes_no_correction_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    // wake：correction 粗筛命中，但 user_message_id 是新生成的（库中不存在），
    // 且本轮 run 无既有 usage 行 → 无精确锚点，不落候选；
    // 工具数达标时仍按普通成功轮写 trajectory（wake 是合法完成的运行）。
    processTurn(db, summaryFor(
      'sess-1', 'msg_run_wake', 'msg_u_fresh', true,
      traces([toolResult('a', true), toolResult('b', true), toolResult('c', true)]),
    ));

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceKind).toBe(CandidateSourceKind.Trajectory);
  });

  it('g09_correction_turn_writes_no_trajectory_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    insertUserMessage(db, 'sess-1', 'msg_u_original');
    // 纠错轮本身即使有 ≥3 个成功工具，也不写 trajectory 正例
    processTurn(db, summaryFor(
      'sess-1', 'msg_run_edit', 'msg_u_original', true,
      traces([toolResult('a', true), toolResult('b', true), toolResult('c', true)]),
    ));

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceKind).toBe(CandidateSourceKind.UserCorrection);
  });
});

describe('skill_usage.rs privacy boundary', () => {
  it('g09_candidate_payload_contains_no_user_content', async () => {
    const db = database();
    insertSession(db, 'sess-1');

    const userSecret = '用户的私密问题内容XYZ';
    const assistantSecret = '助手回复的私密内容ABC';
    const toolInputSecret = '工具参数里的私密路径/private/secret';
    const withSecretInput: SkillToolResultInfo = {
      ...toolResult('vfs_search', true),
      input: { query: toolInputSecret },
    };
    const results = [
      withSecretInput,
      toolResult('note_read', true),
      toolResult('anki_add_cards', true),
    ];
    // summary 只携带最小 trace；用户/助手内容根本不进入摘要结构。
    processTurn(db, summaryFor('sess-1', 'msg_run_1', 'msg_u1', false, traces(results)));

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    for (const forbidden of [userSecret, assistantSecret, toolInputSecret]) {
      expect(candidate.draftPayloadJson).not.toContain(forbidden);
      expect(candidate.evidenceRefsJson).not.toContain(forbidden);
    }
    // payload 只允许统计字段键
    const payload = JSON.parse(candidate.draftPayloadJson) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      'kind',
      'tool_sequence',
      'tool_call_count',
      'failed_tool_call_count',
      'skills_loaded',
      'duration_ms',
      'total_tokens',
    ]);
  });

  it('g09_turn_summary_from_ctx_carries_no_content_fields', () => {
    // 端到端隐私防线：TurnUsageSummary 结构上就不含用户/助手内容字段。
    const ctx: SkillPipelineContext = {
      sessionId: 'sess-1',
      assistantMessageId: 'msg_run_ctx',
      userMessageId: 'msg_u_ctx',
      startTime: Date.now(),
      tokenUsage: { totalTokens: 999 },
      options: { skipUserMessageSave: true },
      toolResults: [loadSkillsResult(['skill-a'], ['skill-b'])],
    };

    const summary = turnUsageSummaryFromCtx(ctx);
    expect(summary.correctionHint).toBe(true);
    expect(summary.totalTokens).toBe(999);
    expect(summary.tools).toHaveLength(1);
    expect(summary.tools[0]!.loadedSkillIds).toEqual(['skill-a']);
    expect(JSON.stringify(summary.tools)).not.toContain('绝密用户消息内容');
  });

  it('g09_correction_hint_excludes_headless_and_goal_continuation', () => {
    // headless/worker：executionAllowedTools 只由后端构造
    expect(detectCorrectionHint({
      skipUserMessageSave: true,
      executionAllowedTools: ['tool'],
    })).toBe(false);

    // goal 续跑：schemaToolIds 注入 goal 三件套
    expect(detectCorrectionHint({
      skipUserMessageSave: true,
      schemaToolIds: ['goal_update'],
    })).toBe(false);

    // retry / edit_and_resend / wake：hint 命中（精确锚定交给 DB 探针）
    expect(detectCorrectionHint({ skipUserMessageSave: true })).toBe(true);

    // 普通发送：不命中
    expect(detectCorrectionHint({})).toBe(false);
  });
});

describe('skill_usage.rs G09-P2 outcome reflux', () => {
  it('g09p2_finalization_verdict_maps_to_three_state_outcome', () => {
    expect(outcomeFromFinalizationVerdict('verified_complete')).toBe('success');
    expect(outcomeFromFinalizationVerdict('complete_with_exceptions')).toBe('success');
    expect(outcomeFromFinalizationVerdict('partial')).toBe('failed');
    expect(outcomeFromFinalizationVerdict('blocked')).toBe('failed');
    // OutcomeUnknown 不标记；未知值 fail-closed
    expect(outcomeFromFinalizationVerdict('outcome_unknown')).toBeUndefined();
    expect(outcomeFromFinalizationVerdict('bogus')).toBeUndefined();
  });

  it('g09p2_process_turn_refluxes_verdict_into_usage_rows', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const usageRepo = new SkillUsageRepo(db);

    // verified_complete / complete_with_exceptions → success
    const ok = summaryFor(
      'sess-1', 'msg_run_ok', 'msg_u1', false,
      traces([loadSkillsResult(['skill-a'], [])]),
    );
    ok.finalizationVerdict = 'complete_with_exceptions';
    processTurn(db, ok);
    const okRows = usageRepo.listByRun('msg_run_ok');
    expect(okRows).toHaveLength(1);
    expect(okRows[0]!.outcome).toBe('success');
    // 成功终态不产生失败反例；工具数不足也不产生 trajectory
    expect(listAllCandidates(db)).toHaveLength(0);

    // partial / blocked → failed
    const bad = summaryFor(
      'sess-1', 'msg_run_bad', 'msg_u2', false,
      traces([loadSkillsResult(['skill-b'], [])]),
    );
    bad.finalizationVerdict = 'blocked';
    processTurn(db, bad);
    const badRows = usageRepo.listByRun('msg_run_bad');
    expect(badRows).toHaveLength(1);
    expect(badRows[0]!.outcome).toBe('failed');

    // outcome_unknown → 不标记
    const unknown = summaryFor(
      'sess-1', 'msg_run_unknown', 'msg_u3', false,
      traces([loadSkillsResult(['skill-c'], [])]),
    );
    unknown.finalizationVerdict = 'outcome_unknown';
    processTurn(db, unknown);
    const unknownRows = usageRepo.listByRun('msg_run_unknown');
    expect(unknownRows).toHaveLength(1);
    expect(unknownRows[0]!.outcome).toBe('unknown');

    // 无完成块 verdict（非任务轮）→ 保持 unknown（P0 行为不变）
    const plain = summaryFor(
      'sess-1', 'msg_run_plain', 'msg_u4', false,
      traces([loadSkillsResult(['skill-d'], [])]),
    );
    processTurn(db, plain);
    expect(usageRepo.listByRun('msg_run_plain')[0]!.outcome).toBe('unknown');
  });

  it('g09p2_failed_outcome_writes_counter_example_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');

    const failed = summaryFor(
      'sess-1', 'msg_run_bad', 'msg_u1', false,
      traces([loadSkillsResult(['skill-a', 'skill-b'], [])]),
    );
    failed.finalizationVerdict = 'partial';
    processTurn(db, failed);

    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.sourceKind).toBe(CandidateSourceKind.UserCorrection);
    expect(candidate.status).toBe(CandidateStatus.New);
    // trace_hash 含失败锚点（失败 run id）
    expect(candidate.traceHash).toBe(correctionTraceHash('sess-1', 'outcome_failed', 'msg_run_bad'));
    const payload = JSON.parse(candidate.draftPayloadJson) as Record<string, unknown>;
    expect(payload.kind).toBe('user_correction');
    expect(payload.trigger).toBe('outcome_failed');
    expect(payload.corrected_run_id).toBe('msg_run_bad');
    expect(payload.corrected_skill_ids).toEqual(['skill-a', 'skill-b']);
    expect(payload.verdict).toBe('partial');
    const evidence = JSON.parse(candidate.evidenceRefsJson) as Record<string, unknown>;
    expect(evidence.run_id).toBe('msg_run_bad');
    expect(evidence.corrected_run_id).toBe('msg_run_bad');

    // 同一失败 run 重复处理 → 候选按 trace_hash 去重
    processTurn(db, failed);
    expect(listAllCandidates(db)).toHaveLength(1);
  });

  it('g09p2_failed_verdict_without_loaded_skills_writes_no_candidate', async () => {
    const db = database();
    insertSession(db, 'sess-1');

    // 终态失败 + ≥3 个不同成功工具但没加载技能：
    // 既不写失败反例（无已发布技能涉及），也不写 trajectory 正例。
    const failed = summaryFor(
      'sess-1', 'msg_run_bad', 'msg_u1', false,
      traces([toolResult('a', true), toolResult('b', true), toolResult('c', true)]),
    );
    failed.finalizationVerdict = 'partial';
    processTurn(db, failed);
    expect(listAllCandidates(db)).toHaveLength(0);

    // 对照：同样的工具序列但验收通过 → trajectory 正例照常写入
    const ok = summaryFor(
      'sess-1', 'msg_run_ok', 'msg_u2', false,
      traces([toolResult('a', true), toolResult('b', true), toolResult('c', true)]),
    );
    ok.finalizationVerdict = 'verified_complete';
    processTurn(db, ok);
    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceKind).toBe(CandidateSourceKind.Trajectory);
  });

  it('g09p2_retry_correction_precedes_failed_outcome_reflux', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const usageRepo = new SkillUsageRepo(db);

    // 被推翻 run 的旧行（同 run_id，tokens=7 用于区分新行）
    usageRepo.insert({
      skillId: 'skill-a',
      taskSessionId: 'sess-1',
      runId: 'msg_run_retry',
      kind: SkillUsageKind.ToolLoad,
      loads: 7,
      latencyMs: null,
      tokens: 7,
    });

    // 重试轮：correction_hint=true，且本轮验收也失败（partial）
    const retry = summaryFor(
      'sess-1', 'msg_run_retry', 'msg_u_new', true,
      traces([loadSkillsResult(['skill-a'], [])]),
    );
    retry.finalizationVerdict = 'partial';
    processTurn(db, retry);

    // 顺序不变量：旧行先被纠错收敛为 user_corrected（绝不能被 verdict
    // 覆盖成 failed），本轮新行才被标本 failed
    const rows = usageRepo.listByRun('msg_run_retry');
    expect(rows).toHaveLength(2);
    const old = rows.find(row => row.tokens === 7)!;
    const fresh = rows.find(row => row.tokens === 3456)!;
    expect(old.outcome).toBe('user_corrected');
    expect(fresh.outcome).toBe('failed');

    // 候选：retry 反例 + outcome_failed 反例各一（锚点不同 trigger）
    const candidates = listAllCandidates(db);
    expect(candidates).toHaveLength(2);
    const triggers = candidates.map(
      candidate => (JSON.parse(candidate.draftPayloadJson) as Record<string, unknown>).trigger,
    );
    expect(triggers).toContain('retry');
    expect(triggers).toContain('outcome_failed');
  });

  it('g09p2_on_task_finalized_marks_existing_rows_only_when_safe', async () => {
    const db = database();
    insertSession(db, 'sess-1');
    const usageRepo = new SkillUsageRepo(db);
    const insertUnknown = (runId: string): void => {
      usageRepo.insert({
        skillId: 'skill-a',
        taskSessionId: 'sess-1',
        runId,
        kind: SkillUsageKind.ToolLoad,
        loads: 1,
        latencyMs: null,
        tokens: null,
      });
    };

    // 立即通路：行已存在 + 非纠错轮 → 直接收敛
    insertUnknown('msg_run_a');
    onTaskFinalizedInner(db, 'msg_run_a', [completionToolResult('verified_complete')], false);
    expect(usageRepo.listByRun('msg_run_a')[0]!.outcome).toBe('success');

    // 纠错轮（retry 复用 run_id）：跳过立即通路——旧行必须留给轮末
    // 纠错处理先收敛为 user_corrected
    insertUnknown('msg_run_b');
    onTaskFinalizedInner(db, 'msg_run_b', [completionToolResult('partial')], true);
    expect(usageRepo.listByRun('msg_run_b')[0]!.outcome).toBe('unknown');

    // outcome_unknown：不标记
    insertUnknown('msg_run_c');
    onTaskFinalizedInner(db, 'msg_run_c', [completionToolResult('outcome_unknown')], false);
    expect(usageRepo.listByRun('msg_run_c')[0]!.outcome).toBe('unknown');

    // 无完成块：no-op
    insertUnknown('msg_run_d');
    onTaskFinalizedInner(db, 'msg_run_d', [toolResult('vfs_search', true)], false);
    expect(usageRepo.listByRun('msg_run_d')[0]!.outcome).toBe('unknown');

    // 行尚不存在（常规首轮：usage 行在轮末才落账）：标记 0 行，不报错
    onTaskFinalizedInner(db, 'msg_run_e', [completionToolResult('blocked')], false);
    expect(usageRepo.listByRun('msg_run_e')).toHaveLength(0);
  });
});
