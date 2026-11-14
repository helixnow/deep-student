/**
 * 生成流程推给前端的 `anki_generation_event` 事件与任务状态更新
 * （`dstu-anki/src/streaming_anki_service.rs` 事件发送段）。发送失败只记 error，不中断任务。
 */
import type { AnkiCard, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';
import type { AnkiLogger } from './logger.ts';
import { buildTaskCompletedEvent, type StreamStats } from './streaming-anki.ts';
import type { DocumentProcessingService } from './document-processing.ts';
import type { AnkiEventWindow } from './enhanced-service.ts';
import { generationErrorMessage } from './generation-service.ts';

export function updateTaskStatus(
  logger: Pick<AnkiLogger, 'error'>,
  processor: DocumentProcessingService,
  taskId: string,
  status: TaskStatus,
  message: string | null,
  segmentIndex: number | null,
  documentId: string | null,
  window: AnkiEventWindow,
): void {
  processor.updateTaskStatus(taskId, status, message);
  try {
    window.emit('anki_generation_event', {
      TaskStatusUpdate: {
        task_id: taskId,
        status,
        message,
        segment_index: segmentIndex,
        document_id: documentId,
      },
    });
  } catch (error) {
    logger.error(`发送任务状态更新事件失败: ${generationErrorMessage(error)}`);
  }
}

export function emitNewCard(logger: Pick<AnkiLogger, 'error'>, card: AnkiCard, documentId: string, window: AnkiEventWindow): void {
  try {
    window.emit('anki_generation_event', { NewCard: { card, document_id: documentId } });
  } catch (error) {
    logger.error(`发送新卡片事件失败: ${generationErrorMessage(error)}`);
  }
}

export function emitErrorCard(logger: Pick<AnkiLogger, 'error'>, card: AnkiCard, documentId: string, window: AnkiEventWindow): void {
  try {
    window.emit('anki_generation_event', { NewErrorCard: { card, document_id: documentId } });
  } catch (error) {
    logger.error(`发送错误卡片事件失败: ${generationErrorMessage(error)}`);
  }
}

export function emitGenerationStats(
  logger: Pick<AnkiLogger, 'error'>,
  taskId: string,
  documentId: string,
  stats: StreamStats,
  window: AnkiEventWindow,
): void {
  try {
    window.emit('anki_generation_event', {
      GenerationStats: {
        task_id: taskId,
        document_id: documentId,
        cards_generated: stats.card_count,
        failed_cards: stats.failed_cards,
        duplicate_cards: stats.duplicate_cards,
        dropped_fragments: stats.dropped_fragments,
        flagged_cards: stats.flagged_cards,
      },
    });
  } catch (error) {
    logger.error(`发送生成统计事件失败: ${generationErrorMessage(error)}`);
  }
}

export function emitGenerationWarning(
  logger: Pick<AnkiLogger, 'error'>,
  taskId: string,
  documentId: string,
  reason: string,
  fragment: string,
  window: AnkiEventWindow,
): void {
  try {
    window.emit('anki_generation_event', {
      GenerationWarning: {
        task_id: taskId,
        document_id: documentId,
        reason,
        fragment_preview: Array.from(fragment).slice(0, 200).join(''),
      },
    });
  } catch (error) {
    logger.error(`发送生成警告事件失败: ${generationErrorMessage(error)}`);
  }
}

export function completeTaskSuccessfully(
  logger: Pick<AnkiLogger, 'error'>,
  processor: DocumentProcessingService,
  taskId: string,
  stats: StreamStats,
  documentId: string,
  window: AnkiEventWindow,
): void {
  updateTaskStatus(logger, processor, taskId, 'Completed', null, null, documentId, window);
  try {
    window.emit(
      'anki_generation_event',
      buildTaskCompletedEvent(taskId, documentId, stats, logger),
    );
  } catch (error) {
    logger.error(`发送任务完成事件失败: ${generationErrorMessage(error)}`);
  }
}
