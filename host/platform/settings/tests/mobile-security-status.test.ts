import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '../../crypto/web.ts';
import { createOpfsFiles, mobileRoots } from '../../files/opfs.ts';
import { createFakeOpfs } from '../../files/tests/__fixtures__/fake-opfs.ts';
import { createMobileSecrets } from '../../secrets/mobile.ts';
import { getMobileSecurityStatus } from '../mobile-security-status.ts';

const dataDir = '/app';
const slot = `${dataDir}/slots/slotA`;

function setup() {
  const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(dataDir) });
  const openStore = () => createMobileSecrets(files, createWebCrypto(), dataDir).openStore(slot);
  return { files, openStore };
}

describe('mobile security status', () => {
  it('reports the existing encrypted settings without creating key material or exposing credential values', async () => {
    const { files, openStore } = setup();
    expect(await getMobileSecurityStatus(openStore())).toMatchObject({
      keychain_available: false, storage_kind: 'private_files',
      migration_completed: null, last_migration_time: null, sensitive_keys_count: 0,
    });
    expect(await files.exists(`${slot}/.secure`)).toBe(false);

    const store = openStore();
    await store.saveSecret('web_search.api_key.tavily', 'test-credential');
    await files.mkdir(`${slot}/.secure/not-a-record.enc`, { recursive: true });
    const status = await getMobileSecurityStatus(openStore());
    expect(status.sensitive_keys_count).toBe(1);
    expect(JSON.stringify(status)).not.toMatch(/tavily|test-credential/);
  });

  it('surfaces storage inspection errors rather than reporting zero records', async () => {
    const { files, openStore } = setup();
    await files.writeAtomic(`${slot}/.secure`, 'not a directory', { createParents: true });
    await expect(getMobileSecurityStatus(openStore())).rejects.toMatchObject({ kind: 'NotADirectory' });
  });
});
