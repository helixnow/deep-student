/**
 * ChatAnki 制卡块 — 模块级 UI 状态（以 blockId 为 key）。
 *
 * 消息列表虚拟滚动会卸载/重挂块组件，组件本地 state（展开态、
 * 编辑索引、未保存草稿、分页计数、多选集合）会被静默清空。
 * 这里用模块级 Map 保存这些轻量 UI 状态，重挂时恢复。
 *
 * 注意：仅存 UI 状态，不存卡片数据本身（卡片以 store/toolOutput 为准）。
 */

export interface AnkiCardEditDraft {
  /** 正在编辑的卡片 id（优先）；无 id 时回退 index */
  cardId?: string;
  index: number;
  fieldOrder: string[];
  values: Record<string, string>;
  tags: string;
}

export interface AnkiBlockUiState {
  isExpanded: boolean;
  layout: 'list' | 'grid';
  editingIndex: number;
  visibleCount: number;
  /** 多选集合（卡片 id） */
  selectedIds: string[];
  /** 未保存的编辑草稿（卸载时保留，回来恢复） */
  editDraft: AnkiCardEditDraft | null;
  /** 用户为本块选择的牌组名（保存/导出/同步共用） */
  deckName?: string;
}

const DEFAULT_STATE: AnkiBlockUiState = {
  isExpanded: false,
  layout: 'list',
  editingIndex: -1,
  visibleCount: 20,
  selectedIds: [],
  editDraft: null,
};

/** 简单容量上限：块非常多的长会话中避免 Map 无限增长（Map 迭代序=插入序，删最旧） */
const MAX_TRACKED_BLOCKS = 200;

const stateByBlockId = new Map<string, AnkiBlockUiState>();

export function getAnkiBlockUiState(blockId: string): AnkiBlockUiState {
  const existing = stateByBlockId.get(blockId);
  if (existing) return existing;
  return { ...DEFAULT_STATE, selectedIds: [] };
}

export function patchAnkiBlockUiState(
  blockId: string,
  patch: Partial<AnkiBlockUiState>,
): void {
  const current = stateByBlockId.get(blockId) ?? { ...DEFAULT_STATE, selectedIds: [] };
  // 删后重插保持 LRU 语义
  stateByBlockId.delete(blockId);
  stateByBlockId.set(blockId, { ...current, ...patch });
  if (stateByBlockId.size > MAX_TRACKED_BLOCKS) {
    const oldest = stateByBlockId.keys().next().value;
    if (oldest !== undefined) stateByBlockId.delete(oldest);
  }
}

/** 测试辅助：清空全部块级 UI 状态（避免用例间串状态） */
export function resetAnkiBlockUiState(): void {
  stateByBlockId.clear();
  lastDeckNameInput = null;
}

/** 会话级记忆：上一次用户输入的牌组名（跨块共享，应用重启后重置） */
let lastDeckNameInput: string | null = null;

export function getLastDeckNameInput(): string | null {
  return lastDeckNameInput;
}

export function setLastDeckNameInput(deckName: string): void {
  const trimmed = deckName.trim();
  if (trimmed) lastDeckNameInput = trimmed;
}
