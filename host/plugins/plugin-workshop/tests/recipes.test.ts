/**
 * The two shipped recipes beyond the seed templates are real plugins: they must pass the same built-in compiler
 * and lifecycle self-check as generated code, and the agent-tool one must actually answer through the kernel.
 * Also covers what the workshop adds for such plugins: the sealed Host build, the handler check and the
 * Host-derived capability lines shown on the confirmation card.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import { pluginAgentToolName, type PluginAgentToolContext } from '../../../kernel/plugin-agent-tools.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';
import type { WorkshopTemplate } from '../api.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { checkWorkshopLifecycle, compileWorkshop, declaredCapabilities, type WorkshopBuild } from '../src/compiler.ts';
import { PipelineWorkshopGeneration } from '../src/generation.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { recipeFiles, workshopRecipes } from '../src/resources.ts';
import { writeSourceFiles } from '../src/source.ts';
import { WorkshopStore } from '../src/store.ts';

const APP_VERSION = '0.20.1';
/** Workshop works are installed with full trust; the app's `pluginModel` is whatever the llm plugin provides. */
const fullTrust = (services: Record<string, unknown> = {}) => async (): Promise<WorkshopSelfCheckContext> =>
  ({ trust: 'full', safeMode: false, services });

async function workspace(template: WorkshopTemplate) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-recipe-'));
  const store = new WorkshopStore(dataDir);
  const card = await store.propose({ sessionId: 'test', title: '作品', description: '说明', template, changes: [], capabilities: [] });
  const source = join(store.directory(card.id), 'source');
  const app = { version: APP_VERSION, dataDir, debug: true } as AppInfo;
  const recipe = await recipeFiles(template);
  const build = async (files: Record<string, string>, services?: Record<string, unknown>): Promise<WorkshopBuild> => {
    await writeSourceFiles(source, Object.entries(files).map(([path, content]) => ({ path, content })));
    const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app);
    await checkWorkshopLifecycle(built, app, fullTrust(services));
    return built;
  };
  return { card, app, recipe, build };
}

let host: TestHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
});

