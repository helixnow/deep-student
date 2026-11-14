import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  buildBasicFields,
  buildFieldsWithModelNames,
  classifyCanAddFalse,
  extractFieldMediaRefs,
  isAudioMediaFilename,
  isDuplicateNoteError,
  isInternalProtocolField,
  mediaBasename,
  modelMatchesTemplate,
  noteToJson,
  prepareOcclusionNote,
  readMediaFileBase64,
  syncReportToJson,
  templateModelName,
  type AnkiNote,
} from '../src/anki-sync.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';
import { setAnkiLocalRuntime } from '../src/local-runtime.ts';
import { nodeAnkiLocalRuntime } from '../src/local-runtime.node.ts';

const OCCLUSION_TAG = 'image-occlusion';

// 一部分用例直接调用桌面实现（`readMediaFileBase64`）；这里固定安装桌面端口。
beforeAll(() => { setAnkiLocalRuntime(nodeAnkiLocalRuntime); });
afterAll(() => { setAnkiLocalRuntime(null); });

function identityTemplate(): CustomAnkiTemplate {
  return {
    id: 'template-a',
    name: 'Basic',
    description: '',
    author: null,
    version: '1',
    preview_front: '',
    preview_back: '',
    note_type: 'Basic',
    fields: ['Front', 'Back'],
    generation_prompt: '',
    front_template: '{{Front}}',
    back_template: '{{Back}}',
    css_style: '.card { color: red; }',
    field_extraction_rules: {},
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    is_active: true,
    is_built_in: false,
    preview_data_json: null,
  };
}

function emptyCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    front: '',
    back: '',
    text: null,
    tags: [],
    images: [],
    id: 'card-1',
    task_id: 'task-1',
    is_error_card: false,
    error_content: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    extra_fields: {},
    template_id: null,
    ...overrides,
  };
}

function basicNote(front: string, back: string): AnkiNote {
  return {
    deckName: 'Default',
    modelName: 'Basic',
    fields: { Front: front, Back: back },
    tags: [],
    picture: [],
    audio: [],
  };
}

function basicModelCache(): Map<string, readonly string[] | null> {
  return new Map([['Basic', ['Front', 'Back']]]);
}

function occlusionTestCard(text: string | null, imageRef: string): AnkiCard {
  const occlusionJson = JSON.stringify({
    imageRef,
    boxes: [
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: '左心房', clozeIndex: 1 },
      { x: 0.6, y: 0.6, w: 0.2, h: 0.2, label: '右心室', clozeIndex: 2 },
    ],
  });
  return emptyCard({
    front: '正面',
    back: '背面',
    text,
    tags: [OCCLUSION_TAG],
    extra_fields: { _occlusion: occlusionJson },
  });
}

function plainTestCard(): AnkiCard {
  return emptyCard({
    front: '问题',
    back: '答案',
    extra_fields: { Extra: '补充' },
  });
}

