/**
 * ACR 4.0 A4 — AI 打字机滚动跟随单测：
 * computeFollowScrollTop 目标位置、节流状态机、用户滚动暂停与程序滚动区分。
 * 只测状态与计算，不测真实动画帧。
 */
import { describe, expect, it } from 'vitest';
import {
  AgentScrollFollower,
  computeFollowScrollTop,
} from '@/components/crepe/agentScrollFollow';

describe('computeFollowScrollTop', () => {
  const viewport = {
    viewportTop: 0,
    viewportBottom: 300,
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 300,
  };

  it('光标在可视区内（含边距）→ null 不滚动', () => {
    expect(
      computeFollowScrollTop({ ...viewport, caretTop: 150, caretBottom: 168 }),
    ).toBeNull();
  });

  it('光标越出下边界 → 对齐到视口 2/3 处（下三分之一分界）', () => {
    const next = computeFollowScrollTop({
      ...viewport,
      caretTop: 400,
      caretBottom: 418,
    });
    // anchorY = 0 + 300*2/3 = 200；delta = 400-200 = 200 → 100+200 = 300
    expect(next).toBe(300);
  });

  it('光标越出上边界 → 向上滚（同样对齐 2/3 分界）', () => {
    const next = computeFollowScrollTop({
      ...viewport,
      caretTop: -50,
      caretBottom: -32,
    });
    // delta = -50-200 = -250 → 100-250 = -150 → 夹到 0
    expect(next).toBe(0);
  });

  it('目标夹到最大可滚动位置', () => {
    const next = computeFollowScrollTop({
      ...viewport,
      scrollTop: 1650,
      caretTop: 500,
      caretBottom: 518,
    });
    // maxScrollTop = 2000-300 = 1700；1650+300 = 1950 → 夹到 1700
    expect(next).toBe(1700);
  });

  it('视口高度非法 → null', () => {
    expect(
      computeFollowScrollTop({
        ...viewport,
        viewportBottom: 0,
        caretTop: 500,
        caretBottom: 510,
      }),
    ).toBeNull();
  });
});

