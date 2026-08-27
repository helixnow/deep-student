/**
 * 每文档 PDF 视图状态持久化（zoom / fitMode / viewMode / 封面偏移）。
 *
 * 落点选择：localStorage（key 按 DSTU resourcePath 区分），与本分支
 * EPUB 阅读器的排版状态（`epub-reader:<id>`）、PDF 暗色阅读偏好
 * （`pdf:darkReading`）同一持久层。不写 DSTU metadata 的原因：
 * dstu_set_metadata 对 textbook/file 是白名单落库（readingProgress.page /
 * bookmarks / highlights / favorite / title），任意自定义字段不会回读
 * （见 src-tauri/src/dstu/handlers.rs 与 node_converters.rs），写了也会
 * 在下次加载时静默丢失。
 *
 * ── 切文档时的继承语义（有意延续，2026-08 r4 注明）─────────────────
 * EnhancedPdfViewer 同一挂载实例切换文档（resourcePath 变化）时只应用
 * 新文档持久化状态中**存在**的字段：新文档从未保存过 zoomMode/viewMode
 * 时，沿用上一文档的当前缩放与单双页（coverOffset 例外，`?? false` 重置）。
 * 这是有意行为——用户为可读性调好的缩放在连续阅读多份文档时应延续，
 * 而不是每次切换都弹回默认；一旦用户在新文档里调整过，该文档即拥有
 * 自己的持久化状态，后续互不影响。
 * 若产品侧改为「切文档回默认」，请勿在 viewer 里散写重置逻辑：改为在
 * resourcePath 变化的 effect（EnhancedPdfViewer 约 693-710 行）里用本模块
 * `resolvePdfViewStateOnSwitch(defaults, persisted)` 一次性解析出全字段
 * 结果再 set，两种语义的差异就收敛在这一个纯函数上。本卡不改 viewer。
 *
 * ── localStorage GC ────────────────────────────────────────────────
 * key 无清理机制（文档删除/移动后旧 key 遗留），本模块提供
 * `sweepPdfViewStates`（按 savedAt 的 LRU 上限清扫，默认 200 条）。
 * 有意**不在模块 import 时自动扫全库**：全库遍历 O(storage.length)，
 * 应由调用方在低频时机（如打开阅读器、DSTU 删除回调）显式触发。
 */

import type { PdfFitMode } from './stores/pdfSettingsStore';

export interface PdfViewState {
  /** 缩放适配模式 */
  zoomMode?: PdfFitMode;
  /** 手动缩放倍率（仅 zoomMode === 'custom' 时有意义） */
  scale?: number;
  /** 单页 / 双页 */
  viewMode?: 'single' | 'dual';
  /** 双页模式下封面（第 1 页）单独成页 */
  coverOffset?: boolean;
}

const STORAGE_PREFIX = 'pdf-viewstate:';

/** 与 EnhancedPdfViewer 的 MIN_SCALE/MAX_SCALE 对齐 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 3.0;

const FIT_MODES: ReadonlySet<string> = new Set(['custom', 'fitWidth', 'fitPage', 'actualSize']);

export function pdfViewStateKey(resourcePath: string): string {
  return `${STORAGE_PREFIX}${resourcePath}`;
}

/** 解析并钳制持久化载荷；非法字段独立回退，不整体作废。 */
export function normalizePdfViewState(raw: unknown): PdfViewState {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const state: PdfViewState = {};

  if (typeof value.zoomMode === 'string' && FIT_MODES.has(value.zoomMode)) {
    state.zoomMode = value.zoomMode as PdfFitMode;
  }
  const scale = Number(value.scale);
  if (Number.isFinite(scale)) {
    state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100));
  }
  if (value.viewMode === 'single' || value.viewMode === 'dual') {
    state.viewMode = value.viewMode;
  }
  if (typeof value.coverOffset === 'boolean') {
    state.coverOffset = value.coverOffset;
  }
  return state;
}

export function loadPdfViewState(
  resourcePath: string | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : undefined,
): PdfViewState {
  if (!resourcePath || !storage) return {};
  try {
    const raw = storage.getItem(pdfViewStateKey(resourcePath));
    if (!raw) return {};
    return normalizePdfViewState(JSON.parse(raw));
  } catch {
    // JSON 损坏 / storage 不可用：回退默认视图
    return {};
  }
}