describe('crates/dstu-anki/src/anki_connect_service.rs::tests', () => {
  it('custom_model_identity_uses_template_id_and_version_not_note_type_or_title', () => {
    const template = identityTemplate();
    const name = templateModelName(template);
    const renamed = { ...template, name: 'Renamed' };
    expect(templateModelName(renamed)).toBe(name);
    const otherId = { ...template, id: 'template-b' };
    expect(templateModelName(otherId)).not.toBe(name);
    const otherVersion = { ...template, version: '2' };
    expect(templateModelName(otherVersion)).not.toBe(name);
    expect(name).not.toBe('Basic');
  });

  it('existing_models_must_match_field_order_card_faces_and_css', () => {
    const template = identityTemplate();
    const faces = { 'Card 1': { Front: template.front_template, Back: template.back_template } };
    const css = { css: template.css_style };
    expect(modelMatchesTemplate(template, template.fields, faces, css)).toBe(true);

    const reversed = [...template.fields].reverse();
    expect(modelMatchesTemplate(template, reversed, faces, css)).toBe(false);

    const wrongFaces = { 'Card 1': { Front: '{{Back}}', Back: '{{Front}}' } };
    expect(modelMatchesTemplate(template, template.fields, wrongFaces, css)).toBe(false);
    expect(modelMatchesTemplate(template, template.fields, faces, { css: '' })).toBe(false);

    const extraFace = { ...faces, 'Card 2': faces['Card 1'] };
    expect(modelMatchesTemplate(template, template.fields, extraFace, css)).toBe(false);
  });

  it('can_add_false_with_valid_note_is_duplicate', () => {
    expect(classifyCanAddFalse(basicNote('question', 'answer'), basicModelCache())).toBe('duplicate');
  });

  it('can_add_false_with_empty_first_field_is_failure', () => {
    expect(classifyCanAddFalse(basicNote('   ', 'answer'), basicModelCache())).toBe('invalid_note');
  });

  it('can_add_false_with_unknown_model_fields_is_failure', () => {
    const cache = new Map<string, readonly string[] | null>([['Basic', null]]);
    expect(classifyCanAddFalse(basicNote('question', 'answer'), cache)).toBe('invalid_note');
  });

  it('can_add_false_with_missing_model_field_is_failure', () => {
    const note = basicNote('question', 'answer');
    delete note.fields.Back;
    expect(classifyCanAddFalse(note, basicModelCache())).toBe('invalid_note');
  });

  it('note_serialization_omits_empty_media_attachments', () => {
    const value = noteToJson(basicNote('question', 'answer'));
    expect(value.picture).toBeUndefined();
    expect(value.audio).toBeUndefined();

    const withMedia = basicNote('question', 'answer');
    withMedia.picture!.push({ data: 'aGk=', filename: 'img.png', fields: ['Back'] });
    const mediaValue = noteToJson(withMedia);
    const picture = mediaValue.picture as Record<string, unknown>[];
    expect(picture[0]!.filename).toBe('img.png');
    expect(picture[0]!.data).toBe('aGk=');
    expect(picture[0]!.url).toBeUndefined();
    expect((picture[0]!.fields as string[])[0]).toBe('Back');
  });

  it('media_filename_classification_and_ref_extraction', () => {
    expect(isAudioMediaFilename('clip.mp3')).toBe(true);
    expect(isAudioMediaFilename('CLIP.WAV')).toBe(true);
    expect(isAudioMediaFilename('img.png')).toBe(false);
    expect(isAudioMediaFilename('noext')).toBe(false);

    const html = `<img src="one.png"> text <img src='/abs/two.jpg'/> [sound:clip.mp3] src= broken`;
    expect(extractFieldMediaRefs(html)).toEqual(['one.png', '/abs/two.jpg', 'clip.mp3']);

    expect(mediaBasename('/abs/path/pic.png')).toBe('pic.png');
    expect(mediaBasename('pic.png')).toBe('pic.png');
    expect(mediaBasename('')).toBeNull();
  });

  it('read_media_file_base64_reads_and_limits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-media-'));
    try {
      const mediaPath = path.join(dir, 'img.png');
      fs.writeFileSync(mediaPath, 'hi');
      expect(readMediaFileBase64(mediaPath)).toBe('aGk=');
      expect(() => readMediaFileBase64(path.join(dir, 'missing.png'))).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('duplicate_note_error_detection_is_case_insensitive', () => {
    expect(isDuplicateNoteError('cannot create note because it is a duplicate')).toBe(true);
    expect(isDuplicateNoteError('AnkiConnect错误(addNote): Duplicate')).toBe(true);
    expect(isDuplicateNoteError('model was not found: Basic')).toBe(false);
  });

  it('sync_report_omits_empty_optional_fields_for_backward_compat', () => {
    const value = syncReportToJson({
      noteIds: [1, null],
      added: 1,
      duplicates: 1,
      failed: 0,
      createdModels: [],
      modelErrors: [],
      warnings: [],
    });
    expect((value.noteIds as (number | null)[])[0]).toBe(1);
    expect(value.added).toBe(1);
    expect(value.duplicates).toBe(1);
    expect(value.failed).toBe(0);
    expect(Array.isArray(value.createdModels)).toBe(true);
    expect(value.modelErrors).toBeUndefined();
    expect(value.warnings).toBeUndefined();
  });

  it('sync_report_serializes_structured_model_errors_when_present', () => {
    const value = syncReportToJson({
      noteIds: [null],
      added: 0,
      duplicates: 0,
      failed: 1,
      createdModels: [],
      modelErrors: [{ model: 'Custom', error: '自动创建模型失败: boom' }],
      warnings: ['canAddNotes 预检不可用，已降级为逐条 addNote: timeout'],
    });
    const errors = value.modelErrors as { model: string; error: string }[];
    expect(errors[0]!.model).toBe('Custom');
    expect(errors[0]!.error).toContain('boom');
    expect((value.warnings as string[])[0]).toContain('addNote');
  });

  it('internal_protocol_field_predicate_covers_underscore_and_reserved_keys', () => {
    expect(isInternalProtocolField('_occlusion')).toBe(true);
    expect(isInternalProtocolField('_qa_flags')).toBe(true);
    expect(isInternalProtocolField('_original_generation')).toBe(true);
    expect(isInternalProtocolField('AnkiNoteId')).toBe(true);
    expect(isInternalProtocolField('ankilapses')).toBe(true);
    expect(isInternalProtocolField('Occlusion')).toBe(false);
    expect(isInternalProtocolField('Front')).toBe(false);
  });

  it('occlusion_json_never_leaks_into_emitted_fields', () => {
    const card = occlusionTestCard('{{c1::左心房}}', '/abs/diagram.png');
    card.extra_fields._qa_flags = '{"flags":[]}';
    card.extra_fields.AnkiNoteId = '12345';

    const modelFields = ['Text', 'Extra', 'Occlusion', 'AnkiNoteId'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Cloze');

    expect(fields.Occlusion).toBe('');
    expect(fields.AnkiNoteId).toBe('');
    expect(Object.hasOwn(fields, '_occlusion')).toBe(false);
    for (const value of Object.values(fields)) {
      expect(value).not.toContain('imageRef');
      expect(value).not.toContain('_occlusion');
    }
    expect(fields.Text?.includes('{{c')).toBe(true);
  });

  it('occlusion_card_prefers_card_text_and_mounts_image_ref', () => {
    const authoredText = '<img src="diagram.png"><br>{{c1::左心房}} {{c2::右心室}}';
    const card = occlusionTestCard(authoredText, '/abs/diagram.png');
    const modelFields = ['Text', 'Extra'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Cloze');
    const warnings: string[] = [];

    prepareOcclusionNote(card, fields, warnings);

    expect(fields.Text).toBe(authoredText);
    expect(card.images).toContain('/abs/diagram.png');
    expect(warnings).toEqual([]);
  });

  it('occlusion_card_without_cloze_text_rebuilds_from_spec', () => {
    const card = occlusionTestCard(null, '/abs/diagram.png');
    const modelFields = ['Text', 'Extra'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Cloze');
    expect(fields.Text!.includes('{{c')).toBe(false);
    const warnings: string[] = [];

    prepareOcclusionNote(card, fields, warnings);

    const text = fields.Text!;
    expect(text).toContain('{{c1::左心房}}');
    expect(text).toContain('{{c2::右心室}}');
    expect(text).toContain('<img src="diagram.png">');
    expect(card.images).toContain('/abs/diagram.png');
  });

  it('occlusion_pending_image_ref_is_not_mounted', () => {
    const card = occlusionTestCard(null, 'vlm://pending-image');
    const modelFields = ['Text'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Cloze');
    const warnings: string[] = [];

    prepareOcclusionNote(card, fields, warnings);

    expect(card.images).toEqual([]);
    const text = fields.Text!;
    expect(text).toContain('{{c1::左心房}}');
    expect(text).not.toContain('<img');
  });

  it('occlusion_invalid_spec_degrades_with_warning', () => {
    const card = plainTestCard();
    card.extra_fields._occlusion = 'not-json';
    const modelFields = ['Front', 'Back'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Basic');
    const before = { ...fields };
    const warnings: string[] = [];

    prepareOcclusionNote(card, fields, warnings);

    expect(fields).toEqual(before);
    expect(card.images).toEqual([]);
    expect(warnings.some((warning) => warning.includes('_occlusion'))).toBe(true);
  });

  it('plain_card_regression_prepare_occlusion_note_is_noop', () => {
    const card = plainTestCard();
    const modelFields = ['Front', 'Back', 'Extra'];
    const fields = buildFieldsWithModelNames(card, modelFields, 'Basic');
    const before = { ...fields };
    const warnings: string[] = [];

    prepareOcclusionNote(card, fields, warnings);

    expect(fields).toEqual(before);
    expect(card.images).toEqual([]);
    expect(warnings).toEqual([]);
    expect(fields.Extra).toBe('补充');
    expect(fields.Front).toBe('问题');
    expect(fields.Back).toBe('答案');
  });
});

describe('add_cards_to_anki_connect 前置校验（真实 mistakes 库）', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
    db.run('DELETE FROM custom_anki_templates');
  });

  it('rejects empty selections, blank deck and blank note type before any network call', async () => {
    await expect(env.host.invoke('add_cards_to_anki_connect', {
      selectedCards: [],
      deckName: 'Default',
      noteType: 'Basic',
    })).rejects.toMatchObject({ error_type: 'Validation', message: '没有选择任何卡片' });

    await expect(env.host.invoke('add_cards_to_anki_connect', {
      selectedCards: [emptyCard()],
      deckName: '   ',
      noteType: 'Basic',
    })).rejects.toMatchObject({ error_type: 'Validation', message: '牌组名称不能为空' });

    await expect(env.host.invoke('add_cards_to_anki_connect', {
      selectedCards: [emptyCard()],
      deckName: 'Default',
      noteType: ' ',
    })).rejects.toMatchObject({ error_type: 'Validation', message: '笔记类型不能为空' });
  });

  it('serialises basic fields for the default note type', () => {
    expect(buildBasicFields(emptyCard({ front: 'F', back: 'B' }), 'Basic')).toEqual({ Front: 'F', Back: 'B' });
    expect(buildBasicFields(emptyCard({ front: 'F', back: '' }), 'Cloze')).toEqual({ Text: 'F' });
    expect(buildBasicFields(emptyCard({ front: 'F', back: 'B' }), 'Cloze')).toEqual({
      Text: 'F\n\nB',
      Extra: 'B',
    });
  });
});
