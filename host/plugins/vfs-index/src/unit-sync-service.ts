/**
 * `vfs/index_service.rs` unit synchronization and index maintenance.
 *
 * Table writes go through L11's published owner repositories; this service owns
 * the Rust branch order, transactions and logging. It is exposed as
 * `vfsUnitBuilder` for `vfs_sync_resource_units` and as `vfsIndexMaintenance`
 * for the unit-reset / resource-index-deletion handoff from L13b.
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type {
  CreateUnitInput, VfsIndexUnit, VfsReposService,
} from '../../vfs-repos/api.ts';
import type {
  DeleteIndexResult, UnitBuildInput, UnitBuilderService, VfsIndexMaintenanceService,
} from '../api.ts';
import { TRANSCRIPT_TEXT_SOURCE } from './indexing-content.ts';
import type { LaneLogger } from './logger.ts';
import { UnitBuilderRegistry } from './unit-builders.ts';
import {
  PDF_PAGE_SEPARATOR, getFileIdForResource, getIndexingUnitSource, needsLegacyPdfReextract,
} from '../repository/unit-sync.ts';

const WINDOW_TARGET_MS = 90_000;
const WINDOW_TARGET_CHARS = 800;
const SEGMENT_STATUS_DONE = 1;

interface TranscriptLine { startMs: number; endMs: number; text: string }
interface MediaWindow { startMs: number; endMs: number; text: string }

/** `media_index.rs::format_timestamp`: `mm:ss`, or `h:mm:ss` from one hour on. */
export function formatTimestamp(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const padded = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`;
}

/** `media_index.rs::build_windows`: ~90 s or ~800 chars per transcript unit. */
export function buildTranscriptWindows(lines: readonly TranscriptLine[]): MediaWindow[] {
  const windows: MediaWindow[] = [];
  let current: TranscriptLine[] = [];
  let currentChars = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    let endMs = last.endMs;
    for (const line of current) endMs = Math.max(endMs, line.endMs);
    const text = current.map((line) => `[${formatTimestamp(line.startMs)}] ${rustTrim(line.text)}`).join('\n');
    windows.push({ startMs: first.startMs, endMs, text });
    current = [];
  };
  for (const line of lines) {
    const lineChars = Array.from(rustTrim(line.text)).length;
    if (lineChars === 0) continue;
    const first = current[0];
    if (first !== undefined
      && (line.endMs - first.startMs > WINDOW_TARGET_MS
        || currentChars + lineChars > WINDOW_TARGET_CHARS)) {
      flush();
      currentChars = 0;
    }
    current.push(line);
    currentChars += lineChars;
  }
  flush();
  return windows;
}

export interface VfsUnitIndexDeps {
  readonly database: DatabaseHandle;
  readonly repositories: () => VfsReposService;
  readonly logger?: LaneLogger;
  /** Directory containing L11 `vfs_blobs`; required for legacy PDF re-extraction. */
  readonly blobsDir?: string;
  /** F7 `nativePdfium`, resolved lazily so a late provider is used. */
  readonly pdfium?: () => NativePdfium | undefined;
  /** Platform file port for the optional legacy-PDF repair path. */
  readonly readBytes?: (path: string) => Promise<Uint8Array>;
}

export class VfsUnitIndexService implements UnitBuilderService, VfsIndexMaintenanceService {
  private readonly database: DatabaseHandle;
  private readonly resolveRepositories: () => VfsReposService;
  private readonly logger: LaneLogger | undefined;
  private readonly blobsDir: string | undefined;
  private readonly resolvePdfium: (() => NativePdfium | undefined) | undefined;
  private readonly readBytes: ((path: string) => Promise<Uint8Array>) | undefined;
  private readonly builders = new UnitBuilderRegistry();
  private readonly warnedLegacyPdfWriteback = new Set<string>();

  constructor(deps: VfsUnitIndexDeps) {
    this.readBytes = deps.readBytes;
    this.database = deps.database;
    this.resolveRepositories = deps.repositories;
    this.logger = deps.logger;
    this.blobsDir = deps.blobsDir;
    this.resolvePdfium = deps.pdfium;
  }

  /** `VfsIndexService::sync_resource_units`, reusing the single shared connection. */
  syncResourceUnits(input: UnitBuildInput): VfsIndexUnit[] {
    const db = this.database;
    const repos = this.resolveRepositories();
    const units = this.unitsForInput(db, repos, input);
    const result = repos.embeddingUnits.syncUnits(db, input.resourceId, units);
    if (result.orphanedLanceRowIds.length > 0) {
      this.logger?.info(
        `[VfsIndexService] sync_resource_units: ${result.orphanedLanceRowIds.length} stale LanceDB vectors for resource ${input.resourceId} enqueued into __lance_orphan_queue`,
      );
    }
    if (result.units.length > 0) {
      repos.indexStates.setIndexState(db, input.resourceId, 'pending', null, null);
    }
    return result.units;
  }

  /** `indexing.rs::sync_resource_to_units`: resolve the resource row, then sync. */
  syncResourceUnitsForResource(resourceId: string): VfsIndexUnit[] {
    const input = getIndexingUnitSource(
      this.database, resourceId, this.resolveRepositories(),
    );
    if (input === undefined) return [];
    return this.syncResourceUnits(input);
  }

  /**
   * Async variant used by the full indexer: the Rust path re-extracts legacy
   * multi-page PDFs with `nativePdfium` before building page units
   * (`indexing.rs:1838-1869`). The owner-side `extracted_text` write-back is
   * still pending L11's `FileRepository.setExtractedTextByResource` (the branch
   * setter is by file id and also rewrites `page_count`), so the repaired text
   * is used for this sync only, matching Rust's behaviour when its best-effort
   * UPDATE fails.
   */
  async syncResourceUnitsForResourceAsync(resourceId: string): Promise<VfsIndexUnit[]> {
    const repositories = this.resolveRepositories();
    let input = getIndexingUnitSource(this.database, resourceId, repositories);
    if (input === undefined) return [];
    if (needsLegacyPdfReextract(input)) {
      input = await this.reextractLegacyPdf(input, repositories);
    }
    return this.syncResourceUnits(input);
  }

  private async reextractLegacyPdf(
    input: UnitBuildInput,
    repositories: VfsReposService,
  ): Promise<UnitBuildInput> {
    const blobHash = input.blobHash;
    const blobsDir = this.blobsDir;
    if (blobHash === null || blobHash === undefined) return input;
    if (blobsDir === undefined) return input;
    const pdfium = this.resolvePdfium?.();
    if (pdfium === undefined || this.readBytes === undefined) return input;
    try {
      const path = repositories.blobs.getBlobPath(this.database, blobsDir, blobHash);
      if (path === null) return input;
      const bytes = await this.readBytes(path);
      if (bytes.length < 4
        || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
        return input;
      }
      const extracted = await pdfium.extractText(bytes);
      if (!extracted.includes(PDF_PAGE_SEPARATOR)) return input;
      this.logger?.info(
        `[VfsIndexing] 已为旧 PDF 重提逐页文字 resource=${input.resourceId}`,
      );
      if (!this.warnedLegacyPdfWriteback.has(input.resourceId)) {
        this.warnedLegacyPdfWriteback.add(input.resourceId);
        this.logger?.warn(
          `[VfsIndexing] 逐页文字暂未回写 resource=${input.resourceId}: `
          + 'L11 FileRepository 尚未发布 setExtractedTextByResource（本次索引使用重提结果）',
        );
      }
      return { ...input, extractedText: extracted };
    } catch (error) {
      // Rust `reextract_pdf_page_text` returns `None` on every failure and then
      // falls back to the stored text; failures are not warning-worthy here.
      this.logger?.debug(
        `[VfsIndexing] 旧 PDF 分页重提跳过 resource=${input.resourceId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return input;
    }
  }

  /** `index_service.rs::get_status_summary`: unit stats + segment modality dimensions. */
  getStatusSummary(): import('../api.ts').VfsIndexStatusSummary {
    const db = this.database;
    const repos = this.resolveRepositories();
    const stats = repos.embeddingUnits.getStats(db);
    return {
      totalUnits: stats.total,
      textStats: {
        pending: stats.textPending,
        indexing: stats.textIndexing,
        indexed: stats.textIndexed,
        failed: stats.textFailed,
        disabled: stats.textDisabled,
      },
      mmStats: {
        pending: stats.mmPending,
        indexing: stats.mmIndexing,
        indexed: stats.mmIndexed,
        failed: stats.mmFailed,
        disabled: stats.mmDisabled,
      },
      dimensions: repos.embeddingSegments.getModalityDimStats(db).map((entry) => ({
        dimension: entry.embeddingDim,
        modality: entry.modality,
        count: entry.count,
      })),
    };
  }

  /** `VfsIndexService::reset_unit_index`: one IMMEDIATE transaction with scheduler state. */
  resetUnitIndex(unitId: string, mode: string): void {
    const repos = this.resolveRepositories();
    this.database.transaction((tx) => {
      const unit = repos.embeddingUnits.getById(tx, unitId);
      if (unit === null) throw new Error(`Unit not found: ${unitId}`);
      const textState = unit.textRequired ? 'pending' : 'disabled';
      const mmState = unit.mmRequired && unit.imageBlobHash !== null ? 'pending' : 'disabled';
      if (mode !== 'text' && mode !== 'mm' && mode !== 'both') {
        throw new Error(`unsupported index reset mode '${mode}'; expected text, mm, or both`);
      }
      if (mode === 'text' || mode === 'both') {
        repos.embeddingUnits.setTextState(tx, unitId, textState, null);
        if (textState === 'pending') {
          repos.indexStates.setIndexState(tx, unit.resourceId, 'pending', null, null);
        }
      }
      if (mode === 'mm' || mode === 'both') {
        repos.embeddingUnits.setMmState(tx, unitId, mmState, null);
        if (mmState === 'pending') {
          repos.indexStates.setMmIndexState(tx, unit.resourceId, 'pending', null);
        }
      }
    }, { behavior: 'immediate' });
  }

  /** `VfsIndexService::delete_resource_index` (the caller still clears both Lance modalities). */
  deleteResourceIndex(resourceId: string): DeleteIndexResult {
    const db = this.database;
    const repos = this.resolveRepositories();
    const units = repos.embeddingUnits.getByResource(db, resourceId);
    const lanceRowIds: string[] = [];
    for (const unit of units) {
      lanceRowIds.push(...repos.embeddingSegments.listLanceRowIdsByUnit(db, unit.id));
    }
    const unitCount = units.length;
    repos.embeddingUnits.purgeIndexArtifactsByResource(db, resourceId);
    repos.embeddingDims.refreshCountsFromSegments(db);
    if (lanceRowIds.length > 0) {
      this.logger?.info(
        `[VfsIndexService] Deleted ${unitCount} units, ${lanceRowIds.length} LanceDB row IDs pending for resource ${resourceId}`,
      );
    }
    return { resourceId, deletedUnitCount: unitCount, lanceRowIds };
  }

  private unitsForInput(
    db: DatabaseHandle,
    repos: VfsReposService,
    input: UnitBuildInput,
  ): readonly CreateUnitInput[] {
    const transcript = input.resourceType === 'file'
      ? this.transcriptUnits(db, repos, input.resourceId)
      : undefined;
    if (transcript !== undefined) return transcript;
    const built = this.builders.build(input);
    if (built === undefined) {
      throw new Error(`Invalid argument 'resource_type': Unsupported resource type: ${input.resourceType}`);
    }
    return built.units;
  }

  /** `index_service.rs::sync_resource_units_with_conn` transcript branch. */
  private transcriptUnits(
    db: DatabaseHandle,
    repos: VfsReposService,
    resourceId: string,
  ): CreateUnitInput[] | undefined {
    const fileId = getFileIdForResource(db, resourceId);
    if (fileId === null) return undefined;
    const lines: TranscriptLine[] = repos.mediaTranscripts
      .listSegments(db, fileId)
      .filter((segment) => segment.status === SEGMENT_STATUS_DONE && rustTrim(segment.text) !== '')
      .map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      }));
    const windows = buildTranscriptWindows(lines);
    if (windows.length === 0) return undefined;
    return windows.map((window, index) => ({
      resourceId,
      unitIndex: index,
      imageBlobHash: null,
      imageMimeType: null,
      textContent: window.text,
      textSource: TRANSCRIPT_TEXT_SOURCE,
    }));
  }
}