describe('recipe: a plugin that teaches the Agent a tool', () => {
  it('compiles, self-checks, and the installed tool reads the declared calendar and lists that day\'s lessons', async () => {
    const { card, recipe, build } = await workspace('host-tool');
    expect(recipe.name).toBe('agent-tool');
    const built = await build(recipe.files);
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
    expect(built.declared).toEqual(['让 AI 助手学会新本事「查课表」', '联网读取 calendar.example.edu.cn（只读，仅限这个域名）']);
    expect(built.manifest!.agentTools!.map(tool => [tool.name, tool.title, tool.sensitivity])).toEqual([['lookup_timetable', '查课表', 'medium']]);

    // Install the built package the way the manager does and call the tool through the kernel.
    host = await createTestHost({ app: { version: APP_VERSION } });
    const plugin = createRequire(import.meta.url)(join(built.directory, 'dist/host.js')).default as HostPlugin;
    // The address comes from the plugin's config (entered on the workshop card), never from the code.
    const installed = await host.runtime.installIsolated({ plugin, packageRoot: built.directory, manifest: { ...built.manifest!, trust: 'full' },
      config: { calendarUrl: 'https://calendar.example.edu.cn/timetable.ics' } });
    expect(installed.ok).toBe(true);
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Shanghai:20260907T080000', 'DTEND;TZID=Asia/Shanghai:20260907T093500',
      'RRULE:FREQ=WEEKLY;COUNT=16', 'SUMMARY:线性代数', 'LOCATION:教二\\, 301', 'DESCRIPTION:王老师', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:20261116T140000', 'DTEND:20261116T153500', 'SUMMARY:大学物理', 'LOCATION:理', ' 科楼 204', 'DESCRIPTION:李老师', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:20261117T100000', 'DTEND:20261117T113500', 'SUMMARY:英语', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART:20260908T100000', 'DTEND:20260908T113500', 'RRULE:FREQ=WEEKLY;INTERVAL=2', 'SUMMARY:实验（双周）', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const requested: string[] = [];
    const context: PluginAgentToolContext = { signal: new AbortController().signal,
      fetch: async url => { requested.push(url); return { status: 200, ok: true, contentType: 'text/calendar', text: ics }; } };
    const tools = host.ctx.get('pluginAgentTools')!;
    const name = pluginAgentToolName(card.pluginId, 'lookup_timetable');
    expect(tools.list().map(tool => tool.qualifiedName)).toEqual([name]);
    // 2026-11-16 是周一：每周一的线性代数（第 11 次）与当天单次的大学物理；周二的课不在内。
    await expect(tools.call(name, { date: '2026-11-16' }, context)).resolves.toEqual({ date: '2026-11-16', count: 2, lessons: [
      { start: '08:00', end: '09:35', course: '线性代数', room: '教二, 301', teacher: '王老师' },
      { start: '14:00', end: '15:35', course: '大学物理', room: '理科楼 204', teacher: '李老师' },
    ] });
    expect(requested).toEqual(['https://calendar.example.edu.cn/timetable.ics']);
    // COUNT=16 之后不再出现；隔周课只在偶数周。
    await expect(tools.call(name, { date: '2026-12-28' }, context)).resolves.toMatchObject({ count: 0 });
    await expect(tools.call(name, { date: '2026-09-22' }, context)).resolves.toMatchObject({ lessons: [expect.objectContaining({ course: '实验（双周）' })] });
    await expect(tools.call(name, { date: '2026-09-15' }, context)).resolves.toMatchObject({ count: 0 });
    await expect(tools.call(name, { date: '11/16' }, context)).rejects.toThrow('日期要写成 YYYY-MM-DD');
    await expect(tools.call(name, {}, { ...context, fetch: async () => ({ status: 503, ok: false, contentType: null, text: '' }) }))
      .rejects.toThrow('教务日历暂时读不到（HTTP 503）');
    // Disabled / uninstalled: the tool is gone with the plugin.
    await host.runtime.unload(card.pluginId);
    expect(tools.list()).toEqual([]);
  });

  it('seals the Host half: no ambient network, process or module access around the declared permissions', async () => {
    const { recipe, build } = await workspace('host-tool');
    const index = recipe.files['index.ts']!;
    const variants: [string, string, string][] = [
      ['global fetch', index.replace('await tool.fetch(calendarUrl)', 'await fetch(calendarUrl) as never'), 'cannot use the global "fetch"'],
      ['process', index.replace("const pad =", "const home = process.env.HOME;\nconst pad ="), 'cannot use the global "process"'],
      ['globalThis', index.replace("const pad =", "export const g = globalThis;\nconst pad ="), 'cannot use the global "globalThis"'],
      ['eval', index.replace("const pad =", "export const e = eval;\nconst pad ="), 'cannot use the global "eval"'],
      ['node module', `import { readFileSync } from 'node:fs';\n${index}\nexport const read = readFileSync;`, 'cannot import modules ("node:fs")'],
      ['dynamic import', index.replace("const pad =", "export const load = (name: string) => import(name);\nconst pad ="), 'cannot use dynamic import()'],
    ];
    for (const [label, source, problem] of variants) {
      const built = await build({ ...recipe.files, 'index.ts': source });
      expect(built.check.ok, label).toBe(false);
      expect(built.check.errors.join('\n'), label).toContain(problem);
    }
    // A local or a property with one of those names is not the global.
    const shadowed = await build({ ...recipe.files, 'index.ts': index.replace('const pad =',
      "const local = { process: 1, fetch: (value: number) => value };\nexport const used = ((fetch: number) => local.fetch(fetch))(local.process);\nconst pad =") });
    expect(shadowed.check.errors.join('\n')).toBe('');
    expect(shadowed.check.ok).toBe(true);
  });

  it('rejects a declared tool without its handler, an undeclared host and an undeclared service', async () => {
    const { recipe, build } = await workspace('host-tool');
    const renamed = await build({ ...recipe.files, 'index.ts': recipe.files['index.ts']!.replace('async lookup_timetable(', 'async timetable(') });
    expect(renamed.check).toMatchObject({ ok: false, compile: 'passed', lifecycle: 'failed' });
    expect(renamed.check.errors.join('\n')).toContain('agentTools "lookup_timetable" need a method of the same name on the primary service');

    const pkg = JSON.parse(recipe.files['package.json']!);
    const withoutPermission = await build({ ...recipe.files, 'package.json': JSON.stringify({ ...pkg, deepStudent: { ...pkg.deepStudent, permissions: ['net:calendar.example.edu.cn'] } }) });
    expect(withoutPermission.check.errors.join('\n')).toContain('requires the "agent:tools" permission');

    // Full trust does not cover undeclared services once the plugin gives the Agent tools.
    const injecting = await build({ ...recipe.files, 'index.ts': recipe.files['index.ts']!.replace("  name: '__PLUGIN_ID__',", "  name: '__PLUGIN_ID__',\n  inject: ['notes'],") }, { notes: {} });
    expect(injecting.check.errors.join('\n')).toContain('PERMISSION_UNDECLARED: injects "notes" without declaring "service:notes"');
  });
});