describe('AgentScrollFollower 节流与用户滚动暂停', () => {
  function makeFollower(opts?: { throttleMs?: number; userPauseMs?: number }) {
    let now = 10_000;
    const follower = new AgentScrollFollower({
      throttleMs: opts?.throttleMs ?? 500,
      userPauseMs: opts?.userPauseMs ?? 3000,
      now: () => now,
      prefersReducedMotion: () => false,
    });
    return {
      follower,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('节流：500ms 内至多一次程序滚动', () => {
    const { follower, advance } = makeFollower();
    expect(follower.beginFollow(true)).toBe(true);
    expect(follower.beginFollow(true)).toBe(false); // 立刻再来 → 被节流
    advance(499);
    expect(follower.beginFollow(true)).toBe(false);
    advance(1);
    expect(follower.beginFollow(true)).toBe(true);
  });

  it('用户手动滚动后 3 秒内暂停跟随，超时恢复', () => {
    const { follower, advance } = makeFollower();
    follower.handleScrollEvent(); // 无程序滚动在途 → 认定为用户滚动
    expect(follower.isPausedByUser()).toBe(true);
    expect(follower.beginFollow(true)).toBe(false);
    advance(2999);
    expect(follower.beginFollow(true)).toBe(false);
    advance(1);
    expect(follower.isPausedByUser()).toBe(false);
    expect(follower.beginFollow(true)).toBe(true);
  });

  it('程序滚动保护窗内的 scroll 事件不算用户滚动', () => {
    const { follower, advance } = makeFollower();
    expect(follower.beginFollow(true)).toBe(true); // 置位程序滚动标志（smooth ~800ms 窗）
    advance(300);
    follower.handleScrollEvent(); // smooth 滚动产生的事件 → 忽略
    expect(follower.isPausedByUser()).toBe(false);

    advance(600); // 越过保护窗（300+600 > 800）
    follower.handleScrollEvent(); // 这次是真实用户滚动
    expect(follower.isPausedByUser()).toBe(true);
  });

  it('用户滚动中断连续跟随后，跟随保持静默直至暂停窗过期', () => {
    const { follower, advance } = makeFollower();
    expect(follower.beginFollow(true)).toBe(true);
    advance(1000); // 程序滚动保护窗已过
    follower.handleScrollEvent(); // 用户滚动
    advance(500);
    expect(follower.beginFollow(true)).toBe(false); // 暂停中
    advance(2500); // 用户滚动后共 3000ms
    expect(follower.beginFollow(true)).toBe(true);
  });
});

describe('AgentScrollFollower.followPos（jsdom DOM 胶水）', () => {
  function makeDom() {
    const viewport = document.createElement('div');
    viewport.className = 'scroll-area--native';
    const editor = document.createElement('div');
    viewport.appendChild(editor);
    document.body.appendChild(viewport);

    // jsdom 无布局：手工桩 rect / 滚动几何
    viewport.getBoundingClientRect = () =>
      ({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true });
    viewport.scrollTop = 0;
    const scrollToCalls: Array<{ top: number; behavior: string }> = [];
    (viewport as unknown as { scrollTo: (o: { top: number; behavior: string }) => void }).scrollTo =
      (o) => {
        scrollToCalls.push({ top: o.top, behavior: o.behavior });
        viewport.scrollTop = o.top;
      };
    return { viewport, editor, scrollToCalls };
  }

  function makeView(editor: HTMLElement, caretTop: number) {
    return {
      dom: editor,
      coordsAtPos: () => ({ left: 0, right: 2, top: caretTop, bottom: caretTop + 18 }),
    };
  }

  it('光标在视口外时滚动容器 scrollTo，且尊重 reduced-motion 用 auto', () => {
    const { viewport, editor, scrollToCalls } = makeDom();
    let now = 0;
    const follower = new AgentScrollFollower({
      now: () => now,
      prefersReducedMotion: () => true,
    });
    const moved = follower.followPos(makeView(editor, 500), 1);
    expect(moved).toBe(true);
    expect(scrollToCalls).toHaveLength(1);
    expect(scrollToCalls[0]!.behavior).toBe('auto'); // reduced-motion → 瞬滚
    expect(scrollToCalls[0]!.top).toBe(300); // 500 - 200(2/3 分界)

    // 节流：立即第二次不滚
    expect(follower.followPos(makeView(editor, 900), 1)).toBe(false);
    now += 600;
    expect(follower.followPos(makeView(editor, 900), 1)).toBe(true);
    follower.dispose();
    viewport.remove();
  });

  it('光标可见时不滚动；找不到滚动容器时安全 no-op', () => {
    const { viewport, editor } = makeDom();
    const follower = new AgentScrollFollower({ prefersReducedMotion: () => false });
    expect(follower.followPos(makeView(editor, 150), 1)).toBe(false);

    const orphan = document.createElement('div');
    expect(follower.followPos(makeView(orphan, 900), 1)).toBe(false);
    follower.dispose();
    viewport.remove();
  });

  it('绑定滚动监听：viewport 上的用户 scroll 事件触发暂停', () => {
    const { viewport, editor, scrollToCalls } = makeDom();
    let now = 0;
    const follower = new AgentScrollFollower({
      now: () => now,
      prefersReducedMotion: () => true,
    });
    expect(follower.followPos(makeView(editor, 500), 1)).toBe(true);
    expect(scrollToCalls).toHaveLength(1);

    now += 1000; // 越过程序滚动保护窗与节流
    viewport.dispatchEvent(new Event('scroll'));
    expect(follower.isPausedByUser()).toBe(true);
    expect(follower.followPos(makeView(editor, 900), 1)).toBe(false);

    now += 3000;
    expect(follower.followPos(makeView(editor, 900), 1)).toBe(true);
    follower.dispose();
    viewport.remove();
  });
});
