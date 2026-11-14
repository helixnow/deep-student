/**
 * Indexing configuration, content resolution and OCR page helpers.
 *
 * Ported from the pure half of `crates/dstu-vfs/src/vfs/indexing.rs`
 * (`VfsFullIndexingService`'s content pipeline). The chunker itself lives in
 * `indexing.ts`; resource/SQL reads live in `repository/`.
 */
import { nanoid } from 'nanoid';
import { bindVfsTableOwners, unbindVfsTableOwners, vfsTableOwners } from '../repository/owners.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { ChunkingConfig, EmbeddingProgressCallback, IndexingConfig, PageText, SearchConfig, TextChunk, VfsEmbeddingStats } from '../api.ts';
import { chunkText, chunkTextWithPages, defaultChunkingConfig, extractIndexableContent, extractIndexablePages, normalizeCompatibilityRrfScore } from './indexing.ts';
import type { LaneLogger } from './logger.ts';
import { listAll } from '../repository/embedding-dim.ts';
import {
  INDEX_STATE_INDEXED, INDEX_STATE_INDEXING, INDEX_STATE_PENDING,
  claimPendingResources, getBool, getConfig, getI32, getIndexState, getPendingResources,
  markFailed, markIndexed, markIndexing, markPending, markDisabledWithReason,
  refreshCountsFromSegments, setIndexState,
  type IndexState,
} from '../repository/index-state.ts';
import {
  clearTextIndexRowsForResource, contentHashChanged, getExamIdForResource,
  getExamPreviewJson, getFileExtractedTextById, getFileExtractedTextByResource,
  getFileExtractedTextForRecovery, getFileOcrPagesById, getFileOcrPagesByResource,
  getResourceOcrValue, getTextbookFileColumns, getTextbookPageColumns, getUnitIdAt,
  hasLegacyUnpagedPdf, hasMediaTranscript, incrementEmbeddingDimCountRow,
  insertIndexingUnitRow, insertPlaceholderSegmentRow, listOrphanQueueEntries,
  listPrepareCandidates, markUnitIndexedRow, recoverStuckIndexingRows,
  updateOrphanRetry, updateResourceOcrTextIfEmpty,
} from '../repository/index-content.ts';
import {
  MODALITY_MULTIMODAL, MODALITY_TEXT,
  ensurePrimaryUnit, getFullResource, getNoteFolderId, getNoteRecord,
  getPendingTextUnits, getResourceOcrText, getUnitsByResource,
  markTextUnitsFailedWithoutDim, markTextUnitsState, markUnitTextIndexed,
  purgeIndexArtifactsByResource, registerAndIncrementEmbeddingDim,
  replaceSegmentsByUnitAndModality, searchFtsRows, setUnitIndexProfile, setUnitTextState,
  embeddingStats,
  type CreateSegmentInput, type VfsIndexUnit, type VfsResourceRecord,
} from '../repository/index-units.ts';
import { deleteLanceOrphan } from '../repository/index-segment.ts';
import { getResource, isSourceSoftDeleted, sourceDisplayTitle } from '../repository/retrieval.ts';
import type { VfsEmbeddingPipeline } from './embedding.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
export const PDF_TEXT_THRESHOLD = 100;
export const OCR_FAILED_MARKER = '__OCR_FAILED__';
export const TRANSCRIPT_TEXT_SOURCE = 'transcript';

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function hasValidText(content: string | null | undefined, threshold: number | bigint): boolean {
  return content !== null && content !== undefined
    && Array.from(rustTrim(content)).length >= threshold;
}

// ---------------------------------------------------------------- config

export function getIndexingConfig(db: SqlExecutor): IndexingConfig {
  return {
    enabled: getBool(db, 'indexing.enabled', true),
    batchSize: getI32(db, 'indexing.batch_size', 10),
    intervalSecs: getI32(db, 'indexing.interval_secs', 5),
    maxConcurrent: getI32(db, 'indexing.max_concurrent', 2),
    retryDelaySecs: getI32(db, 'indexing.retry_delay_secs', 60),
    maxRetries: getI32(db, 'indexing.max_retries', 3),
  };
}

