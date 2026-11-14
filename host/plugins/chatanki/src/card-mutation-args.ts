// Rust: chatanki_executor.rs:930–1217 删除 / 新增 / 入队复习 / agent 复习参数。
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeBool, serdeI64, serdeOption, serdeString, serdeStringMap, serdeVec,
  type SerdeStructField,
} from './serde-struct.ts';
import { type ChatAnkiCardPatch, patchIsEmpty, parseChatAnkiCardPatch } from './card-patch-args.ts';

export interface ChatAnkiDeleteCardArgs {
  cardId: string;
  expectedVersion: string;
  expectedReviewVersion: number | bigint | null;
}

// ChatAnkiDeleteCardArgs and ChatAnkiDeleteCardsItem share this shape;
// `undefined` review = absent (`#[serde(default)] Option<Option<i64>>`).
const DELETE_CARD_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardId', read: serdeString },
  { name: 'expectedVersion', read: serdeString },
  { name: 'expectedReviewVersion', default: true, read: serdeOption(serdeI64) },
];

export function parseChatAnkiDeleteCardArgs(raw: unknown): ChatAnkiDeleteCardArgs {
  const [rawCardId, rawExpectedVersion, review] = deserializeSerdeStruct(
    raw, 'ChatAnkiDeleteCardArgs', DELETE_CARD_FIELDS, true,
  );
  const cardId = rustTrim(rawCardId as string);
  const expectedVersion = rustTrim(rawExpectedVersion as string);
  if (cardId.length === 0 || expectedVersion.length === 0) {
    throw new Error('cardId and expectedVersion are required');
  }
  if (review === undefined) {
    throw new Error('expectedReviewVersion is required; use null to assert the card is not enqueued');
  }
  const expectedReviewVersion = review as number | bigint | null;
  if (expectedReviewVersion !== null && expectedReviewVersion < 0) {
    throw new Error('expectedReviewVersion must be null or non-negative');
  }
  return { cardId, expectedVersion, expectedReviewVersion };
}

const CHATANKI_BATCH_MUTATION_LIMIT = 100;

export interface ChatAnkiBatchUpdateCardItem {
  cardId: string;
  expectedVersion: string;
  patch: ChatAnkiCardPatch;
}

export interface ChatAnkiBatchUpdateCardsArgs {
  documentId: string;
  updates: ChatAnkiBatchUpdateCardItem[];
  allowTruncatedSource: boolean;
}

const BATCH_UPDATE_ITEM_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardId', read: serdeString },
  { name: 'expectedVersion', read: serdeString },
  { name: 'patch', read: parseChatAnkiCardPatch },
];

function parseBatchUpdateItem(raw: unknown): ChatAnkiBatchUpdateCardItem {
  const [cardId, expectedVersion, patch] = deserializeSerdeStruct(
    raw, 'ChatAnkiBatchUpdateCardItem', BATCH_UPDATE_ITEM_FIELDS, true,
  );
  return { cardId: cardId as string, expectedVersion: expectedVersion as string, patch: patch as ChatAnkiCardPatch };
}

const BATCH_UPDATE_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', read: serdeString },
  { name: 'updates', read: serdeVec(parseBatchUpdateItem) },
  { name: 'allowTruncatedSource', default: true, read: serdeBool },
];

/** chatanki_executor.rs:979-1034 `ChatAnkiBatchUpdateCardsArgs` + `normalize`. */
export function parseChatAnkiBatchUpdateCardsArgs(raw: unknown): ChatAnkiBatchUpdateCardsArgs {
  const [rawDocumentId, rawUpdates, rawAllowTruncated] = deserializeSerdeStruct(
    raw, 'ChatAnkiBatchUpdateCardsArgs', BATCH_UPDATE_FIELDS, true,
  );
  const documentId = rustTrim(rawDocumentId as string);
  const updates = rawUpdates as ChatAnkiBatchUpdateCardItem[];
  const allowTruncatedSource = (rawAllowTruncated ?? false) as boolean;
  if (documentId.length === 0) throw new Error('documentId is required');
  if (updates.length === 0 || updates.length > CHATANKI_BATCH_MUTATION_LIMIT) {
    throw new Error(`updates must contain 1..=${CHATANKI_BATCH_MUTATION_LIMIT} items`);
  }
  const seen = new Set<string>();
  for (const item of updates) {
    item.cardId = rustTrim(item.cardId);
    item.expectedVersion = rustTrim(item.expectedVersion);
    if (item.cardId.length === 0 || item.expectedVersion.length === 0) {
      throw new Error('each update requires cardId and expectedVersion');
    }
    if (patchIsEmpty(item.patch)) throw new Error(`update for card ${item.cardId} has an empty patch`);
    if (seen.has(item.cardId)) throw new Error(`duplicate cardId in updates: ${item.cardId}`);
    seen.add(item.cardId);
  }
  return { documentId, updates, allowTruncatedSource };
}

