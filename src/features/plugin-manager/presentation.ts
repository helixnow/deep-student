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

export function pluginNeedsAttention(plugin: ManagedPlugin, uiStatus?: PluginUiStatusSnapshot): boolean {
  return plugin.runtime === 'error' || !!plugin.degraded || plugin.consent === 'required'
    || !!uiStatus?.degraded || uiStatus?.consentRequired === true;
}

/** A single summary never equates a profile enable flag with a running runtime. */
export function pluginStatusKey(plugin: ManagedPlugin, uiStatus?: PluginUiStatusSnapshot, safeMode = false): string {
  if (safeMode && plugin.origin === 'community') return 'manager.disabled';
  if (plugin.consent === 'required' || uiStatus?.consentRequired) return 'row.consentRequired';
  if (pluginNeedsAttention(plugin, uiStatus)) return 'manager.problemStatus';
  if (plugin.runtime === 'running') return 'runtime.running';
  if (plugin.runtime === 'unknown') return 'runtime.unknown';
  return plugin.enabled ? 'manager.waiting' : 'manager.disabled';
}
