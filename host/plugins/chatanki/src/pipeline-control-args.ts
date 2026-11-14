// Rust: chatanki_executor.rs:736–747（wait）、:1555–1563（control）、:1654–1667（sync）参数。
import { isJsonNumberAtom, oneOf, unexpectedOf } from '../../../kernel/serde.ts';
import {
  deserializeSerdeStruct, isSerdeMap, serdeOption, serdeString, serdeU64, serdeVec,
} from './serde-struct.ts';

export interface ChatAnkiWaitArgs {
  ankiBlockId: string | null;
  documentId: string | null;
  timeoutMs: number | bigint | null;
}

/** Rust :736-747: no `deny_unknown_fields`; each alias equals its camelCase name. */
export function parseChatAnkiWaitArgs(raw: unknown): ChatAnkiWaitArgs {
  const [ankiBlockId, documentId, timeoutMs] = deserializeSerdeStruct(raw, 'ChatAnkiWaitArgs', [
    { name: 'ankiBlockId', option: true, read: serdeOption(serdeString) },
    { name: 'documentId', option: true, read: serdeOption(serdeString) },
    { name: 'timeoutMs', option: true, read: serdeOption(serdeU64) },
  ], false) as [string | null | undefined, string | null | undefined, number | bigint | null | undefined];
  return { ankiBlockId: ankiBlockId ?? null, documentId: documentId ?? null, timeoutMs: timeoutMs ?? null };
}

export interface ChatAnkiControlArgs {
  action: string;
  documentId: string;
  taskId: string | null;
}

/** Rust :1555-1563 `ChatAnkiControlArgs`: no `deny_unknown_fields`; aliases equal the camelCase names. */
export function parseChatAnkiControlArgs(raw: unknown): ChatAnkiControlArgs {
  const [action, documentId, taskId] = deserializeSerdeStruct(raw, 'ChatAnkiControlArgs', [
    { name: 'action', read: serdeString },
    { name: 'documentId', read: serdeString },
    { name: 'taskId', option: true, read: serdeOption(serdeString) },
  ], false) as [string, string, string | null | undefined];
  return { action, documentId, taskId: taskId ?? null };
}

const TEMPLATE_MODES = ['single', 'multiple', 'all'] as const;

/** `ChatAnkiTemplateMode` (lowercase unit variants) through serde_json `Value::deserialize_enum`. */
function serdeTemplateMode(value: unknown): typeof TEMPLATE_MODES[number] {
  let variant: string;
  let content: unknown;
  if (typeof value === 'string') {
    variant = value;
  } else if (isSerdeMap(value) && !isJsonNumberAtom(value)) {
    const entries = Object.entries(value);
    if (entries.length !== 1) throw new Error('invalid value: map, expected map with a single key');
    [variant, content] = entries[0]!;
  } else {
    throw new Error(`invalid type: ${unexpectedOf(value)}, expected string or map`);
  }
  const mode = TEMPLATE_MODES.find((candidate) => candidate === variant);
  if (mode === undefined) throw new Error(`unknown variant \`${variant}\`, expected ${oneOf(TEMPLATE_MODES)}`);
  if (content !== undefined && content !== null) {
    throw new Error(`invalid type: ${unexpectedOf(content)}, expected unit`);
  }
  return mode;
}

export interface ChatAnkiSyncArgs {
  documentId: string;
  deckName: string | null;
  noteType: string | null;
  templateId: string | null;
  templateIds: string[] | null;
}

/** Rust :1654-1667 `ChatAnkiSyncArgs`; `templateMode` is decoded (its errors count) but unused by the handler. */
export function parseChatAnkiSyncArgs(raw: unknown): ChatAnkiSyncArgs {
  const [documentId, deckName, noteType, templateId, templateIds] = deserializeSerdeStruct(raw, 'ChatAnkiSyncArgs', [
    { name: 'documentId', read: serdeString },
    { name: 'deckName', option: true, read: serdeOption(serdeString) },
    { name: 'noteType', option: true, read: serdeOption(serdeString) },
    { name: 'templateId', option: true, read: serdeOption(serdeString) },
    { name: 'templateIds', option: true, read: serdeOption(serdeVec(serdeString)) },
    { name: 'templateMode', option: true, read: serdeOption(serdeTemplateMode) },
  ], false) as [string, string | null | undefined, string | null | undefined, string | null | undefined,
    string[] | null | undefined];
  return {
    documentId,
    deckName: deckName ?? null,
    noteType: noteType ?? null,
    templateId: templateId ?? null,
    templateIds: templateIds ?? null,
  };
}
