import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostPlugin } from '../../../kernel/api.ts';
import { projectConfigSchema } from '../../../kernel/config-schema.ts';

export type ApiCategory = 'sdk' | 'services' | 'slots' | 'config' | 'theme' | 'examples' | 'resources';
export interface ApiEntry { id: string; category: ApiCategory; summary: string; }
export class WorkshopCatalog {
  readonly root: string;
  readonly plugins: () => readonly HostPlugin<any>[];
  constructor(plugins: () => readonly HostPlugin<any>[], root = fileURLToPath(new URL('../../../../', import.meta.url))) {
    this.plugins = plugins; this.root = root;
  }
  async files(): Promise<Map<string, { category: ApiCategory; file: string }>> {
    const entries = new Map<string, { category: ApiCategory; file: string }>();
    const add = (category: ApiCategory, file: string) => entries.set(`${category}:${file}`, { category, file });
    add('sdk', 'src/ui-sdk/index.ts');
    add('sdk', 'host/kernel/api.ts');
    add('sdk', 'host/kernel/core.ts');
    add('theme', 'src/styles/shadcn-variables.css');
    add('resources', 'resources/dstu-workshop/skills/dstu-plugin-development/SKILL.md');
    const explainer = 'resources/dstu-workshop/skills/interactive-explainer';
    add('resources', `${explainer}/SKILL.md`);
    for (const name of ['chart', 'explore', 'host-question', 'manipulate', 'practice', 'runtime', 'simulation', 'static-diagrams', 'stepper']) {
      add('resources', `${explainer}/references/${name}.md`);
    }
    for (const name of await readdir(join(this.root, 'src/ui-kernel/contracts'))) if (name.endsWith('.ts')) add('slots', `src/ui-kernel/contracts/${name}`);
    for (const template of ['learning-tool', 'host-tool']) {
      const dir = `resources/dstu-workshop/templates/${template}`;
      for (const name of await readdir(join(this.root, dir))) add('examples', `${dir}/${name}`);
    }
    return entries;
  }
  async list(category?: ApiCategory): Promise<{ entries: ApiEntry[] }> {
    const entries: ApiEntry[] = [{ id: 'sdk:version', category: 'sdk', summary: 'Running application and manifest SDK version' }];
    for (const [id, item] of await this.files()) entries.push({ id, category: item.category, summary: item.file });
    for (const plugin of this.plugins()) {
      entries.push({ id: `services:${plugin.meta.id}`, category: 'services', summary: plugin.meta.id });
      if (plugin.Config) entries.push({ id: `config:${plugin.meta.id}`, category: 'config', summary: plugin.meta.id });
    }
    return { entries: category === undefined ? entries : entries.filter(entry => entry.category === category) };
  }
  async read(id: string, version: string): Promise<{ id: string; content: unknown }> {
    if (id === 'sdk:version') return { id, content: { appVersion: version, manifestVersion: 1, uiSdk: '@deepstudent/ui' } };
    const resource = (await this.files()).get(id);
    if (resource) return { id, content: await readFile(join(this.root, resource.file), 'utf8') };
    const plugin = this.plugins().find(item => id === `services:${item.meta.id}` || id === `config:${item.meta.id}`);
    if (plugin) return { id, content: id.startsWith('config:') ? projectConfigSchema(plugin.Config) : {
      id: plugin.meta.id, services: plugin.meta.provides ?? [], remote: plugin.meta.remote ?? {},
      inject: plugin.inject ?? [], version: plugin.meta.version ?? null,
    } };
    throw new Error(`WORKSHOP_INVALID: unknown API resource ${id}`);
  }
}
