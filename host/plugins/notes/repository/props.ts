// vfs::note_props.rs: shared key syntax, write validation and read-side tracing.
import { invalidParam } from './errors.ts';
import { decodeJson, decodeJsonExact } from './json.ts';
import { notesLog } from './log.ts';
import { charCount, rustTrim, takeChars } from '../../../platform/util/portable.ts';

export const MAX_PROPS = 32;
export const MAX_PROP_KEY_CHARS = 64;
export const MAX_PROP_VALUE_CHARS = 512;
export const PROPS_RESERVED_KEYS = ['tags', 'tag', 'path', 'title', 'isfavorite', 'snippet', 'props'] as const;

export type PropKeyError = 'empty' | 'too_long' | 'reserved' | 'control';

function codePointLength(value: string): number {
  return charCount(value);
}

/** Rust char::is_control is Unicode Cc; JS equivalent. */
function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Value::Number atom from decodeJsonExact (native brand; lookalike objects are rejected). */
function isRawNumber(value: unknown): boolean {
  return (JSON as typeof JSON & { isRawJSON?(value: unknown): boolean }).isRawJSON?.(value) === true;
}

export function validatePropKey(key: string): { key: string } | { error: PropKeyError } {
  const trimmed = rustTrim(key);
  if (trimmed.length === 0) return { error: 'empty' };
  if (codePointLength(trimmed) > MAX_PROP_KEY_CHARS) return { error: 'too_long' };
  if ((PROPS_RESERVED_KEYS as readonly string[]).includes(trimmed.toLowerCase())) return { error: 'reserved' };
  if (hasControl(trimmed)) return { error: 'control' };
  return { key: trimmed };
}

export function propKeyReason(error: PropKeyError, trimmedKey: string): string {
  switch (error) {
    case 'empty': return '属性名不能为空';
    case 'too_long': return `属性名过长（最多 ${MAX_PROP_KEY_CHARS} 个字符）`;
    case 'reserved': return `属性名 ${JSON.stringify(trimmedKey)} 为保留字`;
    case 'control': return '属性名不能包含控制字符';
  }
}

let malformedTotal = 0;

/** Process-wide observability counter, mirroring the Rust AtomicU64. */
export function malformedPropsTotal(): number {
  return malformedTotal;
}

export function recordMalformedProps(noteId: string, kind: 'invalid_json' | 'not_an_object' | 'empty_object' | 'column_read', detail: string): void {
  malformedTotal += 1;
  notesLog.warn(`[VFS::NoteProps] Malformed props for note ${noteId} (kind=${kind}, total=${malformedTotal}): ${detail}`);
}

/** Front-end `parseSearchOperators` key syntax; storable keys may still fail it. */
export function isOperatorSearchableKey(key: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(key);
}

export function snippet(raw: string): string {
  return charCount(raw) <= 120 ? raw : `${takeChars(raw, 120)}…`;
}

/** None is the normal SQL NULL path; every malformed non-empty value is counted.
 * `exact` keeps arbitrary_precision number text for history persistence. */
export function parsePropsCell(noteId: string, raw: string | null | undefined, exact = false): unknown | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try {
    value = exact ? decodeJsonExact(raw) : decodeJson(raw);
  } catch (error) {
    // decodeJson reproduces serde_json's message/line/column; Rust logs `{error}`.
    recordMalformedProps(noteId, 'invalid_json',
      `${error instanceof Error ? error.message : String(error)}; raw=${snippet(raw)}`);
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    recordMalformedProps(noteId, 'not_an_object', `JSON 不是对象; raw=${snippet(raw)}`);
    return null;
  }
  if (Object.keys(value as Record<string, unknown>).length === 0) {
    recordMalformedProps(noteId, 'empty_object', '空对象落库（写侧应规范化为 SQL NULL），疑似旁路写入');
    return null;
  }
  return value;
}

/** VfsNoteRepo::validate_note_props; trims keys and rejects ambiguous duplicates. */
export function normalizeNoteProps(props: unknown): { raw: string | null; value: Record<string, unknown> | null } {
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    invalidParam('props', 'props 必须是键值对象');
  }
  const map = props as Record<string, unknown>;
  const entries = Object.entries(map);
  if (entries.length > MAX_PROPS) invalidParam('props', `属性数量超出上限（最多 ${MAX_PROPS} 个）`);
  const normalizedKeys = new Set<string>();
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const checked = validatePropKey(key);
    if ('error' in checked) {
      invalidParam('props', propKeyReason(checked.error, rustTrim(key)));
    }
    const trimmed = checked.key;
    const lowered = trimmed.toLowerCase();
    if (normalizedKeys.has(lowered)) invalidParam('props', `属性名 ${JSON.stringify(trimmed)} 与已有属性重复`);
    normalizedKeys.add(lowered);
    if (typeof value === 'string') {
      if (codePointLength(value) > MAX_PROP_VALUE_CHARS) {
        invalidParam('props', `属性值过长（最多 ${MAX_PROP_VALUE_CHARS} 个字符）`);
      }
      if (hasControl(value)) invalidParam('props', '属性值不能包含控制字符');
    } else if (typeof value !== 'number' && typeof value !== 'boolean' && !isRawNumber(value)) {
      invalidParam('props', '属性值只支持字符串、数字或布尔');
    }
    normalized[trimmed] = value;
  }
  if (Object.keys(normalized).length === 0) return { raw: null, value: null };
  return { raw: JSON.stringify(normalized), value: normalized };
}

/** Only used by the shared write-side vector test. */
export const propVectors = {
  validOperatorKeys: ['status', 'Status', '优先级', 'due_date', 'sprint-42', 'p0', '_internal', 'k'],
  storableButNotOperatorSearchable: ['my key', 'a:b', 'emoji🙂', '-lead', '得 分'],
  invalidKeys: [
    ['', 'empty'], ['   ', 'empty'], ['tags', 'reserved'], ['TAGS', 'reserved'],
    ['Tag', 'reserved'], ['path', 'reserved'], ['title', 'reserved'],
    ['isFavorite', 'reserved'], ['snippet', 'reserved'], ['props', 'reserved'],
    ['bad\u0007key', 'control'], ['tab\tkey', 'control'],
  ] as const,
  overlongKey: () => 'k'.repeat(MAX_PROP_KEY_CHARS + 1),
  maxLengthKey: () => 'k'.repeat(MAX_PROP_KEY_CHARS),
};

