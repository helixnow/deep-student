import type { ManagedPlugin } from './types';
import type { PluginUiStatusSnapshot } from './ui-status';
import type { TFunction } from 'i18next';

/** Display adapter seam. Host metadata is mapped here once its published contract is available. */
export function pluginName(plugin: ManagedPlugin, t: TFunction): string {
  return plugin.displayNameKey ? t(plugin.displayNameKey, { defaultValue: plugin.displayName ?? plugin.id }) : plugin.displayName || plugin.id;
}
/**
 * Host `plugin:manager|list` falls back to `meta.provides.join(', ')` when an official plugin has no
 * `meta.description`; that surfaces raw service keys (`agentApproval, agentWorkspace, ...`) in the row.
 * Localized `plugin_manager:builtinDescriptions.<id>` wins over the raw host text, and the host
 * description stays the last fallback for community plugins or ids we do not know yet.
 */
export function pluginDescription(plugin: ManagedPlugin, t: TFunction): string {
  if (plugin.descriptionKey) return t(plugin.descriptionKey, { defaultValue: plugin.description ?? '' });
  const key = `builtinDescriptions.${plugin.id}`;
  const localized = t(key, { defaultValue: '' });
  if (localized && localized !== key) return localized;
  return plugin.description ?? '';
}
/** P1 currently projects builtin meta.lane as category. Group those real inventory values by user function. */
const functionalCategories: Record<string, string[]> = {
  conversation: ['conversation', 'L01-llm-providers', 'L02-llm-manager', 'L03-chat-pipeline', 'L04-chat-session', 'L05-agent-workspace', 'L06-agent-orchestration', 'L07-agent-skills-ptc', 'L17-memory-research'],
  learning: ['learning', 'L10-notes', 'L14-qbank', 'L15-review-analytics', 'L16-anki', 'L24-chatanki'],
  resources: ['resources', 'L11-vfs-repos', 'L12-vfs-index', 'L13-vfs-api', 'L18-media-docs'],
  integrations: ['integrations', 'L19-mcp-browser', 'L20-sync', 'L21-backup-governance', 'L23-sync-providers'],
  platform: ['platform', 'application', 'L22-app-commands', 'F1-kernel', 'F2-shell', 'F7-native', 'F4-security', 'F4-platform', 'F3-storage', 'W14-portable'],
};
export function pluginCategory(plugin: ManagedPlugin): string {
  if (!plugin.category) return 'manager.other';
  const group = Object.entries(functionalCategories).find(([, values]) => values.includes(plugin.category!))?.[0];
  return group ? `manager.categories.${group}` : plugin.category;
}

/**
 * Official plugins read top-down from what a learner uses directly to what keeps the app running. The Host
 * lists by id, which would open the page on agent orchestration and scatter the groups; ids missing here (new
 * official plugins) follow the known ones in Host order, and unknown categories follow the known groups.
 */
const officialOrder: readonly (readonly [group: string, icon: string, ids: readonly string[]])[] = [
  ['learning', 'BookOpen', ['dstu.notes', 'dstu.qbank', 'dstu.anki', 'dstu.review', 'dstu.chatanki']],
  ['conversation', 'ChatCircle', [
    'dstu.chat', 'dstu.chat-pipeline', 'dstu.llm', 'dstu.llm-providers', 'dstu.agent-workspace',
    'dstu.agent-orchestration', 'dstu.agent-skills', 'dstu.memory', 'dstu.translation',
  ]],
  ['resources', 'MagnifyingGlass', ['dstu.vfs', 'dstu.vfs-repos', 'dstu.vfs-index', 'dstu.vfs-handlers', 'dstu.media']],
  ['integrations', 'Wrench', [
    'dstu.mcp', 'dstu.browser', 'dstu.sync', 'dstu.sync-providers', 'dstu.sync-support', 'dstu.sync-startup', 'dstu.backup',
  ]],
  ['platform', 'Package', [
    'dstu.plugin-workshop', 'dstu.plugin-services', 'dstu.plugins', 'dstu.shell', 'dstu.integration', 'dstu.native', 'dstu.vector',
    'dstu.platform.storage', 'dstu.platform.settings', 'dstu.platform.files', 'dstu.platform.secrets', 'dstu.platform.http',
    'dstu.platform.log', 'dstu.platform.paths', 'dstu.platform.crypto', 'dstu.platform.diagnostics',
    'dstu.platform.cloud-config', 'dstu.platform.backup-config',
  ]],
];
const categoryRank = new Map(officialOrder.map(([group], index) => [`manager.categories.${group}`, index]));
const categoryIcon = new Map(officialOrder.map(([group, icon]) => [`manager.categories.${group}`, icon]));
/** Every official plugin id that has a display slot, in display order (checked against the desktop profile in tests). */
export const officialPluginDisplayOrder: readonly string[] = officialOrder.flatMap(([, , ids]) => ids);
const idRank = new Map(officialPluginDisplayOrder.map((id, index) => [id, index]));
const rankOf = (ranks: ReadonlyMap<string, number>, key: string): number => ranks.get(key) ?? Number.MAX_SAFE_INTEGER;

