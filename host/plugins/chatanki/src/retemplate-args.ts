// Rust: chatanki_executor.rs:1446–1547 换模板参数。
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeOption, serdeString, serdeStringMap, serdeUnitEnum, serdeVec,
  type SerdeStructField,
} from './serde-struct.ts';

export type ChatAnkiRetemplateStrategy = 'map_only' | 'fill_missing' | 'fill_missing_llm';

export const parseChatAnkiRetemplateStrategy = serdeUnitEnum<ChatAnkiRetemplateStrategy>(
  ['map_only', 'fill_missing', 'fill_missing_llm'],
);

export type AnkiRetemplateSelector =
  | { kind: 'document'; documentId: string }
  | { kind: 'cards'; cardIds: string[] };

export interface NormalizedChatAnkiRetemplateRequest {
  selector: AnkiRetemplateSelector;
  targetTemplateId: string;
  strategy: ChatAnkiRetemplateStrategy;
  expectedVersions: Record<string, string>;
}

const RETEMPLATE_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', option: true, read: serdeOption(serdeString) },
  { name: 'cardIds', option: true, read: serdeOption(serdeVec(serdeString)) },
  { name: 'targetTemplateId', read: serdeString },
  { name: 'strategy', read: parseChatAnkiRetemplateStrategy },
  { name: 'expectedVersions', read: serdeStringMap },
];

export function parseChatAnkiRetemplateArgs(raw: unknown): NormalizedChatAnkiRetemplateRequest {
  const [rawDocumentId, rawCardIds, rawTarget, rawStrategy, rawVersionMap] = deserializeSerdeStruct(
    raw, 'ChatAnkiRetemplateArgs', RETEMPLATE_FIELDS, true,
  );
  const documentId = (rawDocumentId ?? null) as string | null;
  const cardIds = (rawCardIds ?? null) as string[] | null;
  const rawTargetTemplateId = rawTarget as string;
  const strategy = rawStrategy as ChatAnkiRetemplateStrategy;
  const rawVersions = rawVersionMap as Record<string, string>;

  let selector: AnkiRetemplateSelector;
  if (documentId !== null && cardIds === null) {
    const trimmed = rustTrim(documentId);
    if (trimmed.length === 0) throw new Error('documentId must not be empty');
    selector = { kind: 'document', documentId: trimmed };
  } else if (documentId === null && cardIds !== null) {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawCardId of cardIds) {
      const cardId = rustTrim(rawCardId);
      if (cardId.length === 0) throw new Error('cardIds must not contain empty IDs');
      if (seen.has(cardId)) throw new Error('cardIds must not contain duplicate IDs');
      seen.add(cardId);
      normalized.push(cardId);
    }
    if (normalized.length === 0 || normalized.length > 100) {
      throw new Error('cardIds must contain 1 to 100 unique entries');
    }
    selector = { kind: 'cards', cardIds: normalized };
  } else {
    throw new Error('blocks.ankiCards.errors.retemplateSelectorRequired');
  }

  const targetTemplateId = rustTrim(rawTargetTemplateId);
  if (targetTemplateId.length === 0) throw new Error('targetTemplateId must not be empty');
  if (Object.keys(rawVersions).length === 0) throw new Error('expectedVersions must not be empty');
  const expectedVersions: Record<string, string> = {};
  for (const [rawCardId, rawVersion] of Object.entries(rawVersions)) {
    const cardId = rustTrim(rawCardId);
    const version = rustTrim(rawVersion);
    if (cardId.length === 0 || version.length === 0) {
      throw new Error('expectedVersions keys and values must not be empty');
    }
    if (Object.hasOwn(expectedVersions, cardId)) {
      throw new Error('expectedVersions contains duplicate normalized card IDs');
    }
    Object.defineProperty(expectedVersions, cardId, {
      value: version, enumerable: true, writable: true, configurable: true,
    });
  }
  return { selector, targetTemplateId, strategy, expectedVersions };
}
