import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { readZip } from '../src/apkg-zip.ts';
import {
  APKG_EXPORT_DECK_ID,
  APKG_MODEL_ID_BASE,
  RESERVED_IMPORT_METADATA_FIELDS,
  type ApkgExportReport,
  type ApkgExportRuntime,
  apkgExportReportJson,
  cardSchedRestore,
  cleanTemplatePlaceholders,
  clozeCardOrds,
  containsClozeMarker,
  convertCardsToAnkiRecordsWithFields,
  exportCardsToApkgWithFullTemplateReport,
  exportMultiTemplateApkgReport,
  formatIoRects,
  humanizeCitationMarkers,
  isInternalProtocolField,
  isReservedImportMetadataField,
  normalizeCardsForExport,
  occlusionMediaFileName,
  resolveCardFieldValue,
  sanitizeApkgFieldValue,
  stableModelIdForTemplate,
  stableNoteGuid,
  uniqueNoteGuid,
} from '../src/apkg-exporter.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

function testCard(id: string, front: string, back: string): AnkiCard {
  const now = new Date().toISOString();
  return {
    id,
    task_id: '',
    front,
    back,
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: {},
    template_id: null,
  };
}

function testTemplate(id: string, noteType: string, fields: string[]): CustomAnkiTemplate {
  const now = new Date().toISOString();
  const isCloze = noteType.toLowerCase() === 'cloze';
  return {
    id,
    name: `Test ${id}`,
    description: '',
    author: null,
    version: '1.0.0',
    preview_front: '',
    preview_back: '',
    note_type: noteType,
    fields: [...fields],
    generation_prompt: '',
    front_template: isCloze ? '{{cloze:Text}}' : '{{Front}}',
    back_template: isCloze ? '{{cloze:Text}}<br>{{Extra}}' : '{{FrontSide}}<hr>{{Back}}',
    css_style: '.card { font-family: sans-serif; }',
    field_extraction_rules: {},
    created_at: now,
    updated_at: now,
    is_active: true,
    is_built_in: false,
    preview_data_json: null,
  };
}

function occlusionSpecJson(imageRef: string): string {
  return JSON.stringify({
    imageRef,
    boxes: [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: '左心房', clozeIndex: 1 },
      { x: 0.5, y: 0.6, w: 0.2, h: 0.1, label: '右心室', clozeIndex: 2 },
    ],
  });
}

let env: AnkiTestEnv;
let tmpRoot: string;
let runtime: ApkgExportRuntime;

beforeAll(async () => {
  env = await createAnkiTestEnv();
  tmpRoot = fs.mkdtempSync(path.join(env.dir, 'apkg-export-'));
  runtime = {
    logger: env.host.ctx.logger,
    openDatabase: (filePath) => env.storage.openFile(filePath),
    closeDatabase: (handle) => env.storage.close(handle),
    tempDir: tmpRoot,
  };
}, 120_000);

afterAll(async () => {
  await env.dispose();
});

/** 从 APKG 解出 `collection.anki2` 并用真实 F3 句柄打开。 */
function withCollection<T>(apkgPath: string, fn: (db: DatabaseHandle) => T): T {
  const archive = readZip(fs.readFileSync(apkgPath));
  const collection = archive.get('collection.anki2');
  if (collection === undefined) throw new Error('APKG 缺少 collection.anki2');
  const dbPath = path.join(tmpRoot, `read-${Date.now()}-${Math.random().toString(16).slice(2)}.anki2`);
  fs.writeFileSync(dbPath, collection);
  const db = env.storage.openFile(dbPath);
  try {
    return fn(db);
  } finally {
    env.storage.close(db);
  }
}

function modelOf(db: DatabaseHandle): Record<string, unknown> {
  const row = db.one<{ models: string }>('SELECT models FROM col LIMIT 1');
  const models = JSON.parse(row.models) as Record<string, Record<string, unknown>>;
  const first = Object.values(models)[0];
  if (first === undefined) throw new Error('models 为空');
  return first;
}

function modelFieldNames(model: Record<string, unknown>): string[] {
  return (model.flds as Array<{ name: string }>).map((field) => field.name);
}

function readMediaManifest(apkgPath: string): Record<string, string> {
  const archive = readZip(fs.readFileSync(apkgPath));
  const manifest = archive.get('media');
  if (manifest === undefined) throw new Error('APKG 缺少 media 清单');
  return JSON.parse(new TextDecoder().decode(manifest)) as Record<string, string>;
}

