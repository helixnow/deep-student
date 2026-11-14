// Rust: chatanki_executor.rs:11016–11090 (preference memory settings orchestration).
// The extract/consolidate semantics live in L16 `anki_preference_memory`; this module
// owns the settings read/parse/write loop and its fail-closed error text.
import type {
  ChatAnkiConsolidateOutcome, ChatAnkiPreferenceEntry, ChatAnkiPreferenceKind,
  ChatAnkiPreferenceMemory, ChatAnkiPreferenceStore, ChatAnkiPreferenceTimestamp,
  ChatAnkiSessionObservation, ChatAnkiSettingsStore,
} from '../api.ts';
import { errorText } from './execution.ts';
import { JsonReader } from '../../../platform/util/portable.ts';

export const CHATANKI_PREFERENCE_MEMORY_SETTING_KEY = 'chatanki_preference_memory_store';

// Rust serializes writes behind a process-wide mutex because settings
// get/modify/save is not one transaction. The host settings surface is
// synchronous and the event loop never interleaves inside this function, which
// gives the same single-writer guarantee without an async queue.

const PREFERENCE_KINDS: readonly ChatAnkiPreferenceKind[] = [
  'language', 'card_density', 'no_translation', 'template_preference',
];

function storeShapeError(detail: string): Error {
  return new Error(`parse local preference store: ${detail}`);
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const ENTRY_FIELDS = ['kind', 'statement', 'subject', 'confidence', 'evidence_count',
  'last_evidence', 'first_seen_ms', 'last_seen_ms'] as const;

function required<T>(r: JsonReader, value: T | undefined, field: string): T {
  if (value === undefined) throw r.error(`missing field \`${field}\``);
  return value;
}

function readPreferenceKind(r: JsonReader): ChatAnkiPreferenceKind {
  const map = r.peekKind() === 'object';
  if (map) r.beginObject();
  const variant = map ? r.readEnumVariant() : r.readString('string or map');
  const kind = PREFERENCE_KINDS.find((name) => name === variant);
  if (kind === undefined) {
    throw r.error(`unknown variant \`${variant}\`, expected one of ${PREFERENCE_KINDS.map((kind) => `\`${kind}\``).join(', ')}`);
  }
  if (map) { r.readNull(); r.endEnumObject(); }
  return kind;
}

/** serde derive of PreferenceEntry (anki_preference_memory.rs:124-135). */
function readPreferenceEntry(r: JsonReader): ChatAnkiPreferenceEntry {
  let kind: ChatAnkiPreferenceKind | undefined;
  let statement: string | undefined;
  let subject: string | null = null;
  let confidence: number | undefined;
  let evidenceCount: number | undefined;
  let lastEvidence: string | undefined;
  let firstSeen: bigint | undefined;
  let lastSeen: bigint | undefined;
  const seen = new Set<string>();
  const readField = (field: typeof ENTRY_FIELDS[number]): void => {
    seen.add(field);
    switch (field) {
      case 'kind': kind = readPreferenceKind(r); break;
      case 'statement': statement = r.readString(); break;
      case 'subject': subject = r.readOptionNone() ? null : r.readString(); break;
      case 'confidence': {
        // Fixed desktop feature: JSON numeric token -> f64 -> f32. This is not
        // the nullable outbound projection; null/string input remains rejected.
        const number = r.readNumber('f32');
        confidence = Math.fround(Number(number.value));
        break;
      }
      case 'evidence_count': evidenceCount = Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
      case 'last_evidence': lastEvidence = r.readString(); break;
      case 'first_seen_ms': firstSeen = r.readSigned('i64', I64_MIN, I64_MAX); break;
      case 'last_seen_ms': lastSeen = r.readSigned('i64', I64_MIN, I64_MAX); break;
    }
  };
  if (r.peekKind() === 'array') {
    r.beginArray();
    for (const [index, field] of ENTRY_FIELDS.entries()) {
      if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct PreferenceEntry with 8 elements`);
      readField(field);
    }
    if (r.nextItem()) throw r.error('trailing characters');
  } else {
    r.beginObject('struct PreferenceEntry');
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = ENTRY_FIELDS.find((name) => name === key);
      if (field === undefined) { r.skipValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      readField(field);
    }
  }
  return {
    kind: required(r, kind, 'kind'), statement: required(r, statement, 'statement'), subject,
    confidence: required(r, confidence, 'confidence'), evidence_count: required(r, evidenceCount, 'evidence_count'),
    last_evidence: required(r, lastEvidence, 'last_evidence'),
    first_seen_ms: required(r, firstSeen, 'first_seen_ms'), last_seen_ms: required(r, lastSeen, 'last_seen_ms'),
  };
}

