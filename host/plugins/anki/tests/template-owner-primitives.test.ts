import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { AnkiTemplateService, CreateTemplateRequest, CustomAnkiTemplate } from '../api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const request = (patch: Partial<CreateTemplateRequest> = {}): CreateTemplateRequest => ({
  name: 'Primitive template', description: 'description', preview_front: '', preview_back: '',
  note_type: 'Basic', fields: ['Front'], generation_prompt: 'Generate cards',
  front_template: '{{Front}}', back_template: '{{FrontSide}}', css_style: '.card {}',
  field_extraction_rules: {
    Front: { field_type: 'Text', is_required: true, description: 'Question' },
  },
  ...patch,
});

/** Raw primitives throw the unwrapped storage/anyhow-style Error, never the facade CommandError. */
function expectRawError(run: () => unknown, message: string): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(CommandError);
  expect((caught as Error).message).toBe(message);
}

const bundled = JSON.parse(
  fs.readFileSync(new URL('../data/builtin-templates.json', import.meta.url), 'utf8'),
) as Array<Record<string, string>>;

describe('WP-160 anki.templates raw owner primitives (L24 template_executor.rs)', () => {
  let env: AnkiTestEnv;
  let templates: AnkiTemplateService;
  beforeEach(async () => {
    env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
    templates = env.host.ctx.anki.templates;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.dispose();
  });

  const mistakes = () => env.storage.database('mistakes');
  const userState = (id: string) => mistakes().get<{ user_modified: number; user_deleted: number }>(
    'SELECT user_modified, user_deleted FROM custom_anki_templates WHERE id = ?', [id],
  );

  it('importBuiltinTemplatesIfEmpty inserts every bundled builtin with its own id/version/author (chatanki_executor.rs:11742)', async () => {
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(16);
    const list = templates.list();
    expect(list.map((t) => t.id).sort()).toEqual(bundled.map((t) => t.id).sort());
    for (const source of bundled) {
      const row = templates.get(source.id!)!;
      expect(row).toMatchObject({
        name: source.name, description: source.description, author: source.author, version: source.version,
        note_type: source.note_type, fields: JSON.parse(source.fields_json!),
        front_template: source.front_template, back_template: source.back_template, css_style: source.css_style,
        preview_front: source.preview_front, preview_back: source.preview_back,
        preview_data_json: source.preview_data_json ?? null, generation_prompt: source.generation_prompt,
        is_active: true, is_built_in: true,
      });
      expect(Object.keys(row.field_extraction_rules).sort())
        .toEqual(Object.keys(JSON.parse(source.field_extraction_rules_json!)).sort());
    }
    expect(userState('design-lab')).toEqual({ user_modified: 0, user_deleted: 0 });
    // Same rows as the production `import_builtin_templates` IPC reads back.
    expect(await env.host.invoke('get_all_custom_templates')).toEqual(list);
    // Existing ids are skipped: a second run inserts nothing and changes nothing.
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(0);
    expect(templates.list()).toEqual(list);
  });

  it('importBuiltinTemplatesIfEmpty skips existing ids, keeps tombstones, and silently drops failed inserts', () => {
    templates.importBuiltinTemplatesIfEmpty();
    templates.softDeleteBuiltin('design-lab');
    mistakes().run("DELETE FROM custom_anki_templates WHERE id IN ('design-glass', 'design-exam')");
    mistakes().exec("CREATE TRIGGER deny_exam BEFORE INSERT ON custom_anki_templates WHEN NEW.id = 'design-exam' BEGIN SELECT RAISE(ABORT, 'insert denied'); END");
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(1);
    expect(templates.get('design-glass')).toMatchObject({ is_built_in: true, is_active: true });
    expect(templates.get('design-exam')).toBeNull();
    expect(templates.get('design-lab')).toMatchObject({ is_active: false });
    expect(userState('design-lab')).toEqual({ user_modified: 0, user_deleted: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('importBuiltinTemplatesIfEmpty applies Value defaults, fields/rules fallbacks and normalization (chatanki_executor.rs:11361-11417)', () => {
    const data = [
      { id: '  ', name: 'blank id is skipped' },
      { name: 'missing id is skipped' },
      'not an object',
      { id: ' spaced ', name: 'Spaced', fields_json: 'not json', fields: ['Q', 'tags'], field_extraction_rules_json: '{"Q":{"field_type":"Bogus"}}',
        field_extraction_rules: { Q: { field_type: 'RichText', is_required: false, description: 'question' } } },
      { id: 'defaults', fields_json: '[1]', field_extraction_rules_json: 7, author: 3, version: null },
    ];
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(data));
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(2);
    read.mockRestore();
    expect(templates.list().map((t) => t.id).sort()).toEqual(['defaults', 'spaced']);
    expect(templates.get('spaced')).toMatchObject({
      fields: ['Q', 'tags'],
      field_extraction_rules: {
        Q: { field_type: 'RichText', is_required: false, description: 'question', default_value: null, validation_pattern: null },
        tags: { field_type: 'Array', is_required: false, default_value: '[]', validation_pattern: null, description: 'tags' },
      },
    });
    expect(templates.get('defaults')).toEqual(expect.objectContaining({
      name: '未命名模板', description: '', author: null, version: '1.0.0', preview_front: '', preview_back: '',
      note_type: 'Basic', fields: ['front', 'back', 'tags'], generation_prompt: '', front_template: '',
      back_template: '', css_style: '', preview_data_json: null, is_active: true, is_built_in: true,
      field_extraction_rules: {
        front: { field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: 'front' },
        back: { field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: 'back' },
        tags: { field_type: 'Array', is_required: false, default_value: '[]', validation_pattern: null, description: 'tags' },
      },
    } satisfies Partial<CustomAnkiTemplate>));
  });

  it('importBuiltinTemplatesIfEmpty reports an unusable bundled JSON as `Parse builtin templates failed`', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('{"not":"a list"}').mockReturnValueOnce('[');
    expectRawError(() => templates.importBuiltinTemplatesIfEmpty(), 'Parse builtin templates failed: invalid type: map, expected a sequence at line 1 column 0');
    expectRawError(() => templates.importBuiltinTemplatesIfEmpty(), 'Parse builtin templates failed: EOF while parsing a list at line 1 column 1');
    expect(read).toHaveBeenCalledTimes(2);
    expect(templates.list()).toEqual([]);
  });

  it('importBuiltinTemplatesIfEmpty trims ids with Rust White_Space and attempts insertion after a real read error', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify([
      { id: '\u0085nel\u0085', name: 'NEL' }, { id: '\uFEFFbom\uFEFF', name: 'BOM' },
    ]));
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(2);
    read.mockRestore();
    expect(templates.list().map((t) => t.id).sort()).toEqual(['nel', '\uFEFFbom\uFEFF']);
    const db = mistakes();
    db.exec('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
    const get = vi.spyOn(db, 'get');
    const run = vi.spyOn(db, 'run');
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    expect(templates.importBuiltinTemplatesIfEmpty()).toBe(0);
    expect(get).toHaveBeenCalledTimes(16);
    expect(run).toHaveBeenCalledTimes(16);
    expect(get.mock.results.every((result) => result.type === 'throw')).toBe(true);
    expect(run.mock.results.every((result) => result.type === 'throw')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('updateIfVersion writes an explicit version as-is even when it equals the current one (mod.rs:2725-2737)', () => {
    const id = templates.create(request());
    expect(templates.updateIfVersion(id, { name: 'Same version', version: '1.0.0', expected_version: '1.0.0' })).toBeUndefined();
    expect(templates.get(id)).toMatchObject({ name: 'Same version', version: '1.0.0' });
    templates.updateIfVersion(id, { version: '9.9.9', expected_version: '1.0.0' });
    expect(templates.get(id)?.version).toBe('9.9.9');
    // Facade (IPC update_custom_template) keeps its own bump-on-equal behavior.
    expect(templates.update(id, { version: '9.9.9', expected_version: '9.9.9' })).toBeNull();
    expect(templates.get(id)?.version).toBe('9.9.10');
  });

  it('updateIfVersion increments the current version without explicit version, falling back to 1.0.0 on an unreadable column', () => {
    const id = templates.create(request({ version: '2.3.4' }));
    templates.updateIfVersion(id, { description: 'bumped', expected_version: '2.3.4' });
    expect(templates.get(id)).toMatchObject({ description: 'bumped', version: '2.3.5' });
    templates.updateIfVersion(id, { version: null, expected_version: '2.3.5' });
    expect(templates.get(id)?.version).toBe('2.3.6');
    templates.updateIfVersion(id, { expected_version: null });
    expect(templates.get(id)?.version).toBe('2.3.7');
    mistakes().run("UPDATE custom_anki_templates SET version = X'31' WHERE id = ?", [id]);
    templates.updateIfVersion(id, {});
    expect(mistakes().pluck('SELECT version FROM custom_anki_templates WHERE id = ?', [id])).toBe('1.0.1');
  });

  it('updateIfVersion applies a fields-only patch without merged re-validation, unlike the facade', () => {
    const id = templates.create(request());
    let facadeError: unknown;
    try { templates.update(id, { fields: ['Front', 'Back'], expected_version: '1.0.0' }); } catch (error) { facadeError = error; }
    expect(facadeError).toMatchObject({ value: { error_type: 'Validation', message: "缺少字段 'Back' 的提取规则" } });
    expect(templates.get(id)?.fields).toEqual(['Front']);
    templates.updateIfVersion(id, { fields: ['Front', 'Back'], expected_version: '1.0.0' });
    expect(templates.get(id)).toMatchObject({
      fields: ['Front', 'Back'], version: '1.0.1', field_extraction_rules: { Front: { description: 'Question' } },
    });
    expect(Object.keys(templates.get(id)!.field_extraction_rules)).toEqual(['Front']);
  });

  it('updateIfVersion CAS: stale/missing expected_version throws optimistic_lock_failed and keeps the competing write (mod.rs:2822-2833)', async () => {
    const id = templates.create(request());
    const snapshot = templates.get(id)!;
    // Competing writer lands between the consumer's read and its CAS write.
    await env.host.invoke('update_custom_template', { templateId: id, request: { name: 'Competing', expected_version: snapshot.version } });
    const competing = templates.get(id)!;
    expect(competing).toMatchObject({ name: 'Competing', version: '1.0.1' });
    expectRawError(() => templates.updateIfVersion(id, { name: 'Stale', expected_version: snapshot.version }), 'optimistic_lock_failed');
    expect(templates.get(id)).toEqual(competing);
    expectRawError(() => templates.updateIfVersion('missing', { name: 'x', expected_version: '1.0.0' }), 'optimistic_lock_failed');
    expect(templates.updateIfVersion('missing', { name: 'x' })).toBeUndefined();
    expect(templates.get('missing')).toBeNull();
    mistakes().exec('CREATE TRIGGER deny_template_update BEFORE UPDATE ON custom_anki_templates BEGIN SELECT RAISE(IGNORE); END');
    expectRawError(() => templates.updateIfVersion(id, { name: 'Ignored', expected_version: '1.0.1' }), 'optimistic_lock_failed');
    expect(templates.get(id)).toEqual(competing);
    expect(mistakes().inTransaction).toBe(false);
  });

  it('updateIfVersion propagates the raw storage error and leaves the row unchanged', () => {
    const id = templates.create(request());
    const original = templates.get(id);
    mistakes().exec("CREATE TRIGGER deny_update BEFORE UPDATE ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    expectRawError(() => templates.updateIfVersion(id, { name: 'Denied', expected_version: '1.0.0' }), 'write denied');
    expect(templates.get(id)).toEqual(original);
  });

  it('updateIfVersion SQL CAS rejects a second connection committing between version SELECT and UPDATE', () => {
    const id = templates.create(request());
    const db = mistakes();
    const competitor = env.storage.openFile(db.path, { profile: 'mistakes', mustExist: true });
    const pluck = db.pluck.bind(db);
    const read = vi.spyOn(db, 'pluck').mockImplementationOnce((query, params) => {
      const snapshot = pluck(query, params);
      expect(snapshot).toBe('1.0.0');
      expect(db.inTransaction).toBe(false);
      expect(competitor.run("UPDATE custom_anki_templates SET name = 'Other connection', version = '1.0.1' WHERE id = ? AND version = '1.0.0'", [id]).changes).toBe(1);
      return snapshot;
    });
    try {
      expectRawError(() => templates.updateIfVersion(id, { name: 'Lost write', expected_version: '1.0.0' }), 'optimistic_lock_failed');
      expect(read).toHaveBeenCalledTimes(1);
      expect(templates.get(id)).toMatchObject({ name: 'Other connection', version: '1.0.1' });
      expect(competitor.pluck('SELECT name FROM custom_anki_templates WHERE id = ?', [id])).toBe('Other connection');
      expect(db.inTransaction).toBe(false);
    } finally {
      read.mockRestore();
      env.storage.close(competitor);
    }
  });

  it('updateIfVersion on a builtin leaves user_modified to the caller; markUserModified only marks builtin rows (mod.rs:2907)', () => {
    templates.importBuiltinTemplatesIfEmpty();
    const builtin = templates.get('design-lab')!;
    const customId = templates.create(request());
    templates.updateIfVersion(builtin.id, { description: 'AI edit', expected_version: builtin.version });
    expect(userState(builtin.id)).toEqual({ user_modified: 0, user_deleted: 0 });
    templates.markUserModified(builtin.id);
    templates.markUserModified(customId);
    templates.markUserModified('missing');
    expect(userState(builtin.id)).toEqual({ user_modified: 1, user_deleted: 0 });
    expect(userState(customId)).toEqual({ user_modified: 0, user_deleted: 0 });
    mistakes().exec("CREATE TRIGGER deny_modified BEFORE UPDATE OF user_modified ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'mark denied'); END");
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    templates.updateIfVersion(builtin.id, { description: 'Committed before failed mark' });
    expectRawError(() => templates.markUserModified(builtin.id), 'mark denied');
    expect(templates.get(builtin.id)?.description).toBe('Committed before failed mark');
    expect(mistakes().inTransaction).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('softDeleteBuiltin tombstones builtin rows and rejects custom/missing ids (mod.rs:2921-2937)', () => {
    templates.importBuiltinTemplatesIfEmpty();
    const customId = templates.create(request());
    const custom = templates.get(customId);
    templates.softDeleteBuiltin('design-lab');
    expect(templates.get('design-lab')).toMatchObject({ is_active: false, is_built_in: true });
    expect(userState('design-lab')).toEqual({ user_modified: 0, user_deleted: 1 });
    expectRawError(() => templates.softDeleteBuiltin(customId), `builtin_template_not_found: ${customId}`);
    expectRawError(() => templates.softDeleteBuiltin('missing'), 'builtin_template_not_found: missing');
    expect(templates.get(customId)).toEqual(custom);
    mistakes().exec("CREATE TRIGGER deny_update BEFORE UPDATE ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    expectRawError(() => templates.softDeleteBuiltin('design-glass'), 'write denied');
    expect(templates.get('design-glass')?.is_active).toBe(true);
  });

  it('countReferencingCards counts live references and surfaces a raw failure for warn-and-continue callers', async () => {
    const id = templates.create(request());
    const db = mistakes();
    db.exec("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, anki_generation_options_json) VALUES ('task', 'doc', 'doc', 0, 'content', 'Completed', '2020-01-01', '2020-01-01', '{}')");
    for (const card of ['live', 'deleted']) {
      db.run("INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at, template_id, deleted_at) VALUES (?, 'task', ?, 'back', '2020-01-01', '2020-01-01', ?, ?)", [card, card, id, card === 'deleted' ? '2020-01-02' : null]);
    }
    expect(templates.countReferencingCards(id)).toBe(1);
    expect(templates.countReferencingCards('missing')).toBe(0);
    templates.importBuiltinTemplatesIfEmpty();
    db.exec('ALTER TABLE anki_cards RENAME TO unavailable_cards');
    expectRawError(() => templates.countReferencingCards(id), 'no such table: anki_cards');
    await expect(env.host.invoke('delete_custom_template', { templateId: id })).rejects.toMatchObject({
      error_type: 'Database', message: '统计模板引用卡片失败: no such table: anki_cards', details: null,
    });
    expect(templates.get(id)).not.toBeNull();
    // The count failure does not block the separate delete primitive.
    templates.softDeleteBuiltin('design-lab');
    expect(userState('design-lab')?.user_deleted).toBe(1);
    templates.deleteCustom(id);
    expect(templates.get(id)).toBeNull();
  });

  it('countReferencingCards retains the original legacy-column fallback SQL (mod.rs:2875-2880)', () => {
    const db = mistakes();
    db.exec('ALTER TABLE anki_cards RENAME TO modern_cards');
    db.exec('CREATE TABLE anki_cards (template_id TEXT)');
    db.run("INSERT INTO anki_cards VALUES ('legacy'), ('legacy'), ('other')");
    expect(templates.countReferencingCards('legacy')).toBe(2);
    expect(templates.countReferencingCards('missing')).toBe(0);
  });

  it('deleteCustom deletes unconditionally, is a no-op for missing ids, and propagates raw failures (mod.rs:2839)', () => {
    templates.importBuiltinTemplatesIfEmpty();
    const id = templates.create(request());
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    templates.deleteCustom(id);
    expect(templates.get(id)).toBeNull();
    expect(templates.deleteCustom('missing')).toBeUndefined();
    templates.deleteCustom('design-glass');
    expect(templates.get('design-glass')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    mistakes().exec("CREATE TRIGGER deny_delete BEFORE DELETE ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    expectRawError(() => templates.deleteCustom('design-lab'), 'write denied');
    expect(templates.get('design-lab')).not.toBeNull();
  });
});
