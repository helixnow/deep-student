/**
 * handoffDescriptor（P3 · 0824 Wave2-B r5 handoff-1）— 双壳切换的焦点上下文交接
 *
 * 背景（docs/0824-quality-review/workbench-fg.md「接缝三」+
 * docs/dev/wave2-B-r1-anchor-workbench.md §4）：Finder 分桶与
 * currentView / Workbench 焦点窗两套状态使桌面壳↔经典壳只有「隔离」
 * 没有「交接」——legacyNavigationMap 只处理新的 launch/activate，
 * 不迁移已打开窗口的资源与内部路由。本模块按 wave2-B-r1-workbench-gap
 * §四-C 的裁决实现显式、可校验的最小交接结构：
 *
 *   { version: 1, appType, resourceId, innerRoute?, savedAt }
 *
 * 设计约束（不变量）：
 * - 独立 settings key（desktop.workbenchHandoff），绝不混入
 *   desktop.workbenchSnapshot —— 快照白名单纯净性（P0）不受影响；
 * - 双向共用同一 key，消费一次即清（consumeHandoffDescriptor 总是先删）；
 * - **不合并 Finder bucket**：跨壳连续性全部走本 descriptor，分桶隔离保留；
 * - parse/serialize 为纯函数（storage 可注入），逐字段 sanitize，
 *   坏载荷整体作废返回 null，不抛错。
 *
 * 角色分工（r5）：
 * - handoff-1（本模块 + legacyNavigationMap）：类型 / serialize / parse /
 *   焦点窗采集 / 存取；Workbench→经典壳的携带在 legacyNavigationMap 的
 *   handoffWorkbenchToLegacyShell。
 * - handoff-2（App.tsx 独占）：经典壳侧 consume（挂载时读取一次并清除、
 *   应用 innerRoute），以及反向（经典壳→Workbench）复用
 *   workbenchBus.launch({ typeId, instanceKey }) 打开同一资源。
 *   本模块不 import App、不派发任何新事件协议。
 */
import { useWindowStore } from './windowStore';
import {
  getResourceWorkspaceActive,
  type ResourceWorkspaceType,
} from '../apps/content/resourceWorkspaceRegistry';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 交接三元组（任务卡口径）：焦点应用 / 资源 / 应用内部路由 */
export interface WorkbenchHandoffContext {
  /** 焦点窗 typeId（appRegistry 口径，如 note / textbook / chat / exam） */
  appType: string;
  /** instanceKey，或单实例工作区（exam/essay/translation）的当前选中资源 */
  resourceId: string | null;
  /**
   * 应用内部路由，能取则取、取不到省略。自由格式短字符串，约定前缀：
   * `page:<n>`（阅读器页码）、`tab:<id>`（内部标签页）。消费方按前缀
   * 尽力恢复，无法识别时忽略——descriptor 缺 innerRoute 不影响资源级交接。
   */
  innerRoute?: string;
}

/** 持久化信封（wave2-B-r1-workbench-gap §四-C 裁决的完整形状） */
export interface WorkbenchHandoffDescriptor extends WorkbenchHandoffContext {
  version: typeof HANDOFF_DESCRIPTOR_VERSION;
  savedAt: number;
}

export const HANDOFF_DESCRIPTOR_VERSION = 1 as const;

/** 独立 settings key：与 desktop.workbenchSnapshot / workbenchMode 平级且互不混入 */
export const WORKBENCH_HANDOFF_STORAGE_KEY = 'desktop.workbenchHandoff';

/**
 * 消费时的默认新鲜度窗口：壳切换与消费之间隔着一次 React 卸载/挂载，
 * 正常在秒级完成；超过该窗口的 descriptor 视为陈旧残留（例如上次交接
 * 后消费方从未挂载），consume 时静默丢弃，避免旧上下文劫持本次导航。
 */
export const DEFAULT_HANDOFF_MAX_AGE_MS = 15 * 60_000;

const APP_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_INNER_ROUTE_LENGTH = 256;

/** 与 workbenchBus.ts RESOURCE_WORKSPACE_TYPE_IDS 同口径（instanceKey=null 的单实例工作区） */
const RESOURCE_WORKSPACE_TYPE_IDS: ReadonlySet<string> = new Set([
  'exam',
  'essay',
  'translation',
]);

type HandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): HandoffStorage | undefined {
  return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

// ---------------------------------------------------------------------------
// sanitize（纯函数；逐字段收敛，appType/savedAt 坏则整体作废）
// ---------------------------------------------------------------------------

function sanitizeAppType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return APP_TYPE_PATTERN.test(trimmed) ? trimmed : null;
}

function sanitizeResourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RESOURCE_ID_LENGTH) return null;
  return trimmed;
}

function sanitizeInnerRoute(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- 剥离控制字符是 sanitize 本意
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > MAX_INNER_ROUTE_LENGTH) return undefined;
  return cleaned;
}

/**
 * 由交接三元组构造持久化信封；appType 非法 → null（无 appType 的
 * descriptor 无消费意义）。resourceId/innerRoute 逐字段收敛不作废整体。
 */
export function buildHandoffDescriptor(
  context: WorkbenchHandoffContext,
  now: number = Date.now(),
): WorkbenchHandoffDescriptor | null {
  const appType = sanitizeAppType(context.appType);
  if (!appType) return null;
  const descriptor: WorkbenchHandoffDescriptor = {
    version: HANDOFF_DESCRIPTOR_VERSION,
    appType,
    resourceId: sanitizeResourceId(context.resourceId),
    savedAt: Number.isFinite(now) && now > 0 ? now : Date.now(),
  };
  const innerRoute = sanitizeInnerRoute(context.innerRoute);
  if (innerRoute !== undefined) descriptor.innerRoute = innerRoute;
  return descriptor;
}

/** 序列化为存储载荷；context 非法（appType 坏）→ null，不写半截 JSON。 */
export function serializeHandoffDescriptor(
  context: WorkbenchHandoffContext,
  now: number = Date.now(),
): string | null {
  const descriptor = buildHandoffDescriptor(context, now);
  if (!descriptor) return null;
  try {
    return JSON.stringify(descriptor);
  } catch {
    return null;
  }
}

/**
 * 解析未知载荷（字符串或对象）；任何结构性问题（版本不符 / appType 非法 /
 * savedAt 非正数）整体返回 null，绝不抛错。innerRoute 坏则按缺省省略。
 */
export function parseHandoffDescriptor(raw: unknown): WorkbenchHandoffDescriptor | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== HANDOFF_DESCRIPTOR_VERSION) return null;
  const appType = sanitizeAppType(record.appType);
  if (!appType) return null;
  const savedAt = Number(record.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  const descriptor: WorkbenchHandoffDescriptor = {
    version: HANDOFF_DESCRIPTOR_VERSION,
    appType,
    resourceId: sanitizeResourceId(record.resourceId),
    savedAt,
  };
  const innerRoute = sanitizeInnerRoute(record.innerRoute);
  if (innerRoute !== undefined) descriptor.innerRoute = innerRoute;
  return descriptor;
}

// ---------------------------------------------------------------------------
// innerRoute 提供者注册表（应用自愿提供 tab/page；未注册即省略）
// ---------------------------------------------------------------------------

/**
 * 应用侧 innerRoute 提供者：返回当前内部路由（如 `page:12` / `tab:abc`），
 * 返回 null/undefined 表示当下无可交接的内部路由。采集在壳切换热路径上
 * 同步调用，实现必须同步、轻量、不触发副作用。
 */
export type HandoffInnerRouteProvider = (
  instanceKey: string | null,
) => string | null | undefined;

const innerRouteProviders = new Map<string, HandoffInnerRouteProvider>();

/**
 * 注册某 typeId 的 innerRoute 提供者（同 typeId 后注册覆盖先注册；
 * 返回注销函数，仅当仍是自己时才删除，避免误删他人）。
 *
 * 本轮（r5 handoff-1）只建通道不接线：各应用（阅读器页码 / hub 标签等）
 * 的注册留给后续轮次在各自可写清单内完成；未注册时 descriptor 按约定
 * 省略 innerRoute，资源级交接不受影响。
 */
export function registerHandoffInnerRouteProvider(
  typeId: string,
  provider: HandoffInnerRouteProvider,
): () => void {
  innerRouteProviders.set(typeId, provider);
  return () => {
    if (innerRouteProviders.get(typeId) === provider) {
      innerRouteProviders.delete(typeId);
    }
  };
}

