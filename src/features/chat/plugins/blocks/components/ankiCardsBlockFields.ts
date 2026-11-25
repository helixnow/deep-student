/**
 * Chat V2 - Anki 卡片块纯逻辑工具（字段归一化、模板兼容性、状态映射、Zombie 终态归约）
 */

import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import type { AnkiCardStackPreviewStatus } from '../../../anki';
import { isInternalAnkiField } from './ankiQaFlags';
import type {
  DocumentTaskSummary,
  ZombieCardLike,
  ZombieCompletionState,
} from './ankiCardsBlockTypes';

export function getRetryableTaskIds(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];

  const ids = tasks.flatMap((task: DocumentTaskSummary) => {
    const status = typeof task?.status === 'string' ? task.status.trim().toLowerCase() : '';
    const id = typeof task?.id === 'string' ? task.id.trim() : '';
    return id && (status === 'failed' || status === 'truncated') ? [id] : [];
  });

  return Array.from(new Set(ids));
}

/**
 * 卡片是否已带真实持久化 ID（DB 已有行，后端 CAS 可保护并发编辑）。
 * anki_synthetic_* / chat-batch-* 为前端/批次生成的临时 ID。
 */
export function hasRealCardId(card: Pick<AnkiCard, 'id'>): boolean {
  const id = typeof card.id === 'string' ? card.id.trim() : '';
  return id.length > 0 && !id.startsWith('anki_synthetic_') && !id.startsWith('chat-batch-');
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function isTemplateCompatibleWithCard(
  card: AnkiCard,
  template: CustomAnkiTemplate | null | undefined,
): boolean {
  if (!template) return false;
  const requiredKeys = Object.entries(template.field_extraction_rules ?? {})
    .filter(([, rule]) => Boolean(rule?.is_required))
    .map(([key]) => key.toLowerCase());
  if (requiredKeys.length === 0) return true;

  const fields = (card.fields ?? {}) as Record<string, unknown>;
  const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
  const values = new Map<string, unknown>();

  const pushEntries = (source: Record<string, unknown>) => {
    Object.entries(source).forEach(([key, value]) => {
      values.set(key.toLowerCase(), value);
    });
  };

  pushEntries(fields);
  pushEntries(extraFields);

  if (!values.has('front')) values.set('front', card.front);
  if (!values.has('back')) values.set('back', card.back);
  if (!values.has('text')) values.set('text', card.text);

  return requiredKeys.every((key) => hasValue(values.get(key)));
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, val]) => {
    if (typeof val === 'string') {
      acc[key] = val;
      return acc;
    }
    if (val === null || val === undefined) {
      acc[key] = '';
      return acc;
    }
    acc[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return acc;
  }, {});
}

export function tryParseFrontAsFields(front: string | undefined): Record<string, string> {
  if (!front) return {};
  const trimmed = front.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value === null || value === undefined) {
        acc[key] = '';
      } else if (typeof value === 'string') {
        acc[key] = value;
      } else {
        acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

export function getCaseInsensitiveValue(record: Record<string, string>, key: string): string | undefined {
  if (key in record) return record[key];
  const lower = key.toLowerCase();
  const matchedKey = Object.keys(record).find((item) => item.toLowerCase() === lower);
  if (!matchedKey) return undefined;
  return record[matchedKey];
}

export function setCaseInsensitiveValue(record: Record<string, string>, key: string, value: string): void {
  if (key in record) {
    record[key] = value;
    return;
  }
  const lower = key.toLowerCase();
  const matchedKey = Object.keys(record).find((item) => item.toLowerCase() === lower);
  if (matchedKey) {
    record[matchedKey] = value;
    return;
  }
  record[key] = value;
}

export function resolveSpecialFieldFallback(card: AnkiCard, key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'front' || lower === '正面') return card.front ?? '';
  if (lower === 'back' || lower === '背面') return card.back ?? '';
  if (lower === 'text') return card.text ?? '';
  return '';
}

