import type { JsonValue } from '../../api.ts';
import { JsonReader, JsonSyntaxError } from '../../../../platform/util/portable.ts';
import { array, duplicateField, typedU64, object, string, U64_MAX } from '../json.ts';

/**
 * multimodal/page_indexer.rs:19 `AttachmentPreviewPage`.
 * Both the legacy snake_case and the PdfPreviewJson camelCase spellings are
 * accepted through serde aliases; absent Options stay undefined.
 */
export interface AttachmentPreviewPage {
  /** `usize`: kept exact as bigint inside the Host (D3 narrows only at real IPC boundaries). */
  page_index: bigint;
  blob_hash?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  compressed_blob_hash?: string;
}

/** multimodal/page_indexer.rs:15 `AttachmentPreview`. */
export interface AttachmentPreview {
  pages: AttachmentPreviewPage[];
  dpi?: number;
  /** `Option<usize>`: exact bigint, see `page_index`. */
  page_count?: bigint;
  rendered_at?: string;
}

export type TextbookPreview = AttachmentPreview;
export type TextbookPreviewPage = AttachmentPreviewPage;

function serdeError(detail: string, cause?: JsonSyntaxError): Error {
  return new Error(`invalid attachment preview: ${detail}`, cause === undefined ? undefined : { cause });
}

function fieldWithAlias(value: JsonValue, name: string, alias: string): JsonValue | undefined {
  // Struct sequences use positional aliases supplied by the domain decoder.
  if (Array.isArray(value)) return value[Number(alias)];
  const map = object(value);
  if (!map) return undefined;
  if (Object.hasOwn(map, name)) return map[name];
  if (Object.hasOwn(map, alias)) return map[alias];
  return undefined;
}

function optionalString(value: JsonValue, name: string, alias: string): string | undefined {
  const raw = fieldWithAlias(value, name, alias);
  if (raw === undefined || raw === null) return undefined;
  const text = string(raw);
  if (text === undefined) throw serdeError(`invalid type for \`${name}\``);
  return text;
}

/** page_indexer.rs:18-50 serde fields; an alias fills the same slot as its canonical name. */
const PREVIEW_FIELDS = [['pages'], ['dpi', 'renderDpi'], ['page_count', 'totalPages'], ['rendered_at', 'renderedAt']];
const PAGE_FIELDS = [['page_index', 'pageIndex'], ['blob_hash', 'blobHash'], ['width'], ['height'],
  ['mime_type', 'mimeType'], ['compressed_blob_hash', 'compressedBlobHash']];
function rejectDuplicateField(value: JsonValue, fields: string[][]): void {
  const duplicate = duplicateField(value, fields);
  if (duplicate !== undefined) throw serdeError(`duplicate field \`${duplicate}\``);
}

/**
 * multimodal_service.rs:1378 consumes `serde_json::from_str::<AttachmentPreview>(&preview_json)`.
 * Consumers should pass the stored text here so integer literal forms, the
 * 64-bit range and repeated fields are judged from the text, as serde does.
 */
export function parseAttachmentPreviewJson(text: string): AttachmentPreview {
  const reader = new JsonReader(text);
  try {
    const preview = readPreview(reader);
    reader.end();
    return preview;
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    // Keep the public syntax-error context, without discarding serde's detail/position.
    const context = /^(invalid type:|invalid value:|invalid length |missing field |duplicate field )/.test(error.code)
      ? '' : 'invalid JSON: ';
    throw serdeError(`${context}${error.message}`, error);
  }
}

/** usize is 64-bit on desktop targets; the full range is accepted (D3), not a JS safe-integer cap. */
const USIZE_MAX = U64_MAX;
const U32_MAX = 4294967295n;

