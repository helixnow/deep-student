/**
 * 流式服务的错误形状与 JSON/遮挡辅助函数。
 */
import { rustTrim } from '../../../platform/util/index.ts';
import { OCCLUSION_FIELD } from './image-occlusion.ts';
import { isRecord } from './streaming-anki-fields.ts';

// ============================================================================
// 错误形状（与 Rust `AppError::validation/database` 对应）
// ============================================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function trimJsonQuotes(serialized: string | undefined): string {
  if (serialized === undefined) return '';
  return serialized.replace(/^"+|"+$/gu, '');
}

export function occlusionImageRef(extra: Record<string, string>): string | null {
  const raw = extra[OCCLUSION_FIELD];
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(value)) return null;
  const ref = Object.hasOwn(value, 'imageRef') ? value['imageRef'] : value['image_ref'];
  if (typeof ref !== 'string') return null;
  const trimmed = rustTrim(ref);
  return trimmed !== '' && !trimmed.startsWith('vlm://') ? trimmed : null;
}

