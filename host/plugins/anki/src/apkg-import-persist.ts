/**
 * APKG 导入落库：任务 + 卡片 + 可选 FSRS 状态 + 事务后模板补建。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { CreateTemplateRequest } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import {
  insertApkgCard,
  insertApkgDocumentTask,
  listExistingApkgCardFingerprints,
} from '../repository/apkg-import.ts';
import { getTemplateById, insertTemplate } from '../repository/templates.ts';
import type {} from './apkg-import-collection.ts';
import {
  emptyApkgMediaReport,
  type ApkgImportResult,
  type ApkgReviewEnqueueReport,
} from './apkg-types.ts';
import { nowRfc3339 } from './time.ts';
import type { AnkiLogger } from './logger.ts';
import {
  databaseError,
  errorMessage,
  isAppErrorValue,
  trimWhitespace,
  rustFileName,
  type ApkgImportRuntime,
  type FsrsImportEnqueueSummary,
  type ParsedCard,
  type ParsedPackage,
  type TemplateImportCandidate,
} from './apkg-import-types.ts';
import { ankiSchedToFsrs, type EnqueueSeed } from './apkg-import-fsrs.ts';

// ============================================================================
// 持久化 + 模板补建
// ============================================================================

export function safeSourceName(sourceName: string): string {
  const name = rustFileName(sourceName);
  const trimmed = name === null ? '' : trimWhitespace(name);
  if (trimmed === '') return 'imported.apkg';
  return Array.from(trimmed).slice(0, 255).join('');
}

/** `import_template_candidates`：仅补建本地缺失、且携带 deepStudentTemplateId 的模板。 */
export function importTemplateCandidates(
  db: SqlExecutor,
  candidates: readonly TemplateImportCandidate[],
  warnings: string[],
  logger: Pick<AnkiLogger, 'warn'>,
): number {
  let imported = 0;
  for (const candidate of candidates) {
    try {
      const existing = getTemplateById(db, candidate.templateId);
      if (existing !== undefined) continue; // 本地已有同 id 模板：以本地为准，不覆盖
    } catch (error) {
      warnings.push(`查询本地模板失败，跳过模板导入 ${candidate.templateId}: ${errorMessage(error)}`);
      continue;
    }
    if (trimWhitespace(candidate.frontTemplate) === ''
      || trimWhitespace(candidate.backTemplate) === ''
      || candidate.fields.length === 0) {
      warnings.push(
        `APKG 模型缺少可用的模板正反面/字段定义，跳过模板导入: ${candidate.templateId}`,
      );
      continue;
    }
    const request: CreateTemplateRequest = {
      name: candidate.name,
      description: 'Imported from an APKG package',
      author: null,
      version: '1.0.0',
      preview_front: '',
      preview_back: '',
      note_type: candidate.noteType,
      fields: [...candidate.fields],
      generation_prompt: '',
      front_template: candidate.frontTemplate,
      back_template: candidate.backTemplate,
      css_style: candidate.cssStyle,
      field_extraction_rules: {},
      preview_data_json: null,
      is_active: true,
      is_built_in: false,
    };
    try {
      insertTemplate(db, candidate.templateId, request, nowRfc3339());
      imported += 1;
    } catch (error) {
      logger.warn(`APKG 模板导入失败 ${candidate.templateId} (${candidate.name}): ${errorMessage(error)}`);
      warnings.push(
        `模板导入失败（可能与现有模板重名）${candidate.templateId}: ${errorMessage(error)}`,
      );
    }
  }
  return imported;
}

export interface PersistPackageResult {
  result: ApkgImportResult;
  warnings: string[];
}

function apkgCardFingerprintKey(
  modelId: string,
  noteId: string,
  cardOrd: string,
  front: string,
  back: string,
  text: string | null,
): string {
  return JSON.stringify([modelId, noteId, cardOrd, front, back, text]);
}

