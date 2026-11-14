import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkMarkdownSafeText, chunkText, computeEqualJitterBackoffMs, emptyCredentials, IlinkClient, type WeixinMessage } from '../src/client.ts';
import { IlinkPhotoBatchAggregator, MAX_SEEN_IDS_PER_SCOPE, type IlinkPhotoBatch, type IlinkPhotoMessage } from '../src/photo-batch.ts';
import { evaluateChannelReadiness, IlinkPairingGuard } from '../src/pairing-guard.ts';
import { IlinkBotPlugin, CREDENTIALS_KEY, IlinkPhotoBatchAggregator as BotPhotoBatch, IlinkPairingGuard as BotPairingGuard } from '../src/bot.ts';

const scope = { accountId: 'account', peer: 'owner', sessionId: 'session' };
const photo = (id: number, count = 1): IlinkPhotoMessage<number> => ({ ...scope, messageId: id, attachments: Array.from({ length: count }, (_, index) => id + index) });
const caption = (id: number, text: string): IlinkPhotoMessage<number> => ({ ...scope, messageId: id, text });

afterEach(() => vi.useRealTimers());

describe('iLink sliding photo batches', () => {
  it.each([8, 9, 99])('keeps %i images in arrival order and includes captions', count => {
    vi.useFakeTimers();
    const batches: IlinkPhotoBatch<number>[] = [];
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch: batch => batches.push(batch) });
    for (let i = 0; i < count; i++) aggregator.push(photo(i));
    aggregator.push(caption(1000, '请比较这些图片'));
    vi.advanceTimersByTime(9999);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.attachments).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(batches[0]!.text).toBe('请比较这些图片');
    aggregator.dispose();
  });

  it('splits oversized single messages and overflowing consecutive messages at 99', () => {
    vi.useFakeTimers();
    const aggregator = new IlinkPhotoBatchAggregator<number>();
    const first = aggregator.push(photo(0, 200));
    expect(first.batches.map(batch => batch.attachments.length)).toEqual([99, 99]);
    expect(aggregator.flush(scope)!.attachments).toEqual([198, 199]);
    aggregator.push(photo(1000, 99));
    const overflow = aggregator.push(photo(2000, 9));
    expect(overflow.batches[0]!.attachments).toHaveLength(99);
    expect(aggregator.flush(scope)!.attachments).toEqual(Array.from({ length: 9 }, (_, i) => 2000 + i));
    aggregator.dispose();
  });

  it('slides across polls, extends on 还有, and commits on 就这些', () => {
    vi.useFakeTimers();
    const batches: IlinkPhotoBatch<number>[] = [];
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch: batch => batches.push(batch) });
    aggregator.push(photo(1));
    vi.advanceTimersByTime(9000);
    aggregator.push(photo(2));
    vi.advanceTimersByTime(9000);
    aggregator.push(caption(3, '还有，等一下，没发完'));
    vi.advanceTimersByTime(9000);
    expect(batches).toHaveLength(0);
    aggregator.push(photo(4));
    expect(aggregator.push(caption(5, '就这些')).kind).toBe('submitted');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.attachments).toEqual([1, 2, 4]);
    expect(batches[0]!.text).toContain('就这些');
    aggregator.dispose();
  });

  it.each(['开始', '可以了', '发完了'])('seals immediately on %s', text => {
    vi.useFakeTimers();
    const aggregator = new IlinkPhotoBatchAggregator<number>();
    aggregator.push(photo(1));
    expect(aggregator.push(caption(2, text)).batches[0]!.attachments).toEqual([1]);
    expect(aggregator.isCollecting(scope)).toBe(false);
    aggregator.dispose();
  });

  it('does not reset the quiet timer for duplicate IDs, including after submission', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch });
    aggregator.push(photo(1));
    vi.advanceTimersByTime(9000);
    expect(aggregator.push(photo(1)).kind).toBe('duplicate');
    vi.advanceTimersByTime(1000);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(aggregator.push(photo(1)).kind).toBe('duplicate');
    expect(aggregator.isCollecting(scope)).toBe(false);
    aggregator.dispose();
  });

  it('enforces the 120-second safety cap despite continuous arrivals', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const aggregator = new IlinkPhotoBatchAggregator<number>({ maxWaitMs: 999_999, onBatch });
    aggregator.push(photo(0));
    for (let i = 1; i <= 13; i++) {
      vi.advanceTimersByTime(9000);
      aggregator.push(photo(i));
    }
    vi.advanceTimersByTime(3000);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0]![0].attachments).toHaveLength(14);
    aggregator.dispose();
  });

  it('isolates account, peer and session, cancels on /stop, and bypasses controls', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch });
    const others = [{ ...scope, accountId: 'other' }, { ...scope, peer: 'other' }, { ...scope, sessionId: 'other' }];
    aggregator.push(photo(1));
    for (const other of others) expect(aggregator.push({ ...photo(1), ...other }).kind).toBe('collecting');
    expect(aggregator.push(caption(2, '/stop')).kind).toBe('cancelled');
    expect(onBatch).not.toHaveBeenCalled();
    expect(aggregator.isCollecting(scope)).toBe(false);
    for (const [index, command] of ['/status', '/approve approval-id', '/reject approval-id'].entries()) {
      const result = aggregator.push({ ...caption(2, command), ...others[index]! });
      expect(result.kind).toBe('bypass');
      expect(result.batches[0]!.attachments).toEqual([1]);
    }
    vi.advanceTimersByTime(120_000);
    expect(onBatch).toHaveBeenCalledTimes(3);
    aggregator.dispose();
  });

  it('does not delay standalone text or allow disposed timers to submit', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch });
    expect(aggregator.push(caption(1, '普通问题')).kind).toBe('submitted');
    aggregator.push(photo(2));
    aggregator.dispose();
    vi.advanceTimersByTime(120_000);
    expect(onBatch).toHaveBeenCalledTimes(1);
  });
});

