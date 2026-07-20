/**
 * projection — 长活业务实例的声明式投射管理器（主责 P9）
 *
 * 设计文档 §4.4：project 语义——长活业务实例（运行中的番茄钟、后台制卡任务、
 * Agent 任务等）声明式投射：实例出现→自动出现窗口（或仅 Dock 角标）；
 * 实例消失→默认关窗（宿主可配 keepShell 保留壳）。
 *
 * 投射源（ProjectionSource）由宿主 feature 侧适配提供，本管理器负责：
 * - 订阅实例列表变化并做 diff；
 * - 出现 → `workbenchBus.project()`（幂等：已有窗则复用）；
 * - 消失 → 默认直接关窗（不走 canClose——业务实例已结束，无未保存语义）；
 * - workbench 未启用期间静默累积状态，启用后 `resyncProjections()` 补投。
 */
import type { Frame } from './types';
import { workbenchBus } from './workbenchBus';
import { useWindowStore } from './windowStore';

export interface ProjectionInstance {
  instanceKey: string;
  title: string;
  initialFrame?: Partial<Frame>;
}

export interface ProjectionSource {
  /**
   * 订阅实例列表变化。实现方应在订阅时立即用当前列表回调一次，
   * 之后每次实例集合变化时回调。返回取消订阅函数。
   */
  subscribe: (notify: (instances: ProjectionInstance[]) => void) => () => void;
  /** 实例消失时保留窗口壳（默认 false = 关窗） */
  keepShell?: boolean;
  /** false = 仅供 Dock 角标等消费，不投射窗口（默认 true） */
  projectWindows?: boolean;
}

interface SourceState {
  typeId: string;
  source: ProjectionSource;
  unsubscribe: (() => void) | null;
  /** 最近一次 notify 的实例集合（含 workbench 未启用期间） */
  current: Map<string, ProjectionInstance>;
}

const sources = new Map<string, SourceState>();

function closeProjectedWindow(typeId: string, instanceKey: string): void {
  const store = useWindowStore.getState();
  const win = Object.values(store.windows).find(
    (w) => w.typeId === typeId && w.instanceKey === instanceKey,
  );
  if (win) store.closeWindow(win.id);
}

function projectInstance(typeId: string, inst: ProjectionInstance): void {
  workbenchBus.project({
    typeId,
    instanceKey: inst.instanceKey,
    title: inst.title,
    initialFrame: inst.initialFrame,
  });
}

function applyInstances(state: SourceState, instances: ProjectionInstance[]): void {
  const next = new Map<string, ProjectionInstance>();
  for (const inst of instances) next.set(inst.instanceKey, inst);

  const wantWindows = state.source.projectWindows !== false;
  if (wantWindows && workbenchBus.isEnabled()) {
    for (const inst of next.values()) {
      if (!state.current.has(inst.instanceKey)) projectInstance(state.typeId, inst);
    }
    if (!state.source.keepShell) {
      for (const key of state.current.keys()) {
        if (!next.has(key)) closeProjectedWindow(state.typeId, key);
      }
    }
  }
  state.current = next;
}

/**
 * 注册投射源（每 typeId 一个；重复注册覆盖旧源并 warn）。
 * 返回注销函数：取消订阅并停止管理（已投射的窗口保留，由用户自行关闭）。
 */
export function registerProjectionSource(typeId: string, source: ProjectionSource): () => void {
  const existing = sources.get(typeId);
  if (existing) {
    console.warn(`[workbench:projection] source for "${typeId}" re-registered, replacing`);
    existing.unsubscribe?.();
    sources.delete(typeId);
  }
  const state: SourceState = { typeId, source, unsubscribe: null, current: new Map() };
  sources.set(typeId, state);
  state.unsubscribe = source.subscribe((instances) => applyInstances(state, instances));
  return () => {
    if (sources.get(typeId) !== state) return;
    state.unsubscribe?.();
    sources.delete(typeId);
  };
}

/**
 * workbench 开关打开（或快照恢复完成）后调用：
 * - 把各源当前存活的实例补投成窗口（project 幂等，已有窗不重复开）；
 * - 反向收口：禁用期间已结束的实例（快照里还挂着壳）默认关窗，
 *   否则启用后会残留「业务已结束的孤儿窗」（keepShell 源不收口）。
 */
export function resyncProjections(): void {
  if (!workbenchBus.isEnabled()) return;
  const store = useWindowStore.getState();
  for (const state of sources.values()) {
    if (state.source.projectWindows === false) continue;
    for (const inst of state.current.values()) projectInstance(state.typeId, inst);
    if (!state.source.keepShell) {
      for (const win of Object.values(store.windows)) {
        if (win.typeId !== state.typeId) continue;
        if (!win.instanceKey) continue;
        if (!state.current.has(win.instanceKey)) {
          closeProjectedWindow(state.typeId, win.instanceKey);
        }
      }
    }
  }
}

/** 诊断/测试用：某 typeId 当前被投射源声明存活的实例键列表 */
export function getProjectedInstances(typeId: string): string[] {
  const state = sources.get(typeId);
  return state ? Array.from(state.current.keys()) : [];
}

/** 测试/卸载用：注销全部投射源 */
export function resetProjections(): void {
  for (const state of sources.values()) state.unsubscribe?.();
  sources.clear();
}
