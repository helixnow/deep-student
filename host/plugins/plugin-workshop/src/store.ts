// RUST-FIX(RF-P3-workshop-compiler): Host-owned persistent draft roots.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkshopBrief, WorkshopCard, WorkshopInstallation, WorkshopPlace, WorkshopSetting } from '../api.ts';
import { recipeFor } from './resources.ts';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
/** Config never carries credentials (host/kernel/plugin-config.ts): such keys are refused here already. */
const CREDENTIAL_LIKE = /key|secret|token|password|passwd|credential/i;

/**
 * The values a proposal asks the user for (WorkshopSetting). At most four, plain config keys, no credentials.
 * A modification keeps the value the user entered last time for the same key unless the Agent supplied a new one.
 */
export function proposalSettings(raw: unknown, previous: readonly WorkshopSetting[] = []): WorkshopSetting[] {
  if (raw === undefined || raw === null) return previous.map(item => ({ ...item }));
  if (!Array.isArray(raw) || raw.length > 4) throw new Error('WORKSHOP_INVALID: settings must be a list of at most 4 entries');
  const seen = new Set<string>();
  return raw.map(entry => {
    const item = entry as Partial<WorkshopSetting> | null;
    const key = typeof item?.key === 'string' ? item.key.trim() : '';
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    const secret = item?.kind === 'secret';
    // Credentials are welcome only as kind "secret": their value goes to the secure store, never to config.
    if (!SETTING_KEY.test(key) || (!secret && CREDENTIAL_LIKE.test(key)) || seen.has(key)) throw new Error(`WORKSHOP_INVALID: setting key "${key}" must be a unique plain config name (credentials only as kind "secret")`);
    if (!title || title.length > 60) throw new Error(`WORKSHOP_INVALID: setting "${key}" needs a short title`);
    if (item?.kind !== 'ics-url' && item?.kind !== 'https-url' && item?.kind !== 'text' && item?.kind !== 'secret') throw new Error(`WORKSHOP_INVALID: setting "${key}" kind must be ics-url, https-url, text or secret`);
    if (secret) {
      // The Agent never supplies a secret's value; the user types it on the card.
      seen.add(key);
      const saved = previous.some(old => old.key === key && old.kind === 'secret' && old.saved);
      return { key, title, kind: item.kind, ...(saved ? { saved: true } : {}) };
    }
    if (item.value !== undefined && (typeof item.value !== 'string' || item.value.length > 2048)) throw new Error(`WORKSHOP_INVALID: setting "${key}" value must be a string`);
    seen.add(key);
    const value = item.value?.trim() || previous.find(old => old.key === key && old.kind === item.kind)?.value;
    return { key, title, kind: item.kind, ...(value ? { value } : {}) };
  });
}

/**
 * A conversation may act on a work only if the user bound it there: the one that created it, or any the user
 * later opened from the manager (`bindSession`). Rebinding to a new conversation does not lock the earlier ones out,
 * so continuing in the original chat after a modification still works; an unrelated conversation still cannot.
 */
export function ownsSession(card: Pick<WorkshopCard, 'sessionId' | 'boundSessions'>, sessionId: string): boolean {
  return Boolean(sessionId) && (card.sessionId === sessionId || (card.boundSessions ?? []).includes(sessionId));
}
/** Every conversation bound so far, the previous current one included; the new current one is `sessionId`. */
export function withBoundSession(card: Pick<WorkshopCard, 'sessionId' | 'boundSessions'>, sessionId: string): string[] {
  return [...new Set([...(card.boundSessions ?? []), card.sessionId].filter(id => id && id !== sessionId))];
}
/**
 * Where a proposal will probably show up, by the same rules that pick its recipe (recipeFor). A Host-only tool has no
 * phrase until it is built, so it has no expected place (the card hides the line instead of guessing).
 */
const SELECTION_WORDS = /选中|选区|工具栏|按钮|selection|toolbar/i;
export function expectedPlaces(brief: Pick<WorkshopCard, 'template' | 'title' | 'description' | 'changes'>): WorkshopPlace[] {
  if (brief.template !== 'learning-tool') return [];
  // recipeFor falls back to the selection recipe for any learning tool that does not read like a reference app; only
  // a proposal that actually asks for a selection button (the rule recipeFor checks first) is expected there.
  const text = [brief.title, brief.description, ...(brief.changes ?? [])].join(' ');
  const recipe = recipeFor(brief);
  // A PDF selection button or a chat command has no place kind the card can name yet: hide the line, never guess.
  if (recipe === 'pdf-selection' || recipe === 'chat-command') return [];
  return recipe === 'selection-model' && SELECTION_WORDS.test(text) ? [{ kind: 'selectionButton' }] : [{ kind: 'app', title: brief.title }];
}

/**
 * Records written before the installed version was tracked apart from the proposal (`installation`) get it derived
 * once from what they did record: the state, the last version seen running and the last fault.
 */
export function migrateCard(card: WorkshopCard): WorkshopCard {
  if (card.installation !== undefined) return card;
  return { ...card, installation: legacyInstallation(card) };
}
/**
 * The installed version as the workshop acts on it. The latest step wins when it was itself an install or an
 * uninstall (`state` installed / revoked); otherwise the recorded installation, or the legacy derivation.
 */
