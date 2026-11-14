import { describe, expect, it } from 'vitest';
import {
  BrowserSession, MAX_HISTORY, USER_TAKEOVER_BLOCK_SECS, defaultOpenSessionOptions,
} from '../src/session.ts';

function session(): BrowserSession {
  return new BrowserSession('bs_1', 'https://a.example/', '/tmp/p');
}

describe('dstu-browser/src/browser/session.rs::tests', () => {
  it('history_back_forward', () => {
    const s = session();
    s.pushUrl('https://b.example/', null);
    s.pushUrl('https://c.example/', null);
    expect(s.canGoBack()).toBe(true);
    expect(s.canGoForward()).toBe(false);
    expect(s.goBack()).toBe('https://b.example/');
    expect(s.canGoForward()).toBe(true);
    expect(s.goForward()).toBe('https://c.example/');
  });

  it('push_truncates_forward_stack', () => {
    const s = session();
    s.pushUrl('https://b.example/', null);
    s.pushUrl('https://c.example/', null);
    s.goBack();
    s.pushUrl('https://d.example/', null);
    expect(s.history.length).toBe(3);
    expect(s.url).toBe('https://d.example/');
    expect(s.canGoForward()).toBe(false);
  });

  it('user_takeover_blocks_then_clears_on_agent_claim', () => {
    const s = session();
    expect(s.controlMode).toBe('user');
    expect(s.isBlockedByUserTakeover()).toBe(false);

    s.setControlMode('agent');
    expect(s.controlMode).toBe('agent');

    s.takeOver();
    expect(s.controlMode).toBe('user');
    expect(s.userTakeoverAt).not.toBeNull();
    expect(s.isBlockedByUserTakeover()).toBe(true);

    s.setControlMode('agent');
    expect(s.controlMode).toBe('agent');
    expect(s.userTakeoverAt).toBeNull();
    expect(s.isBlockedByUserTakeover()).toBe(false);
  });

  it('takeover_notice_latch_survives_claim_until_consumed', () => {
    const s = session();
    expect(s.takeoverNoticePending).toBe(false);
    expect(s.consumeTakeoverNotice()).toBe(false);

    s.takeOver();
    expect(s.takeoverNoticePending).toBe(true);

    s.userTakeoverAt = new Date(Date.now() - (USER_TAKEOVER_BLOCK_SECS + 1) * 1000);
    expect(s.isBlockedByUserTakeover()).toBe(false);
    expect(s.takeoverNoticePending).toBe(true);

    s.setControlMode('agent');
    expect(s.takeoverNoticePending).toBe(true);
    expect(s.consumeTakeoverNotice()).toBe(true);
    expect(s.consumeTakeoverNotice()).toBe(false);
  });

  it('user_takeover_block_expires', () => {
    const s = session();
    s.takeOver();
    s.userTakeoverAt = new Date(Date.now() - (USER_TAKEOVER_BLOCK_SECS + 1) * 1000);
    expect(s.isBlockedByUserTakeover()).toBe(false);
    expect(s.userTakeoverAt).toBeNull();
  });
});

describe('browser session helpers', () => {
  it('caps history at MAX_HISTORY and keeps the newest entries', () => {
    const s = session();
    for (let index = 0; index < MAX_HISTORY + 5; index += 1) s.pushUrl(`https://n${index}.example/`);
    expect(s.history.length).toBe(MAX_HISTORY);
    expect(s.history.at(-1)!.url).toBe(`https://n${MAX_HISTORY + 4}.example/`);
    expect(s.historyIndex).toBe(MAX_HISTORY - 1);
  });

  it('produces the camelCase snapshot with RFC3339 timestamps', () => {
    const s = session();
    s.setTitle('A');
    s.markLoaded();
    const snapshot = s.snapshot();
    expect(snapshot).toMatchObject({
      id: 'bs_1', label: 'browser-content', title: 'A', url: 'https://a.example/',
      canGoBack: false, canGoForward: false, loading: false, alive: true,
      controlMode: 'user', historyIndex: 0, historyLen: 1,
      chatSessionId: null, profilePath: '/tmp/p',
    });
    expect(snapshot.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
    s.markClosed();
    expect(s.snapshot()).toMatchObject({ alive: false, loading: false });
    expect(defaultOpenSessionOptions()).toEqual({
      url: '', displayName: null, chatSessionId: null, width: null, height: null,
      focused: true, reuseExisting: true, fromAgent: false,
    });
  });
});
