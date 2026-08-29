/**
 * ChatAnki 卡片质检标记（`extra_fields._qa_flags`）类型化解析。
 *
 * 后端契约（src-tauri/src/anki_qa_lint.rs）：
 * - lint / critic 条目：`{code, field, message, severity}`（severity: info/warn/error）
 * - 字段规则校验旧条目：`{field, rule, message}`（无 severity，视为 warn）
 * - 值本身是 JSON 数组字符串；后端遇到不可解析的旧值会包装为
 *   `{code: "legacy_flags_unparsed"}` 条目保留原文。
 *
 * 前端职责：只读展示（摘要徽标 + 详情），绝不把 `_qa_flags` 拼进
 * front/back 文本，也不把它当成可编辑字段暴露。
 */

import type { AnkiCard } from '@/types';

/** 与后端 `QA_FLAGS_FIELD` 保持一致的键名。 */
export const QA_FLAGS_FIELD = '_qa_flags';

/** 与 `anki_critic.rs` 的审计 code 保持一致。两者沿用标准 lint 条目形状。 */
export const CRITIC_QA_FLAG_CODES = {
  flagged: 'llm_critic',
  revised: 'llm_critic_revised',
} as const;

export type QaFlagSeverity = 'info' | 'warn' | 'error';

export interface QaFlagEntry {
  /** 机器可读违规码（lint 条目）或旧字段规则名（rule 条目）。 */
  code: string;
  /** 违规字段名；卡片级违规为 "card"，未知为空串。 */
  field: string;
  /** 人类可读描述（后端生成，可能为中文/英文）。 */
  message: string;
  severity: QaFlagSeverity;
}

const SEVERITY_RANK: Record<QaFlagSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
};

function normalizeSeverity(value: unknown): QaFlagSeverity {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'error') return 'error';
    if (normalized === 'info') return 'info';
    if (normalized === 'warn' || normalized === 'warning') return 'warn';
  }
  // 旧字段规则条目（{field, rule, message}）无 severity，按 warn 处理
  return 'warn';
}

function normalizeEntry(raw: unknown): QaFlagEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const code =
    typeof record.code === 'string' && record.code.trim()
      ? record.code.trim()
      : typeof record.rule === 'string' && record.rule.trim()
        ? record.rule.trim()
        : '';
  const field = typeof record.field === 'string' ? record.field.trim() : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  // 完全空的条目没有展示价值，丢弃（防御损坏数据）
  if (!code && !field && !message) return null;
  return {
    code: code || 'unknown',
    field,
    message,
    severity: normalizeSeverity(record.severity),
  };
}

/**
 * 从单张卡片解析质检标记。
 *
 * 容错策略（前端永不因坏数据崩溃）：
 * - `_qa_flags` 缺失/空串 → []
 * - 合法 JSON 数组 → 逐条归一化，跳过非对象条目
 * - 不可解析字符串 → 包装为单条 `legacy_flags_unparsed`（对齐后端行为）
 * - 直接是数组（未来后端可能不再字符串化）→ 同样支持
 */
export function parseCardQaFlags(card: Pick<AnkiCard, 'extra_fields'>): QaFlagEntry[] {
  const raw = (card.extra_fields as Record<string, unknown> | undefined)?.[QA_FLAGS_FIELD];
  if (raw === null || raw === undefined) return [];

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [
        {
          code: 'legacy_flags_unparsed',
          field: '',
          message: trimmed,
          severity: 'warn',
        },
      ];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeEntry)
    .filter((entry): entry is QaFlagEntry => entry !== null);
}

export interface QaFlagsSummary {
  /** 带 ≥1 条标记的卡片数。 */
  flaggedCardCount: number;
  /** 全部标记条数。 */
  totalFlagCount: number;
  /** 全部标记中的最高严重度；无标记时为 null。 */
  maxSeverity: QaFlagSeverity | null;
}

export function summarizeQaFlags(cards: ReadonlyArray<Pick<AnkiCard, 'extra_fields'>>): QaFlagsSummary {
  let flaggedCardCount = 0;
  let totalFlagCount = 0;
  let maxSeverity: QaFlagSeverity | null = null;
  for (const card of cards) {
    const flags = parseCardQaFlags(card);
    if (flags.length === 0) continue;
    flaggedCardCount += 1;
    totalFlagCount += flags.length;
    for (const flag of flags) {
      if (maxSeverity === null || SEVERITY_RANK[flag.severity] > SEVERITY_RANK[maxSeverity]) {
        maxSeverity = flag.severity;
      }
    }
  }
  return { flaggedCardCount, totalFlagCount, maxSeverity };
}

export function maxFlagSeverity(flags: ReadonlyArray<QaFlagEntry>): QaFlagSeverity | null {
  let max: QaFlagSeverity | null = null;
  for (const flag of flags) {
    if (max === null || SEVERITY_RANK[flag.severity] > SEVERITY_RANK[max]) {
      max = flag.severity;
    }
  }
  return max;
}

/**
 * 下划线前缀字段是内部协议字段（如 `_qa_flags`），
 * 不进入可编辑字段列表、不渲染进卡片正文。
 */
export function isInternalAnkiField(fieldName: string): boolean {
  return fieldName.trim().startsWith('_');
}
