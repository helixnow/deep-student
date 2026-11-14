/** Fixed F4 vectors only: no round-trip-generated ciphertext is used as evidence. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { services } from './__tests__/host.ts';
import { cleanup, tempDir } from './__fixtures__/fixtures.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });
function setup() { const dir = tempDir(); dirs.push(dir); return { dir, ...services(dir) }; }

it('F4 vectors.test.ts: existing v3 seed + .enc decrypt through the public SecureStore', async () => {
  const { dir, secrets } = setup();
  mkdirSync(join(dir, '.secure'));
  writeFileSync(join(dir, '.secure/.key_seed'), 'ab'.repeat(32));
  writeFileSync(join(dir, '.secure/builtin-openai.api_key.enc'), Buffer.from(
    '000102030405060708090a0b9f870e11e858940c8c90a12532d8566f494046effe43d0bfc7d9379222ef5a429703', 'hex'));
  expect(await secrets.openStore(dir).getSecret('builtin-openai.api_key')).toBe('sk-test-secret-值');
});

it('F4 vectors.test.ts: old .master_key file decrypts the exact EncryptedData bytes', async () => {
  const { dir, secrets } = setup();
  writeFileSync(join(dir, '.master_key'), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n');
  const crypto = await secrets.openCrypto(dir);
  expect(crypto.decryptApiKey({ ciphertext: 'NGn7b6CWtjbsMf6m2owBQLLktADF5P1edSxR7Gi6YKcPlKdXfQ==', nonce: 'AAECAwQFBgcICQoL', version: 2 })).toBe('sk-test-api-key-12345');
  expect(crypto.keyFingerprint).toBe('630dcd29');
});

it('F4 vectors.test.ts: pre-v2 base64 plaintext format remains readable', async () => {
  const { dir, secrets } = setup();
  writeFileSync(join(dir, '.master_key'), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
  const crypto = await secrets.openCrypto(dir);
  expect(crypto.decryptApiKey({ ciphertext: 'bGVnYWN5', nonce: '', version: null })).toBe('legacy');
});

it('F4 backup-crypto.test.ts: fixed DSBK v1 archive decrypts (production KDF parameters)', async () => {
  const { secrets } = setup();
  const vector = Buffer.from('4453424b0100000100030000000400000007070707070707070707070707070707000102030405060708090a0b23f2c6510cc9cfec607a867c3ddd216ae244d9eb789081723128f0d51d7434da4d9f', 'hex');
  expect(Buffer.from(await secrets.backup.decryptBackup(vector, 'pw-vector')).toString('utf8')).toBe('hello backup world');
}, 120_000);

it('F4 backup-crypto.test.ts: fixed DSBK v2 streaming archive decrypts (production KDF parameters)', async () => {
  const { dir, secrets } = setup();
  const input = join(dir, 'old.dsbk'), output = join(dir, 'old.zip');
  writeFileSync(input, Buffer.from('4453424b0200000100030000000400000007070707070707070707070707070707aaaaaaaaaaaaaa00001000f6bdd95a3155ef588c2e94c3d79e8c2fb7091b543b77a8397976ee45c90801e0cedb', 'hex'));
  await secrets.backup.decryptBackupFile(input, output, 'pw-vector');
  expect(readFileSync(output, 'utf8')).toBe('hello backup world');
}, 120_000);
