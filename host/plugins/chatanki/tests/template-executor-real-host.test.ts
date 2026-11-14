/**
 * WP-119: the template designer tools (template_executor.rs) run against the
 * published L16 `anki.templates` owner after a formal plugin install. No
 * TemplateDatabase is injected; the real `hydrate` supplies the store, and every
 * row is cross-checked through L16's own IPC commands on the same repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, CustomAnkiTemplate, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

const rule = (description: string) => ({ field_type: 'Text', is_required: true, description });
const definition = (name: string) => ({
  name, description: 'desc', noteType: 'Basic', fields: ['Front', 'Back'],
  frontTemplate: '{{Front}}', backTemplate: '{{Back}}', cssStyle: '.card {}',
  generationPrompt: 'gen', previewFront: 'pf', previewBack: 'pb',
  fieldExtractionRules: { Front: rule('正面'), Back: rule('背面') },
});

function harness() {
  const trace: unknown[][] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const context: ToolExecutionContext = {
    sessionId: 'session-tpl', messageId: 'message-tpl', blockId: 'block-tpl',
    emitToolCallStart: (name, args, id) => { trace.push(['start', name, args, id]); },
    emitToolCallEnd: (payload) => { trace.push(['end', payload]); },
    emitToolCallError: (error) => { trace.push(['error', error]); },
    saveToolBlock: (result) => { trace.push(['save', result]); },
    warn: (message) => { warns.push(message); },
    info: (message) => { infos.push(message); },
  };
  const run = (id: string, name: string, args: unknown) =>
    host.ctx.chatankiTools.execute({ id, name, arguments: args }, context);
  return { context, trace, infos, warns, run };
}

const row = (id: string) => storage.database('mistakes').get<{
  is_active: number; user_modified: number; user_deleted: number; version: string;
}>('SELECT is_active, user_modified, user_deleted, version FROM custom_anki_templates WHERE id = ?1', [id]);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-template-real-host-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } },
      storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {},
    },
  });
}, 60_000);

afterAll(async () => {
  if (host !== undefined) await host.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

describe('template_executor.rs through the published anki.templates owner', () => {
  it('template_list/template_get read the same repository as get_all_custom_templates (rs:734-905)', async () => {
    const { run, trace } = harness();
    // Production-owned fixture: the real L16 builtin import command.
    expect(await host.invoke<string>('import_builtin_templates')).toBe('导入完成: 16 个新增, 0 个更新, 0 个跳过');
    const listed = await run('tl1', 'builtin-template_list', { builtinOnly: true, limit: 3 });
    expect(listed.success).toBe(true);
    const ipc = await host.invoke<CustomAnkiTemplate[]>('get_all_custom_templates');
    const output = listed.output as { count: number; templates: Array<{ id: string; isBuiltIn: boolean }> };
    expect(output.count).toBe(3);
    expect(output.templates.map((t) => t.id)).toEqual(ipc.filter((t) => t.is_active && t.is_built_in).slice(0, 3).map((t) => t.id));
    expect(output.templates.every((t) => t.isBuiltIn)).toBe(true);
    expect(trace.map((event) => event[0])).toEqual(['start', 'end', 'save']);

    trace.length = 0;
    const got = await run('tg1', 'template_get', { templateId: 'design-lab' });
    expect(got.output).toMatchObject({ id: 'design-lab', version: '3.0.4', isBuiltIn: true, _visualRendered: true });
    const [, end, save] = trace as [unknown[], unknown[], unknown[]];
    expect((end[1] as { result: { _templateVisual: boolean } }).result._templateVisual).toBe(true);
    expect((save[1] as ToolResultInfo).output).toEqual((end[1] as { result: unknown }).result);

    trace.length = 0;
    const missing = await run('tg2', 'template_get', { template_id: 'tpl-missing' });
    expect(missing.success).toBe(false);
    expect(missing.error).toBe("模板 'tpl-missing' 不存在。请使用 template_list 查看可用模板");
    expect(trace.map((event) => event[0])).toEqual(['start', 'error', 'save']);
    expect(trace[1]).toEqual(['error', missing.error]);
    expect(trace[2]?.[1]).toEqual(missing);
  });

  it('template_create/template_fork/template_preview write and read through L16 (rs:949-1027,1230-1444)', async () => {
    const { run } = harness();
    const created = await run('tc1', 'template_create', { template: definition('Real Create') });
    expect(created.success).toBe(true);
    const id = (created.output as { templateId: string }).templateId;
    expect(created.output).toEqual({ created: true, templateId: id, name: 'Real Create', version: '1.0.0',
      noteType: 'Basic', fields: ['Front', 'Back'], isActive: true, _visualRendered: true });
    expect(await host.invoke<CustomAnkiTemplate | null>('get_custom_template_by_id', { templateId: id }))
      .toMatchObject({ id, name: 'Real Create', version: '1.0.0', is_built_in: false, is_active: true });

    const invalid = await run('tc2', 'template_create', { template: { ...definition('Bad'), fields: [] } });
    expect(invalid.error).toContain('模板校验失败: fields 不能为空');
    expect((await host.invoke<CustomAnkiTemplate[]>('get_all_custom_templates')).some((t) => t.name === 'Bad')).toBe(false);

    const forked = await run('tf1', 'template_fork', { templateId: 'design-lab' });
    const forkId = (forked.output as { templateId: string }).templateId;
    expect(forked.output).toMatchObject({ forked: true, sourceTemplateId: 'design-lab', name: 'The Lab (学术选择题) (副本)' });
    expect(await host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: forkId }))
      .toMatchObject({ version: '1.0.0', is_built_in: false, is_active: true });
    const forkMissing = await run('tf2', 'template_fork', { sourceTemplateId: 'tpl-missing' });
    expect(forkMissing.error).toBe("源模板 'tpl-missing' 不存在。请使用 template_list 查看可用模板");

    const preview = await run('tp1', 'template_preview', { templateId: id });
    expect(preview.output).toEqual({ previewRendered: true, usedTemplateId: id, fields: ['Front', 'Back'], _visualRendered: true });
    const previewMissing = await run('tp2', 'template_preview', { templateId: 'tpl-missing' });
    expect(previewMissing.error).toBe("模板 'tpl-missing' 不存在。请使用 template_list 查看可用模板");
  });

  it('template_update keeps the version CAS, missing and optimistic_lock_failed branches (rs:1029-1228)', async () => {
    const { run } = harness();
    const created = await run('tu0', 'template_create', { template: definition('CAS') });
    const id = (created.output as { templateId: string }).templateId;

    const stale = await run('tu1', 'template_update', { templateId: id, expectedVersion: '0.9.0', name: 'x' });
    expect(stale.error).toBe('版本冲突：当前版本 1.0.0 与提供的 expectedVersion 0.9.0 不匹配。请先用 template_get 获取最新版本');
    expect(row(id)?.version).toBe('1.0.0');

    const missing = await run('tu2', 'template_update', { templateId: 'tpl-missing', expectedVersion: '1.0.0', name: 'x' });
    expect(missing.error).toBe("模板 'tpl-missing' 不存在。请使用 template_list 查看可用模板");

    const updated = await run('tu3', 'template_update', { templateId: id, expectedVersion: '1.0.0', name: 'CAS Renamed' });
    expect(updated.success).toBe(true);
    expect(updated.output).toEqual({ updated: true, templateId: id, name: 'CAS Renamed', version: '1.0.1',
      fields: ['Front', 'Back'], noteType: 'Basic', _visualRendered: true });
    expect(await host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: id }))
      .toMatchObject({ name: 'CAS Renamed', version: '1.0.1' });

    // A competing writer lands between this executor's version check and its
    // write: the real L16 SQL CAS misses and maps to Rust's optimistic_lock_failed text.
    const templates = host.ctx.anki.templates;
    const realGet = templates.get;
    let raced = false;
    templates.get = (templateId: string) => {
      const snapshot = realGet.call(templates, templateId);
      if (!raced && templateId === id) {
        raced = true;
        templates.update(id, { expected_version: '1.0.1', name: 'Concurrent' });
      }
      return snapshot;
    };
    let race: ToolResultInfo;
    try { race = await run('tu4', 'template_update', { templateId: id, expectedVersion: '1.0.1', name: 'Loser' }); }
    finally { templates.get = realGet; }
    expect(raced).toBe(true);
    expect(race.error).toBe('模板已被其他操作更新。请重新用 template_get 获取最新版本后重试');
    expect(await host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: id }))
      .toMatchObject({ name: 'Concurrent', version: '1.0.2' });
  });

  it('builtin update marks user_modified; template_delete soft-deletes builtins and deletes custom rows (rs:1446-1555)', async () => {
    const { run, infos, warns } = harness();
    const before = await host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: 'design-manuscript' });
    const updated = await run('td0', 'template_update', {
      templateId: 'design-manuscript', patch: { expectedVersion: before.version, description: 'AI edit', isBuiltIn: false },
    });
    expect(updated.success).toBe(true);
    expect(row('design-manuscript')).toMatchObject({ user_modified: 1, version: '2.2.1' });
    expect((await host.invoke<CustomAnkiTemplate>('get_custom_template_by_id', { templateId: 'design-manuscript' })).is_built_in).toBe(true);

    // One live card references the builtin so referencingCards comes from the real count.
    const at = '2026-11-06T00:00:00Z';
    host.ctx.anki.documents.insertDocumentTask({
      id: 'task-tpl', document_id: 'doc-tpl', original_document_name: 'tpl.md', segment_index: 0,
      content_segment: 'seg', status: 'Completed', created_at: at, updated_at: at,
      error_message: null, anki_generation_options_json: '{}',
    });
    const card: AnkiCard = {
      id: 'card-tpl', task_id: 'task-tpl', front: 'f', back: 'b', text: null, tags: [], images: [],
      is_error_card: false, error_content: null, created_at: at, updated_at: at,
      extra_fields: {}, template_id: 'design-manuscript',
    };
    expect(host.ctx.anki.cards.insertCard(card)).toBe(true);

    const soft = await run('td1', 'builtin-template_delete', { templateId: 'design-manuscript' });
    expect(soft.output).toEqual({ success: true, deleted: false, deactivated: true, isBuiltIn: true,
      templateId: 'design-manuscript', templateName: 'The Manuscript (手稿风格)', referencingCards: 1,
      message: '内置模板「The Manuscript (手稿风格)」已停用（内置模板不可物理删除，已有 1 张卡片引用不受影响；后续版本升级不会重新启用它）。' });
    expect(row('design-manuscript')).toMatchObject({ is_active: 0, user_deleted: 1 });

    const inactive = await run('td2', 'template_set_default', { templateId: 'design-manuscript' });
    expect(inactive.error).toBe('模板「The Manuscript (手稿风格)」当前为停用状态，不能设为默认模板。请先将其激活');

    const created = await run('td3', 'template_create', { template: definition('Disposable') });
    const id = (created.output as { templateId: string }).templateId;
    const hard = await run('td4', 'template_delete', { templateId: id });
    expect(hard.output).toEqual({ success: true, deleted: true, deactivated: false, isBuiltIn: false,
      templateId: id, templateName: 'Disposable', referencingCards: 0, message: '模板「Disposable」已成功删除。' });
    expect(await host.invoke('get_custom_template_by_id', { templateId: id })).toBeNull();

    const gone = await run('td5', 'template_delete', { templateId: id });
    expect(gone.error).toBe(`模板不存在: ${id}。请使用 builtin-template_list 查看可用模板。`);

    expect(infos.filter((line) => !line.includes('execute: tool_name='))).toEqual([
      '[TemplateDesignerExecutor] Soft-deleted builtin template: id=design-manuscript, name=The Manuscript (手稿风格)',
      `[TemplateDesignerExecutor] Deleted template: id=${id}, name=Disposable`,
    ]);
    expect(warns).toEqual([]);
  });

  it('template_set_default writes the settings row read by get_default_template_id (rs:1557-1630)', async () => {
    const { run, infos, trace } = harness();
    const ok = await run('ts1', 'template_set_default', { templateId: 'design-lab' });
    expect(ok.output).toEqual({ success: true, templateId: 'design-lab', templateName: 'The Lab (学术选择题)',
      message: '已将「The Lab (学术选择题)」设为默认制卡模板。' });
    expect(await host.invoke('get_default_template_id')).toBe('design-lab');
    expect(infos).toContain('[TemplateDesignerExecutor] Set default template: id=design-lab, name=The Lab (学术选择题)');
    expect(trace.map((event) => event[0])).toEqual(['start', 'end', 'save']);
    const missing = await run('ts2', 'template_set_default', { templateId: 'tpl-missing' });
    expect(missing.error).toBe("模板 'tpl-missing' 不存在。请使用 template_list 查看可用模板");
    expect(await host.invoke('get_default_template_id')).toBe('design-lab');
  });

  it('the L07 registry wrapper hydrates the same template store', async () => {
    const executor = host.ctx.agentTools.toolExecutors()
      .find((candidate) => candidate.name() === 'TemplateDesignerExecutor');
    expect(executor).toBeDefined();
    const saved: unknown[] = [];
    const result = await executor!.execute!({ id: 'reg1', name: 'builtin-template_get', arguments: { templateId: 'design-lab' } }, {
      session_id: 'session-reg', message_id: 'message-reg', block_id: 'block-reg', variant_id: null,
      emitter: { emitError: () => undefined, emitChunk: () => undefined },
      emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
      saveToolBlock: (value: unknown) => { saved.push(value); },
    }) as ToolResultInfo;
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ id: 'design-lab', isBuiltIn: true });
    expect(saved).toHaveLength(1);
  });
});
