/**
 * 布局快照持久化（主责 P1 → O11 打磨：分层保存 / 版本迁移 / 跨分辨率
 * 自适应恢复 / 恢复后逐帧唤醒调度）
 *
 * - saveSnapshot(layer)：分层防抖——'layout'（缺省）2s 尾随防抖（窗口几何等
 *   高频变更）；'meta' 10s 首次请求优先（Dock 固定区等低频元数据）。写入现有
 *   settings 存储（get_setting / save_setting invoke，非 Tauri 环境回退
 *   localStorage，与 utils/settingsApi 行为一致），key = 'desktop.workbenchSnapshot'；
 *   内容与上次落盘一致时跳过写盘（flushSnapshot 强制写）。
 * - loadSnapshot()：读取 + JSON 解析 + sanitize；任何坏数据 → null + console.warn，
 *   永不抛出（旧/损坏快照绝不导致白屏，设计文档 §10）。同时把快照记录的
 *   desktopSize 停放给 windowStore，供 hydrate 做多显示器/分辨率自适应。
 * - sanitizeSnapshot()：白名单剥离——只保留 WorkbenchSnapshotV1 声明的字段，
 *   lifecycle / launch payload / 未知注入字段一律丢弃（快照纯净性 P0 约束，§7）；
 *   version 缺失 / 未来版本走 best-effort 迁移（白名单天然向后安全），
 *   仅结构性坏数据整体拒绝。
 * - 逐帧唤醒（设计 §7）：模块加载即注册 post-hydrate 钩子，恢复后首帧只完整
 *   渲染焦点窗口，其余窗口逐帧提升 background→visible，最后交还 scheduler 收敛。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  DisplayMode,
  Frame,
  MaterialTier,
  WindowLifecycle,
  WorkbenchSnapshotV1,
  WorkbenchWindow,
} from './types';
import {
  registerPostHydrateHook,
  setPendingRestoreDesktopSize,
  useWindowStore,
} from './windowStore';
import { recomputeLifecycles } from './scheduler';

export const WORKBENCH_SNAPSHOT_KEY = 'desktop.workbenchSnapshot';
export const SNAPSHOT_SAVE_DEBOUNCE_MS = 2000;
/** O11：元数据层（Dock 固定区等低频变更）的保存间隔 */
export const SNAPSHOT_META_SAVE_DEBOUNCE_MS = 10_000;
export const WORKBENCH_SNAPSHOT_VERSION = 1;

/**
 * 保存分层：'layout' = 高频布局变更（窗口增删/几何/z 序），2s 尾随防抖；
 * 'meta' = 低频元数据（Dock 固定区/壁纸/材质档），10s 首次请求优先
 * （不被后续 meta 请求顺延；有 layout 排队时直接搭车）。
 */
export type SnapshotSaveLayer = 'layout' | 'meta';

const DISPLAY_MODES: ReadonlySet<DisplayMode> = new Set<DisplayMode>([
  'floating',
  'maximized',
  'tiled-left',
  'tiled-right',
  'tiled-tl',
  'tiled-tr',
  'tiled-bl',
  'tiled-br',
]);

const MATERIAL_TIERS: ReadonlySet<MaterialTier> = new Set<MaterialTier>([
  'full',
  'reduced',
  'minimal',
]);

// ---------------------------------------------------------------------------
// settings 存储适配（与 utils/settingsApi 同一后端命令；本地实现避免拖入
// 该文件的重量级传递依赖）
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

async function readSetting(key: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  }
  return await invoke<string | null>('get_setting', { key });
}

async function writeSetting(key: string, value: string): Promise<void> {
  if (!isTauriRuntime()) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    return;
  }
  await invoke<void>('save_setting', { key, value });
}

