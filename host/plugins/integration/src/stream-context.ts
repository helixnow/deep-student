/**
 * serde codec for `dstu_core::models::StreamContext` (models.rs:177-210) as stored in
 * `temp_sessions.session_data` (`serde_json::to_string` / `from_str`, dstu-storage
 * database/mod.rs:4172-4173, 4208-4209).
 *
 * Typed down to `StreamContext`, `ChatMessage` (models.rs:9-57) and `ChatMetadata`
 * (models.rs:212-223): required fields, `mistake_id` alias, duplicate/missing field
 * failures, `#[serde(default)]`, `skip_serializing_if = "Option::is_none"`, field
 * declaration order, unknown fields dropped on re-serialization, chrono `DateTime<Utc>`
 * normalization. Deeper typed structs (RagSourceInfo, DocumentAttachment,
 * MultimodalContentPart, ToolCall/ToolResult, MistakeExamSheetLink, BridgeLinkContext)
 * are kept as exact `serde_json::Value` nodes (container kind checked); see LANE.md.
 */
import {
  JsonReader,
  stringifyJsonValue,
  type JsonNode,
} from '../../../platform/util/portable.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import type { ChatMetadata, StreamChatMessage, StreamContext, TempStreamState } from '../api.ts';

export type { StreamContext } from '../api.ts';

// ------------------------------------------------------------------ chrono

/** chrono `Deserialize for DateTime<Utc>` then `Serialize` (FormatIso8601: AutoSi + `Z`). */
function readDateTime(r: JsonReader): string {
  const raw = r.readString('a formatted date and time string or a unix timestamp');
  const parsed = parseRfc3339(raw);
  if (parsed === null) throw r.error('input contains invalid characters');
  return toRfc3339Opts(parsed.epochNanos, 'AutoSi', true);
}

/** `DateTime::<Utc>::to_rfc3339()` of a serde-form value (column `created_at`, mod.rs:4187). */
export function dateTimeEpochNanos(value: string): bigint {
  const parsed = parseRfc3339(value);
  if (parsed === null) throw new TypeError(`Invalid chrono DateTime: ${value}`);
  return parsed.epochNanos;
}

/** chrono `Serialize for DateTime<Utc>` of an in-memory value (FormatIso8601: AutoSi + `Z`). */
export function serdeDateTime(value: string): string {
  return toRfc3339Opts(dateTimeEpochNanos(value), 'AutoSi', true);
}

// ------------------------------------------------------------------ decode helpers

function readStringVec(r: JsonReader): string[] {
  r.beginArray();
  const out: string[] = [];
  while (r.nextItem()) out.push(r.readString());
  return out;
}

function readOpt<T>(r: JsonReader, read: (r: JsonReader) => T): T | null {
  return r.readOptionNone() ? null : read(r);
}

/** A typed field kept as a Value node: the container kind must still match. */
function readKind(kind: 'array' | 'object', expected: string): (r: JsonReader) => JsonNode {
  return (r) => {
    if (r.peekKind() !== kind) throw r.invalidType(expected);
    return r.readValue();
  };
}
const readSeqNode = readKind('array', 'a sequence');
const readStructNode = (name: string) => readKind('object', `struct ${name}`);
const readAnyValue = (r: JsonReader): JsonNode => r.readValue();

/** derive(Deserialize) struct walk: duplicate known field → error; unknown → IgnoredAny. */
function readStruct(
  r: JsonReader,
  name: string,
  fields: Record<string, (r: JsonReader) => void>,
  aliases: Record<string, string> = {},
): Set<string> {
  r.beginObject(`struct ${name}`);
  const seen = new Set<string>();
  for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
    const field = aliases[key] ?? key;
    const read = fields[field];
    if (read === undefined) { r.skipValue(); continue; }
    if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
    seen.add(field);
    read(r);
  }
  return seen;
}

function required<T>(r: JsonReader, value: T | undefined, field: string): T {
  if (value === undefined) throw r.error(`missing field \`${field}\``);
  return value;
}

function readChatMetadata(r: JsonReader): ChatMetadata {
  let title: string | undefined;
  const out: Omit<ChatMetadata, 'title'> = { summary: null, tags: [], attributes: null, note: null };
  readStruct(r, 'ChatMetadata', {
    title: (x) => { title = x.readString(); },
    summary: (x) => { out.summary = readOpt(x, (y) => y.readString()); },
    tags: (x) => { out.tags = readStringVec(x); },
    attributes: (x) => { out.attributes = readOpt(x, readAnyValue); },
    note: (x) => { out.note = readOpt(x, (y) => y.readString()); },
  });
  return { title: required(r, title, 'title'), ...out };
}

