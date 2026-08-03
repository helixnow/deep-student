/**
 * interactionTrace 单测 — 交互时间线环形缓冲 / mark / measure / 桥。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTION_TRACE_MAX_SESSIONS,
  beginInteraction,
  clearInteractionTrace,
  disableInteractionTrace,
  enableInteractionTrace,
  endInteraction,
  exportInteractionTraceJson,
  getActiveInteraction,
  getRecentInteractions,
  installInteractionTraceBridge,
  markInteraction,
  recordInteractionFreeze,
  resetInteractionTraceForTests,
  setInteractionTraceConsoleLog,
  subscribeInteractionTrace,
  timeInteractionPhase,
} from '../interactionTrace';

beforeEach(() => {
  resetInteractionTraceForTests();
  enableInteractionTrace();
  setInteractionTraceConsoleLog(false);
});

afterEach(() => {
  resetInteractionTraceForTests();
});

describe('interactionTrace', () => {
  it('begin → firstMove → end 产出 armToFirstMoveMs / totalMs', () => {
    const id = beginInteraction({ kind: 'drag', windowId: 'w1' });
    expect(id).toBeTruthy();
    expect(getActiveInteraction()?.kind).toBe('drag');

    markInteraction('firstMove');
    const ended = endInteraction();
    expect(ended).toBeTruthy();
    expect(ended!.measures.armToFirstMoveMs).toBeGreaterThanOrEqual(0);
    expect(ended!.measures.totalMs).toBeGreaterThanOrEqual(ended!.measures.armToFirstMoveMs!);
    expect(ended!.marks.arm).toBe(0);
    expect(ended!.marks.firstMove).toBeDefined();
    expect(ended!.marks.end).toBeDefined();
    expect(getActiveInteraction()).toBeNull();
    expect(getRecentInteractions()).toHaveLength(1);
  });

  it('同名 mark 只记首次', () => {
    beginInteraction({ kind: 'resize', windowId: 'w2' });
    markInteraction('firstMove');
    const first = getActiveInteraction()!.marks.firstMove;
    markInteraction('firstMove');
    expect(getActiveInteraction()!.marks.firstMove).toBe(first);
    endInteraction();
  });

  it('环形缓冲不超过上限', () => {
    for (let i = 0; i < INTERACTION_TRACE_MAX_SESSIONS + 5; i += 1) {
      beginInteraction({ kind: 'drag', windowId: `w${i}` });
      endInteraction();
    }
    expect(getRecentInteractions()).toHaveLength(INTERACTION_TRACE_MAX_SESSIONS);
  });

  it('disable 后 begin 返回 null', () => {
    disableInteractionTrace();
    expect(beginInteraction({ kind: 'drag' })).toBeNull();
  });

  it('subscribe 在 end 时收到快照', () => {
    const spy = vi.fn();
    const unsub = subscribeInteractionTrace(spy);
    beginInteraction({ kind: 'snap.settle', windowId: 'w3' });
    endInteraction({ cancelled: false });
    expect(spy).toHaveBeenCalled();
    const last = spy.mock.calls.at(-1)?.[0] as unknown[];
    expect(Array.isArray(last)).toBe(true);
    expect(last).toHaveLength(1);
    unsub();
  });

  it('timeInteractionPhase 写入 syncPhases；freeze 记入 costs', () => {
    beginInteraction({ kind: 'drag', windowId: 'w4' });
    timeInteractionPhase('layoutAnchor', () => {
      /* sync work */
    }, 'layoutAnchor');
    expect(getActiveInteraction()!.marks.layoutAnchor).toBeDefined();
    expect(getActiveInteraction()!.costs?.syncPhases.layoutAnchorMs).toBeGreaterThanOrEqual(0);

    recordInteractionFreeze({
      applied: true,
      reason: 'immediate-heavy',
      snapshotHit: false,
    });
    expect(getActiveInteraction()!.marks.contentFreeze).toBeDefined();
    expect(getActiveInteraction()!.costs?.freeze?.reason).toBe('immediate-heavy');

    const ended = endInteraction();
    expect(ended!.costs?.syncPhases.layoutAnchorMs).toBeDefined();
    expect(ended!.measures.armToFreezeMs).toBeGreaterThanOrEqual(0);
  });

  it('exportJson / clear / bridge 可用', () => {
    beginInteraction({ kind: 'drag' });
    markInteraction('firstMove');
    endInteraction();
    const json = exportInteractionTraceJson();
    const parsed = JSON.parse(json) as { sessions: unknown[]; schema?: string };
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.schema).toBe('interactionTrace.v2');

    const bridge = installInteractionTraceBridge();
    expect(bridge.getRecent()).toHaveLength(1);
    expect((globalThis as Record<string, unknown>).__WB_INTERACTION_TRACE__).toBe(bridge);

    clearInteractionTrace();
    expect(getRecentInteractions()).toHaveLength(0);
  });
});
