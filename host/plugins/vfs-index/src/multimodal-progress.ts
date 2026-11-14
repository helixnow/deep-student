export const MM_INDEX_PROGRESS_EVENT = 'mm_index_progress';

/** Rust `multimodal::types::IndexProgressEvent` (serde camelCase). */
export interface IndexProgressEvent {
  sourceType: string;
  sourceId: string;
  /** preparing / embedding / saving / completed / failed / pending */
  phase: string;
  currentPage: number;
  totalPages: number;
  indexedPages: number;
  skippedPages: number;
  progressPercent: number;
  message: string;
}

export type ProgressSink = ((event: IndexProgressEvent) => void) | null;

/** `IndexProgressEvent::new(type, id, total).with_phase(phase, message).with_progress(current, indexed, skipped)`. */
export function progressEvent(
  sourceType: string, sourceId: string, totalPages: number, phase: string, message: string,
  currentPage: number, indexedPages: number, skippedPages: number,
): IndexProgressEvent {
  return {
    sourceType, sourceId, phase, currentPage, totalPages, indexedPages, skippedPages,
    progressPercent: totalPages > 0 ? Math.trunc((currentPage / totalPages) * 100) : 0,
    message,
  };
}
