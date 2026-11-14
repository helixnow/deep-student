#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deriveKey, encryptBackupWithKey } from '../../../host/platform/secrets/backup-crypto.ts';

// Deterministic ciphertext INPUTS from the production TS writer. Expected outputs
// still come from executing the independent Rust decrypt/check APIs after approval.
const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const nonce = Buffer.from('00112233445566778899aabb', 'hex');
const vectors = [];
for (const [index, password] of ['fixture-only', '中文🙂'].entries()) {
  const plaintext = Buffer.concat([Buffer.from(`fixture ${index}\0中文🙂`), Buffer.from([0, 255])]);
  const key = await deriveKey(password, salt, 8, 1, 1);
  try {
    const data = encryptBackupWithKey(plaintext, salt, 8, 1, 1, key, nonce);
    const add = (suffix, fn, args) => vectors.push({ id: `crypto-input:${index}:${suffix}`, lane: 'F4-security', fn, args });
    add('decrypt', 'crypto.decryptBackup', { password, hex: data.toString('hex') });
    add('wrong-password', 'crypto.decryptBackup', { password: `${password}-wrong`, hex: data.toString('hex') });
    const corrupt = Buffer.from(data); corrupt[corrupt.length - 1] ^= 1;
    add('tag-corrupt', 'crypto.decryptBackup', { password, hex: corrupt.toString('hex') });
    const digest = createHash('sha256').update('deep-student.encryption-marker.verifier.v1').update(key).digest('hex');
    const verifier = { kdf: 'argon2id', mCost: 8, tCost: 1, pCost: 1, salt: salt.toString('hex'), digest };
    add('verifier', 'crypto.checkVerifier', { password, verifier });
    add('verifier-wrong', 'crypto.checkVerifier', { password: `${password}-wrong`, verifier });
  } finally { key.fill(0); }
}
await writeFile('fixtures/differential/crypto-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
console.log(`prepared ${vectors.length} deterministic KDF/AES/verifier inputs; no Rust execution or expected outputs`);
