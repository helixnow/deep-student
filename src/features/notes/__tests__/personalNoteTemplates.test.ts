import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, values } = vi.hoisted(() => ({ invoke: vi.fn(), values: new Map<string, string>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/utils/shared', () => ({ isTauriRuntime: true }));

import { getCourseDefaultTemplate, loadPersonalNoteTemplates, savePersonalNoteTemplate, PERSONAL_NOTE_TEMPLATES_KEY } from '../personalNoteTemplates';
import { applyNoteTemplate, replaceWithNoteTemplate, applyPreviewedNoteTemplate } from '../noteTemplates';

describe('personal template persistence', () => {
  beforeEach(() => {
    values.clear(); invoke.mockReset();
    invoke.mockImplementation(async (command: string, args: { key: string; value?: string }) => {
      if (command === 'get_setting') return values.get(args.key) ?? null;
      if (command === 'save_setting') { values.set(args.key, args.value!); return; }
      throw new Error(`Unexpected command ${command}`);
    });
  });

  it('saves through native settings, reloads, updates by ID, and retains another template', async () => {
    const [a, b] = await Promise.all([
      savePersonalNoteTemplate({ title: '课程', markdown: '# {{title}}\n\n原文  \n' }),
      savePersonalNoteTemplate({ title: '复习', markdown: '- [ ] 复习' }),
    ]);
    expect(await loadPersonalNoteTemplates()).toEqual([a, b]);
    const updated = await savePersonalNoteTemplate({ ...a, markdown: '新版' });
    expect(await loadPersonalNoteTemplates()).toEqual([updated, b]);
    expect(invoke).toHaveBeenCalledWith('save_setting', expect.objectContaining({ key: PERSONAL_NOTE_TEMPLATES_KEY }));
  });

  it('never replaces unreadable storage with an empty library', async () => {
    values.set(PERSONAL_NOTE_TEMPLATES_KEY, '{bad data');
    await expect(savePersonalNoteTemplate({ title: '新模板', markdown: '正文' })).rejects.toThrow();
    expect(values.get(PERSONAL_NOTE_TEMPLATES_KEY)).toBe('{bad data');
    expect(invoke.mock.calls.some(([command]) => command === 'save_setting')).toBe(false);
    invoke.mockRejectedValueOnce(new Error('read failed'));
    await expect(loadPersonalNoteTemplates()).rejects.toThrow('read failed');
  });

  it('reports native write failure and permits a subsequent retry', async () => {
    invoke.mockImplementationOnce(async () => null).mockRejectedValueOnce(new Error('disk full'));
    await expect(savePersonalNoteTemplate({ title: '课程', markdown: '保留输入' })).rejects.toThrow('disk full');
    expect(values.size).toBe(0);
    await savePersonalNoteTemplate({ title: '课程', markdown: '保留输入' });
    expect(await loadPersonalNoteTemplates()).toHaveLength(1);
  });

  it('rejects stale template editors after another panel updates the same template', async () => {
    const first = await savePersonalNoteTemplate({ title: '课程', markdown: '旧正文' });
    const updated = await savePersonalNoteTemplate({ ...first, markdown: '另一面板新正文', expectedRevision: first.revision });
    await expect(savePersonalNoteTemplate({ ...first, markdown: '过时草稿', expectedRevision: first.revision })).rejects.toThrow('模板已被修改');
    expect(await loadPersonalNoteTemplates()).toEqual([updated]);
  });

  it('adds course defaults and typed presets without migrating old templates; assigning a new default keeps both', async () => {
    const old = await savePersonalNoteTemplate({ title: '旧模板', markdown: '正文' });
    const first = await savePersonalNoteTemplate({ title: '数学模板', markdown: '数学', defaultForCourse: ' 数学 ',
      learningPreset: { course: '数学', mastery: 'learning', reviewDate: '2026-09-25' } });
    expect(getCourseDefaultTemplate(await loadPersonalNoteTemplates(), '数学')).toEqual(first);
    const second = await savePersonalNoteTemplate({ title: '新数学模板', markdown: '新版', defaultForCourse: '数学', learningPreset: { chapter: '导数' } });
    const stored = await loadPersonalNoteTemplates();
    expect(stored[0]).toEqual(old);
    expect(stored[1].defaultForCourse).toBeUndefined();
    expect(stored[1].learningPreset).toEqual(first.learningPreset);
    expect(getCourseDefaultTemplate(stored, '数学')).toEqual(second);
    await savePersonalNoteTemplate({ id: second.id, title: second.title, markdown: '改正文' });
    expect(getCourseDefaultTemplate(await loadPersonalNoteTemplates(), '数学')?.learningPreset).toEqual({ chapter: '导数' });
    await expect(savePersonalNoteTemplate({ title: '非法', markdown: '正文', learningPreset: { reviewDate: '2026-02-29' } })).rejects.toThrow('预设无效');
    expect(await loadPersonalNoteTemplates()).toHaveLength(3);
  });
});

describe('template application protection', () => {
  it('inserts at the captured selection, appends exact preview bytes, rejects stale modes and failed saves', async () => {
    const baseline = { noteId: 'note_a', revision: 5, markdown: 'original  \n' };
    const position = { from: 3, to: 3 };
    const host = { getDocument: () => baseline, replaceDocument: vi.fn().mockResolvedValue(true), insertDocument: vi.fn().mockResolvedValue(true) };
    await applyPreviewedNoteTemplate(host, baseline, '{{title}} preview', 'insert', position);
    expect(host.insertDocument).toHaveBeenCalledWith('{{title}} preview', baseline, position);
    await applyPreviewedNoteTemplate(host, baseline, '{{title}} preview', 'append');
    expect(host.replaceDocument).toHaveBeenCalledWith('original  \n\n---\n\n{{title}} preview\n', baseline);
    await applyPreviewedNoteTemplate(host, baseline, 'replacement', 'replace');
    expect(host.replaceDocument).toHaveBeenLastCalledWith('replacement\n', baseline);
    for (const mode of ['insert', 'append', 'replace'] as const) {
      await expect(applyPreviewedNoteTemplate({ ...host, getDocument: () => ({ ...baseline, noteId: 'note_b' }) }, baseline, 'body', mode, position)).rejects.toThrow();
    }
    host.insertDocument.mockResolvedValueOnce(false);
    await expect(applyPreviewedNoteTemplate(host, baseline, 'body', 'insert', position)).rejects.toThrow();
    host.replaceDocument.mockRejectedValueOnce(new Error('disk full'));
    await expect(applyPreviewedNoteTemplate(host, baseline, 'body', 'append')).rejects.toThrow('disk full');
  });
  it('preserves the exact original prefix on append and treats empty templates as a no-op', () => {
    const original = '# 原文\n\n有两个尾空格  \n{{date}}';
    expect(applyNoteTemplate(original, '# 模板')).toBe(`${original}\n\n---\n\n# 模板\n`);
    expect(applyNoteTemplate(original, '')).toBe(original);
    expect(applyNoteTemplate(original, '# 新文', {}, 'replace')).toBe('# 新文\n');
  });

  it('rejects a stale or switched document without invoking replacement', async () => {
    const baseline = { noteId: 'a', revision: 1, markdown: '未保存原文' };
    const replaceDocument = vi.fn().mockResolvedValue(true);
    const host = { getDocument: () => ({ ...baseline, revision: 2 }), replaceDocument };
    await expect(replaceWithNoteTemplate(host, baseline, '模板')).rejects.toThrow('笔记已变化');
    await expect(replaceWithNoteTemplate({ ...host, getDocument: () => ({ ...baseline, noteId: 'b' }) }, baseline, '模板')).rejects.toThrow();
    expect(replaceDocument).not.toHaveBeenCalled();
    await replaceWithNoteTemplate({ ...host, getDocument: () => baseline }, baseline, '模板');
    expect(replaceDocument).toHaveBeenCalledWith('模板', baseline);
  });
});
