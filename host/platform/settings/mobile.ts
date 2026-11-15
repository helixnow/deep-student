/** Mobile entry (`mobile.json`): SQL repository and secret migration semantics unchanged. */
import { CommandError, definePlugin } from '../../kernel/core.ts';
import { AppError } from '../errors/api.ts';
import { registerUnsupportedCommands } from '../errors/unsupported-commands.ts';
import { dirname } from '../util/path.ts';
import { createFeatureFlagCommands } from './feature-flag-commands.ts';
import { createSettingsService } from './index.ts';
import { getMobileSecurityStatus } from './mobile-security-status.ts';

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
      'get_feature_flags',
      'update_feature_flag',
      'is_feature_enabled',
      'set_android_immersive_mode',
      'get_mcp_stdio_allow_unapproved',
      'set_mcp_stdio_allow_unapproved',
      'plugin_list',
    ],
  },
  inject: ['storage', 'secrets', 'featureFlags'],
  apply(ctx) {
    const secureStore = () => ctx.secrets.openStore(dirname(ctx.storage.pathOf('mistakes')));
    const settings = createSettingsService({
      db: () => ctx.storage.database('mistakes'),
      secureStore,
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
    ctx.commands.register('get_security_status', () => getMobileSecurityStatus(secureStore()));
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
    const flagCommands = createFeatureFlagCommands({
      featureFlags: ctx.featureFlags,
      settings,
      appVersion: ctx.app.version,
      debug: ctx.app.debug,
    });
    ctx.commands.register('get_feature_flags', flagCommands.getFeatureFlags);
    ctx.commands.register('update_feature_flag', flagCommands.updateFeatureFlag);
    ctx.commands.register('is_feature_enabled', flagCommands.isFeatureEnabled);
    ctx.commands.register('set_android_immersive_mode', () => {
      throw new CommandError(AppError.configuration('Immersive mode requires the Android app shell'));
    });
    ctx.commands.register('get_mcp_stdio_allow_unapproved', () => false);
    registerUnsupportedCommands(ctx, ['set_mcp_stdio_allow_unapproved'], () => 'mcp.stdio');
    ctx.commands.register('plugin_list', () => []);
  },
});
