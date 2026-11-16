/**
 * Wiring of the plugin services into the workshop: recipe choice, the shared UI modules, the card's lines for the
 * new services, and card secrets (secure store only, never on the card, in config or the manifest).
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { uiExternals } from '../src/compiler.ts';
import { declaredCapabilities } from '../src/declared.ts';
import { detectUse } from '../src/detect.ts';
import { allWorkshopRecipes, recipeFiles, recipeFor } from '../src/resources.ts';
import { fillSettings, manifestSettings, settingHosts, settingValues, storeSecretSettings } from '../src/settings.ts';
import { expectedPlaces, proposalSettings } from '../src/store.ts';

const card = (description: string, template: 'learning-tool' | 'host-tool' = 'learning-tool') => ({ template, title: '作品', description, changes: [] });

describe('recipes', () => {
  it('ships every recipe and picks the service ones from the proposal wording', async () => {
    expect(allWorkshopRecipes).toEqual(expect.arrayContaining(['nightly-summary', 'pdf-selection', 'chat-command']));
    for (const name of allWorkshopRecipes) expect(Object.keys((await recipeFiles(name)).files)).toContain('package.json');
    expect(recipeFor(card('每晚 10 点把今天的笔记总结一下，提醒我'))).toBe('nightly-summary');
    expect(recipeFor(card('看 PDF 时划词就能让 AI 讲解'))).toBe('pdf-selection');
    expect(recipeFor(card('在聊天里输入斜杠命令 /总结'))).toBe('chat-command');
    expect(recipeFor(card('选中一段话时多一个按钮'))).toBe('selection-model');
    expect(recipeFor(card('公式速查'))).toBe('reference-app');
    expect(recipeFor(card('每天提醒我', 'host-tool'))).toBe('agent-tool');
  });

  it('expected places follow the recipe (F9): an app for the nightly summary, no guess for PDF or chat commands', () => {
    expect(expectedPlaces(card('每晚总结'))).toEqual([{ kind: 'app', title: '作品' }]);
    expect(expectedPlaces(card('PDF 划词讲解'))).toEqual([]);
    expect(expectedPlaces(card('斜杠命令'))).toEqual([]);
  });
});

it('the UI half keeps exactly the app\'s shared modules as imports (COMMUNITY_SHARED_MODULES)', async () => {
  const source = await readFile(new URL('../../../../src/ui-kernel/community.ts', import.meta.url), 'utf8');
  const list = /COMMUNITY_SHARED_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source)![1]!;
  expect([...uiExternals]).toEqual([...list.matchAll(/'([^']+)'/g)].map(match => match[1]));
});

it('says in plain words what the plugin services are used for', () => {
  const host = [
    "ctx.pluginSchedule.daily('nightly', '22:00', run); ctx.pluginSchedule.every('sync', 30, run); ctx.pluginSchedule.onStartup('boot', run);",
    "ctx.studyData.notes.list({}); ctx.studyData.notes.create({}); ctx.studyData.cards.search('x'); ctx.pluginNotify.notify({});",
    "ctx.pluginSecrets.get('apiKey'); ctx.on('study/note-saved', fn); ctx.on('study/card-reviewed', fn);",
  ].join('\n');
  const ui = 'import { pluginFiles } from "@deepstudent/ui"; pluginFiles.pick({}); pluginFiles.readText(p);';
  const inject = ['studyData', 'pluginSchedule', 'pluginNotify', 'pluginSecrets'];
  const lines = declaredCapabilities({ id: 'workshop.plugin-x', permissions: inject.map(name => `service:${name}`) }, inject, detectUse({ host, ui }, inject));
  expect(lines).toEqual([
    '会读取和修改你的学习数据（笔记、卡片、题目、复习、待办、资料库）', '会发系统通知', '保存了你填的密钥（存进系统安全存储，只有这个插件能读）',
    '会按时自动运行（每天 22:00）', '会按时自动运行（每 30 分钟）', '会按时自动运行（每次启动应用时）', '会在你保存笔记、复习卡片时自动运行',
    '会让你选择文件', '能读取你选择的文件', '会修改你的笔记', '会读取你的笔记、卡片', '会读取你保存的密钥',
  ]);
});

describe('card secrets', () => {
  it('a proposal can ask for an API key as kind "secret" but never carries its value', () => {
    expect(proposalSettings([{ key: 'apiKey', title: 'DeepL 密钥', kind: 'secret', value: 'leak' }], []))
      .toEqual([{ key: 'apiKey', title: 'DeepL 密钥', kind: 'secret' }]);
    expect(() => proposalSettings([{ key: 'apiKey', title: '密钥', kind: 'text' }], [])).toThrow('credentials only as kind "secret"');
  });

  it('goes to the secure store; the card keeps only "saved"; never in config, manifest settings or net hosts', async () => {
    const settings = [{ key: 'apiKey', title: '密钥', kind: 'secret' as const }, { key: 'name', title: '名字', kind: 'text' as const }];
    const filled = fillSettings(settings, { apiKey: ' sk-123 ', name: '小明' });
    const store = vi.fn(async () => {});
    const kept = await storeSecretSettings('workshop.plugin-x', filled, store);
    expect(store).toHaveBeenCalledWith('workshop.plugin-x', 'apiKey', 'sk-123');
    expect(kept).toEqual([{ key: 'apiKey', title: '密钥', kind: 'secret', saved: true }, { key: 'name', title: '名字', kind: 'text', value: '小明' }]);
    expect(JSON.stringify(kept)).not.toContain('sk-123');
    expect(settingValues(kept)).toEqual({ name: '小明' });
    expect(manifestSettings(kept)).toEqual([{ key: 'name', title: '名字', kind: 'text' }]);
    expect(settingHosts(kept)).toEqual([]);
    // Retrying keeps the saved key without asking again; a missing one is still required.
    expect(fillSettings(kept, { name: '小明' })[0]).toEqual({ key: 'apiKey', title: '密钥', kind: 'secret', saved: true });
    expect(() => fillSettings(settings, { name: '小明' })).toThrow('WORKSHOP_SETTING_MISSING');
    await expect(storeSecretSettings('workshop.plugin-x', filled, null)).rejects.toThrow('no secure store');
  });
});
