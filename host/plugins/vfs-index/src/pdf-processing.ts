import type { ProcessingProgress, ProcessingProgressSnapshot, ProcessingStage } from '../api.ts';
import { JsonReader, JsonSyntaxError, f32ToJsonNumber, rustTrim } from '../../../platform/util/portable.ts';

const stageOrder: Record<ProcessingStage, number> = {
  pending: 0, queued: 0, decode: 1, vad: 2, asr: 5, indexing: 6,
  text_extraction: 1, page_rendering: 2, page_compression: 3, image_compression: 4,
  ocr_processing: 5, vector_indexing: 6, completed: 7, completed_with_issues: 8, error: 9,
};
export function processingStageFromString(value: string): ProcessingStage {
  const normalized = rustTrim(value).toLowerCase();
  return Object.hasOwn(stageOrder, normalized) ? normalized as ProcessingStage : 'pending';
}
export function processingStageAsString(stage: ProcessingStage): string { return stage; }
export function compareProcessingStages(left: ProcessingStage, right: ProcessingStage): number { return Math.sign(stageOrder[left] - stageOrder[right]); }
export function defaultProcessingProgress(): ProcessingProgress { return { stage: 'pending', percent: 0, readyModes: [] }; }
export function hasRetriableFailure(progress: ProcessingProgress | ProcessingProgressSnapshot): boolean { return progress.failedStages?.some(issue => issue.retriable) ?? false; }

function readOptionalPage(reader: JsonReader): number | bigint | undefined {
  if (reader.readOptionNone()) return undefined;
  const value = reader.readUnsigned('usize', 18446744073709551615n);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function readProgressPercent(reader: JsonReader): number {
  const parsed = reader.readNumber('f32');
  if (parsed.kind === 'f64') return Math.fround(parsed.value);
  // serde's integer visitor casts straight to f32. Round the integer to 24
  // significant bits before converting to JS, avoiding an intervening f64 tie.
  const negative = parsed.value < 0n;
  const magnitude = negative ? -parsed.value : parsed.value;
  const shift = Math.max(0, magnitude.toString(2).length - 24);
  if (shift === 0) return Math.fround(Number(parsed.value));
  let significand = magnitude >> BigInt(shift);
  const remainder = magnitude - (significand << BigInt(shift));
  const halfway = 1n << BigInt(shift - 1);
  if (remainder > halfway || (remainder === halfway && (significand & 1n) !== 0n)) significand++;
  return Math.fround((negative ? -1 : 1) * Number(significand) * 2 ** shift);
}

function readReadyModes(reader: JsonReader): string[] {
  reader.beginArray();
  const modes: string[] = [];
  while (reader.nextItem()) modes.push(reader.readString());
  return modes;
}

function readIssue(reader: JsonReader): import('../api.ts').ProcessingIssue {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    if (!reader.nextItem()) throw reader.error('missing ProcessingIssue stage');
    const stage = reader.readString();
    if (!reader.nextItem()) throw reader.error('missing ProcessingIssue message');
    const message = reader.readString();
    const hasRetriable = reader.nextItem();
    const retriable = hasRetriable ? reader.readBool() : false;
    if (hasRetriable && reader.nextItem()) throw reader.error('extra ProcessingIssue element');
    return { stage, message, retriable };
  }
  reader.beginObject('struct ProcessingIssue');
  const seen = new Set<string>();
  let stage: string | undefined, message: string | undefined, retriable = false;
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    if (key !== 'stage' && key !== 'message' && key !== 'retriable') { reader.skipIgnoredValue(); continue; }
    if (seen.has(key)) throw reader.fieldError(`duplicate field \`${key}\``);
    seen.add(key);
    if (key === 'stage') stage = reader.readString();
    else if (key === 'message') message = reader.readString();
    else retriable = reader.readBool();
  }
  if (stage === undefined) throw reader.error('missing field `stage`');
  if (message === undefined) throw reader.error('missing field `message`');
  return { stage, message, retriable };
}

