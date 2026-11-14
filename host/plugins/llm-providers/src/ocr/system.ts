import type { OcrEngineType, OcrMode, OcrPageResult } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { BaseOcrAdapter } from './base.ts';
import { OcrError } from './types.ts';

/** OCR engine supplied by the native/Electron lane (macOS Vision / Windows.Media.Ocr). */
export interface SystemOcrNativeBinding {
  performSystemOcr(imageData: Uint8Array): Promise<string>;
}

let binding: SystemOcrNativeBinding | null = null;

/** ocr_adapters/system_ocr/mod.rs:72 `is_platform_supported`. */
export function isPlatformSupported(): boolean {
  // Rust gates this on cfg(macos|windows); runtimes without Node's `process` are never desktop hosts.
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
  return platform === 'darwin' || platform === 'win32';
}

export function setSystemOcrBinding(value: SystemOcrNativeBinding | null): void {
  binding = value;
}

export function systemOcrBinding(): SystemOcrNativeBinding | null { return binding; }

/**
 * ocr_adapters/system_ocr/mod.rs:38 `perform_system_ocr`.
 * The platform call is injected; without a binding the capability is reported
 * as unsupported instead of returning fabricated text.
 */
export async function performSystemOcr(imageData: Uint8Array): Promise<string> {
  if (!isPlatformSupported()) {
    throw OcrError.unsupported(
      'System OCR is not available on this platform. Supported: macOS 10.15+, Windows 10+. '
      + 'Please use a VLM-based OCR engine instead.',
    );
  }
  if (binding === null) throw OcrError.unsupported('System OCR native binding is not registered');
  try {
    return await binding.performSystemOcr(imageData);
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw OcrError.imageProcessing(`OCR task failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** ocr_adapters/system_ocr/mod.rs:77 `SystemOcrAdapter`. */
export class SystemOcrAdapter extends BaseOcrAdapter {
  engineType(): OcrEngineType { return 'system_ocr'; }

  /** System OCR only supports plain text extraction. */
  supportsMode(mode: OcrMode): boolean { return mode === 'free_ocr'; }

  buildPrompt(_mode: OcrMode): string { return ''; }

  override parseResponse(
    response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode,
  ): OcrPageResult {
    const text = rustTrim(response);
    return {
      page_index: pageIndex,
      image_path: imagePath,
      image_width: imageWidth,
      image_height: imageHeight,
      regions: [{ label: 'document', text }],
      markdown_text: text,
      engine: 'system_ocr',
      mode,
    };
  }

  override recommendedMaxTokens(_mode: OcrMode): number { return 0; }
  override requiresHighDetail(): boolean { return false; }
}
