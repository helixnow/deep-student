import React from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { createFullDocumentApi } from '@/features/notes/fullDocument';
import { applyNoteTemplate, getNoteTemplates } from '@/features/notes/noteTemplates';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { normalizeMarkdown } from '@/components/crepe/normalizeMarkdown';
import { editorViewCtx, schemaCtx } from '@milkdown/kit/core';
import { useAIReview } from '@/features/notes/aiReview';
import { aiReviewSessionKey, storeAIReviewSession } from '@/features/notes/aiReviewModel';
import { createOfficialDiffAdapter } from '@/components/crepe/officialDiffAdapter';
import { calloutPlugin } from '@/components/crepe/plugins/callout';
import { togglePlugin } from '@/components/crepe/plugins/toggle';
import { wikilinkPlugin } from '@/components/crepe/plugins/wikilink';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), getContent: vi.fn(), update: vi.fn(), props: null as any,
  invoke: vi.fn(), rows: new Map<string, any>(),
}));
// The coordinated AI review persists its prepared intent through notes_state_*.
// jsdom has no Tauri IPC, so back it with an in-memory revision-checked store.
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/dstu', () => ({ dstu: {
  get: mocks.get, getContent: mocks.getContent, update: mocks.update,
  watch: () => () => {}, setMetadata: vi.fn(),
} }));
vi.mock('@/features/notes/markdownWindowSettings', () => ({ loadInitialLineWindowSetting: async () => 100 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({ useSystemStatusStore: { getState: () => ({ maintenanceMode: false }) } }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/features/notes/NotesCrepeEditor', () => ({ NotesCrepeEditor: (props: any) => { mocks.props = props; return null; } }));
vi.mock('@/features/notes/NotesContextPanel', () => ({ NotesContextPanel: () => null }));

import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';

const node = { id: 'review-a', sourceId: 'review-a', path: '/review-a', name: 'A', type: 'note' as const,
  createdAt: 1000, updatedAt: 2000, metadata: { tags: [] } };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const fixtures: Array<{ crepe: Crepe; root: HTMLElement }> = [];
const roots: HTMLElement[] = [];
// The hook suspends its official controls on unmount, so adapters must outlive
// the component tree and are destroyed after cleanup().
const adapters: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.clearAllMocks(); mocks.props = null; mocks.rows.clear();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
    if (typeof command !== 'string' || !command.startsWith('notes_state_')) return null;
    if (command === 'chat_v2_canvas_edit_result') return null;
    const r = args.request;
    if (command === 'notes_state_list') return [...mocks.rows.values()].filter((row) => row.note_id === r.note_id && !row.deleted);
    const old = mocks.rows.get(r.key);
    if (command === 'notes_state_get') return old ?? null;
    if (r.expected_revision !== (old?.revision ?? null)) throw new Error('notes.state_conflict');
    const row = { ...r, revision: (old?.revision ?? 0) + 1, deleted: command === 'notes_state_delete' };
    mocks.rows.set(r.key, structuredClone(row)); return row;
  });
  storeAIReviewSession(aiReviewSessionKey(node.id), null);
  mocks.get.mockResolvedValue(ok(node));
  mocks.getContent.mockResolvedValue(ok('original\n'));
  mocks.update.mockResolvedValue(ok({ ...node, updatedAt: 3000 }));
});
afterEach(async () => {
  cleanup();
  for (const destroy of adapters.splice(0)) await destroy();
  for (const root of roots.splice(0)) root.remove();
  for (const { crepe, root } of fixtures.splice(0)) { await crepe.destroy(); root.remove(); }
});

async function setup() {
    render(<NoteContentView node={node} isActive />);
    await waitFor(() => expect(mocks.props).not.toBeNull());
    const props = mocks.props;
    const root = document.createElement('div'); document.body.append(root);
    const crepe = new Crepe({ root, defaultValue: props.initialContent, features: {
      [CrepeFeature.CodeMirror]: false, [CrepeFeature.Latex]: false,
      [CrepeFeature.Toolbar]: false, [CrepeFeature.BlockEdit]: false,
      [CrepeFeature.LinkTooltip]: false,
    } });
    crepe.editor.use(calloutPlugin()).use(togglePlugin()).use(wikilinkPlugin({ getNotes: async () => [] }));
    fixtures.push({ crepe, root }); await crepe.create();
    let revision = 1;
    const view = crepe.editor.ctx.get(editorViewCtx);
    const dispatch = view.dispatch.bind(view);
    const dispatchSpy = vi.spyOn(view, 'dispatch').mockImplementation((transaction) => {
      if (transaction.docChanged) revision++;
      dispatch(transaction);
    });
    const setMarkdown = vi.fn((markdown: string) => { crepe.editor.action(replaceAll(markdown)); return true; });
    const retainFailure = vi.fn();
    const extended = props.extendEditorApi({
      getMarkdown: () => crepe.getMarkdown(),
      normalizeMarkdown: (markdown: string) => crepe.editor.action((ctx) => normalizeMarkdown(ctx, markdown)),
      setMarkdown,
      isReadonly: () => false,
      flushPendingSave: () => props.onSave(crepe.getMarkdown()),
    } as CrepeEditorApi);
    const api = createFullDocumentApi(extended, {
      noteId: node.id, isCurrent: () => true, revision: () => revision,
      isWindowed: () => mocks.props.windowingState.hasMore, retainFailure,
    });
    act(() => props.onEditorReady(api));
    return { api, crepe, setMarkdown, retainFailure, view, dispatchSpy };
}

