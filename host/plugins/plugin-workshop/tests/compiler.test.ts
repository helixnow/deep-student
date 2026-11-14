import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkshopStore } from '../src/store.ts';
import { seedTemplate, developmentSkill } from '../src/resources.ts';
import { compileWorkshop, checkWorkshopLifecycle } from '../src/compiler.ts';
import type { AppInfo } from '../../../kernel/api.ts';

describe('shipped workshop templates and built-in compiler', () => {
  for (const template of ['learning-tool', 'host-tool'] as const) it(`RF-P3-workshop-compiler: builds and really loads/unloads ${template}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-build-'));
    const store = new WorkshopStore(dataDir);
    const card = await store.propose({ sessionId: 'test', title: 'Recall', description: 'Recall a word', template, changes: [], capabilities: [] });
    const source = join(store.directory(card.id), 'source');
    await seedTemplate(source, card);
    const app = { version: '0.20.0', dataDir, debug: true } as AppInfo;
    const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app, {
      displayName: card.title,
      description: card.description,
    });
    const check = await checkWorkshopLifecycle(built, app);
    expect(check, check.errors.join('\n')).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed', visual: 'not-verified' });
    const pkg = JSON.parse(await readFile(join(built.directory, 'package.json'), 'utf8'));
    expect(pkg.deepStudent.host).toBe('./dist/host.js');
    expect(pkg.deepStudent.displayName).toBe('Recall');
    expect(pkg.deepStudent.description).toBe('Recall a word');
    expect(built.manifest?.displayName).toBe('Recall');
    expect(built.manifest?.description).toBe('Recall a word');
    if (template === 'learning-tool') {
      const ui = await readFile(join(built.directory, 'dist/ui.js'), 'utf8');
      expect(ui).toContain('from "react"');
      expect(ui).toContain('from "@deepstudent/ui"');
      expect(ui).not.toContain('node_modules/react');
    }
    await writeFile(join(source, 'index.ts'), 'export default = invalid');
    expect((await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app)).check.errors.length).toBeGreaterThan(0);
    expect(await readFile(join(built.directory, 'dist/host.js'), 'utf8')).toContain(card.pluginId);
  });
  it('ships a small progressively disclosed skill', async () => {
    const text = await developmentSkill();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(text).toContain('dstu_plugin_api_list');
  });
});
