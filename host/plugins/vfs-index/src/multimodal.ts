/**
 * Pure helpers from `crates/dstu-vfs/src/vfs/multimodal_service.rs`.
 *
 * `MultimodalInput` is owned by L02 (`dstu-llm`); until its api.ts publishes it,
 * this module defines the same wire shape and constructors.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { QueryModality, UnifiedRetrievalRequest } from '../api.ts';

export type MultimodalImage =
  | { readonly kind: 'base64'; readonly data: string; readonly mediaType: string }
  | { readonly kind: 'url'; readonly url: string };

export interface MultimodalInput {
  readonly text: string | null;
  readonly image: MultimodalImage | null;
  readonly instruction: string | null;
  readonly video: unknown | null;
}

export const MultimodalInput = {
  text(text: string): MultimodalInput {
    return { text, image: null, instruction: null, video: null };
  },
  imageBase64(data: string, mediaType: string): MultimodalInput {
    return { text: null, image: { kind: 'base64', data, mediaType }, instruction: null, video: null };
  },
  imageUrl(url: string): MultimodalInput {
    return { text: null, image: { kind: 'url', url }, instruction: null, video: null };
  },
  textAndImage(text: string, data: string, mediaType: string): MultimodalInput {
    return { text, image: { kind: 'base64', data, mediaType }, instruction: null, video: null };
  },
  withInstruction(input: MultimodalInput, instruction: string): MultimodalInput {
    return { ...input, instruction };
  },
};

export interface VfsMultimodalPage {
  page_index: number;
  image_base64: string | null;
  image_mime: string | null;
  text_content: string | null;
  blob_hash: string | null;
}

export interface VfsMultimodalSearchResult {
  embedding_id: string;
  resource_id: string;
  unit_id: string | null;
  resource_type: string;
  page_index: number;
  text_content: string | null;
  blob_hash: string | null;
  score: number;
  folder_id: string | null;
}

export function normalizeMultimodalRrfScore(score: number, bestScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(bestScore) || bestScore <= 0) return 0;
  return Math.fround(Math.min(Math.max(score / bestScore, 0), 1));
}

export function unifiedMultimodalRequest(
  queryInput: MultimodalInput,
  topK: number,
  folderIds?: readonly string[] | null,
  resourceIds?: readonly string[] | null,
  resourceTypes?: readonly string[] | null,
): UnifiedRetrievalRequest {
  let queryImageBase64: string | null = null;
  let queryImageMediaType: string | null = null;
  if (queryInput.image !== null) {
    if (queryInput.image.kind === 'base64') {
      queryImageBase64 = queryInput.image.data;
      queryImageMediaType = queryInput.image.mediaType;
    } else {
      throw new Error(
        "Invalid argument 'queryInput.image': profile-aware VFS retrieval requires Base64 image bytes; URL-only image queries are unsupported",
      );
    }
  }
  let queryText: string | null = null;
  if (queryInput.text !== null) {
    const instruction = rustTrim(queryInput.instruction ?? '');
    queryText = instruction !== ''
      ? `${instruction}\n\n${queryInput.text}`
      : queryInput.text;
  }
  let queryModality: QueryModality;
  if (queryText !== null && queryImageBase64 !== null) queryModality = 'mixed';
  else if (queryImageBase64 !== null) queryModality = 'image';
  else if (queryText !== null) queryModality = 'text';
  else {
    throw new Error(
      "Invalid argument 'queryInput': multimodal retrieval requires text or image input",
    );
  }
  return {
    queryText,
    queryImageBase64,
    queryImageMediaType,
    queryModality,
    topK,
    folderIds: folderIds === undefined || folderIds === null ? null : [...folderIds],
    resourceIds: resourceIds === undefined || resourceIds === null ? null : [...resourceIds],
    resourceTypes: resourceTypes === undefined || resourceTypes === null ? null : [...resourceTypes],
  };
}

export function parseMultimodalProvenance(
  metadataJson: string | null | undefined,
): [string | null, string | null] {
  if (metadataJson === null || metadataJson === undefined) return [null, null];
  let value: unknown;
  try {
    value = JSON.parse(metadataJson);
  } catch {
    return [null, null];
  }
  if (typeof value !== 'object' || value === null) return [null, null];
  const record = value as Record<string, unknown>;
  return [
    typeof record['blob_hash'] === 'string' ? record['blob_hash'] : null,
    typeof record['unit_id'] === 'string' ? record['unit_id'] : null,
  ];
}

export interface VfsMultimodalIndexResult {
  indexed_pages: number;
  dimension: number;
  failed_pages: number[];
}

export interface VfsMultimodalStats {
  total_records: number;
  dimensions: number[];
}