describe('real Crepe full-document contract', () => {
  it.each(getNoteTemplates('zh-CN'))('applies the built-in $id template through the real Crepe serializer', async (template) => {
    const { api } = await setup();
    const baseline = api.getFullDocument();
    const candidate = applyNoteTemplate(baseline.markdown, template.markdown, { date: '2026/09/21', title: '测试' });
    // This is the product's actual built-in template, not malformed Markdown.
    let applied;
    await act(async () => { applied = await api.replaceFullDocument(candidate, baseline); });
    expect(applied).toEqual(api.getFullDocument());
    expect(api.getFullDocument().markdown).not.toBe(candidate);
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(api.getFullDocument().markdown);
  });

  it.each([
    '# title\n\n* a\n* **b**\n',
    '> [!note] Title\n> body\n\n> [!toggle]- Fold\n> hidden\n',
    '[[Other note|Label]]\n\n![1.00](notes_assets/test.png "title")\n',
    '| A | B |\n|---|---|\n| x | y |\n',
    '~~~js\nconst x = 1;\n~~~\n',
  ])('normalizes supported structured content without mutating the editor: %s', async (source) => {
    const { api, view, dispatchSpy } = await setup();
    const state = view.state;
    const canonical = api.normalizeMarkdown!(source);
    expect(view.state).toBe(state);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(api.normalizeMarkdown!(canonical)).toBe(canonical);
    await act(async () => {
      const applied = await api.replaceFullDocument(source, api.getFullDocument());
      expect(applied.markdown).toBe(canonical);
      expect(applied).toEqual(api.getFullDocument());
    });
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(canonical);
  });

  it('rejects schema nodes that silently drop content, before touching the live window or its tail', async () => {
    mocks.getContent.mockResolvedValue(ok(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')));
    const { api, crepe, setMarkdown, retainFailure } = await setup();
    act(() => { crepe.editor.action(replaceAll('UNSAVED window\n')); });
    const baseline = api.getFullDocument();
    const schema = crepe.editor.ctx.get(schemaCtx);
    const spec = schema.nodes.code_block.spec as any;
    const previous = spec.parseMarkdown;
    spec.parseMarkdown = { ...previous, runner: () => {} }; // schema accepts a node but swallows it
    const candidate = baseline.markdown + '\n\n```js\nDO NOT LOSE THIS\n```\n';
    try {
      await expect(api.replaceFullDocument(candidate, baseline)).rejects.toThrow('lose content');
    } finally { spec.parseMarkdown = previous; }
    expect(api.getFullDocument()).toEqual(baseline);
    expect(api.getFullDocument().markdown).toContain('line 999');
    expect(setMarkdown).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(retainFailure.mock.calls[0][0]).toBe(candidate);
    expect(retainFailure.mock.calls[0][2]).toBe(baseline.markdown);
  });

  it('rejects unsupported code metadata rather than silently stripping it', async () => {
    const { api, setMarkdown } = await setup();
    await expect(api.replaceFullDocument('```js keep-this-metadata\nx\n```', api.getFullDocument())).rejects.toThrow('lose content');
    expect(setMarkdown).not.toHaveBeenCalled();
  });

  it('a throwing parser cannot poison the live parser or the next replacement', async () => {
    const { api, crepe, setMarkdown, view } = await setup();
    const before = api.getFullDocument();
    const spec = crepe.editor.ctx.get(schemaCtx).nodes.code_block.spec as any;
    const previous = spec.parseMarkdown;
    spec.parseMarkdown = { ...previous, runner: () => { throw new Error('parser rejected node'); } };
    try {
      await expect(api.replaceFullDocument('```js\nx\n```', before)).rejects.toThrow('parser rejected node');
    } finally { spec.parseMarkdown = previous; }
    expect(api.getFullDocument()).toEqual(before);
    expect(crepe.editor.ctx.get(editorViewCtx)).toBe(view);
    expect(setMarkdown).not.toHaveBeenCalled();
    await act(async () => { await api.replaceFullDocument('## valid retry\n', before); });
    expect(api.getFullDocument().markdown).toBe('## valid retry\n');
  });

  it('restores the live unsaved prefix plus untouched tail when actual application differs from preflight', async () => {
    mocks.getContent.mockResolvedValue(ok(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n\n'));
    const { api, crepe, setMarkdown } = await setup();
    act(() => { crepe.editor.action(replaceAll('UNSAVED window\n')); });
    const baseline = api.getFullDocument();
    setMarkdown.mockImplementationOnce(() => { crepe.editor.action(replaceAll('truncated')); return true; });
    await act(async () => {
      await expect(api.replaceFullDocument('# Canonical candidate\n', baseline)).rejects.toThrow();
    });
    expect(api.getFullDocument().markdown).toBe(baseline.markdown);
    expect(api.getFullDocument().markdown).toContain('line 999\n\n');
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => api.flushPendingSave!());
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(baseline.markdown);
  });

  it('does not return a newer user revision as the applied baseline while persistence is pending', async () => {
    const { api, crepe } = await setup();
    let finish!: (value: ReturnType<typeof ok>) => void;
    mocks.update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const before = api.getFullDocument();
    let outcome!: Promise<unknown>;
    act(() => { outcome = api.replaceFullDocument('* item\n', before).catch(error => error); });
    act(() => { crepe.editor.action(replaceAll('NEWER USER DRAFT\n')); });
    await act(async () => { finish(ok({ ...node, updatedAt: 3000 })); await outcome; });
    expect(await outcome).toBeInstanceOf(Error);
    expect(api.getFullDocument().markdown).toBe('NEWER USER DRAFT\n');
  });

  it('rejects descriptive image alt text that Crepe image-block would overwrite with a size ratio', async () => {
    const { api, setMarkdown } = await setup();
    await expect(api.replaceFullDocument('![important description](notes_assets/test.png "caption")', api.getFullDocument())).rejects.toThrow('lose content');
    expect(setMarkdown).not.toHaveBeenCalled();
  });

  it.each([false, true])('AI accept / retry / checkpoint use actual canonical content (save failure: %s)', async (failSave) => {
    const { api, setMarkdown } = await setup();
    const original = api.getFullDocument();
    const candidate = applyNoteTemplate(original.markdown, getNoteTemplates('zh-CN')[0].markdown, { date: '2026/09/21' });
    const canonical = api.normalizeMarkdown!(candidate);
    const hook = renderHook(() => useAIReview({ noteId: node.id, editorApi: api }));
    act(() => window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: {
      requestId: 'real-review', noteId: node.id, operation: 'set', content: candidate,
    } })));
    // Accepting now commits through the official review controls, which the host
    // registers with onReviewReady. Without them handleAccept cannot apply the
    // candidate and leaves the session pending.
    const root = document.createElement('div'); document.body.append(root); roots.push(root);
    let adapter!: Awaited<ReturnType<typeof createOfficialDiffAdapter>>;
    await act(async () => {
      adapter = await createOfficialDiffAdapter({
        root, baseline: original.markdown, target: candidate,
        onDecision: (decision) => hook.result.current.officialReviewProps.onReviewDecision(decision),
        onError: (error) => hook.result.current.officialReviewProps.onReviewError(error),
      });
      hook.result.current.officialReviewProps.onReviewReady(adapter);
    });
    if (failSave) mocks.update.mockRejectedValueOnce(new Error('disk unavailable'));
    await act(async () => hook.result.current.handleAccept());
    if (failSave) {
      expect(hook.result.current.session?.retryBaseline).toEqual(api.getFullDocument());
      expect(hook.result.current.session?.retryBaseline?.markdown).toBe(canonical);
      expect(hook.result.current.session?.candidate).toBe(candidate);
      expect(hook.result.current.checkpoint).toBeNull();
      await act(async () => hook.result.current.handleAccept());
    }
    expect(setMarkdown).toHaveBeenCalledTimes(1);
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.checkpoint?.resultContent).toBe(canonical);
    expect(api.getFullDocument().markdown).toBe(canonical);
    await act(async () => hook.result.current.rollbackCheckpoint());
    expect(api.getFullDocument().markdown).toBe(original.markdown);
    expect(hook.result.current.checkpoint).toBeNull();
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(original.markdown);
    adapters.push(() => adapter.destroy());
  });
});
