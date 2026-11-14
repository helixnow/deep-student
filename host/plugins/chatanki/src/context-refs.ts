// Rust: chatanki_executor.rs:10471–10533 context-ref projection and unsupported kinds.
import type {
  ContextRef, VfsContextRefData, VfsResourceRef, VfsResourceType,
} from '../api.ts';
import { rustTrim } from '../../../platform/util/text.ts';

// ============================================================================
// Context refs (chatanki_executor.rs:10471–10533)
// ============================================================================

export function buildSingleRefDataFromContextRef(contextRef: ContextRef): VfsContextRefData | null {
  if (rustTrim(contextRef.hash).length === 0) return null;
  const sourceId = contextRef.resourceId;
  let type: VfsResourceType;
  if (contextRef.typeId === 'image') type = 'image';
  else if (sourceId.startsWith('tb_')) type = 'textbook';
  else if (sourceId.startsWith('file_') || sourceId.startsWith('att_')) type = 'file';
  else return null;
  const ref: VfsResourceRef = {
    sourceId,
    resourceHash: contextRef.hash,
    type,
    name: contextRef.displayName ?? sourceId,
    resourceId: null,
    snippet: null,
    injectModes: contextRef.injectModes ?? null,
  };
  return { refs: [ref], truncated: false, totalCount: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** serde unit-variant enum: the bare string or a `{ "variant": null }` map. */
function unitEnum<T extends string>(value: unknown, variants: readonly T[]): T | null {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || value[keys[0]!] !== null) return null;
    value = keys[0];
  }
  return typeof value === 'string' && variants.includes(value as T) ? value as T : null;
}

const RESOURCE_TYPES: readonly VfsResourceType[] = [
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'retrieval', 'mindmap', 'insightcard',
];

function decodeModes<T extends string>(value: unknown, variants: readonly T[]): T[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => unitEnum(item, variants));
  return parsed.some((item) => item === null) ? null : parsed as T[];
}

/** `serde_json::from_str::<VfsContextRefData>` over `vfs_resources.data`; any mismatch is `null` (Rust `Err`). */
export function decodeVfsContextRefData(text: string): VfsContextRefData | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isRecord(data) || !Array.isArray(data.refs)) return null;
  if (data.truncated !== undefined && typeof data.truncated !== 'boolean') return null;
  if (data.totalCount !== undefined && (typeof data.totalCount !== 'number'
    || !Number.isInteger(data.totalCount) || data.totalCount < 0)) return null;
  const refs: VfsResourceRef[] = [];
  for (const raw of data.refs) {
    if (!isRecord(raw) || typeof raw.sourceId !== 'string' || typeof raw.resourceHash !== 'string'
      || typeof raw.name !== 'string') return null;
    const type = unitEnum(raw.type, RESOURCE_TYPES);
    if (type === null) return null;
    if ([raw.resourceId, raw.snippet].some((value) => value !== undefined && value !== null && typeof value !== 'string')) {
      return null;
    }
    let injectModes: VfsResourceRef['injectModes'] = null;
    if (raw.injectModes !== undefined && raw.injectModes !== null) {
      if (!isRecord(raw.injectModes)) return null;
      const image = decodeModes(raw.injectModes.image, ['image', 'ocr'] as const);
      const pdf = decodeModes(raw.injectModes.pdf, ['text', 'ocr', 'image'] as const);
      if (image === null || pdf === null) return null;
      injectModes = {};
      if (image !== undefined) injectModes.image = image;
      if (pdf !== undefined) injectModes.pdf = pdf;
    }
    refs.push({
      sourceId: raw.sourceId,
      resourceHash: raw.resourceHash,
      type,
      name: raw.name,
      resourceId: typeof raw.resourceId === 'string' ? raw.resourceId : null,
      snippet: typeof raw.snippet === 'string' ? raw.snippet : null,
      injectModes,
    });
  }
  return { refs, truncated: data.truncated === true, totalCount: typeof data.totalCount === 'number' ? data.totalCount : 0 };
}

export function unsupportedChatankiResourceMessage(rawId: string): string | null {
  const trimmed = rustTrim(rawId);
  const kind = trimmed.startsWith('mm_') ? 'mindmap'
    : trimmed.startsWith('note_') ? 'note'
      : trimmed.startsWith('exam_') ? 'exam'
        : trimmed.startsWith('essay_') ? 'essay'
          : trimmed.startsWith('tr_') ? 'translation'
            : trimmed.startsWith('fld_') ? 'folder'
              : null;
  if (kind === null) return null;
  return `Resource '${trimmed}' is a ${kind} resource. chatanki_run currently supports direct file/image/textbook attachments only; please pass a file_/att_/tb_/res_ resource instead.`;
}