/** `persist_package`：一个 immediate 事务写入任务 + 全部卡片 +（可选）FSRS 状态。 */
export function persistPackage(
  runtime: ApkgImportRuntime,
  parsedPackage: ParsedPackage,
  sourceName: string,
  sessionId: string | null,
  enqueueForReview: boolean,
  deduplicateExisting = false,
): ApkgImportResult {
  const clock = runtime.now ?? Date.now;
  const generatedDocumentId = `apkg-${globalThis.crypto.randomUUID()}`;
  const taskId = `apkg-task-${globalThis.crypto.randomUUID()}`;
  const nowMs = clock();
  const now = toRfc3339(BigInt(nowMs) * 1_000_000n);
  const displayName = safeSourceName(sourceName);
  const mediaSkipped = parsedPackage.mediaSkipped;
  const mediaImported = parsedPackage.mediaImported;
  const mediaReport = parsedPackage.mediaReport;
  const templateCandidates = parsedPackage.templateCandidates;
  const warnings = parsedPackage.warnings;
  const cardIds: string[] = [];
  const collectionCrtSecs = parsedPackage.collectionCrtSecs;
  const reviewSeeds: EnqueueSeed[] = [];

  let txOutcome: {
    documentId: string;
    importedCards: number;
    skippedDuplicates: number;
    reviewEnqueue: ApkgReviewEnqueueReport | null;
  };
  try {
    txOutcome = runtime.db.transaction((tx) => {
      let cardsToInsert: ParsedCard[] = parsedPackage.cards;
      let skippedDuplicates = 0;
      let matchedDocumentId: string | null = null;

      if (deduplicateExisting) {
        const existingDocByKey = new Map<string, string>();
        for (const existing of listExistingApkgCardFingerprints(tx)) {
          if (existing.modelId === '' || existing.noteId === '' || existing.cardOrd === '') continue;
          const key = apkgCardFingerprintKey(
            existing.modelId,
            existing.noteId,
            existing.cardOrd,
            existing.front,
            existing.back,
            existing.text,
          );
          if (!existingDocByKey.has(key)) {
            existingDocByKey.set(key, existing.documentId);
          }
        }
        cardsToInsert = [];
        for (const card of parsedPackage.cards) {
          const modelId = card.extraFields.AnkiModelId ?? '';
          const noteId = card.extraFields.AnkiNoteId ?? '';
          const cardOrd = card.extraFields.AnkiCardOrd ?? '';
          if (modelId !== '' && noteId !== '' && cardOrd !== '') {
            const key = apkgCardFingerprintKey(
              modelId,
              noteId,
              cardOrd,
              card.front,
              card.back,
              card.text,
            );
            const existingDocId = existingDocByKey.get(key);
            if (existingDocId !== undefined) {
              skippedDuplicates += 1;
              if (matchedDocumentId === null) matchedDocumentId = existingDocId;
              continue;
            }
          }
          cardsToInsert.push(card);
        }
      }

      const importedCards = cardsToInsert.length;
      const effectiveDocumentId = importedCards === 0 && matchedDocumentId !== null
        ? matchedDocumentId
        : generatedDocumentId;

      if (importedCards > 0) {
        const options = JSON.stringify({
          deck_name: parsedPackage.deckNames[0] ?? 'Imported APKG',
          note_type: 'Imported',
          enable_images: false,
          max_cards_per_mistake: importedCards,
          segment_overlap_size: 0,
          source_type: 'apkg_import',
          imported_decks: parsedPackage.deckNames,
        });
        try {
          insertApkgDocumentTask(tx, {
            id: taskId,
            documentId: effectiveDocumentId,
            originalDocumentName: displayName,
            optionsJson: options,
            sessionId,
            now,
          });
        } catch (error) {
          throw databaseError(`Failed to create APKG document task: ${errorMessage(error)}`);
        }
        cardsToInsert.forEach((card, index) => {
          const cardId = globalThis.crypto.randomUUID();
          try {
            insertApkgCard(tx, {
              id: cardId,
              taskId,
              front: card.front,
              back: card.back,
              text: card.text,
              tagsJson: JSON.stringify(card.tags),
              imagesJson: JSON.stringify(card.images),
              cardOrderInTask: index,
              now,
              extraFieldsJson: JSON.stringify(card.extraFields),
              templateId: card.templateId,
              documentId: effectiveDocumentId,
            });
          } catch (error) {
            throw databaseError(
              `Failed to insert APKG card ${index + 1} of ${importedCards}: ${errorMessage(error)}`,
            );
          }
          if (enqueueForReview) {
            reviewSeeds.push({
              cardId,
              seed: card.ankiSched === null
                ? null
                : ankiSchedToFsrs(card.ankiSched, collectionCrtSecs, nowMs),
              ...(card.ankiRevlog && card.ankiRevlog.length > 0
                ? { reviewLogs: card.ankiRevlog }
                : {}),
            });
          }
          cardIds.push(cardId);
        });
      }

      if (!enqueueForReview) {
        return {
          documentId: effectiveDocumentId,
          importedCards,
          skippedDuplicates,
          reviewEnqueue: null,
        };
      }
      const fsrsOwner = runtime.fsrsOwner;
      if (fsrsOwner === null || fsrsOwner === undefined) {
        throw databaseError(
          'Failed to enqueue imported APKG cards for review: '
          + 'review service does not publish enqueueImportedCardsInTx',
        );
      }
      let summary: FsrsImportEnqueueSummary;
      try {
        summary = fsrsOwner.enqueueImportedCardsInTx(tx, reviewSeeds);
      } catch (error) {
        throw databaseError(
          `Failed to enqueue imported APKG cards for review: ${errorMessage(error)}`,
        );
      }
      return {
        documentId: effectiveDocumentId,
        importedCards,
        skippedDuplicates,
        reviewEnqueue: {
          enqueued: summary.enqueued,
          withHistory: summary.withHistory,
          suspended: summary.suspended,
        },
      };
    }, { behavior: 'immediate' });
  } catch (error) {
    if (isAppErrorValue(error)) throw error;
    throw databaseError(`Failed to commit APKG import transaction: ${errorMessage(error)}`);
  }

  if (txOutcome.skippedDuplicates > 0) {
    warnings.push(`跳过 ${txOutcome.skippedDuplicates} 张已存在的重复卡片`);
  }

  // 模板映射导入（卡片事务成功后执行，失败不回滚卡片、只产生结构化告警）。
  const importedTemplates = importTemplateCandidates(runtime.db, templateCandidates, warnings, runtime.logger);

  return {
    documentId: txOutcome.documentId,
    importedCards: txOutcome.importedCards,
    importedTemplates,
    mediaSkipped,
    mediaImported,
    mediaReport,
    warnings,
    cardIds,
    reviewEnqueue: txOutcome.reviewEnqueue,
  };
}
