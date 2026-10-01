import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { diffPluginKey } from '@milkdown/kit/plugin/diff';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { createOfficialDiffAdapter, normalizeOfficialDiffDoc } from '../officialDiffAdapter';
import { createUploadLifecycle } from '../uploadLifecycle';
import type { EditorView } from '@milkdown/prose/view';
import type { OfficialReviewDecision } from '@/features/notes/officialDiffContract';

beforeAll(async () => { await i18next.init({ lng: 'zh-CN', resources: {} }); });
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
async function setup(baseline: string, target: string, commit?: (decision: OfficialReviewDecision) => Promise<void>) {
  const root = document.createElement('div'); document.body.append(root);
  const decisions: OfficialReviewDecision[] = [];
  const errors: unknown[] = [];
  const adapter = await createOfficialDiffAdapter({ root, baseline, target,
    onDecision: async decision => { await commit?.(decision); decisions.push(decision); },
    onError: error => errors.push(error),
  });
  disposers.push(async () => { await adapter.destroy(); root.remove(); });
  const buttons = (action: 'accept' | 'reject') => Array.from(root.querySelectorAll<HTMLButtonElement>(`.milkdown-diff-${action}`));
  const click = async (action: 'accept' | 'reject', index = 0) => { buttons(action)[index].click(); await adapter.whenIdle(); };
  const expectDoc = (markdown: string) => {
    adapter.view.state.doc.check();
    expect(adapter.view.state.doc.eq(adapter.parse(markdown))).toBe(true);
    expect(adapter.parse(adapter.crepe.getMarkdown()).eq(adapter.parse(markdown))).toBe(true);
  };
  return { ...adapter, root, decisions, errors, buttons, click, expectDoc };
}

