import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopStore } from '../src/store.ts';

it('B5 preserves the last usable version through failed updates and repeated modification proposals', async () => {
  const store = new WorkshopStore(await mkdtemp(join(tmpdir(), 'dstu-version-pointer-')));
  const brief = { sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool' as const, changes: [], capabilities: [] };
  let card = await store.propose(brief);
  card = await store.write({ ...card, state: 'installed', version: '1.0.0', usableVersion: '1.0.0' } as typeof card);
  card = await store.propose({ ...brief, pluginId: card.pluginId });
  card = await store.write({ ...card, state: 'failed', version: '2.0.0' });
  card = await store.propose({ ...brief, pluginId: card.pluginId });
  expect(card.previousVersion).toBe('1.0.0');
  card = await store.write({ ...card, state: 'failed', version: null });
  card = await store.propose({ ...brief, pluginId: card.pluginId });
  expect(card.previousVersion).toBe('1.0.0');
});
