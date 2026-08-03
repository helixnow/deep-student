/**
 * 遮挡计算（主责 P1；O10 增量化升级）
 *
 * 全量语义不变（`computeOcclusion`，签名冻结）：自顶向下按 zIndex 累计上层窗口
 * 矩形并集，判定每个窗口是否被【完全】遮挡（true = 完全遮挡 / 无可见面积；
 * 部分可见 = false）。
 *
 * O10 新增：
 * - `computeOcclusionDetail`：额外产出 visibleRatio（可见面积 / 窗口有效渲染
 *   面积，同时计入桌面裁剪与上层覆盖），供 scheduler 的 visible 细分档
 *   （完全可见 vs 部分可见）。
 * - `createOcclusionCache` + `computeOcclusionIncremental`：增量重算。缓存上
 *   一轮每窗的有效矩形 / zIndex / 结果；本轮只重算「自身变化的窗口 + 与任一
 *   变化窗口新旧矩形相交、且层序可能受其影响的窗口」，其余复用缓存。
 *   正确性依据：某窗口的遮挡结果是「自身有效矩形 + 所有上层有效矩形」的纯
 *   函数；一个未变化的窗口若与所有变化窗口的新旧矩形都不相交（或层序上
 *   从未被其覆盖过），其覆盖集减法结果逐块不变。
 * - 桌面尺寸 / margin 变化（影响全部 tiled/maximized 派生矩形）→ 退化为全量。
 *
 * 误判取向保持设计文档 §11：宁可 visible 不可错杀——所有矩形先裁剪到桌面
 * 可视区，完全移出桌面的窗口视为无可见面积。
 */
import type { Frame, Size, WorkbenchWindow } from './types';
import { computeTiledFrame } from './tiling';

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function toRect(frame: Frame): Rect {
  return { x1: frame.x, y1: frame.y, x2: frame.x + frame.w, y2: frame.y + frame.h };
}

function isEmpty(rect: Rect): boolean {
  return rect.x2 <= rect.x1 || rect.y2 <= rect.y1;
}

