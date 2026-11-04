import { visibleInkObjectBounds } from './geometryPrimitives';
import {
  INK_BOARD_LIMITS,
  INK_BOARD_SCHEMA_VERSION,
  INK_LIMITS,
  type InkBoardChunk,
  type InkBoardManifest,
  type InkBoardObject,
  type InkObjectContent,
} from './types';

/**
 * Pure board chunk edit planner.
 *
 * Ownership comes only from `loaded`: an incoming id found there updates that
 * object in its loaded chunk; an incoming id not found there is new only when
 * `allowNew` is true. Unloaded chunks are never fetched; their manifest refs
 * contribute only their summary counts to final-board validation.
 *
 * New object ids are caller-assigned and must be fresh among loaded chunks and
 * the incoming batch. The backend still protects ids inside unloaded chunks.
 * The planner never allocates object ids or z_index values and never hydrates
 * chunks; it only checks collisions among loaded chunks and the incoming batch.
 *
 * New objects are packed whole into deterministic new chunks (never splitting
 * an object's samples). Updated objects stay in their loaded owner chunk. All
 * changes are validated together against chunk limits and the final board
 * limits before anything is returned. Inputs are never mutated.
 */

export interface InkBoardChunkEditPlan {
  changed: InkBoardChunk[];
  previous: Array<{ chunk_id: string; previous?: InkBoardChunk }>;
}

interface ChunkSummary {
  objects: number;
  samples: number;
  bytes: number;
}

interface LoadedCandidate {
  original: InkBoardChunk;
  chunk: InkBoardChunk;
  summary: ChunkSummary;
  changed: boolean;
}

interface PendingNewChunk {
  chunk: InkBoardChunk;
  summary: ChunkSummary;
}

const MIB = 1024 * 1024;
const WORLD_LIMIT = INK_BOARD_LIMITS.world_limit;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

let textEncoder: TextEncoder | undefined;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shared exact-key gate for v2 board objects and render payloads. Unknown keys
 * are rejected instead of being dropped by a rebuild; required keys must be
 * present. The v1 page parser is intentionally untouched.
 */
