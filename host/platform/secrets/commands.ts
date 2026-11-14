import { CommandError, type Context } from '../../kernel/api.ts';
import { SecureStoreError, type CloudStorageCredentials } from './api.ts';
import { SecretPromptStore, secretPromptCapabilities, submitSecretPrompt } from './secret-prompt.ts';

export function registerCommands(ctx: Context) {
  const store = ctx.secrets.openStore(ctx.app.dataDir);
  const mapped = async <T>(operation: string, run: () => Promise<T>) => {
    try { return await run(); } catch (error) {
      if (error instanceof SecureStoreError) throw new CommandError(error.toCommandError(operation));
      throw error;
    }
  };
  // Rust synchronous secure commands execute serially. Preserve that across asynchronous filesystem calls.
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = pending.then(run, run);
    pending = result;
    return result;
  };
  ctx.commands.register('secure_save_cloud_credentials', (args) => serial(() => mapped('save_cloud_credentials', () => {
    const input = args.credentials as Record<string, string | null>;
    const credentials: CloudStorageCredentials = {};
    for (const key of ['webdavPassword', 's3SecretAccessKey', 'ftpPassword', 'encryptionPassword'] as const) if (input[key] != null) credentials[key] = input[key];
    return store.updateCloudCredentials(credentials, args.encryptionPasswordIsPreexisting === true);
  })));
  ctx.commands.register('secure_get_cloud_credentials', () => serial(() => mapped('get_cloud_credentials', () => store.cloudCredentialStatus())));
  ctx.commands.register('secure_delete_cloud_credentials', () => serial(() => mapped('delete_cloud_credentials', () => store.deleteCloudCredentials())));
  ctx.commands.register('secure_clear_cloud_encryption_password', () => serial(() => mapped('clear_cloud_encryption_password', () => store.clearCloudEncryptionPassword())));
  ctx.commands.register('secure_store_is_available', () => serial(() => store.isAvailable()));
  ctx.commands.register('secure_store_get_keystore_protection', () => serial(() => mapped('get_keystore_protection', () => store.keystoreProtectionStatus())));
  ctx.commands.register('secure_store_set_keystore_protection', ({ enabled }) => serial(async () => {
    await mapped('set_keystore_protection', () => store.setKeystoreProtection(enabled as boolean));
    return mapped('get_keystore_protection', () => store.keystoreProtectionStatus());
  }));
  const prompts = new SecretPromptStore();
  ctx.effect(() => () => prompts.dispose());
  ctx.commands.register('secret_prompt_submit', submitSecretPrompt);
  ctx.commands.register('secret_prompt_status', ({ handleId }) => ({ available: prompts.contains(handleId as string), consumerAvailable: false, reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE' }));
  ctx.commands.register('secret_prompt_discard', ({ handleId }) => prompts.discard(handleId as string));
  ctx.commands.register('secret_prompt_capabilities', secretPromptCapabilities);
}
