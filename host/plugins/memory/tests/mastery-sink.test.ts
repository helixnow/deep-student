import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MasteryProfileSink } from '../../review/api.ts';
import { WEAK_POINT_SOURCE_MASTERY } from '../src/profile-store.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('mastery profile sink', () => {
  it('upserts and removes mastery weak points through the memory profile', async () => {
    current = await setupMemoryHost();
    await current.host.invoke<string>('memory_get_or_create_root_folder');
    const sink = current.host.ctx.get('masteryProfileSink') as MasteryProfileSink | undefined;
    expect(sink).toBeDefined();
    const service = current.host.ctx.get('memory') as unknown as MemoryServiceImpl;
    const conn = current.db as unknown as SqlExecutor;

    sink!.upsertWeakPointFromMastery(conn, '  concept-a  ', {
      score: 0.5, total: 10, wrongCount: 3, recentWrongSummary: 'q1, q2',
    });

    const profile = service.loadProfile();
    expect(profile).not.toBeNull();
    const weakPoint = profile!.weak_points.find(point => point.knowledge_point === 'concept-a');
    expect(weakPoint).toMatchObject({
      subject: '掌握度', evidence_count: 3, source: WEAK_POINT_SOURCE_MASTERY,
    });
    expect(weakPoint!.error_pattern).toBe('[mastery] score=0.50 total=10 wrongs=3; q1, q2');

    sink!.removeWeakPointFromMastery(conn, 'CONCEPT-A');
    expect(service.loadProfile()!.weak_points
      .some(point => point.knowledge_point === 'concept-a')).toBe(false);
  });

  it('keeps the Rust mastery concept validation', async () => {
    current = await setupMemoryHost();
    await current.host.invoke<string>('memory_get_or_create_root_folder');
    const sink = current.host.ctx.get('masteryProfileSink') as MasteryProfileSink;
    expect(() => sink.upsertWeakPointFromMastery(current!.db as unknown as SqlExecutor, '   ', {
      score: 0, total: 0, wrongCount: 0, recentWrongSummary: '',
    })).toThrow(/mastery concept must be non-empty/);
    expect(() => sink.removeWeakPointFromMastery(
      current!.db as unknown as SqlExecutor, '   '))
      .toThrow(/mastery concept must be non-empty/);
  });
});