function parseDeleteCardsItem(raw: unknown): { cardId: string; expectedVersion: string; review: unknown } {
  const [cardId, expectedVersion, review] = deserializeSerdeStruct(
    raw, 'ChatAnkiDeleteCardsItem', DELETE_CARD_FIELDS, true,
  );
  return { cardId: cardId as string, expectedVersion: expectedVersion as string, review };
}

const DELETE_CARDS_FIELDS: readonly SerdeStructField[] = [
  { name: 'cards', read: serdeVec(parseDeleteCardsItem) },
];

/** chatanki_executor.rs:1036-1097 `ChatAnkiDeleteCardsArgs` + `normalize`. */
export function parseChatAnkiDeleteCardsArgs(raw: unknown): ChatAnkiDeleteCardArgs[] {
  const [rawCards] = deserializeSerdeStruct(raw, 'ChatAnkiDeleteCardsArgs', DELETE_CARDS_FIELDS, true);
  const cards = rawCards as ReturnType<typeof parseDeleteCardsItem>[];
  if (cards.length === 0 || cards.length > CHATANKI_BATCH_MUTATION_LIMIT) {
    throw new Error(`cards must contain 1..=${CHATANKI_BATCH_MUTATION_LIMIT} items`);
  }
  const seen = new Set<string>();
  return cards.map((item) => {
    const cardId = rustTrim(item.cardId);
    const expectedVersion = rustTrim(item.expectedVersion);
    if (cardId.length === 0 || expectedVersion.length === 0) {
      throw new Error('each card requires cardId and expectedVersion');
    }
    if (item.review === undefined) {
      throw new Error(`expectedReviewVersion is required for card ${cardId}; use null to assert the card is not enqueued`);
    }
    const expectedReviewVersion = item.review as number | bigint | null;
    if (expectedReviewVersion !== null && expectedReviewVersion < 0) {
      throw new Error(`expectedReviewVersion for card ${cardId} must be null or non-negative`);
    }
    if (seen.has(cardId)) throw new Error(`duplicate cardId in cards: ${cardId}`);
    seen.add(cardId);
    return { cardId, expectedVersion, expectedReviewVersion };
  });
}

export interface ChatAnkiAddCardInput {
  front: string;
  back: string;
  text: string | null;
  tags: string[];
  extraFields: Record<string, string>;
  templateId: string | null;
}

export interface ChatAnkiAddCardsArgs {
  documentId: string;
  cards: ChatAnkiAddCardInput[];
}

// `#[serde(default)]` fields still reject an explicit null; only Option<T> accepts it.
const ADD_CARD_INPUT_FIELDS: readonly SerdeStructField[] = [
  { name: 'front', default: true, read: serdeString },
  { name: 'back', default: true, read: serdeString },
  { name: 'text', option: true, read: serdeOption(serdeString) },
  { name: 'tags', default: true, read: serdeVec(serdeString) },
  { name: 'extraFields', aliases: ['extra_fields'], default: true, read: serdeStringMap },
  { name: 'templateId', option: true, read: serdeOption(serdeString) },
];

function parseAddCardInput(raw: unknown): ChatAnkiAddCardInput {
  const [front, back, text, tags, extraFields, templateId] = deserializeSerdeStruct(
    raw, 'ChatAnkiAddCardInput', ADD_CARD_INPUT_FIELDS, true,
  );
  return {
    front: (front ?? '') as string,
    back: (back ?? '') as string,
    text: (text ?? null) as string | null,
    tags: (tags ?? []) as string[],
    extraFields: (extraFields ?? {}) as Record<string, string>,
    templateId: (templateId ?? null) as string | null,
  };
}

