import type { ProcessingIssue, ProcessingProgress, ProcessingStage } from '../api.ts';
import { MediaError, type MediaTranscriptionResult } from '../../media/api.ts';
import type { MediaPipelineFailure, PdfProgressCallbacks } from './pdf-service.ts';
import { messageOf, type PdfNativeRuntimeDeps, type PdfRuntimeFile } from './pdf-runtime-deps.ts';

/**
 * `pdf_processing_service.rs::run_media_pipeline_internal` (941-1105): L18
 * owns decoding/ASR/persistence through `mediaTranscriber`; this runtime owns
 * the shared task status, events and the post-transcript vector-index hop.
 */
export async function runMediaStage(
  deps: PdfNativeRuntimeDeps,
  file: PdfRuntimeFile,
  mediaType: 'audio' | 'video',
  tempDir: string,
  signal: AbortSignal,
  callbacks: PdfProgressCallbacks,
): Promise<{
  readyModes: string[];
  failedStages?: ProcessingIssue[];
  completedSegments?: number;
  totalSegments?: number;
  transcriptionFailure?: MediaPipelineFailure;
}> {
  const transcriber = deps.transcriber?.();
  if (transcriber === undefined) {
    // Rust `hooks::media_transcriber()` returns None until
    // `register_media_transcriber` runs; the task then fails explicitly.
    throw new Error(
      'media transcriber not registered (L18 mediaTranscriber 待 ds-mig/L18-media-docs 合入 main)',
    );
  }
  const repositories = deps.repositories();
  let imported = false;
  if (repositories !== undefined) {
    const plan = repositories.mediaTranscripts.planInfo(deps.db, file.id);
    imported = plan !== null && plan[1] === 'import';
  }
  let currentStage = 'queued';
  let result: MediaTranscriptionResult;
  try {
    result = await transcriber.transcribe({
      fileId: file.id,
      tempDir,
      imported,
      signal,
      onProgress: (update) => {
        // L18 forwards progress synchronously before settling the promise;
        // this also retains the last update delivered immediately before Err.
        currentStage = update.stage;
        const progress: ProcessingProgress = {
          stage: update.stage,
          percent: update.percent,
          readyModes: [],
          mediaType,
        };
        callbacks.progress(update.stage as ProcessingStage, progress, {
          completedSegments: update.completedSegments ?? null,
          totalSegments: update.totalSegments ?? null,
        });
      },
    });
  } catch (error) {
    // Only the actual public L18 error is a MediaTranscriptionFailure.
    // Unknown provider/host exceptions retain the existing outer error path.
    if (!(error instanceof MediaError)) throw error;
    return { readyModes: [], transcriptionFailure: { error, stage: currentStage } };
  }
  const readyModes: string[] = result.transcriptChars > 0 ? ['text'] : [];
  if (result.transcriptChars > 0) {
    callbacks.progress('indexing', {
      stage: 'indexing',
      percent: 92,
      readyModes: [...readyModes],
      mediaType,
    }, {
      completedSegments: result.doneSegments,
      totalSegments: result.totalSegments,
    });
    const indexer = deps.indexing();
    if (indexer !== undefined && file.resourceId !== null) {
      try {
        await indexer.indexResource(file.resourceId, null);
      } catch (error) {
        // Rust logs the failure and still completes with the transcript.
        deps.logger?.warn(
          `[MediaProcessingService] Indexing after transcription failed for ${file.id}: ${messageOf(error)}`,
        );
      }
    }
  }
  if (result.failedSegments > 0) {
    return {
      readyModes,
      failedStages: [{
        stage: 'asr',
        message: `${result.failedSegments} 段转写失败，可重新转写补齐（已完成的段会保留）`,
        retriable: true,
      }],
      completedSegments: result.doneSegments,
      totalSegments: result.totalSegments,
    };
  }
  return {
    readyModes,
    completedSegments: result.doneSegments,
    totalSegments: result.totalSegments,
  };
}
