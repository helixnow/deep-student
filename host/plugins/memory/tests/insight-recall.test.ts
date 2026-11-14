import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import {
  expandViaRelations, insertInsightCardFixture, insertInsightRelationFixture,
  recallFts, setInsightCardStatus, softDeleteInsightCard,
} from '../repository/insight-cards.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }

function sampleCard(id = 'ic_sample'): void {
  if (current === undefined) throw new Error('missing host');
  insertInsightCardFixture(current.db, {
    id,
    title: '导数结构识别 → 换元',
    situation: '求 ∫ x(x²+1)³ dx',
    stuckPoint: '被积函数次数太高，展开不现实',
    turningPoint: '观察到 x 是 (x²+1) 导数的倍数',
    rule: "识别被积函数中'一部分是另一部分导数'的结构 → 令其为 u",
    validityConditions: '复合函数内层导数与外因子成比例',
    createdAt: '2026-07-10T00:00:00+00:00',
  });
}

describe('insight recall', () => {
  it('test_recall_fts_and_like_fallback', async () => {
    const { db } = await setup();
    sampleCard('ic_fts');

    // FTS: >=3 character Chinese phrase hits through trigram substring semantics.
    const hits = recallFts(db, '被积函数次数太高', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.card.id).toBe('ic_fts');
    expect(hits[0]!.confidence).toBeGreaterThan(0);
    expect(hits[0]!.matchedVia).toBe('fts');

    // No match -> empty (the disclosure controller records the silence).
    expect(recallFts(db, '完全无关的量子引力', 10)).toHaveLength(0);

    // LIKE fallback for queries shorter than 3 characters.
    const short = recallFts(db, '换元', 10);
    expect(short).toHaveLength(1);
    expect(short[0]!.matchedVia).toBe('like');
    expect(short[0]!.card.id).toBe('ic_fts');
  });

  it('test_recall_skips_cold_and_deleted', async () => {
    const { db } = await setup();
    sampleCard('ic_visibility');
    expect(recallFts(db, '被积函数次数太高', 10)).toHaveLength(1);

    // Cold cards stay in the table but leave the recall pool.
    setInsightCardStatus(db, 'ic_visibility', 'cold');
    expect(recallFts(db, '被积函数次数太高', 10)).toHaveLength(0);

    // Soft-deleted (tombstone) cards are filtered by every read path.
    setInsightCardStatus(db, 'ic_visibility', 'active');
    softDeleteInsightCard(db, 'ic_visibility');
    expect(recallFts(db, '被积函数次数太高', 10)).toHaveLength(0);
  });

  it('test_cross_cluster_analogy_expansion', async () => {
    const { db } = await setup();
    insertInsightCardFixture(db, {
      id: 'ic_direct',
      title: '导数结构识别换元',
      situation: '识别导数结构换元',
      createdAt: '2026-07-10T00:00:00+00:00',
    });
    // Indirect card: body does not match the query directly, only linked by a
    // same_method edge to the direct hit.
    insertInsightCardFixture(db, {
      id: 'ic_indirect',
      title: '分部积分选型',
      situation: '乘积积分',
      stuckPoint: '不知谁当 u',
      turningPoint: '降次优先',
      rule: '反对幂指三顺序选型',
      createdAt: '2026-07-10T00:01:00+00:00',
    });
    insertInsightRelationFixture(db, {
      id: 'icx_cross_cluster', fromId: 'ic_direct', toId: 'ic_indirect',
      relationType: 'same_method',
    });

    const hits = recallFts(db, '导数结构识别', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.card.id).toBe('ic_direct');

    const expanded = expandViaRelations(db, hits, 2);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.card.id).toBe('ic_indirect');
    expect(expanded[0]!.matchedVia).toBe('relation');
    expect(expanded[0]!.confidence).toBeLessThan(hits[0]!.confidence);
  });
});
