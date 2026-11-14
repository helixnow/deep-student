import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import chatanki from '../index.ts';
import type { FsrsStats, ToolExecutionContext, ToolResultInfo } from '../api.ts';

function context(events: unknown[] = [], saved: ToolResultInfo[] = []): ToolExecutionContext {
  return {
    sessionId: 'sess-review-tools', messageId: 'msg-review-tools', blockId: 'blk-review-tools',
    emitToolCallStart: (...args) => { events.push(['start', ...args]); },
    emitToolCallEnd: (value) => { events.push(['end', value]); },
    emitToolCallError: (error) => { events.push(['error', error]); },
    saveToolBlock: (value) => { saved.push(value); },
    warn: () => undefined,
  };
}

function stats(): FsrsStats {
  return {
    total: 12, due: 3, newCount: 4, learning: 1, review: 5, relearning: 1,
    suspended: 1, reviewsToday: 7, buried: 0, leech: 0, newRemainingToday: 16,
    reviewsRemainingToday: 193, backlog: 3, backlogReview: 3, backlogNew: 0,
    learningWaiting: 1,
  };
}

it('chatanki_review_stats projects the L15 getStats snapshot', async () => {
  const host = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: { getStats: () => stats() },
      llm: {},
      'anki': {},
    },
  });
  try {
    const events: unknown[] = [];
    const saved: ToolResultInfo[] = [];
    const result = await host.ctx.chatankiTools.execute({
      id: 'call-review-stats', name: 'builtin-chatanki_review_stats', arguments: {},
    }, context(events, saved));
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      status: 'ok',
      total: 12,
      due: 3,
      new: 4,
      learning: 1,
      review: 5,
      relearning: 1,
      suspended: 1,
      reviews_today: 7,
    });
    expect(saved).toEqual([result]);
    expect(events[0]).toEqual([
      'start', 'builtin-chatanki_review_stats', {}, 'call-review-stats',
    ]);
    expect(events[1]).toEqual(['end', { result: result.output, durationMs: result.durationMs }]);
  } finally { await host.dispose(); }
});

it('chatanki_review_stats rejects unknown fields and missing review service', async () => {
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
    const unknown = await host.ctx.chatankiTools.execute({
      id: 'call-review-stats-unknown', name: 'chatanki_review_stats',
      arguments: { scope: 'chat' },
    }, context());
    expect(unknown.success).toBe(false);
    // serde `unknown_field` on an empty FIELDS list (struct ChatAnkiReviewStatsArgs {}, deny_unknown_fields).
    expect(unknown.error).toBe('Invalid chatanki_review_stats arguments: unknown field `scope`, there are no fields');
    for (const [args, text] of [
      ['all', 'invalid type: string "all", expected struct ChatAnkiReviewStatsArgs'],
      [[1], 'invalid length 1, expected fewer elements in array'],
    ] as const) {
      const invalid = await host.ctx.chatankiTools.execute({
        id: 'call-review-stats-invalid', name: 'chatanki_review_stats', arguments: args as never,
      }, context());
      expect(invalid.error).toBe(`Invalid chatanki_review_stats arguments: ${text}`);
    }

    const missing = await host.ctx.chatankiTools.execute({
      id: 'call-review-stats-missing', name: 'chatanki_review_stats', arguments: {},
    }, context());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('blocks.ankiCards.errors.databaseUnavailable');
  } finally { await host.dispose(); }
});

it('chatanki_check_anki_connect reports availability and probe failures', async () => {
  const availableHost = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: {},
      llm: {},
      'anki': { checkAnkiConnectAvailability: async () => true },
    },
  });
  try {
    const result = await availableHost.ctx.chatankiTools.execute({
      id: 'call-check-anki', name: 'builtin-chatanki_check_anki_connect', arguments: {},
    }, context());
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ status: 'ok', available: true, error: null });
  } finally { await availableHost.dispose(); }

  const failingHost = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: {},
      llm: {},
      'anki': {
        checkAnkiConnectAvailability: async () => { throw new Error('connection refused'); },
      },
    },
  });
  try {
    const result = await failingHost.ctx.chatankiTools.execute({
      id: 'call-check-anki-failing', name: 'chatanki_check_anki_connect', arguments: {},
    }, context());
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      status: 'ok', available: false, error: 'connection refused',
    });
  } finally { await failingHost.dispose(); }

  const missingHost = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: {},
      llm: {},
      'anki': {},
    },
  });
  try {
    const result = await missingHost.ctx.chatankiTools.execute({
      id: 'call-check-anki-missing', name: 'chatanki_check_anki_connect', arguments: {},
    }, context());
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      status: 'ok', available: false, error: 'AnkiConnect service unavailable',
    });
  } finally { await missingHost.dispose(); }
});
