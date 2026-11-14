// RUST-FIX(RF-P3-workshop-compiler): Host-owned persistent draft roots.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkshopBrief, WorkshopCard } from '../api.ts';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class WorkshopStore {
  readonly root: string;
  constructor(appData: string) { this.root = join(appData, 'dstu-workshop'); }
  directory(id: string): string {
    if (!ID.test(id)) throw new Error('WORKSHOP_INVALID: invalid work id');
    return join(this.root, `workshop.plugin-${id}`);
  }
  async read(id: string): Promise<WorkshopCard> {
    try { return JSON.parse(await readFile(join(this.directory(id), 'workshop.json'), 'utf8')) as WorkshopCard; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`WORKSHOP_NOT_FOUND: ${id}`);
      throw error;
    }
  }
  async list(): Promise<WorkshopCard[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('workshop.plugin-')
      && ID.test(entry.name.slice('workshop.plugin-'.length))).map(entry => this.read(entry.name.slice('workshop.plugin-'.length))));
  }
  async write(card: WorkshopCard): Promise<WorkshopCard> {
    const target = join(this.directory(card.id), 'workshop.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
    await rename(temp, target);
    return card;
  }
  async propose(brief: WorkshopBrief): Promise<WorkshopCard> {
    if (!brief.sessionId || !brief.title?.trim() || !brief.description?.trim()
      || !['learning-tool', 'host-tool'].includes(brief.template)
      || !Array.isArray(brief.changes) || !brief.changes.every(item => typeof item === 'string')
      || !Array.isArray(brief.capabilities) || !brief.capabilities.every(item => typeof item === 'string')) {
      throw new Error('WORKSHOP_INVALID: title, description, session, template and string lists required');
    }
    // Editing binds to the existing managed identity; never overwrite another package.
    const existing = brief.pluginId === undefined ? undefined : (await this.list()).find(card => card.pluginId === brief.pluginId);
    if (brief.pluginId !== undefined && !existing) throw new Error('WORKSHOP_INVALID: only managed works can be edited (omit pluginId when creating a new plugin, or pass an existing workshop.plugin-... pluginId)');
    if (existing && existing.sessionId !== brief.sessionId) throw new Error('WORKSHOP_INVALID: work belongs to another conversation; user must bind the editing session first');
    if (existing && ['generating', 'pending-confirmation'].includes(existing.state)) throw new Error('WORKSHOP_STATE: existing work is busy');
    const id = existing?.id ?? randomUUID();
    for (const sub of ['source', 'build', 'versions', 'exports']) await mkdir(join(this.directory(id), sub), { recursive: true });
    const timestamp = new Date().toISOString();
    return this.write({ kind: 'dstu-plugin-workshop', id, pluginId: existing?.pluginId ?? `workshop.plugin-${id}`,
      sessionId: brief.sessionId, title: brief.title, description: brief.description, template: brief.template,
      changes: [...brief.changes], capabilities: [...brief.capabilities], state: 'draft', revision: (existing?.revision ?? 0) + 1,
      version: null, usableVersion: existing?.usableVersion ?? null,
      previousVersion: existing?.usableVersion ?? existing?.previousVersion ?? null, trust: 'full', source: 'workshop',
      lastGoodPackageDir: existing?.lastGoodPackageDir ?? null,
      lastFault: existing?.lastFault ?? null,
      risk: '完全信任插件与应用同进程运行，可访问应用能力；不是隔离沙箱。',
      check: null, error: null, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
  }
  async update(id: string, revision: number, patch: Partial<Pick<WorkshopCard,
    'state' | 'version' | 'previousVersion' | 'usableVersion' | 'lastGoodPackageDir' | 'buildAttempt' | 'lastFault' | 'sessionId' | 'check' | 'error' | 'rollback'>>): Promise<WorkshopCard> {
    const card = await this.read(id);
    if (revision !== card.revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale; refresh status');
    return this.write({ ...card, ...patch, revision: card.revision + 1, updatedAt: new Date().toISOString() });
  }
  async recoverInterrupted(): Promise<void> {
    for (const card of await this.list()) if (card.state === 'generating') {
      await this.update(card.id, card.revision, { state: 'failed', error: 'WORKSHOP_STATE: background generation interrupted by Host shutdown' });
    }
  }
}
