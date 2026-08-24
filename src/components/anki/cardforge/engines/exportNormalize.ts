import { t } from '@/utils/i18n';
import type {
  ExportCardValidationIssue,
  ExportCardsValidationResult,
} from '../types';

// 历史说明：此处曾有 normalizeToolExportCards（将 Chat V2 anki_export_cards
// 工具载荷归一为 AnkiCardResult）。该工具桥（AnkiToolExecutor →
// CardAgent.handleToolCall）已整体删除，归一函数随之移除；
// 本模块保留导出前校验，供 CardAgent.exportCards 与导出 UI
// （features/chat/anki exportCardsAsApkg）两条链路共用。

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

