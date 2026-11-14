/**
 * `dstu-vision/src/exam_sheet_service.rs`: VFS-backed session detail,
 * per-session serialized card updates, archive migration and rename.
 *
 * Rust owns the commands (`src/commands.rs:945/957/980`) in L14-qbank; this
 * service is the provider L14 calls.  Errors carry the exact `AppError` value.
 * The stored-row -> detail projection lives in `exam-sheet-projection.ts`.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { hostPath as path } from '../../../platform/util/path.ts';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type {
  ExamRepository, Question, QuestionRepository, VfsExamSheet,
} from '../../vfs-repos/api.ts';
import type {
  ExamCardPreview, ExamSheetPreviewResult, ExamSheetSessionDetail,
  ExamSheetSessionMetadata, ExamSheetSessionSummary, RenameExamSheetSessionRequest,
  UpdateExamSheetCardsRequest,
} from '../../../../contracts/ipc/generated/L14-qbank.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';
import type { ExamSheetSessionService, ExamSheetUpdateOutcome } from '../api.ts';
import { applyExamNameUpdate } from './exam-sheet.ts';
import { ExamSheetSessionError } from './errors.ts';
import {
  approxEqBbox, clampBbox, compareUtf8, decodePreview,
  encodeMetadata, encodePreview, normalizedBboxToPixels, resolvedBboxToPixels, sanitizeLabel,
  trimOwned, type BBox, type BBoxPixels,
} from './exam-sheet-model.ts';
import { projectExamSheetDetail } from './exam-sheet-projection.ts';

const ARCHIVE_PREFIX = 'images/';
const ZERO_BBOX: BBox = { x: 0, y: 0, width: 0, height: 0 };

export { ExamSheetSessionError };

/** Raw pixels handed to F7 `nativeImage.encode` (same shape as its `RgbaImage`). */
export interface RgbaImageInput {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface ExamSheetSessionDeps {
  db(): SqlExecutor;
  exams(): ExamRepository;
  questions(): QuestionRepository;
  nativeImage(): NativeImage;
  /** F7 `nativeImage.encode({ format: 'png' })`; production must not encode PNG itself. */
  encodePng(input: RgbaImageInput): Promise<Uint8Array>;
  imagesDir(): string;
  log: { warn(message: string): void; info(message: string): void };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(appError: AppError): never {
  throw new ExamSheetSessionError(appError);
}

function databaseFailure(prefix: string, error: unknown): never {
  return failure(AppError.database(`${prefix}: ${messageOf(error)}`));
}

function validationFailure(message: string): never {
  return failure(AppError.validation(message));
}

function notFoundFailure(message: string): never {
  return failure(AppError.not_found(message));
}

/** `std::io::Error` Display for the codes the exam-sheet paths can hit. */
function ioText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    const mapped: Record<string, string> = {
      ENOENT: 'No such file or directory (os error 2)',
      EPERM: 'Operation not permitted (os error 1)',
      EACCES: 'Permission denied (os error 13)',
      EEXIST: 'File exists (os error 17)',
      ENOTDIR: 'Not a directory (os error 20)',
      EISDIR: 'Is a directory (os error 21)',
      ENOSPC: 'No space left on device (os error 28)',
      EROFS: 'Read-only file system (os error 30)',
    };
    if (typeof code === 'string' && mapped[code] !== undefined) return mapped[code]!;
  }
  return messageOf(error);
}

