import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { seedTemplate } from '../src/resources.ts';
import { compileWorkshop } from '../src/compiler.ts';
import type { WorkshopCard } from '../api.ts';

it('the shipped learning template resolves its UI relative to the compiled Host entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dstu-template-ui-'));
  const source = join(root, 'source');
  const id = 'workshop.template-ui';
  await seedTemplate(source, { pluginId: id, template: 'learning-tool' } as WorkshopCard);
  const result = await compileWorkshop(source, join(root, 'build'), id, { dataDir: root, version: '0.20.0', platform: 'darwin', debug: true });
  expect(result.check.compile, result.check.errors.join('\n')).toBe('passed');
  const hostFile = resolve(result.directory, result.manifest!.host!);
  const plugin = createRequire(import.meta.url)(hostFile).default;
  const uiFile = resolve(dirname(hostFile), plugin.meta.ui);
  expect(uiFile).toBe(resolve(result.directory, result.manifest!.ui!));
  await access(uiFile);
});
