/** translation_save source resolution and VFS persistence, translation_executor.rs:1193-1360. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { VfsRepositoryError, type TranslationRepository, type VfsCreateTranslationParams,
  type VfsTranslation, type JsonValue } from '../../vfs-repos/api.ts';
import { translationFailure, type TranslationSaveArgs, type TranslationToolFailure } from './tool_args.ts';
import { defaultCachedMeta, withTranslationCache, type CachedTranslationMeta } from './tool_result_cache.ts';

/** Requested L11 same-connection owner method, translation_executor.rs:1293–1311. */
export interface TranslationMetadataOwner {
  updateTranslationMetadata(conn: SqlExecutor, translationId: string, metadata: JsonValue): void;
}
export type TranslationPersistenceOwner = Pick<TranslationRepository, 'createTranslationInFolder'> & TranslationMetadataOwner;

export interface ResolvedTranslation {
  source: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
  meta: CachedTranslationMeta;
}

export interface ResolveSaveResult {
  resolved: ResolvedTranslation;
  cachedResultId?: string;
}

export function resolveSaveSource(
  args: TranslationSaveArgs,
  ownerSessionId: string,
  nowMs: number = Date.now(),
): ResolveSaveResult {
  if (args.mode.kind === 'cached_result') {
    const resultId = args.mode.resultId;
    const outcome = withTranslationCache(cache => cache.claimAt(resultId, ownerSessionId, nowMs));
    if (outcome.kind === 'busy') {
      throw translationFailure(
        'TRANSLATION_RESULT_BUSY',
        'The translation result is currently claimed by another in-flight save.',
        'Wait for the other save to finish; if it crashed, the claim becomes reclaimable after about 180 seconds and this call can be retried.',
        true,
      );
    }
    if (outcome.kind === 'not_found') {
      throw translationFailure(
        'TRANSLATION_RESULT_NOT_FOUND',
        'The translation result is expired, already consumed, or belongs to another chat session.',
        'Run translate_text again, then save the new result promptly.',
        false,
      );
    }
    return {
      resolved: {
        source: outcome.entry.source,
        translated: outcome.entry.translated,
        sourceLang: outcome.entry.sourceLang,
        targetLang: outcome.entry.targetLang,
        meta: outcome.entry.meta,
      },
      cachedResultId: resultId,
    };
  }
  return {
    resolved: {
      source: args.mode.source,
      translated: args.mode.translated,
      sourceLang: args.mode.sourceLang,
      targetLang: args.mode.targetLang,
      meta: defaultCachedMeta(),
    },
  };
}

/**
 * Snapshot of the translation request persisted into `translations.metadata_json`.
 * Key names match the workbench adapter (`formality` / `domain` / `glossary` /
 * `customPrompt`) for round-trip compatibility; absent options are omitted.
 */
export function buildPersistedMetadata(
  meta: CachedTranslationMeta,
  sourceMode: 'cached_result' | 'inline',
): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = { origin: 'chat_agent', sourceMode };
  if (meta.formality !== undefined) metadata.formality = meta.formality;
  if (meta.domain !== undefined) metadata.domain = meta.domain;
  if (meta.terms.length > 0) metadata.glossary = meta.terms.map(([src, dst]) => [src, dst]);
  if (meta.promptOverride !== undefined) metadata.customPrompt = meta.promptOverride;
  if (meta.partial) {
    metadata.partial = true;
    metadata.completedSegments = meta.completedSegments;
    metadata.segmentCount = meta.segmentCount;
  }
  return metadata;
}

export function mapSaveError(error: unknown): TranslationToolFailure {
  if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND'
    && typeof error.data?.resourceType === 'string' && error.data.resourceType.toLowerCase() === 'folder'
    && typeof error.data.id === 'string') {
    return translationFailure('FOLDER_NOT_FOUND', `Folder not found: ${error.data.id}`,
      'Choose an existing folder_id or omit it to save at the translation root.', false);
  }
  if (error instanceof VfsError) {
    const fields = error.fields;
    if (error.kind === 'NotFound' && typeof fields !== 'string'
      && 'resource_type' in fields && fields.resource_type.toLowerCase() === 'folder') {
      return translationFailure(
        'FOLDER_NOT_FOUND',
        `Folder not found: ${fields.id}`,
        'Choose an existing folder_id or omit it to save at the translation root.',
        false,
      );
    }
    if (error.kind === 'FolderNotFound' && typeof fields !== 'string' && 'folder_id' in fields) {
      return translationFailure(
        'FOLDER_NOT_FOUND',
        `Folder not found: ${fields.folder_id}`,
        'Choose an existing folder_id or omit it to save at the translation root.',
        false,
      );
    }
  }
  return translationFailure(
    'TRANSLATION_SAVE_FAILED',
    error instanceof Error ? error.message : String(error),
    'Retry after checking VFS availability and the destination folder.',
    true,
  );
}

export function persistTranslation(
  owner: Pick<TranslationRepository, 'createTranslationInFolder'>,
  conn: SqlExecutor,
  resolved: ResolvedTranslation,
  args: TranslationSaveArgs,
): VfsTranslation {
  const params: VfsCreateTranslationParams = {
    title: args.title ?? null,
    source: resolved.source,
    translated: resolved.translated,
    srcLang: resolved.sourceLang,
    tgtLang: resolved.targetLang,
    engine: args.engine ?? null,
    model: args.model ?? null,
  };
  try {
    return owner.createTranslationInFolder(conn, params, args.folderId ?? null);
  } catch (error) {
    throw mapSaveError(error);
  }
}

export function persistTranslationMetadata(
  owner: TranslationMetadataOwner,
  conn: SqlExecutor,
  translationId: string,
  metadata: JsonValue,
): void {
  owner.updateTranslationMetadata(conn, translationId, metadata);
}