/** `FileManager::resolve_image_path` traversal confinement. */
export function resolveImagePath(imagesDir: string, relativePath: string, log?: { warn(message: string): void }): string {
  // Rust receives raw archive paths; accept both separators, but never let a `\..\` component
  // bypass the traversal check or leak a mixed-separator path into `existsSync` / `path.join`.
  const normalized = relativePath.replaceAll('\\', '/');
  if (path.isAbsolute(normalized)) return normalized;

  const stripped = normalized.startsWith('images/') ? normalized.slice('images/'.length) : normalized;
  const trimmed = stripped.replace(/^\/+/, '');
  if (trimmed.split('/').some(part => part === '..')) {
    log?.warn(`路径遍历拦截: ${relativePath} 包含 ..`);
    return imagesDir;
  }
  const candidate = path.join(imagesDir, trimmed);

  try {
    const canonical = path.resolve(candidate);
    const base = path.resolve(imagesDir);
    if (existsSync(candidate) && existsSync(imagesDir)) {
      const realCandidate = realPathOrNull(candidate);
      const realBase = realPathOrNull(imagesDir);
      if (realCandidate !== null && realBase !== null) {
        if (realCandidate === realBase || realCandidate.startsWith(realBase + path.sep)) {
          return realCandidate;
        }
        log?.warn(`路径遍历拦截: ${canonical} 不在 ${base} 内`);
        return imagesDir;
      }
    }
  } catch (error) {
    // canonicalize 失败时退回组件级检查；仅记录，不改变解析结果。
    log?.warn(`路径规范化失败，回退到组件检查: ${messageOf(error)}`);
  }

  if (candidate.replaceAll('\\', '/').split('/').some(part => part === '..')) {
    log?.warn(`路径遍历拦截: ${candidate} 包含 ..`);
    return imagesDir;
  }
  return candidate;
}