export function installationOf(card: WorkshopCard): WorkshopInstallation | null {
  const recorded = card.installation ?? null;
  if (card.state === 'installed' && card.version) {
    return { previousVersion: recorded?.version !== card.version ? recorded?.version ?? null : recorded?.previousVersion ?? null,
      ...(recorded?.version === card.version ? recorded : {}), state: 'installed', version: card.version };
  }
  if (card.state === 'revoked') {
    const version = recorded?.version ?? card.usableVersion ?? card.version;
    return version ? { ...recorded, state: 'revoked', version } : null;
  }
  return recorded ?? legacyInstallation(card);
}
/** A proposal still waiting for the user or being made (not closed, not an install). */
export const OPEN_PROPOSAL_STATES: readonly WorkshopCard['state'][] = ['draft', 'generating', 'pending-confirmation'];
function legacyInstallation(card: WorkshopCard): WorkshopInstallation | null {
  const previous = card.previousVersion && card.previousVersion !== card.version ? card.previousVersion : null;
  if (card.state === 'installed' && card.version) return { state: 'installed', version: card.version, previousVersion: previous };
  if (card.state === 'revoked') {
    const version = card.usableVersion ?? card.version;
    return version ? { state: 'revoked', version, previousVersion: previous } : null;
  }
  const usable = card.usableVersion ?? null;
  if (!usable && !card.lastGoodPackageDir) return null;
  const version = usable ?? card.version;
  if (!version) return null;
  // A fault isolated the running version (reportFault records the same text in both fields).
  const isolated = card.state === 'failed' && Boolean(card.lastFault) && card.error?.startsWith(card.lastFault!) === true;
  return { state: isolated ? 'failed' : 'installed', version, previousVersion: null };
}

export class WorkshopStore {
  readonly root: string;
  constructor(appData: string) { this.root = join(appData, 'dstu-workshop'); }
  directory(id: string): string {
    if (!ID.test(id)) throw new Error('WORKSHOP_INVALID: invalid work id');
    return join(this.root, `workshop.plugin-${id}`);
  }
  async read(id: string): Promise<WorkshopCard> {
    try { return migrateCard(JSON.parse(await readFile(join(this.directory(id), 'workshop.json'), 'utf8')) as WorkshopCard); }
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
    // Windows refuses to replace a file another handle is reading (a status poll): retry briefly instead of failing.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, target); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
      }
    }
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
    const settings = proposalSettings(brief.settings, existing?.settings);
    if (brief.pluginId !== undefined && !existing) throw new Error('WORKSHOP_INVALID: only managed works can be edited (omit pluginId when creating a new plugin, or pass an existing workshop.plugin-... pluginId)');
    if (existing && !ownsSession(existing, brief.sessionId)) throw new Error('WORKSHOP_INVALID: work belongs to another conversation; user must bind the editing session first');
    if (existing && ['generating', 'pending-confirmation'].includes(existing.state)) throw new Error('WORKSHOP_STATE: existing work is busy');
    const id = existing?.id ?? randomUUID();
    for (const sub of ['source', 'build', 'versions', 'exports']) await mkdir(join(this.directory(id), sub), { recursive: true });
    const timestamp = new Date().toISOString();
    const revision = (existing?.revision ?? 0) + 1;
    return this.write({ kind: 'dstu-plugin-workshop', id, pluginId: existing?.pluginId ?? `workshop.plugin-${id}`,
      sessionId: brief.sessionId, ...(existing ? { boundSessions: withBoundSession(existing, brief.sessionId) } : {}),
      ...(existing?.places ? { places: existing.places } : {}), expectedPlaces: expectedPlaces(brief), title: brief.title, description: brief.description, template: brief.template,
      changes: [...brief.changes], capabilities: [...brief.capabilities], ...(settings.length ? { settings } : {}),
      generationApproved: false, agentEditing: null, state: 'draft', revision, proposalRevision: revision,
      installation: existing?.installation ?? null,
      version: null, usableVersion: existing?.usableVersion ?? null,
      previousVersion: existing?.usableVersion ?? existing?.previousVersion ?? null, trust: 'full', source: 'workshop',
      lastGoodPackageDir: existing?.lastGoodPackageDir ?? null,
      lastFault: existing?.lastFault ?? null,
      risk: '完全信任插件与应用同进程运行，可访问应用能力；不是隔离沙箱。',
      check: null, error: null, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
  }
  async update(id: string, revision: number, patch: Partial<Pick<WorkshopCard,
    'state' | 'version' | 'previousVersion' | 'usableVersion' | 'lastGoodPackageDir' | 'buildAttempt' | 'buildStage' | 'buildFiles' | 'buildStep'
    | 'settings' | 'generationApproved' | 'agentEditing' | 'lastFault' | 'sessionId' | 'boundSessions' | 'check' | 'error' | 'rollback' | 'declared' | 'places'
    | 'installation'>>): Promise<WorkshopCard> {
    const card = await this.read(id);
    if (revision !== card.revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale; refresh status');
    return this.write({ ...card, ...patch, revision: card.revision + 1, updatedAt: new Date().toISOString() });
  }
  /**
   * Background progress of a generating work. It does not bump the revision: the revision binds what the user
   * confirms or cancels, and a progress tick must not make the card they are looking at stale.
   * Callers hold the work's serial lock.
   */
  async progress(id: string, patch: Partial<Pick<WorkshopCard, 'buildAttempt' | 'buildStage' | 'buildFiles' | 'buildStep' | 'check' | 'error'>>): Promise<WorkshopCard> {
    const card = await this.read(id);
    if (card.state !== 'generating') return card;
    return this.write({ ...card, ...patch, updatedAt: new Date().toISOString() });
  }
  async recoverInterrupted(): Promise<void> {
    for (const card of await this.list()) if (card.state === 'generating') {
      await this.update(card.id, card.revision, { state: 'failed', error: 'WORKSHOP_STATE: background generation interrupted by Host shutdown' });
    }
  }
}
