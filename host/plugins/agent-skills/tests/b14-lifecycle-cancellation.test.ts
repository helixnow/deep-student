import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendEvents } from '../../../kernel/api.ts';
import type { ExecutionContext } from '../../chat/api.ts';
import { SkillLifecycleChatToolExecutor } from '../src/tools/skill-lifecycle-chat-executor.ts';

function harness() {
  const controller = new AbortController();
  const listeners = new Map<string, (payload: unknown) => void>();
  const requests: Array<Record<string, unknown>> = [];
  const remove = vi.fn();
  const events = {
    listenWindow: (_window: unknown, name: string, receive: (payload: unknown) => void) => {
      listeners.set(name, receive);
      return () => { listeners.delete(name); };
    },
    emit: (_name: string, payload: Record<string, unknown>) => { requests.push(payload); },
  } as unknown as BackendEvents;
  const executor = new SkillLifecycleChatToolExecutor({
    files: () => ({ expandPath: () => '/fake/skills', joinPath: (a: string, b: string) => `${a}/${b}`,
      exists: () => true, validatePath: () => undefined, delete: remove }),
    settings: () => null, events: () => events, warn: () => undefined,
    uuid: () => `request-${requests.length}`, bridgeTimeoutMs: 5000,
  });
  const ctx = { cancellation_token: controller.signal, session_id: 'session', block_id: 'block',
    tryWindow: () => ({ window: 'web-a', webview: 'web-a' }), emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined, emitToolCallError: () => undefined, saveToolBlock: () => undefined,
  } as unknown as ExecutionContext;
  const run = (name: string) => executor.execute({ id: 'call', name,
    arguments: { skill_id: 'demo', enabled: false } }, ctx);
  return { controller, listeners, requests, remove, run };
}

afterEach(() => { vi.useRealTimers(); });

describe('skill lifecycle cancellation', () => {
  it.each(['skill_set_enabled', 'skill_remove'])('stops pending %s without waiting for the bridge timeout', async name => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.run(name);
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Advance the old timeout too: cancellation must not fall back to deleting a package.
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not emit a bridge request or delete when already cancelled', async () => {
    const h = harness();
    h.controller.abort();
    const pending = h.run('skill_remove');
    expect(h.requests).toHaveLength(0);
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('does not send set_enabled when cancellation follows the describe response', async () => {
    const h = harness();
    const pending = h.run('skill_set_enabled');
    const request = h.requests[0];
    if (!request) throw new Error('Expected a describe bridge request');
    h.listeners.get(`skill-lifecycle-bridge-response:${request.correlationId}`)?.({
      correlationId: request.correlationId, ok: true, data: { found: true, isBuiltin: false, disabled: false },
    });
    h.controller.abort();
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(h.requests).toHaveLength(1);
    expect(h.listeners.size).toBe(0);
  });
});