export function exactBoardKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail('Ink board value must be an object.');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Ink board value has unknown key ${key}.`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`Ink board value is missing key ${key}.`);
    }
  }
  return value;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function jsonByteLength(value: unknown): number {
  let json: string | undefined = undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail('Ink board edit plan contains a non-serializable value.');
  }
  if (typeof json !== 'string') fail('Ink board edit plan contains a non-serializable value.');
  textEncoder ??= new TextEncoder();
  return textEncoder.encode(json).byteLength;
}

/**
 * Exact bytes of an empty chunk. Adding whole object JSON bodies and one comma
 * per extra object yields the exact candidate byte count without re-serializing
 * the growing chunk.
 */
function chunkEnvelopeBytes(chunkId: string): number {
  return jsonByteLength({
    schema_version: INK_BOARD_SCHEMA_VERSION,
    chunk_id: chunkId,
    objects: [],
  });
}

function safeZIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('Ink board z_index must be a safe integer >= 0.');
  }
  return value;
}

function assertCoord(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > WORLD_LIMIT) {
    fail(`Ink board ${label} must be finite and within ±${WORLD_LIMIT}.`);
  }
  return value;
}

function assertRect(value: unknown): void {
  const record = exactBoardKeys(value, ['x', 'y', 'width', 'height']);
  const x = assertCoord(record.x, 'rect.x');
  const y = assertCoord(record.y, 'rect.y');
  const width = record.width;
  const height = record.height;
  if (typeof width !== 'number' || !Number.isFinite(width)
    || typeof height !== 'number' || !Number.isFinite(height)
    || width <= 0 || height <= 0) {
    fail('Ink board rect width/height must be finite and positive.');
  }
  if (x + width > WORLD_LIMIT || y + height > WORLD_LIMIT) {
    fail(`Ink board rect must stay within ±${WORLD_LIMIT}.`);
  }
}

function assertPoint(value: unknown): void {
  const record = exactBoardKeys(value, ['x', 'y']);
  assertCoord(record.x, 'point.x');
  assertCoord(record.y, 'point.y');
}

function assertColor(value: unknown): void {
  if (typeof value !== 'string' || !wellFormed(value) || !HEX_COLOR.test(value)) {
    fail('Ink board color must be a well-formed hex color.');
  }
}

function assertWidth(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value <= 0 || value > INK_LIMITS.width_max) {
    fail(`Ink board width must be finite and within (0, ${INK_LIMITS.width_max}].`);
  }
}

function assertFontSize(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < INK_LIMITS.font_size_min || value > INK_LIMITS.font_size_max) {
    fail(`Ink board font_size must be within ${INK_LIMITS.font_size_min}..${INK_LIMITS.font_size_max}.`);
  }
}

function assertStroke(value: Record<string, unknown>): void {
  const record = exactBoardKeys(value, ['kind', 'samples', 'style']);
  const samples = record.samples;
  if (!Array.isArray(samples)
    || samples.length < INK_LIMITS.stroke_min_samples
    || samples.length > INK_BOARD_LIMITS.chunk_samples_max) {
    fail('Ink board stroke samples are outside the allowed range.');
  }

  let previousElapsed = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const sampleRecord = exactBoardKeys(sample, ['x', 'y', 'pressure'], ['elapsed_ms']);
    assertCoord(sampleRecord.x, 'sample.x');
    assertCoord(sampleRecord.y, 'sample.y');
    const pressure = sampleRecord.pressure;
    if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
      fail('Ink board sample pressure must be finite and within 0..1.');
    }
    if (Object.prototype.hasOwnProperty.call(sampleRecord, 'elapsed_ms')) {
      const elapsed = sampleRecord.elapsed_ms;
      if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)
        || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER || elapsed < previousElapsed) {
        fail('Ink board sample elapsed_ms must be finite, non-negative, and non-decreasing.');
      }
      previousElapsed = elapsed;
    }
  }

  const style = exactBoardKeys(record.style, ['tool', 'color', 'width', 'pressure_enabled']);
  if (style.tool !== 'pen' && style.tool !== 'highlighter') {
    fail('Ink board stroke tool must be pen or highlighter.');
  }
  assertColor(style.color);
  assertWidth(style.width);
  if (typeof style.pressure_enabled !== 'boolean') {
    fail('Ink board stroke pressure_enabled must be boolean.');
  }
}

function assertText(value: Record<string, unknown>): void {
  const record = exactBoardKeys(value, ['kind', 'rect', 'text', 'font_size', 'color']);
  assertRect(record.rect);
  const text = record.text;
  if (typeof text !== 'string' || text.length > INK_LIMITS.text_max_chars || !wellFormed(text)) {
    fail(`Ink board text must be a well-formed string of at most ${INK_LIMITS.text_max_chars} characters.`);
  }
  assertFontSize(record.font_size);
  assertColor(record.color);
}

function assertShape(value: Record<string, unknown>): void {
  const record = exactBoardKeys(value, ['kind', 'rect', 'color', 'width']);
  assertRect(record.rect);
  assertColor(record.color);
  assertWidth(record.width);
}

function assertArrow(value: Record<string, unknown>): void {
  const record = exactBoardKeys(value, ['kind', 'from', 'to', 'color', 'width']);
  assertPoint(record.from);
  assertPoint(record.to);
  assertColor(record.color);
  assertWidth(record.width);
}

function assertContent(value: unknown): asserts value is InkObjectContent {
  if (!isRecord(value)) fail('Ink board object content must be an object.');
  switch (value.kind) {
    case 'stroke':
      assertStroke(value);
      return;
    case 'text':
      assertText(value);
      return;
    case 'rect':
    case 'ellipse':
    case 'region_highlight':
      assertShape(value);
      return;
    case 'arrow':
      assertArrow(value);
      return;
    default:
      fail('Ink board object content kind is unsupported.');
  }
}

export function assertBoardObject(value: unknown): asserts value is InkBoardObject {
  const record = exactBoardKeys(value, ['id', 'author', 'created_at', 'z_index', 'content']);

  const id = record.id;
  if (typeof id !== 'string' || id.length === 0
    || id.length > INK_LIMITS.id_max_chars || !wellFormed(id)) {
    fail('Ink board object id is invalid.');
  }
  if (record.author !== 'user' && record.author !== 'ai') {
    fail('Ink board object author must be user or ai.');
  }
  const createdAt = record.created_at;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    fail('Ink board object created_at must be finite and non-negative.');
  }
  safeZIndex(record.z_index);
  const content = record.content;
  assertContent(content);
  assertVisibleWorldBounds(content, id);
}

function assertVisibleWorldBounds(content: InkObjectContent, objectId: string): void {
  const bounds = visibleInkObjectBounds(content);
  if (!bounds) fail(`Ink board object ${objectId} has no visible bounds.`);
  if (bounds.x < -WORLD_LIMIT || bounds.y < -WORLD_LIMIT
    || bounds.x + bounds.width > WORLD_LIMIT || bounds.y + bounds.height > WORLD_LIMIT) {
    fail(`Ink board object ${objectId} visible footprint exceeds the world bounds.`);
  }
}

function objectSampleCount(object: InkBoardObject): number {
  return object.content.kind === 'stroke' ? object.content.samples.length : 0;
}

function makeChunk(chunkId: string, objects: InkBoardObject[]): InkBoardChunk {
  return {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    chunk_id: chunkId,
    objects,
  };
}

function summarizeChunk(chunk: InkBoardChunk): ChunkSummary {
  let samples = 0;
  for (const object of chunk.objects) samples += objectSampleCount(object);
  return {
    objects: chunk.objects.length,
    samples,
    bytes: jsonByteLength(chunk),
  };
}

function assertChunkLimits(chunk: InkBoardChunk, label: string): ChunkSummary {
  const objects = chunk.objects.length;
  if (objects > INK_BOARD_LIMITS.chunk_objects_max) {
    fail(`${label} exceeds the ${INK_BOARD_LIMITS.chunk_objects_max} object limit.`);
  }
  let samples = 0;
  for (const object of chunk.objects) samples += objectSampleCount(object);
  if (samples > INK_BOARD_LIMITS.chunk_samples_max) {
    fail(`${label} exceeds the ${INK_BOARD_LIMITS.chunk_samples_max} sample limit.`);
  }
  const bytes = jsonByteLength(chunk);
  if (bytes > INK_BOARD_LIMITS.chunk_max_bytes) {
    fail(`${label} exceeds the ${INK_BOARD_LIMITS.chunk_max_bytes / MIB} MiB chunk limit.`);
  }
  return { objects, samples, bytes };
}

function canFitObject(summary: ChunkSummary, objectBytes: number, objectSamples: number): boolean {
  const commaBytes = summary.objects > 0 ? 1 : 0;
  return summary.objects + 1 <= INK_BOARD_LIMITS.chunk_objects_max
    && summary.samples + objectSamples <= INK_BOARD_LIMITS.chunk_samples_max
    && summary.bytes + commaBytes + objectBytes <= INK_BOARD_LIMITS.chunk_max_bytes;
}

function advanceSummary(
  summary: ChunkSummary,
  objectBytes: number,
  objectSamples: number,
): ChunkSummary {
  return {
    objects: summary.objects + 1,
    samples: summary.samples + objectSamples,
    bytes: summary.bytes + (summary.objects > 0 ? 1 : 0) + objectBytes,
  };
}

function indexManifest(manifest: InkBoardManifest): Set<string> {
  if (!manifest || typeof manifest !== 'object') fail('Ink board manifest must be an object.');
  if (manifest.schema_version !== INK_BOARD_SCHEMA_VERSION) {
    fail('Ink board manifest must use schema v2.');
  }
  if (!Array.isArray(manifest.chunks)) fail('Ink board manifest chunks must be an array.');

  const chunkIds = new Set<string>();
  for (const ref of manifest.chunks) {
    if (!ref || typeof ref.chunk_id !== 'string' || ref.chunk_id.length === 0) {
      fail('Ink board manifest chunk id is invalid.');
    }
    if (chunkIds.has(ref.chunk_id)) {
      fail(`Ink board manifest contains duplicate chunk ${ref.chunk_id}.`);
    }
    if (!Number.isSafeInteger(ref.object_count) || ref.object_count < 0
      || !Number.isSafeInteger(ref.sample_count) || ref.sample_count < 0
      || !Number.isSafeInteger(ref.byte_length) || ref.byte_length < 0) {
      fail(`Ink board manifest chunk ${ref.chunk_id} has invalid summary counts.`);
    }
    chunkIds.add(ref.chunk_id);
  }
  return chunkIds;
}

function indexLoaded(loaded: InkBoardChunk[]): {
  loadedById: Map<string, InkBoardChunk>;
  ownerByObjectId: Map<string, InkBoardChunk>;
} {
  if (!Array.isArray(loaded)) fail('Ink board loaded chunks must be an array.');
  const loadedById = new Map<string, InkBoardChunk>();
  const ownerByObjectId = new Map<string, InkBoardChunk>();

  for (const chunk of loaded) {
    if (!chunk || typeof chunk !== 'object') fail('Ink board loaded chunk must be an object.');
    if (chunk.schema_version !== INK_BOARD_SCHEMA_VERSION) {
      fail('Ink board loaded chunk must use schema v2.');
    }
    if (typeof chunk.chunk_id !== 'string' || chunk.chunk_id.length === 0) {
      fail('Ink board loaded chunk id is invalid.');
    }
    if (loadedById.has(chunk.chunk_id)) {
      fail(`Ink board loaded chunks contain duplicate chunk ${chunk.chunk_id}.`);
    }
    if (!Array.isArray(chunk.objects)) {
      fail(`Ink board chunk ${chunk.chunk_id} objects must be an array.`);
    }
    loadedById.set(chunk.chunk_id, chunk);

    for (const object of chunk.objects) {
      if (!object || typeof object !== 'object') fail('Ink board loaded object must be an object.');
      if (typeof object.id !== 'string' || object.id.length === 0) {
        fail('Ink board loaded object id is invalid.');
      }
      if (ownerByObjectId.has(object.id)) {
        fail(`Ink board object ${object.id} appears in more than one loaded chunk.`);
      }
      ownerByObjectId.set(object.id, chunk);
    }
  }

  return { loadedById, ownerByObjectId };
}

function assertFinalZIndexes(
  loaded: InkBoardChunk[],
  incomingIds: Set<string>,
  incoming: InkBoardObject[],
): void {
  const seen = new Map<number, string>();
  const add = (zIndex: number, objectId: string): void => {
    const existing = seen.get(zIndex);
    if (existing !== undefined) {
      fail(`Ink board z_index ${zIndex} is shared by ${existing} and ${objectId}.`);
    }
    seen.set(zIndex, objectId);
  };

  for (const chunk of loaded) {
    for (const object of chunk.objects) {
      if (incomingIds.has(object.id)) continue;
      add(safeZIndex(object.z_index), object.id);
    }
  }
  for (const object of incoming) add(object.z_index, object.id);
}

function assertFinalBoardLimits(
  manifest: InkBoardManifest,
  loaded: InkBoardChunk[],
  changed: InkBoardChunk[],
  changedSummaries: Map<string, ChunkSummary>,
  loadedSummaries: Map<string, ChunkSummary>,
): void {
  // Start with unloaded refs, then let loaded and changed chunks replace their
  // matching refs instead of adding to them. A changed new chunk is added once.
  const summaries = new Map<string, ChunkSummary>();
  for (const ref of manifest.chunks) {
    summaries.set(ref.chunk_id, {
      objects: ref.object_count,
      samples: ref.sample_count,
      bytes: ref.byte_length,
    });
  }
  for (const chunk of loaded) {
    if (changedSummaries.has(chunk.chunk_id)) continue;
    summaries.set(chunk.chunk_id, loadedSummaries.get(chunk.chunk_id) ?? summarizeChunk(chunk));
  }
  for (const chunk of changed) {
    summaries.set(
      chunk.chunk_id,
      changedSummaries.get(chunk.chunk_id) ?? summarizeChunk(chunk),
    );
  }

  let objects = 0;
  let samples = 0;
  let bytes = 0;
  for (const summary of summaries.values()) {
    objects += summary.objects;
    samples += summary.samples;
    bytes += summary.bytes;
  }

  if (summaries.size > INK_BOARD_LIMITS.chunks_max) {
    fail(`Ink board would contain ${summaries.size} chunks; the limit is ${INK_BOARD_LIMITS.chunks_max}.`);
  }
  if (objects > INK_BOARD_LIMITS.objects_max) {
    fail(`Ink board would contain ${objects} objects; the limit is ${INK_BOARD_LIMITS.objects_max}.`);
  }
  if (samples > INK_BOARD_LIMITS.samples_max) {
    fail(`Ink board would contain ${samples} samples; the limit is ${INK_BOARD_LIMITS.samples_max}.`);
  }
  if (bytes > INK_BOARD_LIMITS.content_max_bytes) {
    fail(`Ink board content would be ${bytes} bytes; the limit is ${INK_BOARD_LIMITS.content_max_bytes}.`);
  }
}

export function planBoardChunkEdits(
  manifest: InkBoardManifest,
  loaded: InkBoardChunk[],
  incoming: InkBoardObject[],
  options: { allowNew: boolean },
): InkBoardChunkEditPlan {
  if (!options || typeof options.allowNew !== 'boolean') {
    fail('planBoardChunkEdits requires a boolean allowNew option.');
  }
  if (!Array.isArray(incoming)) fail('Ink board incoming objects must be an array.');
  if (incoming.length === 0) return { changed: [], previous: [] };

  const manifestChunkIds = indexManifest(manifest);
  const { loadedById, ownerByObjectId } = indexLoaded(loaded);

  const incomingIds = new Set<string>();
  for (const object of incoming) {
    assertBoardObject(object);
    if (incomingIds.has(object.id)) {
      fail(`Ink board incoming object id ${object.id} is duplicated.`);
    }
    incomingIds.add(object.id);
  }
  assertFinalZIndexes(loaded, incomingIds, incoming);

  const updatesByChunkId = new Map<string, Map<string, InkBoardObject>>();
  const newObjects: InkBoardObject[] = [];
  for (const object of incoming) {
    const owner = ownerByObjectId.get(object.id);
    if (!owner) {
      if (!options.allowNew) {
        fail(`Ink board object ${object.id} is not in a loaded chunk.`);
      }
      newObjects.push(object);
      continue;
    }
    let updates = updatesByChunkId.get(owner.chunk_id);
    if (!updates) {
      updates = new Map<string, InkBoardObject>();
      updatesByChunkId.set(owner.chunk_id, updates);
    }
    updates.set(object.id, object);
  }

  const loadedCandidates: LoadedCandidate[] = [];
  for (const original of loaded) {
    const updates = updatesByChunkId.get(original.chunk_id);
    let chunk = original;
    let isChanged = false;
    if (updates) {
      let applied = 0;
      const objects = original.objects.map((object) => {
        const updated = updates.get(object.id);
        if (!updated) return object;
        applied += 1;
        return updated;
      });
      if (applied !== updates.size) {
        fail(`Ink board chunk ${original.chunk_id} did not contain every updated object.`);
      }
      chunk = makeChunk(original.chunk_id, objects);
      isChanged = true;
    }
    loadedCandidates.push({
      original,
      chunk,
      summary: summarizeChunk(chunk),
      changed: isChanged,
    });
  }

  const newChunks: PendingNewChunk[] = [];
  if (newObjects.length > 0) {
    const usedChunkIds = new Set<string>(manifestChunkIds);
    for (const chunkId of loadedById.keys()) usedChunkIds.add(chunkId);

    let nextChunkIndex = 0;
    const allocateChunkId = (): string => {
      let chunkId = '';
      do {
        chunkId = `chunk-edit-${nextChunkIndex}`;
        nextChunkIndex += 1;
      } while (usedChunkIds.has(chunkId));
      usedChunkIds.add(chunkId);
      return chunkId;
    };

    for (const object of newObjects) {
      const objectBytes = jsonByteLength(object);
      const objectSamples = objectSampleCount(object);
      if (objectSamples > INK_BOARD_LIMITS.chunk_samples_max) {
        fail(`Ink board object ${object.id} exceeds the ${INK_BOARD_LIMITS.chunk_samples_max} sample limit.`);
      }

      let placed = false;
      for (const candidate of loadedCandidates) {
        if (!canFitObject(candidate.summary, objectBytes, objectSamples)) continue;
        if (candidate.chunk.objects === candidate.original.objects) {
          candidate.chunk = makeChunk(candidate.chunk.chunk_id, candidate.original.objects.slice());
        }
        candidate.chunk.objects.push(object);
        candidate.summary = advanceSummary(candidate.summary, objectBytes, objectSamples);
        candidate.changed = true;
        placed = true;
        break;
      }

      if (!placed) {
        for (const pending of newChunks) {
          if (!canFitObject(pending.summary, objectBytes, objectSamples)) continue;
          pending.chunk.objects.push(object);
          pending.summary = advanceSummary(pending.summary, objectBytes, objectSamples);
          placed = true;
          break;
        }
      }

      if (!placed) {
        const chunkId = allocateChunkId();
        const singleBytes = chunkEnvelopeBytes(chunkId) + objectBytes;
        if (singleBytes > INK_BOARD_LIMITS.chunk_max_bytes) {
          fail(`Ink board object ${object.id} cannot fit in an ${INK_BOARD_LIMITS.chunk_max_bytes / MIB} MiB chunk.`);
        }
        newChunks.push({
          chunk: makeChunk(chunkId, [object]),
          summary: { objects: 1, samples: objectSamples, bytes: singleBytes },
        });
      }
    }
  }

  const changed: InkBoardChunk[] = [];
  const previous: InkBoardChunkEditPlan['previous'] = [];
  const changedSummaries = new Map<string, ChunkSummary>();
  const loadedSummaries = new Map<string, ChunkSummary>();

  for (const candidate of loadedCandidates) {
    loadedSummaries.set(candidate.chunk.chunk_id, candidate.summary);
    if (!candidate.changed) continue;
    const summary = assertChunkLimits(candidate.chunk, `Ink board chunk ${candidate.chunk.chunk_id}`);
    changed.push(candidate.chunk);
    previous.push({ chunk_id: candidate.chunk.chunk_id, previous: candidate.original });
    changedSummaries.set(candidate.chunk.chunk_id, summary);
  }
  for (const pending of newChunks) {
    const summary = assertChunkLimits(pending.chunk, `Ink board chunk ${pending.chunk.chunk_id}`);
    changed.push(pending.chunk);
    previous.push({ chunk_id: pending.chunk.chunk_id });
    changedSummaries.set(pending.chunk.chunk_id, summary);
  }

  assertFinalBoardLimits(manifest, loaded, changed, changedSummaries, loadedSummaries);
  return { changed, previous };
}