function area(rect: Rect): number {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function rectEquals(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}

/** 相交裁剪；无交集返回 null */
function clip(rect: Rect, bounds: Rect): Rect | null {
  const out: Rect = {
    x1: Math.max(rect.x1, bounds.x1),
    y1: Math.max(rect.y1, bounds.y1),
    x2: Math.min(rect.x2, bounds.x2),
    y2: Math.min(rect.y2, bounds.y2),
  };
  return isEmpty(out) ? null : out;
}

/** target 减去 cover，返回 0–4 个互不重叠的剩余矩形 */
function subtract(target: Rect, cover: Rect): Rect[] {
  const inter = clip(cover, target);
  if (!inter) return [target];
  const out: Rect[] = [];
  // 上条
  if (inter.y1 > target.y1) out.push({ x1: target.x1, y1: target.y1, x2: target.x2, y2: inter.y1 });
  // 下条
  if (inter.y2 < target.y2) out.push({ x1: target.x1, y1: inter.y2, x2: target.x2, y2: target.y2 });
  // 左条
  if (inter.x1 > target.x1) out.push({ x1: target.x1, y1: inter.y1, x2: inter.x1, y2: inter.y2 });
  // 右条
  if (inter.x2 < target.x2) out.push({ x1: inter.x2, y1: inter.y1, x2: target.x2, y2: inter.y2 });
  return out;
}

/** 窗口的实际渲染矩形：tiled/maximized 由平铺几何派生，floating 用自身 frame */
function effectiveRect(win: WorkbenchWindow, desktopSize: Size, margin: number): Rect {
  if (win.displayMode !== 'floating') {
    const tiled = computeTiledFrame(win.displayMode, { desktopSize, margin });
    if (tiled) return toRect(tiled);
  }
  return toRect(win.frame);
}

// ============================================================================
// O10：遮挡明细（occluded + visibleRatio）
// ============================================================================

export interface OcclusionEntry {
  /** true = 完全被遮挡 / 无可见面积 */
  occluded: boolean;
  /** 可见面积 / 有效渲染面积（未裁剪），0–1；minimized / 完全离屏 = 0 */
  visibleRatio: number;
}

/** minimized / 完全不可见窗口共享的常量条目（引用稳定，便于 diff） */
const HIDDEN_ENTRY: OcclusionEntry = Object.freeze({ occluded: true, visibleRatio: 0 });

export interface OcclusionStats {
  mode: 'full' | 'incremental';
  /** 本轮实际执行矩形减法重算的窗口数（minimized / 复用缓存的不计） */
  dirtyCount: number;
  windowCount: number;
}

interface StackItem {
  id: string;
  zIndex: number;
  /** 裁剪到桌面后的矩形；null = 完全离屏 */
  rect: Rect | null;
  /** 未裁剪的有效渲染面积（visibleRatio 分母） */
  rawArea: number;
}

interface CachedWindow {
  zIndex: number;
  minimized: boolean;
  rect: Rect | null;
  /** 未裁剪面积：裁剪后矩形相同但越界程度不同时 visibleRatio 仍会变 */
  rawArea: number;
  entry: OcclusionEntry;
}

export interface OcclusionCache {
  /** `${w}x${h}@${margin}`；变化 → 全量重算 */
  desktopKey: string | null;
  wins: Map<string, CachedWindow>;
  lastStats: OcclusionStats | null;
}

export function createOcclusionCache(): OcclusionCache {
  return { desktopKey: null, wins: new Map(), lastStats: null };
}

export function getLastOcclusionStats(cache: OcclusionCache): OcclusionStats | null {
  return cache.lastStats;
}

function buildStack(
  windows: WorkbenchWindow[],
  desktopSize: Size,
  margin: number,
): { stacked: StackItem[]; minimizedIds: string[] } {
  const bounds: Rect = { x1: 0, y1: 0, x2: desktopSize.w, y2: desktopSize.h };
  const stacked: StackItem[] = [];
  const minimizedIds: string[] = [];
  for (const win of windows) {
    if (win.minimized) {
      minimizedIds.push(win.id);
      continue;
    }
    const raw = effectiveRect(win, desktopSize, margin);
    stacked.push({
      id: win.id,
      zIndex: win.zIndex,
      rect: clip(raw, bounds),
      rawArea: area(raw),
    });
  }
  // 自顶向下（zIndex 降序）
  stacked.sort((a, b) => b.zIndex - a.zIndex);
  return { stacked, minimizedIds };
}

/** 对 stacked[index] 做完整的上层矩形减法，得出遮挡明细 */
function solveOne(stacked: StackItem[], index: number): OcclusionEntry {
  const item = stacked[index];
  if (!item.rect || item.rawArea <= 0) return HIDDEN_ENTRY;
  let remaining: Rect[] = [item.rect];
  for (let j = 0; j < index && remaining.length > 0; j++) {
    const cover = stacked[j].rect;
    if (!cover) continue;
    const next: Rect[] = [];
    for (const piece of remaining) next.push(...subtract(piece, cover));
    remaining = next;
  }
  if (remaining.length === 0) return HIDDEN_ENTRY;
  let visible = 0;
  for (const piece of remaining) visible += area(piece);
  return { occluded: false, visibleRatio: Math.min(1, visible / item.rawArea) };
}

/**
 * 求解 stacked 中窗口的遮挡明细。
 * dirty 为 null 时全量重算；否则仅重算 dirty 中的窗口，其余复用 prev 缓存。
 * 返回明细与实际重算数量。
 */
function solveEntries(
  stacked: StackItem[],
  dirty: ReadonlySet<string> | null,
  prev: Map<string, CachedWindow>,
): { entries: Map<string, OcclusionEntry>; solvedCount: number } {
  const entries = new Map<string, OcclusionEntry>();
  let solvedCount = 0;
  for (let i = 0; i < stacked.length; i++) {
    const item = stacked[i];
    if (dirty && !dirty.has(item.id)) {
      const cached = prev.get(item.id);
      if (cached && !cached.minimized) {
        entries.set(item.id, cached.entry);
        continue;
      }
      // 缓存缺失兜底（理论上 diff 已覆盖）：按脏处理
    }
    entries.set(item.id, solveOne(stacked, i));
    solvedCount += 1;
  }
  return { entries, solvedCount };
}

/**
 * 全量遮挡明细（无状态版）：windowId -> { occluded, visibleRatio }。
 * minimized / 完全离屏 = { occluded: true, visibleRatio: 0 }。
 */
export function computeOcclusionDetail(
  windows: WorkbenchWindow[],
  desktopSize: Size,
  margin = 0,
): Record<string, OcclusionEntry> {
  const { stacked, minimizedIds } = buildStack(windows, desktopSize, margin);
  const { entries } = solveEntries(stacked, null, new Map());
  const result: Record<string, OcclusionEntry> = {};
  for (const [id, entry] of entries) result[id] = entry;
  for (const id of minimizedIds) result[id] = HIDDEN_ENTRY;
  return result;
}

/**
 * 桌面（壁纸）被窗口矩形并集覆盖的比例（0–1）。
 *
 * 供壁纸流动层「基本被遮即暂停」判定：桌面矩形依次减去各非 minimized
 * 窗口裁剪到可视区后的有效矩形，剩余面积即壁纸可见面积。并集减法与
 * 窗口顺序 / z 序无关；重叠区域不会重复计入。
 */
export function computeDesktopCoveredRatio(
  windows: WorkbenchWindow[],
  desktopSize: Size,
  margin = 0,
): number {
  const desktopArea = desktopSize.w * desktopSize.h;
  if (desktopArea <= 0) return 0;
  const bounds: Rect = { x1: 0, y1: 0, x2: desktopSize.w, y2: desktopSize.h };
  let remaining: Rect[] = [bounds];
  for (const win of windows) {
    if (win.minimized) continue;
    const cover = clip(effectiveRect(win, desktopSize, margin), bounds);
    if (!cover) continue;
    const next: Rect[] = [];
    for (const piece of remaining) next.push(...subtract(piece, cover));
    remaining = next;
    if (remaining.length === 0) return 1;
  }
  let visible = 0;
  for (const piece of remaining) visible += area(piece);
  return Math.min(1, Math.max(0, 1 - visible / desktopArea));
}

/**
 * 遮挡矩阵（签名冻结）：windowId -> 是否完全被遮挡（true = 无可见面积）。
 *
 * - minimized 窗口：本身记为 true（无可见面积），且不遮挡其他窗口；
 * - 完全移出桌面可视区的窗口记为 true；
 * - margin 为平铺间距（未接线前默认 0，与渲染层保持一致即可）。
 */
export function computeOcclusion(
  windows: WorkbenchWindow[],
  desktopSize: Size,
  margin = 0,
): Record<string, boolean> {
  const detail = computeOcclusionDetail(windows, desktopSize, margin);
  const result: Record<string, boolean> = {};
  for (const id of Object.keys(detail)) result[id] = detail[id].occluded;
  return result;
}

/**
 * 增量遮挡明细：与 `computeOcclusionDetail` 结果等价，但只重算受影响窗口。
 *
 * 脏窗口判定（保守但正确）：
 * 1. 自身变化：新增 / 移除 / minimized 切换 / zIndex 变化 / 有效矩形变化；
 * 2. 传播：现存窗口 w 的矩形与任一变化窗口 c 的旧矩形或新矩形相交，
 *    且 w 的层序低于 c 新旧 zIndex 的较大值（c 曾经或现在可能覆盖 w）。
 * 桌面尺寸 / margin 变化 → 全量重算（tiled/maximized 派生矩形全部失效）。
 *
 * 统计信息经 `getLastOcclusionStats(cache)` 读取（供 perfMonitor / 测试）。
 */
export function computeOcclusionIncremental(
  cache: OcclusionCache,
  windows: WorkbenchWindow[],
  desktopSize: Size,
  margin = 0,
): Record<string, OcclusionEntry> {
  const desktopKey = `${desktopSize.w}x${desktopSize.h}@${margin}`;
  const { stacked, minimizedIds } = buildStack(windows, desktopSize, margin);
  const fullRecompute = cache.desktopKey !== desktopKey;

  let dirty: Set<string> | null = null;
  if (!fullRecompute) {
    dirty = new Set<string>();
    interface RectChange {
      oldRect: Rect | null;
      newRect: Rect | null;
      /** 该变化可能影响的最高层序（低于此 zIndex 的窗口才可能受影响） */
      maxZ: number;
    }
    const changes: RectChange[] = [];
    const seen = new Set<string>();

    for (const item of stacked) {
      seen.add(item.id);
      const cached = cache.wins.get(item.id);
      if (!cached) {
        // 新增窗口（或缓存缺失）
        dirty.add(item.id);
        if (item.rect) changes.push({ oldRect: null, newRect: item.rect, maxZ: item.zIndex });
      } else if (
        cached.minimized ||
        cached.zIndex !== item.zIndex ||
        cached.rawArea !== item.rawArea ||
        !rectEquals(cached.rect, item.rect)
      ) {
        dirty.add(item.id);
        const oldRect = cached.minimized ? null : cached.rect;
        if (oldRect || item.rect) {
          changes.push({
            oldRect,
            newRect: item.rect,
            maxZ: Math.max(cached.minimized ? item.zIndex : cached.zIndex, item.zIndex),
          });
        }
      }
    }
    // 本轮 minimized 的窗口：结果恒为 HIDDEN，但若上一轮非 minimized，
    // 其旧矩形会释放对下层窗口的覆盖
    for (const id of minimizedIds) {
      seen.add(id);
      const cached = cache.wins.get(id);
      if (cached && !cached.minimized && cached.rect) {
        changes.push({ oldRect: cached.rect, newRect: null, maxZ: cached.zIndex });
      }
    }
    // 已移除的窗口：旧矩形释放覆盖
    for (const [id, cached] of cache.wins) {
      if (seen.has(id)) continue;
      if (!cached.minimized && cached.rect) {
        changes.push({ oldRect: cached.rect, newRect: null, maxZ: cached.zIndex });
      }
    }

    // 传播：与变化矩形相交且层序可能受其覆盖的现存窗口 → 脏
    if (changes.length > 0) {
      for (const item of stacked) {
        if (dirty.has(item.id) || !item.rect) continue;
        for (const change of changes) {
          if (item.zIndex >= change.maxZ) continue;
          if (
            (change.oldRect && intersects(item.rect, change.oldRect)) ||
            (change.newRect && intersects(item.rect, change.newRect))
          ) {
            dirty.add(item.id);
            break;
          }
        }
      }
    }
  }

  const { entries, solvedCount } = solveEntries(stacked, fullRecompute ? null : dirty, cache.wins);

  // 写回缓存 + 输出
  const result: Record<string, OcclusionEntry> = {};
  const nextWins = new Map<string, CachedWindow>();
  for (const item of stacked) {
    const entry = entries.get(item.id) ?? HIDDEN_ENTRY;
    nextWins.set(item.id, {
      zIndex: item.zIndex,
      minimized: false,
      rect: item.rect,
      rawArea: item.rawArea,
      entry,
    });
    result[item.id] = entry;
  }
  for (const id of minimizedIds) {
    nextWins.set(id, { zIndex: 0, minimized: true, rect: null, rawArea: 0, entry: HIDDEN_ENTRY });
    result[id] = HIDDEN_ENTRY;
  }
  cache.desktopKey = desktopKey;
  cache.wins = nextWins;
  cache.lastStats = {
    mode: fullRecompute ? 'full' : 'incremental',
    dirtyCount: solvedCount,
    windowCount: windows.length,
  };
  return result;
}
