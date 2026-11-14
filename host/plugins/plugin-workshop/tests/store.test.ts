import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkshopStore } from '../src/store.ts';

describe('managed workshop storage', () => {
  it('reserves host-owned roots, persists and rejects arbitrary paths/foreign plugin edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dstu-workshop-test-'));
    const store = new WorkshopStore(root);
    const brief = { sessionId: 'test', title: 'Recall', description: 'Practice words', template: 'host-tool' as const, changes: [], capabilities: [] };
    expect(await store.list()).toEqual([]);
    const card = await store.propose(brief);
    expect(store.directory(card.id)).toBe(join(root, 'dstu-workshop', card.pluginId));
    expect(card.state).toBe('draft');
    await expect(new WorkshopStore(root).read(card.id)).resolves.toEqual(card);
    expect(() => store.directory('../plugins')).toThrow('WORKSHOP_INVALID');
    await expect(store.propose({ ...brief, pluginId: 'dstu.shell' })).rejects.toThrow('only managed');
    await store.update(card.id, 1, { state: 'generating' });
    await expect(store.update(card.id, 1, { state: 'installed' })).rejects.toThrow('WORKSHOP_CONFLICT');
    await store.recoverInterrupted();
    expect((await store.read(card.id)).state).toBe('failed');
    expect(JSON.parse(await readFile(join(store.directory(card.id), 'workshop.json'), 'utf8')).error).toContain('interrupted');
  });
});