/** Only these two serde structs share this field traversal; all token reading belongs to F4. */
function readPreviewFields(
  reader: JsonReader, fields: string[][], struct: string, requiredSlots: number,
  readField: (index: number) => void,
): void {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    for (let index = 0; index < fields.length; index++) {
      if (!reader.nextItem()) {
        if (index < requiredSlots) {
          throw reader.error(`invalid length ${index}, expected struct ${struct} with ${fields.length} elements`);
        }
        return; // nextItem closed the array; remaining fields all have #[serde(default)].
      }
      readField(index);
    }
    reader.endArray(); // end_seq does not deserialize a surplus element, even malformed JSON.
    return;
  }
  reader.beginObject(`struct ${struct}`);
  const seen = new Set<number>();
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    const index = fields.findIndex(names => names.includes(key));
    if (index < 0) { reader.skipIgnoredValue(); continue; }
    if (seen.has(index)) throw reader.fieldError(`duplicate field \`${fields[index]![0]}\``);
    seen.add(index); // An explicit Option::None still occupies its field slot.
    readField(index);
  }
  // Both structs have exactly one non-Option field, first in declaration order.
  if (!seen.has(0)) throw reader.error(`missing field \`${fields[0]![0]}\``);
}

function readPreviewUnsigned(reader: JsonReader, field: string, expected: 'usize' | 'u32'): bigint {
  try {
    return reader.readUnsigned(expected, expected === 'usize' ? USIZE_MAX : U32_MAX);
  } catch (error) {
    // Existing service callers retain their field context; cause is the untouched Rust-style error.
    if (error instanceof JsonSyntaxError && /^(invalid type:|invalid value:)/.test(error.code)) {
      throw serdeError(`invalid type for \`${field}\`: ${error.message}`, error);
    }
    throw error;
  }
}

function readPreviewPage(reader: JsonReader): AttachmentPreviewPage {
  let pageIndex: bigint | undefined;
  const optional: Omit<AttachmentPreviewPage, 'page_index'> = {};
  readPreviewFields(reader, PAGE_FIELDS, 'AttachmentPreviewPage', 2, index => {
    if (index === 0) { pageIndex = readPreviewUnsigned(reader, 'page_index', 'usize'); return; }
    if (reader.readOptionNone()) return;
    switch (index) {
      case 1: optional.blob_hash = reader.readString(); break;
      case 2: optional.width = Number(readPreviewUnsigned(reader, 'width', 'u32')); break;
      case 3: optional.height = Number(readPreviewUnsigned(reader, 'height', 'u32')); break;
      case 4: optional.mime_type = reader.readString(); break;
      case 5: optional.compressed_blob_hash = reader.readString(); break;
    }
  });
  // readPreviewFields enforces the required first field before returning.
  return { page_index: pageIndex!, ...optional };
}

function readPreview(reader: JsonReader): AttachmentPreview {
  let pages: AttachmentPreviewPage[] | undefined;
  const optional: Omit<AttachmentPreview, 'pages'> = {};
  readPreviewFields(reader, PREVIEW_FIELDS, 'AttachmentPreview', 1, index => {
    if (index === 0) {
      reader.beginArray();
      pages = [];
      while (reader.nextItem()) pages.push(readPreviewPage(reader));
      return;
    }
    if (reader.readOptionNone()) return;
    switch (index) {
      case 1: optional.dpi = Number(readPreviewUnsigned(reader, 'dpi', 'u32')); break;
      case 2: optional.page_count = readPreviewUnsigned(reader, 'page_count', 'usize'); break;
      case 3: optional.rendered_at = reader.readString(); break;
    }
  });
  return { pages: pages!, ...optional };
}

function optionalUnsignedExact(value: JsonValue, name: string, alias: string, max: bigint): bigint | undefined {
  const raw = fieldWithAlias(value, name, alias);
  if (raw === undefined || raw === null) return undefined;
  const key = object(value) !== undefined && Object.hasOwn(object(value)!, name) ? name : alias;
  const number = typedU64(value, key);
  if (number === undefined || number > max) throw serdeError(`invalid type for \`${name}\``);
  return number;
}
/** u32 fields: every value is a safe integer, so a JS number is exact. */
function optionalU32(value: JsonValue, name: string, alias: string): number | undefined {
  const number = optionalUnsignedExact(value, name, alias, U32_MAX);
  return number === undefined ? undefined : Number(number);
}

