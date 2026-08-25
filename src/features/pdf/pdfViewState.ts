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
): void {
  if (!resourcePath || !storage) return;
  try {
    storage.setItem(pdfViewStateKey(resourcePath), JSON.stringify(normalizePdfViewState(state)));
  } catch {
    // 配额/隐私模式下静默失败：仅会话内生效
  }
}
