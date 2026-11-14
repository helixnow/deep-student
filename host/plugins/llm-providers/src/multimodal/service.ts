import { EmbeddingChunker } from './embedding-chunker.ts';
import { MultimodalEmbeddingService, type EmbeddingServiceConfig, type MultimodalEmbeddingServiceRuntime } from './embedding-service.ts';
import { parseAttachmentPreview, parseAttachmentPreviewJson, parseAttachmentPreviewPage, type AttachmentPreview, type AttachmentPreviewPage } from './page-indexer.ts';
import type { JsonValue, PluginLogger } from '../../api.ts';

/**
 * multimodal/embedding_chunker.rs + embedding_service.rs + page_indexer.rs
 * exposed as one Cordis service. The embedding service still receives L02's
 * runtime through the published minimal interface; this lane owns the logic.
 */
export class MultimodalService {
  readonly version = 1 as const;
  readonly _logger?: PluginLogger;

  constructor(logger?: PluginLogger) { this._logger = logger; }

  createEmbeddingService(
    runtime: MultimodalEmbeddingServiceRuntime,
    config?: EmbeddingServiceConfig,
  ): MultimodalEmbeddingService {
    return config === undefined
      ? new MultimodalEmbeddingService(runtime, undefined, this._logger)
      : new MultimodalEmbeddingService(runtime, config, this._logger);
  }

  createChunker(maxTokens: number): EmbeddingChunker { return new EmbeddingChunker(maxTokens, this._logger); }

  parseAttachmentPreview(value: JsonValue): AttachmentPreview { return parseAttachmentPreview(value); }

  parseAttachmentPreviewJson(text: string): AttachmentPreview { return parseAttachmentPreviewJson(text); }

  parseAttachmentPreviewPage(value: JsonValue): AttachmentPreviewPage { return parseAttachmentPreviewPage(value); }
}
