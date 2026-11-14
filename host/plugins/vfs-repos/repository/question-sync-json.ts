import { JsonReader, JsonSyntaxError } from '../../../platform/util/api.ts';
import type { QuestionImage, QuestionOption } from '../api.ts';

/** question_sync_service.rs:1628-1664: from_str::<Vec<T>>().ok(), not from_value.
 * Only serde decode failures become None; callers choose None or unwrap_or_default().
 */
function parseVec<T>(raw: string | null, read: (reader: JsonReader) => T): T[] | null {
  if (raw === null) return null;
  try {
    const reader = new JsonReader(raw);
    reader.beginArray();
    const items: T[] = [];
    while (reader.nextItem()) items.push(read(reader));
    reader.end();
    return items;
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    // Rust .ok(): discard the entire Vec, without logging.
    return null;
  }
}

function seqString(reader: JsonReader, index: number, expected: string): string {
  if (!reader.nextItem()) throw reader.error(`invalid length ${index}, expected ${expected}`);
  return reader.readString();
}

/** question_repo.rs:249-253; serde_derive 1.0.228 de/struct_.rs + de.rs:451-551. */
function readOption(reader: JsonReader): QuestionOption {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    const expected = 'struct QuestionOption with 2 elements';
    const key = seqString(reader, 0, expected);
    const content = seqString(reader, 1, expected);
    reader.endArray();
    return { key, content };
  }
  reader.beginObject('struct QuestionOption');
  let key: string | undefined;
  let content: string | undefined;
  for (let field = reader.nextKey(); field !== null; field = reader.nextKey()) {
    if (field === 'key') {
      if (key !== undefined) throw reader.fieldError('duplicate field `key`');
      key = reader.readString();
    } else if (field === 'content') {
      if (content !== undefined) throw reader.fieldError('duplicate field `content`');
      content = reader.readString();
    } else reader.skipIgnoredValue();
  }
  if (key === undefined) throw reader.error('missing field `key`');
  if (content === undefined) throw reader.error('missing field `content`');
  return { key, content };
}

/** question_repo.rs:256-268: four required Strings, default Option<String> role.
 * Missing role (including a short seq) and explicit null both serialize without role.
 */
function readImage(reader: JsonReader): QuestionImage {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    const expected = 'struct QuestionImage with 5 elements';
    const id = seqString(reader, 0, expected);
    const name = seqString(reader, 1, expected);
    const mime = seqString(reader, 2, expected);
    const hash = seqString(reader, 3, expected);
    let role: string | null = null;
    if (reader.nextItem()) {
      role = reader.readOptionNone() ? null : reader.readString();
      reader.endArray();
    }
    return { id, name, mime, hash, ...(role === null ? {} : { role }) };
  }
  reader.beginObject('struct QuestionImage');
  const fields: Partial<Record<'id' | 'name' | 'mime' | 'hash', string>> = {};
  // undefined = not seen, null = Some(None): a second role must fail even after null.
  let role: string | null | undefined;
  for (let field = reader.nextKey(); field !== null; field = reader.nextKey()) {
    if (field === 'id' || field === 'name' || field === 'mime' || field === 'hash') {
      if (fields[field] !== undefined) throw reader.fieldError(`duplicate field \`${field}\``);
      fields[field] = reader.readString();
    } else if (field === 'role') {
      if (role !== undefined) throw reader.fieldError('duplicate field `role`');
      role = reader.readOptionNone() ? null : reader.readString();
    } else reader.skipIgnoredValue();
  }
  const { id, name, mime, hash } = fields;
  if (id === undefined) throw reader.error('missing field `id`');
  if (name === undefined) throw reader.error('missing field `name`');
  if (mime === undefined) throw reader.error('missing field `mime`');
  if (hash === undefined) throw reader.error('missing field `hash`');
  return { id, name, mime, hash, ...(role == null ? {} : { role }) };
}

export const parseSyncOptions = (raw: string | null): QuestionOption[] | null => parseVec(raw, readOption);
export const parseSyncTags = (raw: string | null): string[] => parseVec(raw, reader => reader.readString()) ?? [];
export const parseSyncImages = (raw: string | null): QuestionImage[] => parseVec(raw, readImage) ?? [];
