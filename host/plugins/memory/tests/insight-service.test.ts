import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import { InsightService, type InsightDraftInput } from '../src/insight-service.ts';
import type { InsightCommandService } from '../src/insight-api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import ankiPlugin from '../../anki/index.ts';
import reviewPlugin from '../../review/index.ts';
import type { MasteryService } from '../../review/api.ts';
import {
  recordInsightEventIdempotent, recordRecallVerdictToMastery,
} from '../repository/insight.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() {
  current = await setupMemoryHost({ ownerPlugins: [pathsPlugin, ankiPlugin, reviewPlugin] });
  return current;
}

function sampleInput(): InsightDraftInput {
  return {
    title: '导数结构识别 → 换元',
    situation: '求 ∫ x(x²+1)³ dx',
    stuckPoint: '被积函数次数太高，展开不现实',
    turningPoint: '观察到 x 是 (x²+1) 导数的倍数',
    rule: "识别被积函数中'一部分是另一部分导数'的结构 → 令其为 u",
    validityConditions: '复合函数内层导数与外因子成比例',
    ownership: 'self_reported',
    evidence: [{
      kind: 'chat_message',
      sessionId: 'sess_test',
      messageId: 'msg_1',
      variantId: null,
      blockId: null,
      textStart: 0,
      textEnd: 12,
      speaker: 'user',
      resourceId: null,
      quoteSnapshot: '我当时发现 x 恰好是 x²+1 的导数的一半',
    }],
  };
}

describe('insight card service', () => {
  it('create_draft writes the resource snapshot before the insight row (Rust service.rs:88-143)', async () => {
    const { db, repos } = await setup();
    const before = db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM __change_log')!.id ?? 0;
    const card = new InsightService(db, repos.resources).createDraft(sampleInput());
    const rows = db.all<{ table_name: string; operation: string; record_id: string }>(
      'SELECT table_name, operation, record_id FROM __change_log WHERE id > ?1 ORDER BY id', [before]);
    expect(rows.map(row => `${row.operation} ${row.table_name}`)).toEqual([
      'INSERT resources', 'INSERT insights', 'INSERT insight_revisions', 'UPDATE insights',
      'INSERT insight_evidence', 'INSERT insight_events',
    ]);
    expect(rows[1]!.record_id).toBe(card.id);
    expect(rows[0]!.record_id).toBe(card.currentRevision!.resourceId);
  });

  it('test_create_confirm_correct_delete_lifecycle', async () => {
    const { db, repos } = await setup();
    const service = new InsightService(db, repos.resources);

    // Capture.
    const card = service.createDraft(sampleInput());
    expect(card.id.startsWith('ic_')).toBe(true);
    expect(card.ownership).toBe('self_reported');
    expect(card.verificationState).toBe('unverified');
    const revision1 = card.currentRevision;
    expect(revision1).not.toBeNull();
    expect(revision1!.resourceId).not.toBeNull();
    expect(revision1!.turningPoint).toContain('导数');

    // Evidence is queryable.
    const evidence = service.listEvidence(card.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.speaker).toBe('user');
    expect(evidence[0]!.quoteSnapshot.length).toBeGreaterThan(0);

    // Confirm with an edit -> a new revision.
    const confirmed = service.confirm(card.id, {
      rule: '识别反向链式结构 → 换元（无论外层是多项式还是三角函数）',
      editNote: '确认时泛化规则',
    });
    const revision2 = confirmed.currentRevision;
    expect(revision2).not.toBeNull();
    expect(revision2!.id).not.toBe(revision1!.id);
    expect(revision2!.rule).toContain('三角函数');

    // Old revisions remain readable (traceability is the core asset).
    expect(service.listRevisions(card.id)).toHaveLength(2);

    // Correcting appends another revision.
    const corrected = service.correct(card.id, {
      validityConditions: '内层导数与外因子成比例；三角函数外层同样适用',
      editNote: '补充边界',
    });
    expect(service.listRevisions(card.id)).toHaveLength(3);
    expect(corrected.currentRevision!.validityConditions).toContain('三角函数');

    // Delete: tombstone propagation hides the card from every read path.
    service.delete(card.id);
    expect(service.getInsight(card.id)).toBeNull();
    expect(service.listInsights(null, 100, 0)).toHaveLength(0);
  });

  it('test_self_reported_without_user_evidence_downgraded', async () => {
    const { db, repos } = await setup();
    const service = new InsightService(db, repos.resources);
    const input = sampleInput();
    // AI ghostwriting: the evidence speaker is the assistant.
    input.evidence[0]!.speaker = 'assistant';
    const card = service.createDraft(input);
    expect(card.ownership).toBe('guided');
  });

  it('test_validation_and_feedback', async () => {
    const { db, repos } = await setup();
    const service = new InsightService(db, repos.resources);

    // Empty title is rejected.
    const bad = sampleInput();
    bad.title = '  ';
    expect(() => service.createDraft(bad)).toThrow(/标题不能为空/);

    const card = service.createDraft(sampleInput());
    service.recordFeedback(card.id, 'useful', 'sess_test');
    service.recordFeedback(card.id, 'not_applicable', null);
    expect(() => service.recordFeedback(card.id, 'bogus', null)).toThrow(/未知反馈类型/);

    const after = service.getInsight(card.id);
    expect(after).not.toBeNull();
    expect(after!.usefulCount).toBe(1);

    const events = service.listEvents(card.id, 50);
    // create(1) + useful(1) + not_applicable(1)
    expect(events).toHaveLength(3);
    // Three separate ledgers: not_applicable is a quality signal, useful a benefit one.
    const notApplicable = events.find(event => event.eventType === 'feedback_not_applicable');
    expect(notApplicable).toBeDefined();
    expect(notApplicable!.qualitySignal).toBe(0);
    expect(notApplicable!.benefitSignal).toBeNull();
  });

  it('test_relation_scope_required_for_contradict', async () => {
    const { db, repos } = await setup();
    const service = new InsightService(db, repos.resources);
    const a = service.createDraft(sampleInput());
    const inputB = sampleInput();
    inputB.title = 'sqrt(x²) 的化简';
    const b = service.createDraft(inputB);

    // contradict without scope/evidence is rejected.
    expect(() => service.addRelation(a.id, b.id, 'contradict', null, null))
      .toThrow(/必须提供 scope 与 evidence/);
    // With scope + evidence it succeeds.
    service.addRelation(a.id, b.id, 'contradict', 'x<0 时', 'sqrt(x²)=|x| 而非 x');

    const relations = service.listRelations(a.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.relationType).toBe('contradict');
  });
});