export function getChunkingConfig(db: SqlExecutor): ChunkingConfig {
  return {
    strategy: getConfig(db, 'chunking.strategy') ?? 'fixed_size',
    chunkSize: getI32(db, 'chunking.chunk_size', 512),
    chunkOverlap: getI32(db, 'chunking.chunk_overlap', 50),
    minChunkSize: getI32(db, 'chunking.min_chunk_size', 20),
  };
}

export function getSearchConfig(db: SqlExecutor): SearchConfig {
  return {
    defaultTopK: getI32(db, 'search.default_top_k', 10),
    enableHybrid: getBool(db, 'search.enable_hybrid', true),
    enableReranking: getBool(db, 'search.enable_reranking', false),
  };
}

// ---------------------------------------------------------------- resources

export function resolveIndexableContent(
  db: SqlExecutor,
  resource: VfsResourceRecord,
  logger?: LaneLogger,
): string | null {
  const ocrText = getResourceOcrText(db, resource.id);
  if (ocrText !== null) return ocrText;

  if (resource.data !== null && rustTrim(resource.data) !== '') {
    const content = extractIndexableContent(resource.resourceType as never, resource.data);
    if (content !== null && content !== '') return content;
  }

  switch (resource.resourceType) {
    case 'textbook': {
      const textbookId = resource.sourceId?.startsWith('tb_') || resource.sourceId?.startsWith('file_')
        ? resource.sourceId
        : resource.id;
      const file = getTextbookFileColumns(db, resource.id, textbookId);
      if (file === undefined) break;
      const pagesJson = file.ocrPagesJson;
      if (pagesJson !== null) {
        const joined = joinOcrPagesText(parseOcrPagesJson(pagesJson));
        if (joined !== null) return joined;
      }
      const extracted = file.extractedText;
      if (extracted !== null && rustTrim(extracted) !== '') return extracted;
      break;
    }
    case 'exam': {
      const examId = getExamIdForResource(db, resource.id);
      if (examId !== null) {
        // qbank_read is owned by L11 and is not in its api.ts yet. The legacy
        // preview_json fallback below remains authoritative for this lane.
        const preview = getExamPreviewJson(db, resource.id);
        const text = preview === null ? null : extractIndexableContent('exam', preview);
        if (text !== null) return text;
      }
      const preview = getExamPreviewJson(db, resource.id);
      if (preview !== null) {
        const text = extractIndexableContent('exam', preview);
        if (text !== null) return text;
      }
      break;
    }
    case 'file':
    case 'image': {
      let extracted: string | null = null;
      if (resource.sourceId !== null
        && (resource.sourceId.startsWith('att_') || resource.sourceId.startsWith('file_'))) {
        extracted = getFileExtractedTextById(db, resource.sourceId);
      }
      if (extracted === null) {
        extracted = getFileExtractedTextByResource(db, resource.id);
      }
      if (extracted !== null && rustTrim(extracted) === '') extracted = null;
      const latestOcr = getResourceOcrText(db, resource.id);
      if (extracted !== null || latestOcr !== null) {
        const extractedLength = extracted === null ? 0 : extracted.length;
        const ocrLength = latestOcr === null ? 0 : latestOcr.length;
        if (ocrLength > extractedLength) return latestOcr;
        if (ocrLength === 0 && extracted !== null) {
          const current = getResourceOcrValue(db, resource.id);
          if (current === null || current === '') {
            try {
              updateResourceOcrTextIfEmpty(db, resource.id, extracted);
            } catch (error) {
              logger?.warn(`[VfsIndexing] Failed to cache ocr_text for resource ${resource.id}: ${messageOf(error)}`);
            }
          }
        }
        return extracted;
      }
      let pagesJson: string | null = null;
      if (resource.sourceId !== null
        && (resource.sourceId.startsWith('att_') || resource.sourceId.startsWith('file_'))) {
        pagesJson = getFileOcrPagesById(db, resource.sourceId);
      }
      if (pagesJson === null) {
        pagesJson = getFileOcrPagesByResource(db, resource.id);
      }
      if (pagesJson !== null) {
        const joined = joinOcrPagesText(parseOcrPagesJson(pagesJson), '第', '页');
        if (joined !== null) return joined;
      }
      break;
    }
    default:
      break;
  }
  return null;
}