export function savePdfViewState(
  resourcePath: string | undefined,
  state: PdfViewState,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : undefined,
  now: number = Date.now(),
): void {
  if (!resourcePath || !storage) return;
  try {
    // savedAt 是存储层元数据（供 sweepPdfViewStates 做 LRU），不属于视图
    // 状态本身：normalizePdfViewState 在读取时会将其丢弃，不会泄漏给 viewer。
    const payload = { ...normalizePdfViewState(state), savedAt: now };
    storage.setItem(pdfViewStateKey(resourcePath), JSON.stringify(payload));
  } catch {
    // 配额/隐私模式下静默失败：仅会话内生效
  }
}

/**
 * 切文档（resourcePath 变化）时解析下一份视图状态：以 defaults 兜底、
 * persisted 中存在的字段覆盖，返回值每个字段都有确定语义——viewer 可以
 * 无条件应用全部字段，而不是只应用「存在的字段」（后者即当前的
 * 「延续上一文档视图」行为，见文件头注）。
 *
 * 本卡未在 EnhancedPdfViewer 接线：现行为（延续）被注明为有意；若改为
 * 「切文档回默认」，在 resourcePath 变化 effect 中用本函数替换逐字段
 * if 判断即可。
 */
export function resolvePdfViewStateOnSwitch(
  defaults: PdfViewState,
  persisted: PdfViewState,
): PdfViewState {
  return {
    zoomMode: persisted.zoomMode ?? defaults.zoomMode,
    scale: persisted.scale ?? defaults.scale,
    viewMode: persisted.viewMode ?? defaults.viewMode,
    coverOffset: persisted.coverOffset ?? defaults.coverOffset ?? false,
  };
}

/** 视图状态条目默认上限；超出后按 savedAt（最后写入时间）淘汰最旧的。 */
export const DEFAULT_PDF_VIEW_STATE_CAP = 200;

export interface SweepPdfViewStatesOptions {
  /** 保留的最大条目数（默认 {@link DEFAULT_PDF_VIEW_STATE_CAP}） */
  maxEntries?: number;
  /** 当前打开文档的 resourcePath：其条目永不淘汰 */
  keepResourcePath?: string;
  storage?: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>;
}

/**
 * 轻量 GC：清扫 `pdf-viewstate:` 前缀下超出上限的最旧条目（近似 LRU——
 * savedAt 是最后一次**写入**时间，纯只读的打开不会刷新它；损坏或缺
 * savedAt 的旧版载荷按最旧处理，优先淘汰）。
 *
 * 必须由调用方显式触发（建议：打开 PDF 阅读器时、或 DSTU 删除完成回调），
 * 模块 import 不会自动执行。返回实际删除的条目数。
 */
export function sweepPdfViewStates(options: SweepPdfViewStatesOptions = {}): number {
  const storage =
    options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!storage) return 0;
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_PDF_VIEW_STATE_CAP);
  const keepKey = options.keepResourcePath
    ? pdfViewStateKey(options.keepResourcePath)
    : undefined;

  // 先收集再删除：边遍历边 removeItem 会让 storage.key(i) 的索引失效
  const entries: { key: string; savedAt: number }[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX) || key === keepKey) continue;
      let savedAt = 0;
      try {
        const raw = storage.getItem(key);
        if (raw) {
          const ts = Number((JSON.parse(raw) as { savedAt?: unknown }).savedAt);
          if (Number.isFinite(ts) && ts > 0) savedAt = ts;
        }
      } catch {
        // 载荷损坏：savedAt 记 0，按最旧优先淘汰
      }
      entries.push({ key, savedAt });
    }
  } catch {
    return 0;
  }

  if (entries.length <= maxEntries) return 0;
  entries.sort((a, b) => a.savedAt - b.savedAt);
  let removed = 0;
  for (const entry of entries.slice(0, entries.length - maxEntries)) {
    try {
      storage.removeItem(entry.key);
      removed++;
    } catch {
      // 单条删除失败不阻断其余清扫
    }
  }
  return removed;
}