function readChatMessage(r: JsonReader): StreamChatMessage {
  let role: string | undefined;
  let content: string | undefined;
  let timestamp: string | undefined;
  const opt: Omit<StreamChatMessage, 'role' | 'content' | 'timestamp'> = {
    thinking_content: null, thought_signature: null, rag_sources: null, memory_sources: null,
    graph_sources: null, web_search_sources: null, image_paths: null, image_base64: null,
    doc_attachments: null, multimodal_content: null, tool_call: null, tool_result: null,
    overrides: null, relations: null, persistent_stable_id: null, metadata: null,
  };
  const str = (x: JsonReader) => x.readString();
  readStruct(r, 'ChatMessage', {
    role: (x) => { role = x.readString(); },
    content: (x) => { content = x.readString(); },
    timestamp: (x) => { timestamp = readDateTime(x); },
    thinking_content: (x) => { opt.thinking_content = readOpt(x, str); },
    thought_signature: (x) => { opt.thought_signature = readOpt(x, str); },
    rag_sources: (x) => { opt.rag_sources = readOpt(x, readSeqNode); },
    memory_sources: (x) => { opt.memory_sources = readOpt(x, readSeqNode); },
    graph_sources: (x) => { opt.graph_sources = readOpt(x, readSeqNode); },
    web_search_sources: (x) => { opt.web_search_sources = readOpt(x, readSeqNode); },
    image_paths: (x) => { opt.image_paths = readOpt(x, readStringVec); },
    image_base64: (x) => { opt.image_base64 = readOpt(x, readStringVec); },
    doc_attachments: (x) => { opt.doc_attachments = readOpt(x, readSeqNode); },
    multimodal_content: (x) => { opt.multimodal_content = readOpt(x, readSeqNode); },
    tool_call: (x) => { opt.tool_call = readOpt(x, readStructNode('ToolCall')); },
    tool_result: (x) => { opt.tool_result = readOpt(x, readStructNode('ToolResult')); },
    overrides: (x) => { opt.overrides = readOpt(x, readAnyValue); },
    relations: (x) => { opt.relations = readOpt(x, readAnyValue); },
    persistent_stable_id: (x) => { opt.persistent_stable_id = readOpt(x, str); },
    metadata: (x) => { opt.metadata = readOpt(x, readAnyValue); },
  });
  return {
    role: required(r, role, 'role'),
    content: required(r, content, 'content'),
    timestamp: required(r, timestamp, 'timestamp'),
    ...opt,
  };
}

function readStreamState(r: JsonReader): TempStreamState {
  const value = r.readString('variant identifier');
  if (value === 'in_progress' || value === 'completed' || value === 'failed') return value;
  throw r.error(`unknown variant \`${value}\`, expected one of \`in_progress\`, \`completed\`, \`failed\``);
}

/** `serde_json::from_str::<StreamContext>`. Throws on any serde failure. */
export function decodeStreamContext(text: string): StreamContext {
  const r = new JsonReader(text);
  const v: Partial<StreamContext> = {};
  const str = (x: JsonReader) => x.readString();
  readStruct(r, 'StreamContext', {
    temp_id: (x) => { v.temp_id = x.readString(); },
    question_images: (x) => { v.question_images = readStringVec(x); },
    analysis_images: (x) => { v.analysis_images = readStringVec(x); },
    user_question: (x) => { v.user_question = x.readString(); },
    ocr_text: (x) => { v.ocr_text = x.readString(); },
    ocr_note: (x) => { v.ocr_note = readOpt(x, str); },
    tags: (x) => { v.tags = readStringVec(x); },
    mistake_type: (x) => { v.mistake_type = x.readString(); },
    chat_category: (x) => { v.chat_category = x.readString(); },
    chat_metadata: (x) => { v.chat_metadata = readOpt(x, readChatMetadata); },
    chat_history: (x) => {
      x.beginArray();
      const list: StreamChatMessage[] = [];
      while (x.nextItem()) list.push(readChatMessage(x));
      v.chat_history = list;
    },
    initial_doc_attachments: (x) => { v.initial_doc_attachments = readOpt(x, readSeqNode); },
    pinned_images: (x) => { v.pinned_images = readOpt(x, readStringVec); },
    created_at: (x) => { v.created_at = readDateTime(x); },
    exam_sheet: (x) => { v.exam_sheet = readOpt(x, readStructNode('MistakeExamSheetLink')); },
    stream_state: (x) => { v.stream_state = readStreamState(x); },
    bridge_context: (x) => { v.bridge_context = readOpt(x, readStructNode('BridgeLinkContext')); },
    last_error: (x) => { v.last_error = readOpt(x, str); },
  }, { mistake_id: 'temp_id' });
  const ctx: StreamContext = {
    temp_id: required(r, v.temp_id, 'temp_id'),
    question_images: required(r, v.question_images, 'question_images'),
    analysis_images: required(r, v.analysis_images, 'analysis_images'),
    user_question: required(r, v.user_question, 'user_question'),
    ocr_text: required(r, v.ocr_text, 'ocr_text'),
    ocr_note: v.ocr_note ?? null,
    tags: required(r, v.tags, 'tags'),
    mistake_type: required(r, v.mistake_type, 'mistake_type'),
    chat_category: required(r, v.chat_category, 'chat_category'),
    chat_metadata: v.chat_metadata ?? null,
    chat_history: required(r, v.chat_history, 'chat_history'),
    initial_doc_attachments: v.initial_doc_attachments ?? null,
    pinned_images: v.pinned_images ?? null,
    created_at: required(r, v.created_at, 'created_at'),
    exam_sheet: v.exam_sheet ?? null,
    stream_state: v.stream_state ?? 'in_progress',
    bridge_context: v.bridge_context ?? null,
    last_error: v.last_error ?? null,
  };
  r.end();
  return ctx;
}

