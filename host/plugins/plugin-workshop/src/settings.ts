// Values a workshop plugin needs from the user (WorkshopSetting), and the Host-side source normalisation that keeps
// the Agent from spending repair rounds on bookkeeping: the version bump of a modification and the `net:<host>`
// permission derived from an address the user entered.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkshopCard, WorkshopSetting } from '../api.ts';

/** Reads one address for the link check: HTTPS GET through the pinned public transport (see index.ts). */
export type WorkshopLinkReader = (url: string, signal: AbortSignal) => Promise<{ status: number; ok: boolean; text: string }>;
/** Saves one card secret in the system secure store (`pluginSecretSettingsKey(pluginId, key)`, see index.ts). */
export type WorkshopSecretStore = (pluginId: string, key: string, value: string) => Promise<void>;

/**
 * Move the secrets the user just typed into the secure store and drop their values from the settings that will be
 * written to the card (workshop.json). Without a store a secret cannot be kept, so it is refused instead of leaked.
 */
export async function storeSecretSettings(pluginId: string, settings: readonly WorkshopSetting[], store: WorkshopSecretStore | null): Promise<WorkshopSetting[]> {
  const result: WorkshopSetting[] = [];
  for (const setting of settings) {
    if (setting.kind !== 'secret' || setting.value === undefined) { result.push(setting); continue; }
    if (!store) throw new Error(`WORKSHOP_SETTING_INVALID: ${setting.key}: this Host has no secure store for 「${setting.title}」`);
    await store(pluginId, setting.key, setting.value);
    result.push({ key: setting.key, title: setting.title, kind: setting.kind, saved: true });
  }
  return result;
}

/** Why an address cannot be used by a plugin tool (same rules as the plugin tool `fetch`), or null. */
export function settingUrlProblem(raw: string): string | null {
  if (raw.length > 2048) return 'the address is too long';
  let url: URL;
  try { url = new URL(raw); } catch { return 'it is not a complete web address'; }
  if (url.protocol !== 'https:') return 'only https:// addresses are allowed';
  if (url.username !== '' || url.password !== '') return 'addresses with a user name or password are not allowed';
  if (url.port !== '') return 'addresses with an explicit port are not allowed';
  return null;
}

/**
 * The card's settings with the values the user entered on it (`values`, keyed by setting key; anything else is
 * ignored). Every setting must end up with a value, and an address must be usable.
 */
export function fillSettings(settings: readonly WorkshopSetting[], values: unknown): WorkshopSetting[] {
  const entered = values !== null && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {};
  return settings.map(setting => {
    const raw = entered[setting.key];
    if (setting.kind === 'secret') {
      // A key saved earlier stays saved unless the user types a new one; its value never comes back to the card.
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value && setting.saved) return { key: setting.key, title: setting.title, kind: setting.kind, saved: true };
      if (!value) throw new Error(`WORKSHOP_SETTING_MISSING: ${setting.key}: 「${setting.title}」 is required before making the plugin`);
      if (value.length > 4096) throw new Error(`WORKSHOP_SETTING_INVALID: ${setting.key}: value is too long`);
      return { key: setting.key, title: setting.title, kind: setting.kind, value };
    }
    const value = (typeof raw === 'string' && raw.trim() ? raw.trim() : setting.value ?? '').trim();
    if (!value) throw new Error(`WORKSHOP_SETTING_MISSING: ${setting.key}: 「${setting.title}」 is required before making the plugin`);
    if (value.length > 2048) throw new Error(`WORKSHOP_SETTING_INVALID: ${setting.key}: value is too long`);
    if (setting.kind === 'ics-url' || setting.kind === 'https-url') {
      const problem = settingUrlProblem(value);
      if (problem) throw new Error(`WORKSHOP_SETTING_INVALID: ${setting.key}: ${problem}`);
    }
    return { ...setting, value };
  });
}

/** Lower-case host names of the address settings, as the plugin must declare them (`net:<host>`). */
export function settingHosts(settings: readonly WorkshopSetting[] = []): string[] {
  const hosts = settings.filter(setting => (setting.kind === 'ics-url' || setting.kind === 'https-url') && setting.value)
    .map(setting => { try { return new URL(setting.value!).hostname; } catch { return ''; } }).filter(Boolean);
  return [...new Set(hosts)];
}

