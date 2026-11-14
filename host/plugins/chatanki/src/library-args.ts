// Rust: chatanki_executor.rs:1219–1444 卡片库列表与库卡变更参数。
import { rustTrim } from '../../../platform/util/text.ts';
import { isJsonNumberAtom, oneOf, unexpectedOf } from '../../../kernel/serde.ts';
import {
  deserializeSerdeStruct, isSerdeMap, serdeBool, serdeI64, serdeOption, serdeString, serdeStringMap, serdeU32, serdeVec,
} from './serde-struct.ts';
import { type ChatAnkiCardPatch, patchIsEmpty } from './card-patch-args.ts';

export type ChatAnkiLibrarySchedule = 'all' | 'due' | 'not_enqueued' | 'suspended' | 'enqueued';
export type ChatAnkiLibraryFilter = 'all' | 'error_only';

export interface ChatAnkiListLibraryCardsArgs {
  search: string | null;
  templateId: string | null;
  schedule: ChatAnkiLibrarySchedule;
  filter: ChatAnkiLibraryFilter;
  page: number;
  pageSize: number;
}

const LIBRARY_LIST_FIELDS = ['search', 'templateId', 'schedule', 'filter', 'page', 'pageSize'] as const;
// serde_derive's FIELDS flattens each field's sorted aliases, in struct order.
const LIBRARY_LIST_WIRE_FIELDS = ['query', ...LIBRARY_LIST_FIELDS];

function libraryListInvalidType(value: unknown, expected: string): never {
  throw new Error(`invalid type: ${unexpectedOf(value)}, expected ${expected}`);
}

function libraryListOptionString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') libraryListInvalidType(value, 'a string');
  return value;
}

function libraryListOptionU32(value: unknown): number | null {
  if (value === null) return null;
  if (isJsonNumberAtom(value)) return serdeU32(value);
  if (typeof value !== 'number') libraryListInvalidType(value, 'u32');
  // Locked serde_json arbitrary_precision: Value::deserialize_u32 delegates
  // to Number's typed parse; numeric overflow/fraction/negative is invalid_number,
  // not from_str's primitive visitor range error. No JSON reserialization.
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('invalid number');
  return value;
}

function libraryListUnitVariant<T extends string>(value: unknown, variants: readonly T[]): T {
  let variant = value;
  let unit: unknown;
  const map = isSerdeMap(value);
  if (map) {
    const entries = Object.entries(value);
    if (entries.length !== 1) throw new Error('invalid value: map, expected map with a single key');
    [variant, unit] = entries[0]!;
  }
  if (typeof variant !== 'string') libraryListInvalidType(value, 'string or map');
  const kind = variants.find((name) => name === variant);
  if (kind === undefined) throw new Error(`unknown variant \`${variant}\`, expected ${oneOf(variants)}`);
  // from_value resolves the variant before deserializing its unit payload.
  if (map && unit !== null) libraryListInvalidType(unit, 'unit');
  return kind;
}

/** Rust :1276-1304 / from_value: visit fields in input order; arrays are positional structs. */
export function parseChatAnkiListLibraryCardsArgs(raw: unknown): ChatAnkiListLibraryCardsArgs {
  let search: string | null = null;
  let templateId: string | null = null;
  let schedule: ChatAnkiLibrarySchedule = 'all';
  let filter: ChatAnkiLibraryFilter = 'all';
  let page: number | null = null;
  let pageSize: number | null = null;
  const readField = (field: typeof LIBRARY_LIST_FIELDS[number], value: unknown): void => {
    switch (field) {
      case 'search': search = libraryListOptionString(value); break;
      case 'templateId': templateId = libraryListOptionString(value); break;
      case 'schedule': schedule = libraryListUnitVariant(value, ['all', 'due', 'not_enqueued', 'suspended', 'enqueued']); break;
      case 'filter': filter = libraryListUnitVariant(value, ['all', 'error_only']); break;
      case 'page': page = libraryListOptionU32(value); break;
      case 'pageSize': pageSize = libraryListOptionU32(value); break;
    }
  };
  if (Array.isArray(raw)) {
    for (const [index, field] of LIBRARY_LIST_FIELDS.entries()) {
      if (index >= raw.length) {
        // serde(default) applies to missing enum slots only. Option fields in
        // the positional form still require a slot (null represents None).
        if (field === 'schedule' || field === 'filter') continue;
        throw new Error(`invalid length ${index}, expected struct ChatAnkiListLibraryCardsArgs with 6 elements`);
      }
      readField(field, raw[index]);
    }
    if (raw.length > 6) throw new Error(`invalid length ${raw.length}, expected fewer elements in array`);
  } else {
    if (!isSerdeMap(raw)) libraryListInvalidType(raw, 'struct ChatAnkiListLibraryCardsArgs');
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(raw)) {
      const field = key === 'query' ? 'search' : LIBRARY_LIST_FIELDS.find((name) => name === key);
      if (field === undefined) throw new Error(`unknown field \`${key}\`, expected ${oneOf(LIBRARY_LIST_WIRE_FIELDS)}`);
      if (seen.has(field)) throw new Error(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field, value);
    }
  }
  const nonBlank = (value: string | null): string | null => value === null ? null : rustTrim(value) || null;
  return {
    search: nonBlank(search), templateId: nonBlank(templateId), schedule, filter,
    page: Math.max(page ?? 1, 1), pageSize: Math.min(Math.max(pageSize ?? 20, 1), 20),
  };
}