function readIssues(reader: JsonReader): import('../api.ts').ProcessingIssue[] | undefined {
  if (reader.readOptionNone()) return undefined;
  reader.beginArray();
  const issues: import('../api.ts').ProcessingIssue[] = [];
  while (reader.nextItem()) issues.push(readIssue(reader));
  return issues;
}

const progressFields = ['stage', 'currentPage', 'totalPages', 'percent', 'readyModes', 'mediaType', 'failedStages'] as const;
type ProgressField = typeof progressFields[number];
const progressAliases = new Map<string, ProgressField>([
  ['current_page', 'currentPage'], ['total_pages', 'totalPages'], ['ready_modes', 'readyModes'],
  ['media_type', 'mediaType'], ['failed_stages', 'failedStages'],
]);

function readProgressField(reader: JsonReader, field: ProgressField, progress: ProcessingProgress): void {
  switch (field) {
    case 'stage': progress.stage = reader.readString(); break;
    case 'percent': progress.percent = readProgressPercent(reader); break;
    case 'readyModes': progress.readyModes = readReadyModes(reader); break;
    case 'currentPage': {
      const value = readOptionalPage(reader);
      if (value !== undefined) progress.currentPage = value;
      break;
    }
    case 'totalPages': {
      const value = readOptionalPage(reader);
      if (value !== undefined) progress.totalPages = value;
      break;
    }
    case 'mediaType': if (!reader.readOptionNone()) progress.mediaType = reader.readString(); break;
    case 'failedStages': {
      const value = readIssues(reader);
      if (value !== undefined) progress.failedStages = value;
      break;
    }
  }
}

/** Rust ProcessingProgress serde: invalid data becomes Default, not a partial record. */
export function parseProcessingProgress(text: string | null | undefined): ProcessingProgress {
  if (text === null || text === undefined) return defaultProcessingProgress();
  return tryParseProcessingProgress(text) ?? defaultProcessingProgress();
}

/** `serde_json::from_str::<ProcessingProgress>(..).ok()`: invalid data is `null`, not Default. */
export function tryParseProcessingProgress(text: string): ProcessingProgress | null {
  const reader = new JsonReader(text);
  try {
    const progress = defaultProcessingProgress();
    if (reader.peekKind() === 'array') {
      reader.beginArray();
      let count = 0;
      while (reader.nextItem()) {
        const field = progressFields[count++];
        if (field === undefined) throw reader.error('extra ProcessingProgress element');
        readProgressField(reader, field, progress);
      }
      // Only failed_stages has #[serde(default)] for the sequence visitor.
      if (count < 6) throw reader.error('missing ProcessingProgress element');
    } else {
      reader.beginObject('struct ProcessingProgress');
      const seen = new Set<ProgressField>();
      for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
        const field = progressAliases.get(key) ?? progressFields.find((field) => field === key);
        if (field === undefined) { reader.skipIgnoredValue(); continue; }
        if (seen.has(field)) throw reader.fieldError(`duplicate field \`${field}\``);
        seen.add(field);
        readProgressField(reader, field, progress);
      }
      for (const field of ['stage', 'percent', 'readyModes'] as const) {
        if (!seen.has(field)) throw reader.error(`missing field \`${field}\``);
      }
    }
    reader.end();
    return progress;
  } catch (error) {
    if (error instanceof JsonSyntaxError) return null;
    throw error;
  }
}

/** Rust's serialized struct shape; None options are omitted and non-finite f32 is null. */
export function processingProgressSnapshot(progress: ProcessingProgress): import('../api.ts').ProcessingProgressSnapshot {
  return {
    stage: progress.stage,
    ...(progress.currentPage == null ? {} : { currentPage: progress.currentPage }),
    ...(progress.totalPages == null ? {} : { totalPages: progress.totalPages }),
    percent: f32ToJsonNumber(progress.percent),
    readyModes: [...progress.readyModes],
    ...(progress.mediaType == null ? {} : { mediaType: progress.mediaType }),
    ...(progress.failedStages == null ? {} : { failedStages: progress.failedStages.map((issue) => ({
      stage: issue.stage, message: issue.message, retriable: issue.retriable,
    })) }),
  };
}

