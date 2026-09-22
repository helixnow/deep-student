import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIReviewSession } from './aiReviewModel';
const native = vi.hoisted(() => ({ rows: new Map<string, any>(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/i18n', () => ({ default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } }));
const db = async (command: string, { request: r }: any) => {
  const id = `${r.note_id}/${r.key}`;
  if (command === 'notes_state_list') return [...native.rows.values()].filter(row => row.note_id === r.note_id && !row.deleted);
  if (command === 'notes_state_get') return native.rows.get(id) ?? null;
  const previous = native.rows.get(id);
  if (r.expected_revision !== (previous?.revision ?? null)) throw new Error('notes.state_conflict');
  const row = { note_id: r.note_id, key: r.key, type: r.type, value: r.value ?? null,
    revision: (previous?.revision ?? 0) + 1, deleted: command === 'notes_state_delete' };
  native.rows.set(id, structuredClone(row));
  return row;
};
beforeEach(() => { vi.resetModules(); native.rows.clear(); native.invoke.mockReset().mockImplementation(db); });
async function modules() { return { model: await import('./aiReviewModel'), store: await import('./aiReviewPersistence') }; }
async function seed(windowId = 'old-window', noteId = 'n1') {
  const { model, store } = await modules();
  const baseline = { noteId, revision: 2, markdown: 'Accepted.\n\nAnchor.\n\nPending.\n' };
  const request = { requestId: `r-${windowId}`, noteId, operation: 'set' as const, content: 'Accepted.\n\nAnchor.\n\nProposed.\n', targetWindowId: windowId };
  const session = model.createAIReviewSession(request, baseline, request.content);
  session.persistenceId = store.newAIReviewPersistenceId();
  session.origin = { ...baseline, revision: 1, markdown: baseline.markdown.replace('Accepted', 'Old') };
  session.decisions = [{ action: 'accept', before: session.origin.markdown, after: baseline.markdown, target: request.content, remaining: 1 }];
  session.accepted = [{ id: 'checkpoint', noteId, originalContent: session.origin.markdown, resultContent: baseline.markdown,
    appliedAt: 1, operation: 'set', diffLines: [] }];
  session.collapsed = true;
  await store.persistAIReviewSession(session, windowId);
  return session;
}
describe('AI review dedicated state table CAS and restart', () => {
  it('persists candidate, withdrawn target, decisions, accepted checkpoint and collapse across restart', async () => {
    const saved = await seed();
    vi.resetModules(); const { store } = await modules();
    const restored = (await store.loadPersistedAIReview('n1', 'new-window')).session!;
    expect(restored.candidate).toBe(saved.candidate);
    expect(restored.target).toBe(saved.target);
    expect(restored.decisions).toEqual(saved.decisions);
    expect(restored.accepted).toEqual(saved.accepted);
    expect(restored.baseline).toEqual(saved.baseline);
    expect(restored.origin).toEqual(saved.origin);
    expect(restored.collapsed).toBe(true);
    expect(restored.restored).toBe(true);
    expect(restored.request.targetWindowId).toBeUndefined();
    expect(native.invoke.mock.calls.every(([command]) => command.startsWith('notes_state_'))).toBe(true);
  });
  it('allowlists runtime requests and does not persist callbacks', async () => {
    const saved = await seed(); const { store } = await modules();
    Object.assign(saved.request, { onSettled: () => {}, onLocalDisposition: () => {}, secretRuntime: 'excluded' });
    await store.persistAIReviewSession(saved);
    const row = [...native.rows.values()][0];
    expect(row.value.session.request).not.toHaveProperty('onSettled');
    expect(row.value.session.request).not.toHaveProperty('secretRuntime');
    expect(row.value.session.request).not.toHaveProperty('targetWindowId');
  });
  it('concurrent writers for distinct candidate keys cannot lose each other through an index', async () => {
    await Promise.all([seed('one'), seed('two')]);
    vi.resetModules(); const { store } = await modules();
    const result = await store.loadPersistedAIReview('n1', 'new-window');
    expect(result.session).toBeNull(); expect(result.options).toHaveLength(2);
    const chosen = await store.loadPersistedAIReview('n1', 'new-window', result.options[0].id);
    expect(chosen.session?.persistenceId).toBe(result.options[0].id);
  });
  it('two renderer modules claiming the same revision cannot overwrite the winning decision', async () => {
    await seed();
    vi.resetModules(); const first = await modules();
    const a = (await first.store.loadPersistedAIReview('n1', 'a')).session!;
    vi.resetModules(); const second = await modules();
    const b = (await second.store.loadPersistedAIReview('n1', 'b')).session!;
    a.collapsed = false; await first.store.persistAIReviewSession(a, 'a');
    await expect(second.store.persistAIReviewSession(b, 'b')).rejects.toThrow('notes.state_conflict');
    expect([...native.rows.values()][0].value.windowId).toBe('a');
    expect([...native.rows.values()][0].value.session.collapsed).toBe(false);
  });
  it('serializes same-key decisions using the returned revision, without serializing other keys', async () => {
    const saved = await seed(); const { store } = await modules();
    await Promise.all([store.persistAIReviewSession({ ...saved, collapsed: false }), store.persistAIReviewSession({ ...saved, collapsed: true })]);
    const row = [...native.rows.values()][0];
    expect(row.revision).toBe(3); expect(row.value.session.collapsed).toBe(true);
  });
  it('terminal CAS survives failed deletion and cannot resurrect the candidate', async () => {
    const saved = await seed(); const { store } = await modules();
    native.invoke.mockImplementation(async (command, args) => { if (command === 'notes_state_delete') throw new Error('IO'); return db(command, args); });
    await expect(store.removePersistedAIReview({ ...saved, resolution: 'discarded' })).rejects.toThrow('IO');
    vi.resetModules(); const restarted = await modules();
    expect((await restarted.store.loadPersistedAIReview('n1', 'new')).session).toBeNull();
    native.invoke.mockImplementation(db);
    await store.removePersistedAIReview({ ...saved, resolution: 'discarded' });
    expect([...native.rows.values()][0].deleted).toBe(true);
  });
  it('read/write failure retains the record and allows explicit retry', async () => {
    const saved = await seed(); const { store } = await modules();
    const before = structuredClone([...native.rows.values()]);
    native.invoke.mockRejectedValueOnce(new Error('IO'));
    await expect(store.persistAIReviewSession({ ...saved, collapsed: false })).rejects.toThrow('IO');
    expect([...native.rows.values()]).toEqual(before);
    await store.persistAIReviewSession({ ...saved, collapsed: false });
    expect([...native.rows.values()][0].value.session.collapsed).toBe(false);
  });
  it('retains a prepared applied intent for recovery after the body committed before state confirmation', async () => {
    const saved = await seed(); const { store } = await modules();
    saved.retryDecision = { action: 'accept', before: saved.baseline.markdown, after: saved.target, target: saved.target, remaining: 0 };
    await store.persistAIReviewSession(saved);
    vi.resetModules(); const restarted = await modules();
    const session = (await restarted.store.loadPersistedAIReview('n1', 'new')).session!;
    expect(session.retryDecision).toEqual(saved.retryDecision);
    expect(session.baseline.markdown).toBe(saved.baseline.markdown);
  });
  it('leaves wrong-note/corrupt records untouched', async () => {
    await seed();
    const row = [...native.rows.values()][0]; row.value.session.baseline.noteId = 'other';
    vi.resetModules(); const { store } = await modules(); native.invoke.mockClear();
    await expect(store.loadPersistedAIReview('n1', 'new')).rejects.toThrow('原数据未改动');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit scope and landing data without comparing serialized content', async () => {
    const saved: AIReviewSession = await seed(); const { store } = await modules();
    saved.request.scope = { kind: 'selection', from: 0, to: 3, baseline: saved.origin }; saved.request.landing = 'insert-below';
    await store.persistAIReviewSession(saved);
    vi.resetModules(); const restarted = await modules();
    const session = (await restarted.store.loadPersistedAIReview('n1', 'new')).session!;
    expect(session.request.scope).toEqual(saved.request.scope); expect(session.request.landing).toBe('insert-below');
  });
});
