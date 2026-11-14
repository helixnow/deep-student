import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { FlushExtraction } from '../api.ts';
import { localDate } from '../src/daily-log.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

const SEGMENT_ID = 'seg_test_1';
const SESSION_ID = 'sess_flush_1';

function extraction(): FlushExtraction {
  return {
    facts: [
      { title: '偏好', content: '偏好先看结论再看推导', folder: '偏好' },
      { title: '薄弱点', content: '配方法符号处理容易出错', folder: null },
    ],
    activities: ['做了 5 道二次函数题，错 2 道'],
  };
}

function serviceOf(host: MemoryHost): MemoryServiceImpl {
  return host.host.ctx.memory as unknown as MemoryServiceImpl;
}

function liveNoteCount(host: MemoryHost): number {
  return host.db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM notes WHERE deleted_at IS NULL')?.count ?? 0;
}

describe('compaction memory flush', () => {
  it('extract_compaction_segment_uses_memory_decision_prompt_and_parses', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({
        facts: [{ title: '偏好', content: '偏好先看结论', folder: '偏好' }],
        activities: ['复习了二次函数'],
      }),
    });
    const service = serviceOf(current);

    const result = await service.extractCompactionSegment('对话'.repeat(30));

    expect(result.facts).toEqual([{ title: '偏好', content: '偏好先看结论', folder: '偏好' }]);
    expect(result.activities).toEqual(['复习了二次函数']);
    expect(current.memoryDecision?.calls).toHaveLength(1);
    const prompt = current.memoryDecision!.calls[0]!.prompt;
    expect(prompt).toContain('这段对话即将被压缩摘要');
    expect(prompt).toContain('对话'.repeat(30));
  });

  it('short segment skips the LLM call', async () => {
    current = await setupMemoryHost({ memoryDecision: () => '{"facts":[],"activities":[]}' });
    const service = serviceOf(current);

    const result = await service.extractCompactionSegment('短'.repeat(39));

    expect(result).toEqual({ facts: [], activities: [] });
    expect(current.memoryDecision?.calls).toHaveLength(0);
  });

  it('missing L02 memory-decision entry fails loudly instead of faking extraction', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);

    await expect(service.extractCompactionSegment('对话'.repeat(30)))
      .rejects.toThrow('Memory flush LLM call failed: L02 service does not expose '
        + 'callMemoryDecisionRawPrompt');
  });

  it('LLM errors keep the Rust error prefix and propagate the abort signal', async () => {
    const controller = new AbortController();
    current = await setupMemoryHost({
      memoryDecision: (_prompt, signal) => {
        expect(signal).toBe(controller.signal);
        throw new Error('provider offline');
      },
    });
    const service = serviceOf(current);

    await expect(service.extractCompactionSegment('对话'.repeat(30), controller.signal))
      .rejects.toThrow('Memory flush LLM call failed: provider offline');
  });

  it('apply writes each fact with an atomic receipt and deduplicates replays', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);
    const data = extraction();

    const first = await service.applyFlushExtraction(data, {
      segmentId: SEGMENT_ID, sessionId: SESSION_ID,
    });
    expect(first.report).toEqual({
      facts_extracted: 2, facts_stored: 2, activities_extracted: 1, activities_stored: 1,
    });
    expect(liveNoteCount(current)).toBe(3); // 2 facts + 1 daily-log note

    const receipts = service.queryFlushReceipts(SEGMENT_ID);
    expect(receipts.map(receipt => receipt.idempotencyKey)).toEqual([
      `compaction_flush:${SEGMENT_ID}:fact:0`,
      `compaction_flush:${SEGMENT_ID}:fact:1`,
    ]);
    expect(receipts.every(receipt => !receipt.inProgress && receipt.event === 'ADD')).toBe(true);
    expect(service.getFlushReceipt(SEGMENT_ID, 1)?.noteId).toBe(
      current.db.pluck<string>('SELECT id FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['薄弱点']));
    expect(service.getFlushReceipt(SEGMENT_ID, 9)).toBeUndefined();

    const replay = await service.applyFlushExtraction(data, {
      segmentId: SEGMENT_ID, sessionId: SESSION_ID,
    });
    expect(replay.report.facts_stored).toBe(2);
    expect(liveNoteCount(current)).toBe(3);

    const log = current.db.pluck<string>(
      'SELECT r.data FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.title = ?1',
      [`__daily_log_${localDate()}__`]) ?? '';
    expect(log.split('做了 5 道二次函数题，错 2 道').length - 1).toBe(1);
    expect(service.cleanupFlushReceipts(SEGMENT_ID)).toBe(2);
    expect(service.queryFlushReceipts(SEGMENT_ID)).toEqual([]);
    expect(service.cleanupFlushReceipts(SEGMENT_ID)).toBe(0);
  });

  it('resumes from ledger progress and reports each committed item', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);
    const progress: Array<[number, number]> = [];

    const result = await service.applyFlushExtraction(extraction(), {
      segmentId: SEGMENT_ID, sessionId: SESSION_ID,
      factsCompleted: 1, activitiesCompleted: 0,
      onProgress: (facts, activities) => progress.push([facts, activities]),
    });

    expect(result.factsCompleted).toBe(2);
    expect(result.activitiesCompleted).toBe(1);
    expect(result.facts.map(fact => fact.index)).toEqual([1]);
    expect(progress).toEqual([[2, 0], [2, 1]]);
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['偏好'])).toBe(0);
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['薄弱点'])).toBe(1);
  });

  it('rejects ledger progress beyond the extraction length', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);

    await expect(service.applyFlushExtraction(extraction(), {
      segmentId: SEGMENT_ID, sessionId: SESSION_ID, factsCompleted: 3,
    })).rejects.toThrow('memory flush ledger progress exceeds extraction length');
  });

  it('flush_segment extracts and persists in one production call', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({
        facts: [{ title: '偏好', content: '偏好先看结论', folder: null }],
        activities: [],
      }),
    });
    const service = serviceOf(current);

    const report = await service.flushSegment('对话'.repeat(30), SESSION_ID, SEGMENT_ID);

    expect(report).toEqual({
      facts_extracted: 1, facts_stored: 1, activities_extracted: 0, activities_stored: 0,
    });
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['偏好'])).toBe(1);
    // Ordinary `flush_segment` is best-effort and writes no ledger receipts;
    // only `applyFlushExtraction` owns the L03 idempotency keys.
    expect(service.queryFlushReceipts(SEGMENT_ID)).toEqual([]);
  });

  it('flush_segment warns and continues after one fact fails, then appends activities and logs stats', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({
        facts: [
          { title: '坏事实', content: '使用系统保留目录', folder: '__system__' },
          { title: '好事实', content: '前一条失败后仍然写入', folder: null },
        ],
        activities: ['完成失败继续验证'],
      }),
    });
    const service = serviceOf(current);

    const report = await service.flushSegment('对话'.repeat(30), SESSION_ID, SEGMENT_ID);

    expect(report).toEqual({
      facts_extracted: 2, facts_stored: 1,
      activities_extracted: 1, activities_stored: 1,
    });
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['坏事实'])).toBe(0);
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['好事实'])).toBe(1);
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL',
      [`__daily_log_${localDate()}__`])).toBe(1);
    expect(current.warnings).toContain(
      "[MemoryFlush] Failed to store fact '坏事实': "
      + "Invalid argument 'folder_path': 路径包含系统保留目录（'__*'）");
    expect(current.infos).toContain(
      '[MemoryFlush] Flushed before compaction: facts 1/2, activities 1/1');
    expect(service.queryFlushReceipts(SEGMENT_ID)).toEqual([]);
  });

  it('extract uses Rust trim (U+0085 is whitespace, unlike JS trim)', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => '{"facts":[],"activities":[]}',
    });
    const service = serviceOf(current);

    const result = await service.extractCompactionSegment(
      `\u0085${'对'.repeat(39)}\u0085`);

    expect(result).toEqual({ facts: [], activities: [] });
    expect(current.memoryDecision?.calls).toHaveLength(0);
  });

  it('D1 receipt seam joins the caller transaction and rolls back with it', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);
    const key = `compaction_flush:${SEGMENT_ID}:fact:0`;
    const output = {
      noteId: 'note_receipt', event: 'ADD', isNew: true, confidence: 1,
      reason: 'D1 seam', resourceId: 'res_receipt', downgraded: false,
    };

    current.db.transaction(tx => {
      const reservation = service.tryReserveFlushReceiptWithConn(tx, key);
      expect(reservation).not.toBeNull();
      service.renewFlushReceiptWithConn(tx, reservation!);
      service.cacheFlushReceiptWithConn(tx, reservation!, output);
      expect(service.getFlushReceiptWithConn(tx, SEGMENT_ID, 0)).toMatchObject({
        idempotencyKey: key, noteId: 'note_receipt', event: 'ADD',
      });
      expect(service.listFlushReceiptsWithConn(tx, SEGMENT_ID)).toHaveLength(1);
    }, { behavior: 'immediate' });
    expect(service.queryFlushReceipts(SEGMENT_ID)).toHaveLength(1);

    const rollbackKey = `compaction_flush:${SEGMENT_ID}:fact:1`;
    expect(() => current!.db.transaction(tx => {
      const reservation = service.tryReserveFlushReceiptWithConn(tx, rollbackKey)!;
      service.cacheFlushReceiptWithConn(tx, reservation, { ...output, noteId: 'note_rolled_back' });
      throw new Error('rollback receipt seam');
    }, { behavior: 'immediate' })).toThrow('rollback receipt seam');
    expect(service.queryFlushReceipts(SEGMENT_ID)).toHaveLength(1);
    expect(service.getFlushReceipt(SEGMENT_ID, 1)).toBeUndefined();

    current.db.transaction(tx => {
      expect(service.cleanupFlushReceiptsWithConn(tx, SEGMENT_ID)).toBe(1);
    }, { behavior: 'immediate' });
    expect(service.queryFlushReceipts(SEGMENT_ID)).toEqual([]);
  });

  it('cleanupFlushReceipts uses the Rust GLOB pattern and leaves adjacent segments', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);
    const insert = (key: string): void => {
      current!.db.run(
        `INSERT INTO memory_write_idempotency
           (idempotency_key, note_id, event, is_new, confidence, reason, resource_id, downgraded, created_at)
         VALUES (?1, NULL, 'ADD', 1, 1.0, 'test', NULL, 0, ?2)`,
        [key, Date.now()],
      );
    };
    insert(`compaction_flush:${SEGMENT_ID}:fact:0`);
    insert(`compaction_flush:${SEGMENT_ID}:fact:1`);
    insert('compaction_flush:seg_test_10:fact:0');
    insert(`compaction_flush:${SEGMENT_ID}:activity:0`);

    expect(service.cleanupFlushReceipts(SEGMENT_ID)).toBe(2);
    expect(current.db.all<{ key: string }>(
      'SELECT idempotency_key AS key FROM memory_write_idempotency ORDER BY idempotency_key'))
      .toEqual([
        { key: 'compaction_flush:seg_test_10:fact:0' },
        { key: `compaction_flush:${SEGMENT_ID}:activity:0` },
      ]);
    expect(service.queryFlushReceipts(SEGMENT_ID)).toEqual([]);
  });

  it('cleanupFlushReceipts propagates database failures like the Rust sqlite call', async () => {
    current = await setupMemoryHost();
    const service = serviceOf(current);
    current.db.exec('ALTER TABLE memory_write_idempotency RENAME TO memory_write_idempotency_offline');
    expect(() => service.cleanupFlushReceipts(SEGMENT_ID)).toThrow(/no such table/);
  });
});