/**
 * serde_json `serialize_f32` → zmij 1.0.21 `write::<f32>` (lib.rs:1064-1135): shortest
 * f32 digits, fixed notation for decimal exponents in [-6, 12] (integers keep `.0`),
 * otherwise `d.ddde+X` / `de-X`. Non-finite values serialize as `null`.
 */
function serdeF32Token(value: number): string {
  const f32 = f32ToJsonNumber(value);
  if (f32 === null) return 'null';
  if (f32 === 0) return Object.is(f32, -0) ? '-0.0' : '0.0';
  const exp = f32.toExponential();
  const neg = exp.startsWith('-');
  const [mantissa = '', expPart = '0'] = (neg ? exp.slice(1) : exp).split('e');
  const digits = mantissa.replace('.', '');
  const e = Number(expPart);
  const len = digits.length;
  let out: string;
  if (e >= -6 && e <= 12) {
    if (len - 1 <= e) out = `${digits}${'0'.repeat(e - (len - 1))}.0`;
    else if (e >= 0) out = `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
    else out = `0.${'0'.repeat(-e - 1)}${digits}`;
  } else {
    out = `${digits[0]}${len > 1 ? `.${digits.slice(1)}` : ''}e${e < 0 ? '-' : '+'}${Math.abs(e)}`;
  }
  return neg ? `-${out}` : out;
}

/** Persist serde's JSON numeric tokens: exact usize atoms and the f32 `percent` spelling. */
export function serializeProcessingProgress(progress: ProcessingProgress): string {
  const json = JSON as typeof JSON & { rawJSON(value: string): unknown };
  return JSON.stringify(processingProgressSnapshot(progress), (key, value: unknown) => {
    if (typeof value === 'bigint') return json.rawJSON(value.toString());
    if (key === 'percent' && typeof value === 'number') return json.rawJSON(serdeF32Token(value));
    return value;
  });
}
export function imageExtensionForMime(mime: string): string {
  switch (rustTrim(mime).replace(/[A-Z]/g, c => c.toLowerCase())) {
    case 'image/jpeg': case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/bmp': return '.bmp';
    case 'image/heic': return '.heic';
    case 'image/heif': return '.heif';
    default: return '.png';
  }
}

/** pdf_processing_service.rs:448: biased cancellation before taking capacity. */
export class ProcessingSlots {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(capacity: number) { this.permits = capacity; }
  availablePermits(): number { return this.permits; }
  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.permits > 0) { this.permits--; return Promise.resolve(this.releasePermit()); }
    return new Promise(resolve => {
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(null);
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(this.releasePermit());
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const grant = this.waiters.shift();
      if (grant) grant(); else this.permits++;
    };
  }
}

export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

export interface ImageCompressionResult {
  readonly originalSize: number;
  readonly compressed: Uint8Array;
}

/** Compression primitives owned by the native image adapter (F7). */
export interface ImageCompressionDeps {
  readonly slots: ProcessingSlots;
  readFile(path: string): Promise<Uint8Array>;
  compress(bytes: Uint8Array, quality: ImageQuality): Promise<Uint8Array>;
}

/**
 * `compress_image_path` (pdf_processing_service.rs:464): cancellation is biased
 * before capacity acquisition and re-checked after the codec, so a cancelled
 * token never reads the file. The permit stays held for the whole codec call.
 */
export async function compressImagePath(
  deps: ImageCompressionDeps,
  filePath: string,
  signal: AbortSignal,
  quality: ImageQuality = 'low',
): Promise<ImageCompressionResult | null> {
  const release = await deps.slots.acquire(signal);
  if (release === null) return null;
  try {
    if (signal.aborted) return null;
    const imageData = await deps.readFile(filePath);
    const originalSize = imageData.byteLength;
    const compressed = await deps.compress(imageData, quality);
    if (signal.aborted) return null;
    return { originalSize, compressed };
  } finally {
    release();
  }
}
