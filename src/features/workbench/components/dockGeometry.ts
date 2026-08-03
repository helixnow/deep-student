/**
 * dockGeometry（O5）— Dock 图标屏幕坐标 provider
 *
 * 协作接口（编排文档 §4）：Dock 渲染/布局变化时把每个 typeId 的图标
 * **视口坐标**（getBoundingClientRect 语义，px）发布到本模块；
 * O9（genie 最小化收敛点）、O5 自身（launch bounce 起点）等通过
 * get / subscribe 消费。O20 兜底接线时也可在此读取并注入
 * `--wb-minimize-origin-x/y` CSS 变量。
 *
 * 设计约束：
 * - 零 React / 零依赖，可被 core 层或任意组件消费而不引起循环依赖；
 * - 发布方测量的是图标 wrap（未被 magnification transform 污染的外层元素），
 *   因此坐标在放大动效进行中依然稳定；
 * - 引用稳定：仅当坐标发生 >0.5px 的实质变化时才更换快照并通知订阅者，
 *   可直接用于 useSyncExternalStore。
 */

export interface DockIconRect {
  /** 视口坐标（CSS px），同 getBoundingClientRect().left/top */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DockIconRectMap = Readonly<Record<string, DockIconRect>>;

const EPSILON = 0.5;

let snapshot: DockIconRectMap = {};
const listeners = new Set<() => void>();

function rectEquals(a: DockIconRect, b: DockIconRect): boolean {
  return (
    Math.abs(a.x - b.x) < EPSILON &&
    Math.abs(a.y - b.y) < EPSILON &&
    Math.abs(a.w - b.w) < EPSILON &&
    Math.abs(a.h - b.h) < EPSILON
  );
}

function mapEquals(a: DockIconRectMap, b: DockIconRectMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const rectB = b[key];
    if (!rectB || !rectEquals(a[key], rectB)) return false;
  }
  return true;
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** 单个应用图标的视口 rect；Dock 未挂载或该 typeId 不在 Dock 上时为 null */
export function getDockIconRect(typeId: string): DockIconRect | null {
  return snapshot[typeId] ?? null;
}

/** 单个应用图标的视口中心点（genie 收敛点常用） */
export function getDockIconCenter(typeId: string): { x: number; y: number } | null {
  const rect = snapshot[typeId];
  if (!rect) return null;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** 全量快照（引用稳定，可直接作 useSyncExternalStore 的 getSnapshot） */
export function getDockIconRects(): DockIconRectMap {
  return snapshot;
}

/** 订阅坐标变化（仅实质变化时触发） */
export function subscribeDockGeometry(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 发布方（Dock）整体替换坐标表。
 * 与上一快照逐项 epsilon 比较，无实质变化则不通知（防 rAF 抖动风暴）。
 */
export function publishDockIconRects(next: Record<string, DockIconRect>): void {
  if (mapEquals(snapshot, next)) return;
  snapshot = Object.freeze({ ...next });
  emit();
}

/** Dock 卸载时清空（消费方拿到 null 即回退默认收敛点） */
export function clearDockGeometry(): void {
  if (Object.keys(snapshot).length === 0) return;
  snapshot = {};
  emit();
}