describe('production official diff adapter with real Crepe and component controls', () => {
  it('rejects a pure deletion then accepts another group without deleting rejected content', async () => {
    const f = await setup('Keep.\n\nRemove.\n\nAnchor.\n\nOld.', 'Keep.\n\nAnchor.\n\nNew.');
    expect(f.buttons('reject')).toHaveLength(2);
    await f.click('reject');
    expect(f.pending()).toHaveLength(1);
    expect(f.decisions[0].action).toBe('reject');
    await f.acceptAll();
    f.expectDoc('Keep.\n\nRemove.\n\nAnchor.\n\nNew.');
    expect(f.pending()).toHaveLength(0);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });
  it('rejects the only deletion and releases the official lock', async () => {
    const f = await setup('Keep.\n\nDelete.\n\nEnd.', 'Keep.\n\nEnd.');
    await f.click('reject');
    f.expectDoc('Keep.\n\nDelete.\n\nEnd.');
    expect(f.pending()).toHaveLength(0);
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
  });
  it('confirms a group only after the host save, and retains remaining groups', async () => {
    let release!: () => void;
    const commit = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const f = await setup('Old.\n\nAnchor.\n\nCold.', 'New.\n\nAnchor.\n\nWarm.', commit);
    const before = f.view.state.doc;
    f.buttons('accept')[0].click();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(f.view.state.doc).toBe(before);
    expect(f.buttons('accept').every(button => button.disabled)).toBe(true);
    release(); await f.whenIdle();
    f.expectDoc('New.\n\nAnchor.\n\nCold.');
    expect(f.buttons('reject')).toHaveLength(1);
  });
  it('keeps the official group pending after an external-update/OCC failure', async () => {
    const commit = vi.fn(async () => { throw new Error('baseline changed'); });
    const f = await setup('Old.', 'New.', commit);
    await expect(f.click('accept')).rejects.toThrow('baseline changed');
    f.expectDoc('Old.');
    expect(f.buttons('accept')).toHaveLength(1);
    expect(f.errors).toHaveLength(1);
  });
  it('merges only the table block and leaves an independent prose decision', async () => {
    const oldTable = '| A | B |\n| - | - |\n| old | cold |';
    const newTable = '| A | B |\n| - | - |\n| fresh | warm |';
    const f = await setup(`${oldTable}\n\nAnchor.\n\nOld.`, `${newTable}\n\nAnchor.\n\nNew.`);
    expect(f.pending()).toHaveLength(3);
    expect(f.buttons('accept')).toHaveLength(2);
    await f.click('accept');
    f.expectDoc(`${newTable}\n\nAnchor.\n\nOld.`);
    await f.click('reject');
    f.expectDoc(`${newTable}\n\nAnchor.\n\nOld.`);
  });
  it('shows toggle/callout titles and preserves nested table, math, attrs on accept', async () => {
    const before = '> [!toggle]- Old title\n>\n> > [!note] Inner old\n> >\n> > | A | B |\n> > | - | - |\n> > | old | $x^2$ |';
    const after = '> [!toggle] New title\n>\n> > [!tip] Inner new\n> >\n> > | A | B |\n> > | - | - |\n> > | fresh | $x^3$ |';
    const f = await setup(`${before}\n\nAnchor.\n\nOld.`, `${after}\n\nAnchor.\n\nNew.`);
    expect(f.root.querySelector('.milkdown-diff-added [data-type="toggle"]')?.textContent).toContain('New title');
    expect(f.root.querySelector('.milkdown-diff-added [data-type="callout"]')?.textContent).toContain('Inner new');
    expect(f.buttons('accept')).toHaveLength(2);
    await f.click('accept');
    f.expectDoc(`${after}\n\nAnchor.\n\nOld.`);
    await f.click('reject');
    f.expectDoc(`${after}\n\nAnchor.\n\nOld.`);
  });
  it('normalizes untitled image caption during baseline/candidate parsing and reload', async () => {
    const f = await setup('![](notes_assets/upload.png)\n\nOld.', '![](notes_assets/upload.png)\n\nNew.');
    expect(f.view.state.doc.firstChild?.attrs.caption).toBe('');
    await f.acceptAll();
    f.expectDoc('![](notes_assets/upload.png)\n\nNew.');
    const reloaded = f.parse(f.crepe.getMarkdown());
    reloaded.check(); expect(reloaded.firstChild?.attrs.caption).toBe('');
  });
  it('suspend clears only the private diff; reopening uses the persisted remaining target', async () => {
    const f = await setup('Old.\n\nAnchor.\n\nCold.', 'New.\n\nAnchor.\n\nWarm.');
    await f.click('reject');
    const decision = f.decisions[0];
    f.suspend();
    expect(diffPluginKey.getState(f.view.state)).toBeNull();
    const reopened = await setup(decision.after, decision.target);
    expect(reopened.buttons('accept')).toHaveLength(1);
    await reopened.acceptAll();
    reopened.expectDoc('Old.\n\nAnchor.\n\nWarm.');
  });
  it('preserves live upload completion, clears its anchor, and rejects stale review after external change', async () => {
    const bodyRoot = document.createElement('div'); document.body.append(bodyRoot);
    let view: EditorView | null = null, finish!: (url: string) => void;
    const upload = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const uploads = createUploadLifecycle({ getView: () => view, isCurrent: () => true, container: bodyRoot, validate: async () => {}, upload });
    const body = new Crepe({ root: bodyRoot, defaultValue: 'Old.', features: { [CrepeFeature.AI]: false, [CrepeFeature.Toolbar]: false } });
    body.editor.config(ctx => ctx.update(uploadConfig.key, value => ({ ...value, uploadWidgetFactory: uploads.widgetFactory })));
    await body.create(); view = body.editor.ctx.get(editorViewCtx);
    disposers.push(async () => { uploads.dispose(); await body.destroy(); bodyRoot.remove(); });
    const baseline = body.getMarkdown();
    uploads.start([{ name: 'pending.png', read: async () => new File(['x'], 'pending.png', { type: 'image/png' }) }], { pos: 0 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const release = uploads.acquireReviewLease();
    expect(view.dom.inert).toBe(true);
    expect(view.editable).toBe(true); // completion is still allowed; only interaction is leased
    const f = await setup(baseline, 'New.', async () => { if (body.getMarkdown() !== baseline) throw new Error('baseline changed'); });
    expect(uploads.start([{ name: 'blocked.png', read: async () => null }], { pos: 0 })).toBeNull();
    finish('notes_assets/pending.png');
    await vi.waitFor(() => expect(bodyRoot.querySelector('[role="status"]')).toBeNull());
    expect(view.state.doc.firstChild?.attrs.src).toBe('notes_assets/pending.png');
    const uploadPlugin = view.state.plugins.find(p => (p as unknown as { key: string }).key.startsWith('MILKDOWN_UPLOAD$'))!;
    expect(uploadPlugin.getState(view.state).find()).toHaveLength(0);
    normalizeOfficialDiffDoc(body.editor.ctx.get(parserCtx)(body.getMarkdown())!).check();
    await expect(f.click('accept')).rejects.toThrow('baseline changed');
    expect(view.state.doc.firstChild?.attrs.src).toBe('notes_assets/pending.png');
    f.suspend(); release();
    expect(view.dom.inert).not.toBe(true);
    expect(uploads.start([{ name: 'resumed.png', read: async () => null }], { pos: 0 })).not.toBeNull();
  });
});
