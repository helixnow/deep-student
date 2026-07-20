import { t } from '@/utils/i18n';
import type {
  AnkiCardResult,
  ExportCardValidationIssue,
  ExportCardsValidationResult,
} from '../types';

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

/**
 * Normalize `anki_export_cards` tool arguments into CardForge `AnkiCardResult[]`.
 *
 * The Chat V2 tool-call payload may be:
 * - Full CardForge shape (preferred), or
 * - Legacy minimal cards: `{ front, back, tags? }`, or
 * - Snake_case variants from older bridges.
 */
export function normalizeToolExportCards(cards: unknown[]): AnkiCardResult[] {
  const now = new Date().toISOString();

  return cards.map((raw, i): AnkiCardResult => {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

    const frontFromFields = isStringRecord(obj.fields) ? obj.fields.Front : undefined;
    const backFromFields = isStringRecord(obj.fields) ? obj.fields.Back : undefined;
    const textFromFields = isStringRecord(obj.fields) ? obj.fields.Text : undefined;

    const front = (typeof obj.front === 'string' ? obj.front : frontFromFields) ?? '';
    const back = (typeof obj.back === 'string' ? obj.back : backFromFields) ?? '';
    const text = typeof obj.text === 'string' ? obj.text : textFromFields;

    const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [];
    const images = Array.isArray(obj.images) ? obj.images.filter((p): p is string => typeof p === 'string') : [];

    const templateId =
      typeof obj.templateId === 'string' && obj.templateId.trim()
        ? obj.templateId
        : typeof obj.template_id === 'string' && obj.template_id.trim()
          ? obj.template_id
          : 'basic';

    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id : `temp-${i}`;

    const taskId =
      typeof obj.taskId === 'string' && obj.taskId.trim()
        ? obj.taskId
        : typeof obj.task_id === 'string' && obj.task_id.trim()
          ? obj.task_id
          : 'chat-v2';

    const createdAt =
      typeof obj.createdAt === 'string' && obj.createdAt.trim()
        ? obj.createdAt
        : typeof obj.created_at === 'string' && obj.created_at.trim()
          ? obj.created_at
          : now;

    const isErrorCard =
      typeof obj.isErrorCard === 'boolean'
        ? obj.isErrorCard
        : typeof obj.is_error_card === 'boolean'
          ? obj.is_error_card
          : false;

    const errorContent =
      typeof obj.errorContent === 'string'
        ? obj.errorContent
        : typeof obj.error_content === 'string'
          ? obj.error_content
          : undefined;

    // Prefer explicit fields/extras if provided; otherwise fallback to Front/Back.
    const rawFields = isStringRecord(obj.fields)
      ? obj.fields
      : isStringRecord(obj.extra_fields)
        ? obj.extra_fields
        : {};

    const fields: Record<string, string> = {
      ...rawFields,
    };

    if (!fields.Front) fields.Front = front;
    if (!fields.Back) fields.Back = back;
    if (text && !fields.Text) fields.Text = text;

    return {
      id,
      taskId,
      templateId,
      front,
      back,
      text,
      tags,
      fields,
      images,
      isErrorCard,
      errorContent,
      createdAt,
    };
  });
}

// ============================================================================
// 导出前校验
// ============================================================================

/** anki 命名空间下 engine 子对象的 i18n 快捷函数 */
const tEngine = (key: string, options?: Record<string, unknown>): string =>
  t(`engine.${key}`, options, 'anki');

/**
 * 校验时接受的最小卡片结构。
 *
 * 兼容 CardForge 的 `AnkiCardResult`（camelCase）与全局 `AnkiCard`
 * （snake_case），便于聊天块与任务页两条导出链路共用同一套校验。
 */
export interface ExportableCardLike {
  id?: string;
  front?: string;
  back?: string;
  text?: string | null;
  fields?: Record<string, string>;
  extra_fields?: Record<string, string>;
  isErrorCard?: boolean;
  is_error_card?: boolean;
}

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const resolveCardFields = (card: ExportableCardLike): Record<string, string> => {
  if (card.fields && Object.keys(card.fields).length > 0) return card.fields;
  if (card.extra_fields && Object.keys(card.extra_fields).length > 0) return card.extra_fields;
  return {};
};

/**
 * 导出前校验：识别空卡、缺正/反面、错误卡与模板必填字段缺失。
 *
 * - `error` 级问题的卡片应被排除出导出集合（empty_card / error_card）
 * - `warning` 级问题仅提示（missing_front / missing_back / missing_field），
 *   由调用方决定是否放行（部分模板允许无 front/back，仅靠字段渲染）
 * - 结果结构可直接用于 UI 内联展示（含本地化 message）
 *
 * @param cards 待导出卡片（兼容 AnkiCardResult / AnkiCard 两种形态）
 * @param requiredFields 可选，模板必填字段列表（如 ['Front', 'Back']）
 */
export function validateCardsForExport(
  cards: ExportableCardLike[],
  requiredFields?: string[],
): ExportCardsValidationResult {
  const issues: ExportCardValidationIssue[] = [];
  let exportableCount = 0;

  cards.forEach((card, index) => {
    const cardId = hasText(card.id) ? card.id : undefined;
    const fields = resolveCardFields(card);
    const fieldValues = Object.values(fields);
    const isErrorCard = card.isErrorCard === true || card.is_error_card === true;
    const front = hasText(card.front) ? card.front : fields.Front;
    const back = hasText(card.back) ? card.back : fields.Back;
    const hasAnyContent =
      hasText(front) ||
      hasText(back) ||
      hasText(card.text ?? undefined) ||
      fieldValues.some(hasText);

    let blocked = false;

    if (isErrorCard) {
      blocked = true;
      issues.push({
        index,
        cardId,
        code: 'error_card',
        level: 'error',
        message: tEngine('validation.error_card'),
      });
    }

    if (!hasAnyContent) {
      blocked = true;
      issues.push({
        index,
        cardId,
        code: 'empty_card',
        level: 'error',
        message: tEngine('validation.empty_card'),
      });
    } else {
      if (!hasText(front)) {
        issues.push({
          index,
          cardId,
          code: 'missing_front',
          level: 'warning',
          message: tEngine('validation.missing_front'),
        });
      }
      if (!hasText(back)) {
        issues.push({
          index,
          cardId,
          code: 'missing_back',
          level: 'warning',
          message: tEngine('validation.missing_back'),
        });
      }
      if (requiredFields && requiredFields.length > 0) {
        for (const field of requiredFields) {
          if (!hasText(fields[field])) {
            issues.push({
              index,
              cardId,
              code: 'missing_field',
              level: 'warning',
              field,
              message: tEngine('validation.missing_field', { field }),
            });
          }
        }
      }
    }

    if (!blocked) {
      exportableCount += 1;
    }
  });

  return {
    ok: exportableCount > 0,
    totalCount: cards.length,
    exportableCount,
    issues,
  };
}

/**
 * 按校验结果过滤出可导出的卡片（排除 error 级问题卡）。
 */
export function filterExportableCards<T extends ExportableCardLike>(
  cards: T[],
  validation: ExportCardsValidationResult,
): T[] {
  const blockedIndexes = new Set(
    validation.issues.filter((issue) => issue.level === 'error').map((issue) => issue.index),
  );
  return cards.filter((_, index) => !blockedIndexes.has(index));
}

