import type { JsonValue, OcrAdapter, OcrEngineType, OcrMode, OcrPageResult } from '../../api.ts';
import { ocrEngineDisplayName } from './types.ts';

/** Defaults from ocr_adapters/mod.rs:127–169 `OcrAdapter` trait methods. */
export abstract class BaseOcrAdapter implements OcrAdapter {
  abstract engineType(): OcrEngineType;
  abstract supportsMode(mode: OcrMode): boolean;
  abstract buildPrompt(mode: OcrMode): string;
  abstract parseResponse(
    response: string,
    imageWidth: number,
    imageHeight: number,
    pageIndex: number,
    imagePath: string,
    mode: OcrMode,
  ): OcrPageResult;

  displayName(): string { return ocrEngineDisplayName(this.engineType()); }

  buildCustomPrompt(customPrompt: string, _mode: OcrMode): string { return customPrompt; }

  recommendedMaxTokens(mode: OcrMode): number {
    switch (mode) {
      case 'grounding': return 8000;
      case 'free_ocr': case 'formula': case 'table': case 'chart': return 4096;
    }
  }

  recommendedTemperature(): number { return 0; }
  requiresHighDetail(): boolean { return true; }
  getExtraRequestParams(): JsonValue | null { return null; }
  recommendedRepetitionPenalty(): number | null { return null; }
}
