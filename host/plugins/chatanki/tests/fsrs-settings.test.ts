import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: 测试夹具；mistakesFixture 建出迁移后的真实 mistakes DB（L15 测试唯一的建库入口）
import { mistakesFixture } from '../../review/tests/storage.ts';
// boundary-allow cross-plugin-impl: L15 review/api.ts 尚未发布 getReviewStatistics(days)（dailyLimits 来源）；Rust 测试直接驱动真实 FsrsReviewService 对迁移后 DB 往返，待 L15 扩展 api 后替换
import { FsrsReviewService } from '../../review/src/review.ts';
import chatanki from '../index.ts';
import { FsrsSettingsExecutor, parseUpdateRequest } from '../src/fsrs-settings-executor.ts';
import type {
  FsrsSchedulerConfig, SchedulerService, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';

function context(events: unknown[], saved: ToolResultInfo[]): ToolExecutionContext {
  return {
    sessionId: 'sess-fsrs', messageId: 'msg-fsrs', blockId: 'blk-fsrs',
    emitToolCallStart: (...args) => { events.push(['start', ...args]); },
    emitToolCallEnd: (value) => { events.push(['end', value]); },
    emitToolCallError: (error) => { events.push(['error', error]); },
    saveToolBlock: (value) => { saved.push(value); },
    warn: (message) => { events.push(['warn', message]); },
  };
}

it('can_handle_matches_both_tools_and_splits_sensitivity', () => {
  const executor = new FsrsSettingsExecutor();
  expect(executor.canHandle('builtin-fsrs_get_scheduler_config')).toBe(true);
  expect(executor.canHandle('fsrs_update_scheduler_config')).toBe(true);
  expect(executor.canHandle('builtin-learning_overview')).toBe(false);
  expect(executor.sensitivityLevel('builtin-fsrs_get_scheduler_config')).toBe('low');
  expect(executor.sensitivityLevel('builtin-fsrs_update_scheduler_config')).toBe('medium');
  expect(executor.concurrencyClass('builtin-fsrs_get_scheduler_config')).toBe('read_only');
  expect(executor.concurrencyClass('builtin-fsrs_update_scheduler_config')).toBe('serial');
});

it('parse_update_request_validates_bounds_and_aliases', () => {
  const valid = parseUpdateRequest({
    new_per_day: 50, reviewsPerDay: 300, desired_retention: 0.85, leech_action: 'mark',
  });
  expect(valid.new_per_day).toBe(50);
  expect(valid.reviews_per_day).toBe(300);
  expect(valid.desired_retention).toBe(0.85);
  expect(valid.leech_action).toBe('mark');
  for (const invalid of [
    { new_per_day: 10000 }, { reviews_per_day: -1 }, { new_per_day: 20.5 },
    { desired_retention: 1 }, { desired_retention: '0.9' }, { leech_action: 'ban' },
    { enable_fuzz: 'yes' }, {}, [],
  ]) {
    let caught: unknown;
    try { parseUpdateRequest(invalid); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.parse((caught as Error).message).code).toBe('INVALID_ARGS');
  }
  expect(parseUpdateRequest({ new_per_day: 0 }).new_per_day).toBe(0);
  expect(parseUpdateRequest({ reviews_per_day: 9999 }).reviews_per_day).toBe(9999);
});

it('get_then_update_roundtrip_on_migrated_db', async () => {
  const fixture = mistakesFixture();
  const review = new FsrsReviewService(fixture.db);
  const scheduler: SchedulerService = {
    getSchedulerConfig: () => review.getSchedulerConfig(),
    getReviewStatistics: (days) => review.getReviewStatistics(days),
    // 契约的 update 形状允许 null；Rust 的 Option::None 与缺省同义，
    // 适配时丢弃 null 字段，再交给 L15 的真实实现（与 ReviewService 边界一致）。
    updateSchedulerConfig: (update) => {
      const concrete: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(update)) {
        if (value !== null && value !== undefined) concrete[key] = value;
      }
      return review.updateSchedulerConfig(
        concrete as Parameters<FsrsReviewService['updateSchedulerConfig']>[0],
      );
    },
  };
  const host = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: scheduler,
      llm: {},
      'anki': {},
    },
  });
  try {
    const initialResult = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs-get', name: 'builtin-fsrs_get_scheduler_config', arguments: {},
    }, context([], []));
    expect(initialResult.success).toBe(true);
    const initial = initialResult.output as {
      config: { newPerDay: number; reviewsPerDay: number };
      dailyLimits: { newPerDay: number; newRemainingToday: number };
    };
    expect(initial.config.newPerDay).toBe(20);
    expect(initial.config.reviewsPerDay).toBe(200);
    expect(initial.dailyLimits.newPerDay).toBe(20);
    expect(initial.dailyLimits.newRemainingToday).toBe(20);

    const updateResult = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs-update', name: 'fsrs_update_scheduler_config',
      arguments: { new_per_day: 50, desired_retention: 0.85 },
    }, context([], []));
    expect(updateResult.success).toBe(true);
    const updated = updateResult.output as {
      updated: string[];
      config: { newPerDay: number; desiredRetention: number; reviewsPerDay: number };
    };
    expect(updated.updated).toEqual(['new_per_day', 'desired_retention']);
    expect(updated.config.newPerDay).toBe(50);
    expect(updated.config.desiredRetention).toBe(0.85);
    expect(updated.config.reviewsPerDay).toBe(200);

    const rereadResult = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs-reread', name: 'builtin-fsrs_get_scheduler_config', arguments: {},
    }, context([], []));
    expect(rereadResult.success).toBe(true);
    const reread = rereadResult.output as {
      config: { newPerDay: number; desiredRetention: number };
      dailyLimits: { newPerDay: number };
    };
    expect(reread.config.newPerDay).toBe(50);
    expect(reread.config.desiredRetention).toBe(0.85);
    expect(reread.dailyLimits.newPerDay).toBe(50);
  } finally {
    await host.dispose();
    fixture.dispose();
  }
});

