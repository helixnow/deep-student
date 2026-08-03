/**
 * ACR 4.0 A4：AI 打字机演出的温和滚动跟随。
 *
 * noteDriver 逐批 agentInsert 时，AI 光标可能落在编辑器可视区之外——
 * 长笔记里演出完全不可见。本模块在 crepe 层实现节流的滚动跟随：
 *
 * - 光标越出可视区（含边距）时，把光标滚到视口「下三分之一」分界处；
 * - 节流：默认两次程序滚动间隔 ≥500ms；
 * - 用户手动滚动后 3s 内暂停跟随（程序滚动用时间窗标志位区分，
 *   程序滚动前置位、窗口过期即复位，期间的 scroll 事件不算用户滚动）；
 * - prefers-reduced-motion: reduce → 瞬滚（behavior: 'auto'）。
 *
 * 纯计算部分（computeFollowScrollTop / 节流与用户滚动状态机）与 DOM 解耦，
 * 供 tests/vitest/notes/agentScrollFollow.test.ts 直接单测。
 */

/** 与 scrollSelectionIntoEditorViewport 一致的编辑器滚动容器选择器 */
export const AGENT_FOLLOW_VIEWPORT_SELECTOR =
  '[data-overlayscrollbars-viewport], .scroll-area--native';

/** 光标视为「可见」的上下边距（px） */
const VISIBLE_MARGIN = 24;

/** 程序滚动标志位的保护时长（ms）：smooth 滚动期间的 scroll 事件不算用户滚动 */
const PROGRAMMATIC_SMOOTH_MS = 800;
const PROGRAMMATIC_INSTANT_MS = 200;

