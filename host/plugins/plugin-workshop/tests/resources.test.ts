import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopStore } from '../src/store.ts';
import { developmentSkill, seedTemplate } from '../src/resources.ts';

it('reads a bounded skill and seeds both real source templates without overwriting files', async () => {
  expect(Buffer.byteLength(await developmentSkill())).toBeLessThanOrEqual(8192);
  const store = new WorkshopStore(await mkdtemp(join(tmpdir(), 'dstu-resources-')));
  for (const template of ['learning-tool', 'host-tool'] as const) {
    const card = await store.propose({ sessionId: 'test', title: 'Recall', description: 'Practice', template, changes: [], capabilities: [] });
    const source = join(store.directory(card.id), 'source');
    await seedTemplate(source, card);
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).deepStudent.id).toBe(card.pluginId);
    await expect(seedTemplate(source, card)).rejects.toThrow();
  }
});
