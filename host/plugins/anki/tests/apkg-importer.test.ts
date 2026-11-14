/**
 * `crates/dstu-anki/src/apkg_importer_service.rs::tests` 的全量移植。
 *
 * 测试自身允许直接写 SQL（与 Rust 测试 helper 一致）；生产代码的 SQL 仍只在
 * `repository/`。集合库 fixture 在临时目录里用真实 SQLite 生成，APKG 用
 * `buildZip` 打包，媒体落盘走真实文件系统。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  APKG_ERROR_COLLECTION_INVALID,
  APKG_ERROR_COLLECTION_MISSING,
  APKG_ERROR_COLPKG,
  APKG_ERROR_DATABASE,
  APKG_ERROR_INVALID_ARCHIVE,
  APKG_ERROR_LIMIT_EXCEEDED,
  ApkgImporterService,
  FSRS_STATE_LEARNING,
  FSRS_STATE_NEW,
  FSRS_STATE_REVIEW,
  MAX_COLLECTION_BYTES,
  MAX_ENTRY_BYTES,
  MAX_FIELDS_PER_MODEL,
  MAX_MATERIALIZED_CARD_BYTES,
  MAX_TAGS_PER_CARD,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_ENTRIES,
  MEDIA_SKIP_REASON_ENTRY_MISSING,
  MEDIA_SKIP_REASON_ENTRY_OVERSIZED,
  MEDIA_SKIP_REASON_FILENAME_CONFLICT,
  MEDIA_SKIP_REASON_IMPORT_DISABLED,
  MEDIA_SKIP_REASON_IO_ERROR,
  MEDIA_SKIP_REASON_MANIFEST_UNPARSED,
  MEDIA_SKIP_REASON_ORPHAN_ENTRY,
  MEDIA_SKIP_REASON_UNSAFE_FILENAME,
  UNTRUSTED_IMPORT_PROTOCOL_FIELDS,
  ankiSchedToFsrs,
  decodeCollection,
  defaultImportLimits,
  errorCodeOf,
  extractMediaFilenames,
  isUntrustedImportProtocolField,
  mapCard,
  parseCardFsrsData,
  parseModernMediaManifest,
  parseNotetypeKind,
  sanitizeMediaFilename,
  sm2ToFsrsMemory,
  type ApkgImportRuntime,
  type CardSchedState,
  type ImportLimits,
  type ModelDefinition,
} from '../src/apkg-importer.ts';
import {
  emptyApkgMediaReport,
  serializeApkgImportResult,
  type ApkgImportResult,
} from '../src/apkg-types.ts';
import { buildZip, readZip } from '../src/apkg-zip.ts';
import {
  exportCardsToApkgWithFullTemplateReport,
  exportMultiTemplateApkgReport,
  type ApkgExportRuntime,
  type TemplateConfigTuple,
} from '../src/apkg-exporter.ts';
import { decodeAnkiCardRow } from '../src/anki-cards.ts';
import { decodeTemplateRow } from '../src/templates.ts';
import { getTemplateById } from '../repository/templates.ts';
import { listCardsForDocument } from '../repository/anki-cards.ts';
import { compression as nativeCompression } from '../../../platform/native/compression/index.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';
import { setAnkiLocalRuntime } from '../src/local-runtime.ts';
import { nodeAnkiLocalRuntime } from '../src/local-runtime.node.ts';

// ---------------------------------------------------------------- 运行时替身

const zstd = zlib as unknown as {
  zstdCompressSync(data: Uint8Array): Buffer;
};

let env: AnkiTestEnv;
let db: DatabaseHandle;
let exportRuntime: ApkgExportRuntime;

const testLogger = { debug() {}, info() {}, warn() {}, error() {} };
let tempCounter = 0;

beforeAll(async () => {
  env = await createAnkiTestEnv();
  db = env.storage.database('mistakes');
  exportRuntime = {
    logger: env.host.ctx.logger,
    openDatabase: (filePath) => env.storage.openFile(filePath),
    closeDatabase: (handle) => env.storage.close(handle),
    tempDir: fs.mkdtempSync(path.join(env.dir, 'apkg-export-')),
  };
}, 120_000);

afterAll(async () => {
  await env.dispose();
  setAnkiLocalRuntime(null);
});

beforeEach(() => {
  // 用例直接调用桌面实现（buildZip / 导入器），并且个别用例会建/拆第二个 env——
  // 之后重新安装端口，保证本文件的每个用例都有 `node:fs` / `node:zlib` 能力。
  setAnkiLocalRuntime(nodeAnkiLocalRuntime);
  // 共享迁移库：每个用例从干净的业务数据开始（与 Rust 的 setup_migrated_db 等价）。
  db.exec(`
    DROP TRIGGER IF EXISTS fail_second_apkg_card;
    DELETE FROM fsrs_review_logs;
    DELETE FROM fsrs_card_states;
    DELETE FROM anki_cards;
    DELETE FROM document_tasks;
    DELETE FROM custom_anki_templates;
    DELETE FROM anki_decks;
  `);
});

function tempPath(label: string): string {
  tempCounter += 1;
  return path.join(env.dir, `${label}-${process.pid}-${tempCounter}.anki2`);
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(env.dir, `${label}-`));
}

function importRuntime(mediaDir: string | null = null): ApkgImportRuntime {
  return {
    db,
    openDatabase: (filePath) => env.storage.openFile(filePath),
    closeDatabase: (handle) => env.storage.close(handle),
    tempDir: tempDir('apkg-tmp'),
    mediaDir,
    fsrsOwner: env.host.ctx.review,
    logger: testLogger,
  };
}

function service(mediaDir: string | null = null): ApkgImporterService {
  return new ApkgImporterService(importRuntime(mediaDir));
}

function errorFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to throw');
}

function cardsOf(documentId: string): AnkiCard[] {
  return listCardsForDocument(db, documentId).map(decodeAnkiCardRow);
}

function isDocumentOwnedBySession(documentId: string, sessionId: string): boolean {
  const row = db.one<{ total: number; owned: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS owned
     FROM document_tasks
     WHERE document_id = ?1 AND deleted_at IS NULL`,
    [documentId, sessionId],
  );
  return Number(row.total) > 0 && Number(row.owned) === Number(row.total);
}

function documentSessionSource(documentId: string): string | null {
  const row = db.get<{ source_session_id: string | null }>(
    `SELECT source_session_id
     FROM document_tasks
     WHERE document_id = ?1 AND source_session_id IS NOT NULL AND deleted_at IS NULL
     LIMIT 1`,
    [documentId],
  );
  return row?.source_session_id ?? null;
}

function withCollectionBytes<T>(bytes: Uint8Array, fn: (handle: DatabaseHandle) => T): T {
  const file = tempPath('read-collection');
  fs.writeFileSync(file, bytes);
  const handle = env.storage.openFile(file);
  try {
    return fn(handle);
  } finally {
    env.storage.close(handle);
    fs.rmSync(file, { force: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------- 集合 fixture

function modelJson(modelType: number, fields: ReadonlyArray<readonly [string, number]>): Record<string, unknown> {
  return {
    name: modelType === 1 ? 'Cloze' : 'Basic',
    type: modelType,
    flds: fields.map(([name, ord]) => ({ name, ord })),
  };
}

function makeCollection(
  models: unknown,
  notes: ReadonlyArray<readonly [number, number, string, string]>,
  cards: ReadonlyArray<readonly [number, number, number]>,
): Buffer {
  const file = tempPath('collection');
  const handle = env.storage.openFile(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
      CREATE TABLE notes (
          id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
      );
      CREATE TABLE cards (
          id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
      );
    `);
    handle.run('INSERT INTO col (models, decks) VALUES (?1, ?2)', [
      JSON.stringify(models),
      JSON.stringify({ 1: { name: 'Imported' } }),
    ]);
    for (const [id, mid, tags, fields] of notes) {
      handle.run('INSERT INTO notes (id, mid, tags, flds) VALUES (?1, ?2, ?3, ?4)', [id, mid, tags, fields]);
    }
    for (const [id, nid, ord] of cards) {
      handle.run('INSERT INTO cards (id, nid, did, ord) VALUES (?1, ?2, 1, ?3)', [id, nid, ord]);
    }
  } finally {
    env.storage.close(handle);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

function makeViewBackedCollection(): Buffer {
  const file = tempPath('view-backed');
  const handle = env.storage.openFile(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
      CREATE TABLE notes (
          id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
      );
      CREATE TABLE card_rows (
          id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
      );
      CREATE VIEW cards AS SELECT id, nid, did, ord FROM card_rows;
    `);
    handle.run('INSERT INTO col (models, decks) VALUES (?1, ?2)', [
      JSON.stringify({ 100: modelJson(0, [['Front', 0], ['Back', 1]]) }),
      '{}',
    ]);
    handle.run("INSERT INTO notes (id, mid, tags, flds) VALUES (1, 100, '', ?1)", ['front\u001fback']);
    handle.run('INSERT INTO card_rows (id, nid, did, ord) VALUES (10, 1, 1, 0)');
  } finally {
    env.storage.close(handle);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

function makeBasicCollection(front: string): Buffer {
  return makeCollection(
    { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
    [[1, 100, '', `${front}\u001fback`]],
    [[10, 1, 0]],
  );
}

function makeMixedCollection(): Buffer {
  return makeCollection(
    {
      100: modelJson(0, [['ExtraField', 2], ['bAcK', 1], ['fRoNt', 0]]),
      200: modelJson(1, [['tExT', 0], ['Extra', 1], ['Source', 2]]),
    },
    [
      [1, 100, 'tag-one tag-two', 'basic front\u001fbasic back\u001fdetail'],
      [2, 200, 'cloze-tag', 'A {{c1::cloze}} note\u001fcontext\u001fbook'],
    ],
    [[10, 1, 0], [11, 1, 1], [12, 2, 0]],
  );
}

interface ModernCardSched {
  readonly type: number;
  readonly queue: number;
  readonly due: number;
  readonly ivl: number;
  readonly factor: number;
  readonly reps: number;
  readonly lapses: number;
}

function makeModernCollection(
  notetypes: ReadonlyArray<readonly [number, string, number, readonly string[]]>,
  notes: ReadonlyArray<readonly [number, number, string, string]>,
  cards: ReadonlyArray<readonly [number, number, number, ModernCardSched]>,
): Buffer {
  const file = tempPath('modern-collection');
  const handle = env.storage.openFile(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE notes (
          id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
      );
      CREATE TABLE cards (
          id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL,
          type INTEGER NOT NULL DEFAULT 0, queue INTEGER NOT NULL DEFAULT 0,
          due INTEGER NOT NULL DEFAULT 0, ivl INTEGER NOT NULL DEFAULT 0,
          factor INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
          lapses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, config BLOB NOT NULL);
      CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE fields (
          ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL,
          PRIMARY KEY (ntid, ord)
      );
    `);
    handle.run('INSERT INTO decks (id, name) VALUES (1, ?1)', ['Parent\u001fChild']);
    for (const [id, name, kind, fields] of notetypes) {
      const config = kind === 1 ? Buffer.from([0x08, 0x01]) : Buffer.alloc(0);
      handle.run('INSERT INTO notetypes (id, name, config) VALUES (?1, ?2, ?3)', [id, name, config]);
      fields.forEach((fieldName, ord) => {
        handle.run('INSERT INTO fields (ntid, ord, name) VALUES (?1, ?2, ?3)', [id, ord, fieldName]);
      });
    }
    for (const [id, mid, tags, fields] of notes) {
      handle.run('INSERT INTO notes (id, mid, tags, flds) VALUES (?1, ?2, ?3, ?4)', [id, mid, tags, fields]);
    }
    for (const [id, nid, ord, sched] of cards) {
      handle.run(
        `INSERT INTO cards (id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        [id, nid, ord, sched.type, sched.queue, sched.due, sched.ivl, sched.factor, sched.reps, sched.lapses],
      );
    }
  } finally {
    env.storage.close(handle);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

function makeSchedCollection(
  crt: number | null,
  cards: ReadonlyArray<readonly [number, number, ModernCardSched]>,
): Buffer {
  const file = tempPath('sched-collection');
  const handle = env.storage.openFile(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE col (crt INTEGER NOT NULL, models TEXT NOT NULL, decks TEXT NOT NULL);
      CREATE TABLE notes (
          id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
      );
      CREATE TABLE cards (
          id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL,
          type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL,
          ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL,
          lapses INTEGER NOT NULL
      );
    `);
    handle.run('INSERT INTO col (crt, models, decks) VALUES (?1, ?2, ?3)', [
      crt ?? 0,
      JSON.stringify({ 100: modelJson(0, [['Front', 0], ['Back', 1]]) }),
      JSON.stringify({ 1: { name: 'Imported' } }),
    ]);
    for (const [id, nid, sched] of cards) {
      handle.run('INSERT OR IGNORE INTO notes (id, mid, tags, flds) VALUES (?1, 100, \'\', ?2)', [
        nid,
        `front ${nid}\u001fback ${nid}`,
      ]);
      handle.run(
        `INSERT INTO cards (id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses)
         VALUES (?1, ?2, 1, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        [id, nid, sched.type, sched.queue, sched.due, sched.ivl, sched.factor, sched.reps, sched.lapses],
      );
    }
  } finally {
    env.storage.close(handle);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

function makeApkg(entries: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  return Buffer.from(buildZip(entries.map(([name, data]) => ({ name, data }))));
}

/** 手工编码 protobuf MediaEntries（每条 entry 含 name=field1 + size=field2）。 */
function encodeMediaEntries(names: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8');
    const entry = Buffer.concat([
      Buffer.from([0x0a, nameBytes.length]),
      nameBytes,
      Buffer.from([0x10, 0x05]),
    ]);
    chunks.push(Buffer.from([0x0a, entry.length]), entry);
  }
  return Buffer.concat(chunks);
}

