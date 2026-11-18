import { CommandError, type Context } from '../../kernel/api.ts';
import { SecureStoreError } from './errors.ts';
import type { CloudStorageCredentials } from './api.ts';


export const cloudCredentialCommands = ['secure_save_cloud_credentials', 'secure_get_cloud_credentials', 'secure_delete_cloud_credentials', 'secure_clear_cloud_encryption_password'] as const;
export function cloudCommandAccess(ctx: Context) {
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
  return { store, mapped, serial };
}

export function registerCloudCredentialCommands(ctx: Context, { store, mapped, serial } = cloudCommandAccess(ctx)) {
  ctx.commands.register('secure_save_cloud_credentials', (args) => serial(() => mapped('save_cloud_credentials', () => {
    const input = args.credentials as Record<string, string | null>;
    const credentials: CloudStorageCredentials = {};
    for (const key of ['webdavPassword', 's3SecretAccessKey', 'ftpPassword', 'encryptionPassword'] as const) if (input[key] != null) credentials[key] = input[key];
    return store.updateCloudCredentials(credentials, args.encryptionPasswordIsPreexisting === true);
  })));
  ctx.commands.register('secure_get_cloud_credentials', () => serial(() => mapped('get_cloud_credentials', () => store.cloudCredentialStatus())));
  ctx.commands.register('secure_delete_cloud_credentials', () => serial(() => mapped('delete_cloud_credentials', () => store.deleteCloudCredentials())));
  ctx.commands.register('secure_clear_cloud_encryption_password', () => serial(() => mapped('clear_cloud_encryption_password', () => store.clearCloudEncryptionPassword())));
}
