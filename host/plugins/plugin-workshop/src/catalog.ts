import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostPlugin } from '../../../kernel/api.ts';
import { projectConfigSchema } from '../../../kernel/config-schema.ts';
import { KERNEL_ONLY_SERVICES } from '../../../kernel/kernel.ts';
import { allWorkshopRecipes } from './resources.ts';
import { ServiceDocs } from './service-docs.ts';

/** Kernel-owned services and the workshop itself: not something a plugin can use (see checkPluginModule). */
const HIDDEN_SERVICES = new Set([...KERNEL_ONLY_SERVICES, 'pluginWorkshop']);

export type ApiCategory = 'sdk' | 'services' | 'slots' | 'config' | 'theme' | 'examples' | 'resources';
export interface ApiEntry { id: string; category: ApiCategory; summary: string; }
export class WorkshopCatalog {
  readonly root: string;
  readonly plugins: () => readonly HostPlugin<any>[];
  /** Whether a service is provided right now (platform services are not in any plugin's meta.provides). */
  readonly live: (service: string) => boolean;
  private readonly docs: ServiceDocs;
  constructor(plugins: () => readonly HostPlugin<any>[], root = fileURLToPath(new URL('../../../../', import.meta.url)),
    live: (service: string) => boolean = () => false) {
    this.plugins = plugins; this.root = root; this.live = live; this.docs = new ServiceDocs(root);
  }
  /** Live, documented services a plugin can inject: name → providing plugin id (`platform` for core services). */
  private async services(): Promise<Map<string, string>> {
    const declared = await this.docs.declarations();
    const live = new Map<string, string>();
    for (const plugin of this.plugins()) for (const name of plugin.meta.provides ?? []) if (declared.has(name)) live.set(name, plugin.meta.id);
    for (const name of declared.keys()) if (!live.has(name) && this.live(name)) live.set(name, 'platform');
    for (const name of HIDDEN_SERVICES) live.delete(name);
    return live;
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
    // Recipes beyond the seed templates: a new Agent tool, a selection-toolbar button that asks the model, a reference app.
    for (const recipe of allWorkshopRecipes) {
      const dir = `resources/dstu-workshop/recipes/${recipe}`;
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
    // One entry per live service, with its type and first doc sentence; api_read gives the real method signatures.
    const declared = await this.docs.declarations();
    for (const [name, provider] of [...await this.services()].sort(([a], [b]) => a.localeCompare(b))) {
      const declaration = declared.get(name)!;
      entries.push({ id: `service:${name}`, category: 'services',
        summary: `ctx.${name}: ${declaration.typeExpr} (${provider})${declaration.doc ? ` — ${declaration.doc}` : ''}` });
    }
    return { entries: category === undefined ? entries : entries.filter(entry => entry.category === category) };
  }
  async read(id: string, version: string): Promise<{ id: string; content: unknown }> {
    if (id === 'sdk:version') return { id, content: { appVersion: version, manifestVersion: 1, uiSdk: '@deepstudent/ui' } };
    const resource = (await this.files()).get(id);
    if (resource) return { id, content: await readFile(join(this.root, resource.file), 'utf8') };
    if (id.startsWith('service:')) {
      const name = id.slice('service:'.length);
      const provider = (await this.services()).get(name);
      const doc = provider ? await this.docs.read(name) : null;
      if (provider && doc) return { id, content: { ...doc, provider,
        use: { inject: [name], permission: `service:${name}`, call: `ctx.${name}.<member>(…)`, note: 'Signatures are read from the app api.ts types; validation never calls live methods.' } } };
    }
    const plugin = this.plugins().find(item => id === `services:${item.meta.id}` || id === `config:${item.meta.id}`);
    if (plugin) {
      if (id.startsWith('config:')) return { id, content: projectConfigSchema(plugin.Config) };
      const api: Record<string, unknown> = {};
      for (const name of plugin.meta.provides ?? []) {
        if (HIDDEN_SERVICES.has(name)) continue;
        const doc = await this.docs.read(name);
        if (doc) api[name] = { type: doc.type, source: doc.source, members: doc.members, readMore: `service:${name}` };
      }
      return { id, content: {
        id: plugin.meta.id, services: plugin.meta.provides ?? [], remote: plugin.meta.remote ?? {},
        inject: plugin.inject ?? [], version: plugin.meta.version ?? null, ...(Object.keys(api).length ? { api } : {}),
      } };
    }
    throw new Error(`WORKSHOP_INVALID: unknown API resource ${id}`);
  }
}
