/**
 * Exposé 重内容暂停（shellGestureFlags 追加导出）
 *
 * - begin 双 rAF 延后 flush（不与打开同栈）；end 恢复；
 * - rAF 未触发前 end → 不落任何 paused；
 * - 深度嵌套配对；与拖/缩手势旗互查：手势仍活跃时 end 不摘旗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginExposeHeavyContentPause,
  beginShellSettling,
  endExposeHeavyContentPause,
  endShellSettling,
  isExposeHeavyContentPaused,
  resetExposeHeavyContentPauseForTests,
  resetShellGestureFlagsForTests,
  WB_RENDER_PAUSED_ATTR,
} from '../shellGestureFlags';
import { resetSchedulerTransientsForTests } from '../scheduler';

let rafQueue: Array<() => void> = [];

/** 手动可控的 rAF：flush 一次 = 推进一帧 */
function flushRafFrame(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) cb();
}

function flushDoubleRaf(): void {
  flushRafFrame();
  flushRafFrame();
}

let host: HTMLElement;

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(() => cb(0));
    return rafQueue.length;
  });
  resetShellGestureFlagsForTests();
  resetExposeHeavyContentPauseForTests();
  resetSchedulerTransientsForTests();
  host = document.createElement('div');
  host.setAttribute('data-wb-content-host', '');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  resetShellGestureFlagsForTests();
  resetExposeHeavyContentPauseForTests();
  resetSchedulerTransientsForTests();
  vi.unstubAllGlobals();
});

describe('exposeHeavyContentPause', () => {
  it('begin 双 rAF 后 flush paused；end 恢复', () => {
    beginExposeHeavyContentPause();
    expect(isExposeHeavyContentPaused()).toBe(true);
    // 与起拖同规：不得与打开同栈 flush
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
    flushRafFrame();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
    flushRafFrame();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);

    endExposeHeavyContentPause();
    expect(isExposeHeavyContentPaused()).toBe(false);
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
  });

  it('rAF 未触发前 end：延后 flush 作废，不落 paused', () => {
    beginExposeHeavyContentPause();
    endExposeHeavyContentPause();
    flushDoubleRaf();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
    expect(isExposeHeavyContentPaused()).toBe(false);
  });

  it('深度嵌套：全部 end 后才恢复', () => {
    beginExposeHeavyContentPause();
    beginExposeHeavyContentPause();
    flushDoubleRaf();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);

    endExposeHeavyContentPause();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);
    endExposeHeavyContentPause();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
  });

  it('拖/缩手势仍活跃时 end 不摘旗，交由手势收尾统一恢复', () => {
    beginExposeHeavyContentPause();
    flushDoubleRaf();
    beginShellSettling();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);

    endExposeHeavyContentPause();
    // settle 仍在途 → paused 保持
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(true);

    endShellSettling();
    expect(host.hasAttribute(WB_RENDER_PAUSED_ATTR)).toBe(false);
  });
});