function zstdBytes(data: Buffer): Buffer {
  return zstd.zstdCompressSync(data);
}

function sch(value: Partial<ModernCardSched> = {}): ModernCardSched {
  return {
    type: value.type ?? 0,
    queue: value.queue ?? 0,
    due: value.due ?? 0,
    ivl: value.ivl ?? 0,
    factor: value.factor ?? 0,
    reps: value.reps ?? 0,
    lapses: value.lapses ?? 0,
  };
}

// ---------------------------------------------------------------- 卡片 / 模板 fixture

function testCard(id: string, front: string, back: string, tags: string[] = []): AnkiCard {
  const now = new Date().toISOString();
  return {
    id,
    task_id: '',
    front,
    back,
    text: null,
    tags,
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: {},
    template_id: null,
  };
}

function customTemplate(id: string, noteType: string, fields: string[]): CustomAnkiTemplate {
  const now = new Date().toISOString();
  const isCloze = noteType.toLowerCase() === 'cloze';
  return {
    id,
    name: `Round-trip ${id}`,
    description: 'APKG round-trip fixture',
    author: 'Deep Student',
    version: '1.0.0',
    preview_front: '',
    preview_back: '',
    note_type: noteType,
    fields: [...fields],
    generation_prompt: '',
    front_template: isCloze ? '{{cloze:Text}}' : '{{Question}}',
    back_template: isCloze ? '{{cloze:Text}}<br>{{Extra}}' : '{{Question}}<br>{{Extra}}',
    css_style: '.card { font-family: sans-serif; }',
    field_extraction_rules: {},
    created_at: now,
    updated_at: now,
    is_active: true,
    is_built_in: true,
    preview_data_json: null,
  };
}

// ---------------------------------------------------------------- 共享断言 helper

function assertRoundTripCards(cards: AnkiCard[]): void {
  expect(cards.length).toBe(3);

  const basic = cards.find((card) => card.template_id === 'design-lab');
  expect(basic).toBeDefined();
  expect(basic!.front).toBe('basic front');
  expect(basic!.back).toBe('basic back');
  expect(basic!.extra_fields.Subject).toBe('Physics');
  expect(basic!.extra_fields.Question).toBe('What is inertia?');
  expect(basic!.extra_fields.explanation).toBe("Newton's first law");

  const cloze = cards.find((card) => card.template_id === 'design-redaction');
  expect(cloze).toBeDefined();
  expect(cloze!.front).toBe('cloze front');
  expect(cloze!.back).toBe('cloze back');
  expect(cloze!.text).toBe(
    "{{c1::Mass}} resists {{c2::acceleration}} under {{c3::Newton's second law}}.",
  );
  for (const marker of ['{{c1::Mass}}', '{{c2::acceleration}}', "{{c3::Newton's second law}}"]) {
    expect(cloze!.text!.includes(marker)).toBe(true);
  }
  expect(cloze!.extra_fields.Header).toBe('CLASSIFIED / MECHANICS');
  expect(cloze!.extra_fields.Extra).toBe('Inertial mass');

  const glass = cards.find((card) => card.template_id === 'design-glass');
  expect(glass).toBeDefined();
  expect(glass!.front).toBe('glass front');
  expect(glass!.back).toBe('glass back');
  expect(glass!.text).toBe('Energy is {{c1::conserved}} in a closed system.');
  expect(glass!.text!.includes('{{c1::conserved}}')).toBe(true);
  expect(glass!.extra_fields.Subject).toBe('Thermodynamics');
  expect(glass!.extra_fields.Extra).toBe('First law');
}

interface ImportedFsrsRow {
  ankiCardId: string;
  state: number;
  stability: number | null;
  difficulty: number | null;
  scheduledDays: number;
  reps: number;
  lapses: number;
  dueMs: number;
  lastReviewMs: number | null;
  suspended: boolean;
}

function fsrsRowsByAnkiId(documentId: string): Map<number, ImportedFsrsRow> {
  const rows = db.all<{
    extra_fields_json: string;
    anki_card_id: string;
    state: number;
    stability: number | null;
    difficulty: number | null;
    scheduled_days: number;
    reps: number;
    lapses: number;
    due_ms: number;
    last_review_ms: number | null;
    suspended: number;
  }>(
    `SELECT ac.extra_fields_json, s.anki_card_id, s.state, s.stability, s.difficulty,
            s.scheduled_days, s.reps, s.lapses, s.due_ms, s.last_review_ms, s.suspended
     FROM fsrs_card_states s
     INNER JOIN anki_cards ac ON ac.id = s.anki_card_id
     WHERE ac.source_id = ?1 AND s.deleted_at IS NULL`,
    [documentId],
  );
  const out = new Map<number, ImportedFsrsRow>();
  for (const row of rows) {
    const extra = JSON.parse(row.extra_fields_json) as Record<string, string>;
    const ankiId = Number.parseInt(extra.AnkiCardId ?? '', 10);
    expect(Number.isInteger(ankiId)).toBe(true);
    expect(out.has(ankiId)).toBe(false);
    out.set(ankiId, {
      ankiCardId: row.anki_card_id,
      state: Number(row.state),
      stability: row.stability,
      difficulty: row.difficulty,
      scheduledDays: Number(row.scheduled_days),
      reps: Number(row.reps),
      lapses: Number(row.lapses),
      dueMs: Number(row.due_ms),
      lastReviewMs: row.last_review_ms,
      suspended: Number(row.suspended) !== 0,
    });
  }
  return out;
}

