import type { MultimodalInput as Input, MultimodalImage, MultimodalVideo, VLEmbeddingInputItem, MultimodalIndexingMode, IndexProgressEvent as Progress } from '../../api.ts';

export class MultimodalInput implements Input {
  text?: string;
  image?: MultimodalImage;
  instruction?: string;
  video?: MultimodalVideo;
  static text(text: string): MultimodalInput { return Object.assign(new MultimodalInput(), { text }); }
  static imageBase64(data: string, media_type: string): MultimodalInput {
    return Object.assign(new MultimodalInput(), { image: { data, media_type } });
  }
  static imageUrl(url: string): MultimodalInput { return Object.assign(new MultimodalInput(), { image: { url } }); }
  static textAndImage(text: string, data: string, media_type: string): MultimodalInput {
    return Object.assign(MultimodalInput.imageBase64(data, media_type), { text });
  }
  withInstruction(instruction: string): this { this.instruction = instruction; return this; }
  isTextOnly(): boolean { return this.text !== undefined && this.image === undefined && this.video === undefined; }
  hasImage(): boolean { return this.image !== undefined; }
  isEmpty(): boolean { return this.text === undefined && this.image === undefined && this.video === undefined; }
  toJSON(): Input {
    return {
      ...(this.text === undefined ? {} : { text: this.text }),
      ...(this.image === undefined ? {} : { image: this.image }),
      ...(this.instruction === undefined ? {} : { instruction: this.instruction }),
      ...(this.video === undefined ? {} : { video: this.video }),
    };
  }
}
export function imageAsBase64(image: MultimodalImage): [string, string] | null {
  return 'data' in image ? [image.data, image.media_type] : null;
}
export function imageAsUrl(image: MultimodalImage): string | null { return 'url' in image ? image.url : null; }
export function toVLEmbeddingInput(input: Input): VLEmbeddingInputItem {
  return {
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.image === undefined ? {} : { image: 'url' in input.image ? input.image.url : `data:${input.image.media_type};base64,${input.image.data}` }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
  };
}
export function indexingModeFromStr(s: string): MultimodalIndexingMode | null {
  switch (s.toLowerCase().replaceAll('-', '_')) {
    case 'vl_embedding': case 'vlembedding': case 'direct': return 'vl_embedding';
    case 'vl_summary_then_text_embed': case 'vlsummarythentextembed': case 'summary': return 'vl_summary_then_text_embed';
    default: return null;
  }
}
export function indexingModeAsStr(mode: MultimodalIndexingMode): string { return mode; }
export function requiresVLEmbeddingModel(mode: MultimodalIndexingMode): boolean { return mode === 'vl_embedding'; }
export function requiresVLSummaryModel(mode: MultimodalIndexingMode): boolean { return mode === 'vl_summary_then_text_embed'; }
export function requiresTextEmbeddingModel(mode: MultimodalIndexingMode): boolean { return mode === 'vl_summary_then_text_embed'; }
export function vectorTableSuffix(mode: MultimodalIndexingMode = 'vl_embedding'): 'vl' | 'text' { return mode === 'vl_embedding' ? 'vl' : 'text'; }

export class IndexProgressEvent implements Progress {
  sourceType: string;
  sourceId: string;
  totalPages: number;
  phase = 'preparing';
  currentPage = 0;
  indexedPages = 0;
  skippedPages = 0;
  progressPercent = 0;
  message = '准备中...';
  constructor(sourceType: string, sourceId: string, totalPages: number) {
    this.sourceType = sourceType; this.sourceId = sourceId; this.totalPages = totalPages;
  }
  withPhase(phase: string, message: string): this { this.phase = phase; this.message = message; return this; }
  withProgress(current: number, indexed: number, skipped: number): this {
    this.currentPage = current; this.indexedPages = indexed; this.skippedPages = skipped;
    if (this.totalPages > 0) this.progressPercent = Math.max(-2147483648, Math.min(2147483647, Math.trunc(current / this.totalPages * 100)));
    return this;
  }
  toJSON(): Progress {
    return { sourceType: this.sourceType, sourceId: this.sourceId, phase: this.phase, currentPage: this.currentPage,
      totalPages: this.totalPages, indexedPages: this.indexedPages, skippedPages: this.skippedPages,
      progressPercent: this.progressPercent, message: this.message };
  }
}
