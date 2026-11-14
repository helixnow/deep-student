/**
 * FE-A1 layer 1 & FE-A3 slot snapshot utilities:
 * - FE-A1 (`captureSlotSnapshot`, `captureRegistries`, `diffSlotSnapshots`, …): every slot the kernel knows about,
 *   every entry with id/key/order/owner/origin, a deterministic projection of its value, and the visibility the
 *   official consumers derive in one scenario of the platform × mode × shell × UI Lab matrix.
 * - FE-A3 (`slotSnapshot`, `kernelSnapshot`, `chatLegacyRegistries`, `removedSlotEntries`, …): structural slot
 *   inventory plus kernel-owned chat registry entries used by FE-A3 evidence and full-stack pairing tests.
 */
import type { TFunction } from 'i18next';
import type { UiAdapters, UiKernel } from '../../ui-kernel/kernel';
import type { LegacyRegistries } from '../../ui-kernel/legacy-adapters';
import type { SlotEntry } from '../../ui-kernel/slots';
import type { ShellNavItem, ShellView } from '../../ui-kernel/contracts/shell';
import type { SettingsSection } from '../../ui-kernel/contracts/settings';
import { shellNavigationItems } from '../official/shell/navigation';
import { settingsNavigation } from '../official/settings/navigation';
import { blockRegistry, eventRegistry, modeRegistry, MODULE_OWNER, type RegistryEntry } from '@/features/chat/registry';

export interface SlotScenario {
  platform: 'desktop' | 'mobile';
  mode: 'dev' | 'prod';
  shell: 'normal' | 'demo';
  uiLab: boolean;
}

export const SLOT_SCENARIOS: Readonly<Record<string, SlotScenario>> = Object.fromEntries(
  (['desktop', 'mobile'] as const).flatMap((platform) => (['dev', 'prod'] as const).flatMap((mode) =>
    (['normal', 'demo'] as const).flatMap((shell) => [false, true].map((uiLab) => [
      `${platform}-${mode}-${shell}-uilab-${uiLab ? 'on' : 'off'}`, { platform, mode, shell, uiLab },
    ] as const)))),
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SlotSnapshotEntry {
  id: string;
  key: string | null;
  order: number;
  owner: string;
  origin: string;
  value: Json;
}

export interface SlotSnapshot {
  scenario: SlotScenario;
  plugins: string[];
  slots: Record<string, { cardinality: string; entries: SlotSnapshotEntry[] }>;
  /** Contributions that went through a legacy-registry adapter (commands, chat blocks, …). */
  adapters: Record<string, Json[]>;
  consumers: Record<string, Json>;
}

export interface CaptureOptions {
  /** Identity → name for components without a usable displayName (e.g. factory-made icons). */
  componentNames?: ReadonlyMap<unknown, string>;
  recorder?: AdapterRecorder;
}

/** In-memory UiAdapters that keep what plugins registered, so adapter-routed contributions are snapshotted too. */
export interface AdapterRecorder {
  adapters: Required<Pick<UiAdapters, 'commands' | 'chatBlocks' | 'chatEvents' | 'chatModes' | 'workbenchApps' | 'i18n'>>;
  records: Record<string, unknown[]>;
}

export function createAdapterRecorder(): AdapterRecorder {
  const records: Record<string, unknown[]> = { commands: [], chatBlocks: [], chatEvents: [], chatModes: [], workbenchApps: [], i18n: [] };
  const track = (kind: string, value: unknown) => {
    records[kind]!.push(value);
    return () => {
      const list = records[kind]!;
      const index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1);
    };
  };
  return {
    records,
    adapters: {
      commands: { register: (command) => track('commands', command) },
      chatBlocks: { register: (type, renderer, owner) => track('chatBlocks', { type, renderer, owner }) },
      chatEvents: { register: (type, handler, owner) => track('chatEvents', { type, handler, owner }) },
      chatModes: { register: (name, mode, owner) => track('chatModes', { name, mode, owner }) },
      workbenchApps: { register: (def) => track('workbenchApps', def) },
      i18n: { addBundle: (lng, ns, resources) => track('i18n', { lng, ns, keys: Object.keys(resources).sort() }) },
    },
  };
}

/** Predicates evaluated per scenario; elsewhere a function is recorded only as present. */
const PREDICATE_SLOTS = new Set(['views', 'nav', 'settings.sections']);
const PREDICATE_KEYS = new Set(['visible', 'contentVisible', 'redirect']);

