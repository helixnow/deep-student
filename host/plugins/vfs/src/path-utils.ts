import { DstuFailure } from './dstu-error.ts';
import { parseRealPath } from './paths.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

/** `is_uuid_format` (path_utils.rs:62-82). */
export function isUuidFormat(value: string): boolean {
  if (value.length !== 36) return false;
  const parts = value.split('-');
  if (parts.length !== 5) return false;
  if (parts[0]!.length !== 8 || parts[1]!.length !== 4 || parts[2]!.length !== 4
    || parts[3]!.length !== 4 || parts[4]!.length !== 12) return false;
  return /^[0-9a-fA-F-]+$/.test(value);
}

const SIMPLE_ID_PREFIXES = [
  'note_', 'tb_', 'file_', 'tr_', 'exam_', 'essay_session_', 'essay_', 'att_', 'fld_', 'mm_', 'res_', 'img_',
];

/** `extract_simple_id` (path_utils.rs:13-59). */
export function extractSimpleId(path: string): string | undefined {
  const trimmed = rustTrim(path).replace(/^\/+/, '');
  if (trimmed.includes('/')) return undefined;
  if (SIMPLE_ID_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return trimmed;
  return isUuidFormat(trimmed) ? trimmed : undefined;
}

/** `infer_resource_type_from_id` (path_utils.rs:90-118); plural wire names. */
export function inferResourceTypeFromId(id: string): string {
  if (id.startsWith('note_')) return 'notes';
  if (id.startsWith('file_') || id.startsWith('tb_') || id.startsWith('att_') || id.startsWith('img_')) return 'files';
  if (id.startsWith('tr_')) return 'translations';
  if (id.startsWith('exam_')) return 'exams';
  if (id.startsWith('essay_session_') || id.startsWith('essay_')) return 'essays';
  if (id.startsWith('fld_') || isUuidFormat(id)) return 'folders';
  if (id.startsWith('mm_')) return 'mindmaps';
  if (id.startsWith('res_')) return 'resources';
  return 'unknown';
}

/** `extract_resource_info` (path_utils.rs:123-169). */
export function extractResourceInfo(path: string): { resourceType: string; id: string } {
  const simple = extractSimpleId(path);
  if (simple !== undefined) {
    const resourceType = inferResourceTypeFromId(simple);
    if (resourceType === 'unknown') {
      throw new DstuFailure('InvalidPath', `Cannot infer resource type from ID: ${simple}`);
    }
    return { resourceType, id: simple };
  }

  const parsed = parseRealPath(path);
  if (parsed.resourceId === undefined) {
    throw new DstuFailure('InvalidPath', `Path must contain a resource ID: ${path}`);
  }
  const resourceType = inferResourceTypeFromId(parsed.resourceId);
  if (resourceType === 'unknown') {
    throw new DstuFailure('InvalidPath', `Cannot infer resource type from ID: ${parsed.resourceId}`);
  }
  return { resourceType, id: parsed.resourceId };
}
