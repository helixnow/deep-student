import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import type { FullDocumentSearchApi } from './fullDocument';
import { createMarkdownWindow, composeWindowedSave } from './markdownWindow';
import { aiReviewSessionKey, readAIReviewSession, storeAIReviewSession } from './aiReviewModel';
import { clearPendingNotesQuoteTargetsForTests, publishNotesQuoteTarget } from './quoteTarget';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), get: vi.fn(), metadata: vi.fn(), copy: vi.fn(async () => true), export: vi.fn(async () => ({ canceled: false, path: '/test.md' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/features/notes/NotesContext', () => ({ useNotesOptional: () => undefined }));
vi.mock('@/hooks/useTauriDragAndDrop', () => ({ useTauriDragAndDrop: () => ({ isDragging: false }) }));
vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({ GenerativeUIPanel: () => null }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/utils/fileManager', () => ({ fileManager: { saveTextFile: mocks.export } }));
vi.mock('@/dstu', () => ({ dstu: { get: mocks.get, setMetadata: mocks.metadata, watch: () => () => {}, list: async () => ({ ok: true, value: [] }) },
  updatedAtToVersionToken: (value: number) => new Date(value).toISOString() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/i18n', async () => ({ default: (await import('../../../tests/ct/mocks/react-i18next')).i18n }));
import { NotesCrepeEditor } from './NotesCrepeEditor';
import i18n from '@/i18n';

let api: FullDocumentSearchApi | null = null;
const onReady = (value: unknown) => { api = value as FullDocumentSearchApi | null; };
const format = (noteId: string) => ({ note_id: noteId, content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1', required_capabilities: [], updated_at: '2026-09-22T00:00:00.000Z' });
const node = (props: Record<string, unknown> = {}) => ({ id: 'note_host', type: 'note', path: '/note_host', name: 'Host', updatedAt: Date.UTC(2026, 8, 22), metadata: { props } });
beforeEach(() => {
  api = null; vi.clearAllMocks(); storeAIReviewSession(aiReviewSessionKey('note_host'), null);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'notes_get_format') return format(args.noteId);
    if (command === 'notes_state_list') return [];
    if (command === 'notes_state_put') return { ...args.request, revision: 1, deleted: false };
    if (command === 'notes_state_delete') return { ...args.request, revision: 2, deleted: true };
    return null;
  });
  mocks.get.mockResolvedValue({ ok: true, value: node() });
  mocks.metadata.mockResolvedValue({ ok: true, value: null });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(768);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1024, 768));
  vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: /min-width|prefers-reduced-motion/.test(query), media: query,
    onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
});
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); });
async function mount(markdown: string, onSave = vi.fn(async (_text: string) => {})) {
  const result = render(<NotesCrepeEditor noteId="note_host" initialContent={markdown} initialTitle="Host" onEditorReady={onReady} onSave={onSave} />);
  await waitFor(() => expect(api?.getCrepe()).toBeTruthy(), { timeout: 4000 });
  return { ...result, onSave };
}
function select(text: string) {
  const view = api!.getCrepe()!.editor.ctx.get(editorViewCtx);
  let from = -1;
  view.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text); });
  expect(from).toBeGreaterThanOrEqual(0);
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length))));
}
/** 模板库对话框：预置一个个人模板，打开后选中它（打开即捕获文档基线与插入点） */
async function openPersonalTemplate(markdown: string, learningPreset?: Record<string, string>) {
  localStorage.setItem('notes.personalTemplates.v1', JSON.stringify([{ id: 'personal:it', title: 'IT template', summary: '', markdown, revision: 1, ...(learningPreset ? { learningPreset } : {}) }]));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:toolbar.page_actions', 'More note actions') }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:toolbar.note_templates', 'Note templates') }));
  fireEvent.click(await screen.findByRole('button', { name: 'IT template' }));
  expect(screen.queryAllByRole('alert').map(el => el.textContent)).toEqual([]);
}
async function previewTemplate(text: string) {
  await openPersonalTemplate(text);
  await screen.findByRole('button', { name: '插入当前位置' });
}
describe('real Notes host entrances', () => {
  it('inserts at the remembered selection after preview inputs take focus and persists the full document', async () => {
    const h = await mount('# Keep\n\n😀 before target after\n\n## Tail\n\nUntouched\n');
    select('target');
    const original = api!.getFullDocument().markdown;
    await previewTemplate('replacement');
    fireEvent.click(screen.getByRole('button', { name: '插入当前位置' }));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    expect(api!.getFullDocument().markdown).toBe(original.replace('target', 'replacement'));
    expect(h.onSave).toHaveBeenLastCalledWith(original.replace('target', 'replacement'));
  });

  it('recomputes candidates from the actual selection for selection/block/section and leaves untouched text intact', async () => {
    await mount('# Keep\n\nIntro\n\n## Part\n\nleft target right\n\n### Child\n\nChild body\n\n## Tail\n\nTail body\n');
    select('target');
    const original = api!.getFullDocument().markdown;
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: {
      requestId: 'scope-ui', noteId: 'note_host', operation: 'set', content: 'CHANGED',
    } })));
    const scope = await screen.findByRole('combobox', { name: 'AI 编辑范围' });
    fireEvent.change(scope, { target: { value: 'selection' } });
    await waitFor(() => expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).toBe(original.replace('target', 'CHANGED')));
    fireEvent.change(scope, { target: { value: 'block' } });
    await waitFor(() => expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).toContain('## Part\n\nCHANGED'));
    expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).toContain('### Child');
    fireEvent.change(scope, { target: { value: 'section' } });
    await waitFor(() => expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).not.toContain('Child body'));
    expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).toContain('# Keep\n\nIntro');
    expect(readAIReviewSession(aiReviewSessionKey('note_host'))?.candidate).toContain('## Tail\n\nTail body');
    expect(api!.getFullDocument().markdown).toBe(original);
  });

  it('fills preset fields without replacing existing user props and sends their fresh CAS token', async () => {
    mocks.get.mockResolvedValue({ ok: true, value: node({ study_course: 'User course', custom: 'keep' }) });
    await mount('target\n'); select('target');
    await openPersonalTemplate('template', { course: 'Preset course', chapter: 'New chapter' });
    // 应用模板时自动只填入未设置的学习属性
    fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:personalTemplates.append') }));
    await waitFor(() => expect(mocks.metadata).toHaveBeenCalledWith('/note_host', { props: { study_course: 'User course', custom: 'keep', study_chapter: 'New chapter' } }, '2026-09-22T00:00:00.000Z'));
  });

  it('does not mount Crepe for future formats and copies/exports the complete original bytes', async () => {
    const raw = '<!-- ds:future-v99 -->\n\n:::unknown payload\nTAIL\n';
    mocks.invoke.mockImplementation(async (command, args) => command === 'notes_get_format'
      ? { ...format(args.noteId), serializer_version: 'markdown-v99' }
      : command === 'notes_history_current' ? { content_md: raw, title: 'Future', updated_at: 'token' } : null);
    const save = vi.fn();
    const h = render(<NotesCrepeEditor noteId="note_host" initialContent="prefix only" onEditorReady={onReady} onSave={save} />);
    expect(await screen.findByLabelText('完整笔记原文')).toHaveTextContent('TAIL');
    expect(h.container.querySelector('.ProseMirror')).toBeNull(); expect(api).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '复制完整原文' }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(raw));
    fireEvent.click(screen.getByRole('button', { name: '导出原文' }));
    await waitFor(() => expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ content: raw })));
    h.unmount(); expect(save).not.toHaveBeenCalled();
  });
});