function componentName(value: unknown, names?: ReadonlyMap<unknown, string>): string | undefined {
  const known = names?.get(value);
  if (known) return known;
  if (typeof value === 'function') {
    const named = (value as { displayName?: string }).displayName ?? value.name;
    return named && /^[A-Z]/.test(named) ? named : undefined;
  }
  if (value && typeof value === 'object' && '$$typeof' in value) {
    const v = value as { displayName?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string }; _payload?: unknown };
    if (v._payload !== undefined) return 'lazy';
    return v.displayName || v.render?.displayName || v.render?.name || v.type?.displayName || v.type?.name || 'anonymous';
  }
  return undefined;
}

function project(value: unknown, context: Record<string, unknown> | null, names: ReadonlyMap<unknown, string> | undefined, key = '', seen = new Set<unknown>()): Json | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  const component = componentName(value, names);
  if (component) return `<${component}>`;
  if (typeof value === 'function') {
    if (context && PREDICATE_KEYS.has(key)) {
      try {
        return { 'ƒ=': project((value as (ctx: unknown) => unknown)(context), null, names) ?? null };
      } catch (error) {
        return { 'ƒ!': String((error as Error)?.message ?? error) };
      }
    }
    return 'ƒ';
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => project(item, context, names, '', seen) ?? null);
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value as object).sort()) {
      const projected = project((value as Record<string, unknown>)[k], context, names, k, seen);
      if (projected !== undefined) out[k] = projected;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const keyOnlyT = ((key: string) => key) as unknown as TFunction;

/** Visibility as the official consumers compute it (real helpers, not a reimplementation). */
function consumerOutputs(kernel: UiKernel, scenario: SlotScenario): Record<string, Json> {
  const shellContext = { dev: scenario.mode === 'dev', uiLabEnabled: scenario.uiLab };
  const surface = scenario.platform;
  const views = kernel.slots.list<ShellView>('views');
  const nav = shellNavigationItems(kernel.slots.list<ShellNavItem>('nav'), shellContext, surface);
  const sections = kernel.slots.list<SettingsSection>('settings.sections');
  const settingsContext = { isMobile: scenario.platform === 'mobile' };
  const settings = settingsNavigation(sections, keyOnlyT, settingsContext);
  return {
    views: views.map(({ key, value }) => {
      const visible = value.visible ? value.visible(shellContext) : true;
      // App.tsx: the demo shell only navigates to views flagged allowInDemo.
      return { key: key ?? null, visible, navigable: visible && (scenario.shell !== 'demo' || value.allowInDemo === true) };
    }),
    nav: nav.map((item) => ({
      id: item.id, viewId: item.viewId,
      placement: item[surface]?.placement ?? null, defaultPlacement: item.defaultPlacement,
    })),
    settings: {
      groups: settings.sidebarNavGroups.map((group) => (group ?? []).map((item) => item.value)),
      categories: settings.sidebarCategories.map((category) => ({ id: category.value, items: category.items.map((item) => item.value) })),
      content: sections.map(({ value }) => ({
        id: value.id,
        contentVisible: value.contentVisible ? value.contentVisible(settingsContext) : true,
        redirect: value.redirect?.(settingsContext) ?? null,
      })),
      search: settings.settingsSearchIndex.map((item) => `${item.tab}:${item.label}`),
    },
  };
}

export function captureSlotSnapshot(kernel: UiKernel, scenario: SlotScenario, options: CaptureOptions = {}): SlotSnapshot {
  const context = { dev: scenario.mode === 'dev', uiLabEnabled: scenario.uiLab, isMobile: scenario.platform === 'mobile' };
  const slots: SlotSnapshot['slots'] = {};
  for (const def of kernel.slots.definitions()) {
    const evaluate = PREDICATE_SLOTS.has(def.name) ? context : null;
    slots[def.name] = {
      cardinality: def.cardinality,
      entries: kernel.slots.list<unknown>(def.name).map((entry: SlotEntry<unknown>) => ({
        id: entry.id, key: entry.key ?? null, order: entry.order, owner: entry.owner, origin: entry.origin,
        value: project(entry.value, evaluate, options.componentNames) ?? null,
      })),
    };
  }
  const adapters: SlotSnapshot['adapters'] = {};
  for (const [kind, list] of Object.entries(options.recorder?.records ?? {})) {
    adapters[kind] = list.map((item) => project(item, null, options.componentNames) ?? null);
  }
  return { scenario, plugins: kernel.list(), slots, adapters, consumers: consumerOutputs(kernel, scenario) };
}

/** The chat block/event/mode registries (module-import layer + kernel layer), keyed like a slot. */
export interface ChatRegistryLike {
  getName(): string;
  getAll(): Map<string, unknown>;
  entries?(): readonly { key: string; value: unknown; owner?: string; origin?: string }[];
}

/** Registries without owners (pre-kernel) record entries as owned by `module`, the registry's own default owner. */
export function captureRegistries(registries: Record<string, ChatRegistryLike>, options: CaptureOptions = {}): SlotSnapshot['slots'] {
  const slots: SlotSnapshot['slots'] = {};
  for (const [name, registry] of Object.entries(registries)) {
    const listed = registry.entries
      ? registry.entries().map(({ key, value, owner, origin }) => ({ key, value, owner: owner ?? 'module', origin: origin ?? 'builtin' }))
      : [...registry.getAll()].map(([key, value]) => ({ key, value, owner: 'module', origin: 'builtin' }));
    slots[`registry:${name}`] = {
      cardinality: 'keyed',
      entries: listed.map(({ key, value, owner, origin }, order) => ({
        id: key, key, order, owner, origin, value: project(value, null, options.componentNames) ?? null,
      })),
    };
  }
  return slots;
}

// ------------------------------------------------------------------ comparison

/**
 * One reviewed change in owner-moves.json:
 * - `{slot, id, from, to}`: the entry's owner changed from `from` to `to`; `id: "*"` covers every entry of the slot owned by `from`.
 * - `{slot, id, from: null, to}`: a new entry owned by `to` (a new contribution); the id must be listed exactly.
 * Anything else about the entry (key, order, origin, value) must still match.
 */
export interface OwnerMove { slot: string; id: string; from: string | null; to: string; note?: string }

export interface SlotDiff {
  /** Human-readable differences that fail the check. */
  failures: string[];
  /** Owner changes that owner-moves.json accepts. */
  acceptedMoves: string[];
}

function stable(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** Leaf-level differences with JSON-ish paths, at most `limit` of them. */
export function diffJson(path: string, before: unknown, after: unknown, out: string[], limit = 20): void {
  if (out.length >= limit || stable(before) === stable(after)) return;
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  const bothObjects = !bothArrays && before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after);
  if (bothArrays) {
    const a = before as unknown[];
    const b = after as unknown[];
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffJson(`${path}[${i}]`, a[i], b[i], out, limit);
    return;
  }
  if (bothObjects) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(`${path}.${key}`, a[key], b[key], out, limit);
    return;
  }
  out.push(`${path}: ${stable(before)} → ${stable(after)}`);
}