// ---------------------------------------------------------------------------
// sanitizer（白名单剥离 + 校验）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeFrame(value: unknown): Frame | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
    return null;
  }
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** 单窗白名单：字段级校验失败可兜底的兜底，结构性失败（id/typeId/frame 坏）返回 null 丢弃 */
function sanitizeWindow(value: unknown): WorkbenchWindow | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.typeId !== 'string' || value.typeId.length === 0) return null;
  const frame = sanitizeFrame(value.frame);
  if (!frame) return null;

  return {
    id: value.id,
    typeId: value.typeId,
    instanceKey: typeof value.instanceKey === 'string' ? value.instanceKey : null,
    title: typeof value.title === 'string' ? value.title : '',
    frame,
    restoreFrame: sanitizeFrame(value.restoreFrame),
    displayMode: DISPLAY_MODES.has(value.displayMode as DisplayMode)
      ? (value.displayMode as DisplayMode)
      : 'floating',
    minimized: value.minimized === true,
    zIndex: isFiniteNumber(value.zIndex) ? value.zIndex : 0,
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : 0,
    lastFocusedAt: isFiniteNumber(value.lastFocusedAt) ? value.lastFocusedAt : 0,
  };
}

/**
 * 版本迁移（O11）：把历史 / 未来版本的快照对象规整成当前 v1 形状。
 * - version === 1：原样通过；
 * - version 缺失但形状可用（windows 是数组）：视为 v1 容错解析 + warn
 *   （极旧数据 / 手工恢复的备份）；
 * - version 为大于当前的整数（应用降级场景）：best-effort 按 v1 白名单解析 + warn
 *   ——白名单 sanitizer 会剥掉一切未知字段、丢掉坏窗口记录，最坏恢复出
 *   部分窗口，也远好于整份布局清零；
 * - 其余（version 非法且形状不可用）→ null 整体拒绝。
 *
 * 未来出现真正的 v2 时，在此函数内加显式字段迁移分支。
 */
function migrateSnapshotShape(input: Record<string, unknown>): Record<string, unknown> | null {
  const version = input.version;
  if (version === WORKBENCH_SNAPSHOT_VERSION) return input;
  const shapeUsable = Array.isArray(input.windows);
  if (version === undefined && shapeUsable) {
    console.warn('[workbench] snapshot missing version, parsing as v1 (best effort)');
    return { ...input, version: WORKBENCH_SNAPSHOT_VERSION };
  }
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > WORKBENCH_SNAPSHOT_VERSION &&
    shapeUsable
  ) {
    console.warn(
      '[workbench] snapshot from newer version, best-effort whitelist migration:',
      version,
    );
    return { ...input, version: WORKBENCH_SNAPSHOT_VERSION };
  }
  return null;
}

/**
 * 快照校验 + 白名单剥离。结构性坏数据（非对象 / version 无法迁移 / windows 非数组）
 * → null + console.warn；单条坏窗口记录丢弃但不拖垮整体。
 */