/** Official plugins grouped for display: known groups in their fixed order, each with its rows in reading order. */
export function officialPluginGroups(plugins: readonly ManagedPlugin[]): { category: string; plugins: ManagedPlugin[] }[] {
  const groups = new Map<string, ManagedPlugin[]>();
  for (const plugin of plugins) {
    const category = pluginCategory(plugin);
    groups.set(category, [...(groups.get(category) ?? []), plugin]);
  }
  // Array.prototype.sort is stable: equal ranks keep the Host's order.
  return [...groups.entries()]
    .sort(([a], [b]) => rankOf(categoryRank, a) - rankOf(categoryRank, b))
    .map(([category, rows]) => ({ category, plugins: [...rows].sort((a, b) => rankOf(idRank, a.id) - rankOf(idRank, b.id)) }));
}

/**
 * Icon name for a row. The Host reports the generic `Package` for every official plugin that declares no icon
 * of its own; those take their group's icon so a group is recognisable at a glance.
 */
export function categoryIconName(category: string): string | undefined {
  return categoryIcon.get(category);
}
export function pluginIcon(plugin: ManagedPlugin): string | undefined {
  if (plugin.origin !== 'builtin' || (plugin.icon && plugin.icon !== 'Package')) return plugin.icon;
  return categoryIcon.get(pluginCategory(plugin)) ?? plugin.icon;
}

export function pluginNeedsAttention(plugin: ManagedPlugin, uiStatus?: PluginUiStatusSnapshot): boolean {
  return plugin.runtime === 'error' || !!plugin.degraded || plugin.consent === 'required'
    || !!uiStatus?.degraded || uiStatus?.consentRequired === true;
}

/** A single summary never equates a profile enable flag with a running runtime. */
export function pluginStatusKey(plugin: ManagedPlugin, uiStatus?: PluginUiStatusSnapshot, safeMode = false): string {
  if (safeMode && plugin.origin === 'community') {
    return plugin.enabled ? 'safeMode.pausedStatus' : 'safeMode.quarantinedStatus';
  }
  if (plugin.consent === 'required' || uiStatus?.consentRequired) return 'row.consentRequired';
  if (pluginNeedsAttention(plugin, uiStatus)) return 'manager.problemStatus';
  if (plugin.runtime === 'running') return 'runtime.running';
  if (plugin.runtime === 'unknown') return 'runtime.unknown';
  return plugin.enabled ? 'manager.waiting' : 'manager.disabled';
}

// ---------------------------------------------------------------- redesign: what a plugin adds, identity, essentials

/**
 * What a plugin adds to the app, in the user's words. Each kind maps to the contribution points that produce it:
 * Host-known ones (`agent.tools`, from the manifest) and UI slots owned by the plugin in the UI kernel.
 */
export const ADDITION_KINDS = [
  'app', 'selectionButton', 'agentTool', 'chatCard', 'settingsPage', 'contextMenu', 'menuItem',
  'slashCommand', 'dashboardWidget', 'editor', 'renderer', 'navEntry',
  'studyPrompt', 'studyTemplate', 'studyDeck', 'studyRule', 'studyWidget',
] as const;
export type PluginAdditionKind = typeof ADDITION_KINDS[number];

const additionByPoint: Readonly<Record<string, PluginAdditionKind>> = {
  views: 'app', 'workbench.apps': 'app',
  'editor.selectionToolbar': 'selectionButton', 'pdf.selectionToolbar': 'selectionButton',
  'review.cardActions': 'menuItem', 'chat.message.actions': 'menuItem',
  'chat.composer.commands': 'slashCommand',
  'desktop.widgets': 'dashboardWidget', 'statusbar.items': 'dashboardWidget',
  'agent.tools': 'agentTool',
  'chat.toolResults': 'chatCard', 'genui.components': 'chatCard',
  'settings.sections': 'settingsPage',
  'resource.contextMenu': 'contextMenu',
  'app.menu': 'menuItem',
  'editor.slashMenu': 'slashCommand',
  'dashboard.widgets': 'dashboardWidget', 'dashboard.stats': 'dashboardWidget', 'dashboard.charts': 'dashboardWidget',
  'editor.extensions': 'editor', 'editor.blockMenu': 'editor',
  'markdown.codeBlocks': 'renderer', 'markdown.remark': 'renderer', 'markdown.rehype': 'renderer', 'resource.types': 'renderer',
  nav: 'navEntry',
  prompts: 'studyPrompt', 'study-pack.prompts': 'studyPrompt', 'declarative.prompts': 'studyPrompt',
  skills: 'studyPrompt', 'declarative.skills': 'studyPrompt',
  templates: 'studyTemplate', 'study-pack.templates': 'studyTemplate', 'declarative.templates': 'studyTemplate',
  cardTemplates: 'studyTemplate', 'declarative.cardTemplates': 'studyTemplate',
  decks: 'studyDeck', 'study-pack.decks': 'studyDeck', 'declarative.decks': 'studyDeck',
  rules: 'studyRule', 'study-pack.rules': 'studyRule', 'declarative.rules': 'studyRule',
  rubrics: 'studyRule', 'declarative.rubrics': 'studyRule',
  widgets: 'studyWidget', 'study-pack.widgets': 'studyWidget', 'declarative.widgets': 'studyWidget',
  workflows: 'studyWidget', 'declarative.workflows': 'studyWidget',
};

