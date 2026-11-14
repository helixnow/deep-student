// Rust: chatanki_executor.rs:1565–1652 导出参数，:638–681 导入 APKG 参数。
import { isAbsolute } from '../../../platform/util/path.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeOption, serdeString, serdeVec, type SerdeStructField,
} from './serde-struct.ts';

export type ChatAnkiExportSelector =
  | { kind: 'document'; documentId: string }
  | { kind: 'libraryCards'; cardIds: string[] };

export interface NormalizedChatAnkiExportRequest {
  selector: ChatAnkiExportSelector;
  format: 'json' | 'apkg';
  deckName: string | null;
  noteType: string | null;
  templateId: string | null;
  suggestedName: string | null;
}

const EXPORT_FIELDS: readonly SerdeStructField[] = [
  { name: 'documentId', option: true, read: serdeOption(serdeString) },
  { name: 'libraryCardIds', option: true, read: serdeOption(serdeVec(serdeString)) },
  { name: 'format', read: serdeString },
  { name: 'deckName', option: true, read: serdeOption(serdeString) },
  { name: 'noteType', option: true, read: serdeOption(serdeString) },
  { name: 'templateId', option: true, read: serdeOption(serdeString) },
  { name: 'suggestedName', option: true, read: serdeOption(serdeString) },
];

export function parseChatAnkiExportArgs(raw: unknown): NormalizedChatAnkiExportRequest {
  const [rawDocumentId, rawLibraryCardIds, rawFormatValue, deckName, noteType, templateId, suggestedName] =
    deserializeSerdeStruct(raw, 'ChatAnkiExportArgs', EXPORT_FIELDS, false);
  const rawFormat = rawFormatValue as string;
  const format = rustTrim(rawFormat).toLowerCase();
  if (format !== 'json' && format !== 'apkg') {
    throw new Error(`Unsupported export format: ${rawFormat}`);
  }

  const documentId = (rawDocumentId ?? null) as string | null;
  const libraryCardIds = (rawLibraryCardIds ?? null) as string[] | null;
  let selector: ChatAnkiExportSelector;
  if (documentId !== null && libraryCardIds === null) {
    const trimmed = rustTrim(documentId);
    if (trimmed.length === 0) throw new Error('documentId must not be empty');
    selector = { kind: 'document', documentId: trimmed };
  } else if (documentId === null && libraryCardIds !== null) {
    if (format !== 'json') {
      throw new Error('libraryCardIds export only supports format=json');
    }
    if (libraryCardIds.length === 0 || libraryCardIds.length > 100) {
      throw new Error('libraryCardIds must contain 1 to 100 unique entries');
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawCardId of libraryCardIds) {
      const cardId = rustTrim(rawCardId);
      if (cardId.length === 0) throw new Error('libraryCardIds must not contain empty IDs');
      if (seen.has(cardId)) throw new Error('libraryCardIds must not contain duplicate IDs');
      seen.add(cardId);
      normalized.push(cardId);
    }
    selector = { kind: 'libraryCards', cardIds: normalized };
  } else {
    throw new Error('documentId and libraryCardIds are mutually exclusive; provide exactly one');
  }

  return {
    selector,
    format,
    deckName: (deckName ?? null) as string | null,
    noteType: (noteType ?? null) as string | null,
    templateId: (templateId ?? null) as string | null,
    suggestedName: (suggestedName ?? null) as string | null,
  };
}
export type ChatAnkiImportApkgSource =
  | { kind: 'resourceId'; resourceId: string }
  | { kind: 'absolutePath'; path: string };

/** chatanki_executor.rs:636-642 `ChatAnkiImportApkgArgs` after serde. */
export interface ChatAnkiImportApkgArgs {
  resourceId: string | null;
  path: string | null;
}

const IMPORT_APKG_FIELDS: readonly SerdeStructField[] = [
  { name: 'resourceId', option: true, read: serdeOption(serdeString) },
  { name: 'path', option: true, read: serdeOption(serdeString) },
];

export function decodeChatAnkiImportApkgArgs(raw: unknown): ChatAnkiImportApkgArgs {
  const [resourceId, path] = deserializeSerdeStruct(raw, 'ChatAnkiImportApkgArgs', IMPORT_APKG_FIELDS, true);
  return { resourceId: (resourceId ?? null) as string | null, path: (path ?? null) as string | null };
}

export function parseChatAnkiImportApkgArgs(raw: unknown): ChatAnkiImportApkgSource {
  return normalizeChatAnkiImportApkgArgs(decodeChatAnkiImportApkgArgs(raw));
}

/** 恰好一个来源；resourceId 只接受 file_/att_/res_，path 必须绝对。 */
export function normalizeChatAnkiImportApkgArgs(args: ChatAnkiImportApkgArgs): ChatAnkiImportApkgSource {
  const resourceId = args.resourceId === null ? null : rustTrim(args.resourceId) || null;
  const path = args.path === null ? null : rustTrim(args.path) || null;
  if (resourceId !== null && path === null) {
    if (!resourceId.startsWith('file_') && !resourceId.startsWith('att_')
      && !resourceId.startsWith('res_')) {
      throw new Error('resourceId must be a file_, att_, or res_ file resource');
    }
    return { kind: 'resourceId', resourceId };
  }
  if (resourceId === null && path !== null) {
    if (!isAbsolute(path)) throw new Error('path must be absolute');
    return { kind: 'absolutePath', path };
  }
  throw new Error('exactly one of resourceId or path is required');
}