it('missing_review_statistics_fails_closed_without_blocking_update', async () => {
  const base: FsrsSchedulerConfig = {
    newPerDay: 20, reviewsPerDay: 200, learnAheadMinutes: 15, desiredRetention: 0.9,
    leechThreshold: 8, leechAction: 'suspend', enableFuzz: true, learningSteps: [1, 10],
    relearningSteps: [10], maximumInterval: 36500, dayRolloverHour: 4, fsrsParams: [],
    fsrsOptimizedAtMs: null, fsrsOptimizedReviewCount: null, buryNewSiblings: false,
    buryReviewSiblings: false, reviewOrder: 'due', newReviewOrder: 'new-first',
    maxAnswerSeconds: 60,
  };
  const writes: unknown[] = [];
  const scheduler: SchedulerService = {
    getSchedulerConfig: () => base,
    updateSchedulerConfig: (update) => {
      writes.push(update);
      return { ...base, newPerDay: update.newPerDay ?? base.newPerDay };
    },
  };
  const host = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: scheduler,
      llm: {},
      'anki': {},
    },
  });
  try {
    const read = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs-no-stats', name: 'builtin-fsrs_get_scheduler_config', arguments: {},
    }, context([], []));
    expect(read.success).toBe(false);
    expect(JSON.parse(read.error!).code).toBe('FSRS_STATS_UNAVAILABLE');

    const write = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs-no-stats-update', name: 'fsrs_update_scheduler_config',
      arguments: { new_per_day: 50 },
    }, context([], []));
    expect(write.success).toBe(true);
    expect(writes).toEqual([{ newPerDay: 50 }]);
  } finally { await host.dispose(); }
});

it('missing_anki_db_is_structured_fail_closed', async () => {
  const host = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: {},
      llm: {},
      'anki': {},
    },
  });
  try {
    const events: unknown[] = [];
    const saved: ToolResultInfo[] = [];
    const result = await host.ctx.chatankiTools.execute({
      id: 'call-fsrs', name: 'builtin-fsrs_get_scheduler_config', arguments: {},
    }, context(events, saved));
    expect(result.success).toBe(false);
    const structured = JSON.parse(result.error!);
    expect(structured.code).toBe('FSRS_DB_UNAVAILABLE');
    expect(structured.retryable).toBe(false);
    expect(result.output).toBeNull();
    expect(saved).toEqual([result]);
    expect(events[0]).toEqual(['start', 'builtin-fsrs_get_scheduler_config', {}, 'call-fsrs']);
    expect(events[1]).toEqual(['error', result.error]);
  } finally { await host.dispose(); }
});

it('scheduler aliases prefer non-null snake values and preserve false and zero', () => {
  expect(parseUpdateRequest({ new_per_day: null, newPerDay: 0, enable_fuzz: false })).toMatchObject({
    new_per_day: 0, enable_fuzz: false,
  });
  expect(parseUpdateRequest({ new_per_day: 1, newPerDay: 2 }).new_per_day).toBe(1);
  expect(() => parseUpdateRequest({ new_per_day: '1', newPerDay: 2 })).toThrow('INVALID_ARGS');
});

it('scheduler numbers follow arbitrary_precision Number::as_u64 / as_f64 on the literal', () => {
  const raw = (text: string): unknown => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
  const detail = (args: unknown): unknown => {
    try { parseUpdateRequest(args); } catch (error) { return JSON.parse((error as Error).message).messageParams.detail; }
    return null;
  };
  expect(parseUpdateRequest({
    desired_retention: raw('0.90'), new_per_day: raw('-0'), reviews_per_day: raw('120'), leech_threshold: raw('8'),
  })).toMatchObject({ desired_retention: 0.9, new_per_day: 0, reviews_per_day: 120, leech_threshold: 8 });
  expect(detail({ desired_retention: raw('1.0') })).toBe('desired_retention 必须在 (0,1) 开区间内，例如 0.9');
  expect(detail({ desired_retention: raw('1e400') })).toBe('desired_retention 必须是 (0,1) 开区间内的小数，例如 0.9');
  expect(detail({ new_per_day: raw('20.0') })).toBe('new_per_day 必须是 0–9999 的整数');
  expect(detail({ new_per_day: raw('1e1') })).toBe('new_per_day 必须是 0–9999 的整数');
  expect(detail({ new_per_day: raw('9007199254740993') }))
    .toBe('new_per_day 必须是 0–9999 的整数（对齐闪卡设置面板的 0–9999 区间）');
  expect(detail({ reviews_per_day: raw('18446744073709551616') })).toBe('reviews_per_day 必须是 0–9999 的整数');
  expect(detail({ reviews_per_day: 2 ** 64 })).toBe('reviews_per_day 必须是 0–9999 的整数');
  expect(detail({ leech_threshold: raw('-0.0') })).toBe('leech_threshold 必须是 0–9999 的整数');
});
