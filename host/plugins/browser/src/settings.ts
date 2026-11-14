import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

// src/cmd/web_search.rs:12-37: key checks are case-sensitive and prefix checks are bidirectional.
export function ensurePublicSettingKey(key: string): void {
  if (key.startsWith('internal.oauth.')) throw new CommandError(AppError.configuration('该设置键属于后端内部凭据，不能通过通用设置接口访问'));
}
export function ensurePublicSettingPrefix(prefix: string): void {
  if (prefix.startsWith('internal.oauth.') || 'internal.oauth.'.startsWith(prefix)) {
    throw new CommandError(AppError.configuration('该设置前缀可能包含后端内部凭据，不能通过通用设置接口访问'));
  }
}
export function readSettingOrNone(settings: SettingsStore, key: string): string | null {
  try { return settings.get(key); } catch { return null; } // Rust .unwrap_or(None)
}
export function securityStatus() {
  return {
    keychain_available: false, migration_completed: true, sensitive_keys_count: 0, last_migration_time: null,
    warnings: ['🚨 钥匙串功能已彻底禁用以避免密码弹窗，敏感数据使用加密数据库存储'],
    sensitive_key_patterns: ['web_search.api_key.*', 'web_search.searxng.api_key', 'api_configs', 'mcp.transport.*'],
    timestamp: new Date().toISOString().replace(/\.000Z$/, 'Z').replace('Z', '+00:00'),
  };
}
export function namespaceConfig(settings: SettingsStore) {
  return {
    namespace_prefix: readSettingOrNone(settings, 'mcp.tools.namespace_prefix'),
    conflict_resolution: readSettingOrNone(settings, 'mcp.tools.conflict_resolution') ?? 'use_local',
    available_resolutions: [
      { value: 'use_local', label: '优先使用本地工具' },
      { value: 'use_mcp', label: '优先使用MCP工具' },
      { value: 'use_namespace', label: '使用命名空间前缀' },
    ],
    config_keys: { namespace_prefix: 'mcp.tools.namespace_prefix', conflict_resolution: 'mcp.tools.conflict_resolution' },
  };
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