function readInnerRoute(typeId: string, instanceKey: string | null): string | undefined {
  const provider = innerRouteProviders.get(typeId);
  if (!provider) return undefined;
  try {
    return sanitizeInnerRoute(provider(instanceKey));
  } catch {
    // 提供者抛错按「无内部路由」处理：innerRoute 是尽力而为的增强字段
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 焦点窗采集
// ---------------------------------------------------------------------------

/**
 * 从 windowStore 当前焦点窗采集交接上下文：
 * - appType = 焦点窗 typeId，resourceId = instanceKey；
 * - instanceKey=null 的单实例工作区（exam/essay/translation）回落
 *   resourceWorkspaceRegistry.getResourceWorkspaceActive —— 补上评审
 *   缝一指出的「从 launcher 打开则连重建选中项的 payload 都没有」；
 * - innerRoute 经提供者注册表尽力获取，取不到省略。
 *
 * 无焦点窗（focusStack 空，全最小化/空桌面）→ null，调用方保持
 * 经典壳原有 currentView 不动。
 */
export function collectFocusHandoffDescriptor(
  now: number = Date.now(),
): WorkbenchHandoffDescriptor | null {
  const state = useWindowStore.getState();
  const focusId = state.focusStack[state.focusStack.length - 1];
  const win = focusId ? state.windows[focusId] : undefined;
  if (!win) return null;
  const resourceId =
    win.instanceKey
    ?? (RESOURCE_WORKSPACE_TYPE_IDS.has(win.typeId)
      ? getResourceWorkspaceActive(win.typeId as ResourceWorkspaceType)
      : null);
  return buildHandoffDescriptor(
    {
      appType: win.typeId,
      resourceId,
      innerRoute: readInnerRoute(win.typeId, win.instanceKey),
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// 存取（独立 key；消费一次即清）
// ---------------------------------------------------------------------------

/**
 * 持久化 descriptor（覆盖旧值——交接语义上后发生的切换胜出）。
 * 返回实际落盘的信封；context 非法或 storage 不可用/配额失败 → null
 * （静默：交接是尽力而为的增强，绝不阻塞壳切换本身）。
 */
export function saveHandoffDescriptor(
  context: WorkbenchHandoffContext,
  storage: HandoffStorage | undefined = defaultStorage(),
  now: number = Date.now(),
): WorkbenchHandoffDescriptor | null {
  const descriptor = buildHandoffDescriptor(context, now);
  if (!descriptor || !storage) return null;
  try {
    storage.setItem(WORKBENCH_HANDOFF_STORAGE_KEY, JSON.stringify(descriptor));
    return descriptor;
  } catch {
    return null;
  }
}

/** 只读窥视（不清除）；载荷缺失/损坏 → null。诊断与测试用，消费请走 consume。 */
export function peekHandoffDescriptor(
  storage: HandoffStorage | undefined = defaultStorage(),
): WorkbenchHandoffDescriptor | null {
  if (!storage) return null;
  try {
    return parseHandoffDescriptor(storage.getItem(WORKBENCH_HANDOFF_STORAGE_KEY));
  } catch {
    return null;
  }
}

export interface ConsumeHandoffOptions {
  /** 新鲜度窗口；传 Infinity 关闭陈旧判定。默认 {@link DEFAULT_HANDOFF_MAX_AGE_MS}。 */
  maxAgeMs?: number;
  now?: number;
  storage?: HandoffStorage;
}

/**
 * 消费一次即清：**无论载荷是否有效、是否陈旧，都先删除存储条目**，
 * 再决定返回值（有效且新鲜 → descriptor；否则 null）。这保证同一份
 * 交接绝不会被两个消费方（经典壳挂载 effect / Workbench 启动链路）
 * 各应用一次，也保证坏载荷不会永久滞留。
 */
export function consumeHandoffDescriptor(
  options: ConsumeHandoffOptions = {},
): WorkbenchHandoffDescriptor | null {
  const storage = options.storage ?? defaultStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(WORKBENCH_HANDOFF_STORAGE_KEY);
    storage.removeItem(WORKBENCH_HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
  const descriptor = parseHandoffDescriptor(raw);
  if (!descriptor) return null;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_HANDOFF_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  if (Number.isFinite(maxAgeMs) && now - descriptor.savedAt > maxAgeMs) return null;
  return descriptor;
}

/** 显式清除（放弃交接时用；storage 异常静默）。 */
export function clearHandoffDescriptor(
  storage: HandoffStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(WORKBENCH_HANDOFF_STORAGE_KEY);
  } catch {
    // 静默：清不掉的陈旧载荷由 consume 的新鲜度窗口兜底
  }
}