export function resolveIndexablePages(
  db: SqlExecutor,
  resource: VfsResourceRecord,
): PageText[] | null {
  switch (resource.resourceType) {
    case 'textbook': {
      const textbookId = resource.sourceId?.startsWith('tb_') || resource.sourceId?.startsWith('file_')
        ? resource.sourceId
        : resource.id;
      const file = getTextbookPageColumns(db, resource.id, textbookId);
      if (file === undefined) break;
      const sourceId = resource.sourceId ?? resource.id;
      const pagesJson = file.ocrPagesJson;
      if (pagesJson !== null) {
        const pages = parseOcrPagesJsonForPages(pagesJson, sourceId);
        if (pages.length > 0) return pages;
      }
      const extracted = file.extractedText;
      const pageCount = file.pageCount;
      if (extracted !== null && pageCount !== null && pageCount > 0 && rustTrim(extracted) !== '') {
        const paragraphs = extracted.split('\n\n').filter((part) => rustTrim(part) !== '');
        if (paragraphs.length > 0) {
          const perPage = Math.ceil(paragraphs.length / pageCount);
          const result: PageText[] = [];
          for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            const start = pageIndex * perPage;
            const end = Math.min((pageIndex + 1) * perPage, paragraphs.length);
            if (start >= paragraphs.length) break;
            const pageText = paragraphs.slice(start, end).join('\n\n');
            if (rustTrim(pageText) !== '') {
              result.push({ page_index: pageIndex, text: pageText, source_id: sourceId });
            }
          }
          if (result.length > 0) return result;
        }
      }
      break;
    }
    case 'exam': {
      const examId = getExamIdForResource(db, resource.id);
      if (examId !== null) {
        const preview = getExamPreviewJson(db, resource.id);
        if (preview !== null) {
          const pages = extractIndexablePages('exam', examId, preview);
          if (pages !== null && pages.length > 0) return pages;
        }
      }
      break;
    }
    case 'file':
    case 'image': {
      const attachmentId = resource.sourceId?.startsWith('att_') ? resource.sourceId : null;
      const pagesJson = attachmentId !== null
        ? getFileOcrPagesById(db, attachmentId)
        : getFileOcrPagesByResource(db, resource.id);
      if (pagesJson !== null) {
        const sourceId = resource.sourceId ?? resource.id;
        const pages = parseOcrPagesJsonForPages(pagesJson, sourceId);
        if (pages.length > 0) return pages;
      }
      break;
    }
    default:
      break;
  }
  if (resource.data !== null) {
    const pages = extractIndexablePages(
      resource.resourceType as never, resource.id, resource.data,
    );
    if (pages !== null && pages.length > 0) return pages;
  }
  return null;
}

export function parseOcrPagesJson(json: string): Array<string | null> {
  const trimmed = rustTrim(json);
  if (trimmed === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const normalize = (text: string): string | null => {
    const trimmedText = rustTrim(text);
    return trimmedText === '' || trimmedText === OCR_FAILED_MARKER ? null : text;
  };
  if (Array.isArray(value)) {
    // `Vec<Option<String>>` fails on any other element; the Value fallback then finds no `pages`.
    if (!value.every((item) => item === null || typeof item === 'string')) return [];
    return value.map((item) => (item === null ? null : normalize(item as string)));
  }
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const rawPages = Array.isArray(record['pages']) ? record['pages'] : null;
  if (rawPages === null) return [];
  const totalPagesRaw = record['total_pages'] ?? record['totalPages'];
  let totalPages = typeof totalPagesRaw === 'number' && Number.isInteger(totalPagesRaw)
    ? totalPagesRaw
    : 0;
  if (totalPages <= 0) {
    let maxIndex = -1;
    for (const page of rawPages) {
      if (page === null || typeof page !== 'object') continue;
      const pageRecord = page as Record<string, unknown>;
      const index = pageRecord['page_index'] ?? pageRecord['pageIndex'];
      if (typeof index === 'number' && Number.isInteger(index)) maxIndex = Math.max(maxIndex, index);
    }
    totalPages = maxIndex + 1;
  }
  totalPages = Math.max(totalPages, rawPages.length);
  const result: Array<string | null> = new Array(totalPages).fill(null);
  rawPages.forEach((page, index) => {
    if (page === null || typeof page !== 'object') return;
    const pageRecord = page as Record<string, unknown>;
    const pageIndexRaw = pageRecord['page_index'] ?? pageRecord['pageIndex'];
    const pageIndex = typeof pageIndexRaw === 'number' && Number.isInteger(pageIndexRaw)
      ? pageIndexRaw
      : index;
    const blocks = Array.isArray(pageRecord['blocks']) ? pageRecord['blocks'] : [];
    const blockParts: string[] = [];
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue;
      const blockText = (block as Record<string, unknown>)['text'];
      if (typeof blockText !== 'string') continue;
      const trimmedBlock = rustTrim(blockText);
      if (trimmedBlock !== '') blockParts.push(trimmedBlock);
    }
    const blockText = blockParts.length === 0 ? null : blockParts.join('\n');
    const rawText = pageRecord['text'];
    const textField = typeof rawText === 'string' && rustTrim(rawText) !== ''
      ? rustTrim(rawText)
      : null;
    let pageText: string | null = null;
    if (blockText !== null && textField !== null) {
      pageText = blockText.length >= textField.length ? blockText : textField;
    } else {
      pageText = blockText ?? textField;
    }
    while (result.length <= pageIndex) result.push(null);
    result[pageIndex] = pageText === null ? null : pageText;
  });
  return result.map((text) => (text === null ? null : normalize(text)));
}