const ADD_CARDS_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', read: serdeString },
  { name: 'cards', read: serdeVec(parseAddCardInput) },
];

export function parseChatAnkiAddCardsArgs(raw: unknown): ChatAnkiAddCardsArgs {
  const [documentId, cards] = deserializeSerdeStruct(raw, 'ChatAnkiAddCardsArgs', ADD_CARDS_FIELDS, false);
  return { documentId: documentId as string, cards: cards as ChatAnkiAddCardInput[] };
}

export type ChatAnkiReviewSelector =
  | { kind: 'document'; documentId: string }
  | { kind: 'cards'; cardIds: string[] };

const ENQUEUE_REVIEW_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', option: true, read: serdeOption(serdeString) },
  { name: 'cardIds', option: true, read: serdeOption(serdeVec(serdeString)) },
];

export function parseChatAnkiEnqueueReviewArgs(raw: unknown): ChatAnkiReviewSelector {
  const [rawDocumentId, rawCardIds] = deserializeSerdeStruct(
    raw, 'ChatAnkiEnqueueReviewArgs', ENQUEUE_REVIEW_FIELDS, true,
  );
  const documentId = (rawDocumentId ?? null) as string | null;
  const cardIds = (rawCardIds ?? null) as string[] | null;
  if (documentId !== null && cardIds === null) {
    const trimmed = rustTrim(documentId);
    if (trimmed.length === 0) throw new Error('documentId must not be empty');
    return { kind: 'document', documentId: trimmed };
  }
  if (documentId === null && cardIds !== null) {
    if (cardIds.length === 0 || cardIds.length > 100) {
      throw new Error('cardIds must contain 1 to 100 entries');
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawCardId of cardIds) {
      const cardId = rustTrim(rawCardId);
      if (cardId.length === 0) throw new Error('cardIds must not contain empty IDs');
      if (!seen.has(cardId)) {
        seen.add(cardId);
        normalized.push(cardId);
      }
    }
    return { kind: 'cards', cardIds: normalized };
  }
  throw new Error('blocks.ankiCards.errors.reviewSelectorRequired');
}

export interface ChatAnkiUndoLastReviewArgs {
  cardId: string;
  expectedReviewVersion: number | bigint;
  expectedLogId: string;
}

const UNDO_LAST_REVIEW_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardId', read: serdeString },
  { name: 'expectedReviewVersion', read: serdeI64 },
  { name: 'expectedLogId', read: serdeString },
];

export function parseChatAnkiUndoLastReviewArgs(raw: unknown): ChatAnkiUndoLastReviewArgs {
  const [rawCardId, rawReviewVersion, rawLogId] = deserializeSerdeStruct(
    raw, 'ChatAnkiUndoLastReviewArgs', UNDO_LAST_REVIEW_FIELDS, true,
  );
  const cardId = rustTrim(rawCardId as string);
  const expectedReviewVersion = rawReviewVersion as number | bigint;
  const expectedLogId = rustTrim(rawLogId as string);
  if (cardId.length === 0 || expectedLogId.length === 0 || expectedReviewVersion < 0) {
    throw new Error('cardId, non-negative expectedReviewVersion, and expectedLogId are required');
  }
  return { cardId, expectedReviewVersion, expectedLogId };
}

export interface ChatAnkiSetSuspendedArgs {
  cardId: string;
  expectedReviewVersion: number | bigint;
  suspended: boolean;
}

const SET_SUSPENDED_FIELDS: readonly SerdeStructField[] = [
  { name: 'cardId', read: serdeString },
  { name: 'expectedReviewVersion', read: serdeI64 },
  { name: 'suspended', read: serdeBool },
];

export function parseChatAnkiSetSuspendedArgs(raw: unknown): ChatAnkiSetSuspendedArgs {
  const [rawCardId, rawReviewVersion, rawSuspended] = deserializeSerdeStruct(
    raw, 'ChatAnkiSetSuspendedArgs', SET_SUSPENDED_FIELDS, true,
  );
  const cardId = rustTrim(rawCardId as string);
  const expectedReviewVersion = rawReviewVersion as number | bigint;
  const suspended = rawSuspended as boolean;
  if (cardId.length === 0 || expectedReviewVersion < 0) {
    throw new Error('cardId and a non-negative expectedReviewVersion are required');
  }
  return { cardId, expectedReviewVersion, suspended };
}
