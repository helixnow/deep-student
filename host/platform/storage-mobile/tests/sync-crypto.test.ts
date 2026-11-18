import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '../../crypto/web.ts';
import { createOpfsFiles, mobileRoots } from '../../files/opfs.ts';
import { createFakeOpfs } from '../../files/tests/__fixtures__/fake-opfs.ts';
import { createBackupCrypto } from '../../secrets/backup-crypto.ts';
import { DSBK_V1_DEFAULT_HEX, DSBK_V2_DEFAULT_HEX } from '../../secrets/tests/dsbk-fixed-vectors.ts';
import { createMobileSyncCrypto } from '../sync-crypto.ts';

function mobile() {
  return createMobileSyncCrypto(createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') }), createWebCrypto());
}
describe('mobile WebDAV encryption compatibility', () => {
  it('reads the established v1 and v2 backup vectors', async () => {
    const crypto = mobile();
    for (const vector of [DSBK_V1_DEFAULT_HEX, DSBK_V2_DEFAULT_HEX]) {
      expect(new TextDecoder().decode(await crypto.decryptBackup(Buffer.from(vector, 'hex'), 'pw-vector'))).toBe('hello backup world');
    }
  });
  it('preserves the bytes and authenticates data in both directions', async () => {
    const phone = mobile(), desktop = createBackupCrypto();
    const options = { mCost: 32, tCost: 2, pCost: 1 };
    const a = await phone.createFileCipherSession('round-trip', options);
    const b = await desktop.createFileCipherSession('round-trip', options);
    try {
      const data = new Uint8Array([0, 34, 255]);
      expect(new Uint8Array(await b.decryptBytes(await a.encryptBytes(data)))).toEqual(data);
      const ciphertext = await b.encryptBytes(data);
      expect(await a.decryptBytes(ciphertext)).toEqual(data);
      ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
      await expect(a.decryptBytes(ciphertext)).rejects.toThrow();
    } finally { a.dispose(); b.dispose(); }
  });
});
