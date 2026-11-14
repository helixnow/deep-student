/**
 * 回放的 `POST …/v1/audio/transcriptions`（OpenAI multipart wire 格式）。这里只解码请求；用哪段文本
 * （或哪个错误）应答由脚本决定（answer.ts）。应答字节只取决于那段文本和表单字段，与 multipart
 * boundary、片段顺序、时钟、随机数无关。可移植：只用 Uint8Array / DataView / TextDecoder。
 *
 * 请求：`multipart/form-data`（RFC 7578），带文件名的 `file` 片段和 `model` 字段；可选 `language`、
 * `prompt`、`response_format`。这几个各自最多出现一次；其他字段（`temperature`、
 * `timestamp_granularities[]` …）接受，只记日志。
 * 按 `response_format` 应答：
 *   - `json`（缺省）：`{"text":…}`，application/json；
 *   - `text`：文本本身，text/plain; charset=utf-8；
 *   - `verbose_json`：`{"task":"transcribe","language":…,"duration":…,"text":…,"segments":[…]}`。
 *     `language` 取表单字段，没有时为 `"unknown"`；`duration` 是 PCM WAV 的时长（data 字节数 / 字节率，
 *     四舍五入到整毫秒），其他文件为 null；时长已知且文本非空时有一个片段
 *     `{id:0,seek:0,start:0,end:duration,text}`，否则没有；
 *   - 其他值：400 `unsupported-response-format`（消息里写明 `response_format`）。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface MultipartPart { name: string; filename: string | null; contentType: string | null; data: Uint8Array }

/** 请求日志保留的片段信息：字段文本，或文件元数据与其字节的 sha256。 */
export type LoggedPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string | null; size: number; sha256: string };

export interface TranscriptionRequest {
  model: string;
  language: string | null;
  prompt: string | null;
  responseFormat: string;
  file: { filename: string; contentType: string | null; data: Uint8Array };
}

export type TranscriptionDecode =
  | { ok: true; request: TranscriptionRequest; parts: LoggedPart[] }
  | { ok: false; outcome: 'bad-multipart' | 'bad-transcription-request' | 'unsupported-response-format'; status: number; message: string;
    parts: LoggedPart[] | null };

const RESPONSE_FORMATS = new Set(['json', 'text', 'verbose_json']);
const SINGLE_FIELDS = ['file', 'model', 'language', 'prompt', 'response_format'];

/** 与 Node `Buffer#toString('utf8')` 相同：非法序列替换为 U+FFFD，保留开头的 BOM。 */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();
const CRLF_CRLF = encoder.encode('\r\n\r\n');

/** `needle` 在 `haystack` 中从 `from` 起的第一个位置；没有时为 -1。 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  for (let i = haystack.indexOf(needle[0]!, from); i >= 0 && i <= last; i = haystack.indexOf(needle[0]!, i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

const startsWithAt = (data: Uint8Array, at: number, bytes: Uint8Array) => bytes.every((byte, i) => data[at + i] === byte);
const isCrlfAt = (data: Uint8Array, at: number) => data[at] === 0x0d && data[at + 1] === 0x0a;
const latin1 = (data: Uint8Array, start: number, end: number) => String.fromCharCode(...data.subarray(start, end));

/** `;` 分隔的头参数（`name="x"`、`boundary=y`），参数名小写，去掉引号与 `\` 转义。 */
function headerParameters(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of value.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const name = match[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!.trim());
  }
  return out;
}

