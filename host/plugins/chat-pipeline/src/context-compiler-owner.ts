/** context_compiler.rs:721–735/832–859 — caller side of the L02 high-level owner operations. */
import * as path from '../../../platform/util/path.ts';
import { join } from '../../../platform/util/path.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { ChatV2Error } from '../../chat/api.ts';
import type { ImagePayload, StandardModel2Output } from '../../llm/api.ts';
import { decodeBase64Standard } from '../../../platform/util/portable.ts';
import type { ContextCompilationPorts } from './context-compiler.ts';
import type { RuntimeImage } from './images.ts';

/** `ctx.files` 中 OCR 临时目录用到的操作。 */
export type ContextCompilerTempFiles = Pick<FilesService, 'mkdir' | 'writeBytes' | 'rm'>;

/** Required consumption contract. L02's candidate ContextCompilerLlmOwner is not a provided service.
 * Keep this explicit until the owner implementation is normally integrated; no low-level substitute.
 */
export interface ContextCompilerLlmCalls {
  callRawPromptWithConfigIdAndImagesCancellable(configId: string, prompt: string, images: ImagePayload[],
    callerType: 'chat_v2', cancellation: AbortSignal): Promise<StandardModel2Output>;
  callDedicatedOcrFreeTextWithFallback(imagePath: string, cancellation: AbortSignal): Promise<string>;
}

/** Cancellation drops the caller future even if an owner operation has not settled yet. */
async function untilCancelled<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new ChatV2Error('Cancelled');
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ChatV2Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([call(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** tempfile::NamedTempFile Drop ignores unlink failure, including unwinding/error paths. */
async function removeOwnedTemp(files: ContextCompilerTempFiles, directory: string): Promise<boolean> {
  try { await files.rm(directory, { recursive: true, force: true }); return true; }
  catch { return false; }
}

/** `tempfile::Builder::prefix(..).tempdir_in(..)`：唯一且尚不存在的子目录。 */
async function createOwnedTempDir(files: ContextCompilerTempFiles, parent: string): Promise<string> {
  const directory = join(parent, `chat-v2-ocr-${globalThis.crypto.randomUUID()}`);
  await files.mkdir(directory);
  return directory;
}

async function ocrRuntimeImage(image: RuntimeImage, signal: AbortSignal,
  owner: ContextCompilerLlmCalls, temporaryDirectory: string, files: () => ContextCompilerTempFiles): Promise<string> {
  const decoded = decodeBase64Standard(image.base64);
  if (decoded.error !== undefined) throw new Error(`invalid image base64: ${decoded.error}`);
  const suffix = image.mimeType === 'image/png' ? '.png' : image.mimeType === 'image/webp' ? '.webp'
    : image.mimeType === 'image/gif' ? '.gif' : '.jpg';
  const store = files();
  const directory = await createOwnedTempDir(store, temporaryDirectory);
  try {
    const imagePath = path.join(directory, `chat-v2-ocr-image${suffix}`);
    if (signal.aborted) throw new ChatV2Error('Cancelled');
    await store.writeBytes(imagePath, decoded.bytes, { exclusive: true, unixMode: 0o600 });
    return await untilCancelled(signal, () => owner.callDedicatedOcrFreeTextWithFallback(imagePath, signal));
  } finally { await removeOwnedTemp(store, directory); }
}

export function bindContextCompilationPorts(owner: ContextCompilerLlmCalls,
  resolveCanonicalImages: ContextCompilationPorts['resolveCanonicalImages'],
  temporaryDirectory: string, files: () => ContextCompilerTempFiles): ContextCompilationPorts {
  return {
    resolveCanonicalImages,
    async observeImages(configId, prompt, images, signal) {
      const result = await untilCancelled(signal, () => owner.callRawPromptWithConfigIdAndImagesCancellable(
        configId, prompt, images, 'chat_v2', signal));
      // Rust compiler consumes assistant_message only; retries/usage/protocol remain owned by L02.
      return result.assistant_message;
    },
    ocrImage: (image, signal) => ocrRuntimeImage(image, signal, owner, temporaryDirectory, files),
  };
}
