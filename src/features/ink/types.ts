/**
 * `.dsink` v1 wire types. Field names and tagged unions match the Rust domain
 * types and the shared fixtures under `tests/fixtures/ink/`.
 *
 * Coordinates in `InkSample`, `InkRect`, and `InkPoint` are logical page units,
 * not normalized tool coordinates. Text is plain content; renderers must not
 * interpret markup as HTML.
 */

export { INK_MIME, INK_EXTENSION } from '@/dstu/inkFormat';
import { INK_MIME, INK_EXTENSION } from '@/dstu/inkFormat';
export const INK_SCHEMA_VERSION = 1 as const;

/** v1 upper bounds, documented here to keep the Rust/TypeScript contract aligned. */
export const INK_LIMITS = {
  manifest_max_bytes: 1024 * 1024,
  page_max_bytes: 8 * 1024 * 1024,
  pages_min: 1,
  pages_max: 500,
  dimension_min: 1,
  dimension_max: 16384,
  id_max_chars: 128,
  title_max_chars: 256,
  page_objects_max: 10000,
  page_samples_max: 100000,
  stroke_min_samples: 1,
  text_max_chars: 10000,
  width_max: 256,
  font_size_min: 1,
  font_size_max: 256,
} as const;

export type InkErrorCode =
  | 'INVALID_ARGUMENT'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED_SCHEMA';

export interface InkError {
  code: InkErrorCode;
  message: string;
}

export type InkAuthor = 'user' | 'ai';
export type InkRuling = 'blank' | 'lined' | 'grid';
export type InkTool = 'pen' | 'highlighter';

export type InkSource =
  | { kind: 'blank' }
  | {
      kind: 'resource';
      resource_id: string;
      source_hash: string;
      conversion_revision: string;
    };

export type InkBackground =
  | { kind: 'blank'; ruling: InkRuling }
  | { kind: 'image'; blob_hash: string }
  | { kind: 'pdf_page'; blob_hash: string; source_page_index: number };

export interface InkPageRef {
  page_id: string;
  width: number;
  height: number;
  background: InkBackground;
  page_blob_hash: string;
}

export interface InkOperationReceipt {
  operation_id: string;
  input_hash: string;
  previous_revision?: string;
  result_revision: string;
}

export interface InkManifest {
  schema_version: number;
  document_id: string;
  revision: string;
  title: string;
  source: InkSource;
  pages: InkPageRef[];
  last_operation?: InkOperationReceipt;
}

/** v2 board schema. Kept separate from v1 `InkManifest`; do not widen v1. */
export const INK_BOARD_SCHEMA_VERSION = 2 as const;

/** v2 board hard limits, aligned with Rust `vfs/ink/board.rs`. */
export const INK_BOARD_LIMITS = {
  world_limit: 10000000,
  chunks_max: 256,
  objects_max: 100000,
  samples_max: 2000000,
  content_max_bytes: 64 * 1024 * 1024,
  chunk_max_bytes: 8 * 1024 * 1024,
  chunk_objects_max: 10000,
  chunk_samples_max: 100000,
} as const;

/** Signed board-world bounds; x/y may be negative, width/height must be positive. */
export interface InkBoardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkBoardSurface {
  kind: 'board';
  page_id: string;
  ruling: InkRuling;
  bounds: InkBoardBounds;
}

export interface InkBoardChunkRef {
  chunk_id: string;
  blob_hash: string;
  byte_length: number;
  object_count: number;
  sample_count: number;
  bounds: InkBoardBounds;
}

export interface InkBoardObject {
  id: string;
  author: InkAuthor;
  created_at: number;
  z_index: number;
  content: InkObjectContent;
}

export interface InkBoardChunk {
  schema_version: typeof INK_BOARD_SCHEMA_VERSION;
  chunk_id: string;
  objects: InkBoardObject[];
}

/** Exact v2 empty-or-chunked board manifest; v1 fields are intentionally unchanged. */
export interface InkBoardManifest {
  schema_version: typeof INK_BOARD_SCHEMA_VERSION;
  document_id: string;
  revision: string;
  title: string;
  source: { kind: 'blank' };
  pages: [];
  surface: InkBoardSurface;
  chunks: InkBoardChunkRef[];
  last_operation?: InkOperationReceipt;
}

export interface InkSample {
  x: number;
  y: number;
  pressure: number;
  elapsed_ms?: number;
}

export interface InkStrokeStyle {
  tool: InkTool;
  color: string;
  width: number;
  pressure_enabled: boolean;
}

export interface InkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkPoint {
  x: number;
  y: number;
}

export type InkObjectContent =
  | { kind: 'stroke'; samples: InkSample[]; style: InkStrokeStyle }
  | { kind: 'text'; rect: InkRect; text: string; font_size: number; color: string }
  | { kind: 'rect'; rect: InkRect; color: string; width: number }
  | { kind: 'ellipse'; rect: InkRect; color: string; width: number }
  | { kind: 'region_highlight'; rect: InkRect; color: string; width: number }
  | { kind: 'arrow'; from: InkPoint; to: InkPoint; color: string; width: number };

export interface InkObject {
  id: string;
  author: InkAuthor;
  created_at: number;
  content: InkObjectContent;
}

export interface InkPage {
  schema_version: number;
  page_id: string;
  objects: InkObject[];
}

/** Normalized point/rectangle used only in tool operation requests (0..1). */
export interface InkNormalizedPoint {
  x: number;
  y: number;
}

export interface InkNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InkOperationCoordinateSpace = 'page' | 'render_crop';

/** Add/update payloads intentionally exclude stroke content. */
export type InkOperationContentRequest =
  | { kind: 'text'; rect: InkNormalizedRect; text: string; font_size: number; color: string }
  | { kind: 'rect'; rect: InkNormalizedRect; color: string; width: number }
  | { kind: 'ellipse'; rect: InkNormalizedRect; color: string; width: number }
  | { kind: 'region_highlight'; rect: InkNormalizedRect; color: string; width: number }
  | { kind: 'arrow'; from: InkNormalizedPoint; to: InkNormalizedPoint; color: string; width: number };

/** Public normalized operations; stable object/page IDs and timestamps are service-generated. */
export type InkOperationRequest =
  | { op: 'append_blank_page'; width: number; height: number; ruling: InkRuling }
  | {
      op: 'add_text';
      page_id: string;
      coordinate_space: InkOperationCoordinateSpace;
      based_on_render_id: string;
      rect: InkNormalizedRect;
      text: string;
      font_size: number;
      color: string;
    }
  | {
      op: 'add_rect' | 'add_ellipse' | 'add_region_highlight';
      page_id: string;
      coordinate_space: InkOperationCoordinateSpace;
      based_on_render_id: string;
      rect: InkNormalizedRect;
      color: string;
      width: number;
    }
  | {
      op: 'add_arrow';
      page_id: string;
      coordinate_space: InkOperationCoordinateSpace;
      based_on_render_id: string;
      from: InkNormalizedPoint;
      to: InkNormalizedPoint;
      color: string;
      width: number;
    }
  | {
      op: 'update_object';
      page_id: string;
      object_id: string;
      coordinate_space: InkOperationCoordinateSpace;
      based_on_render_id: string;
      content: InkOperationContentRequest;
    }
  | { op: 'remove_object'; page_id: string; object_id: string };