export function sanitizeSnapshot(input: unknown): WorkbenchSnapshotV1 | null {
  if (!isRecord(input)) {
    console.warn('[workbench] snapshot rejected: not an object');
    return null;
  }
  const source = migrateSnapshotShape(input);
  if (!source) {
    console.warn('[workbench] snapshot rejected: unsupported version', input.version);
    return null;
  }
  if (!Array.isArray(source.windows)) {
    console.warn('[workbench] snapshot rejected: windows is not an array');
    return null;
  }

  const windows: WorkbenchWindow[] = [];
  const seenIds = new Set<string>();
  for (const raw of source.windows) {
    const win = sanitizeWindow(raw);
    if (!win) {
      console.warn('[workbench] snapshot window dropped: invalid record');
      continue;
    }
    if (seenIds.has(win.id)) {
      console.warn('[workbench] snapshot window dropped: duplicate id', win.id);
      continue;
    }
    seenIds.add(win.id);
    windows.push(win);
  }

  const dockPinned = Array.isArray(source.dockPinned)
    ? source.dockPinned.filter((item): item is string => typeof item === 'string')
    : [];

  const tilingRatios: Record<string, number> = {};
  if (isRecord(source.tilingRatios)) {
    for (const [key, ratio] of Object.entries(source.tilingRatios)) {
      if (isFiniteNumber(ratio) && ratio > 0 && ratio < 1) tilingRatios[key] = ratio;
    }
  }

  const snapshot: WorkbenchSnapshotV1 = { version: 1, windows, dockPinned, tilingRatios };

  if (
    isRecord(source.wallpaper) &&
    (source.wallpaper.kind === 'theme' || source.wallpaper.kind === 'image') &&
    typeof source.wallpaper.value === 'string'
  ) {
    snapshot.wallpaper = { kind: source.wallpaper.kind, value: source.wallpaper.value };
  }
  if (MATERIAL_TIERS.has(source.materialTier as MaterialTier)) {
    snapshot.materialTier = source.materialTier as MaterialTier;
  }
  // O11：快照保存时的桌面尺寸（恢复自适应用）；坏值直接丢弃该字段
  if (isRecord(source.desktopSize)) {
    const { w, h } = source.desktopSize;
    if (isFiniteNumber(w) && isFiniteNumber(h) && w > 0 && h > 0) {
      snapshot.desktopSize = { w, h };
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// 快照采集与持久化
// ---------------------------------------------------------------------------

type DockPinnedProvider = () => string[];

let dockPinnedProvider: DockPinnedProvider | null = null;

/** Dock（P5）/ 接线（P11）注册固定应用列表来源；传 null 注销 */
export function registerDockPinnedProvider(provider: DockPinnedProvider | null): void {
  dockPinnedProvider = provider;
}

/** 只提取 WorkbenchWindow 白名单壳字段（lifecycle / payload 天然不在其中） */
function pickShellFields(win: WorkbenchWindow): WorkbenchWindow {
  return {
    id: win.id,
    typeId: win.typeId,
    instanceKey: win.instanceKey,
    title: win.title,
    frame: { ...win.frame },
    restoreFrame: win.restoreFrame ? { ...win.restoreFrame } : null,
    displayMode: win.displayMode,
    minimized: win.minimized,
    zIndex: win.zIndex,
    createdAt: win.createdAt,
    lastFocusedAt: win.lastFocusedAt,
  };
}

/** 从当前 store 状态构建快照（纯采集，不写盘） */
export function buildSnapshot(): WorkbenchSnapshotV1 {
  const state = useWindowStore.getState();
  const windows = Object.values(state.windows)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map(pickShellFields);
  return {
    version: 1,
    windows,
    dockPinned: dockPinnedProvider ? [...dockPinnedProvider()] : [],
    tilingRatios: { ...state.tilingRatios },
    // O11：记录保存时的桌面尺寸，恢复时按比例自适应（多显示器/分辨率变化）
    desktopSize: { ...state.desktopSize },
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLayer: SnapshotSaveLayer | null = null;
/** 上次成功落盘的序列化内容；防抖保存内容未变时跳过写盘（IO 去重） */
let lastPersistedPayload: string | null = null;

async function persistNow(force: boolean): Promise<void> {
  try {
    // 双保险：采集结果再过一次 sanitizer，确保落盘永远是纯净白名单数据
    const snapshot = sanitizeSnapshot(buildSnapshot());
    if (!snapshot) return;
    const payload = JSON.stringify(snapshot);
    if (!force && payload === lastPersistedPayload) return;
    await writeSetting(WORKBENCH_SNAPSHOT_KEY, payload);
    lastPersistedPayload = payload;
    // P11 接线：通知 DevPanel（P10）快照保存时间
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('workbench:snapshot-saved', { detail: { at: Date.now() } }),
        );
      } catch {
        /* 非浏览器环境忽略 */
      }
    }
  } catch (error) {
    console.warn('[workbench] snapshot save failed:', error);
  }
}

/**
 * 请求保存快照（分层防抖）：
 * - 'layout'（缺省）：2s 尾随防抖，窗口拖动提交、增删、平铺比例变化等高频布局变更；
 * - 'meta'：10s 首次请求优先，Dock 固定区 / 壁纸 / 材质档等低频元数据
 *   （持续的 meta 请求不会无限顺延写盘；已有 layout 排队时元数据直接搭车）。
 *
 * 两层写的都是同一份完整快照，分层只决定落盘时机。
 */
export function saveSnapshot(layer: SnapshotSaveLayer = 'layout'): void {
  if (layer === 'meta' && pendingLayer !== null) return; // 已有排队保存，搭车
  if (saveTimer) clearTimeout(saveTimer);
  pendingLayer = layer;
  const delay = layer === 'layout' ? SNAPSHOT_SAVE_DEBOUNCE_MS : SNAPSHOT_META_SAVE_DEBOUNCE_MS;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pendingLayer = null;
    void persistNow(false);
  }, delay);
}

/** 立即落盘（应用退出前 / 模式关闭前 / 测试）；跳过内容去重，强制写 */
export async function flushSnapshot(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingLayer = null;
  await persistNow(true);
}