describe('one-time account pairing', () => {
  it('generates four characters and consumes normalized bare and /pair codes only once', () => {
    const random = new IlinkPairingGuard();
    expect(random.generate('a').code).toMatch(/^[A-Z0-9]{4}$/);
    const guard = new IlinkPairingGuard({ generateCode: () => 'AB12' });
    guard.generate('a');
    expect(guard.verify('a', ' a-b 1-2 ', 'owner')).toEqual({ ok: true, boundUserId: 'owner' });
    expect(guard.verify('a', 'AB12', 'other')).toEqual({ ok: false, reason: 'no_code' });
    guard.generate('b');
    expect(guard.verify('b', ' /PaIr aB-12 ', 'other')).toMatchObject({ ok: true });
    expect(guard.boundUserId('a')).toBe('owner');
    expect(guard.boundUserId('b')).toBe('other');
  });

  it('expires after ten minutes and revokes both binding and all outstanding codes', () => {
    let now = 0;
    let code = 'AB12';
    const guard = new IlinkPairingGuard({ now: () => now, generateCode: () => code });
    expect(guard.generate('a').expiresAt).toBe(600_000);
    now = 600_000;
    expect(guard.verify('a', code, 'owner')).toEqual({ ok: false, reason: 'expired' });
    guard.generate('a');
    expect(guard.verify('a', code, 'owner').ok).toBe(true);
    guard.generate('a');
    code = 'CD34';
    guard.generate('a');
    expect(guard.verify('a', 'AB12', 'owner').ok).toBe(false);
    guard.revoke('a');
    expect(guard.boundUserId('a')).toBeNull();
    expect(guard.verify('a', 'CD34', 'owner').ok).toBe(false);
  });

  it('invalidates at five failures across senders/regeneration, enforces cooldown and requires a new code', () => {
    let now = 0;
    const guard = new IlinkPairingGuard({ now: () => now, generateCode: () => 'AB12' });
    guard.generate('a');
    guard.generate('b');
    for (let i = 0; i < 4; i++) {
      expect(guard.verify('a', 'ZZZZ', `attacker-${i}`)).toEqual({ ok: false, reason: 'invalid_code' });
      guard.generate('a');
    }
    expect(guard.verify('a', 'ZZZZ', 'attacker')).toEqual({ ok: false, reason: 'cooldown' });
    guard.revoke('a');
    expect(() => guard.generate('a')).toThrow('pairing_cooldown');
    expect(guard.verify('a', 'AB12', 'owner').ok).toBe(false);
    expect(guard.verify('b', 'AB12', 'owner').ok).toBe(true);
    now = 600_000;
    expect(guard.verify('a', 'AB12', 'owner')).toEqual({ ok: false, reason: 'no_code' });
    guard.generate('a');
    expect(guard.verify('a', 'AB12', 'owner').ok).toBe(true);
  });

  it('does not accumulate failures older than the rolling ten-minute window', () => {
    let now = 0;
    const guard = new IlinkPairingGuard({ now: () => now, generateCode: () => 'AB12' });
    guard.generate('a');
    for (let i = 0; i < 4; i++) guard.verify('a', 'ZZZZ', 'attacker');
    now = 600_001;
    guard.generate('a');
    expect(guard.verify('a', 'ZZZZ', 'attacker')).toEqual({ ok: false, reason: 'invalid_code' });
  });
});

