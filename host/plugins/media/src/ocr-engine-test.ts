/** Rust `src/cmd/ocr.rs:566-789` test_ocr_engine. The LLM branch is L02 `testOcrWithEngine`. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import type {
  OcrTestRequest, OcrTestResponse, OcrTestRegion,
} from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { engineInfoList, parseEngineType, systemOcrPlatformSupported } from './ocr-settings.ts';
import type { LlmOcrPages } from '../../llm/api.ts';
import { performSystemOcr } from '../../llm-providers/api.ts';
import { errorLike } from './pdf-ocr-service.ts';

export interface OcrEngineTestDeps {
  settings: { get(key: string): string | null };
  appDataDir(): string;
  ocrPages(): LlmOcrPages | undefined;
  /** L01 `performSystemOcr` (ocr_adapters/system_ocr::perform_system_ocr). */
  systemOcr?(imageBytes: Uint8Array): Promise<string>;
  platform: string;
  now?(): number;
}

/** `parse_base64_image` (Err strings are wrapped by the caller). */
export function parseBase64Image(data: string): Uint8Array {
  let payload = data;
  if (data.startsWith('data:')) {
    const parts = data.split(',');
    if (parts.length < 2) throw new Error('Invalid data URL format');
    payload = parts[1]!;
  }
  try { return decodeBase64Standard(payload); }
  catch (error) {
    throw new Error(`Base64 decode error: ${error instanceof Base64DecodeError ? error.message : String(error)}`);
  }
}

/** `infer_extension_from_data_url` */
export function inferExtensionFromDataUrl(data: string): string {
  if (data.startsWith('data:image/png')) return 'png';
  if (data.startsWith('data:image/gif')) return 'gif';
  if (data.startsWith('data:image/webp')) return 'webp';
  return 'jpg';
}

function configuredName(settings: OcrEngineTestDeps['settings'], configId: string): string | null {
  let json: string | null;
  try { json = settings.get('ocr.available_models'); } catch { return null; }
  if (json === null) return null;
  try {
    const models = JSON.parse(json) as unknown;
    if (!Array.isArray(models)) return null;
    for (const model of models as Array<{ configId?: unknown; name?: unknown }>) {
      if (model?.configId === configId) return typeof model.name === 'string' ? model.name : null;
    }
  } catch { return null; }
  return null;
}

export async function testOcrEngine(deps: OcrEngineTestDeps, request: OcrTestRequest): Promise<OcrTestResponse> {
  const now = deps.now ?? (() => performance.now());
  const engineType = parseEngineType(request.engineType);
  const configId = request.configId ?? null;
  const engineName = (configId !== null ? configuredName(deps.settings, configId) : null)
    ?? engineInfoList(systemOcrPlatformSupported(deps.platform)).find((e) => e.engineType === engineType)?.name
    ?? engineType;

  const start = now();
  let imageBytes: Uint8Array;
  try { imageBytes = parseBase64Image(request.imageBase64); }
  catch (error) { throw new CommandError(AppError.validation(`图片解析失败: ${(error as Error).message}`)); }

  const tempDir = join(deps.appDataDir(), 'ocr_test_temp');
  try { mkdirSync(tempDir, { recursive: true }); }
  catch (error) { throw new CommandError(AppError.file_system(`创建临时目录失败: ${(error as Error).message}`)); }
  const tempPath = join(tempDir, `test_${globalThis.crypto.randomUUID()}.${inferExtensionFromDataUrl(request.imageBase64)}`);
  try { writeFileSync(tempPath, imageBytes); }
  catch (error) { throw new CommandError(AppError.file_system(`写入临时文件失败: ${(error as Error).message}`)); }

  let outcome: { ok: true; text: string; regions: OcrTestRegion[] } | { ok: false; error: string };
  try {
    const pages = deps.ocrPages();
    if (engineType === 'system_ocr') {
      let text: string;
      try { text = await (deps.systemOcr ?? performSystemOcr)(imageBytes); }
      catch (error) {
        // `Err(e) => Err(e.into())`: From<OcrError> for AppError.
        const toAppError = (error as { toAppError?: () => unknown }).toAppError;
        throw typeof toAppError === 'function' ? toAppError.call(error) : error;
      }
      outcome = { ok: true, text, regions: [{ text, bbox: null, label: 'document' }] };
    } else {
      if (pages === undefined) throw new CommandError(AppError.configuration('OCR 页面服务不可用'));
      const result = await pages.testOcrWithEngine(tempPath, engineType, configId);
      outcome = {
        ok: true,
        text: result.text,
        regions: result.regions.map((r) => {
          const v = r.bbox_normalized;
          return { text: r.text, bbox: v != null && v.length === 4 ? [v[0]!, v[1]!, v[2]!, v[3]!] : null, label: r.label };
        }),
      };
    }
  } catch (error) {
    outcome = { ok: false, error: errorLike(error).message };
  } finally {
    // M10 TempFileGuard
    try { rmSync(tempPath, { force: true }); } catch { // boundary-allow empty-catch: TempFileGuard drop ignores removal errors like Rust
    }
  }
  const elapsedMs = Math.trunc(now() - start);
  return outcome.ok
    ? { engineType, engineName, text: outcome.text, regions: outcome.regions, elapsedMs, success: true, error: null }
    : { engineType, engineName, text: '', regions: [], elapsedMs, success: false, error: outcome.error };
}