/** RFC 7578 正文切分。每个片段都要有 `Content-Disposition: form-data; name=…`。 */
export function parseMultipart(contentType: string | null | undefined, body: Uint8Array): { ok: true; parts: MultipartPart[] } | { ok: false; message: string } {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'multipart/form-data') return { ok: false, message: `content-type must be multipart/form-data, got ${JSON.stringify(contentType ?? null)}` };
  const boundary = headerParameters(contentType!.slice(contentType!.indexOf(';'))).get('boundary');
  if (!boundary) return { ok: false, message: 'multipart content-type has no boundary' };
  const data = new Uint8Array(body.length + 2);
  data.set([0x0d, 0x0a]);
  data.set(body, 2);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  let at = indexOfBytes(data, delimiter, 0);
  if (at < 0) return { ok: false, message: 'multipart body has no opening boundary' };
  const parts: MultipartPart[] = [];
  for (;;) {
    let cursor = at + delimiter.length;
    if (data[cursor] === 0x2d && data[cursor + 1] === 0x2d) return { ok: true, parts };
    while (data[cursor] === 0x20 || data[cursor] === 0x09) cursor++;
    if (!isCrlfAt(data, cursor)) return { ok: false, message: `part ${parts.length}: boundary line is not followed by CRLF` };
    const headersEnd = indexOfBytes(data, CRLF_CRLF, cursor);
    const next = indexOfBytes(data, delimiter, cursor);
    if (next < 0) return { ok: false, message: `part ${parts.length}: no closing boundary` };
    // 没有头行的片段，正文紧跟在 boundary 行的 CRLF 之后。
    const empty = startsWithAt(data, cursor, CRLF_CRLF);
    if (!empty && (headersEnd < 0 || headersEnd > next)) return { ok: false, message: `part ${parts.length}: headers are not terminated` };
    const headerText = empty ? '' : utf8.decode(data.subarray(cursor + 2, headersEnd));
    const bodyStart = empty ? cursor + 4 : headersEnd + 4;
    const headers = new Map<string, string>();
    for (const line of headerText.split('\r\n')) {
      if (line === '') continue;
      const colon = line.indexOf(':');
      if (colon <= 0) return { ok: false, message: `part ${parts.length}: malformed header line ${JSON.stringify(line)}` };
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const disposition = headers.get('content-disposition') ?? '';
    if (disposition.split(';')[0]!.trim().toLowerCase() !== 'form-data') return { ok: false, message: `part ${parts.length}: Content-Disposition must be form-data` };
    const parameters = headerParameters(disposition.slice(disposition.indexOf(';') < 0 ? disposition.length : disposition.indexOf(';')));
    const name = parameters.get('name');
    if (name === undefined) return { ok: false, message: `part ${parts.length}: Content-Disposition has no name` };
    parts.push({ name, filename: parameters.get('filename') ?? null, contentType: headers.get('content-type') ?? null,
      data: data.slice(bodyStart, next) });
    at = next;
  }
}

function logged(part: MultipartPart): LoggedPart {
  return part.filename === null ? { name: part.name, value: utf8.decode(part.data) }
    : { name: part.name, filename: part.filename, contentType: part.contentType, size: part.data.length, sha256: bytesToHex(sha256(part.data)) };
}

/** 解码并校验转写请求；正文能解析时 `parts` 是写进日志的投影。 */
export function decodeTranscription(contentType: string | null | undefined, body: Uint8Array): TranscriptionDecode {
  const parsed = parseMultipart(contentType, body);
  if (parsed.ok === false) return { ok: false, outcome: 'bad-multipart', status: 400, message: `x5 llm service: ${parsed.message}`, parts: null };
  const parts = parsed.parts.map(logged);
  const fail = (outcome: 'bad-transcription-request' | 'unsupported-response-format', message: string): TranscriptionDecode =>
    ({ ok: false, outcome, status: 400, message: `x5 llm service: ${message}`, parts });
  for (const name of SINGLE_FIELDS) {
    if (parsed.parts.filter(part => part.name === name).length > 1) return fail('bad-transcription-request', `field ${name} appears more than once`);
  }
  const field = (name: string) => parsed.parts.find(part => part.name === name);
  const file = field('file');
  if (!file || file.filename === null) return fail('bad-transcription-request', 'transcription needs a file part with a filename');
  const text = (name: string): string | null => {
    const part = field(name);
    return part === undefined || part.filename !== null ? null : utf8.decode(part.data);
  };
  const model = text('model');
  if (model === null || model === '') return fail('bad-transcription-request', 'transcription needs a model field');
  const responseFormat = text('response_format') ?? 'json';
  if (!RESPONSE_FORMATS.has(responseFormat)) {
    return fail('unsupported-response-format', `response_format ${JSON.stringify(responseFormat)} is not supported (json, text, verbose_json)`);
  }
  return { ok: true, parts, request: { model, language: text('language'), prompt: text('prompt'), responseFormat,
    file: { filename: file.filename, contentType: file.contentType, data: file.data } } };
}

/** RIFF/WAVE 文件的毫秒数：`data` 块字节数（截到文件末尾）/ `fmt ` 字节率；不是 WAV 时为 null。 */
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 12 || latin1(bytes, 0, 4) !== 'RIFF' || latin1(bytes, 8, 12) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate: number | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = latin1(bytes, at, at + 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) byteRate = view.getUint32(body + 8, true);
    if (id === 'data') {
      if (!byteRate) return null;
      return Math.round((Math.min(size, bytes.length - body) * 1000) / byteRate);
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** 按请求的 response_format（已由 decodeTranscription 校验）给出 `text` 的应答体。 */
export function transcriptionResponse(request: TranscriptionRequest, text: string): { contentType: string; body: string } {
  if (request.responseFormat === 'text') return { contentType: 'text/plain; charset=utf-8', body: text };
  if (request.responseFormat === 'json') return { contentType: 'application/json', body: JSON.stringify({ text }) };
  const ms = wavDurationMs(request.file.data);
  const duration = ms === null ? null : ms / 1000;
  const segments = duration === null || text === '' ? [] : [{ id: 0, seek: 0, start: 0, end: duration, text }];
  return { contentType: 'application/json', body: JSON.stringify({ task: 'transcribe', language: request.language ?? 'unknown', duration, text, segments }) };
}