function realPathOrNull(value: string): string | null {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

function ensureImagesPrefix(value: string): string {
  if (value.startsWith(ARCHIVE_PREFIX)) return value;
  return `images/${value.replace(/^\/+/, '')}`;
}

function nowTimestamp(): string {
  return toRfc3339Opts(nowEpochNanos(), 'AutoSi', true);
}

export class ExamSheetSessionCore implements ExamSheetSessionService {
  readonly version = 1 as const;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly deps: ExamSheetSessionDeps;

  constructor(deps: ExamSheetSessionDeps) {
    this.deps = deps;
  }

  private resolveImagePath(relativePath: string): string {
    return resolveImagePath(this.deps.imagesDir(), relativePath, this.deps.log);
  }

  private async dimensions(absPath: string): Promise<{ width: number; height: number }> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absPath);
    } catch (error) {
      throw new Error(ioText(error));
    }
    return await this.deps.nativeImage().dimensions(bytes);
  }

  private saveToVfs(detail: ExamSheetSessionDetail): void {
    try {
      this.deps.exams().upsertExamSheet(this.deps.db(), {
        examName: detail.summary.exam_name ?? null,
        tempId: detail.summary.temp_id,
        status: detail.summary.status,
        metadataJson: encodeMetadata(detail.summary.metadata) as unknown as JsonValue,
        previewJson: encodePreview(detail.preview) as unknown as JsonValue,
        folderId: null,
      }, detail.summary.id);
    } catch (error) {
      databaseFailure('VFS 保存整卷失败', error);
    }
  }

  private getFromVfs(sessionId: string): ExamSheetSessionDetail | null {
    let exam: VfsExamSheet | null;
    try {
      exam = this.deps.exams().getExamSheet(this.deps.db(), sessionId);
    } catch (error) {
      return databaseFailure('VFS 查询整卷失败', error);
    }
    if (exam === null) return null;

    const formal: Question[] = [];
    for (let page = 1; ; page += 1) {
      let result;
      try {
        result = this.deps.questions().listQuestions(this.deps.db(), sessionId, {}, page, 100);
      } catch (error) {
        return databaseFailure('读取正式题目失败', error);
      }
      formal.push(...result.questions);
      if (!result.has_more) break;
    }
    return projectExamSheetDetail(exam, formal, this.deps.log);
  }

  private async copyAssetToArchive(sourceRel: string, archiveRootRel: string): Promise<string | undefined> {
    const normalizedSource = sourceRel.trim();
    if (normalizedSource === '') return undefined;
    if (normalizedSource.startsWith(archiveRootRel)) return ensureImagesPrefix(normalizedSource);

    const sourceAbs = this.resolveImagePath(normalizedSource);
    if (!await stat(sourceAbs).then(() => true, () => false)) {
      this.deps.log.info(`⚠️ [exam-sheet] 原始图片不存在，跳过持久化: ${sourceAbs}`);
      return undefined;
    }

    let fileName = path.basename(normalizedSource);
    if (normalizedSource.endsWith('/') || fileName === '.' || fileName === '..' || fileName === '') {
      fileName = `asset_${globalThis.crypto.randomUUID()}`;
    }

    const normalizedRoot = archiveRootRel.startsWith(ARCHIVE_PREFIX)
      ? archiveRootRel.replace(/\/+$/, '')
      : `images/${archiveRootRel.replace(/^\/+/, '').replace(/\/+$/, '')}`;
    const destDirAbs = this.resolveImagePath(normalizedRoot);
    try {
      await mkdir(destDirAbs, { recursive: true });
    } catch (error) {
      return failure(AppError.file_system(`创建整卷归档目录失败: ${ioText(error)}`));
    }
    const destAbs = path.join(destDirAbs, fileName);
    try {
      await copyFile(sourceAbs, destAbs);
    } catch (error) {
      return failure(AppError.file_system(`复制整卷图片失败: ${ioText(error)}`));
    }
    return ensureImagesPrefix(`${normalizedRoot}/${fileName}`);
  }

  private async archivePreviewAssets(preview: ExamSheetPreviewResult, sessionId: string): Promise<void> {
    const archiveRoot = `images/exam_sheet_archive/${sessionId}`;
    for (const page of preview.pages) {
      const original = await this.copyAssetToArchive(page.original_image_path ?? '', archiveRoot);
      if (original !== undefined) page.original_image_path = original;
      for (const card of page.cards) {
        const cropped = await this.copyAssetToArchive(card.cropped_image_path ?? '', archiveRoot);
        if (cropped !== undefined) card.cropped_image_path = cropped;
      }
    }
  }

  private async enrichSessionDetail(detail: ExamSheetSessionDetail): Promise<void> {
    const sessionId = detail.summary.id;

    if (detail.preview.session_id === undefined || detail.preview.session_id === null) {
      detail.preview.session_id = sessionId;
      try {
        this.saveToVfs({
          summary: detail.summary,
          preview: detail.preview,
        });
      } catch (error) {
        this.deps.log.warn(`⚠️ 回写缺失 session_id 失败: ${messageOf(error)}`);
      }
    }

    delete detail.summary.linked_mistake_ids;

    const archivePrefix = `images/exam_sheet_archive/${sessionId}`;
    const needsArchive = detail.preview.pages.some(page =>
      (page.blob_hash === undefined || page.blob_hash === null)
      && (page.original_image_path ?? '') !== ''
      && !(page.original_image_path ?? '').startsWith(archivePrefix))
      || detail.preview.pages.some(page => page.cards.some(card =>
        (card.cropped_image_path ?? '') !== ''
        && !(card.cropped_image_path ?? '').startsWith(archivePrefix)));

    if (needsArchive) {
      try {
        await this.archivePreviewAssets(detail.preview, sessionId);
        try {
          this.saveToVfs({ summary: detail.summary, preview: detail.preview });
        } catch (error) {
          this.deps.log.warn(`⚠️ enrich时回写归档后的会话失败: ${messageOf(error)}`);
        }
      } catch (error) {
        this.deps.log.info(`⚠️ [exam-sheet] enrich时归档资源失败: ${messageOf(error)}，将继续使用原路径显示`);
      }
    }

    for (const page of detail.preview.pages) {
      let width = 0;
      let height = 0;
      if (page.width !== undefined && page.width !== null
        && page.height !== undefined && page.height !== null) {
        if (page.width > 0 && page.height > 0) {
          width = page.width;
          height = page.height;
        }
      } else if ((page.original_image_path ?? '') !== '') {
        const abs = this.resolveImagePath(page.original_image_path!);
        try {
          const dims = await this.dimensions(abs);
          width = dims.width;
          height = dims.height;
        } catch (error) {
          this.deps.log.info(`⚠️ [exam-sheet] 读取页面尺寸失败 ${abs}: ${messageOf(error)}`);
        }
      }

      for (const card of page.cards) {
        if (card.resolved_bbox === undefined || card.resolved_bbox === null) {
          if (width > 0 && height > 0) {
            const resolved = clampBbox(card.bbox, width, height);
            card.resolved_bbox = {
              x: resolved.x, y: resolved.y, width: resolved.width, height: resolved.height,
            };
          }
        }
        delete card.linked_mistake_ids;
      }
    }
  }

  async getExamSheetSessionDetail(sessionId: string): Promise<ExamSheetSessionDetail> {
    const detail = this.getFromVfs(sessionId);
    if (detail === null) return notFoundFailure('未找到指定的整卷会话');
    await this.enrichSessionDetail(detail);
    return detail;
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chained = previous.then(() => gate);
    this.locks.set(sessionId, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === chained) this.locks.delete(sessionId);
    }
  }

  private async cropAndSaveAsync(
    originalAbs: string,
    cropAbs: string,
    pixels: BBoxPixels,
    invalidMessage: string,
  ): Promise<void> {
    const image = this.deps.nativeImage();
    let decoded: RgbaImageInput;
    try {
      decoded = await image.decodeRgba(await readFile(originalAbs));
    } catch (error) {
      return failure(AppError.file_system(`加载试卷图片失败: ${ioText(error)}`));
    }
    // exam_sheet_service.rs:526-536,744-756: crop_imm clips to the image, then 0-extent is invalid.
    const cropped = image.cropRgba(decoded, pixels);
    if (cropped.width === 0 || cropped.height === 0) return validationFailure(invalidMessage);
    let png: Uint8Array;
    try {
      png = await this.deps.encodePng(cropped);
    } catch (error) {
      return failure(AppError.file_system(`保存裁剪题目失败: ${messageOf(error)}`));
    }
    try {
      await writeFile(cropAbs, png);
    } catch (error) {
      return failure(AppError.file_system(`保存裁剪题目失败: ${ioText(error)}`));
    }
  }

  async updateExamSheetCards(request: UpdateExamSheetCardsRequest): Promise<ExamSheetUpdateOutcome> {
    const sessionId = request.session_id;
    const cardsRequested = (request.cards?.length ?? 0) > 0
      || (request.create_cards?.length ?? 0) > 0
      || (request.delete_card_ids?.length ?? 0) > 0;
    const renameRequested = request.exam_name !== undefined && request.exam_name !== null;

    if (cardsRequested) {
      let count: number;
      try {
        count = this.deps.questions().countQuestions(this.deps.db(), sessionId);
      } catch (error) {
        return failure(AppError.database(messageOf(error)));
      }
      if (count > 0) {
        return validationFailure('该题目集使用正式题目实体，请通过题目编辑/删除接口操作，不能单独修改兼容预览');
      }
    }
    if (!cardsRequested && !renameRequested) {
      return validationFailure('没有需要更新的内容');
    }

    return await this.withSessionLock(sessionId, async () => {
      const detail = this.getFromVfs(sessionId);
      if (detail === null) return notFoundFailure('未找到指定的整卷会话');
      await this.enrichSessionDetail(detail);

      let pendingUpdates = [...(request.cards ?? [])];
      const createCards = [...(request.create_cards ?? [])];
      const deleteCardIds = [...(request.delete_card_ids ?? [])];
      let anyCardModified = false;

      if (deleteCardIds.length > 0) {
        const deleteSet = new Set(deleteCardIds);
        for (const page of detail.preview.pages) {
          for (const card of page.cards) {
            if (deleteSet.has(card.card_id) && (card.linked_mistake_ids?.length ?? 0) > 0) {
              return validationFailure(`题目 ${card.question_label} 已关联错题，请先解除关联后再删除。`);
            }
          }
        }

        const cropPathsToRemove: string[] = [];
        for (const page of detail.preview.pages) {
          page.cards = page.cards.filter(card => {
            if (!deleteSet.has(card.card_id)) return true;
            if ((card.cropped_image_path ?? '').trim() !== '') {
              cropPathsToRemove.push(card.cropped_image_path!);
            }
            anyCardModified = true;
            return false;
          });
        }
        for (const rel of cropPathsToRemove) {
          const abs = this.resolveImagePath(rel);
          try {
            rmSync(abs);
          } catch (error) {
            this.deps.log.info(`⚠️ [exam-sheet] 删除裁剪图片失败 ${abs}: ${messageOf(error)}`);
          }
        }
        pendingUpdates = pendingUpdates.filter(update => !deleteSet.has(update.card_id));
      }

      if (createCards.length > 0) {
        const archiveRootRel = `images/exam_sheet_archive/${detail.summary.id}`;
        const archiveAbs = this.resolveImagePath(archiveRootRel);
        try {
          mkdirSync(archiveAbs, { recursive: true });
        } catch (error) {
          this.deps.log.info(`⚠️ [exam-sheet] 创建 archive 目录失败 ${archiveAbs}: ${messageOf(error)}`);
        }

        for (const create of createCards) {
          const page = detail.preview.pages[create.page_index];
          if (page === undefined) {
            return validationFailure(`新增题目失败：未找到第 ${create.page_index + 1} 页`);
          }

          const pageAbs = this.resolveImagePath(page.original_image_path ?? '');
          let imgWidth: number;
          let imgHeight: number;
          try {
            const dims = await this.dimensions(pageAbs);
            imgWidth = dims.width;
            imgHeight = dims.height;
          } catch (error) {
            return failure(AppError.file_system(`读取试卷图片尺寸失败: ${messageOf(error)}`));
          }

          let candidate: BBoxPixels;
          if (create.resolved_bbox !== undefined && create.resolved_bbox !== null) {
            candidate = resolvedBboxToPixels(create.resolved_bbox, imgWidth, imgHeight);
          } else if (create.bbox !== undefined && create.bbox !== null) {
            candidate = clampBbox(create.bbox, imgWidth, imgHeight);
          } else {
            return validationFailure('新增题目缺少分割框信息');
          }

          if (candidate.width < 4 || candidate.height < 4) {
            return validationFailure('新增题目的分割框过小');
          }

          const maxWidth = Math.max(1, imgWidth);
          const maxHeight = Math.max(1, imgHeight);
          const normalizedBbox: BBox = {
            x: Math.min(Math.max(candidate.x / maxWidth, 0), 1),
            y: Math.min(Math.max(candidate.y / maxHeight, 0), 1),
            width: Math.min(Math.max(candidate.width / maxWidth, 0), 1),
            height: Math.min(Math.max(candidate.height / maxHeight, 0), 1),
          };
          const resolvedBbox: BBox = {
            x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height,
          };

          let label = create.question_label === undefined || create.question_label === null
            ? null : trimOwned(create.question_label);
          if (label === null) label = `Q${page.cards.length + 1}`;
          if (label.trim() === '') label = `Q${page.cards.length + 1}`;

          const slug = sanitizeLabel(label);
          const newCardId = `${detail.summary.temp_id}-${globalThis.crypto.randomUUID()}`;
          const timestampPrefix = utcTimestampPrefix();
          const suffix = [...newCardId].filter(char => /^[A-Za-z0-9]$/.test(char)).slice(0, 8).join('');
          const cropFilename = `${timestampPrefix}_p${create.page_index}_${slug}_${suffix}.png`;
          const cropRel = `${archiveRootRel}/${cropFilename}`;
          const cropAbs = this.resolveImagePath(cropRel);
          try {
            mkdirSync(path.dirname(cropAbs), { recursive: true });
          } catch (error) {
            this.deps.log.info(`⚠️ [exam-sheet] 创建裁剪目录失败 ${path.dirname(cropAbs)}: ${messageOf(error)}`);
          }

          await this.cropAndSaveAsync(pageAbs, cropAbs, candidate, '新增题目的分割框无效');

          const tags = [...new Set((create.tags ?? [])
            .map(tag => trimOwned(tag))
            .filter((tag): tag is string => tag !== null))].sort(compareUtf8);

          const newCard: ExamCardPreview = {
            card_id: newCardId,
            page_index: create.page_index,
            question_label: label,
            bbox: normalizedBbox,
            resolved_bbox: resolvedBbox,
            cropped_image_path: cropRel,
            ocr_text: create.ocr_text ?? '',
            tags,
            status: 'new',
            attempt_count: 0,
            correct_count: 0,
            source_type: 'ocr_image',
          };
          page.cards.push(newCard);
          page.cards.sort((a, b) =>
            (a.resolved_bbox?.y ?? 0) - (b.resolved_bbox?.y ?? 0));
          anyCardModified = true;
        }
      }

      const cardLookup = new Map<string, [number, number]>();
      detail.preview.pages.forEach((page, pageIndex) => {
        page.cards.forEach((card, cardIndex) => cardLookup.set(card.card_id, [pageIndex, cardIndex]));
      });
      const updateMap = new Map<string, (typeof pendingUpdates)[number]>();
      for (const update of pendingUpdates) updateMap.set(update.card_id, update);

      const pageDimsCache = new Map<number, { width: number; height: number }>();

      for (const [cardId, update] of updateMap) {
        const location = cardLookup.get(cardId);
        if (location === undefined) return notFoundFailure(`未找到题目卡片: ${cardId}`);
        const [pageIndex, cardIndex] = location;
        const page = detail.preview.pages[pageIndex];
        if (page === undefined) return notFoundFailure('题目所在页不存在');
        const card = page.cards[cardIndex];
        if (card === undefined) return notFoundFailure('题目不存在');

        let hasChange = false;

        if (update.question_label !== undefined && update.question_label !== null) {
          const trimmed = trimOwned(update.question_label);
          if (trimmed !== null && trimmed !== card.question_label) {
            card.question_label = trimmed;
            hasChange = true;
          }
        }

        if (update.tags !== undefined && update.tags !== null) {
          const sanitized = update.tags
            .map(tag => trimOwned(tag))
            .filter((tag): tag is string => tag !== null);
          if (sanitized.length !== card.tags.length
            || sanitized.some((tag, index) => tag !== card.tags[index])) {
            card.tags = sanitized;
            hasChange = true;
          }
        }

        if (update.ocr_text !== undefined && update.ocr_text !== null) {
          const trimmed = trimOwned(update.ocr_text);
          if (trimmed !== null && trimmed !== card.ocr_text) {
            card.ocr_text = trimmed;
            hasChange = true;
          }
        }

        if (update.bbox !== undefined && update.bbox !== null
          || update.resolved_bbox !== undefined && update.resolved_bbox !== null) {
          let dims = pageDimsCache.get(pageIndex);
          if (dims === undefined) {
            try {
              dims = await this.dimensions(this.resolveImagePath(page.original_image_path ?? ''));
            } catch (error) {
              return failure(AppError.file_system(`读取试卷图片尺寸失败: ${messageOf(error)}`));
            }
            pageDimsCache.set(pageIndex, dims);
          }

          if (dims.width > 0 && dims.height > 0) {
            const pixels = update.resolved_bbox !== undefined && update.resolved_bbox !== null
              ? resolvedBboxToPixels(update.resolved_bbox, dims.width, dims.height)
              : normalizedBboxToPixels(update.bbox!, dims.width, dims.height);

            if (pixels.width > 0 && pixels.height > 0) {
              const normalized: BBox = {
                x: Math.min(Math.max(pixels.x / Math.max(1, dims.width), 0), 1),
                y: Math.min(Math.max(pixels.y / Math.max(1, dims.height), 0), 1),
                width: Math.min(Math.max(pixels.width / Math.max(1, dims.width), 0), 1),
                height: Math.min(Math.max(pixels.height / Math.max(1, dims.height), 0), 1),
              };
              const resolved: BBox = {
                x: pixels.x, y: pixels.y, width: pixels.width, height: pixels.height,
              };
              const existingResolved = card.resolved_bbox ?? ZERO_BBOX;

              if (!approxEqBbox(normalized, card.bbox) || !approxEqBbox(resolved, existingResolved)) {
                const cropAbs = this.resolveImagePath(card.cropped_image_path ?? '');
                await this.cropAndSaveAsync(
                  this.resolveImagePath(page.original_image_path ?? ''),
                  cropAbs, pixels, '调整后的分割框无效 (0 宽或高)');
                card.bbox = normalized;
                card.resolved_bbox = resolved;
                hasChange = true;
              }
            }
          }
        }

        if (hasChange) anyCardModified = true;
      }

      const nameState = {
        summary: detail.summary.exam_name ?? null,
        preview: detail.preview.exam_name ?? null,
      };
      if (applyExamNameUpdate(nameState, request.exam_name ?? null)) {
        detail.summary.exam_name = nameState.summary ?? undefined;
        detail.preview.exam_name = nameState.preview;
        anyCardModified = true;
      }

      if (!anyCardModified) {
        return { detail, updated_mistake_ids: [] };
      }

      const tags = [...new Set(detail.preview.pages
        .flatMap(page => page.cards)
        .flatMap(card => card.tags))].sort(compareUtf8);
      const metadata: ExamSheetSessionMetadata = detail.summary.metadata ?? { source_type: 'ocr_image' };
      metadata.tags = tags.length === 0 ? undefined : tags;
      metadata.page_count = detail.preview.pages.length;
      metadata.card_count = detail.preview.pages.reduce((sum, page) => sum + page.cards.length, 0);
      detail.summary.metadata = metadata;
      detail.summary.updated_at = nowTimestamp();

      try {
        this.saveToVfs({ summary: detail.summary, preview: detail.preview });
      } catch (error) {
        return databaseFailure('更新整卷会话失败', error);
      }

      await this.enrichSessionDetail(detail);
      return { detail, updated_mistake_ids: [] };
    });
  }

  async renameExamSheetSession(request: RenameExamSheetSessionRequest): Promise<ExamSheetSessionSummary> {
    const outcome = await this.updateExamSheetCards({
      session_id: request.session_id,
      exam_name: request.exam_name ?? '',
    });
    return outcome.detail.summary;
  }

  decodePreview(value: unknown): ExamSheetPreviewResult {
    return decodePreview(value);
  }

  encodePreview(preview: ExamSheetPreviewResult): Record<string, JsonValue> {
    return encodePreview(preview) as Record<string, JsonValue>;
  }
}

/** Cordis provider: registers as `examSheetSession`. */
export class ExamSheetSessionCordisService extends Service {
  readonly version = 1 as const;
  private readonly core: ExamSheetSessionCore;

  constructor(ctx: Context, deps: ExamSheetSessionDeps) {
    super(ctx, 'examSheetSession');
    this.core = new ExamSheetSessionCore(deps);
  }

  getExamSheetSessionDetail(sessionId: string): Promise<ExamSheetSessionDetail> {
    return this.core.getExamSheetSessionDetail(sessionId);
  }

  updateExamSheetCards(request: UpdateExamSheetCardsRequest): Promise<ExamSheetUpdateOutcome> {
    return this.core.updateExamSheetCards(request);
  }

  renameExamSheetSession(request: RenameExamSheetSessionRequest): Promise<ExamSheetSessionSummary> {
    return this.core.renameExamSheetSession(request);
  }

  decodePreview(value: unknown): ExamSheetPreviewResult {
    return this.core.decodePreview(value);
  }

  encodePreview(preview: ExamSheetPreviewResult): Record<string, JsonValue> {
    return this.core.encodePreview(preview);
  }
}

function utcTimestampPrefix(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `exam_${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}
