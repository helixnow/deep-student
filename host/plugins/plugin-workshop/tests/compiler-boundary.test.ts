import { mkdtemp, writeFile, mkdir, symlink, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopStore } from '../src/store.ts';
import { seedTemplate } from '../src/resources.ts';
import { compileWorkshop } from '../src/compiler.ts';

for (const target of ['host', 'ui'] as const) for (const escape of ['absolute', 'relative', 'symlink', 'tsconfig', 'tsconfig-extends'] as const) {
  it(`B1 rejects ${target} ${escape} compiler inputs outside the real source root`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-compiler-boundary-'));
    const store = new WorkshopStore(dataDir);
    const card = await store.propose({ sessionId: 'test', title: 'Test', description: 'Test', template: 'learning-tool', changes: [], capabilities: [] });
    const source = join(store.directory(card.id), 'source');
    await seedTemplate(source, card);
    const outside = join(store.directory(card.id), 'outside.json');
    await writeFile(outside, '{"secret":"OUTSIDE_MUST_NOT_BE_BUNDLED"}');
    let specifier = escape === 'absolute' ? outside : '../outside.json';
    if (escape === 'symlink') {
      await symlink(outside, join(source, 'linked.json')); specifier = './linked.json';
    }
    if (escape === 'tsconfig') {
      await writeFile(join(source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { './aliased': ['../outside.json'], aliased: ['../outside.json'] } } }));
      specifier = target === 'host' ? './aliased' : 'aliased';
    }
    if (escape === 'tsconfig-extends') {
      await writeFile(join(store.directory(card.id), 'outside-tsconfig.json'), '{"compilerOptions":{"jsxFactory":"OUTSIDE_MUST_NOT_BE_BUNDLED"}}');
      await writeFile(join(source, 'tsconfig.json'), '{"extends":"../outside-tsconfig.json"}');
      specifier = './local.json'; await writeFile(join(source, 'local.json'), '{}');
    }
    const entry = join(source, target === 'host' ? 'index.ts' : 'ui.tsx');
    await writeFile(entry, `import value from ${JSON.stringify(specifier)}; export default value;`);
    const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId,
      { dataDir, version: '0.20.0', platform: 'darwin', debug: true });
    expect(built.check.compile, built.check.errors.join('\n')).toBe('failed');
    expect(built.check.errors.join('\n')).toMatch(/WORKSHOP_INVALID|Unsupported shared UI module/);
    // No rejected external content can reach a complete installable candidate.
    await expect(readFile(join(built.directory, 'package.json'))).rejects.toThrow();
  });
}

it('B1 still bundles relative source modules and preserves the four UI externals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-compiler-local-')), store = new WorkshopStore(dataDir);
  const card = await store.propose({ sessionId: 'test', title: 'Test', description: 'Test', template: 'learning-tool', changes: [], capabilities: [] });
  const source = join(store.directory(card.id), 'source'); await seedTemplate(source, card);
  await mkdir(join(source, 'local'));
  await writeFile(join(source, 'local/value.ts'), 'export const value = 42;');
  await writeFile(join(source, 'ui.tsx'), 'import React from "react"; import ReactDOM from "react-dom"; import * as sdk from "@deepstudent/ui"; import i18next from "i18next"; import {value} from "./local/value"; export default {React,ReactDOM,sdk,i18next,value};');
  const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId,
    { dataDir, version: '0.20.0', platform: 'darwin', debug: true });
  expect(built.check.compile, built.check.errors.join('\n')).toBe('passed');
});

it('B1 rejects a replaced source root symlink before reading the foreign package', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-compiler-root-link-')), store = new WorkshopStore(dataDir);
  const card = await store.propose({ sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] });
  const source = join(store.directory(card.id), 'source'); await seedTemplate(source, card);
  const foreign = join(dataDir, 'foreign');
  await rename(source, foreign); await symlink(foreign, source);
  const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId,
    { dataDir, version: '0.20.0', platform: 'darwin', debug: true });
  expect(built.check.compile).toBe('failed');
  expect(built.check.errors.join('\n')).toContain('WORKSHOP_INVALID');
});