describe('crates/dstu-anki/src/apkg_importer_service.rs::tests', () => {
  it('basic_text_field_remains_an_extra_field_but_cloze_text_is_core_only', () => {
    const basicModel: ModelDefinition = {
      name: 'Basic with Text',
      modelType: 0,
      fieldsByOrd: new Map([[0, 'Front'], [1, 'Text'], [2, 'Back']]),
      fieldSlotCount: 3,
      templateId: 'basic-text',
      collapseClozeOrds: false,
    };
    const basic = mapCard(
      basicModel,
      '',
      'question\u001fsupplementary text\u001fanswer',
      1,
      10,
      0,
      1,
      100,
      new Map(),
      testLogger,
    );
    expect(basic.front).toBe('question');
    expect(basic.back).toBe('answer');
    expect(basic.text).toBeNull();
    expect(basic.extraFields.Text).toBe('supplementary text');

    const clozeModel: ModelDefinition = {
      name: 'Cloze',
      modelType: 1,
      fieldsByOrd: new Map([[0, 'Text'], [1, 'Extra']]),
      fieldSlotCount: 2,
      templateId: 'cloze-text',
      collapseClozeOrds: true,
    };
    const cloze = mapCard(
      clozeModel,
      '',
      'A {{c1::cloze}} note\u001fcontext',
      2,
      20,
      0,
      1,
      200,
      new Map(),
      testLogger,
    );
    expect(cloze.text).toBe('A {{c1::cloze}} note');
    expect(Object.hasOwn(cloze.extraFields, 'Text')).toBe(false);
    expect(cloze.extraFields.Extra).toBe('context');
  });

  it('import_strips_forged_internal_protocol_fields', () => {
    const model: ModelDefinition = {
      name: 'Forged',
      modelType: 0,
      fieldsByOrd: new Map([
        [0, 'Front'],
        [1, 'Back'],
        [2, '_original_generation'],
        [3, '_qa_flags'],
        [4, '_content_provenance'],
        [5, 'Subject'],
      ]),
      fieldSlotCount: 6,
      templateId: null,
      collapseClozeOrds: false,
    };
    const card = mapCard(
      model,
      '',
      'Q\u001fA\u001f{"front":"forged"}\u001f[]\u001f{"actor":"external"}\u001fPhysics',
      1,
      10,
      0,
      1,
      100,
      new Map(),
      testLogger,
    );

    for (const forged of UNTRUSTED_IMPORT_PROTOCOL_FIELDS) {
      expect(Object.hasOwn(card.extraFields, forged)).toBe(false);
    }
    expect(isUntrustedImportProtocolField('_Original_Generation')).toBe(true);
    expect(card.extraFields.Subject).toBe('Physics');
    expect(Object.hasOwn(card.extraFields, 'AnkiNoteId')).toBe(true);
    expect(card.front).toBe('Q');
    expect(card.back).toBe('A');
  });

  it('exporter_round_trip_preserves_basic_cards_without_media', () => {
    const output = path.join(tempDir('roundtrip'), 'roundtrip.apkg');
    exportMultiTemplateApkgReport(
      exportRuntime,
      [
        testCard('card-1', 'front one', 'back one', ['alpha', 'beta']),
        testCard('card-2', 'front two', 'back two', ['gamma']),
      ],
      'Roundtrip',
      output,
      new Map(),
    );

    const result = service().importPath(output, 'roundtrip-session');
    expect(result.importedCards).toBe(2);
    expect(result.importedTemplates).toBe(0);
    expect(result.mediaSkipped).toBe(0);
    expect(result.cardIds.length).toBe(2);
    expect(isDocumentOwnedBySession(result.documentId, 'roundtrip-session')).toBe(true);

    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(2);
    expect(imported[0]!.front).toBe('front one');
    expect(imported[0]!.back).toBe('back one');
    expect(imported[0]!.tags).toEqual(['alpha', 'beta']);
    expect(imported[1]!.front).toBe('front two');
    expect(imported[1]!.back).toBe('back two');
    expect(imported[1]!.tags).toEqual(['gamma']);
    expect(imported.every((card) => card.template_id === null)).toBe(true);
  });

  it('single_template_cloze_round_trip_materializes_one_internal_card_per_note', () => {
    const output = path.join(tempDir('single-cloze'), 'single-cloze-roundtrip.apkg');
    const template = customTemplate('design-single-cloze', 'Cloze', ['Text', 'Extra']);
    const templateConfig: TemplateConfigTuple = [
      template.name,
      [...template.fields],
      template.front_template,
      template.back_template,
      template.css_style,
    ];
    const cloze = testCard('cloze-1', 'cloze front', 'cloze extra', ['cloze-tag']);
    cloze.template_id = template.id;
    cloze.text =
      "{{c1::Mass}} resists {{c2::acceleration}} according to {{c3::Newton's second law}}.";

    exportCardsToApkgWithFullTemplateReport(
      exportRuntime,
      [cloze],
      'Single Cloze round trip',
      'Cloze',
      output,
      templateConfig,
      template,
    );

    const result = service().importPath(output, 'single-cloze-import');
    expect(result.importedCards).toBe(1);
    expect(result.cardIds.length).toBe(1);
    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(1);
    expect(imported[0]!.template_id).toBe('design-single-cloze');
    expect(imported[0]!.text).toBe(
      "{{c1::Mass}} resists {{c2::acceleration}} according to {{c3::Newton's second law}}.",
    );
    expect(imported[0]!.extra_fields.AnkiCardOrd).toBe('0');
  });

  it('multi_template_export_import_round_trip_preserves_fields_and_template_ids', async () => {
    const basicTemplate = customTemplate('design-lab', 'Basic', [
      'Subject',
      'Question',
      'optiona',
      'optionb',
      'optionc',
      'optiond',
      'optione',
      'correct',
      'explanation',
    ]);
    const redactionTemplate = customTemplate('design-redaction', 'Cloze', ['Header', 'Text', 'Extra']);
    const glassTemplate = customTemplate('design-glass', 'Cloze', ['Subject', 'Text', 'Extra']);
    const templates = new Map<string, CustomAnkiTemplate>([
      [basicTemplate.id, basicTemplate],
      [redactionTemplate.id, redactionTemplate],
      [glassTemplate.id, glassTemplate],
    ]);

    const basic = testCard('basic-1', 'basic front', 'basic back', ['basic-tag']);
    basic.template_id = 'design-lab';
    basic.extra_fields = {
      Subject: 'Physics',
      Question: 'What is inertia?',
      optiona: 'Resistance to acceleration',
      optionb: 'A unit of energy',
      optionc: 'A type of force',
      optiond: 'A reference frame',
      correct: 'A',
      explanation: "Newton's first law",
    };

    const cloze = testCard('cloze-1', 'cloze front', 'cloze back', ['cloze-tag']);
    cloze.template_id = 'design-redaction';
    cloze.text = "{{c1::Mass}} resists {{c2::acceleration}} under {{c3::Newton's second law}}.";
    cloze.extra_fields = {
      Header: 'CLASSIFIED / MECHANICS',
      Extra: 'Inertial mass',
    };

    const glass = testCard('glass-1', 'glass front', 'glass back', ['glass-tag']);
    glass.template_id = 'design-glass';
    glass.text = 'Energy is {{c1::conserved}} in a closed system.';
    glass.extra_fields = {
      Subject: 'Thermodynamics',
      Extra: 'First law',
    };

    const outputDir = tempDir('multi-template');
    const firstOutput = path.join(outputDir, 'multi-template.apkg');
    exportMultiTemplateApkgReport(
      exportRuntime,
      [basic, cloze, glass],
      'Multi-template round trip',
      firstOutput,
      templates,
    );

    const firstResult = service().importPath(firstOutput, 'first-import');
    expect(firstResult.importedCards).toBe(3);
    expect(firstResult.importedTemplates).toBe(3);
    for (const templateId of ['design-lab', 'design-redaction', 'design-glass']) {
      const row = getTemplateById(db, templateId);
      expect(row).toBeDefined();
    }
    const firstCards = cardsOf(firstResult.documentId);
    assertRoundTripCards(firstCards);

    const secondOutput = path.join(outputDir, 'multi-template-reexport.apkg');
    exportMultiTemplateApkgReport(
      exportRuntime,
      firstCards,
      'Direct re-export',
      secondOutput,
      templates,
    );

    const secondEnv = await createAnkiTestEnv();
    try {
      const secondDb = secondEnv.storage.database('mistakes');
      const secondRuntime: ApkgImportRuntime = {
        db: secondDb,
        openDatabase: (filePath) => secondEnv.storage.openFile(filePath),
        closeDatabase: (handle) => secondEnv.storage.close(handle),
        tempDir: fs.mkdtempSync(path.join(secondEnv.dir, 'apkg-tmp-')),
        logger: testLogger,
      };
      const secondResult = new ApkgImporterService(secondRuntime)
        .importPath(secondOutput, 'second-import');
      expect(secondResult.importedCards).toBe(3);
      expect(secondResult.importedTemplates).toBe(3);
      const secondCards = listCardsForDocument(secondDb, secondResult.documentId)
        .map(decodeAnkiCardRow);
      assertRoundTripCards(secondCards);
    } finally {
      await secondEnv.dispose();
    }
  });

  it('imports_basic_cloze_and_every_card_row_with_session_ownership', () => {
    const apkg = makeApkg([
      ['collection.anki2', makeMixedCollection()],
      ['media', Buffer.from('{"0":"picture.png","1":"sound.mp3"}', 'utf8')],
      ['0', Buffer.from('ignored media', 'utf8')],
    ]);
    const result = service().importBytes(apkg, 'mixed.apkg', 'owner-session');

    expect(result.importedCards).toBe(3);
    expect(result.cardIds.length).toBe(3);
    expect(new Set(result.cardIds).size).toBe(3);
    expect(result.importedTemplates).toBe(0);
    expect(result.mediaSkipped).toBe(2);
    expect(isDocumentOwnedBySession(result.documentId, 'owner-session')).toBe(true);
    expect(isDocumentOwnedBySession(result.documentId, 'other-session')).toBe(false);

    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(3);
    expect(imported.every((card) => card.template_id === null)).toBe(true);
    expect(imported[0]!.front).toBe('basic front');
    expect(imported[0]!.back).toBe('basic back');
    expect(imported[0]!.tags).toEqual(['tag-one', 'tag-two']);
    expect(imported[0]!.extra_fields.ExtraField).toBe('detail');
    expect(imported[1]!.front).toBe(imported[0]!.back);
    expect(imported[1]!.back).toBe(imported[0]!.front);
    expect(imported[0]!.extra_fields.AnkiCardId).not.toBe(imported[1]!.extra_fields.AnkiCardId);
    expect(imported[0]!.extra_fields.AnkiCardOrd).toBe('0');
    expect(imported[1]!.extra_fields.AnkiCardOrd).toBe('1');
    expect(imported[0]!.extra_fields.AnkiNoteId).toBe(imported[1]!.extra_fields.AnkiNoteId);
    expect(imported[2]!.text).toBe('A {{c1::cloze}} note');
    expect(imported[2]!.back).toBe('context');
    expect(imported[2]!.extra_fields.Source).toBe('book');

    const provenance = db.pluck<number>(
      "SELECT COUNT(*) FROM anki_cards WHERE source_type = 'apkg_import' AND source_id = ?1",
      [result.documentId],
    );
    expect(Number(provenance)).toBe(3);
  });

  it('external_cloze_note_without_deep_student_metadata_keeps_each_card_row', () => {
    const collection = makeCollection(
      { 200: modelJson(1, [['Text', 0], ['Extra', 1]]) },
      [[2, 200, 'external-cloze', '{{c1::one}} {{c2::two}} {{c3::three}}\u001fcontext']],
      [[20, 2, 0], [21, 2, 1], [22, 2, 2]],
    );
    const apkg = makeApkg([['collection.anki2', collection]]);
    const result = service().importBytes(apkg, 'external-multi-ord.apkg', 'external-session');

    expect(result.importedCards).toBe(3);
    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(3);
    expect(imported.every((card) => card.template_id === null)).toBe(true);
    expect(imported.every(
      (card) => card.text === '{{c1::one}} {{c2::two}} {{c3::three}}',
    )).toBe(true);
    const ords = imported
      .map((card) => card.extra_fields.AnkiCardOrd)
      .filter((ord): ord is string => ord !== undefined)
      .sort();
    expect(ords).toEqual(['0', '1', '2']);
  });

  it('external_cloze_export_preserves_selected_ordinals_and_separate_progress', () => {
    const outputs = tempDir('external-cloze');
    const collection = makeModernCollection(
      [[200, 'Cloze', 1, ['Text', 'Extra']]],
      [[2, 200, 'tag', '{{c1::one}} {{c2::two}}\u001fcontext']],
      [
        [20, 2, 0, sch({ type: 2, queue: 2, due: 3, ivl: 7, factor: 2500, reps: 4, lapses: 0 })],
        [21, 2, 1, sch({ type: 2, queue: 2, due: 5, ivl: 20, factor: 2300, reps: 9, lapses: 2 })],
      ],
    );
    const packageBytes = makeApkg([['collection.anki21b', collection]]);
    const importer = service();
    const result = importer.importBytes(packageBytes, 'external.apkg', null);
    const cards = cardsOf(result.documentId)
      .sort((left, right) =>
        (left.extra_fields.AnkiCardOrd ?? '').localeCompare(right.extra_fields.AnkiCardOrd ?? ''));
    expect(cards.length).toBe(2);

    let fullGuid: string | null = null;
    for (const mode of ['single', 'multi', 'custom'] as const) {
      for (const onlySecond of [false, true]) {
        const selected = onlySecond ? [structuredClone(cards[1]!)] : cards.map((card) => structuredClone(card));
        const output = path.join(outputs, `${mode}-${onlySecond}.apkg`);
        const templates = new Map<string, CustomAnkiTemplate>();
        if (mode === 'custom') {
          const template = customTemplate('external-cloze-copy', 'Cloze', [
            'Text',
            'Extra',
            'Front',
            'Back',
          ]);
          for (const card of selected) card.template_id = template.id;
          templates.set(template.id, template);
        }
        if (mode === 'single') {
          exportCardsToApkgWithFullTemplateReport(
            exportRuntime,
            selected,
            'Cloze test',
            'Cloze',
            output,
            null,
            null,
          );
        } else {
          exportMultiTemplateApkgReport(exportRuntime, selected, 'Cloze test', output, templates);
        }

        const collectionBytes = readZip(fs.readFileSync(output)).get('collection.anki2');
        expect(collectionBytes).toBeDefined();
        const rows = withCollectionBytes(collectionBytes!, (handle) => {
          const count = Number(handle.pluck<number>('SELECT COUNT(*) FROM notes'));
          expect(count).toBe(1);
          const guid = handle.pluck<string>('SELECT guid FROM notes');
          expect(guid).toBeDefined();
          if (fullGuid === null) fullGuid = guid ?? null;
          else expect(guid).toBe(fullGuid);
          return handle.all<{ ord: number; ivl: number; reps: number; lapses: number }>(
            'SELECT ord, ivl, reps, lapses FROM cards ORDER BY ord',
          ).map((row) => [Number(row.ord), Number(row.ivl), Number(row.reps), Number(row.lapses)] as const);
        });
        expect(rows).toEqual(
          onlySecond
            ? [[1, 20, 9, 2]]
            : [[0, 7, 4, 0], [1, 20, 9, 2]],
        );

        const restored = importer.importPath(output, null);
        const restoredCards = cardsOf(restored.documentId)
          .sort((left, right) =>
            (left.extra_fields.AnkiCardOrd ?? '').localeCompare(right.extra_fields.AnkiCardOrd ?? ''));
        expect(restoredCards.length).toBe(rows.length);
        restoredCards.forEach((card, index) => {
          const row = rows[index]!;
          expect(card.extra_fields.AnkiCardScope).toBe('card');
          expect(card.extra_fields.AnkiCardOrd).toBe(String(row[0]));
          expect(card.extra_fields.AnkiIvl).toBe(String(row[1]));
          expect(card.extra_fields.AnkiReps).toBe(String(row[2]));
        });
      }
    }
  });

  it('anki21_is_preferred_and_zstd_collection_is_supported', () => {
    const preferred = makeBasicCollection('preferred anki21');
    const compressed = zstdBytes(preferred);
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('fallback anki2')],
      ['collection.anki21', compressed],
      ['media', Buffer.from('{}', 'utf8')],
    ]);
    const result = service().importBytes(apkg, 'modern.apkg', null);
    const cards = cardsOf(result.documentId);
    expect(cards.length).toBe(1);
    expect(cards[0]!.front).toBe('preferred anki21');
    expect(documentSessionSource(result.documentId)).toBeNull();
  });

  it('modern_anki21b_package_imports_cards_media_and_schedule', () => {
    const mediaDir = tempDir('modern-media');
    const collection = makeModernCollection(
      [
        [100, 'Basic', 0, ['Front', 'Back']],
        [200, 'Cloze', 1, ['Text', 'Extra']],
      ],
      [
        [1, 100, ' geo ', 'capital of France? <img src="map.png">\u001fParis'],
        [2, 200, '', 'A {{c1::cloze}} note\u001fextra'],
      ],
      [
        [10, 1, 0, sch({ type: 2, queue: 2, due: 5, ivl: 12, factor: 2500, reps: 7, lapses: 1 })],
        [20, 2, 0, sch()],
      ],
    );
    const compressed = zstdBytes(collection);
    const manifest = zstdBytes(encodeMediaEntries(['map.png']));
    const mediaBlob = zstdBytes(Buffer.from('png-bytes', 'utf8'));
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('please upgrade placeholder')],
      ['collection.anki21b', compressed],
      ['media', manifest],
      ['0', mediaBlob],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'modern.apkg', 'modern-session');
    expect(result.importedCards).toBe(2);
    expect(result.mediaImported).toBe(1);
    expect(result.mediaSkipped).toBe(0);
    expect(result.warnings.some((warning) => warning.includes('复习进度'))).toBe(true);
    const extracted = path.join(mediaDir, 'map.png');
    expect(fs.readFileSync(extracted)).toEqual(Buffer.from('png-bytes', 'utf8'));

    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(2);
    expect(imported.every((card) => card.template_id === null)).toBe(true);
    const basic = imported.find((card) => card.text === null);
    expect(basic).toBeDefined();
    expect(basic!.front).toBe('capital of France? <img src="map.png">');
    expect(basic!.back).toBe('Paris');
    expect(basic!.tags).toEqual(['geo']);
    expect(basic!.extra_fields.AnkiIvl).toBe('12');
    expect(basic!.extra_fields.AnkiReps).toBe('7');
    expect(basic!.extra_fields.AnkiSchedType).toBe('2');
    expect(basic!.images).toEqual([extracted]);
    const cloze = imported.find((card) => card.text !== null);
    expect(cloze).toBeDefined();
    expect(cloze!.text).toBe('A {{c1::cloze}} note');
    expect(Object.hasOwn(cloze!.extra_fields, 'AnkiIvl')).toBe(false);
  });

  it('async_import_uses_native_compression_for_collection_manifest_and_media', async () => {
    const mediaDir = tempDir('native-media');
    const collection = makeModernCollection(
      [[100, 'Basic', 0, ['Front', 'Back']]],
      [[1, 100, '', 'front <img src="map.png">\u001fback']],
      [[10, 1, 0, sch({ type: 2, queue: 2, due: 5, ivl: 12, factor: 2500, reps: 7 })]],
    );
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('please upgrade placeholder')],
      ['collection.anki21b', zstdBytes(collection)],
      ['media', zstdBytes(encodeMediaEntries(['map.png']))],
      ['0', zstdBytes(Buffer.from('png-bytes', 'utf8'))],
    ]);
    const decodeCalls: number[] = [];
    const compression = {
      ...nativeCompression,
      async zstdDecode(bytes: Uint8Array, maxOutputBytes?: number) {
        decodeCalls.push(bytes.length);
        return nativeCompression.zstdDecode(bytes, maxOutputBytes);
      },
    };
    const result = await new ApkgImporterService({
      ...importRuntime(mediaDir),
      compression,
    }).withReviewEnqueue().importBytesAsync(apkg, 'native.apkg', 'native-session');

    expect(result.importedCards).toBe(1);
    expect(result.mediaImported).toBe(1);
    expect(decodeCalls.length).toBe(3);
    expect(fs.readFileSync(path.join(mediaDir, 'map.png')))
      .toEqual(Buffer.from('png-bytes', 'utf8'));
    expect(result.reviewEnqueue?.enqueued).toBe(1);
  });

  it('async_import_keeps_media_decompression_bomb_limits', async () => {
    const mediaDir = tempDir('native-bomb-media');
    const collection = makeModernCollection(
      [[100, 'Basic', 0, ['Front', 'Back']]],
      [[1, 100, '', 'front <img src="bomb.bin">\u001fback']],
      [[10, 1, 0, sch()]],
    );
    const apkg = makeApkg([
      ['collection.anki21b', zstdBytes(collection)],
      ['media', zstdBytes(encodeMediaEntries(['bomb.bin']))],
      ['0', zstdBytes(Buffer.alloc(512 * 1024, 0))],
    ]);
    const result = await new ApkgImporterService({
      ...importRuntime(mediaDir),
      compression: nativeCompression,
    }).importReaderAsync(apkg, 'bomb.apkg', null, { maxEntryBytes: 128 * 1024 });

    expect(result.mediaImported).toBe(0);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_ENTRY_OVERSIZED);
    expect(fs.existsSync(path.join(mediaDir, 'bomb.bin'))).toBe(false);
  });

  it('modern_media_manifest_failure_degrades_to_no_media_import', () => {
    const mediaDir = tempDir('bad-media');
    const collection = makeModernCollection(
      [[100, 'Basic', 0, ['Front', 'Back']]],
      [[1, 100, '', 'front\u001fback']],
      [[10, 1, 0, sch()]],
    );
    const apkg = makeApkg([
      ['collection.anki21b', zstdBytes(collection)],
      // 非法 protobuf：wire type 5 但数据被截断
      ['media', Buffer.from([0x05, 0x05, 0x05])],
      ['0', Buffer.from('orphan', 'utf8')],
    ]);
    const result = service(mediaDir).importBytes(apkg, 'modern-bad-media.apkg', null);
    expect(result.importedCards).toBe(1);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('媒体清单解析失败'))).toBe(true);
    expect(result.mediaReport.declared).toBe(1);
    expect(result.mediaReport.imported).toBe(0);
    expect(result.mediaReport.skipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_MANIFEST_UNPARSED);
    expect(result.mediaReport.skips[0]!.count).toBe(1);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['0']);
  });

  it('modern_media_manifest_protobuf_parses_names_in_order', () => {
    const encoded = encodeMediaEntries(['a.png', 'b.mp3']);
    const manifest = parseModernMediaManifest(encoded);
    expect(manifest.get('0')).toBe('a.png');
    expect(manifest.get('1')).toBe('b.mp3');

    const compressed = zstdBytes(encoded);
    const compressedManifest = parseModernMediaManifest(compressed);
    expect(compressedManifest.size).toBe(2);

    expect(() => parseModernMediaManifest(Buffer.from([0x0a, 0x02, 0x10]))).toThrow();
  });

  it('notetype_kind_parsing_defaults_to_normal_on_unknown_data', () => {
    expect(parseNotetypeKind(Buffer.alloc(0))).toBe(0);
    expect(parseNotetypeKind(Buffer.from([0x08, 0x01]))).toBe(1);
    expect(parseNotetypeKind(Buffer.from([0x08, 0x00]))).toBe(0);
    expect(parseNotetypeKind(Buffer.from([0x12, 0x03, 0x61, 0x62, 0x63, 0x08, 0x01]))).toBe(1);
    expect(parseNotetypeKind(Buffer.from([0xff]))).toBe(0);
  });

  it('external_multi_template_note_is_deduplicated_with_warning', () => {
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'front\u001fback']],
      [[10, 1, 0], [11, 1, 1], [12, 1, 2]],
    );
    const apkg = makeApkg([['collection.anki2', collection]]);
    const result = service().importBytes(apkg, 'multi-template.apkg', null);
    expect(result.importedCards).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('去重'))).toBe(true);
    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(1);
    expect(imported[0]!.front).toBe('front');
    expect(imported[0]!.back).toBe('back');
    expect(imported[0]!.extra_fields.AnkiCardOrd).toBe('0');
  });

  it('colpkg_source_is_rejected_with_export_guidance', () => {
    const apkg = makeApkg([['collection.anki2', makeBasicCollection('front')]]);
    const error = errorFrom(() => service().importBytes(apkg, 'collection.colpkg', null));
    expect(errorCodeOf(error)).toBe(APKG_ERROR_COLPKG);
    expect((error as { message: string }).message.includes('apkg')).toBe(true);
  });

  it('anki21b_alongside_legacy_anki21_still_imports_legacy_data', () => {
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('placeholder anki2')],
      ['collection.anki21', makeBasicCollection('legacy anki21')],
      ['collection.anki21b', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x6d, 0x6f, 0x64, 0x65, 0x72, 0x6e])],
    ]);
    const result = service().importBytes(apkg, 'modern-plus-legacy.apkg', null);
    const cards = cardsOf(result.documentId);
    expect(cards.length).toBe(1);
    expect(cards[0]!.front).toBe('legacy anki21');
  });

  it('rejects_zstd_collection_with_oversized_window', () => {
    // FHD = 0x00（单段=0、无 content size），window descriptor 0x98 → windowLog = 10 + 19 = 29。
    const encoded = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x98, 0x00, 0x00, 0x00]);
    const error = errorFrom(() => decodeCollection(encoded, MAX_COLLECTION_BYTES));
    expect(errorCodeOf(error)).toBe(APKG_ERROR_COLLECTION_INVALID);
    expect((error as { message: string }).message.includes('decompress')).toBe(true);
  });

  it('rejects_traversal_oversize_and_missing_collection_without_persistence', () => {
    const importer = service();
    const collection = makeBasicCollection('front');

    const traversal = makeApkg([
      ['collection.anki2', collection],
      ['../escape', Buffer.from('no', 'utf8')],
    ]);
    const traversalError = errorFrom(() => importer.importBytes(traversal, 'traversal.apkg', null));
    expect(errorCodeOf(traversalError)).toBe(APKG_ERROR_INVALID_ARCHIVE);

    const missing = makeApkg([['media', Buffer.from('{}', 'utf8')]]);
    const missingError = errorFrom(() => importer.importBytes(missing, 'missing.apkg', null));
    expect(errorCodeOf(missingError)).toBe(APKG_ERROR_COLLECTION_MISSING);

    const oversized = makeApkg([['collection.anki2', collection]]);
    const oversizeError = errorFrom(() => importer.importReader(oversized, 'oversized.apkg', null, {
      maxEntries: 10,
      maxEntryBytes: 32,
      maxTotalUncompressedBytes: 64,
      maxCollectionBytes: 32,
      maxMaterializedCardBytes: MAX_MATERIALIZED_CARD_BYTES,
    }));
    expect(errorCodeOf(oversizeError)).toBe(APKG_ERROR_LIMIT_EXCEEDED);
  });

  it('rejects_view_backed_collection_schema', () => {
    const apkg = makeApkg([['collection.anki2', makeViewBackedCollection()]]);
    const error = errorFrom(() => service().importBytes(apkg, 'view-backed.apkg', null));
    expect(errorCodeOf(error)).toBe(APKG_ERROR_COLLECTION_INVALID);
    expect((error as { message: string }).message.includes('must be a real table')).toBe(true);
  });

  it('rejects_field_delimiter_and_tag_bombs', () => {
    const importer = service();
    const models = { 100: modelJson(0, [['Front', 0], ['Back', 1]]) };

    const delimiterBomb = 'x\u001f'.repeat(MAX_FIELDS_PER_MODEL + 1);
    const delimiterCollection = makeCollection(
      models,
      [[1, 100, '', delimiterBomb]],
      [[10, 1, 0]],
    );
    const delimiterError = errorFrom(() => importer.importBytes(
      makeApkg([['collection.anki2', delimiterCollection]]),
      'delimiter-bomb.apkg',
      null,
    ));
    expect(errorCodeOf(delimiterError)).toBe(APKG_ERROR_LIMIT_EXCEEDED);

    const tagBomb = Array.from({ length: MAX_TAGS_PER_CARD + 1 }, () => 'tag').join(' ');
    const tagCollection = makeCollection(
      models,
      [[1, 100, tagBomb, 'front\u001fback']],
      [[10, 1, 0]],
    );
    const tagError = errorFrom(() => importer.importBytes(
      makeApkg([['collection.anki2', tagCollection]]),
      'tag-bomb.apkg',
      null,
    ));
    expect(errorCodeOf(tagError)).toBe(APKG_ERROR_LIMIT_EXCEEDED);
  });

  it('repeated_card_rows_hit_materialized_budget', () => {
    const repeatedCards = Array.from({ length: 16 }, (_, index) => [10 + index, 1, index] as const);
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, 'tag', 'repeated front\u001frepeated back']],
      repeatedCards,
    );
    const apkg = makeApkg([['collection.anki2', collection]]);
    const limits: ImportLimits = {
      ...defaultImportLimits(),
      maxMaterializedCardBytes: 8 * 1024,
    };
    const error = errorFrom(() => service().importReader(apkg, 'materialized-bomb.apkg', null, limits));
    expect(errorCodeOf(error)).toBe(APKG_ERROR_LIMIT_EXCEEDED);
    expect((error as { message: string }).message.includes('materialized card data')).toBe(true);
  });

  it('target_failure_rolls_back_document_and_all_cards', () => {
    db.exec(`
      CREATE TRIGGER fail_second_apkg_card
      BEFORE INSERT ON anki_cards
      WHEN NEW.source_type = 'apkg_import' AND NEW.card_order_in_task = 1
      BEGIN
          SELECT RAISE(ABORT, 'injected APKG failure');
      END;
    `);
    try {
      const apkg = makeApkg([['collection.anki2', makeMixedCollection()]]);
      const error = errorFrom(() => service().importBytes(apkg, 'rollback.apkg', 'owner'));
      expect((error as { error_type?: string }).error_type).toBe('Database');
      expect(errorCodeOf(error)).toBe(APKG_ERROR_DATABASE);

      const tasks = Number(db.pluck<number>(
        "SELECT COUNT(*) FROM document_tasks WHERE original_document_name = 'rollback.apkg'",
      ));
      const cards = Number(db.pluck<number>(
        "SELECT COUNT(*) FROM anki_cards WHERE source_type = 'apkg_import'",
      ));
      expect(tasks).toBe(0);
      expect(cards).toBe(0);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_second_apkg_card');
    }
  });

  it('migration_keeps_generated_dedup_while_allowing_apkg_card_identity', () => {
    db.run(
      `INSERT INTO document_tasks (
          id, document_id, original_document_name, segment_index, content_segment,
          status, anki_generation_options_json
       ) VALUES ('task', 'doc', 'doc', 0, '', 'Completed', '{}')`,
    );
    const insert = (id: string, sourceType: string) => db.run(
      `INSERT INTO anki_cards (
          id, task_id, front, back, tags_json, images_json, is_error_card,
          card_order_in_task, extra_fields_json, source_type, source_id
       ) VALUES (?1, 'task', 'same front', 'same back', '[]', '[]', 0, 0, '{}', ?2, 'doc')`,
      [id, sourceType],
    );
    insert('generated-1', 'document');
    expect(() => insert('generated-2', 'document')).toThrow();
    insert('apkg-1', 'apkg_import');
    insert('apkg-2', 'apkg_import');
  });

  it('result_serialization_does_not_expose_internal_card_ids', () => {
    const result: ApkgImportResult = {
      documentId: 'doc',
      importedCards: 1,
      importedTemplates: 0,
      mediaSkipped: 0,
      mediaImported: 0,
      mediaReport: emptyApkgMediaReport(),
      warnings: [],
      cardIds: ['card'],
      reviewEnqueue: null,
    };
    const value = asRecord(serializeApkgImportResult(result));
    expect(value.documentId).toBe('doc');
    expect(value.mediaImported).toBe(0);
    expect(value.cardIds).toBeUndefined();
    expect(value.warnings).toBeUndefined();
    expect(value.mediaReport).toBeUndefined();
  });

  it('result_deserialization_defaults_new_optional_fields', () => {
    // 本 lane 没有生产反序列化入口；按 serde `#[serde(default)]` 语义在测试内投影。
    const raw = JSON.parse(
      '{"documentId":"doc","importedCards":2,"importedTemplates":0,"mediaSkipped":1}',
    ) as Record<string, unknown>;
    const parsed = {
      documentId: String(raw.documentId),
      importedCards: Number(raw.importedCards),
      importedTemplates: Number(raw.importedTemplates),
      mediaSkipped: Number(raw.mediaSkipped),
      mediaImported: typeof raw.mediaImported === 'number' ? raw.mediaImported : 0,
      mediaReport: emptyApkgMediaReport(),
      warnings: Array.isArray(raw.warnings) ? raw.warnings as string[] : [],
      cardIds: [] as string[],
      reviewEnqueue: null,
    };
    expect(parsed.mediaImported).toBe(0);
    expect(parsed.warnings).toEqual([]);
  });

  it('media_filename_sanitization_rejects_traversal_and_control_names', () => {
    expect(sanitizeMediaFilename('picture.png')).toBe('picture.png');
    expect(sanitizeMediaFilename('nested/dir/photo.jpg')).toBe('photo.jpg');
    expect(sanitizeMediaFilename('')).toBeNull();
    expect(sanitizeMediaFilename('..')).toBeNull();
    expect(sanitizeMediaFilename('bad\u0000name.png')).toBeNull();
    expect(sanitizeMediaFilename('x'.repeat(256))).toBeNull();
    expect(sanitizeMediaFilename('..\\evil.png')).toBeNull();
    expect(sanitizeMediaFilename('C:\\evil.exe')).toBeNull();
    expect(sanitizeMediaFilename('a\\b.png')).toBeNull();
    expect(sanitizeMediaFilename('drive:name.png')).toBeNull();
    expect(sanitizeMediaFilename('/etc/passwd')).toBe('passwd');
  });

  it('media_reference_extraction_handles_img_and_sound_tags', () => {
    const html = '<img src="one.png"> text <img src=\'two.jpg\'/> [sound:clip.mp3] src= broken';
    expect(extractMediaFilenames(html)).toEqual(['one.png', 'two.jpg', 'clip.mp3']);
  });

  it('media_import_extracts_declared_files_and_links_referencing_cards', () => {
    const mediaDir = tempDir('media-extract');
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'front with <img src="picture.png">\u001fplain back']],
      [[10, 1, 0]],
    );
    const apkg = makeApkg([
      ['collection.anki2', collection],
      ['media', Buffer.from('{"0":"picture.png","1":"missing-entry.mp3"}', 'utf8')],
      ['0', Buffer.from('png-bytes', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'media.apkg', 'media-session');
    expect(result.mediaImported).toBe(1);
    expect(result.mediaSkipped).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('missing-entry.mp3'))).toBe(true);
    expect(result.mediaReport.declared).toBe(2);
    expect(result.mediaReport.imported).toBe(1);
    expect(result.mediaReport.skipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_ENTRY_MISSING);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['missing-entry.mp3']);
    expect(result.mediaReport.mediaDir).toBe(mediaDir);
    const extracted = path.join(mediaDir, 'picture.png');
    expect(fs.existsSync(extracted)).toBe(true);
    expect(fs.readFileSync(extracted)).toEqual(Buffer.from('png-bytes', 'utf8'));

    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(1);
    expect(imported[0]!.images).toEqual([extracted]);
  });

  it('media_import_without_media_dir_keeps_legacy_skip_semantics', () => {
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"picture.png"}', 'utf8')],
      ['0', Buffer.from('png-bytes', 'utf8')],
    ]);
    const result = service().importBytes(apkg, 'legacy.apkg', null);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.declared).toBe(1);
    expect(result.mediaReport.skipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_IMPORT_DISABLED);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['picture.png']);
    expect(result.mediaReport.mediaDir).toBeNull();
  });

  it('media_report_structures_every_skip_reason_without_silent_loss', () => {
    const mediaDir = tempDir('mixed-media');
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'front <img src="ok.png">\u001fback']],
      [[10, 1, 0]],
    );
    const apkg = makeApkg([
      ['collection.anki2', collection],
      ['media', Buffer.from('{"0":"ok.png","1":"missing.mp3","2":"..\\\\evil.png"}', 'utf8')],
      ['0', Buffer.from('ok-bytes', 'utf8')],
      ['2', Buffer.from('evil-bytes', 'utf8')],
      ['9', Buffer.from('orphan-bytes', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'mixed-media.apkg', null);
    expect(result.mediaImported).toBe(1);
    expect(result.mediaReport.declared).toBe(4);
    expect(result.mediaReport.imported).toBe(1);
    expect(result.mediaReport.skipped).toBe(3);
    expect(result.mediaSkipped).toBe(3);
    const totalFromSkips = result.mediaReport.skips.reduce((sum, skip) => sum + skip.count, 0);
    expect(totalFromSkips).toBe(result.mediaSkipped);
    const reasonOf = (reason: string) => {
      const skip = result.mediaReport.skips.find((candidate) => candidate.reason === reason);
      if (skip === undefined) throw new Error(`missing skip reason ${reason}`);
      return skip;
    };
    expect(reasonOf(MEDIA_SKIP_REASON_ENTRY_MISSING).filenames).toEqual(['missing.mp3']);
    expect(reasonOf(MEDIA_SKIP_REASON_UNSAFE_FILENAME).filenames).toEqual(['..\\evil.png']);
    expect(reasonOf(MEDIA_SKIP_REASON_ORPHAN_ENTRY).filenames).toEqual(['9']);
    expect(fs.existsSync(path.join(mediaDir, 'ok.png'))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'evil.png'))).toBe(false);
    expect(fs.existsSync(path.join(mediaDir, '..\\evil.png'))).toBe(false);
  });

  it('media_manifest_path_traversal_never_escapes_media_dir', () => {
    const parent = tempDir('traversal-parent');
    const mediaDir = path.join(parent, 'media');
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from(
        '{"0":"../escape.png","1":"C:\\\\evil.exe","2":"nested/dir/deep.png"}',
        'utf8',
      )],
      ['0', Buffer.from('escape-bytes', 'utf8')],
      ['1', Buffer.from('exe-bytes', 'utf8')],
      ['2', Buffer.from('deep-bytes', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'traversal-media.apkg', null);
    expect(fs.existsSync(path.join(mediaDir, 'escape.png'))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'deep.png'))).toBe(true);
    expect(fs.existsSync(path.join(parent, 'escape.png'))).toBe(false);
    expect(fs.existsSync(path.join(parent, 'evil.exe'))).toBe(false);
    expect(fs.existsSync(path.join(mediaDir, 'nested'))).toBe(false);
    expect(result.mediaImported).toBe(2);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_UNSAFE_FILENAME);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['C:\\evil.exe']);
  });

  it('media_import_refuses_dangling_symlink_targets', () => {
    const parent = tempDir('symlink-parent');
    const mediaDir = path.join(parent, 'media');
    fs.mkdirSync(mediaDir);
    const outside = path.join(parent, 'outside-created.txt');
    const link = path.join(mediaDir, 'escape.png');
    fs.symlinkSync(outside, link);

    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"escape.png"}', 'utf8')],
      ['0', Buffer.from('attacker-controlled', 'utf8')],
    ]);
    const result = service(mediaDir).importBytes(apkg, 'symlink-media.apkg', null);
    expect(result.importedCards).toBe(1);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_IO_ERROR);
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('media_decompression_bomb_is_rejected_and_reported', () => {
    const mediaDir = tempDir('bomb-media');
    const collection = makeModernCollection(
      [[100, 'Basic', 0, ['Front', 'Back']]],
      [[1, 100, '', 'front <img src="bomb.bin">\u001fback']],
      [[10, 1, 0, sch()]],
    );
    const manifest = zstdBytes(encodeMediaEntries(['bomb.bin']));
    const bomb = zstdBytes(Buffer.alloc(512 * 1024, 0));
    expect(bomb.length).toBeLessThan(16 * 1024);
    const apkg = makeApkg([
      ['collection.anki21b', zstdBytes(collection)],
      ['media', manifest],
      ['0', bomb],
    ]);

    const result = service(mediaDir).importReader(apkg, 'bomb.apkg', null, {
      maxEntryBytes: 128 * 1024,
    });
    expect(result.importedCards).toBe(1);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_ENTRY_OVERSIZED);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['bomb.bin']);
    expect(fs.existsSync(path.join(mediaDir, 'bomb.bin'))).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('bomb.bin'))).toBe(true);
  });

  it('media_import_links_audio_sound_references', () => {
    const mediaDir = tempDir('audio-media');
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'front\u001fback [sound:clip.mp3]']],
      [[10, 1, 0]],
    );
    const apkg = makeApkg([
      ['collection.anki2', collection],
      ['media', Buffer.from('{"0":"clip.mp3"}', 'utf8')],
      ['0', Buffer.from('mp3-bytes', 'utf8')],
    ]);
    const result = service(mediaDir).importBytes(apkg, 'audio.apkg', null);
    expect(result.mediaImported).toBe(1);
    expect(result.mediaSkipped).toBe(0);
    const extracted = path.join(mediaDir, 'clip.mp3');
    expect(fs.readFileSync(extracted)).toEqual(Buffer.from('mp3-bytes', 'utf8'));
    const imported = cardsOf(result.documentId);
    expect(imported[0]!.images).toEqual([extracted]);
  });

  it('media_report_serializes_camel_case_contract', () => {
    const mediaDir = tempDir('contract-media');
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"a.png","1":"gone.png"}', 'utf8')],
      ['0', Buffer.from('a-bytes', 'utf8')],
    ]);
    const result = service(mediaDir).importBytes(apkg, 'contract.apkg', null);
    const value = asRecord(serializeApkgImportResult(result));
    expect(value.mediaImported).toBe(1);
    expect(value.mediaSkipped).toBe(1);
    const report = value.mediaReport as Record<string, unknown>;
    expect(report.declared).toBe(2);
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    const skips = report.skips as Array<Record<string, unknown>>;
    expect(skips[0]!.reason).toBe('entry_missing');
    expect(skips[0]!.count).toBe(1);
    expect((skips[0]!.filenames as string[])[0]).toBe('gone.png');
    expect(typeof report.mediaDir).toBe('string');
    expect((report.mediaDir as string).length).toBeGreaterThan(0);
    expect(value.documentId).toBeDefined();
  });

  it('media_import_reuses_duplicate_names_only_when_contents_match', () => {
    const mediaDir = tempDir('dup-media');
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"dup.png","1":"dup.png"}', 'utf8')],
      ['0', Buffer.from('dup-bytes', 'utf8')],
      ['1', Buffer.from('dup-bytes', 'utf8')],
    ]);
    const result = service(mediaDir).importBytes(apkg, 'dup.apkg', null);
    expect(result.mediaImported).toBe(2);
    expect(result.mediaSkipped).toBe(0);
    expect(result.mediaReport.skips).toEqual([]);
    expect(fs.readFileSync(path.join(mediaDir, 'dup.png'))).toEqual(Buffer.from('dup-bytes', 'utf8'));
  });

  it('media_import_rejects_duplicate_name_with_different_contents', () => {
    const mediaDir = tempDir('dup-conflict-media');
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"dup.png","1":"dup.png"}', 'utf8')],
      ['0', Buffer.from('first-bytes', 'utf8')],
      ['1', Buffer.from('different-bytes', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'dup-conflict.apkg', null);
    expect(result.mediaImported).toBe(1);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips.length).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_FILENAME_CONFLICT);
    expect(result.mediaReport.skips[0]!.filenames).toEqual(['dup.png']);
    expect(fs.readFileSync(path.join(mediaDir, 'dup.png'))).toEqual(Buffer.from('first-bytes', 'utf8'));
  });

  it('media_import_does_not_reuse_preexisting_name_with_different_contents', () => {
    const mediaDir = tempDir('existing-conflict-media');
    fs.writeFileSync(path.join(mediaDir, 'same-name.png'), Buffer.from('old-library-bytes', 'utf8'));
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'front <img src="same-name.png">\u001fback']],
      [[10, 1, 0]],
    );
    const apkg = makeApkg([
      ['collection.anki2', collection],
      ['media', Buffer.from('{"0":"same-name.png"}', 'utf8')],
      ['0', Buffer.from('new-package-bytes', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'existing-conflict.apkg', null);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_FILENAME_CONFLICT);
    expect(fs.readFileSync(path.join(mediaDir, 'same-name.png')))
      .toEqual(Buffer.from('old-library-bytes', 'utf8'));
    const cards = cardsOf(result.documentId);
    expect(cards[0]!.images).toEqual([]);
  });

  it('media_import_does_not_reuse_existing_name_when_archive_entry_is_missing', () => {
    const mediaDir = tempDir('missing-existing-media');
    fs.writeFileSync(path.join(mediaDir, 'existing.png'), Buffer.from('old-bytes', 'utf8'));
    const apkg = makeApkg([
      ['collection.anki2', makeBasicCollection('front')],
      ['media', Buffer.from('{"0":"existing.png"}', 'utf8')],
    ]);

    const result = service(mediaDir).importBytes(apkg, 'missing-existing.apkg', null);
    expect(result.mediaImported).toBe(0);
    expect(result.mediaSkipped).toBe(1);
    expect(result.mediaReport.skips[0]!.reason).toBe(MEDIA_SKIP_REASON_ENTRY_MISSING);
    expect(fs.readFileSync(path.join(mediaDir, 'existing.png')))
      .toEqual(Buffer.from('old-bytes', 'utf8'));
  });

  it('media_round_trip_import_then_export_repacks_media', () => {
    const mediaDir = tempDir('media-roundtrip');
    const collection = makeCollection(
      { 100: modelJson(0, [['Front', 0], ['Back', 1]]) },
      [[1, 100, '', 'capital? <img src="map.png">\u001fParis [sound:say.mp3]']],
      [[10, 1, 0]],
    );
    const apkg = makeApkg([
      ['collection.anki2', collection],
      ['media', Buffer.from('{"0":"map.png","1":"say.mp3"}', 'utf8')],
      ['0', Buffer.from('map-bytes', 'utf8')],
      ['1', Buffer.from('mp3-bytes', 'utf8')],
    ]);
    const imported = service(mediaDir).importBytes(apkg, 'roundtrip-media.apkg', 'rt-session');
    expect(imported.mediaImported).toBe(2);
    expect(imported.mediaSkipped).toBe(0);

    const cards = cardsOf(imported.documentId);
    expect(cards.length).toBe(1);
    expect(cards[0]!.front.includes('src="map.png"')).toBe(true);
    expect(cards[0]!.images.length).toBe(2);
    for (const image of cards[0]!.images) {
      expect(fs.existsSync(image)).toBe(true);
    }

    const output = path.join(tempDir('media-repack'), 'repacked.apkg');
    const report = exportMultiTemplateApkgReport(
      exportRuntime,
      cards,
      'Roundtrip Media',
      output,
      new Map(),
    );
    expect(report.exportedMedia).toBe(2);
    expect(report.missingMedia).toEqual([]);

    const archive = readZip(fs.readFileSync(output));
    const manifestRaw = archive.get('media');
    expect(manifestRaw).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw!)) as Record<string, string>;
    const names = Object.values(manifest).sort();
    expect(names).toEqual(['map.png', 'say.mp3']);
    for (const [key, name] of Object.entries(manifest)) {
      const entry = archive.get(key);
      expect(entry).toBeDefined();
      expect(entry).toEqual(Buffer.from(name === 'map.png' ? 'map-bytes' : 'mp3-bytes', 'utf8'));
    }

    const secondMediaDir = tempDir('media-reimport');
    const reimported = service(secondMediaDir).importPath(output, 'rt-session-2');
    expect(reimported.mediaImported).toBe(2);
    expect(reimported.mediaSkipped).toBe(0);
    expect(fs.readFileSync(path.join(secondMediaDir, 'map.png')))
      .toEqual(Buffer.from('map-bytes', 'utf8'));
  });

  it('review_enqueue_carries_anki_progress_into_fsrs_queue', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const crt = nowSecs - 100 * 86_400;
    const learningDue = nowSecs - 60;
    const collection = makeSchedCollection(crt, [
      [10, 1, sch({ type: 0, queue: 0, due: 1 })],
      [11, 2, sch({ type: 2, queue: 2, due: 105, ivl: 10, factor: 2500, reps: 6, lapses: 1 })],
      [12, 3, sch({ type: 1, queue: 1, due: learningDue, factor: 2500, reps: 1 })],
      [13, 4, sch({ type: 2, queue: -1, due: 90, ivl: 30, factor: 2300, reps: 12, lapses: 3 })],
      [14, 5, sch({ type: 2, queue: 2, due: 98, ivl: 7, factor: 2500, reps: 4 })],
    ]);
    const apkg = makeApkg([['collection.anki2', collection]]);
    const result = service().withReviewEnqueue().importBytes(apkg, 'sched.apkg', null);
    expect(result.importedCards).toBe(5);
    expect(result.reviewEnqueue).toEqual({ enqueued: 5, withHistory: 4, suspended: 1 });
    const serialized = asRecord(serializeApkgImportResult(result));
    expect(asRecord(serialized.reviewEnqueue).enqueued).toBe(5);
    expect(asRecord(serialized.reviewEnqueue).withHistory).toBe(4);

    const rows = fsrsRowsByAnkiId(result.documentId);
    expect(rows.size).toBe(5);
    const dayMs = 86_400_000;
    const crtMs = crt * 1000;

    const fresh = rows.get(10)!;
    expect(fresh.state).toBe(FSRS_STATE_NEW);
    expect(fresh.stability).toBeNull();
    expect(fresh.difficulty).toBeNull();
    expect(fresh.reps).toBe(0);
    expect(fresh.suspended).toBe(false);

    const review = rows.get(11)!;
    expect(review.state).toBe(FSRS_STATE_REVIEW);
    expect(review.dueMs).toBe(crtMs + 105 * dayMs);
    expect(review.lastReviewMs).toBe(crtMs + 95 * dayMs);
    const [expectedStability, expectedDifficulty] = sm2ToFsrsMemory(2500, 10);
    expect(review.stability).toBe(expectedStability);
    expect(review.difficulty).toBe(expectedDifficulty);
    expect(review.scheduledDays).toBe(10);
    expect(review.reps).toBe(6);
    expect(review.lapses).toBe(1);
    expect(review.suspended).toBe(false);

    const learning = rows.get(12)!;
    expect(learning.state).toBe(FSRS_STATE_LEARNING);
    expect(learning.dueMs).toBe(learningDue * 1000);
    expect(learning.reps).toBe(1);

    const suspended = rows.get(13)!;
    expect(suspended.state).toBe(FSRS_STATE_REVIEW);
    expect(suspended.suspended).toBe(true);
    expect(suspended.dueMs).toBe(crtMs + 90 * dayMs);
    expect(suspended.reps).toBe(12);
    expect(suspended.lapses).toBe(3);

    // Due queue 等价查询：new + 到期 learning + 逾期 review；未来 review 与暂停卡排除。
    // （本 lane 无 FsrsReviewService，due 队列用只读 SQL 复现，评分路径见下方说明。）
    const dueIds = new Set(
      db.all<{ anki_card_id: string }>(
        `SELECT anki_card_id
         FROM fsrs_card_states
         WHERE deleted_at IS NULL AND suspended = 0 AND due_ms <= ?1`,
        [Date.now()],
      ).map((row) => row.anki_card_id),
    );
    expect(dueIds).toEqual(new Set([10, 12, 14].map((id) => rows.get(id)!.ankiCardId)));

    // 评分路径（FsrsReviewService::rate）不在本 lane；用评分前不变量覆盖同一张
    // 逾期 review 卡：历史计数、状态与到期时间都必须是「可继续评分」的形态。
    const overdue = rows.get(14)!;
    expect(overdue.state).toBe(FSRS_STATE_REVIEW);
    expect(overdue.reps).toBe(4);
    expect(overdue.lapses).toBe(0);
    expect(overdue.scheduledDays).toBe(7);
    expect(overdue.dueMs).toBeLessThan(Date.now());

    // Idempotent: explicit enqueue of the same cards creates no duplicate states.
    const again = env.host.ctx.review.enqueueImportedCardsInTx(
      db,
      result.cardIds.map((cardId) => ({ cardId, seed: null })),
    );
    expect(again.enqueued).toBe(0);
    expect(again.skipped).toBe(5);

    // Re-importing the package yields a fresh document with its own states only.
    const second = service().withReviewEnqueue().importBytes(apkg, 'sched.apkg', null);
    expect(second.documentId).not.toBe(result.documentId);
    expect(second.reviewEnqueue?.enqueued).toBe(5);
    expect(fsrsRowsByAnkiId(second.documentId).size).toBe(5);
    const counts = db.one<{ total: number; distinct_count: number }>(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT anki_card_id) AS distinct_count
       FROM fsrs_card_states
       WHERE deleted_at IS NULL`,
    );
    expect(Number(counts.total)).toBe(10);
    expect(Number(counts.distinct_count)).toBe(10);
  });

  it('review_enqueue_without_l15_owner_fails_closed_and_rolls_back', () => {
    const collection = makeSchedCollection(1_600_000_000, [
      [10, 1, sch({ type: 2, queue: 2, due: 10, ivl: 5, factor: 2500, reps: 3 })],
    ]);
    const apkg = makeApkg([['collection.anki2', collection]]);
    const runtime: ApkgImportRuntime = { ...importRuntime(), fsrsOwner: null };
    const error = errorFrom(
      () => new ApkgImporterService(runtime).withReviewEnqueue()
        .importBytes(apkg, 'no-owner.apkg', null),
    );
    expect(error).toMatchObject({
      error_type: 'Database',
      message: expect.stringContaining(
        'review service does not publish enqueueImportedCardsInTx',
      ),
      details: { errorCode: 'apkg_database' },
    });
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards')).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM document_tasks')).toBe(0);
  });

  it('import_without_review_enqueue_leaves_cards_unqueued', () => {
    const collection = makeSchedCollection(1_600_000_000, [
      [10, 1, sch({ type: 2, queue: 2, due: 10, ivl: 5, factor: 2500, reps: 3 })],
    ]);
    const apkg = makeApkg([['collection.anki2', collection]]);
    const result = service().importBytes(apkg, 'plain.apkg', null);
    expect(result.reviewEnqueue).toBeNull();
    expect(asRecord(serializeApkgImportResult(result)).reviewEnqueue).toBeUndefined();
    expect(fsrsRowsByAnkiId(result.documentId).size).toBe(0);
  });

  it('sm2_schedule_converts_with_fsrs_memory_state_from_sm2', () => {
    const [stability, defaultDifficulty] = sm2ToFsrsMemory(2500, 10);
    expect(Math.abs(stability - 10)).toBeLessThan(1e-4);
    const [, hardDifficulty] = sm2ToFsrsMemory(1300, 10);
    const [, easyDifficulty] = sm2ToFsrsMemory(3500, 10);
    expect(hardDifficulty).toBeGreaterThan(defaultDifficulty);
    expect(defaultDifficulty).toBeGreaterThan(easyDifficulty);
    for (const difficulty of [defaultDifficulty, hardDifficulty, easyDifficulty]) {
      expect(difficulty).toBeGreaterThanOrEqual(1);
      expect(difficulty).toBeLessThanOrEqual(10);
    }
    expect(sm2ToFsrsMemory(0, 10)).toEqual(sm2ToFsrsMemory(2500, 10));
  });

  it('card_data_fsrs_memory_is_parsed_and_validated', () => {
    expect(parseCardFsrsData('{"s":12.5,"d":6.2,"dr":0.9,"lrt":1790000000}'))
      .toEqual([[12.5, 6.2], 1_790_000_000]);
    expect(parseCardFsrsData('{"pos":3}')).toEqual([null, null]);
    expect(parseCardFsrsData('{"s":0,"d":6.2}')).toEqual([null, null]);
    expect(parseCardFsrsData('{"s":3,"d":11}')).toEqual([null, null]);
    expect(parseCardFsrsData('not json')).toEqual([null, null]);
  });

  it('anki_sched_conversion_handles_missing_crt_relearning_and_day_learning', () => {
    const nowMs = 1_800_000_000_000;
    const sched = (cardType: number, queue: number, due: number, ivl: number): CardSchedState => ({
      cardType,
      queue,
      due,
      ivl,
      factor: 2500,
      reps: 3,
      lapses: 1,
      fsrsMemory: null,
      lastReviewSecs: null,
    });

    const review = ankiSchedToFsrs(sched(2, 2, 400, 12), null, nowMs);
    expect(review.state).toBe(FSRS_STATE_REVIEW);
    expect(review.dueMs).toBe(nowMs);
    expect(review.lastReviewMs).toBe(nowMs - 12 * 86_400_000);

    const relearn = ankiSchedToFsrs(sched(3, 1, 1_799_999_000, 3), 1, nowMs);
    expect(relearn.state).toBe(3);
    expect(relearn.dueMs).toBe(1_799_999_000_000);
    expect(Math.abs(relearn.stability! - 3)).toBeLessThan(1e-4);

    const crt = 1_700_000_000;
    const dayLearn = ankiSchedToFsrs(sched(1, 3, 50, 0), crt, nowMs);
    expect(dayLearn.state).toBe(FSRS_STATE_LEARNING);
    expect(dayLearn.dueMs).toBe(crt * 1000 + 50 * 86_400_000);
    expect(Math.abs(dayLearn.stability! - 1)).toBeLessThan(1e-4);

    const newSuspended = ankiSchedToFsrs(sched(0, -1, 7, 0), crt, nowMs);
    expect(newSuspended.state).toBe(FSRS_STATE_NEW);
    expect(newSuspended.suspended).toBe(true);
    expect(newSuspended.reps).toBe(0);
    expect(ankiSchedToFsrs(sched(2, -2, 50, 4), crt, nowMs).suspended).toBe(false);

    const fsrsCard = sched(2, 2, 400, 12);
    fsrsCard.fsrsMemory = [30.5, 7.25];
    fsrsCard.lastReviewSecs = 1_799_000_000;
    const converted = ankiSchedToFsrs(fsrsCard, crt, nowMs);
    expect(converted.stability).toBe(30.5);
    expect(converted.difficulty).toBe(7.25);
    expect(converted.lastReviewMs).toBe(1_799_000_000_000);
  });

  it('deep_student_template_metadata_recreates_missing_local_template', () => {
    const models = {
      300: {
        name: 'Imported Design',
        type: 0,
        css: '.card { color: teal; }',
        tmpls: [{ name: 'Card 1', qfmt: '{{Question}}', afmt: '{{Question}}<hr>{{Answer}}' }],
        flds: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }],
        deepStudentTemplateId: 'design-imported',
      },
    };
    const collection = makeCollection(models, [[1, 300, '', 'q\u001fa']], [[10, 1, 0]]);
    const apkg = makeApkg([['collection.anki2', collection]]);

    const result = service().importBytes(apkg, 'template.apkg', null);
    expect(result.importedTemplates).toBe(1);

    const row = getTemplateById(db, 'design-imported');
    expect(row).toBeDefined();
    const template = decodeTemplateRow(row!, () => new Date());
    expect(template.name).toBe('Imported Design');
    expect(template.note_type).toBe('Basic');
    expect(template.fields).toEqual(['Question', 'Answer']);
    expect(template.front_template).toBe('{{Question}}');
    expect(template.css_style).toBe('.card { color: teal; }');

    const second = service().importBytes(apkg, 'template.apkg', null);
    expect(second.importedTemplates).toBe(0);
  });

  it('X6-LP-0061: production importer warns before reporting failed template creation without rolling back cards', () => {
    const models = {
      301: {
        name: 'Imported Warning Design', type: 0,
        tmpls: [{ name: 'Card 1', qfmt: '{{Question}}', afmt: '{{Answer}}' }],
        flds: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }, { name: '_original_generation', ord: 2 }],
        deepStudentTemplateId: 'design-warning',
      },
    };
    const collection = makeCollection(models, [[1, 301, '', 'q\u001fa\u001fforged']], [[10, 1, 0]]);
    const apkg = makeApkg([['collection.anki2', collection]]);
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    db.exec(`CREATE TEMP TRIGGER fail_imported_template BEFORE INSERT ON custom_anki_templates
      WHEN NEW.id = 'design-warning' BEGIN SELECT RAISE(ABORT, 'template insert denied'); END`);
    try {
      const result = env.host.ctx.anki.apkgImporter.importBytes(apkg, 'warning.apkg', null);
      expect(result.importedCards).toBe(1);
      expect(result.importedTemplates).toBe(0);
      expect(warn.mock.calls.map((call) => call[0])).toEqual([
        "导入包字段 '_original_generation' 与内部协议字段同名，已剥离（外部来源不可信）",
        'APKG 模板导入失败 design-warning (Imported Warning Design): template insert denied',
      ]);
      expect(result.warnings).toContain(
        '模板导入失败（可能与现有模板重名）design-warning: template insert denied',
      );
      expect(cardsOf(result.documentId)).toHaveLength(1);
      expect(cardsOf(result.documentId)[0]!.extra_fields).not.toHaveProperty('_original_generation');
      expect(getTemplateById(db, 'design-warning')).toBeUndefined();
    } finally {
      db.exec('DROP TRIGGER fail_imported_template');
      warn.mockRestore();
    }
  });

  it.skipIf(process.env.DEEP_STUDENT_EXTERNAL_APKG === undefined)('external_apkg_env_smoke', () => {
    const sessionId = 'external-smoke';
    const pathToPackage = process.env.DEEP_STUDENT_EXTERNAL_APKG!;
    const result = service().importPath(pathToPackage, sessionId);
    expect(result.importedCards).toBeGreaterThan(0);
    expect(result.cardIds.length).toBe(result.importedCards);
    expect(isDocumentOwnedBySession(result.documentId, sessionId)).toBe(true);

    const imported = cardsOf(result.documentId);
    expect(imported.length).toBe(result.importedCards);
    expect(imported.every((card) => card.template_id === null)).toBe(true);
    const basic = imported.filter((card) => card.text === null);
    const cloze = imported.filter((card) => card.text !== null);
    expect(basic.length).toBeGreaterThan(0);
    expect(cloze.length).toBeGreaterThan(0);
    expect(basic.length + cloze.length).toBe(result.importedCards);
    expect(result.importedCards).toBeLessThanOrEqual(500);

    const provenance = Number(db.pluck<number>(
      "SELECT COUNT(*) FROM anki_cards WHERE source_type = 'apkg_import' AND source_id = ?1",
      [result.documentId],
    ));
    expect(provenance).toBe(result.importedCards);

    // 说明：Rust 版 smoke 还覆盖 FSRS due/rate、library 分页与 retemplate；
    // 这些服务不在本 lane（导入功能）的移植范围内，故此处只覆盖导入产物本身。
  });
});