/** multimodal/page_indexer.rs:29 `AttachmentPreviewPage` deserialization. */
export function parseAttachmentPreviewPage(value: JsonValue): AttachmentPreviewPage {
  const sequence = Array.isArray(value) ? value : undefined;
  if (!object(value) && sequence === undefined) throw serdeError('invalid type in `pages`');
  if (sequence?.length === 0) throw serdeError('invalid length 0, expected struct AttachmentPreviewPage with 6 elements');
  const alias = (index: number, named: string): string => sequence === undefined ? named : String(index);
  rejectDuplicateField(value, PAGE_FIELDS);
  // `page_index: usize` is not an Option: null is a type error, not a missing field.
  if (fieldWithAlias(value, 'page_index', alias(0, 'pageIndex')) === null) throw serdeError('invalid type: null, expected usize');
  const pageIndex = optionalUnsignedExact(value, 'page_index', alias(0, 'pageIndex'), USIZE_MAX);
  if (pageIndex === undefined) throw serdeError('missing field `page_index`');
  const page: AttachmentPreviewPage = { page_index: pageIndex };
  // blob_hash is Option<String> without #[serde(default)]: missing map fields
  // become None, but visit_seq requires this slot (serde_derive de.rs:805-835).
  if (sequence !== undefined && sequence.length < 2) throw serdeError('invalid length 1, expected struct AttachmentPreviewPage with 6 elements');
  const blobHash = optionalString(value, 'blob_hash', alias(1, 'blobHash'));
  if (blobHash !== undefined) page.blob_hash = blobHash;
  const width = optionalU32(value, 'width', alias(2, 'width'));
  if (width !== undefined) page.width = width;
  const height = optionalU32(value, 'height', alias(3, 'height'));
  if (height !== undefined) page.height = height;
  const mimeType = optionalString(value, 'mime_type', alias(4, 'mimeType'));
  if (mimeType !== undefined) page.mime_type = mimeType;
  const compressedBlobHash = optionalString(value, 'compressed_blob_hash', alias(5, 'compressedBlobHash'));
  if (compressedBlobHash !== undefined) page.compressed_blob_hash = compressedBlobHash;
  if (sequence !== undefined && sequence.length > 6) throw serdeError('trailing characters');
  return page;
}

/** multimodal/page_indexer.rs:15 `AttachmentPreview` deserialization. */
export function parseAttachmentPreview(value: JsonValue): AttachmentPreview {
  const previewObject = object(value);
  const sequence = Array.isArray(value) ? value : undefined;
  if (!previewObject && sequence === undefined) throw serdeError('invalid type: expected struct AttachmentPreview');
  if (sequence?.length === 0) throw serdeError('invalid length 0, expected struct AttachmentPreview with 4 elements');
  const alias = (index: number, named: string): string => sequence === undefined ? named : String(index);
  rejectDuplicateField(value, PREVIEW_FIELDS);
  if (previewObject !== undefined && !Object.hasOwn(previewObject, 'pages')) throw serdeError('missing field `pages`');
  const pages = array(fieldWithAlias(value, 'pages', alias(0, 'pages')));
  if (!pages) throw serdeError('invalid type for `pages`');
  const preview: AttachmentPreview = { pages: pages.map(parseAttachmentPreviewPage) };
  const dpi = optionalU32(value, 'dpi', alias(1, 'renderDpi'));
  if (dpi !== undefined) preview.dpi = dpi;
  const pageCount = optionalUnsignedExact(value, 'page_count', alias(2, 'totalPages'), USIZE_MAX);
  if (pageCount !== undefined) preview.page_count = pageCount;
  const renderedAt = optionalString(value, 'rendered_at', alias(3, 'renderedAt'));
  if (renderedAt !== undefined) preview.rendered_at = renderedAt;
  if (sequence !== undefined && sequence.length > 4) throw serdeError('trailing characters');
  return preview;
}
