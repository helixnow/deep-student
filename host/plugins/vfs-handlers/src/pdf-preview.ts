/** Persisted preview DTOs: types.rs:2851-2897 and models.rs:396-492. */
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import qbankContract from '../../../../contracts/ipc/L14-qbank.json' with { type: 'json' };
import sharedContract from '../../../../contracts/ipc/_shared.json' with { type: 'json' };
import { utf8ByteLength } from '../../../platform/util/portable.ts';

const uint = { type: 'integer', minimum: 0, maximum: 4294967295 };
const usize = { type: 'integer', minimum: 0 };
const text = { type: 'string' };
const definitions = structuredClone({ ...sharedContract.$defs, ...qbankContract.$defs }) as Record<string, Record<string, unknown>>;
// These are deserialization requirements, not the serialization required lists.
definitions.ExamSheetPreviewResult!.required = [];
definitions.ExamSheetPreviewPage!.required = ['page_index', 'cards'];
definitions.ExamCardPreview!.required = [];
definitions.PdfPreviewJson = { type: 'object', properties: {
  pages: { type: 'array', items: { $ref: '#/$defs/PdfPagePreview' } },
  renderDpi: uint, totalPages: usize, renderedAt: text,
  isTruncated: { type: 'boolean' }, maxRenderedPages: usize,
}, required: ['pages', 'renderDpi', 'totalPages', 'renderedAt'] };
definitions.PdfPagePreview = { type: 'object', properties: {
  pageIndex: usize, blobHash: text, width: uint, height: uint, mimeType: text,
  compressedBlobHash: { anyOf: [text, { type: 'null' }] },
}, required: ['pageIndex', 'blobHash', 'width', 'height', 'mimeType'] };
// Rust structs ignore unknown persisted keys (no deny_unknown_fields).
function allowUnknown(schema: unknown): void {
  if (schema === null || typeof schema !== 'object') return;
  const value = schema as Record<string, unknown>;
  if (typeof value.$ref === 'string') value.$ref = value.$ref.replace(/^_shared\.json#/, '#');
  if (value.type === 'object') value.additionalProperties = true;
  for (const child of Object.values(value)) allowUnknown(child);
}
allowUnknown(definitions);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const pdfValidator = ajv.compile({ $defs: definitions, $ref: '#/$defs/PdfPreviewJson' });
const examValidator = ajv.compile({ $defs: definitions, $ref: '#/$defs/ExamSheetPreviewResult' });

export interface PreviewPage {
  pageIndex: number; blobHash: string; mimeType: string; compressedBlobHash?: string | null;
}
export interface ExamPreviewPage { page_index: number; blob_hash?: string | null }

/** Record token ends for serde's byte-based line/column on persisted JSON errors. */
function tokenEnds(raw: string): Map<string, number> {
  const ends = new Map<string, number>();
  const tokens = [...raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  let i = 0;
  function value(pointer: string): void {
    const token = tokens[i++]!;
    if (token[0] === '{') {
      while (tokens[i]![0] !== '}') {
        const key = JSON.parse(tokens[i++]![0]) as string;
        i++; // colon
        value(`${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        if (tokens[i]![0] !== ',') break;
        i++;
      }
      const close = tokens[i++]!;
      ends.set(pointer, close.index! + 1);
    } else if (token[0] === '[') {
      let index = 0;
      while (tokens[i]![0] !== ']') {
        value(`${pointer}/${index++}`);
        if (tokens[i]![0] !== ',') break;
        i++;
      }
      const close = tokens[i++]!;
      ends.set(pointer, close.index! + 1);
    } else ends.set(pointer, token.index! + token[0].length);
  }
  value('');
  return ends;
}
function location(raw: string, offset: number): string {
  const before = raw.slice(0, offset);
  return ` at line ${before.split('\n').length} column ${utf8ByteLength(before.slice(before.lastIndexOf('\n') + 1))}`;
}
function atPointer(value: unknown, pointer: string): unknown {
  for (const key of pointer.split('/').slice(1)) value = (value as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')];
  return value;
}
function validationMessage(error: ErrorObject, value: unknown): string {
  if (error.keyword === 'required') return `missing field \`${String(error.params.missingProperty)}\``;
  if (error.keyword === 'enum') return `unknown variant \`${String(value)}\`, expected ${error.params.allowedValues.map((v: string) => `\`${v}\``).join(', ')}`;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'sequence'
    : typeof value === 'object' ? 'map' : typeof value === 'string' ? `string ${JSON.stringify(value)}`
      : typeof value === 'number' ? `${Number.isInteger(value) ? 'integer' : 'floating point'} \`${value}\`` : `boolean \`${value}\``;
  const expected = error.keyword === 'minimum' || error.keyword === 'maximum' || error.params.type === 'integer'
    ? (error.schemaPath.includes('pageIndex') || error.schemaPath.includes('page_index') || error.schemaPath.includes('totalPages') || error.schemaPath.includes('maxRenderedPages') ? 'usize' : 'u32')
    : error.params.type === 'array' ? 'a sequence' : error.params.type === 'boolean' ? 'a boolean'
      : error.params.type === 'object' ? `struct ${/\$defs\/([^/]+)/.exec(error.schemaPath)?.[1] ?? 'PdfPreviewJson'}` : 'a string';
  return `invalid ${error.keyword === 'minimum' || error.keyword === 'maximum' ? 'value' : 'type'}: ${actual}, expected ${expected}`;
}
/** Only classifies an EOF already reported by JSON.parse; does not parse values.
 * serde_json 1.0.149 de.rs: MapAccess/SeqAccess EOF after a comma is Value,
 * after an opening container or complete member it is Object/List, and after
 * a colon (or inside a partial scalar) the field deserializer reports Value.
 */
function eofContext(raw: string): 'an object' | 'a list' | 'a string' | 'a value' {
  const containers: Array<'an object' | 'a list'> = [];
  let awaitingValue = true;
  for (let i = 0; i < raw.length;) {
    const char = raw[i]!;
    if (/[ \t\r\n]/.test(char)) { i++; continue; }
    if (char === '"') {
      i++;
      for (;;) {
        if (i >= raw.length) return 'a string';
        const next = raw[i++]!;
        if (next === '"') break;
        if (next === '\\') i++; // Escaped quotes/brackets are not container tokens.
      }
      awaitingValue = false;
    } else if (char === '{' || char === '[') {
      containers.push(char === '{' ? 'an object' : 'a list');
      awaitingValue = false;
      i++;
    } else if (char === '}' || char === ']') {
      containers.pop();
      awaitingValue = false;
      i++;
    } else if (char === ':' || char === ',') {
      awaitingValue = true;
      i++;
    } else {
      const start = i;
      while (i < raw.length && !/[ \t\r\n{}\[\],:]/.test(raw[i]!)) i++;
      const token = raw.slice(start, i);
      awaitingValue = !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token);
    }
  }
  return awaitingValue ? 'a value' : containers.at(-1) ?? 'a value';
}

export function parsePreview(raw: string, exam: boolean): { pages: PreviewPage[]; totalPages: number } | { pages: ExamPreviewPage[] } {
  const prefix = exam ? '解析 exam preview_json 失败' : '解析 preview_json 失败';
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offset = Number(/position (\d+)/.exec(message)?.[1] ?? raw.length);
    const eof = /end of JSON|end of data/i.test(message) || offset >= raw.length;
    const detail = /Unterminated string/i.test(message) ? 'EOF while parsing a string'
      : eof ? `EOF while parsing ${eofContext(raw)}`
        : /property name|double-quoted property/i.test(message) ? 'key must be a string'
          : /Expected ':'/i.test(message) ? 'expected `:`'
            : /Expected ',' or '}'/i.test(message) ? 'expected `,` or `}`'
              : /Expected ',' or ']'/i.test(message) ? 'expected `,` or `]`'
                : /after JSON/i.test(message) ? 'trailing characters'
                  : /Bad escaped|Bad Unicode escape/i.test(message) ? 'invalid escape'
                    : /Bad control character/i.test(message) ? 'control character (\\u0000-\\u001F) found while parsing a string'
                      : 'expected value';
    throw new Error(`${prefix}: ${detail}${location(raw, eof ? raw.length : offset + 1)}`);
  }
  const validate = exam ? examValidator : pdfValidator;
  if (!validate(value)) {
    const ends = tokenEnds(raw);
    // Present invalid fields are read before serde checks absent required fields.
    const errors = validate.errors!.filter(error => error.keyword !== 'anyOf');
    errors.sort((a, b) => (ends.get(a.instancePath) ?? raw.length) - (ends.get(b.instancePath) ?? raw.length));
    const error = errors[0]!;
    throw new Error(`${prefix}: ${validationMessage(error, atPointer(value, error.instancePath))}${location(raw, ends.get(error.instancePath) ?? raw.length)}`);
  }
  if (exam) return { pages: (value as { pages?: ExamPreviewPage[] }).pages ?? [] };
  return value as { pages: PreviewPage[]; totalPages: number };
}
