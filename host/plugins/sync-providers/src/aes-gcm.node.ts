/** Desktop AES-256-GCM (`node:crypto`, OpenSSL); injected by `index.ts`. Same bytes as the portable default. */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { AesGcm } from './aes-gcm.ts';

const TAG_BYTES = 16;

function plain(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export const nodeAesGcm: AesGcm = {
  seal(key, nonce, aad, plaintext) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return plain(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  open(key, nonce, aad, sealed) {
    if (sealed.length < TAG_BYTES) throw new Error('AES-GCM input is shorter than the authentication tag');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return plain(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]));
  },
};
