import type { CryptoService, Hasher } from '../../../platform/crypto/api.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';

/**
 * SHA-256 for checksums and content addressing. The plugin installs a lookup of `ctx.crypto`
 * (native hashing on desktop); when the service is absent (unit tests, tools, hosts that do not
 * install `dstu.platform.crypto`) the portable WebCrypto/noble implementation produces identical digests.
 */
let lookup: (() => CryptoService | undefined) | null = null;
let portable: CryptoService | null = null;

export function setCryptoLookup(next: (() => CryptoService | undefined) | null): void {
  lookup = next;
}

function service(): CryptoService {
  return lookup?.() ?? (portable ??= createWebCrypto());
}

export function sha256Hasher(): Hasher {
  return service().createHasher('SHA-256');
}

export function sha256Hex(data: Uint8Array | string): string {
  return sha256Hasher().update(data).digestHex();
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256Hasher().update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return service().hmacSync('SHA-256', key, data);
}

export function randomBytes(length: number): Uint8Array {
  return service().randomBytes(length);
}