describe('crates/dstu-anki/src/apkg_exporter_service.rs::tests', () => {
  it('export_fields_humanize_chat_citation_markers', () => {
    expect(humanizeCitationMarkers('词根：contro-(相反)；出处：[PDF@file_ghtouXXDFW:1]')).toBe(
      '词根：contro-(相反)；出处：第 1 页',
    );
    expect(humanizeCitationMarkers('见 [PDF@tb_1:2-3] 与 [PDF@tb_1:1,5]')).toBe(
      '见 第 2-3 页 与 第 1、5 页',
    );
    expect(humanizeCitationMarkers('马氏规则：H 加到含 H 多的碳上 [知识库-1]。')).toBe(
      '马氏规则：H 加到含 H 多的碳上。',
    );
    expect(humanizeCitationMarkers('词根：vulner(伤)；[PDF@file_x]')).toBe('词根：vulner(伤)');
    expect(humanizeCitationMarkers('参见 [思维导图:mm_abc:线性代数框架]')).toBe('参见 线性代数框架');
    const plain = 'Few economists {{c1::anticipated}} it. [注] [1]';
    expect(humanizeCitationMarkers(plain)).toBe(plain);
    // 字段分隔符清洗仍然生效
    expect(sanitizeApkgFieldValue('a\u001fb [搜索-2]')).toBe('a b');
  });

  it('cloze_card_ords_extracts_sorted_unique_positive_numbers', () => {
    expect(clozeCardOrds('{{c3::three}} {{c1::one::hint}} {{c2::two}} {{c2::duplicate}}')).toEqual([
      0, 1, 2,
    ]);
  });

  it('cloze_card_ords_ignores_invalid_markers_and_falls_back_to_zero', () => {
    expect(clozeCardOrds('{{c0::zero}} {{c1::   }} {{c2::::hint}} plain text')).toEqual([0]);
  });

  it('single_template_record_conversion_carries_all_cloze_ords', () => {
    const card = testCard('cloze', 'front', 'back');
    card.text = '{{c1::one}} {{c2::two}} {{c3::three}}';
    const fields = ['Text', 'Extra'];
    const records = convertCardsToAnkiRecordsWithFields([card], 'Cloze', fields);
    expect(records[0]![6]).toEqual([0, 1, 2]);
  });

  it('test_clean_template_placeholders_control_tags', () => {
    const input = 'Start {{#each items}}<li>{{.}}</li>{{/each}} End';
    expect(cleanTemplatePlaceholders(input)).toBe(input);
  });

  it('imported_cloze_grouping_is_scoped_and_rejects_divergent_siblings', () => {
    const first = testCard('first', 'front', 'back');
    first.text = '{{c1::one}} {{c2::two}}';
    first.extra_fields = {
      AnkiCardScope: 'card',
      AnkiCardOrd: '0',
      AnkiModelId: '100',
      AnkiNoteId: '200',
    };
    const second = structuredClone(first);
    second.id = 'second';
    second.extra_fields.AnkiCardOrd = '1';
    const fields = ['Text', 'Front', 'Back'];
    const convert = (cards: AnkiCard[]) =>
      convertCardsToAnkiRecordsWithFields(cards, 'Cloze', fields);

    expect(convert([structuredClone(first), structuredClone(second)])).toHaveLength(1);
    second.task_id += '-another-import';
    expect(convert([structuredClone(first), structuredClone(second)])).toHaveLength(2);
    second.task_id = first.task_id;
    second.back = 'edited independently';
    expect(() => convert([structuredClone(first), structuredClone(second)])).toThrowError(
      /字段或标签/,
    );
    second.back = first.back;
    second.extra_fields.AnkiCardOrd = '2';
    expect(() => convert([structuredClone(second)])).toThrowError(/挖空编号/);
    first.extra_fields.AnkiCardScope = 'note';
    expect(convert([structuredClone(first)])[0]![6]).toEqual([0, 1]);
  });

  it('test_clean_template_placeholders_keep_fields', () => {
    const input = 'Hello {{Front}} and {{Back}}';
    expect(cleanTemplatePlaceholders(input)).toBe('Hello {{Front}} and {{Back}}');
  });

  it('test_clean_template_placeholders_mixed', () => {
    const input = '{{#if cond}}X{{/if}} A {{Field}} B';
    expect(cleanTemplatePlaceholders(input)).toBe('{{#if cond}}X{{/if}} A {{Field}} B');
  });

  it('test_clean_template_placeholders_no_extra_space', () => {
    expect(cleanTemplatePlaceholders('  Hello   World  ')).toBe('Hello   World');
  });

  it('test_serde_json_json_macro_key_can_use_string_var', () => {
    // serde_json::json!({ key: 1 }) 用 String 变量作对象键；JS 的动态键语义相同。
    const key = '123';
    const value = JSON.parse(JSON.stringify({ [key]: 1 })) as Record<string, number>;
    expect(value['123']).toBe(1);
  });

  it('template_model_id_is_stable_and_distinct', () => {
    const a1 = stableModelIdForTemplate('tpl_a');
    const a2 = stableModelIdForTemplate('tpl_a');
    const b = stableModelIdForTemplate('tpl_b');
    const c = stableModelIdForTemplate('tpl_c');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a1).not.toBe(c);
    expect(a1).toBeGreaterThan(APKG_MODEL_ID_BASE);
    expect(a1).not.toBe(APKG_MODEL_ID_BASE);
  });

  it('export_report_serialization_omits_empty_missing_media', () => {
    const clean: ApkgExportReport = { exportedMedia: 2, missingMedia: [], warnings: [] };
    const cleanValue = apkgExportReportJson(clean) as Record<string, unknown>;
    expect(cleanValue.exportedMedia).toBe(2);
    expect(cleanValue.missingMedia).toBeUndefined();
    expect(cleanValue.warnings).toBeUndefined();

    const dirty: ApkgExportReport = {
      exportedMedia: 0,
      missingMedia: ['/tmp/a.png'],
      warnings: ['媒体同名冲突'],
    };
    const dirtyValue = apkgExportReportJson(dirty) as Record<string, unknown>;
    expect((dirtyValue.missingMedia as string[])[0]).toBe('/tmp/a.png');
    expect((dirtyValue.warnings as string[])[0]).toBe('媒体同名冲突');
  });

  it('stable_note_guid_is_deterministic_per_card_and_unique_per_id', () => {
    const cardA = testCard('card-a', 'front', 'back');
    expect(stableNoteGuid(cardA)).toBe(stableNoteGuid(cardA));

    const cardB = testCard('card-b', 'front', 'back');
    expect(stableNoteGuid(cardA)).not.toBe(stableNoteGuid(cardB));

    const anon = testCard('', 'anon front', 'anon back');
    expect(stableNoteGuid(anon)).toBe(stableNoteGuid(anon));

    const used = new Set<string>();
    const first = uniqueNoteGuid(cardA, used);
    const second = uniqueNoteGuid(cardA, used);
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
  });

  it('record_conversion_reuses_stable_guid_across_exports', () => {
    const card = testCard('stable-guid', 'Q', 'A');
    const fields = ['Front', 'Back'];
    const convert = () => convertCardsToAnkiRecordsWithFields([structuredClone(card)], 'Basic', fields);
    const first = convert();
    const second = convert();
    expect(first[0]![1]).toBe(second[0]![1]);
    expect(first[0]![1]).toBe(stableNoteGuid(card));
  });

  it('field_values_with_unit_separator_are_sanitized', () => {
    const card = testCard('sep', 'front\u001fwith separator', 'back\u001ftoo');
    const records = convertCardsToAnkiRecordsWithFields([card], 'Basic', ['Front', 'Back']);
    expect(records[0]![2].split('\u001f')).toHaveLength(2);
    expect(records[0]![2]).toBe('front with separator\u001fback too');
  });

  it('cloze_text_field_falls_back_to_front_with_cloze_markup', () => {
    const cloze = testCard('cloze-fallback', 'Capital is {{c1::Paris}}', 'extra');
    expect(resolveCardFieldValue(cloze, 'Text')).toBe('Capital is {{c1::Paris}}');

    const plain = testCard('plain', 'no cloze here', 'back');
    expect(resolveCardFieldValue(plain, 'Text')).toBe('');

    const explicit = testCard('explicit', '{{c1::ignored}}', 'back');
    explicit.text = '{{c1::kept}}';
    expect(resolveCardFieldValue(explicit, 'Text')).toBe('{{c1::kept}}');
  });

  it('contains_cloze_marker_matches_valid_markers_only', () => {
    expect(containsClozeMarker('{{c1::answer}}')).toBe(true);
    expect(containsClozeMarker('prefix {{c12::answer::hint}} suffix')).toBe(true);
    expect(containsClozeMarker('{{Front}} plain')).toBe(false);
    expect(containsClozeMarker('{{c::missing number}}')).toBe(false);
    expect(containsClozeMarker('no markers')).toBe(false);
  });

  it('reserved_import_metadata_fields_are_filtered_case_insensitively', () => {
    expect(isReservedImportMetadataField('AnkiNoteId')).toBe(true);
    expect(isReservedImportMetadataField('ankimodelname')).toBe(true);
    expect(isReservedImportMetadataField('AnkiIvl')).toBe(true);
    expect(isReservedImportMetadataField('ankischedtype')).toBe(true);
    expect(isReservedImportMetadataField('Subject')).toBe(false);
  });

  it('card_sched_restore_requires_review_progress_and_clamps_values', () => {
    expect(cardSchedRestore(testCard('plain', 'Q', 'A'))).toBeNull();

    const fresh = testCard('fresh', 'Q', 'A');
    fresh.extra_fields = { AnkiIvl: '10', AnkiReps: '0' };
    expect(cardSchedRestore(fresh)).toBeNull();

    const reviewed = testCard('reviewed', 'Q', 'A');
    reviewed.extra_fields = {
      AnkiSchedType: '2',
      AnkiQueue: '2',
      AnkiDue: '99999',
      AnkiIvl: '21',
      AnkiFactor: '50',
      AnkiReps: '9',
      AnkiLapses: '2',
    };
    expect(cardSchedRestore(reviewed)).toEqual({
      due: 21,
      ivl: 21,
      factor: 2500,
      reps: 9,
      lapses: 2,
      fsrs: null,
    });

    const dueKept = testCard('due-kept', 'Q', 'A');
    dueKept.extra_fields = {
      AnkiDue: '3',
      AnkiIvl: '21',
      AnkiFactor: '2300',
      AnkiReps: '4',
    };
    expect(cardSchedRestore(dueKept)).toEqual({
      due: 3,
      ivl: 21,
      factor: 2300,
      reps: 4,
      lapses: 0,
      fsrs: null,
    });
  });

  it('internal_protocol_field_predicate_covers_underscore_and_reserved_keys', () => {
    expect(isInternalProtocolField('_occlusion')).toBe(true);
    expect(isInternalProtocolField('_qa_flags')).toBe(true);
    expect(isInternalProtocolField('_original_generation')).toBe(true);
    expect(isInternalProtocolField('_content_provenance')).toBe(true);
    expect(isInternalProtocolField('AnkiNoteId')).toBe(true);
    expect(isInternalProtocolField('ankiivl')).toBe(true);
    expect(isInternalProtocolField('Subject')).toBe(false);
    expect(isInternalProtocolField('Extra')).toBe(false);
    expect(isInternalProtocolField('Occlusion')).toBe(false);
    // 保留字段清单与 Rust 一致（13 个 Anki* + AnkiFsrs）。
    expect(RESERVED_IMPORT_METADATA_FIELDS).toHaveLength(15);
    expect(RESERVED_IMPORT_METADATA_FIELDS).toContain('AnkiFsrs');
  });

  it('resolve_card_field_value_refuses_internal_protocol_fields', () => {
    const card = testCard('guard', 'Q', 'A');
    card.extra_fields = {
      _occlusion: '{"imageRef":"x"}',
      _qa_flags: '[]',
      Subject: 'Physics',
    };
    expect(resolveCardFieldValue(card, '_occlusion')).toBe('');
    expect(resolveCardFieldValue(card, '_qa_flags')).toBe('');
    expect(resolveCardFieldValue(card, 'Subject')).toBe('Physics');
  });

  it('format_io_rects_delegates_to_validated_anki_io_syntax', () => {
    const spec = {
      imageRef: 'diagram.png',
      boxes: [
        { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: '左心房', clozeIndex: 1 },
        { x: 0.5, y: 0.625, w: 0.125, h: 0.25, label: '右心室', clozeIndex: 2 },
      ],
    };
    expect(formatIoRects(spec)).toBe(
      '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}'
      + '{{c2::image-occlusion:rect:left=.5:top=.625:width=.125:height=.25}}',
    );
    expect(formatIoRects({ imageRef: 'diagram.png', boxes: [] })).toBe('');
  });

  it('occlusion_media_file_name_resolves_basename_and_rejects_placeholders', () => {
    expect(occlusionMediaFileName('/tmp/media/diagram.png')).toBe('diagram.png');
    expect(occlusionMediaFileName('vfs://images/diagram.png')).toBe('diagram.png');
    expect(occlusionMediaFileName('vlm://pending-image')).toBeNull();
    expect(occlusionMediaFileName('   ')).toBeNull();
  });

  it('normalize_keeps_cards_without_occlusion_unchanged', () => {
    const plain = testCard('plain', 'Q', 'A');
    plain.text = '{{c1::kept}}';
    plain.images = ['/tmp/img.png'];
    plain.extra_fields = { Subject: 'Physics', AnkiIvl: '21' };
    const before = structuredClone(plain);
    const cards = [plain];
    normalizeCardsForExport(cards);
    expect(cards[0]!.text).toBe(before.text);
    expect(cards[0]!.images).toEqual(before.images);
    expect(cards[0]!.extra_fields).toEqual(before.extra_fields);
    expect(cards[0]!.front).toBe(before.front);
    expect(cards[0]!.back).toBe(before.back);
  });

  it('normalize_strips_underscore_fields_but_keeps_anki_sched_keys', () => {
    const card = testCard('strip', 'Q', 'A');
    card.extra_fields = {
      _qa_flags: '[]',
      _original_generation: '{}',
      _content_provenance: '{}',
      AnkiIvl: '21',
      Subject: 'Physics',
    };
    const cards = [card];
    normalizeCardsForExport(cards);
    const extras = cards[0]!.extra_fields;
    expect(Object.keys(extras).some((key) => key.startsWith('_'))).toBe(false);
    expect(extras.AnkiIvl).toBe('21');
    expect(extras.Subject).toBe('Physics');
  });

  it('occlusion_conversion_builds_cloze_text_media_without_io_extra', () => {
    const card = testCard('occ', 'front', '揭底说明');
    card.extra_fields = { _occlusion: occlusionSpecJson('/tmp/media/diagram.png') };
    const cards = [card];
    normalizeCardsForExport(cards);
    const converted = cards[0]!;

    const text = converted.text;
    expect(text).not.toBeNull();
    expect(text!.startsWith('<img src="diagram.png"><br>')).toBe(true);
    expect(text).toContain('{{c1::左心房}}');
    expect(text).toContain('{{c2::右心室}}');
    expect(converted.images).toEqual(['/tmp/media/diagram.png']);
    expect(Object.keys(converted.extra_fields).some((key) => key.toLowerCase() === 'extra')).toBe(false);
    const resolvedExtra = resolveCardFieldValue(converted, 'Extra');
    expect(resolvedExtra).toBe('揭底说明');
    expect(resolvedExtra).not.toContain('image-occlusion:rect');
    expect(converted.extra_fields._occlusion).toBeUndefined();
  });

  it('occlusion_conversion_leaves_human_extra_untouched', () => {
    const card = testCard('occ-extra', 'front', 'back');
    card.extra_fields = {
      _occlusion: occlusionSpecJson('/tmp/media/diagram.png'),
      Extra: '人工笔记：注意瓣膜方向',
    };
    const cards = [card];
    normalizeCardsForExport(cards);
    const converted = cards[0]!;
    expect(converted.extra_fields.Extra).toBe('人工笔记：注意瓣膜方向');
    expect(resolveCardFieldValue(converted, 'Extra')).not.toContain('image-occlusion:rect');
  });

  it('occlusion_conversion_prefers_existing_card_text', () => {
    const card = testCard('occ-text', 'front', '');
    card.text = '{{c1::既有挖空}}';
    card.extra_fields = { _occlusion: occlusionSpecJson('vfs://images/diagram.png') };
    const cards = [card];
    normalizeCardsForExport(cards);
    expect(cards[0]!.text).toBe('<img src="diagram.png"><br>{{c1::既有挖空}}');
  });

  it('test_export_apkg_basic_field_count_matches_model', () => {
    const out = path.join(tmpRoot, 'basic.apkg');
    const card = testCard('1', 'Q', 'A');
    card.tags = ['t1'];

    exportCardsToApkgWithFullTemplateReport(runtime, [card], 'TestDeck', 'Basic', out, null, null);

    const cardOrds = withCollection(out, (db) => {
      const model = modelOf(db);
      const fieldCount = modelFieldNames(model).length;
      const noteFlds = db.one<{ flds: string }>('SELECT flds FROM notes LIMIT 1').flds;
      expect(noteFlds.split('\u001f')).toHaveLength(fieldCount);
      return db.all<{ ord: number }>('SELECT ord FROM cards ORDER BY ord').map((row) => row.ord);
    });
    expect(cardOrds).toEqual([0]);
  });

  it('multi_template_export_writes_each_cloze_ord_once_and_basic_once', () => {
    const out = path.join(tmpRoot, 'multi-cloze.apkg');
    const cloze = testCard('cloze', 'cloze front', 'cloze back');
    cloze.template_id = 'cloze-template';
    cloze.text = '{{c3::three}} {{c1::one}} {{c2::two}} {{c2::duplicate}} '
      + '{{c0::zero}} {{c4::   }} {{c5::::hint}}';
    const basic = testCard('basic', 'Basic {{c9::literal}}', 'answer');
    basic.template_id = 'basic-template';

    exportMultiTemplateApkgReport(runtime, [cloze, basic], 'Cloze ords', out, new Map([
      ['cloze-template', testTemplate('cloze-template', 'Cloze', ['Text', 'Extra'])],
      ['basic-template', testTemplate('basic-template', 'Basic', ['Front', 'Back'])],
    ]));

    const rows = withCollection(out, (db) => db.all<{ flds: string; ord: number }>(
      `SELECT n.flds AS flds, c.ord AS ord
       FROM notes n INNER JOIN cards c ON c.nid = n.id
       ORDER BY n.flds, c.ord`,
    ));
    expect(rows.filter((row) => row.flds.includes('{{c3::three}}')).map((row) => row.ord)).toEqual([0, 1, 2]);
    expect(rows.filter((row) => row.flds.includes('Basic {{c9::literal}}')).map((row) => row.ord)).toEqual([0]);
  });

  it('test_export_apkg_media_entries_are_indexed', () => {
    const out = path.join(tmpRoot, 'media.apkg');
    const imgPath = path.join(tmpRoot, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const card = testCard('1', 'Q', 'A');
    card.images = [imgPath];

    exportCardsToApkgWithFullTemplateReport(runtime, [card], 'TestDeck', 'Basic', out, null, null);

    expect(readMediaManifest(out)['0']).toBe('img.png');
    expect(readZip(fs.readFileSync(out)).has('0')).toBe(true);
  });

  it('test_export_apkg_missing_media_is_tolerated_and_reported', () => {
    const out = path.join(tmpRoot, 'missing-media.apkg');
    const imgPath = path.join(tmpRoot, 'exists.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const missingPath = path.join(tmpRoot, 'does-not-exist.png');
    const card = testCard('m', 'Q', 'A');
    card.images = [imgPath, missingPath];

    const report = exportCardsToApkgWithFullTemplateReport(
      runtime, [card], 'TestDeck', 'Basic', out, null, null,
    );
    expect(report.exportedMedia).toBe(1);
    expect(report.missingMedia).toEqual([missingPath]);

    const manifest = readMediaManifest(out);
    expect(manifest['0']).toBe('exists.png');
    expect(manifest['1']).toBeUndefined();
    const archive = readZip(fs.readFileSync(out));
    expect(archive.has('0')).toBe(true);
    expect(archive.has('1')).toBe(false);
  });

  it('multi_template_export_report_collects_missing_media', () => {
    const out = path.join(tmpRoot, 'multi-missing-media.apkg');
    const card = testCard('m', 'Q', 'A');
    card.images = [path.join(tmpRoot, 'ghost.png')];

    const report = exportMultiTemplateApkgReport(runtime, [card], 'Deck', out, new Map());
    expect(report.exportedMedia).toBe(0);
    expect(report.missingMedia).toHaveLength(1);
    expect(fs.existsSync(out)).toBe(true);
  });

  it('export_restores_schedule_columns_for_cards_with_imported_metadata', () => {
    const out = path.join(tmpRoot, 'sched-restore.apkg');
    const reviewed = testCard('reviewed', 'reviewed front', 'reviewed back');
    reviewed.extra_fields = {
      AnkiSchedType: '2',
      AnkiDue: '5',
      AnkiIvl: '12',
      AnkiFactor: '2600',
      AnkiReps: '7',
      AnkiLapses: '1',
    };
    const fresh = testCard('fresh', 'fresh front', 'fresh back');

    exportCardsToApkgWithFullTemplateReport(runtime, [reviewed, fresh], 'SchedDeck', 'Basic', out, null, null);

    withCollection(out, (db) => {
      const reviewedRow = db.one<{
        type: number; queue: number; due: number; ivl: number; factor: number; reps: number; lapses: number;
      }>(
        `SELECT c.type AS type, c.queue AS queue, c.due AS due, c.ivl AS ivl,
                c.factor AS factor, c.reps AS reps, c.lapses AS lapses
         FROM cards c INNER JOIN notes n ON n.id = c.nid
         WHERE n.flds LIKE 'reviewed front%'`,
      );
      expect([
        reviewedRow.type, reviewedRow.queue, reviewedRow.due, reviewedRow.ivl,
        reviewedRow.factor, reviewedRow.reps, reviewedRow.lapses,
      ]).toEqual([2, 2, 5, 12, 2600, 7, 1]);

      const freshRow = db.one<{ type: number; queue: number; ivl: number }>(
        `SELECT c.type AS type, c.queue AS queue, c.ivl AS ivl
         FROM cards c INNER JOIN notes n ON n.id = c.nid
         WHERE n.flds LIKE 'fresh front%'`,
      );
      expect([freshRow.type, freshRow.queue, freshRow.ivl]).toEqual([0, 0, 0]);
    });
  });

  it('export_writes_local_fsrs_progress_memory_state_and_revlog', () => {
    const out = path.join(tmpRoot, 'fsrs-progress.apkg');
    const nowMs = Date.now();
    const day = 86_400_000;

    const reviewed = testCard('fsrs-reviewed', 'fsrs front', 'fsrs back');
    reviewed.extra_fields = {
      AnkiIvl: '3',
      AnkiReps: '1',
      AnkiFsrs: JSON.stringify({
        v: 1,
        state: 2,
        s: 12.5,
        d: 6.0,
        dr: 0.9,
        decay: 0.1542,
        ivl: 12.0,
        due: nowMs + 5 * day + 3_600_000,
        lrt: nowMs - 7 * day,
        reps: 4,
        lapses: 1,
        susp: false,
        rollover: 4,
        rev: [
          [nowMs - 20 * day, 3, 0, 1, 0.0, nowMs - 20 * day + 600_000, 4_000],
          [nowMs - 19 * day, 3, 1, 2, 2.0, nowMs - 17 * day, 3_000],
          [nowMs - 7 * day, 1, 2, 3, 0.0, nowMs - 7 * day + 600_000, 9_000],
        ],
      }),
    };
    const fresh = testCard('fsrs-fresh', 'fresh front', 'fresh back');
    fresh.extra_fields = {
      AnkiFsrs: JSON.stringify({ v: 1, state: 0, due: nowMs, reps: 0, lapses: 0, rev: [] }),
    };

    exportCardsToApkgWithFullTemplateReport(runtime, [reviewed, fresh], 'FsrsDeck', 'Basic', out, null, null);

    withCollection(out, (db) => {
      const row = db.one<{
        id: number; type: number; queue: number; due: number; ivl: number;
        reps: number; lapses: number; data: string;
      }>(
        `SELECT c.id AS id, c.type AS type, c.queue AS queue, c.due AS due, c.ivl AS ivl,
                c.reps AS reps, c.lapses AS lapses, c.data AS data
         FROM cards c INNER JOIN notes n ON n.id = c.nid
         WHERE n.flds LIKE 'fsrs front%'`,
      );
      expect([row.type, row.queue, row.ivl, row.reps, row.lapses]).toEqual([2, 2, 12, 4, 1]);
      expect(row.due).toBeGreaterThanOrEqual(5);
      expect(row.due).toBeLessThanOrEqual(6);

      const data = JSON.parse(row.data) as Record<string, number>;
      expect(data.s).toBe(12.5);
      expect(data.d).toBe(6.0);
      expect(data.dr).toBe(0.9);
      expect(data.lrt).toBe(Math.trunc((nowMs - 7 * day) / 1000));

      const flds = db.one<{ flds: string }>(
        `SELECT n.flds AS flds FROM notes n INNER JOIN cards c ON c.nid = n.id WHERE c.id = ?1`,
        [row.id],
      ).flds;
      expect(flds).not.toContain('"rev"');

      const revlog = db.all<{ ease: number; ivl: number; type: number }>(
        'SELECT ease AS ease, ivl AS ivl, type AS type FROM revlog WHERE cid = ?1 ORDER BY id',
        [row.id],
      ).map((entry) => [entry.ease, entry.ivl, entry.type]);
      expect(revlog).toEqual([[3, -600, 0], [3, 2, 0], [1, -600, 1]]);

      const freshRow = db.one<{ type: number; queue: number }>(
        `SELECT c.type AS type, c.queue AS queue FROM cards c
         INNER JOIN notes n ON n.id = c.nid WHERE n.flds LIKE 'fresh front%'`,
      );
      expect([freshRow.type, freshRow.queue]).toEqual([0, 0]);
    });
  });

  it('reexport_filters_injected_anki_metadata_fields_from_model', () => {
    const out = path.join(tmpRoot, 'reexport-filter.apkg');
    const card = testCard('reexport', 'Q', 'A');
    card.extra_fields = {
      AnkiNoteId: '1',
      AnkiCardId: '2',
      AnkiCardOrd: '0',
      AnkiDeckId: '1',
      AnkiModelId: '100',
      AnkiModelName: 'Basic',
      Subject: 'Physics',
    };

    exportCardsToApkgWithFullTemplateReport(runtime, [card], 'ReexportDeck', 'Basic', out, null, null);

    withCollection(out, (db) => {
      const fieldNames = modelFieldNames(modelOf(db));
      expect(fieldNames).toContain('Subject');
      for (const reserved of RESERVED_IMPORT_METADATA_FIELDS) {
        expect(fieldNames).not.toContain(reserved);
      }
      const noteFlds = db.one<{ flds: string }>('SELECT flds FROM notes LIMIT 1').flds;
      expect(noteFlds.split('\u001f')).toHaveLength(fieldNames.length);
    });
  });

  it('export_uses_non_reserved_deck_id_with_consistent_references', () => {
    const out = path.join(tmpRoot, 'deck-id.apkg');
    exportCardsToApkgWithFullTemplateReport(runtime, [testCard('d1', 'Q', 'A')], 'DeckIdCheck', 'Basic', out, null, null);

    withCollection(out, (db) => {
      const decks = JSON.parse(db.one<{ decks: string }>('SELECT decks FROM col LIMIT 1').decks) as Record<string, unknown>;
      expect(decks[String(APKG_EXPORT_DECK_ID)]).toBeDefined();
      expect(decks['1']).toBeUndefined();
      expect(db.one<{ did: number }>('SELECT did FROM cards LIMIT 1').did).toBe(APKG_EXPORT_DECK_ID);
    });
  });

  it('duplicate_media_basenames_from_different_paths_are_reported', () => {
    const out = path.join(tmpRoot, 'dup-media.apkg');
    const dirA = path.join(tmpRoot, 'a');
    const dirB = path.join(tmpRoot, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const imgA = path.join(dirA, 'same.png');
    const imgB = path.join(dirB, 'same.png');
    fs.writeFileSync(imgA, 'content-a');
    fs.writeFileSync(imgB, 'content-b');
    const card = testCard('dup', 'Q', 'A');
    card.images = [imgA, imgB];

    const report = exportCardsToApkgWithFullTemplateReport(runtime, [card], 'DupMedia', 'Basic', out, null, null);
    expect(report.exportedMedia).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('same.png');
    expect(report.warnings[0]).toContain('媒体同名冲突');
  });

  it('internal_protocol_fields_do_not_enter_model_field_table', () => {
    const out = path.join(tmpRoot, 'internal-filter.apkg');
    const card = testCard('internal', 'Q', 'A');
    card.extra_fields = {
      _qa_flags: '[{"code":"x"}]',
      _original_generation: '{"front":"Q"}',
      _content_provenance: '{"actor":"llm"}',
      Subject: 'Physics',
    };

    exportCardsToApkgWithFullTemplateReport(runtime, [card], 'InternalFilter', 'Basic', out, null, null);

    withCollection(out, (db) => {
      const fieldNames = modelFieldNames(modelOf(db));
      expect(fieldNames).toContain('Subject');
      expect(fieldNames.some((name) => name.startsWith('_'))).toBe(false);
      const noteFlds = db.one<{ flds: string }>('SELECT flds FROM notes LIMIT 1').flds;
      expect(noteFlds).not.toContain('_original_generation');
      expect(noteFlds).not.toContain('llm');
      expect(noteFlds.split('\u001f')).toHaveLength(fieldNames.length);
    });
  });

  it('occlusion_card_exports_reviewable_cloze_note_with_media', () => {
    const out = path.join(tmpRoot, 'occlusion.apkg');
    const imgPath = path.join(tmpRoot, 'diagram.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const card = testCard('occ-export', 'front', 'back');
    card.extra_fields = {
      _occlusion: occlusionSpecJson(imgPath),
      _qa_flags: '[]',
    };

    const report = exportCardsToApkgWithFullTemplateReport(
      runtime, [card], 'OcclusionDeck', 'Cloze', out, null, null,
    );
    expect(report.exportedMedia).toBe(1);
    expect(report.missingMedia).toEqual([]);

    withCollection(out, (db) => {
      const noteFlds = db.one<{ flds: string }>('SELECT flds FROM notes LIMIT 1').flds;
      expect(noteFlds).toContain('<img src="diagram.png">');
      expect(noteFlds).toContain('{{c1::左心房}}');
      expect(noteFlds).toContain('{{c2::右心室}}');
      expect(noteFlds).not.toContain('_occlusion');
      expect(noteFlds).not.toContain('image-occlusion:rect');

      const cardOrds = db.all<{ ord: number }>('SELECT ord FROM cards ORDER BY ord').map((row) => row.ord);
      expect(cardOrds).toEqual([0, 1]);

      const fieldNames = modelFieldNames(modelOf(db));
      expect(fieldNames.every((name) => !name.startsWith('_'))).toBe(true);
    });

    expect(readMediaManifest(out)['0']).toBe('diagram.png');
  });

  it('occlusion_card_with_missing_image_still_exports_text', () => {
    const out = path.join(tmpRoot, 'occlusion-missing.apkg');
    const ghost = path.join(tmpRoot, 'ghost.png');
    const card = testCard('occ-missing', 'front', 'back');
    card.extra_fields = { _occlusion: occlusionSpecJson(ghost) };

    const report = exportCardsToApkgWithFullTemplateReport(
      runtime, [card], 'OcclusionMissing', 'Cloze', out, null, null,
    );
    expect(report.exportedMedia).toBe(0);
    expect(report.missingMedia).toHaveLength(1);

    withCollection(out, (db) => {
      const noteFlds = db.one<{ flds: string }>('SELECT flds FROM notes LIMIT 1').flds;
      expect(noteFlds).toContain('<img src="ghost.png">');
      expect(noteFlds).toContain('{{c1::左心房}}');
    });
  });
});