export function diffSlotSnapshots(expected: SlotSnapshot, actual: SlotSnapshot, moves: readonly OwnerMove[] = []): SlotDiff {
  const failures: string[] = [];
  const acceptedMoves: string[] = [];
  const moveFor = (slot: string, id: string, from: string) =>
    moves.find((move) => move.slot === slot && move.from === from && (move.id === id || move.id === '*'));
  const additionFor = (slot: string, id: string) => moves.find((move) => move.slot === slot && move.id === id && move.from === null);
  const plugins = (list: string[]) => list.filter((id) => !moves.some((move) => move.to === id || move.from === id));
  if (stable(plugins(expected.plugins)) !== stable(plugins(actual.plugins))) {
    failures.push(`plugins: ${stable(expected.plugins)} → ${stable(actual.plugins)}`);
  }
  for (const slot of new Set([...Object.keys(expected.slots), ...Object.keys(actual.slots)])) {
    const before = expected.slots[slot];
    const after = actual.slots[slot];
    if (!before || !after) {
      failures.push(`slot ${slot}: ${before ? 'removed' : 'added'}`);
      continue;
    }
    if (before.cardinality !== after.cardinality) failures.push(`slot ${slot}: cardinality ${before.cardinality} → ${after.cardinality}`);
    const beforeIds = before.entries.map((entry) => entry.id);
    const afterIds = after.entries.map((entry) => entry.id);
    const removed = beforeIds.filter((id) => !afterIds.includes(id));
    const added = afterIds.filter((id) => !beforeIds.includes(id));
    if (removed.length) failures.push(`slot ${slot}: removed ${removed.join(', ')}`);
    const unlisted: string[] = [];
    for (const id of added) {
      const owner = after.entries.find((entry) => entry.id === id)!.owner;
      if (additionFor(slot, id)?.to === owner) acceptedMoves.push(`${slot}/${id}: added by ${owner}`);
      else unlisted.push(id);
    }
    if (unlisted.length) failures.push(`slot ${slot}: added ${unlisted.join(', ')}`);
    const common = afterIds.filter((id) => beforeIds.includes(id));
    const beforeCommon = beforeIds.filter((id) => afterIds.includes(id));
    if (stable(common) !== stable(beforeCommon)) failures.push(`slot ${slot}: sequence ${beforeCommon.join(' > ')} → ${common.join(' > ')}`);
    for (const id of common) {
      const b = before.entries.find((entry) => entry.id === id)!;
      const a = after.entries.find((entry) => entry.id === id)!;
      const move = moveFor(slot, id, b.owner);
      if (b.owner !== a.owner) {
        if (move && move.to === a.owner) acceptedMoves.push(`${slot}/${id}: ${b.owner} → ${a.owner}`);
        else failures.push(`${slot}/${id}: owner ${b.owner} → ${a.owner} (not in owner-moves.json)`);
      }
      for (const field of ['key', 'order', 'origin'] as const) {
        if (b[field] !== a[field]) failures.push(`${slot}/${id}: ${field} ${stable(b[field])} → ${stable(a[field])}`);
      }
      diffJson(`${slot}/${id}: value`, b.value, a.value, failures, failures.length + 20);
    }
  }
  diffJson('adapters', expected.adapters, actual.adapters, failures, failures.length + 20);
  diffJson('consumers', expected.consumers, actual.consumers, failures, failures.length + 40);
  return { failures, acceptedMoves };
}