/**
 * 读取并校验快照；任何失败（IO / 坏 JSON / 校验不过）→ null + warn，绝不抛出。
 * 成功时把快照记录的 desktopSize 停放给 windowStore，随后的 hydrate 据此
 * 做窗口位置的比例缩放自适应（无该字段的旧快照 → 仅钳制兜底）。
 */
export async function loadSnapshot(): Promise<WorkbenchSnapshotV1 | null> {
  let raw: string | null = null;
  try {
    raw = await readSetting(WORKBENCH_SNAPSHOT_KEY);
  } catch (error) {
    console.warn('[workbench] snapshot read failed:', error);
    return null;
  }
  if (raw == null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[workbench] snapshot JSON parse failed:', error);
    return null;
  }
  const snapshot = sanitizeSnapshot(parsed);
  setPendingRestoreDesktopSize(snapshot?.desktopSize ?? null);
  return snapshot;
}

// ---------------------------------------------------------------------------
// O11：恢复后的逐帧唤醒调度（设计 §7「首帧只完整渲染焦点窗口，其余逐帧唤醒」）
// ---------------------------------------------------------------------------
//
// hydrate 已把初始 lifecycles 标为「栈顶 focused、其余 background」——首帧只有
// 焦点窗口挂载完整内容。本调度器随后每帧把一个窗口提升 background→visible
// （z 序高的先醒，用户先看到最上层），全部提升后调 recomputeLifecycles() 让
// scheduler 的遮挡/预算真值收敛（被完全遮挡者回落 background、超预算者冻结）。
//
// 让位规则：任何窗口集合变化（用户开/关窗、新一轮 hydrate、测试 reset）都会
// 使本轮唤醒立即中止——此时 scheduler 自身的订阅重算会接管档位，不会留下
// 卡在 background 的窗口。

/** 每帧提升的窗口数（保守 1：一帧一窗，10 窗恢复约 160ms 内全部唤醒） */
export const STAGED_WAKE_WINDOWS_PER_FRAME = 1;

function scheduleWakeFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => cb());
  } else {
    setTimeout(cb, 16);
  }
}

let wakeGeneration = 0;

function runStagedWake(): void {
  const generation = ++wakeGeneration;
  const startState = useWindowStore.getState();
  const windowsRef = startState.windows;
  const ids = Object.keys(windowsRef);
  // 0/1 窗无可分帧唤醒的对象：直接收敛真值
  if (ids.length <= 1) {
    recomputeLifecycles();
    return;
  }

  const promoted = new Set<string>();

  const step = (): void => {
    if (generation !== wakeGeneration) return; // 新一轮 hydrate 接管
    const state = useWindowStore.getState();
    if (state.windows !== windowsRef) return; // 窗口集合已变化 → scheduler 接管

    // 非最小化、非栈顶的窗口按 z 序从高到低逐帧唤醒（最上层先醒）
    const order = [...state.focusStack].reverse();
    const topId = order[0];
    const targets = order.filter((id) => id !== topId);
    let promotedThisFrame = 0;
    for (const id of targets) {
      if (promotedThisFrame >= STAGED_WAKE_WINDOWS_PER_FRAME) break;
      if (!promoted.has(id)) {
        promoted.add(id);
        promotedThisFrame += 1;
      }
    }

    const next: Record<string, WindowLifecycle> = {};
    for (const [id, win] of Object.entries(state.windows)) {
      if (win.minimized) next[id] = 'background';
      else if (id === topId) next[id] = 'focused';
      else next[id] = promoted.has(id) ? 'visible' : 'background';
    }
    state.setLifecycles(next);

    if (targets.every((id) => promoted.has(id))) {
      // 全部唤醒完毕：交还 scheduler 真值（遮挡回落 / 预算冻结）
      recomputeLifecycles();
      return;
    }
    scheduleWakeFrame(step);
  };

  scheduleWakeFrame(step);
}

// 模块加载即接线：WorkbenchDesktop 的 loadSnapshot→hydrate 链路自动获得
// 逐帧唤醒；纯 windowStore 单测（不 import 本模块）不受影响（优雅降级为
// scheduler 下一帧全量重算）。
registerPostHydrateHook(runStagedWake);