describe('recipe: a selection-toolbar button that asks the user\'s model', () => {
  it('compiles both halves, self-checks against the app\'s pluginModel and declares the model use', async () => {
    const { card, recipe, build } = await workspace('learning-tool');
    expect(recipe.name).toBe('selection-model');
    const calls: unknown[] = [];
    const pluginModel = { async complete(request: unknown, options: unknown) { calls.push([request, options]); return { text: '1. 特征向量不为零，\n2、一值可配无穷兵；\n\n乘个非零还是它，\n方向不变是真经。\n多余的一行' }; } };
    const built = await build(recipe.files, { pluginModel });
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
    expect(built.declared).toEqual(['用当前对话模型生成文字']);
    expect(calls).toEqual([]); // validation never calls live services

    const ui = await readFile(join(built.directory, 'dist/ui.js'), 'utf8');
    expect(ui).toContain('from "@deepstudent/ui"');
    expect(ui).toContain('createPluginOverlay');
    expect(ui).toContain('editor.selectionToolbar');
    expect(ui).toContain(`${card.pluginId}/mnemonic`);
    expect(ui).not.toContain('react-dom');
    // The button is a host-rendered labelled toolbar item, not one resized by plugin CSS that loses to the editor's rules.
    const source = recipe.files['ui.tsx']!;
    expect(source).toMatch(/label: '编成口诀',\s*icon: ICON,\s*showLabel: true/);
    expect(source).not.toMatch(/toolbar-item|!important|createElement\('style'\)/);

    // The Host half asks the model once, with the caller's signal, and returns four clean lines.
    host = await createTestHost({ app: { version: APP_VERSION }, provide: { pluginModel } });
    const plugin = createRequire(import.meta.url)(join(built.directory, 'dist/host.js')).default as HostPlugin;
    expect(plugin.meta.remote).toEqual({ [pluginServiceName(card.pluginId)]: ['mnemonic'] });
    await host.runtime.installIsolated({ plugin, packageRoot: built.directory, manifest: { ...built.manifest!, trust: 'full' } });
    const service = host.ctx.get(pluginServiceName(card.pluginId)) as { mnemonic(text: unknown, call?: { signal?: AbortSignal }): Promise<{ lines: string[] }> };
    const signal = new AbortController().signal;
    await expect(service.mnemonic('  若 Av = λv 且 v ≠ 0，\n 则 v 是特征向量。 ', { signal })).resolves.toEqual({
      lines: ['特征向量不为零，', '一值可配无穷兵；', '乘个非零还是它，', '方向不变是真经。'],
    });
    expect(calls).toEqual([[{ system: expect.stringContaining('恰好四句'), prompt: '若 Av = λv 且 v ≠ 0， 则 v 是特征向量。' }, { signal }]]);
    // Expected failures reach the UI half as AppError values (shown in the card), not as internal crashes.
    await expect(service.mnemonic('   ')).rejects.toEqual({ error_type: 'Unknown', message: '没有选中文字', details: null });
    pluginModel.complete = async () => { throw new Error('PLUGIN_MODEL_FAILED: 未配置对话模型'); };
    await expect(service.mnemonic('文字')).rejects.toEqual({ error_type: 'Unknown', message: 'PLUGIN_MODEL_FAILED: 未配置对话模型', details: null });
  });
});

