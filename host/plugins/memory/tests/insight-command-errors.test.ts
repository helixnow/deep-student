import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { InsightCommandService } from '../api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

function appErrorOf(error: unknown): { error_type: string; message: string; details: unknown } {
  const value = (error as { value?: unknown })?.value;
  expect(value).toMatchObject({ error_type: expect.any(String), message: expect.any(String) });
  return value as { error_type: string; message: string; details: unknown };
}

function insightOf(host: MemoryHost): InsightCommandService {
  return host.host.ctx.get('insight') as InsightCommandService;
}

describe('insight service AppError classification', () => {
  it('createDraft returns Validation instead of a plain Error', async () => {
    current = await setupMemoryHost();
    const error = await insightOf(current).createDraft({
      title: '', situation: '', stuck_point: '', turning_point: '转折', rule: '',
      validity_conditions: '', ownership: 'self_reported', evidence: [],
    }).catch(value => value);
    expect(appErrorOf(error)).toEqual({
      error_type: 'Validation', message: '灵感卡标题不能为空', details: null,
    });
  });

  it('confirm returns NotFound for a missing card', async () => {
    current = await setupMemoryHost();
    const error = await insightOf(current).confirm('missing', null).catch(value => value);
    expect(appErrorOf(error)).toEqual({
      error_type: 'NotFound', message: '灵感卡不存在: missing', details: null,
    });
  });

  it('recordFeedback returns Validation for an unknown feedback type', async () => {
    current = await setupMemoryHost();
    const error = await insightOf(current).recordFeedback('missing', 'bogus', null)
      .catch(value => value);
    expect(appErrorOf(error)).toEqual({
      error_type: 'Validation', message: '未知反馈类型: bogus', details: null,
    });
  });

  it('addRelation returns Validation for an unknown relation type', async () => {
    current = await setupMemoryHost();
    const error = await insightOf(current).addRelation('a', 'b', 'bogus', null, null)
      .catch(value => value);
    expect(appErrorOf(error)).toEqual({
      error_type: 'Validation', message: '未知关系类型: bogus', details: null,
    });
  });
});
