import { afterEach, describe, expect, it } from 'vitest';
import { InsightService, type InsightDraftInput } from '../src/insight-service.ts';
import { InsightJobWorker } from '../src/insight-worker.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import ankiPlugin from '../../anki/index.ts';
import type { AnkiService } from '../../anki/api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup(): Promise<MemoryHost> {
  current = await setupMemoryHost({ ownerPlugins: [pathsPlugin, ankiPlugin] });
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

function workerFor(host: MemoryHost): InsightJobWorker {
  return new InsightJobWorker({
    vfs: host.db,
    mistakes: host.storage.database('mistakes'),
    todos: host.repos.todos,
    warn: message => { host.warnings.push(message); },
    projectionOwner: () => host.host.ctx.get('anki') as AnkiService,
  });
}

function makeCard(service: InsightService, title: string, rule: string): string {
  const card = service.createDraft({
    ...sampleInput(),
    title,
    rule,
    validityConditions: '某条件',
  });
  service.confirm(card.id, null);
  return card.id;
}

describe('insight consolidation worker', () => {
  it('test_srs_projection_materialize_and_regenerate', async () => {
    const host = await setup();
    const service = new InsightService(host.db, host.repos.resources);
    const mistakes = host.storage.database('mistakes');

    const card = service.createDraft(sampleInput());
    service.confirm(card.id, null);

    // confirm enqueues srs_projection + merge_proposal, both drain in one batch.
    const worker = workerFor(host);
    expect(worker.runOnce(10)).toBe(2);

    const projected = mistakes.get<{
      front: string; back: string; sourceType: string; sourceId: string;
    }>(`SELECT front, back, source_type AS sourceType, source_id AS sourceId
         FROM anki_cards WHERE id = ?1`, [`ac_insight_${card.id}`]);
    expect(projected).toBeDefined();
    expect(projected!.front).toContain('导数结构识别');
    expect(projected!.back).toContain('导数');
    expect(projected!.sourceType).toBe('inspiration');
    expect(projected!.sourceId).toBe(card.id);

    // A correction re-runs the projection in place (same card id, FSRS state kept).
    service.correct(card.id, {
      rule: '修订后的规则：先看导数结构再换元',
      editNote: 'test',
    });
    expect(worker.runOnce(10)).toBe(1);
    const back = mistakes.pluck<string>('SELECT back FROM anki_cards WHERE id = ?1',
      [`ac_insight_${card.id}`]);
    expect(back).toContain('修订后的规则');

    // Deleting the source propagates a tombstone to the projected card.
    service.delete(card.id);
    host.host.ctx.memory.insightJobs.enqueue('srs_projection', `srs:${card.id}`,
      JSON.stringify({ insight_id: card.id }));
    worker.runOnce(10);
    const deletedAt = mistakes.get<{ deletedAt: string | null }>(
      'SELECT deleted_at AS deletedAt FROM anki_cards WHERE id = ?1',
      [`ac_insight_${card.id}`]);
    expect(deletedAt).toBeDefined();
    expect(deletedAt!.deletedAt).not.toBeNull();
  });

  it('test_merge_proposal_creates_deduped_todo', async () => {
    const host = await setup();
    const service = new InsightService(host.db, host.repos.resources);

    // Two cards with highly similar titles (trigram substring hit).
    makeCard(service, '导数结构识别换元法', '规则A：识别导数结构');
    makeCard(service, '导数结构识别换元法进阶', '规则B：识别导数结构');

    expect(host.host.ctx.memory.runInsightJobs(20)).toBeGreaterThanOrEqual(2);

    const countTodos = (): number => host.db.pluck<number>(
      `SELECT COUNT(*) FROM todo_items
       WHERE status = 'pending' AND deleted_at IS NULL
         AND description LIKE '%insight-merge:%'`) ?? 0;
    const first = countTodos();
    expect(first).toBeGreaterThanOrEqual(1);

    // Re-running does not create a duplicate marker todo.
    host.host.ctx.memory.runInsightJobs(20);
    expect(countTodos()).toBe(first);

    const listTitle = host.db.pluck<string>(
      `SELECT t.title FROM todo_lists t
       JOIN todo_items i ON i.todo_list_id = t.id
       WHERE i.description LIKE '%insight-merge:%' LIMIT 1`);
    expect(listTitle).toBe('灵感演化');
    const attachments = host.db.pluck<string>(
      `SELECT attachments_json FROM todo_items
       WHERE description LIKE '%insight-merge:%' LIMIT 1`);
    expect(attachments).toContain('res_');
  });

  it('test_principle_synthesis_requires_cases_and_counterexample', async () => {
    const host = await setup();
    const service = new InsightService(host.db, host.repos.resources);

    const a = makeCard(service, '换元法案例一', '规则一');
    const b = makeCard(service, '换元法案例二', '规则二');
    const c = makeCard(service, '换元法反例卡', '规则三');

    const countPrincipleTodos = (): number => host.db.pluck<number>(
      `SELECT COUNT(*) FROM todo_items
       WHERE status = 'pending' AND deleted_at IS NULL
         AND description LIKE '%insight-principle:%'`) ?? 0;

    // same_method only, without a counterexample: no synthesis.
    service.addRelation(a, b, 'same_method', null, null);
    host.host.ctx.memory.runInsightJobs(20);
    expect(countPrincipleTodos()).toBe(0);

    // Adding the counterexample edge completes the requirement.
    service.addRelation(a, c, 'counterexample', null, null);
    host.host.ctx.memory.runInsightJobs(20);
    expect(countPrincipleTodos()).toBe(1);

    // Replaying the same cluster does not duplicate the proposal.
    host.host.ctx.memory.insightJobs.enqueue('principle_synthesis', `principle:${a}`,
      JSON.stringify({ insight_id: a }));
    host.host.ctx.memory.runInsightJobs(20);
    expect(countPrincipleTodos()).toBe(1);
  });

  it('test_principle_review_todo_on_source_correction', async () => {
    const host = await setup();
    const service = new InsightService(host.db, host.repos.resources);

    const source = makeCard(service, '案例卡', '案例规则');
    const principle = makeCard(service, '原则卡', '原则规则');
    // abstract_of: from=principle -> to=case/evidence.
    service.addRelation(principle, source, 'abstract_of', null, null);

    service.correct(source, {
      rule: '更正后的案例规则',
    });
    host.host.ctx.memory.runInsightJobs(20);

    const reviewTodos = host.db.pluck<number>(
      `SELECT COUNT(*) FROM todo_items
       WHERE status = 'pending' AND deleted_at IS NULL
         AND description LIKE '%insight-review:%'`) ?? 0;
    expect(reviewTodos).toBe(1);
  });
});