describe('insight event ledger', () => {
  it('test_idempotent_event_and_mastery_write', async () => {
    const { db, repos, host } = await setup();
    const service = new InsightService(db, repos.resources);
    const card = service.createDraft(sampleInput());

    // Repeated writes of the same (session, message, insight, type) produce one row.
    for (let index = 0; index < 3; index += 1) {
      recordInsightEventIdempotent(db, 'sess_1', 'msg_1', card.id,
        'shown_existence', 'existence');
    }
    const events = service.listEvents(card.id, 100);
    const shown = events.filter(event => event.eventType === 'shown_existence');
    expect(shown).toHaveLength(1);

    // Silence events may carry a NULL insight_id.
    recordInsightEventIdempotent(db, 'sess_1', 'msg_2', null,
      'silence_no_match', 'hidden');

    // Mastery evidence: source='insight' writes idempotently.
    for (let index = 0; index < 2; index += 1) {
      recordRecallVerdictToMastery(host.ctx.get('mastery') as MasteryService, db, card.id, 'sess_1', true);
    }
    const count = db.pluck<number>(
      "SELECT COUNT(*) FROM mastery_events WHERE source = 'insight'");
    expect(count).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM mastery_states')).toBe(0);
  });
});

describe('insight command facade', () => {
  it('insight service maps wire snake_case and drains consolidation jobs', async () => {
    const host = await setup();
    const insight = host.host.ctx.get('insight') as InsightCommandService;

    const card = await insight.createDraft({
      title: '导数结构识别 → 换元',
      situation: '求 ∫ x(x²+1)³ dx',
      stuck_point: '次数太高',
      turning_point: '观察到导数结构',
      rule: '令 u = x²+1',
      validity_conditions: '内层导数与外因子成比例',
      ownership: 'self_reported',
      evidence: [{
        kind: 'manual', speaker: 'user', quote_snapshot: '手动记录',
      }],
    });
    expect(card.verification_state).toBe('unverified');
    expect(card.current_revision?.situation).toBe('求 ∫ x(x²+1)³ dx');

    const confirmed = await insight.confirm(card.id, null);
    expect(confirmed.current_revision?.rule).toBe('令 u = x²+1');
    expect((await insight.listInsights(null, 10, 0)).map(item => item.id))
      .toContain(card.id);

    // confirm enqueued srs_projection + merge_proposal; the command drains both.
    expect(await insight.runJobs(10)).toBe(2);

    await insight.delete(card.id);
    expect(await insight.getInsight(card.id)).toBeNull();
  });
});