// ------------------------------------------------------------------ encode

/** serde_json string escaping (`ser.rs` ESCAPE table) equals JSON.stringify for valid UTF-8. */
const s = (value: string): string => JSON.stringify(value);

/**
 * `serde_json::Value` serialization (arbitrary_precision + preserve_order) through F4's
 * formal `stringifyJsonValue`: number spelling stays authoritative (`raw`, normalized
 * exponent/`-0`, no Number/Infinity), duplicate keys are last-wins at the first position.
 */
export function encodeValue(node: JsonNode): string {
  return stringifyJsonValue(node);
}

type Field = [name: string, json: string | null];
const obj = (fields: Field[]): string =>
  `{${fields.filter((f): f is [string, string] => f[1] !== null).map(([k, v]) => `${s(k)}:${v}`).join(',')}}`;
const vec = (values: readonly string[]): string => `[${values.map(s).join(',')}]`;
const opt = <T>(value: T | null, encode: (value: T) => string): string | null => (value === null ? null : encode(value));

function encodeChatMetadata(m: ChatMetadata): string {
  return obj([
    ['title', s(m.title)],
    ['summary', opt(m.summary, s)],
    ['tags', vec(m.tags)],
    ['attributes', opt(m.attributes, encodeValue)],
    ['note', opt(m.note, s)],
  ]);
}

function encodeChatMessage(m: StreamChatMessage): string {
  return obj([
    ['role', s(m.role)],
    ['content', s(m.content)],
    ['timestamp', s(serdeDateTime(m.timestamp))],
    ['thinking_content', opt(m.thinking_content, s)],
    ['thought_signature', opt(m.thought_signature, s)],
    ['rag_sources', opt(m.rag_sources, encodeValue)],
    ['memory_sources', opt(m.memory_sources, encodeValue)],
    ['graph_sources', opt(m.graph_sources, encodeValue)],
    ['web_search_sources', opt(m.web_search_sources, encodeValue)],
    ['image_paths', opt(m.image_paths, vec)],
    ['image_base64', opt(m.image_base64, vec)],
    ['doc_attachments', opt(m.doc_attachments, encodeValue)],
    ['multimodal_content', opt(m.multimodal_content, encodeValue)],
    ['tool_call', opt(m.tool_call, encodeValue)],
    ['tool_result', opt(m.tool_result, encodeValue)],
    ['overrides', opt(m.overrides, encodeValue)],
    ['relations', opt(m.relations, encodeValue)],
    ['persistent_stable_id', opt(m.persistent_stable_id, s)],
    ['metadata', opt(m.metadata, encodeValue)],
  ]);
}

/** `serde_json::to_string(&StreamContext)`: declaration order, `None` skipped. */
export function encodeStreamContext(c: StreamContext): string {
  return obj([
    ['temp_id', s(c.temp_id)],
    ['question_images', vec(c.question_images)],
    ['analysis_images', vec(c.analysis_images)],
    ['user_question', s(c.user_question)],
    ['ocr_text', s(c.ocr_text)],
    ['ocr_note', opt(c.ocr_note, s)],
    ['tags', vec(c.tags)],
    ['mistake_type', s(c.mistake_type)],
    ['chat_category', s(c.chat_category)],
    ['chat_metadata', opt(c.chat_metadata, encodeChatMetadata)],
    ['chat_history', `[${c.chat_history.map(encodeChatMessage).join(',')}]`],
    ['initial_doc_attachments', opt(c.initial_doc_attachments, encodeValue)],
    ['pinned_images', opt(c.pinned_images, vec)],
    ['created_at', s(serdeDateTime(c.created_at))],
    ['exam_sheet', opt(c.exam_sheet, encodeValue)],
    ['stream_state', s(c.stream_state)],
    ['bridge_context', opt(c.bridge_context, encodeValue)],
    ['last_error', opt(c.last_error, s)],
  ]);
}

/** `Clone for StreamContext`: callers receive copies, never the cached instance. */
export function cloneStreamContext(c: StreamContext): StreamContext {
  return structuredClone(c);
}
