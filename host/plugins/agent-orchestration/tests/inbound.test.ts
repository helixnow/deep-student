import { describe, expect, it } from 'vitest';
import {
  defaultFilterConfig, defaultSourcePolicy, evaluate, evaluateAndRecord,
  externalSenderId, incomingTrigger, internalTrigger, InboundWindow,
  isExternalSender, normalizeTrigger,
} from '../src/inbound.ts';

const incoming = (source: string, sender: string, body: string) =>
  ({ ...incomingTrigger(source, 'th', body), sender });

describe('super_session/inbound.rs', () => {
  it('internal_always_accepted_with_top_priority', () => {
    expect(evaluate(defaultFilterConfig(), new InboundWindow(), internalTrigger('th', 'watchdog.stalled', 'x'), false, 1_000_000))
      .toEqual({ priority: 2 });
  });
  it('empty_ignored_and_allowlist', () => {
    const cfg = defaultFilterConfig();
    cfg.perSource.set('chat', { ...defaultSourcePolicy(), allowSenders: ['alice'] });
    cfg.perSource.set('noise', { ...defaultSourcePolicy(), mode: 'ignore' });
    const window = new InboundWindow();
    expect(evaluate(cfg, window, incoming('chat', 'alice', '  '), false, 1_000_000)).toEqual({ reason: 'empty_body' });
    expect(evaluate(cfg, window, incoming('chat', 'bob', 'hi'), false, 1_000_000)).toEqual({ reason: 'sender_not_allowed' });
    expect(evaluate(cfg, window, incoming('chat', 'alice', 'hi'), false, 1_000_000)).toEqual({ priority: 0 });
    expect(evaluate(cfg, window, incoming('noise', 'alice', 'hi'), false, 1_000_000)).toEqual({ reason: 'source_ignored' });
  });
  it('mention_only_bypassed_by_explicit_request_or_subscription', () => {
    const cfg = defaultFilterConfig();
    cfg.perSource.set('group', { ...defaultSourcePolicy(), mentionOnly: true, mentionKeywords: ['@Bot'] });
    const window = new InboundWindow();
    const chatter = incoming('group', 'u', 'lunch?');
    expect(evaluate(cfg, window, chatter, false, 1_000_000)).toEqual({ reason: 'not_mentioned' });
    expect(evaluate(cfg, window, chatter, true, 1_000_000)).toEqual({ priority: 0 });
    expect(evaluate(cfg, window, incoming('group', 'u', 'hey @bot look at this'), false, 1_000_000)).toEqual({ priority: 0 });
    expect(evaluate(cfg, window, { ...chatter, explicitRequest: true }, false, 1_000_000)).toEqual({ priority: 1 });
  });
  it('dedupe_and_rate_limit', () => {
    const cfg = defaultFilterConfig();
    cfg.perSource.set('s', { ...defaultSourcePolicy(), maxPerMinute: 2 });
    const window = new InboundWindow();
    window.record({ ...incoming('s', 'u', 'b'), dedupeKey: 'k1' }, 999_900, cfg.dedupeWindowMs);
    expect(evaluate(cfg, window, { ...incoming('s', 'u', 'hi'), dedupeKey: 'k1' }, false, 1_000_000)).toEqual({ reason: 'duplicate' });
    window.record(incoming('s', 'u', 'b'), 999_900, cfg.dedupeWindowMs);
    expect(evaluate(cfg, window, incoming('s', 'u', 'hi'), false, 1_000_000)).toEqual({ reason: 'rate_limited' });
    expect(evaluate(cfg, window, incoming('s', 'other', 'hi'), false, 1_000_000)).toEqual({ priority: 0 });
  });
  it('default_config_treats_manual_and_ilink_as_requests', () => {
    const cfg = defaultFilterConfig();
    const window = new InboundWindow();
    for (const source of ['manual', 'ilink', 'chat']) {
      expect(evaluate(cfg, window, incoming(source, 'me', 'do x'), false, 1_000_000)).toEqual({ priority: 1 });
    }
    expect(evaluate(cfg, window, incoming('webhook', 'me', 'do x'), false, 1_000_000)).toEqual({ priority: 0 });
  });
  it('memory_window_expires_dedupe_and_rate', () => {
    const cfg = defaultFilterConfig();
    const window = new InboundWindow();
    const t = { ...incoming('webhook', 'u', 'hello'), dedupeKey: 'evt-1' };
    expect(evaluateAndRecord(cfg, window, t, 0)).toEqual({ priority: 0 });
    expect(evaluateAndRecord(cfg, window, t, 1000)).toEqual({ reason: 'duplicate' });
    expect(evaluateAndRecord(cfg, window, t, cfg.dedupeWindowMs + 1)).toEqual({ priority: 0 });
    const w2 = new InboundWindow();
    const flood = incoming('webhook', 'spammer', 'x');
    for (let i = 0; i < 30; i++) expect(evaluateAndRecord(cfg, w2, flood, i)).toHaveProperty('priority');
    expect(evaluateAndRecord(cfg, w2, flood, 100)).toEqual({ reason: 'rate_limited' });
    expect(evaluateAndRecord(cfg, w2, flood, 61_000)).toHaveProperty('priority');
  });
  it('normalize_defaults_thread_and_clips_body', () => {
    const cfg = { ...defaultFilterConfig(), maxBodyChars: 4 };
    const t = normalizeTrigger(incomingTrigger('ilink', ' ', '复习到期提醒abc'), cfg);
    expect(t.threadKey).toBe('ilink:default');
    expect(t.body).toBe('复习到期');
  });
  it('external_sender_id_is_sanitized', () => {
    expect(externalSenderId('ilink')).toBe('external:ilink');
    expect(externalSenderId('a b/c<d>')).toBe('external:abcd');
    expect(externalSenderId('  ')).toBe('external:unknown');
    expect(isExternalSender('external:ilink')).toBe(true);
    expect(isExternalSender('subagent_explorer_1')).toBe(false);
  });
});