/** Rust :789-799 `ChatAnkiCardPatch` (deny_unknown_fields; `text` is `Option<Option<String>>`). */
function deserializeChatAnkiCardPatch(raw: unknown): ChatAnkiCardPatch {
  const [front, back, text, tags, extraFields] = deserializeSerdeStruct(raw, 'ChatAnkiCardPatch', [
    { name: 'front', option: true, read: serdeOption(serdeString) },
    { name: 'back', option: true, read: serdeOption(serdeString) },
    { name: 'text', default: true, read: serdeOption(serdeString) },
    { name: 'tags', option: true, read: serdeOption(serdeVec(serdeString)) },
    { name: 'extraFields', aliases: ['extra_fields'], option: true, read: serdeOption(serdeStringMap) },
  ], true) as [string | null | undefined, string | null | undefined, string | null | undefined,
    string[] | null | undefined, Record<string, string> | null | undefined];
  const patch: ChatAnkiCardPatch = {};
  if (front != null) patch.front = front;
  if (back != null) patch.back = back;
  if (text !== undefined) patch.text = text;
  if (tags != null) patch.tags = tags;
  if (extraFields != null) patch.extraFields = extraFields;
  return patch;
}

export interface ChatAnkiUpdateLibraryCardArgs {
  cardId: string;
  expectedVersion: string;
  patch: ChatAnkiCardPatch;
}

/** Rust :1306-1323. */
export function parseChatAnkiUpdateLibraryCardArgs(raw: unknown): ChatAnkiUpdateLibraryCardArgs {
  const [rawCardId, rawExpectedVersion, patch] = deserializeSerdeStruct(raw, 'ChatAnkiUpdateLibraryCardArgs', [
    { name: 'cardId', read: serdeString },
    { name: 'expectedVersion', read: serdeString },
    { name: 'patch', read: deserializeChatAnkiCardPatch },
  ], true) as [string, string, ChatAnkiCardPatch];
  const cardId = rustTrim(rawCardId);
  const expectedVersion = rustTrim(rawExpectedVersion);
  if (cardId.length === 0 || expectedVersion.length === 0 || patchIsEmpty(patch)) {
    throw new Error('cardId, expectedVersion, and a non-empty patch are required');
  }
  return { cardId, expectedVersion, patch };
}

export interface ChatAnkiLibraryEnqueueCardInput {
  cardId: string;
  expectedVersion: string;
}

function deserializeLibraryEnqueueCardInput(raw: unknown): ChatAnkiLibraryEnqueueCardInput {
  const [cardId, expectedVersion] = deserializeSerdeStruct(raw, 'ChatAnkiLibraryEnqueueCardInput', [
    { name: 'cardId', read: serdeString },
    { name: 'expectedVersion', read: serdeString },
  ], true) as [string, string];
  return { cardId, expectedVersion };
}

