/**
 * ChatAnki 制卡块 — 模块级 UI 状态（以 blockId 为 key）。
 *
 * 消息列表虚拟滚动会卸载/重挂块组件，组件本地 state（展开态、
 * 编辑索引、未保存草稿、分页计数、多选集合）会被静默清空。
 * 这里用模块级 Map 保存这些轻量 UI 状态，重挂时恢复。
 *
 * 注意：仅存 UI 状态，不存卡片数据本身（卡片以 store/toolOutput 为准）。
 */

// ============================================================================
// 生成质量观测载荷（anki_generation_event 的 CriticSummary / GenerationStats 标签）
// 后端 wire 格式为 snake_case（src-tauri/anki_critic.rs::CriticSummary、
// streaming_anki_service.rs::emit_generation_stats）；归一化函数同时兼容
// camelCase，避免后端序列化策略调整时前端静默丢数据。
// ============================================================================

/** 任务级 critic 摘要（归一化后的前端形态，patch 进 anki_cards block.toolOutput.criticSummary） */
export interface AnkiCriticSummary {
  taskId?: string;
  documentId?: string;
  /** 进入 prompt 被评审的卡片数 */
  examined: number;
  kept: number;
  revised: number;
  flagged: number;
  /** 越权 card_id 被拒绝的裁决数 */
  rejectedUnknownIds: number;
  /** 因 token 预算 / 单次上限被跳过未评审的卡片数 */
  skippedOverBudget: number;
  /** 实际注入 prompt 的同源金标参照对数（0 = 规则 rubric 模式） */
  goldReferences: number;
  /** 因预算/上限被截断未注入的金标参照对数 */
  goldReferencesTruncated: number;
  /** 持久化失败（update 未命中行等）的卡片数 */
  persistFailures: number;
  /** 非 null 表示本次 critic 降级（模型失败/超时/解析失败），全部卡片视同 keep */
  degraded: string | null;
  /** critic 路由到的模型配置 id（缺省 = 路由不可用，走旧 model2 路径） */
  routedConfigId?: string;
  /** critic 路由到的模型名 */
  routedModel?: string;
  /** 路由决策是否为降级（首选主模型槽缺失，落到了其他槽位的同一模型） */
  routedDegraded?: boolean;
  /** 前端收到事件的时间（ISO），便于调试面板排序 */
  receivedAt: string;
}

/** 流式生成质量统计（归一化后的前端形态，patch 进 block.toolOutput.generationStats） */
export interface AnkiGenerationStats {
  taskId?: string;
  documentId?: string;
  cardsGenerated: number;
  failedCards: number;
  duplicateCards: number;
  droppedFragments: number;
  flaggedCards: number;
  /** 前端收到事件的时间（ISO） */
  receivedAt: string;
}

function pickNumber(
  obj: Record<string, unknown>,
  snake: string,
  camel: string,
): number {
  const value = obj[snake] ?? obj[camel];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function pickString(
  obj: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const value = obj[snake] ?? obj[camel];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 归一化 CriticSummary 事件载荷（snake_case / camelCase 均可）。
 * 非对象载荷返回 null（调用方丢弃事件，不写脏数据）。
 */
export function normalizeAnkiCriticSummary(raw: unknown): AnkiCriticSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const degradedRaw = obj.degraded;
  const routedDegradedRaw = obj.routed_degraded ?? obj.routedDegraded;
  return {
    taskId: pickString(obj, 'task_id', 'taskId'),
    documentId: pickString(obj, 'document_id', 'documentId'),
    examined: pickNumber(obj, 'examined', 'examined'),
    kept: pickNumber(obj, 'kept', 'kept'),
    revised: pickNumber(obj, 'revised', 'revised'),
    flagged: pickNumber(obj, 'flagged', 'flagged'),
    rejectedUnknownIds: pickNumber(obj, 'rejected_unknown_ids', 'rejectedUnknownIds'),
    skippedOverBudget: pickNumber(obj, 'skipped_over_budget', 'skippedOverBudget'),
    goldReferences: pickNumber(obj, 'gold_references', 'goldReferences'),
    goldReferencesTruncated: pickNumber(obj, 'gold_references_truncated', 'goldReferencesTruncated'),
    persistFailures: pickNumber(obj, 'persist_failures', 'persistFailures'),
    degraded: typeof degradedRaw === 'string' && degradedRaw ? degradedRaw : null,
    routedConfigId: pickString(obj, 'routed_config_id', 'routedConfigId'),
    routedModel: pickString(obj, 'routed_model', 'routedModel'),
    routedDegraded: typeof routedDegradedRaw === 'boolean' ? routedDegradedRaw : undefined,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * 归一化 GenerationStats 事件载荷（snake_case / camelCase 均可）。
 * 非对象载荷返回 null。
 */
export function normalizeAnkiGenerationStats(raw: unknown): AnkiGenerationStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    taskId: pickString(obj, 'task_id', 'taskId'),
    documentId: pickString(obj, 'document_id', 'documentId'),
    cardsGenerated: pickNumber(obj, 'cards_generated', 'cardsGenerated'),
    failedCards: pickNumber(obj, 'failed_cards', 'failedCards'),
    duplicateCards: pickNumber(obj, 'duplicate_cards', 'duplicateCards'),
    droppedFragments: pickNumber(obj, 'dropped_fragments', 'droppedFragments'),
    flaggedCards: pickNumber(obj, 'flagged_cards', 'flaggedCards'),
    receivedAt: new Date().toISOString(),
  };
}

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
