/**
 * Narrow test host for the E2EE suites: installs the real F7 `dstu.native`
 * plugin and passes its `ctx.nativeArgon2` to the public F4 backup factory,
 * the same wiring the official secrets instance uses. KDF parameters stay the
 * F4 defaults; the caller disposes the host after the suite.
 */
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createBackupCrypto, type BackupCrypto } from '../../../platform/secrets/api.ts';

export interface NativeBackupHost {
  host: TestHost;
  backup: BackupCrypto;
}

export async function createNativeBackupHost(): Promise<NativeBackupHost> {
  const host = await createTestHost({ app: { debug: false } });
  try {
    await host.install(native);
    return { host, backup: createBackupCrypto({ nativeArgon2: host.ctx.nativeArgon2 }) };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}