export function resolveEditableFields(
  card: AnkiCard,
  template: CustomAnkiTemplate | null | undefined,
): { fieldOrder: string[]; values: Record<string, string> } {
  const fieldRecord = toStringRecord(card.fields);
  const extraFieldRecord = toStringRecord(card.extra_fields);
  const parsedFrontRecord = tryParseFrontAsFields(card.front);

  const templateFields = (template?.fields ?? []).filter(Boolean);
  const fallbackFieldOrder = ['Front', 'Back'];
  const candidates = [
    ...templateFields,
    ...Object.keys(fieldRecord),
    ...Object.keys(extraFieldRecord),
    ...Object.keys(parsedFrontRecord),
  ];
  const ordered = (candidates.length > 0 ? candidates : fallbackFieldOrder).filter((field, index, arr) => {
    if (!field) return false;
    // 内部协议字段（如 _qa_flags）不进入编辑列表，也不拼进任何可见文本
    if (isInternalAnkiField(field)) return false;
    const lower = field.toLowerCase();
    return arr.findIndex((item) => item.toLowerCase() === lower) === index;
  });

  const values = ordered.reduce<Record<string, string>>((acc, key) => {
    const fromFields = getCaseInsensitiveValue(fieldRecord, key);
    if (fromFields !== undefined) {
      acc[key] = fromFields;
      return acc;
    }
    const fromExtraFields = getCaseInsensitiveValue(extraFieldRecord, key);
    if (fromExtraFields !== undefined) {
      acc[key] = fromExtraFields;
      return acc;
    }
    const fromParsedFront = getCaseInsensitiveValue(parsedFrontRecord, key);
    if (fromParsedFront !== undefined) {
      acc[key] = fromParsedFront;
      return acc;
    }
    acc[key] = resolveSpecialFieldFallback(card, key);
    return acc;
  }, {});

  return { fieldOrder: ordered, values };
}

export function mapBlockStatusToPreviewStatus(
  blockStatus: string,
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error',
  hasCards?: boolean,
  finalStatus?: string,
): AnkiCardStackPreviewStatus {
  const normalizedFinalStatus =
    typeof finalStatus === 'string' ? finalStatus.trim().toLowerCase() : undefined;
  const isCancelled =
    normalizedFinalStatus === 'cancelled' ||
    normalizedFinalStatus === 'canceled';
  const isFailed =
    normalizedFinalStatus === 'error' || normalizedFinalStatus === 'failed';

  if (isCancelled) return 'cancelled';
  if (isFailed) return 'error';
  if (syncStatus === 'synced') return 'stored';

  switch (blockStatus) {
    case 'pending':
      return 'parsing';
    case 'running':
      return hasCards ? 'ready' : 'parsing';
    case 'success':
      return syncStatus === 'error' ? 'error' : 'ready';
    case 'error':
      return 'error';
    default:
      return 'ready';
  }
}

export function resolveZombieCompletionState(
  statuses: string[],
  cards: readonly ZombieCardLike[] = [],
): ZombieCompletionState {
  const normalized = statuses.map((status) => status.trim().toLowerCase());
  const hasCompleted = normalized.includes('completed');
  const hasFailures = normalized.some((status) => ['failed', 'truncated'].includes(status));
  const hasCancelled = normalized.some((status) => ['cancelled', 'canceled'].includes(status));
  const hasUnknown = normalized.some((status) => ![
    'completed',
    'failed',
    'truncated',
    'cancelled',
    'canceled',
  ].includes(status));
  const hasUsableCards = cards.some((card) => (
    card.is_error_card !== true && card.isErrorCard !== true
  ));

  if (hasUsableCards) {
    return {
      finalStatus: hasFailures || hasCancelled || hasUnknown
        ? 'completed_with_errors'
        : 'completed',
      blockStatus: 'success',
    };
  }
  if (hasCancelled) {
    return {
      finalStatus: 'cancelled',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCancelledWithoutCards',
    };
  }
  if (hasCompleted && !hasFailures && !hasUnknown) {
    return {
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCompletedWithoutCards',
    };
  }
  return {
    finalStatus: 'error',
    blockStatus: 'error',
    errorKey: hasFailures
      ? 'blocks.ankiCards.errors.watchdogFailedWithoutCards'
      : 'blocks.ankiCards.errors.watchdogUnknownWithoutCards',
  };
}
