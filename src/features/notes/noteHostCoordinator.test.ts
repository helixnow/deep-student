import { describe, expect, it, vi } from 'vitest';
import { NoteHostCoordinator, type NoteHostParticipant } from './noteHostCoordinator';
import type { FullDocumentSearchApi } from './fullDocument';
function participant(id: string, markdown: string, dirty = true): NoteHostParticipant {
  return { id, noteId: 'note', api: { getFullDocument: () => ({ noteId: 'note', markdown, revision: 1 }) } as FullDocumentSearchApi,
    dirty: () => dirty, lock: vi.fn(() => vi.fn()), settle: vi.fn(async () => {}), flush: vi.fn(async () => {}),
    invalidate: vi.fn(), refresh: vi.fn(async () => {}),
  };
}
describe('multi-instance note operations', () => {
  it('refuses divergent drafts before any flush and releases all interaction locks', async () => {
    const host = new NoteHostCoordinator();
    const a = participant('a', 'draft A'), b = participant('b', 'draft B');
    host.register(a); host.register(b);
    await expect(host.withLockedNotes(['note'], () => host.flushPendingSaves(['note']))).rejects.toThrow('不同的未保存草稿');
    expect(a.flush).not.toHaveBeenCalled(); expect(b.flush).not.toHaveBeenCalled();
    expect(vi.mocked(a.lock).mock.results[0].value).toHaveBeenCalledOnce();
    expect(vi.mocked(b.lock).mock.results[0].value).toHaveBeenCalledOnce();
  });
  it('settles existing saves first and flushes identical drafts once, then refreshes siblings', async () => {
    const host = new NoteHostCoordinator(); const order: string[] = [];
    const a = participant('a', 'same'), b = participant('b', 'same');
    a.settle = async () => { order.push('settle-a'); }; b.settle = async () => { order.push('settle-b'); };
    a.flush = async () => { order.push('flush'); }; b.refresh = async () => { order.push('refresh'); };
    host.register(a); host.register(b);
    await host.withLockedNotes(['note'], () => host.flushPendingSaves(['note']));
    expect(order).toEqual(['settle-a', 'settle-b', 'flush', 'refresh']);
    expect(b.flush).not.toHaveBeenCalled(); expect(b.invalidate).toHaveBeenCalledOnce();
  });
  it('retains invalidation on refresh failure and locks instances mounted during a commit', async () => {
    const host = new NoteHostCoordinator(); const a = participant('a', 'same', false), b = participant('b', 'same', false);
    host.register(a); b.refresh = vi.fn(async () => { throw new Error('disk unavailable'); });
    await expect(host.withLockedNotes(['note'], async () => {
      host.register(b); host.invalidateNotes(['note']); await host.refreshNotes(['note']);
    })).rejects.toThrow('disk unavailable');
    expect(b.lock).toHaveBeenCalledOnce(); expect(b.invalidate).toHaveBeenCalled();
    expect(vi.mocked(b.lock).mock.results[0].value).toHaveBeenCalledOnce();
  });
  it('rejects an unsupported cross-WebView operation before freezing or flushing', async () => {
    const host = new NoteHostCoordinator(async () => { throw new Error('cross-WebView'); });
    const a = participant('a', 'draft'); host.register(a);
    await expect(host.withLockedNotes(['note'], () => host.flushPendingSaves(['note']))).rejects.toThrow('cross-WebView');
    expect(a.lock).not.toHaveBeenCalled(); expect(a.flush).not.toHaveBeenCalled();
  });
});