describe('knowledge-base quote target', () => {
  afterEach(clearPendingNotesQuoteTargetsForTests);
  const scrolledTo = (text: string) => vi.mocked(Element.prototype.scrollIntoView).mock.contexts
    .find(el => (el as HTMLElement).textContent?.trim() === text) as HTMLElement | undefined;

  it('scrolls to and flashes the block a retrieval chunk starts in, leaving the selection alone', async () => {
    const paragraph = '若存在非零向量 x 使 Ax = λx，则称 λ 为特征值。';
    await mount(`# 线性代数\n\n## 特征值\n\n${paragraph}\n\n1. 求特征多项式\n2. 解特征方程\n\n## 二次型\n\n可以通过正交变换化为标准形。\n`);
    const view = api!.getCrepe()!.editor.ctx.get(editorViewCtx);
    const selection = view.state.selection.from;
    act(() => publishNotesQuoteTarget({ noteId: 'note_host', quote: '向量 x 使 Ax = λx，则称 λ 为特征值。\n1. 求特征多项式\n2. 解特征方程\n## 二次型' }));
    await waitFor(() => expect(scrolledTo(paragraph)).toBeTruthy());
    expect(scrolledTo(paragraph)!.classList.contains('crepe-heading-locate-flash')).toBe(true);
    expect(view.state.selection.from).toBe(selection);
  });

  it('consumes a target published before the editor mounts', async () => {
    publishNotesQuoteTarget({ noteId: 'note_host', quote: '可以通过正交变换化为标准形。' });
    await mount('# 线性代数\n\n第一段\n\n可以通过正交变换化为标准形。\n');
    await waitFor(() => expect(scrolledTo('可以通过正交变换化为标准形。')).toBeTruthy());
  });
});
