// Rust: chatanki_executor.rs:749–924 卡片补丁与模板别名，以及 get_cards / list_templates / update_card 参数。
import type { AnkiCard } from '../api.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeBool, serdeOption, serdeString, serdeStringMap, serdeU32, serdeUnitEnum,
  serdeUsize, serdeVec, type SerdeStructField,
} from './serde-struct.ts';
import { CHATANKI_CARD_FIELD_LIMIT, type ChatAnkiCardsFilter } from './card-projection.ts';

export interface ChatAnkiGetCardsArgs {
  documentId: string;
  page: number | null;
  pageSize: number | null;
  filter: ChatAnkiCardsFilter;
}

const GET_CARDS_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', read: serdeString },
  { name: 'page', option: true, read: serdeOption(serdeU32) },
  { name: 'pageSize', option: true, read: serdeOption(serdeU32) },
  { name: 'filter', default: true, read: serdeUnitEnum<ChatAnkiCardsFilter>(['all', 'error_only', 'edited_only']) },
];

export function parseChatAnkiGetCardsArgs(raw: unknown): ChatAnkiGetCardsArgs {
  const [documentId, page, pageSize, filter] = deserializeSerdeStruct(raw, 'ChatAnkiGetCardsArgs', GET_CARDS_FIELDS, false);
  return {
    documentId: documentId as string,
    page: (page ?? null) as number | null,
    pageSize: (pageSize ?? null) as number | null,
    filter: (filter ?? 'all') as ChatAnkiCardsFilter,
  };
}

export interface ChatAnkiListTemplatesArgs {
  category: string | null;
  activeOnly: boolean | null;
  page: number | null;
  pageSize: number | null;
}

const LIST_TEMPLATES_FIELDS: readonly SerdeStructField[] = [
  { name: 'category', option: true, read: serdeOption(serdeString) },
  { name: 'activeOnly', option: true, read: serdeOption(serdeBool) },
  { name: 'page', option: true, read: serdeOption(serdeUsize) },
  { name: 'pageSize', option: true, read: serdeOption(serdeUsize) },
];

/** chatanki_executor.rs ChatAnkiListTemplatesArgs (camelCase wire). */
export function parseChatAnkiListTemplatesArgs(raw: unknown): ChatAnkiListTemplatesArgs {
  const [category, activeOnly, page, pageSize] = deserializeSerdeStruct(
    raw, 'ChatAnkiListTemplatesArgs', LIST_TEMPLATES_FIELDS, false,
  );
  // Paging saturates past the template count, so a usize above 2^53 may round.
  return {
    category: (category ?? null) as string | null,
    activeOnly: (activeOnly ?? null) as boolean | null,
    page: page === undefined || page === null ? null : Number(page),
    pageSize: pageSize === undefined || pageSize === null ? null : Number(pageSize),
  };
}

export interface ChatAnkiCardPatch {
  front?: string;
  back?: string;
  /** `undefined` = 未提供；`null` = 显式清空（serde `Option<Option<String>>`）。 */
  text?: string | null;
  tags?: string[];
  extraFields?: Record<string, string>;
}

export function patchIsEmpty(patch: ChatAnkiCardPatch): boolean {
  return patch.front === undefined && patch.back === undefined && patch.text === undefined
    && patch.tags === undefined && patch.extraFields === undefined;
}

const CARD_PATCH_FIELDS: readonly SerdeStructField[] = [
  { name: 'front', option: true, read: serdeOption(serdeString) },
  { name: 'back', option: true, read: serdeOption(serdeString) },
  // `#[serde(default, deserialize_with)] Option<Option<String>>`: absent ≠ null.
  { name: 'text', default: true, read: serdeOption(serdeString) },
  { name: 'tags', option: true, read: serdeOption(serdeVec(serdeString)) },
  { name: 'extraFields', aliases: ['extra_fields'], option: true, read: serdeOption(serdeStringMap) },
];

export function parseChatAnkiCardPatch(raw: unknown): ChatAnkiCardPatch {
  const [front, back, text, tags, extraFields] = deserializeSerdeStruct(raw, 'ChatAnkiCardPatch', CARD_PATCH_FIELDS, true);
  const patch: ChatAnkiCardPatch = {};
  if (typeof front === 'string') patch.front = front;
  if (typeof back === 'string') patch.back = back;
  if (text !== undefined) patch.text = text as string | null;
  if (Array.isArray(tags)) patch.tags = tags as string[];
  if (extraFields !== undefined && extraFields !== null) patch.extraFields = extraFields as Record<string, string>;
  return patch;
}

export interface ChatAnkiUpdateCardArgs {
  cardId: string;
  patch: ChatAnkiCardPatch;
  expectedVersion: string;
  allowTruncatedSource: boolean;
}

const UPDATE_CARD_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardId', read: serdeString },
  { name: 'patch', read: parseChatAnkiCardPatch },
  { name: 'expectedVersion', read: serdeString },
  { name: 'allowTruncatedSource', default: true, read: serdeBool },
];

