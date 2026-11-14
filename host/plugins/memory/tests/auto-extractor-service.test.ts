import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { localDate } from '../src/daily-log.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

function serviceOf(host: MemoryHost): MemoryServiceImpl {
  return host.host.ctx.memory as unknown as MemoryServiceImpl;
}

describe('memory auto extraction', () => {
  it('extract_memory_candidates_uses_profile_and_parses_full_object', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({
        facts: [{ title: '偏好', content: '偏好先看结论', folder: '偏好' }],
        activities: ['复习了二次函数'],
      }),
    });
    const service = serviceOf(current);

    const result = await service.extractMemoryCandidates(
      '我想先看结论再看推导', '好的，这是结论', '已有画像：喜欢图解');

    expect(result.candidates).toEqual([{ title: '偏好', content: '偏好先看结论', folder: '偏好' }]);
    expect(result.activities).toEqual(['复习了二次函数']);
    const prompt = current.memoryDecision!.calls[0]!.prompt;
    expect(prompt).toContain('已有记忆（不要重复提取这些事实）');
    expect(prompt).toContain('已有画像：喜欢图解');
    expect(prompt).toContain('用户: 我想先看结论再看推导');
    expect(prompt).toContain('助手: 好的，这是结论');
  });

  it('both sides under four chars skip the LLM call', async () => {
    current = await setupMemoryHost({ memoryDecision: () => '{"facts":[],"activities":[]}' });
    const service = serviceOf(current);

    const result = await service.extractMemoryCandidates('abc', 'def', null);

    expect(result).toEqual({ candidates: [], activities: [] });
    expect(current.memoryDecision?.calls).toHaveLength(0);
  });

  it('extract_and_store_memory dedupes candidates and appends activities', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({
        facts: [
          { title: '偏好', content: '偏好先看结论', folder: '偏好' },
          { title: '偏好', content: '偏好先看结论', folder: '偏好' },
        ],
        activities: ['复习了二次函数'],
      }),
    });
    const service = serviceOf(current);

    const stored = await service.extractAndStoreMemory('继续复习二次函数', '好的，先看结论');

    expect(stored).toBe(1);
    expect(current.db.pluck<number>(
      'SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL', ['偏好'])).toBe(1);
    const log = current.db.pluck<string>(
      'SELECT r.data FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.title = ?1',
      [`__daily_log_${localDate()}__`]) ?? '';
    expect(log).toContain('复习了二次函数');
    const audit = current.db.all<{ operation: string; reason: string }>(
      "SELECT operation, reason FROM memory_audit_log WHERE source = 'auto_extract' ORDER BY id");
    expect(audit.at(-1)?.operation).toBe('extract');
    expect(audit.at(-1)?.reason).toBe('提取 2 条候选，写入 1 条');
    expect(current.infos).toContain(
      '[MemoryAutoExtractor] Appended 1/1 activities to daily log');
  });

  // Rust auto_extractor.rs:117-132: activities are appended (with info) before the
  // `candidates.is_empty()` early return, which skips the extract audit row and stats.
  it('extract_and_store_memory returns before audit when only activities are extracted', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => JSON.stringify({ facts: [], activities: ['做了 5 道二次函数题'] }),
    });
    const service = serviceOf(current);

    const stored = await service.extractAndStoreMemory('今天做了五道题', '好的，记下来了');

    expect(stored).toBe(0);
    const log = current.db.pluck<string>(
      'SELECT r.data FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.title = ?1',
      [`__daily_log_${localDate()}__`]) ?? '';
    expect(log).toContain('做了 5 道二次函数题');
    expect(current.infos).toContain(
      '[MemoryAutoExtractor] Appended 1/1 activities to daily log');
    expect(current.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_audit_log WHERE source = 'auto_extract' AND operation = 'extract'"))
      .toBe(0);
    expect(current.infos.some(message => message.includes('Pipeline complete'))).toBe(false);
  });
});