export interface FollowScrollInput {
  /** 光标（AI caret）相对视口坐标 */
  caretTop: number;
  caretBottom: number;
  /** 滚动容器 getBoundingClientRect 的 top/bottom */
  viewportTop: number;
  viewportBottom: number;
  /** 滚动容器当前 scrollTop / scrollHeight / clientHeight */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 计算跟随滚动的目标 scrollTop。
 * 光标在可视区内（含边距）→ null（无需滚动）；
 * 否则把光标对齐到视口高度 2/3 处（下三分之一分界），并夹到可滚动范围。
 */
export function computeFollowScrollTop(input: FollowScrollInput): number | null {
  const height = input.viewportBottom - input.viewportTop;
  if (height <= 0) return null;

  const visibleTop = input.viewportTop + VISIBLE_MARGIN;
  const visibleBottom = input.viewportBottom - VISIBLE_MARGIN;
  const inside = input.caretTop >= visibleTop && input.caretBottom <= visibleBottom;
  if (inside) return null;

  // 目标：caretTop 落在视口 2/3 高度处
  const anchorY = input.viewportTop + (height * 2) / 3;
  const delta = input.caretTop - anchorY;
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
  const next = Math.max(0, Math.min(input.scrollTop + delta, maxScrollTop));
  return Math.abs(next - input.scrollTop) < 1 ? null : next;
}

export interface AgentScrollFollowerOptions {
  /** 两次程序滚动之间的最小间隔（ms），默认 500 */
  throttleMs?: number;
  /** 用户手动滚动后暂停跟随的时长（ms），默认 3000 */
  userPauseMs?: number;
  /** 时钟注入（测试用） */
  now?: () => number;
  /** reduced-motion 注入（测试用） */
  prefersReducedMotion?: () => boolean;
}

function defaultPrefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

type ViewLike = {
  dom: HTMLElement;
  coordsAtPos: (pos: number, side?: number) => {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

/**
 * 有状态的跟随器：节流 + 用户滚动暂停 + 程序滚动区分。
 * 每个 CrepeEditor 实例持有一个；dispose() 解绑滚动监听。
 */
export class AgentScrollFollower {
  private readonly throttleMs: number;
  private readonly userPauseMs: number;
  private readonly now: () => number;
  private readonly reducedMotion: () => boolean;

  private lastFollowAt = Number.NEGATIVE_INFINITY;
  private userScrolledAt = Number.NEGATIVE_INFINITY;
  /** 程序滚动保护窗截止时刻：窗内的 scroll 事件不算用户滚动 */
  private programmaticUntil = Number.NEGATIVE_INFINITY;

  private viewport: HTMLElement | null = null;
  private readonly onScroll = (): void => {
    this.handleScrollEvent();
  };

  constructor(options?: AgentScrollFollowerOptions) {
    this.throttleMs = options?.throttleMs ?? 500;
    this.userPauseMs = options?.userPauseMs ?? 3000;
    this.now = options?.now ?? Date.now;
    this.reducedMotion = options?.prefersReducedMotion ?? defaultPrefersReducedMotion;
  }

  /** scroll 事件入口（attach 后自动绑定；导出供单测直接驱动） */
  handleScrollEvent(): void {
    if (this.now() <= this.programmaticUntil) return; // 程序滚动，不计入
    this.userScrolledAt = this.now();
  }

  /** 用户手动滚动后 userPauseMs 内暂停跟随 */
  isPausedByUser(): boolean {
    return this.now() - this.userScrolledAt < this.userPauseMs;
  }

  /** 节流：距上次程序滚动不足 throttleMs 时跳过 */
  isThrottled(): boolean {
    return this.now() - this.lastFollowAt < this.throttleMs;
  }

  /**
   * 决策 + 记账（纯状态，无 DOM）：返回是否应执行本次跟随滚动。
   * 返回 true 时已置位程序滚动保护窗与节流时间戳。
   */
  beginFollow(smooth: boolean): boolean {
    if (this.isPausedByUser() || this.isThrottled()) return false;
    this.lastFollowAt = this.now();
    this.programmaticUntil =
      this.now() + (smooth ? PROGRAMMATIC_SMOOTH_MS : PROGRAMMATIC_INSTANT_MS);
    return true;
  }

  /** 绑定滚动容器的用户滚动监听（容器变化时自动换绑） */
  attach(viewport: HTMLElement): void {
    if (this.viewport === viewport) return;
    this.detach();
    this.viewport = viewport;
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
  }

  detach(): void {
    if (this.viewport) {
      this.viewport.removeEventListener('scroll', this.onScroll);
      this.viewport = null;
    }
  }

  dispose(): void {
    this.detach();
  }

  /**
   * DOM 胶水：把 ProseMirror 文档位置 pos 的光标温和滚入视口。
   * force=true 跳过节流与用户暂停（一次性 reveal，例如破坏类直改后的定位）。
   */
  followPos(view: ViewLike, pos: number, force = false): boolean {
    const viewport = view.dom.closest<HTMLElement>(AGENT_FOLLOW_VIEWPORT_SELECTOR);
    if (!viewport) return false;
    this.attach(viewport);

    const reduced = this.reducedMotion();
    const smooth = !reduced;

    if (!force) {
      if (this.isPausedByUser() || this.isThrottled()) return false;
    }

    let caret: { top: number; bottom: number };
    try {
      caret = view.coordsAtPos(Math.max(0, pos), 1);
    } catch {
      return false;
    }

    const bounds = viewport.getBoundingClientRect();
    const target = computeFollowScrollTop({
      caretTop: caret.top,
      caretBottom: caret.bottom,
      viewportTop: bounds.top,
      viewportBottom: bounds.bottom,
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
    if (target == null) return false;

    if (force) {
      this.lastFollowAt = this.now();
      this.programmaticUntil =
        this.now() + (smooth ? PROGRAMMATIC_SMOOTH_MS : PROGRAMMATIC_INSTANT_MS);
    } else if (!this.beginFollow(smooth)) {
      return false;
    }

    try {
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
      } else {
        viewport.scrollTop = target;
      }
    } catch {
      viewport.scrollTop = target;
    }
    return true;
  }
}
