import { argon2idAsync } from '@noble/hashes/argon2.js';
import type { CryptoService } from '../crypto/api.ts';
import { decryptDsbkStream, encryptDsbkStream, type DsbkKeyFor, type DsbkStreamDeps } from '../secrets/dsbk-stream.ts';

export async function sealBackupSecrets(
  crypto: CryptoService, password: string, input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, encrypt: boolean,
): Promise<void> {
  const secret = new TextEncoder().encode(password);
  let derived: Uint8Array | undefined;
  const keyFor: DsbkKeyFor = async (salt, m, t, p) => {
    return derived = await deriveMobileBackupKey(secret, salt, m, t, p);
  };
  const deps = mobileDsbkDeps(crypto);
  try {
    if (encrypt) await encryptDsbkStream(input, output, { salt: crypto.randomBytes(16), m: 65536, t: 3, p: 4 }, keyFor, deps);
    else await decryptDsbkStream(input, output, keyFor, deps);
  } finally {
    secret.fill(0);
    derived?.fill(0);
  }
}

export function mobileDsbkDeps(crypto: CryptoService): DsbkStreamDeps {
  return {
    randomBytes: length => crypto.randomBytes(length),
    aead: {
      seal: (key, iv, plaintext) => crypto.aesGcmEncrypt({ key, iv, plaintext }),
      open: async (key, iv, ciphertext) => {
        try { return await crypto.aesGcmDecrypt({ key, iv, ciphertext }); }
        catch { return null; }
      },
    },
  };
}

export async function deriveMobileBackupKey(secret: Uint8Array, salt: Uint8Array, m: number, t: number, p: number) {
  if (![m, t, p].every(Number.isSafeInteger) || m < 8 * p || m > 256 * 1024 || t < 1 || t > 10 || p < 1 || p > 8) throw new Error('Unsupported backup Argon2id parameters');
  return argon2idAsync(secret, salt, { m, t, p, dkLen: 32, version: 0x13 });
}