// ------------------------------------------------------------------ FE-A3 kernel slot inventory

/** Pre-FE-A3 inventory of the official UI plugins (see `__tests__/official-slots.golden.test.tsx`). */
export const OFFICIAL_SLOTS_GOLDEN = 'src/ui-plugins/testing/__golden__/official-slots.json';

const MAX_DEPTH = 4;

export function describeSlotValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? `array(${value.length})` : value.map((item) => describeSlotValue(item, depth + 1));
  if (value && typeof value === 'object') {
    if ('$$typeof' in (value as object)) return 'component';
    if (depth >= MAX_DEPTH) return 'object';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, describeSlotValue(item, depth + 1)]));
  }
  return value === undefined ? '<undefined>' : value;
}

export interface KernelSlotSnapshotEntry {
  id: string;
  key?: string;
  order: number;
  owner: string;
  origin: string;
  value: unknown;
}

export interface ChatRegistrySnapshotEntry {
  key: string;
  owner: string;
  origin: string;
}

export interface KernelSlotSnapshot {
  slots: Record<string, KernelSlotSnapshotEntry[]>;
  chat?: Record<'blocks' | 'events' | 'modes', ChatRegistrySnapshotEntry[]>;
}

export function slotSnapshot(kernel: UiKernel): Record<string, KernelSlotSnapshotEntry[]> {
  const slots: Record<string, KernelSlotSnapshotEntry[]> = {};
  for (const { name } of kernel.slots.definitions()) {
    slots[name] = kernel.slots.list(name).map((entry) => ({
      id: entry.id,
      ...(entry.key !== undefined ? { key: entry.key } : {}),
      order: entry.order,
      owner: entry.owner,
      origin: entry.origin,
      value: describeSlotValue(entry.value),
    }));
  }
  return slots;
}

export function chatRegistrySnapshot(entries: readonly RegistryEntry<unknown>[]): ChatRegistrySnapshotEntry[] {
  return entries
    .map(({ key, owner, origin }) => ({ key, owner, origin }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.owner.localeCompare(b.owner));
}

/** The real chat registries; the command palette and workbench registries are inert stand-ins (no official UI plugin registers into them). */
export function chatLegacyRegistries(): LegacyRegistries {
  return {
    commandRegistry: { register: () => () => {}, unregister() {}, getById: () => undefined, getAll: () => [], subscribe: () => () => {} },
    appRegistry: { register() {}, unregister() {}, get: () => undefined, list: () => [], subscribe: () => () => {} } as unknown as LegacyRegistries['appRegistry'],
    blockRegistry,
    eventRegistry,
    modeRegistry,
  };
}

/** Slots plus the chat registry entries the kernel owns (module-layer entries are left out). */
export function kernelSnapshot(kernel: UiKernel): KernelSlotSnapshot {
  const owned = (entries: readonly RegistryEntry<unknown>[]) => chatRegistrySnapshot(entries.filter((entry) => entry.owner !== MODULE_OWNER));
  return {
    slots: slotSnapshot(kernel),
    chat: {
      blocks: owned(blockRegistry.entries()),
      events: owned(eventRegistry.entries()),
      modes: owned(modeRegistry.entries()),
    },
  };
}

/** Entries present in `before` but not in `after`, per slot (compared by owner, id and key). */
export function removedSlotEntries(before: Record<string, KernelSlotSnapshotEntry[]>, after: Record<string, KernelSlotSnapshotEntry[]>): Record<string, KernelSlotSnapshotEntry[]> {
  const identity = (entry: KernelSlotSnapshotEntry) => `${entry.owner}\u0000${entry.id}\u0000${entry.key ?? ''}`;
  const removed: Record<string, KernelSlotSnapshotEntry[]> = {};
  for (const [slot, entries] of Object.entries(before)) {
    const kept = new Set((after[slot] ?? []).map(identity));
    const gone = entries.filter((entry) => !kept.has(identity(entry)));
    if (gone.length) removed[slot] = gone;
  }
  return removed;
}
