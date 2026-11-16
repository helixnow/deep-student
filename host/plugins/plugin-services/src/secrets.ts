import { Service, type Context } from '@deepseek-ai/cordis';
import type {} from '../../../platform/settings/api.ts';
import { PLUGIN_SECRET_KEY, pluginSecretSettingsKey, type PluginSecretsService } from '../api.ts';
import { callerPluginId } from './caller.ts';

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !PLUGIN_SECRET_KEY.test(key)) {
    throw new Error('PLUGIN_SECRET_KEY_INVALID: key must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit');
  }
  return key;
}

/**
 * `pluginSecrets`: each plugin's secrets under `secret.plugin.<id>.<key>`, a key the settings service always routes
 * to the secure store (`isSensitiveKey`: prefix `secret`), never to the plaintext settings table.
 */
export class PluginSecrets extends Service implements PluginSecretsService {
  constructor(ctx: Context) {
    super(ctx, 'pluginSecrets');
  }

  private storageKey(key: unknown): string {
    return pluginSecretSettingsKey(callerPluginId(this.ctx, 'pluginSecrets'), checkKey(key));
  }

  async get(key: string): Promise<string | null> {
    return this.ctx.settings.getSecret(this.storageKey(key));
  }

  async set(key: string, value: string): Promise<void> {
    const storageKey = this.storageKey(key);
    if (typeof value !== 'string') throw new Error('PLUGIN_SECRET_VALUE_INVALID: value must be a string');
    if (value === '') {
      await this.ctx.settings.deleteSecret(storageKey);
      return;
    }
    await this.ctx.settings.saveSecret(storageKey, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.ctx.settings.deleteSecret(this.storageKey(key));
  }
}
