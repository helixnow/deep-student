import { CommandError, type Context } from '../../../kernel/core.ts';
import { AppError } from '../../../platform/errors/api.ts';
import {
  CN_TRUSTED_SITES, defaultProviderStrategies, normalizeProviderStrategies,
  parseCnCustomSites, parseProviderStrategies, serializeProviderStrategies,
} from '../../mcp/portable.ts';
import { errorMessage } from './settings.ts';

const STRATEGIES_KEY = 'web_search.provider_strategies';

export function registerSearchSettings(
  ctx: Pick<Context, 'commands' | 'settings'>,
  onStrategiesSaved: () => void = () => undefined,
): void {
  const read = (key: string): string | null => {
    try { return ctx.settings.get(key); }
    catch (error) { throw new CommandError(AppError.database(`读取搜索设置失败: ${errorMessage(error)}`)); }
  };
  ctx.commands.register('get_cn_whitelist_config', () => ({
    default_sites: [...CN_TRUSTED_SITES],
    user_config: {
      enabled: read('web_search.cn_whitelist.enabled') === 'true',
      use_default_list: read('web_search.cn_whitelist.use_default') !== 'false',
      custom_sites: parseCnCustomSites(read('web_search.cn_whitelist.custom_sites')),
    },
  }));
  ctx.commands.register('get_provider_strategies_config', () => {
    const raw = read(STRATEGIES_KEY);
    const parsed = raw === null ? null : parseProviderStrategies(raw);
    return {
      provider_strategies: parsed ?? defaultProviderStrategies(),
      config_keys: { provider_strategies: STRATEGIES_KEY },
    };
  });
  ctx.commands.register<{ strategies: unknown }>('save_provider_strategies_config', ({ strategies }) => {
    const normalized = normalizeProviderStrategies(strategies);
    if (normalized === null) throw new CommandError(AppError.from('序列化Provider策略失败: invalid ProviderStrategies'));
    try { ctx.settings.save(STRATEGIES_KEY, serializeProviderStrategies(normalized)); }
    catch (error) { throw new CommandError(AppError.from(`保存Provider策略失败: ${errorMessage(error)}`)); }
    onStrategiesSaved();
    return true;
  });
}
