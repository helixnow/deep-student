import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { AnkiTemplateService, CreateTemplateRequest, CustomAnkiTemplate } from '../api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const request = (patch: Partial<CreateTemplateRequest> = {}): CreateTemplateRequest => ({
  name: 'Owner template', description: 'description', preview_front: '', preview_back: '',
  note_type: 'Basic', fields: ['Front'], generation_prompt: 'Generate cards',
  front_template: '{{Front}}', back_template: '{{FrontSide}}', css_style: '.card {}',
  field_extraction_rules: {
    Front: { field_type: 'Text', is_required: true, description: 'Question' },
  },
  ...patch,
});

function expectAppError(run: () => unknown, error_type: string, message: string): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CommandError);
  expect(caught).toMatchObject({ value: { error_type, message, details: null } });
}

describe('WP-015 real anki.templates owner provider', () => {
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

  it('shares CRUD with production commands, preserving UUID, defaults, timestamps and wire fields', async () => {
    expect(templates.list()).toEqual([]);
    expect(templates.get('missing')).toBeNull();
    const id = templates.create(request());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const created = templates.get(id)!;
    expect(created).toEqual({
      ...request(), id, author: null, version: '1.0.0', is_active: true, is_built_in: false,
      preview_data_json: null, created_at: expect.any(String), updated_at: expect.any(String),
      field_extraction_rules: {
        Front: { ...request().field_extraction_rules.Front, default_value: null, validation_pattern: null },
      },
    });
    expect(created.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3}(?:\d{3}){0,2})?Z$/);
    expect(created.updated_at).toBe(created.created_at);
    expect(await env.host.invoke('get_all_custom_templates')).toEqual([created]);
    expect(await env.host.invoke('get_custom_template_by_id', { templateId: id })).toEqual(created);
    const db = env.storage.database('mistakes');
    const raw = db.get<{ created_at: string; updated_at: string }>(
      'SELECT created_at, updated_at FROM custom_anki_templates WHERE id = ?', [id],
    )!;
    expect(raw.created_at).toBe(raw.updated_at);
    expect(raw.created_at).toMatch(/\+00:00$/);
    expect(templates.update(id, { name: 'Updated', expected_version: created.version, version: created.version })).toBeNull();
    const updated = await env.host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: id });
    expect(updated).toEqual({ ...created, name: 'Updated', version: '1.0.1', updated_at: expect.any(String) });
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));
    await env.host.invoke('update_custom_template', { templateId: id, request: { expected_version: '1.0.1', version: '3.2.1', author: 'author' } });
    expect(templates.get(id)).toMatchObject({ version: '3.2.1', author: 'author', created_at: created.created_at });
    expect(templates.update(id, { expected_version: '3.2.1', author: null })).toBeNull();
    expect(templates.get(id)).toMatchObject({ version: '3.2.2', author: 'author' });
    expect(templates.delete(id)).toEqual({
      deleted: true, deactivated: false, isBuiltIn: false, referencingCards: 0, message: '模板「Updated」已删除',
    });
    expect(await env.host.invoke('get_custom_template_by_id', { templateId: id })).toBeNull();
    const commandId = await env.host.invoke<string>('create_custom_template', { request: request({ version: 'legacy', is_active: false }) });
    expect(templates.update(commandId, { expected_version: 'legacy' })).toBeNull();
    expect(templates.get(commandId)).toMatchObject({ version: '1.0.1', is_active: false });
    await env.host.invoke('delete_custom_template', { templateId: commandId });
    expect(templates.list()).toEqual([]);
    expect(env.host.events).toEqual([]);
  });

  it('keeps list ordering, nullable/invalid JSON fallback and precise chrono dates with warnings', () => {
    const first = templates.create(request({ name: 'First' }));
    const second = templates.create(request({ name: 'Second' }));
    const db = env.storage.database('mistakes');
    db.run("UPDATE custom_anki_templates SET created_at = '2020-01-01T08:00:00.123456789+08:00'");
    expect(templates.list().map((t) => t.id)).toEqual([first, second].sort());
    db.run("UPDATE custom_anki_templates SET created_at = '2021-01-01T00:00:00Z' WHERE id = ?", [second]);
    expect(templates.list().map((t) => t.id)).toEqual([second, first]);
    expect(templates.get(first)?.created_at).toBe('2020-01-01T00:00:00.123456789Z');
    db.run("UPDATE custom_anki_templates SET description = NULL, fields_json = '[1]', field_extraction_rules_json = '{', created_at = 'bad-created', updated_at = 'bad-updated' WHERE id = ?", [first]);
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    const before = Date.now();
    const read = templates.get(first)!;
    expect(read).toMatchObject({ description: '', fields: [], field_extraction_rules: {} });
    expect(Date.parse(read.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(read.updated_at)).toBeLessThanOrEqual(Date.now());
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "无法解析 created_at 日期: 'bad-created', 使用当前时间",
      "无法解析 updated_at 日期: 'bad-updated', 使用当前时间",
    ]);
    warn.mockClear();
    expect(templates.list()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each<[Partial<CreateTemplateRequest>, string]>([
    [{ name: '\u0085' }, '模板名称不能为空'],
    [{ fields: [] }, '模板必须至少包含一个字段'],
    [{ front_template: '\u0085' }, '正面模板不能为空'],
    [{ back_template: '' }, '背面模板不能为空'],
    [{ generation_prompt: '' }, '生成提示词不能为空'],
    [{ field_extraction_rules: {} }, "缺少字段 'Front' 的提取规则"],
    [{ fields: ['Other'] }, "缺少字段 'Other' 的提取规则"],
    [{ field_extraction_rules: { ...request().field_extraction_rules, Extra: request().field_extraction_rules.Front! } }, '字段提取规则包含未定义字段: Extra'],
    [{ note_type: 'Cloze' }, 'Cloze 模板「Owner template」的正面模板缺少 {{cloze:字段}} 占位符，Anki 无法生成填空卡片'],
  ])('validates create before persistence: %j', (patch, message) => {
    expectAppError(() => templates.create(request(patch)), 'Validation', message);
    expect(templates.list()).toEqual([]);
  });

  it('warns for sorted unknown field references without blocking a valid template', () => {
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    const id = templates.create(request({ name: '\uFEFF', back_template: '{{Z}} {{#A}}{{A}}{{/A}} {{FrontSide}}' }));
    expect(templates.get(id)?.name).toBe('\uFEFF');
    expect(warn).toHaveBeenCalledExactlyOnceWith('模板「\uFEFF」的 front/back 模板引用了 fields 之外的字段: A, Z（渲染时将为空白，请核对字段定义）');
  });

  it('preserves missing/version/merged-validation ordering and the SQL CAS zero-row branch', () => {
    expectAppError(() => templates.update('missing', {}), 'Validation', '模板不存在');
    expectAppError(() => templates.delete('missing'), 'Validation', '模板不存在');
    const id = templates.create(request());
    const original = templates.get(id);
    expectAppError(() => templates.update(id, { name: '' }), 'Validation', '模板版本缺失，请刷新后重试');
    expectAppError(() => templates.update(id, { expected_version: null }), 'Validation', '模板版本缺失，请刷新后重试');
    expectAppError(() => templates.update(id, { name: '', expected_version: 'old' }), 'Validation', '模板已被更新，请刷新后重试');
    expectAppError(() => templates.update(id, { name: '', expected_version: '1.0.0' }), 'Validation', '模板名称不能为空');
    const db = env.storage.database('mistakes');
    db.exec('CREATE TRIGGER deny_template_update BEFORE UPDATE ON custom_anki_templates BEGIN SELECT RAISE(IGNORE); END');
    expectAppError(() => templates.update(id, { name: 'Changed', expected_version: '1.0.0' }), 'Validation', '模板已被更新，请刷新后重试');
    expect(templates.get(id)).toEqual(original);
  });

  it('keeps builtin modification best-effort and deletion as a non-resurrecting tombstone', async () => {
    await env.host.invoke('import_builtin_templates');
    const original = templates.get('design-lab')!;
    const db = env.storage.database('mistakes');
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    db.exec("CREATE TRIGGER deny_modified BEFORE UPDATE OF user_modified ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'mark denied'); END");
    expect(templates.update(original.id, { expected_version: original.version, description: 'User edit' })).toBeNull();
    const updated = templates.get(original.id)!;
    expect(updated.description).toBe('User edit');
    expect(updated.version).not.toBe(original.version);
    expect(warn).toHaveBeenCalledWith(`标记内置模板 user_modified 失败: design-lab (mark denied)，内置模板升级导入可能覆盖此次修改`);
    db.exec('DROP TRIGGER deny_modified');
    templates.update(original.id, { expected_version: updated.version });
    expect(db.pluck('SELECT user_modified FROM custom_anki_templates WHERE id = ?', [original.id])).toBe(1);
    expect(templates.delete(original.id)).toEqual({
      deleted: false, deactivated: true, isBuiltIn: true, referencingCards: 0,
      message: `内置模板「${original.name}」已停用（内置模板不可物理删除，已有 0 张卡片引用不受影响）`,
    });
    expect(templates.get(original.id)).toMatchObject({ id: original.id, is_active: false, is_built_in: true });
    expect(db.pluck('SELECT user_deleted FROM custom_anki_templates WHERE id = ?', [original.id])).toBe(1);
    await env.host.invoke('import_builtin_templates');
    expect(templates.get(original.id)?.is_active).toBe(false);
  });

  it('counts only live references and warns after physically deleting a user template', () => {
    const id = templates.create(request());
    const db = env.storage.database('mistakes');
    db.exec("INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, anki_generation_options_json) VALUES ('task', 'doc', 'doc', 0, 'content', 'Completed', '2020-01-01', '2020-01-01', '{}')");
    for (const card of ['live', 'deleted']) {
      db.run("INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at, template_id, deleted_at) VALUES (?, 'task', ?, 'back', '2020-01-01', '2020-01-01', ?, ?)", [card, card, id, card === 'deleted' ? '2020-01-02' : null]);
    }
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    expect(templates.delete(id)).toMatchObject({ deleted: true, referencingCards: 1 });
    expect(templates.get(id)).toBeNull();
    expect(db.pluck('SELECT COUNT(*) FROM anki_cards WHERE template_id = ?', [id])).toBe(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith("模板 'Owner template' 已删除，但仍有 1 张卡片引用它（template_id 绑定失效）");
  });

  it('maps read and reference-count failures at their original command stages', () => {
    const id = templates.create(request());
    const db = env.storage.database('mistakes');
    db.exec('ALTER TABLE anki_cards RENAME TO unavailable_cards');
    expectAppError(() => templates.delete(id), 'Database', '统计模板引用卡片失败: no such table: anki_cards');
    expect(templates.get(id)).not.toBeNull();
    db.exec('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
    expectAppError(() => templates.list(), 'Database', '获取模板列表失败: no such table: custom_anki_templates');
    expectAppError(() => templates.get(id), 'Database', '获取模板失败: no such table: custom_anki_templates');
    expectAppError(() => templates.update(id, {}), 'Database', '查询模板失败: no such table: custom_anki_templates');
    expectAppError(() => templates.delete(id), 'Database', '查询模板失败: no such table: custom_anki_templates');
  });

  it('listAll is get_all_custom_templates: list() rows and order, the storage error unwrapped (database/mod.rs:2552)', () => {
    const first = templates.create(request({ name: 'First' }));
    const second = templates.create(request({ name: 'Second' }));
    const db = env.storage.database('mistakes');
    db.run("UPDATE custom_anki_templates SET created_at = '2021-01-01T00:00:00Z' WHERE id = ?", [second]);
    expect(templates.listAll()).toEqual(templates.list());
    expect(templates.listAll().map((t) => t.id)).toEqual([first, second]);
    db.exec('ALTER TABLE custom_anki_templates RENAME TO unavailable_templates');
    let caught: unknown;
    try { templates.listAll(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CommandError);
    expect((caught as Error).message).toBe('no such table: custom_anki_templates');
  });

  it('keeps single-statement atomicity on create/update/delete failures', () => {
    const id = templates.create(request());
    const builtinId = templates.create(request({ name: 'Builtin', is_built_in: true }));
    const original = templates.list();
    const db = env.storage.database('mistakes');
    db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    db.exec("CREATE TRIGGER deny_delete BEFORE DELETE ON custom_anki_templates BEGIN SELECT RAISE(ABORT, 'write denied'); END");
    expectAppError(() => templates.create(request({ name: 'Denied' })), 'Database', '创建模板失败: write denied');
    expectAppError(() => templates.update(id, { expected_version: '1.0.0' }), 'Database', '更新模板失败: write denied');
    expectAppError(() => templates.delete(id), 'Database', '删除模板失败: write denied');
    expectAppError(() => templates.delete(builtinId), 'Database', '停用内置模板失败: write denied');
    expect(templates.list()).toEqual(original);
    expect(db.inTransaction).toBe(false);
  });
});