export function parseChatAnkiUpdateCardArgs(raw: unknown): ChatAnkiUpdateCardArgs {
  const [cardId, patch, expectedVersion, allowTruncatedSource] = deserializeSerdeStruct(
    raw, 'ChatAnkiUpdateCardArgs', UPDATE_CARD_FIELDS, false,
  );
  return {
    cardId: cardId as string,
    patch: patch as ChatAnkiCardPatch,
    expectedVersion: expectedVersion as string,
    allowTruncatedSource: (allowTruncatedSource ?? false) as boolean,
  };
}

export type TemplateCardField = 'front' | 'back' | 'text' | 'tags';

export function normalizeTemplateCardFieldKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function templateAliases(field: TemplateCardField): readonly string[] {
  switch (field) {
    case 'front': return ['front', 'question', 'word', 'name', 'title', 'term', 'prompt'];
    case 'back': return [
      'back', 'answer', 'definition', 'explanation', 'desc', 'expl', 'backdetail', 'meaning',
      'translation',
    ];
    case 'text': return ['text'];
    case 'tags': return ['tags'];
  }
}

export function normalizeAgentExtraFields(
  fields: Record<string, string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalized = rustTrim(key).toLowerCase();
    if (normalized.length === 0) continue;
    Object.defineProperty(output, normalized, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  return output;
}

export function syncTemplateAliases(
  extraFields: Record<string, string>, field: TemplateCardField, value: string | null,
): void {
  const aliases = templateAliases(field);
  const matchingKeys = Object.keys(extraFields)
    .filter((key) => aliases.includes(normalizeTemplateCardFieldKey(key)));
  for (const key of matchingKeys) {
    if (value !== null) extraFields[key] = value;
    else delete extraFields[key];
  }
  const canonical = aliases[0] as string;
  if (value !== null) extraFields[canonical] = value;
  else delete extraFields[canonical];
}

/** chatanki_executor.rs:12482–12494: 新值疑似以 get_cards 的 2000 字符截断输出为源。 */
function patchValueSuspectedTruncatedSource(existing: string, newValue: string): boolean {
  const existingChars = [...existing].length;
  if (existingChars <= CHATANKI_CARD_FIELD_LIMIT) return false;
  const newChars = [...newValue].length;
  if (newChars < CHATANKI_CARD_FIELD_LIMIT || newChars >= existingChars) return false;
  const truncatedExisting = [...existing].slice(0, CHATANKI_CARD_FIELD_LIMIT).join('');
  return newValue.startsWith(truncatedExisting) || truncatedExisting.startsWith(newValue);
}

/** chatanki_executor.rs:12496–12542: patch 中疑似“以截断输出为源”的字段路径。 */
export function detectTruncatedSourceFields(
  card: AnkiCard, patch: ChatAnkiCardPatch,
): string[] {
  const fields: string[] = [];
  if (patch.front !== undefined && patchValueSuspectedTruncatedSource(card.front, patch.front)) {
    fields.push('front');
  }
  if (patch.back !== undefined && patchValueSuspectedTruncatedSource(card.back, patch.back)) {
    fields.push('back');
  }
  if (patch.text !== undefined && patch.text !== null && card.text !== null) {
    if (patchValueSuspectedTruncatedSource(card.text, patch.text)) fields.push('text');
  }
  if (patch.extraFields !== undefined) {
    for (const [key, value] of Object.entries(patch.extraFields)) {
      const normalizedKey = rustTrim(key).toLowerCase();
      const existing = card.extra_fields[normalizedKey] ?? card.extra_fields[key];
      if (existing !== undefined && patchValueSuspectedTruncatedSource(existing, value)) {
        fields.push(`extraFields.${key}`);
      }
    }
  }
  return fields;
}

/** chatanki_executor.rs:12108–12115. */
export function cardContentIsValid(card: AnkiCard): boolean {
  if (card.text !== null && rustTrim(card.text).length > 0) return true;
  return rustTrim(card.front).length > 0 && rustTrim(card.back).length > 0;
}

/** `ChatAnkiCardPatch::apply_to`：核心列与模板别名同步，保留未提及字段。 */
export function applyCardPatch(card: AnkiCard, patch: ChatAnkiCardPatch): void {
  if (patch.extraFields !== undefined) {
    card.extra_fields = normalizeAgentExtraFields(patch.extraFields);
  }
  if (patch.front !== undefined) {
    card.front = patch.front;
    syncTemplateAliases(card.extra_fields, 'front', patch.front);
  }
  if (patch.back !== undefined) {
    card.back = patch.back;
    syncTemplateAliases(card.extra_fields, 'back', patch.back);
  }
  if (patch.text !== undefined) {
    card.text = patch.text;
    syncTemplateAliases(card.extra_fields, 'text', patch.text);
  }
  if (patch.tags !== undefined) {
    card.tags = patch.tags;
    syncTemplateAliases(card.extra_fields, 'tags', JSON.stringify(patch.tags));
  }
}
