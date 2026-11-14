/** Mobile entry (`mobile.json`): SQL repository and secret migration semantics unchanged. */
import { CommandError, definePlugin } from '../../kernel/core.ts';
import { AppError } from '../errors/api.ts';
import { dirname } from '../util/path.ts';
import { createSettingsService } from './index.ts';

function ensurePublicSettingKey(key: string): void {
  if (key.startsWith('internal.oauth.')) {
    throw new CommandError(AppError.configuration('该设置键属于后端内部凭据，不能通过通用设置接口访问'));
  }
}

function ensurePublicSettingPrefix(prefix: string): void {
  if (prefix.startsWith('internal.oauth.') || 'internal.oauth.'.startsWith(prefix)) {
    throw new CommandError(AppError.configuration('该设置前缀可能包含后端内部凭据，不能通过通用设置接口访问'));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default definePlugin({
  meta: {
    id: 'dstu.platform.settings',
    provides: ['settings'],
    platforms: ['mobile'],
    commands: [
      'save_setting',
      'get_setting',
      'delete_setting',
      'get_settings_by_prefix',
      'delete_settings_by_prefix',
      'get_security_status',
      'detect_tool_conflicts',
      'get_tools_namespace_config',
      'get_cn_whitelist_config',
      'get_provider_strategies_config',
      'save_provider_strategies_config',
      'get_feature_flags',
      'update_feature_flag',
      'is_feature_enabled',
      'set_android_immersive_mode',
      'get_mcp_stdio_allow_unapproved',
      'set_mcp_stdio_allow_unapproved',
      'plugin_list',
    ],
  },
  inject: ['storage', 'secrets'],
  apply(ctx) {
    const settings = createSettingsService({
      db: () => ctx.storage.database('mistakes'),
      secureStore: () => ctx.secrets.openStore(dirname(ctx.storage.pathOf('mistakes'))),
      secrets: ctx.secrets,
    });
    ctx.provide('settings', settings);

    const readSettingOrNone = (key: string): string | null => {
      try { return settings.get(key); } catch { return null; }
    };

    ctx.commands.register<{ key: string; value: string }>('save_setting', async ({ key, value }) => {
      ensurePublicSettingKey(key);
      try { await settings.saveSecret(key, value); }
      catch (e) { throw new CommandError(AppError.database(`保存设置失败: ${errorMessage(e)}`)); }
      return true;
    });
    ctx.commands.register<{ key: string }>('get_setting', async ({ key }) => {
      ensurePublicSettingKey(key);
      try { return await settings.getSecret(key); }
      catch (e) { throw new CommandError(AppError.database(`读取设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ key: string }>('delete_setting', async ({ key }) => {
      ensurePublicSettingKey(key);
      try { return await settings.deleteSecret(key); }
      catch (e) { throw new CommandError(AppError.database(`删除设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ prefix: string }>('get_settings_by_prefix', ({ prefix }) => {
      ensurePublicSettingPrefix(prefix);
      try { return settings.listByPrefix(prefix).map((row) => [row.key, row.value, row.updatedAt]); }
      catch (e) { throw new CommandError(AppError.database(`按前缀查询设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ prefix: string }>('delete_settings_by_prefix', ({ prefix }) => {
      ensurePublicSettingPrefix(prefix);
      try { return settings.deleteByPrefix(prefix); }
      catch (e) { throw new CommandError(AppError.database(`按前缀批量删除设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register('get_security_status', () => ({
      keychain_available: false,
      migration_completed: true,
      sensitive_keys_count: 0,
      last_migration_time: null,
      warnings: ['🚨 钥匙串功能已彻底禁用以避免密码弹窗，敏感数据使用加密数据库存储'],
      sensitive_key_patterns: ['web_search.api_key.*', 'web_search.searxng.api_key', 'api_configs', 'mcp.transport.*'],
      timestamp: new Date().toISOString().replace(/\.000Z$/, 'Z').replace('Z', '+00:00'),
    }));
    ctx.commands.register('detect_tool_conflicts', () => []);
    ctx.commands.register('get_tools_namespace_config', () => ({
      namespace_prefix: readSettingOrNone('mcp.tools.namespace_prefix'),
      conflict_resolution: readSettingOrNone('mcp.tools.conflict_resolution') ?? 'use_local',
      available_resolutions: [
        { value: 'use_local', label: '优先使用本地工具' },
        { value: 'use_mcp', label: '优先使用MCP工具' },
        { value: 'use_namespace', label: '使用命名空间前缀' },
      ],
      config_keys: {
        namespace_prefix: 'mcp.tools.namespace_prefix',
        conflict_resolution: 'mcp.tools.conflict_resolution',
      },
    }));
    ctx.commands.register('get_cn_whitelist_config', () => ({
      default_sites: ['zhihu.com', 'baike.baidu.com', 'bilibili.com', 'csdn.net', 'juejin.cn'],
      user_config: {
        enabled: readSettingOrNone('web_search.cn_whitelist.enabled') === 'true',
        use_default_list: readSettingOrNone('web_search.cn_whitelist.use_default') !== 'false',
        custom_sites: [],
      },
    }));
    ctx.commands.register('get_provider_strategies_config', () => ({
      provider_strategies: {},
      config_keys: { provider_strategies: 'web_search.provider_strategies' },
    }));
    ctx.commands.register<{ strategies: unknown }>('save_provider_strategies_config', ({ strategies }) => {
      try { settings.save('web_search.provider_strategies', JSON.stringify(strategies ?? {})); }
      catch (e) { throw new CommandError(AppError.from(`保存Provider策略失败: ${errorMessage(e)}`)); }
      return true;
    });
    ctx.commands.register('get_feature_flags', () => ({
      flags: {},
      total_count: 0,
      enabled_count: 0,
    }));
    ctx.commands.register<{ featureName: string; action: string }>('update_feature_flag', ({ featureName }) => ({
      success: true,
      message: `功能 '${featureName}' 已更新`,
    }));
    ctx.commands.register('is_feature_enabled', () => false);
    ctx.commands.register('set_android_immersive_mode', () => null);
    ctx.commands.register('get_mcp_stdio_allow_unapproved', () => false);
    ctx.commands.register('set_mcp_stdio_allow_unapproved', () => null);
    ctx.commands.register('plugin_list', () => []);
  },
});