function parseOcrPagesJsonForPages(json: string, sourceId: string): PageText[] {
  const result: PageText[] = [];
  parseOcrPagesJson(json).forEach((text, index) => {
    if (text !== null && rustTrim(text) !== '') {
      result.push({ page_index: index, text, source_id: sourceId });
    }
  });
  return result;
}

export function joinOcrPagesText(
  pages: readonly (string | null)[],
  headerPrefix = '--- 第',
  headerSuffix = '页 ---',
): string | null {
  const parts: string[] = [];
  pages.forEach((page, index) => {
    if (page === null) return;
    const trimmed = rustTrim(page);
    if (trimmed === '') return;
    parts.push(`${headerPrefix} ${index + 1} ${headerSuffix}\n${trimmed}`);
  });
  return parts.length === 0 ? null : parts.join('\n\n');
}

// ---------------------------------------------------------------- indexing service

export function inTransaction<T>(db: SqlExecutor, fn: (tx: SqlExecutor) => T): T {
  const runner = db as unknown as {
    transaction?: <R>(callback: (tx: SqlExecutor) => R, options?: { behavior?: string }) => R;
  };
  if (typeof runner.transaction === 'function') {
    return runner.transaction((tx) => {
      const owner = vfsTableOwners(db);
      const previous = vfsTableOwners(tx);
      if (owner !== undefined) bindVfsTableOwners(tx, owner);
      try { return fn(tx); }
      finally {
        if (previous !== undefined) bindVfsTableOwners(tx, previous);
        else unbindVfsTableOwners(tx);
      }
    }, { behavior: 'immediate' });
  }
  return fn(db);
}


/** `VfsFullIndexingService::check_needs_reindex` (shared with the legacy service). */
export function checkNeedsReindex(db: SqlExecutor, resourceId: string): boolean {
  const resource = getFullResource(db, resourceId);
  const state = getIndexState(db, resourceId);
  if (resource === undefined) return false;
  if (state === null) return true;
  if (state.state !== INDEX_STATE_INDEXED) return true;
  return state.hash !== resource.hash;
}

export function requirePendingUnits(db: SqlExecutor, resourceId: string): VfsIndexUnit[] {
  return getPendingTextUnits(db, resourceId);
}

export function emptyContentReason(resourceType: string): string {
  switch (resourceType) {
    case 'textbook': return '教材内容为空（OCR 未完成或无文字）';
    case 'exam': return '题目集内容为空';
    case 'image': return '图片内容为空（OCR 未完成或无文字）';
    case 'file': return '文件内容为空';
    case 'note': return '笔记内容为空';
    case 'mindmap': return '导图内容为空';
    case 'translation': return '翻译内容为空';
    case 'essay': return '作文内容为空';
    case 'retrieval': return '检索结果内容为空';
    case 'insight_card': return '灵感卡内容为空';
    default: return '内容为空';
  }
}
