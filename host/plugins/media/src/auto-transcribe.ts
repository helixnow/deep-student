/**
 * `transcriber_hook.rs::MediaResourceCreatedHook` and
 * `commands.rs::spawn_auto_transcribe_if_short_audio`: short audio imports start
 * transcription in the background. A missing ASR configuration or an ineligible
 * file is skipped silently; the preview page can still start transcription by hand.
 */
import type { NativeAudio } from '../../../platform/native/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { PdfProcessingService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { AsrConfigError } from './asr.ts';
import { loadMediaFile } from './media-commands.ts';
import { autoTranscribeEligible } from './pipeline.ts';

export interface AutoTranscribeDeps {
  /** `try_state::<Arc<VfsDatabase>>()`: undefined when vfs is not loaded. */
  database(): VfsDatabase | undefined;
  repos(): VfsReposService;
  /** `try_state::<Arc<PdfProcessingService>>()`. */
  pipeline(): PdfProcessingService | undefined;
  /** `host::try_services`: undefined when host services are not installed. */
  services(): unknown;
  audio(): NativeAudio;
  /** `voice_input::resolve_asr_endpoint`; rejects when ASR is not configured. */
  resolveAsr(): Promise<unknown>;
  log: { info(message: string): void; warn(message: string): void };
}

export async function autoTranscribeIfShortAudio(deps: AutoTranscribeDeps, fileId: string): Promise<void> {
  const database = deps.database();
  const service = deps.pipeline();
  if (database === undefined || service === undefined || deps.services() === undefined) return;
  try {
    await deps.resolveAsr();
  } catch (error) {
    const code = error instanceof AsrConfigError ? error.code : String(error);
    deps.log.info(`[media::commands] ASR not configured (${code}), skip auto transcription for ${fileId}`);
    return;
  }
  let eligible: boolean;
  try {
    const info = loadMediaFile(database.getConnSafe(), fileId);
    eligible = await autoTranscribeEligible(database, deps.repos(), info, deps.audio());
  } catch {
    // `.ok().and_then(|r| r.ok()).unwrap_or(false)`: load / source errors are "not eligible".
    eligible = false;
  }
  if (!eligible) return;
  try {
    await service.startPipeline(fileId, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn(`[media::commands] auto transcription failed to start for ${fileId}: ${message}`);
  }
}

/** `tauri::async_runtime::spawn`: the upload command returns before the hook does any work. */
export function createAutoTranscribeHook(deps: AutoTranscribeDeps): (resourceId: string) => void {
  return (resourceId) => {
    setTimeout(() => { void autoTranscribeIfShortAudio(deps, resourceId); }, 0);
  };
}
