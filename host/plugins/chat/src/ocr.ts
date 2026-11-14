/** Pure OCR command, Rust handlers/ocr.rs:45-177 (no session or filesystem writes). */
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { decodeBase64Standard } from '../../../platform/util/portable.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { isNativeOcrEngine, performSystemOcr, OcrError, type OcrAdapter } from '../../llm-providers/api.ts';
import type { ImagePayload } from '../../llm/api.ts';
import type { OcrRequest, OcrResponse } from '../api.ts';
import { ChatV2Error } from './error.ts';
import { errorText, type ChatLogger } from './logger.ts';

/** Pending L02 API publication; production resolves these methods on ctx.llm. */
export interface OcrManager {
  getOcrAdapter(): Promise<Pick<OcrAdapter, 'engineType' | 'buildPrompt'>>;
  callOcrModelRawPrompt(prompt: string, images: ImagePayload[] | null): Promise<{ assistantMessage: string }>;
}

function parseImage(data: string, index: number): Uint8Array {
  const payload = data.startsWith('data:') ? data.split(',')[1] : data;
  if (payload === undefined) throw new ChatV2Error('Validation', `Failed to parse image ${index}: Invalid data URL format`);
  const decoded = decodeBase64Standard(payload);
  if (decoded.error !== undefined) {
    throw new ChatV2Error('Validation', `Failed to parse image ${index}: Base64 decode error: ${decoded.error}`);
  }
  return decoded.bytes;
}

function imageMime(data: string): string {
  for (const format of ['png', 'gif', 'webp', 'bmp', 'heic', 'heif']) {
    if (data.startsWith(`data:image/${format}`)) return `image/${format}`;
  }
  return 'image/jpeg';
}

export async function performOcr(request: OcrRequest, manager: OcrManager | undefined, log: ChatLogger): Promise<OcrResponse> {
  log.info(`[ChatV2::OCR] Performing OCR: images_count=${request.images.length}`);
  if (request.images.length === 0) throw new ChatV2Error('Validation', 'At least one image is required');
  if (!manager) throw new ChatV2Error('Other', 'LLM OCR adapter/raw prompt service is unavailable');
  const adapter = await manager.getOcrAdapter();
  let text = '';
  if (isNativeOcrEngine(adapter.engineType())) {
    log.info('[ChatV2::OCR] Using system native OCR engine');
    for (const [index, image] of request.images.entries()) {
      const bytes = parseImage(image, index);
      let part: string;
      try { part = await performSystemOcr(bytes); }
      catch (error) {
        const display = error instanceof OcrError ? error.display() : errorText(error);
        log.error(`[ChatV2::OCR] System OCR failed for image ${index}: ${display}`);
        throw new ChatV2Error('Llm', `System OCR failed: ${display}`);
      }
      if (text !== '' && part !== '') text += '\n\n';
      text += part;
    }
  } else {
    const prompt = adapter.buildPrompt('free_ocr');
    const images = request.images.map((image, index) => ({
      mime: imageMime(image), base64: toBase64(parseImage(image, index)),
    }));
    try { text = rustTrim((await manager.callOcrModelRawPrompt(prompt, images)).assistantMessage); }
    catch (error) {
      log.error(`[ChatV2::OCR] OCR failed: ${errorText(error)}`);
      throw new ChatV2Error('Llm', `OCR failed: ${errorText(error)}`);
    }
  }
  log.info(`[ChatV2::OCR] OCR completed: text_len=${utf8ByteLength(text)}, tags_count=0, type=`);
  return { ocr_text: text, tags: [], mistake_type: '' };
}
