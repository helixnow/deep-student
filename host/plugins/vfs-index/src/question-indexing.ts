/** `VfsFullIndexingService::index_question` / `index_exam_questions` (`indexing.rs`). */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { ChunkingConfig } from '../api.ts';
import { chunkText } from './indexing.ts';
import type { LaneLogger } from './logger.ts';
import { refreshCountsFromSegments } from '../repository/index-state.ts';
import { getUnitIdAt, insertIndexingUnitRow, markUnitIndexedRow } from '../repository/index-content.ts';
import {
  MODALITY_TEXT, getFullResource, registerAndIncrementEmbeddingDim,
  replaceSegmentsByUnitAndModality, setUnitIndexProfile, type CreateSegmentInput,
} from '../repository/index-units.ts';
import type { VfsEmbeddingPipeline } from './embedding.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import { inTransaction, messageOf } from './indexing-content.ts';
import type { IndexingLanceStore } from './full-indexing-types.ts';

export interface QuestionIndexingContext {
  readonly db: SqlExecutor;
  readonly pipeline: VfsEmbeddingPipeline;
  readonly lanceStore: IndexingLanceStore;
  readonly chunkingConfig: ChunkingConfig;
  readonly questionRepo: QuestionRepository | undefined;
  readonly logger: LaneLogger | undefined;
}

/**
 * `VfsFullIndexingService::index_question`: index one question's content,
 * options, answer, explanation, tags and note as a text unit.
 */
export async function indexQuestion(
  ctx: QuestionIndexingContext, questionId: string, examId: string,
): Promise<[number, number]> {
  if (ctx.questionRepo === undefined) {
    throw new Error('L11 vfsRepo questions service is not available');
  }
  const question = ctx.questionRepo.getQuestion(ctx.db, questionId);
  if (question === null) {
    throw new Error(`Question not found: ${questionId}`);
  }
  const texts: string[] = [];
  if (rustTrim(question.content) !== '') texts.push(`题目: ${rustTrim(question.content)}`);
  if (question.options !== null) {
    for (const option of question.options) texts.push(`选项${option.key}: ${option.content}`);
  }
  if (question.answer !== null && rustTrim(question.answer) !== '') {
    texts.push(`答案: ${rustTrim(question.answer)}`);
  }
  if (question.explanation !== null && rustTrim(question.explanation) !== '') {
    texts.push(`解析: ${rustTrim(question.explanation)}`);
  }
  if (question.tags.length > 0) texts.push(`标签: ${question.tags.join(', ')}`);
  if (question.user_note !== null && rustTrim(question.user_note) !== '') {
    texts.push(`笔记: ${rustTrim(question.user_note)}`);
  }
  if (texts.length === 0) return [0, 0];

  const chunks = chunkText(texts.join('\n\n'), ctx.chunkingConfig);
  if (chunks.length === 0) return [0, 0];

  const examResource = getFullResource(ctx.db, examId);
  const folderId = examResource?.sourceId ?? null;

  let unitId: string | null = null;
  try {
    unitId = getUnitIdAt(ctx.db, questionId, 0);
  } catch (lookupError) {
    ctx.logger?.warn(`[VfsFullIndexingService] Failed to look up question unit: ${messageOf(lookupError)}`);
  }
  if (unitId === null) {
    unitId = `unit_${nanoid(10)}`;
    try {
      insertIndexingUnitRow(ctx.db, unitId, questionId, Date.now());
    } catch (insertError) {
      ctx.logger?.warn(`[VfsFullIndexingService] Failed to insert question unit: ${messageOf(insertError)}`);
    }
  }

  const result = await ctx.pipeline.indexChunks(
    questionId, unitId, 'question', folderId, chunks, MODALITY_TEXT, null,
  );
  const count = result.count;
  const dim = result.dim;
  if (result.index_profile_id === null) {
    throw new Error('question indexing result missing index_profile_id');
  }
  if (result.generation === null) {
    throw new Error('question indexing result missing generation');
  }
  const embeddingIds = result.embedding_ids;
  if (count > 0) {
    try {
      inTransaction(ctx.db, (tx) => {
        registerAndIncrementEmbeddingDim(tx, dim, MODALITY_TEXT, 0);
        setUnitIndexProfile(tx, unitId!, MODALITY_TEXT, result.index_profile_id!, result.generation!);
        if (embeddingIds.length !== chunks.length) {
          throw new Error(
            `question embedding_id mismatch: expected ${chunks.length}, got ${embeddingIds.length}`,
          );
        }
        const inputs: CreateSegmentInput[] = chunks.map((chunk, index) => ({
          unitId: unitId!,
          segmentIndex: chunk.index,
          modality: MODALITY_TEXT,
          embeddingDim: dim,
          lanceRowId: embeddingIds[index]!,
          contentText: chunk.text,
          startPos: chunk.start_pos,
          endPos: chunk.end_pos,
          metadataJson: null,
        }));
        replaceSegmentsByUnitAndModality(tx, questionId, unitId!, MODALITY_TEXT, inputs);
        markUnitIndexedRow(tx, unitId!, Date.now(), count, dim);
        refreshCountsFromSegments(tx);
      });
    } catch (syncError) {
      ctx.logger?.error(
        `[VfsFullIndexingService] SQLite metadata sync failed for question ${questionId}, rolling back Lance vectors: ${messageOf(syncError)}`,
      );
      try {
        await ctx.lanceStore.discardUncommittedRows?.(
          MODALITY_TEXT, questionId, embeddingIds,
        );
      } catch (rollbackError) {
        ctx.logger?.error(
          `[VfsFullIndexingService] Lance rollback also failed for question ${questionId}: ${messageOf(rollbackError)}`,
        );
      }
      throw syncError;
    }

    try {
      await ctx.lanceStore.deleteByUnitExceptIds?.(
        MODALITY_TEXT, questionId, unitId, embeddingIds,
      );
    } catch (cleanupError) {
      ctx.logger?.warn(
        `[VfsFullIndexingService] Deferred cleanup for question Unit ${unitId} failed: ${messageOf(cleanupError)}`,
      );
    }
  }
  return [count, dim];
}

/** `VfsFullIndexingService::index_exam_questions` (page 1, page size 1000). */
export async function indexExamQuestions(
  ctx: QuestionIndexingContext, examId: string,
  indexOne: (questionId: string) => Promise<[number, number]>,
): Promise<[number, number]> {
  if (ctx.questionRepo === undefined) {
    throw new Error('L11 vfsRepo questions service is not available');
  }
  const result = ctx.questionRepo.listQuestions(ctx.db, examId, {}, 1, 1000);
  if (result.questions.length === 0) return [0, 0];
  let success = 0;
  let failed = 0;
  for (const question of result.questions) {
    try {
      await indexOne(question.id);
      success += 1;
    } catch (error) {
      ctx.logger?.warn(`[VfsFullIndexingService] Failed to index question ${question.id}: ${messageOf(error)}`);
      failed += 1;
    }
  }
  if (success > 0) {
    try {
      refreshCountsFromSegments(ctx.db);
    } catch (refreshError) {
      ctx.logger?.warn(
        `[VfsFullIndexingService] Failed to refresh counts after batch indexing exam ${examId}: ${messageOf(refreshError)}`,
      );
    }
  }
  return [success, failed];
}