function readPreferenceEntries(r: JsonReader): ChatAnkiPreferenceEntry[] {
  const entries: ChatAnkiPreferenceEntry[] = [];
  r.beginArray();
  while (r.nextItem()) entries.push(readPreferenceEntry(r));
  return entries;
}

/** Exact typed from_str: never JSON.parse timestamp tokens into a Number first. */
export function parsePreferenceStore(raw: string): ChatAnkiPreferenceStore {
  try {
    const r = new JsonReader(raw);
    let entries: ChatAnkiPreferenceEntry[] | undefined;
    if (r.peekKind() === 'array') {
      r.beginArray();
      if (!r.nextItem()) throw r.error('invalid length 0, expected struct PreferenceStore with 1 element');
      entries = readPreferenceEntries(r);
      if (r.nextItem()) throw r.error('trailing characters');
    } else {
      r.beginObject('struct PreferenceStore');
      for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
        if (key !== 'entries') { r.skipValue(); continue; }
        if (entries !== undefined) throw r.fieldError('duplicate field `entries`');
        entries = readPreferenceEntries(r);
      }
    }
    const store = { entries: required(r, entries, 'entries') };
    r.end();
    return store;
  } catch (caught) { throw storeShapeError(errorText(caught)); }
}

function timestampI64(value: unknown): bigint {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw new Error('invalid preference timestamp, expected i64');
  }
  const exact = BigInt(value);
  if (exact < I64_MIN || exact > I64_MAX) throw new Error('preference timestamp out of range, expected i64');
  return exact;
}

function serializePreferenceStore(store: ChatAnkiPreferenceStore): string {
  // Native raw JSON numbers, not strings or Number(bigint). Also serialize the
  // exact represented integer of legacy number parameters, whose ordinary
  // Number.toString() can choose a different decimal integer above 2^53.
  const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
  return JSON.stringify(store, (key: string, value: unknown) =>
    key === 'first_seen_ms' || key === 'last_seen_ms' ? json.rawJSON(timestampI64(value).toString()) : value);
}

/**
 * chatanki_executor.rs:11036–11056: extract → consolidate → settings persist.
 * A corrupt existing value fails closed (never overwritten by an empty store).
 */
export function persistPreferenceObservation(
  db: ChatAnkiSettingsStore,
  memory: ChatAnkiPreferenceMemory,
  observation: ChatAnkiSessionObservation,
  nowMs: ChatAnkiPreferenceTimestamp,
): ChatAnkiConsolidateOutcome {
  let existingJson: string | null;
  try {
    existingJson = db.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
  } catch (caught) {
    throw new Error(`read local preference store: ${errorText(caught)}`);
  }
  const store = existingJson === null
    ? memory.emptyStore()
    : parsePreferenceStore(existingJson);
  const outcome = memory.consolidateObservation(store, observation, nowMs);
  let serialized: string;
  try {
    serialized = serializePreferenceStore(store);
  } catch (caught) {
    throw new Error(`serialize local preference store: ${errorText(caught)}`);
  }
  try {
    db.saveSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, serialized);
  } catch (caught) {
    throw new Error(`save local preference store: ${errorText(caught)}`);
  }
  return outcome;
}

/**
 * chatanki_executor.rs:11059–11090: preference learning is an attached side
 * effect; failures must never change the card-generation result.
 */
export function persistPreferenceObservationBestEffort(
  db: ChatAnkiSettingsStore,
  memory: ChatAnkiPreferenceMemory,
  observation: ChatAnkiSessionObservation,
  source: string,
  nowMs: ChatAnkiPreferenceTimestamp,
  warn: (message: string) => void = () => undefined,
): void {
  try {
    persistPreferenceObservation(db, memory, observation, nowMs);
  } catch (caught) {
    // chatanki_executor.rs:11077–11081 (exact log text).
    warn(`[ChatAnkiToolExecutor] preference observation ignored after persistence failure: source=${source}, error=${errorText(caught)}`);
  }
}
