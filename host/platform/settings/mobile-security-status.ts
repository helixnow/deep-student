import type { SecureStore } from '../secrets/api.ts';
import { toRfc3339 } from '../time/index.ts';

/** Read metadata only: opening this panel must not initialize or read credential values. */
export async function getMobileSecurityStatus(store: Pick<SecureStore, 'keystoreProtectionStatus' | 'listSensitiveKeys'>) {
  const [protection, keys] = await Promise.all([
    store.keystoreProtectionStatus(),
    store.listSensitiveKeys(),
  ]);

  return {
    keychain_available: protection.supported,
    storage_kind: 'private_files' as const,
    // settings.getSecret migrates legacy values individually; there is no recorded
    // global migration result or time.
    migration_completed: null,
    last_migration_time: null,
    sensitive_keys_count: keys.size,
    timestamp: toRfc3339(),
  };
}