describe('recipes are discoverable and described truthfully', () => {
  it('lists every recipe file as an example the Agent can read, and maps one recipe to each template', async () => {
    const catalog = new WorkshopCatalog(() => []);
    const examples = (await catalog.list('examples')).entries.map(entry => entry.id);
    for (const [template, name] of Object.entries(workshopRecipes)) {
      const { files } = await recipeFiles(template as WorkshopTemplate);
      for (const file of Object.keys(files)) {
        const id = `examples:resources/dstu-workshop/recipes/${name}/${file}`;
        expect(examples).toContain(id);
        expect((await catalog.read(id, APP_VERSION)).content).toBe(files[file]);
      }
    }
    // The ids the development skill tells the Agent to read exist.
    const skill = await readFile(join(catalog.root, 'resources/dstu-workshop/skills/dstu-plugin-development/SKILL.md'), 'utf8');
    expect(skill).toContain('examples:resources/dstu-workshop/recipes/agent-tool/index.ts');
    expect(examples).toContain('examples:resources/dstu-workshop/recipes/selection-model/ui.tsx');
  });

  it('derives the card\'s capability lines from the manifest and the module, not from Agent wording', () => {
    const manifest = { id: 'workshop.plugin-x', packageName: 'x', version: '1.0.0', engines: '^0.20', platforms: ['desktop' as const], requires: {},
      permissions: ['agent:tools', 'net:a.example.com', 'net:b.example.org', 'service:pluginModel', 'service:storage', 'service:notes'],
      agentTools: [
        { name: 'one', title: '查课表', description: 'd', parameters: {}, sensitivity: 'medium' as const },
        { name: 'two', title: '退课', description: 'd', parameters: {}, sensitivity: 'high' as const },
      ] };
    expect(declaredCapabilities(manifest, ['log', 'notes', 'settings'])).toEqual([
      '让 AI 助手学会新本事「查课表」', '让 AI 助手学会新本事「退课」（敏感操作，调用前按你的审批设置询问）',
      '联网读取 a.example.com（只读，仅限这个域名）', '联网读取 b.example.org（只读，仅限这个域名）',
      '用当前对话模型生成文字', '在插件自己的数据目录里保存数据', '使用应用服务「笔记」', '读取和保存设置',
    ]);
    expect(declaredCapabilities({ ...manifest, permissions: [], agentTools: [] })).toEqual([]);
  });

  it('puts the derived lines on the card when the candidate is staged for confirmation', async () => {
    const operations = new WorkshopOperations({ version: APP_VERSION, dataDir: await mkdtemp(join(tmpdir(), 'dstu-recipe-card-')), debug: true } as AppInfo);
    const card = await operations.propose({ sessionId: 'test', title: '查课表', description: '说一句「查课表」，列出今天的课', template: 'host-tool',
      changes: [], capabilities: ['读取你订阅的教务日历（只读）'] });
    expect(card.declared).toBeUndefined();
    const { files } = await recipeFiles('host-tool');
    await operations.writeSource(card.id, card.revision, Object.entries(files).map(([path, content]) => ({ path, content })));
    const check = await operations.stageValidated(card.id);
    expect(check.ok, check.errors.join('\n')).toBe(true);
    expect(await operations.status(card.id)).toMatchObject({
      state: 'pending-confirmation',
      declared: ['让 AI 助手学会新本事「查课表」', '联网读取 calendar.example.edu.cn（只读，仅限这个域名）'],
      capabilities: ['读取你订阅的教务日历（只读）'],
      places: [{ kind: 'agentTool', title: '查课表' }],
    });
  });

  it('hands the generation task the recipe for its template and keeps the current source last', async () => {
    for (const [template, recipe, marker] of [['host-tool', 'agent-tool', 'lookup_timetable'], ['learning-tool', 'selection-model', 'createPluginOverlay']] as const) {
      const store = new WorkshopStore(await mkdtemp(join(tmpdir(), 'dstu-recipe-prompt-')));
      const card = await store.propose({ sessionId: 'test', title: '作品', description: '说明', template, changes: [], capabilities: [] });
      const prompts: string[] = [];
      const answer = JSON.stringify({ files: [{ path: 'notes.ts', content: 'export const note = 1;' }] });
      const generation = new PipelineWorkshopGeneration(
        { createSession() {}, getMessageBlocks: () => [{ type: 'content', content: answer }] } as never,
        { execute: async (_window: unknown, request: { content: string; options: { executionAllowedTools: string[] } }) => {
          prompts.push(request.content);
          // The generation session may only run the two read-only discovery tools: user-plugin tools are not offered to it.
          expect(request.options.executionAllowedTools).toEqual(['dstu_plugin_api_list', 'dstu_plugin_api_read']);
          return 'message';
        } } as never,
        { schemaTools: () => [{ id: 'dstu_plugin_api_list', schema: {} }, { id: 'dstu_plugin_api_read', schema: {} }, { id: 'dstu_plugin_validate', schema: {} }] } as never,
      );
      await generation.generate(card, join(store.directory(card.id), 'source'), new AbortController().signal);
      expect(prompts[0]).toContain(`Recipe "${recipe}"`);
      expect(prompts[0]).toContain(marker);
      const current = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf('\nTemplate: ') + '\nTemplate: '.length)) as Record<string, string>;
      expect(Object.keys(current)).toContain('package.json');
      expect(await readFile(join(store.directory(card.id), 'source', 'notes.ts'), 'utf8')).toBe('export const note = 1;');
    }
  });
});