/** Rust :1325-1356. */
export function parseChatAnkiEnqueueLibraryReviewArgs(
  raw: unknown,
): ChatAnkiLibraryEnqueueCardInput[] {
  const [cards] = deserializeSerdeStruct(raw, 'ChatAnkiEnqueueLibraryReviewArgs', [
    { name: 'cards', read: serdeVec(deserializeLibraryEnqueueCardInput) },
  ], true) as [ChatAnkiLibraryEnqueueCardInput[]];
  if (cards.length === 0 || cards.length > 100) {
    throw new Error('cards must contain 1 to 100 entries');
  }
  const seen = new Set<string>();
  return cards.map((card) => {
    const cardId = rustTrim(card.cardId);
    const expectedVersion = rustTrim(card.expectedVersion);
    if (cardId.length === 0 || expectedVersion.length === 0) {
      throw new Error('every card requires cardId and expectedVersion');
    }
    if (seen.has(cardId)) throw new Error('cards must not contain duplicate cardId values');
    seen.add(cardId);
    return { cardId, expectedVersion };
  });
}

export interface ChatAnkiSetLibrarySuspendedArgs {
  cardId: string;
  expectedReviewVersion: number | bigint;
  suspended: boolean;
}

/** Rust :1358-1374. */
export function parseChatAnkiSetLibrarySuspendedArgs(raw: unknown): ChatAnkiSetLibrarySuspendedArgs {
  const [rawCardId, expectedReviewVersion, suspended] = deserializeSerdeStruct(raw, 'ChatAnkiSetLibrarySuspendedArgs', [
    { name: 'cardId', read: serdeString },
    { name: 'expectedReviewVersion', read: serdeI64 },
    { name: 'suspended', read: serdeBool },
  ], true) as [string, number | bigint, boolean];
  const cardId = rustTrim(rawCardId);
  if (cardId.length === 0 || expectedReviewVersion < 0) {
    throw new Error('cardId and a non-negative expectedReviewVersion are required');
  }
  return { cardId, expectedReviewVersion, suspended };
}

export interface ChatAnkiUndoLibraryLastReviewArgs {
  cardId: string;
  expectedReviewVersion: number | bigint;
  expectedLogId: string;
}

/** Rust :1376-1399. */
export function parseChatAnkiUndoLibraryLastReviewArgs(
  raw: unknown,
): ChatAnkiUndoLibraryLastReviewArgs {
  const [rawCardId, expectedReviewVersion, rawLogId] = deserializeSerdeStruct(raw, 'ChatAnkiUndoLibraryLastReviewArgs', [
    { name: 'cardId', read: serdeString },
    { name: 'expectedReviewVersion', read: serdeI64 },
    { name: 'expectedLogId', read: serdeString },
  ], true) as [string, number | bigint, string];
  const cardId = rustTrim(rawCardId);
  const expectedLogId = rustTrim(rawLogId);
  if (cardId.length === 0 || expectedLogId.length === 0 || expectedReviewVersion < 0) {
    throw new Error('cardId, non-negative expectedReviewVersion, and expectedLogId are required');
  }
  return { cardId, expectedReviewVersion, expectedLogId };
}

export interface ChatAnkiDeleteLibraryCardArgs {
  cardId: string;
  expectedVersion: string;
  expectedReviewVersion: { present: true; value: number | bigint | null };
}

/** Rust :1401-1444: `expectedReviewVersion` is `Option<Option<i64>>`; absent differs from null. */
export function parseChatAnkiDeleteLibraryCardArgs(
  raw: unknown,
): ChatAnkiDeleteLibraryCardArgs {
  const [rawCardId, rawExpectedVersion, review] = deserializeSerdeStruct(raw, 'ChatAnkiDeleteLibraryCardArgs', [
    { name: 'cardId', read: serdeString },
    { name: 'expectedVersion', read: serdeString },
    { name: 'expectedReviewVersion', default: true, read: serdeOption(serdeI64) },
  ], true) as [string, string, number | bigint | null | undefined];
  const cardId = rustTrim(rawCardId);
  const expectedVersion = rustTrim(rawExpectedVersion);
  if (cardId.length === 0 || expectedVersion.length === 0) {
    throw new Error('cardId and expectedVersion are required');
  }
  if (review === undefined) {
    throw new Error('expectedReviewVersion is required; use null to assert the card is not enqueued');
  }
  if (review !== null && review < 0) {
    throw new Error('expectedReviewVersion must be null or non-negative');
  }
  return {
    cardId,
    expectedVersion,
    expectedReviewVersion: { present: true, value: review },
  };
}