/** Contribution-point names → addition kinds, de-duplicated, in the fixed reading order of {@link ADDITION_KINDS}. */
export function pluginAdditions(plugin: ManagedPlugin, livePoints: readonly string[] = []): PluginAdditionKind[] {
  const found = new Set<PluginAdditionKind>();
  for (const point of [...(plugin.contributes ?? []), ...livePoints]) {
    const kind = additionByPoint[point];
    if (kind) found.add(kind);
  }
  if (plugin.agentTools?.length) found.add('agentTool');
  const decl = plugin.declarative;
  if (decl) {
    if (decl.prompts?.length || decl.skills?.length) found.add('studyPrompt');
    if (decl.templates?.length || decl.cardTemplates?.length) found.add('studyTemplate');
    if (decl.decks?.length) found.add('studyDeck');
    if (decl.rules?.length || decl.rubrics?.length) found.add('studyRule');
    if (decl.widgets?.length || decl.workflows?.length) found.add('studyWidget');
  }
  // A view is the entry itself; the sidebar item that leads to it is not a second thing the plugin "adds".
  if (found.has('app')) found.delete('navEntry');
  return ADDITION_KINDS.filter((kind) => found.has(kind));
}

/** Accent tokens of the settings palette (light/dark pairs live in theme-colors.css). */
export const PLUGIN_TINTS = ['teal', 'blue', 'violet', 'amber', 'coral', 'green', 'indigo', 'pink', 'sky', 'orange', 'purple'] as const;

/** A stable tint per plugin id: the same plugin keeps its colour across sessions, renames and machines. */
export function pluginTint(id: string): typeof PLUGIN_TINTS[number] {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return PLUGIN_TINTS[(hash >>> 0) % PLUGIN_TINTS.length]!;
}

const firstGrapheme = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment;
  }
  return Array.from(trimmed)[0] ?? '';
};

/**
 * The glyph on a plugin's tile when it brings no icon: an emoji/short glyph the plugin declared as `icon`,
 * otherwise the first character of its name (upper-cased for Latin).
 */
export function pluginMonogram(plugin: ManagedPlugin, name: string): string {
  const icon = plugin.icon?.trim();
  if (icon && !/^[A-Za-z][A-Za-z0-9]*$/.test(icon) && Array.from(icon).length <= 4) return icon;
  return firstGrapheme(name).toLocaleUpperCase() || '?';
}

/**
 * A base service: other installed plugins are using what it provides, so the Host refuses to stop it
 * (`PLUGIN_UNLOAD_BLOCKED`). Derived from the Host's dependency data only — never from a list kept in the UI.
 * A plugin that is currently off is never "essential": turning it back on must stay possible.
 */
export function pluginIsEssential(plugin: ManagedPlugin): boolean {
  return plugin.origin === 'builtin' && plugin.enabled && (plugin.requiredBy?.length ?? 0) > 0;
}

export type PluginFilter = 'all' | 'safeModePaused' | 'mine' | 'builtin' | 'disabled' | 'problem';
export const PLUGIN_FILTERS: readonly PluginFilter[] = ['all', 'mine', 'builtin', 'disabled', 'problem'];
export const SAFE_MODE_PLUGIN_FILTERS: readonly PluginFilter[] = ['all', 'safeModePaused', 'mine', 'builtin', 'disabled', 'problem'];

export function pluginFiltersForMode(safeMode: boolean): readonly PluginFilter[] {
  return safeMode ? SAFE_MODE_PLUGIN_FILTERS : PLUGIN_FILTERS;
}

/** Tone of the quiet status dot next to a plugin's state label. */
export function pluginStatusTone(statusKey: string): 'ok' | 'off' | 'warn' | 'bad' {
  if (statusKey === 'runtime.running') return 'ok';
  if (statusKey === 'manager.problemStatus') return 'bad';
  if (
    statusKey === 'row.consentRequired' ||
    statusKey === 'manager.waiting' ||
    statusKey === 'row.unsupportedPlatform' ||
    statusKey === 'row.desktopOnly' ||
    statusKey === 'safeMode.pausedStatus' ||
    statusKey === 'safeMode.quarantinedStatus'
  ) {
    return 'warn';
  }
  return 'off';
}

/** Why a plugin cannot run on this platform: 「只在电脑上可用」 for desktop-only plugins (all workshop works) on mobile. */
export function unsupportedPlatformKey(plugin: { platforms: readonly string[] }, platform: string): string {
  return platform !== 'desktop' && plugin.platforms.length > 0 && plugin.platforms.every(entry => entry === 'desktop') ? 'row.desktopOnly' : 'row.unsupportedPlatform';
}
