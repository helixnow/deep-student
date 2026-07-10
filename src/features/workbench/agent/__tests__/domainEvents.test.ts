/**
 * R1-18 — domainEvents：多 handler 注册/注销、payload 透传、环形缓冲、dstu key extractor
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂会被提升，可变状态必须放进 vi.hoisted
const { hubHandlers, keyExtractors } = vi.hoisted(() => ({
  hubHandlers: new Map<string, Set<(payload: unknown) => void>>(),
  keyExtractors: new Map<string, (payload: unknown) => string | null>(),
}));

vi.mock('../../core/eventHub', () => ({
  hubListen: vi.fn((eventName: string, handler: (payload: unknown) => void) => {
    let set = hubHandlers.get(eventName);
    if (!set) {
      set = new Set();
      hubHandlers.set(eventName, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) hubHandlers.delete(eventName);
    };
  }),
  setHubKeyExtractor: vi.fn(
    (eventName: string, extractor: (payload: unknown) => string | null) => {
      keyExtractors.set(eventName, extractor);
      return () => {
        if (keyExtractors.get(eventName) === extractor) keyExtractors.delete(eventName);
      };
    },
  ),
}));

import { hubListen, setHubKeyExtractor } from '../../core/eventHub';
import {
  collectDomainEntityIds,
  dstuChangeKeyExtractor,
  getRecentDomainEventsForTests,
  getRecentReceiptSummariesForTests,
  isDstuKeyExtractorInstalledForTests,
  KNOWN_DOMAIN_EVENTS,
  normalizeDomainPayload,
  recordAcrReceiptSummary,
  recordDomainEvent,
  registerDomainListener,
  resetDomainListenersForTests,
  resourceIdFromDstuPath,
} from '../domainEvents';

function emitHub(eventName: string, payload: unknown): void {
  const set = hubHandlers.get(eventName);
  if (!set) return;
  for (const fn of Array.from(set)) fn(payload);
}

describe('domainEvents (R1-18)', () => {
  beforeEach(() => {
    resetDomainListenersForTests();
    hubHandlers.clear();
    vi.mocked(hubListen).mockClear();
    vi.mocked(setHubKeyExtractor).mockClear();
  });

  afterEach(() => {
    resetDomainListenersForTests();
    hubHandlers.clear();
  });

  it('KNOWN_DOMAIN_EVENTS 含四类域事件', () => {
    expect(KNOWN_DOMAIN_EVENTS).toEqual([
      'todo://changed',
      'qbank://changed',
      'fsrs://changed',
      'dstu:change',
    ]);
  });

  it('多 handler 注册：同事件名只挂一次 hubListen，全部收到', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = registerDomainListener('todo://changed', a);
    const unsubB = registerDomainListener('todo://changed', b);

    expect(hubListen).toHaveBeenCalledTimes(1);
    expect(hubListen).toHaveBeenCalledWith('todo://changed', expect.any(Function));

    const payload = { source: 'agent', action: 'create', entityIds: ['i1'], runId: 'r1' };
    emitHub('todo://changed', payload);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject(payload);
    expect(b.mock.calls[0][0]).toMatchObject(payload);

    unsubA();
    emitHub('todo://changed', { source: 'user', action: 'toggle' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    unsubB();
    emitHub('todo://changed', { source: 'user', action: 'noop' });
    expect(b).toHaveBeenCalledTimes(2);
    // 最后一个退订后 hubListen 已拆除
    expect(hubHandlers.has('todo://changed')).toBe(false);
  });

  it('payload 透传：合法对象原样字段保留；非对象包装兜底', () => {
    const handler = vi.fn();
    registerDomainListener('qbank://changed', handler);

    emitHub('qbank://changed', {
      source: 'agent',
      action: 'upsert',
      entityIds: ['q1'],
      extra: 42,
    });
    expect(handler.mock.calls[0][0]).toEqual({
      source: 'agent',
      action: 'upsert',
      entityIds: ['q1'],
      extra: 42,
    });

    emitHub('qbank://changed', 'not-an-object');
    expect(handler.mock.calls[1][0]).toEqual({ source: 'user', action: 'unknown' });

    emitHub('qbank://changed', null);
    expect(handler.mock.calls[2][0]).toEqual({ source: 'user', action: 'unknown' });
  });

  it('normalizeDomainPayload：ai→agent；缺 action 补 unknown', () => {
    expect(normalizeDomainPayload({ source: 'ai', action: 'score' })).toEqual({
      source: 'agent',
      action: 'score',
    });
    expect(normalizeDomainPayload({ source: 'user' })).toEqual({
      source: 'user',
      action: 'unknown',
    });
  });

  it('R2-04：entity_ids / path / node → entityIds 命名一致', () => {
    expect(
      normalizeDomainPayload({
        source: 'ai',
        action: 'create',
        entity_ids: ['item-1', 'item-2'],
        run_id: 'run-9',
      }),
    ).toMatchObject({
      source: 'agent',
      action: 'create',
      entityIds: ['item-1', 'item-2'],
      runId: 'run-9',
    });

    expect(resourceIdFromDstuPath('/高考复习/函数/note_abc')).toBe('note_abc');
    expect(collectDomainEntityIds({ path: '/folder/note_xyz' })).toEqual(['note_xyz']);
    expect(
      collectDomainEntityIds({
        type: 'updated',
        path: '/a/b',
        node: { id: 'note_from_node' },
      }),
    ).toEqual(['note_from_node']);

    const fromPath = normalizeDomainPayload({
      source: 'agent',
      action: 'updated',
      path: '/高考复习/note_flash',
    });
    expect(fromPath.entityIds).toEqual(['note_flash']);
  });

  it('dstu:change 经 hubListen 广播；key extractor 兼容 resourceId/entityIds', () => {
    const handler = vi.fn();
    registerDomainListener('dstu:change', handler);
    expect(hubListen).toHaveBeenCalledWith('dstu:change', expect.any(Function));
    emitHub('dstu:change', { source: 'user', action: 'updated', resourceId: 'note-1' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user',
        action: 'updated',
        resourceId: 'note-1',
        entityIds: ['note-1'],
      }),
    );

    expect(isDstuKeyExtractorInstalledForTests()).toBe(true);
    expect(dstuChangeKeyExtractor({ resourceId: 'res-a' })).toBe('res-a');
    expect(dstuChangeKeyExtractor({ entityIds: ['e1', 'e2'] })).toBe('e1');
    expect(dstuChangeKeyExtractor({ id: 'fallback' })).toBe('fallback');
    expect(dstuChangeKeyExtractor({ path: '/x/note_path' })).toBe('note_path');
    expect(dstuChangeKeyExtractor(null)).toBeNull();
    // 模块加载时已安装；mockClear 后看 map 而非 call count
    expect(keyExtractors.get('dstu:change')).toBe(dstuChangeKeyExtractor);
  });

  it('环形缓冲：registerDomainListener 顺带记录；容量 5；多 handler 只记一条', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerDomainListener('fsrs://changed', a);
    registerDomainListener('fsrs://changed', b);

    for (let i = 0; i < 7; i++) {
      emitHub('fsrs://changed', { source: 'agent', action: `a${i}`, entityIds: [`c${i}`] });
    }

    const recent = getRecentDomainEventsForTests();
    expect(recent).toHaveLength(5);
    expect(recent.map((r) => r.payload.action)).toEqual(['a2', 'a3', 'a4', 'a5', 'a6']);
    expect(recent.every((r) => r.eventName === 'fsrs://changed')).toBe(true);
    // 7 次事件 × 2 handler 回调，但环只按事件记 7→5
    expect(a).toHaveBeenCalledTimes(7);
    expect(b).toHaveBeenCalledTimes(7);
  });

  it('recordDomainEvent 可直接写入环形缓冲', () => {
    recordDomainEvent('todo://changed', { source: 'user', action: 'manual' });
    const recent = getRecentDomainEventsForTests();
    expect(recent).toHaveLength(1);
    expect(recent[0].eventName).toBe('todo://changed');
    expect(recent[0].payload.action).toBe('manual');
  });

  it('recordAcrReceiptSummary：容量 5，供 DevPanel 最近回执', () => {
    for (let i = 0; i < 6; i++) {
      recordAcrReceiptSummary({
        runId: `run-${i}`,
        status: i % 2 === 0 ? 'completed' : 'partial',
        applied: i,
        totalOps: i + 1,
      });
    }
    const recent = getRecentReceiptSummariesForTests();
    expect(recent).toHaveLength(5);
    expect(recent.map((r) => r.runId)).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
    ]);
    expect(recent[4].status).toBe('partial');
  });
});