/** Plugin config written at installation: `{ [key]: value }`. Secrets never go into config (see WorkshopSetting). */
export function settingValues(settings: readonly WorkshopSetting[] = []): Record<string, string> | null {
  const entries = settings.filter(setting => setting.kind !== 'secret' && setting.value).map(setting => [setting.key, setting.value!] as const);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * One real read of every calendar address before the work is offered for installation: it must answer and be an
 * iCalendar document. A placeholder or a login page fails here instead of when the learner first uses the plugin.
 */
export async function checkSettingLinks(settings: readonly WorkshopSetting[] = [], read: WorkshopLinkReader | null, signal: AbortSignal): Promise<void> {
  for (const setting of settings) {
    if (setting.kind !== 'ics-url' || !setting.value) continue;
    if (!read) throw new Error('WORKSHOP_LINK: this Host cannot read web addresses, so the calendar address cannot be checked');
    let response: Awaited<ReturnType<WorkshopLinkReader>>;
    try { response = await read(setting.value, signal); }
    catch (error) { throw new Error(`WORKSHOP_LINK: 「${setting.title}」 could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new Error(`WORKSHOP_LINK: 「${setting.title}」 answered HTTP ${response.status}`);
    if (!/BEGIN:VCALENDAR/i.test(response.text.slice(0, 4096))) throw new Error(`WORKSHOP_LINK: 「${setting.title}」 is not a calendar (.ics): the response has no BEGIN:VCALENDAR`);
  }
}

function versionParts(version: unknown): [number, number, number] | null {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
/** a > b for plain x.y.z versions. */
export function versionGreater(a: unknown, b: unknown): boolean {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!;
  return false;
}
export function nextPatch(version: string): string {
  const parts = versionParts(version) ?? [1, 0, 0];
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

const MODULE_FILES = ['index.ts', 'index.tsx', 'ui.tsx', 'ui.ts'];

/**
 * The manifest's `deepStudent.settings`: what the card asked the user for, without the values. The kernel turns it into
 * the plugin's Schemastery `Config` (the sealed Host half cannot import Schemastery), so the plugin manager shows and
 * edits the same values in the plugin's detail. Keys are plain config names; credential-like keys never get here.
 */
export function manifestSettings(settings: readonly WorkshopSetting[] = []): { key: string; title: string; kind: WorkshopSetting['kind'] }[] {
  return settings.filter(setting => setting.kind !== 'secret').map(({ key, title, kind }) => ({ key, title, kind }));
}

/**
 * Before each build: a modification gets a version above the retained one (package.json and the modules' `meta`
 * together), a plugin with agent tools declares `net:<host>` for the addresses the user entered, and a work with
 * settings declares them (`deepStudent.settings`, see manifestSettings). All Host bookkeeping; the Agent need not get
 * them right. Missing or unparsable package.json is left to the compiler.
 */
export async function normalizeWorkshopSource(source: string, card: Pick<WorkshopCard, 'previousVersion' | 'settings'>): Promise<{ version?: string; added: string[] }> {
  const path = join(source, 'package.json');
  let pkg: { version?: unknown; deepStudent?: { permissions?: unknown; agentTools?: unknown; settings?: unknown } };
  try { pkg = JSON.parse(await readFile(path, 'utf8')); } catch { return { added: [] }; }
  if (!pkg || typeof pkg !== 'object') return { added: [] };
  let changed = false;
  const result: { version?: string; added: string[] } = { added: [] };
  const old = typeof pkg.version === 'string' ? pkg.version : undefined;
  if (card.previousVersion && !versionGreater(old, card.previousVersion)) {
    const next = nextPatch(card.previousVersion);
    pkg.version = next; changed = true; result.version = next;
    for (const file of MODULE_FILES) {
      const modulePath = join(source, file);
      let text: string;
      try { text = await readFile(modulePath, 'utf8'); } catch { continue; }
      const stale = new Set([old, card.previousVersion].filter((value): value is string => Boolean(value)));
      const rewritten = text.replace(/(\bversion\s*:\s*)(['"])([^'"\n]*)\2/g,
        (whole, prefix: string, quote: string, value: string) => stale.has(value) ? `${prefix}${quote}${next}${quote}` : whole);
      if (rewritten !== text) await writeFile(modulePath, rewritten, 'utf8');
    }
  }
  const tools = pkg.deepStudent?.agentTools;
  if (pkg.deepStudent && Array.isArray(tools) && tools.length > 0) {
    const declared = Array.isArray(pkg.deepStudent.permissions) ? pkg.deepStudent.permissions.filter((item): item is string => typeof item === 'string') : [];
    // A placeholder host copied from the recipe never reaches the card once the user's real address is known.
    const permissions = settingHosts(card.settings).length ? declared.filter(item => !/^net:(?:.+\.)?example\./.test(item)) : declared;
    if (permissions.length !== declared.length) changed = true;
    for (const host of settingHosts(card.settings)) {
      if (!permissions.includes(`net:${host}`)) { permissions.push(`net:${host}`); result.added.push(`net:${host}`); }
    }
    if (result.added.length) changed = true;
    if (changed) pkg.deepStudent.permissions = permissions;
  }
  if (pkg.deepStudent && typeof pkg.deepStudent === 'object') {
    const declared = manifestSettings(card.settings);
    const wanted = declared.length ? declared : undefined;
    if (JSON.stringify(pkg.deepStudent.settings) !== JSON.stringify(wanted)) {
      if (wanted) pkg.deepStudent.settings = wanted; else delete pkg.deepStudent.settings;
      changed = true;
    }
  }
  if (changed) await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return result;
}