it('evaluates all four readiness dimensions with actionable stage precedence', () => {
  const ready = { connected: true, boundUserId: 'owner', botEnabled: true, modelConfigured: true, loginRequired: false, lastError: null };
  for (const [patch, stage] of [
    [{ loginRequired: true, connected: false }, 'login_required'],
    [{ connected: false, boundUserId: null }, 'waiting_connection'],
    [{ boundUserId: null, botEnabled: false }, 'connected_unbound'],
    [{ botEnabled: false, modelConfigured: false }, 'bot_disabled'],
    [{ modelConfigured: false, lastError: 'error' }, 'model_unconfigured'],
    [{ lastError: 'error' }, 'needs_attention'],
    [{}, 'ready'],
  ] as const) expect(evaluateChannelReadiness({ ...ready, ...patch }).stage).toBe(stage);
  expect(evaluateChannelReadiness(ready).checklist).toEqual({ connected: true, bound: true, botEnabled: true, modelConfigured: true });
  expect(evaluateChannelReadiness({ ...ready, loginRequired: true }).checklist.connected).toBe(false);
});

describe('outbound helpers', () => {
  it('retains existing chunkText behavior and counts Unicode code points', () => {
    expect(chunkText('😀中ab', 2)).toEqual(['😀中', 'ab']);
    expect(chunkMarkdownSafeText('😀中ab', 2)).toEqual(['😀中', 'ab']);
    expect(chunkMarkdownSafeText('', 20)).toEqual([]);
    expect(chunkMarkdownSafeText('before\n```ts\nlet a = 1;\n```\nafter', 200)).toEqual(['before\n```ts\nlet a = 1;\n```\nafter']);
  });

  it('closes and reopens long fenced blocks with the language and wrappers inside the limit', () => {
    const text = `before\n\n\`\`\`typescript\n${'const 中文 = "😀";\n'.repeat(30)}\`\`\`\nafter`;
    const chunks = chunkMarkdownSafeText(text, 70);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(70);
      const fences = chunk.split('\n').filter(line => /^`{3,}/.test(line));
      expect(fences.length % 2).toBe(0);
      for (let i = 0; i < fences.length; i += 2) {
        expect(fences[i]).toBe('```typescript');
        expect(fences[i + 1]).toBe('```');
      }
    }
    const content = (value: string) => value.replace(/^`{3,}[^\n]*$/gm, '').replace(/\n/g, '');
    expect(chunks.map(content).join('')).toBe(content(text));
  });

  it('handles multiple blocks, unclosed input, long fence markers and impossible limits', () => {
    for (const text of [`\`\`\`js\n${'a'.repeat(80)}\n\`\`\`\n\`\`\`py\n${'b'.repeat(80)}\n\`\`\``, `\`\`\`js\n${'a'.repeat(80)}`, `\`\`\`\`js\n${'a'.repeat(80)}\n\`\`\`\``]) {
      for (const chunk of chunkMarkdownSafeText(text, 24)) {
        expect(Array.from(chunk).length).toBeLessThanOrEqual(24);
        expect(chunk.match(/^`{3,}/gm)!.length % 2).toBe(0);
      }
    }
    expect(() => chunkMarkdownSafeText('x', 0)).toThrow(RangeError);
    expect(() => chunkMarkdownSafeText('```typescript\nlong code\n```', 8)).toThrow(RangeError);
  });

  it('uses one-based exponential equal jitter, caps normal delay and honors Retry-After floors', () => {
    expect(computeEqualJitterBackoffMs(1, 1000, 60_000, 0, () => 0)).toBe(500);
    expect(computeEqualJitterBackoffMs(1, 1000, 60_000, 0, () => 1)).toBe(1000);
    expect(computeEqualJitterBackoffMs(3, 1000, 60_000, 0, () => 0.5)).toBe(3000);
    expect(computeEqualJitterBackoffMs(20, 1000, 60_000, 0, () => 0)).toBe(30_000);
    expect(computeEqualJitterBackoffMs(20, 1000, 60_000, 90_000, () => 0)).toBe(90_000);
    expect(computeEqualJitterBackoffMs(2, 1000, 60_000, 250, () => 1)).toBe(2000);
  });
});

it('exports optional guards from the bot entry without changing default construction', () => {
  expect(BotPhotoBatch).toBe(IlinkPhotoBatchAggregator);
  expect(BotPairingGuard).toBe(IlinkPairingGuard);
});

it('optionally gates owner messages, routes normalized photos, and lets /stop reach the task bridge', async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const secrets = new Map([[CREDENTIALS_KEY, JSON.stringify({ ...emptyCredentials(), accountId: scope.accountId, token: 'token', userId: 'qr-user' })]]);
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => values.delete(key),
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { secrets.set(key, value); },
    deleteSecret: async (key: string) => secrets.delete(key),
  };
  const guard = new IlinkPairingGuard({ generateCode: () => 'AB12' });
  guard.generate(scope.accountId);
  const onBatch = vi.fn();
  const aggregator = new IlinkPhotoBatchAggregator({ onBatch });
  const controller = new AbortController();
  const client = new IlinkClient();
  const messages: WeixinMessage[] = [
    { message_id: 1, item_list: [{ text_item: { text: '未绑定问题' } }] },
    { message_id: 2, item_list: [{ text_item: { text: 'ab-12' } }] },
    { message_id: 3, item_list: [{ type: 2 }] },
    { message_id: 4, item_list: [{ text_item: { text: '就这些' } }] },
    { message_id: 5, item_list: [{ type: 2 }] },
    { message_id: 6, item_list: [{ text_item: { text: '/stop' } }] },
    { message_id: 7, item_list: [{ text_item: { text: '普通问题' } }] },
    { message_id: 8, from_user_id: 'intruder', item_list: [{ text_item: { text: '不允许的问题' } }] },
  ].map(message => ({ from_user_id: scope.peer, session_id: scope.sessionId, context_token: 'context', ...message }));
  let polls = 0;
  const poll = vi.spyOn(client, 'getUpdates').mockImplementation(async () => {
    if (polls++ === 0) return { msgs: messages };
    controller.abort();
    return { msgs: [] };
  });
  const send = vi.spyOn(client, 'sendText').mockResolvedValue({});
  const dispatch = vi.fn(async (_input: { text: string }) => ({ kind: 'ignored' as const }));
  const plugin = new IlinkBotPlugin({
    client, events: { emit: () => undefined }, log: () => undefined,
    pairingGuard: guard,
    photoBatch: { aggregator, attachments: message => message.item_list?.some(item => item.type === 2) ? [message.message_id] : [] },
    tasks: { isControlMessage: text => text === '/stop', dispatch, cancelSession: async () => true },
  });
  try {
    await plugin.run({ settings, signal: controller.signal, config: null, desktop: true });
    expect(guard.boundUserId(scope.accountId)).toBe(scope.peer);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0]![0]).toMatchObject({ attachments: [3], text: '就这些' });
    expect(dispatch.mock.calls.map(call => call[0].text)).toEqual(['/stop', '普通问题']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(aggregator.isCollecting(scope)).toBe(false);
    guard.generate(scope.accountId);
    await plugin.logout(settings);
    expect(guard.boundUserId(scope.accountId)).toBeNull();
    expect(guard.verify(scope.accountId, 'AB12', scope.peer).ok).toBe(false);
  } finally {
    aggregator.dispose();
    poll.mockRestore();
    send.mockRestore();
  }
});

it('bounds per-scope dedup memory and forgets the oldest message ids first', () => {
  const aggregator = new IlinkPhotoBatchAggregator<number>();
  aggregator.push(caption(0, 'first'));
  for (let id = 1; id <= MAX_SEEN_IDS_PER_SCOPE; id += 1) {
    expect(aggregator.push(caption(id, 'x')).kind).toBe('submitted');
  }
  // 超出上限时淘汰最早的 id：它被当作新消息，而最近一个仍然是重复。
  expect(aggregator.push(caption(0, 'first')).kind).toBe('submitted');
  expect(aggregator.push(caption(MAX_SEEN_IDS_PER_SCOPE, 'x')).kind).toBe('duplicate');
  aggregator.dispose();
});
