import { gcm } from '@noble/ciphers/aes';

/**
 * AES-256-GCM for Sync V5 objects: 16-byte tag, sealed bytes are `ciphertext ‖ tag`.
 *
 * The default is pure JS (`@noble/ciphers`) so the mobile entry needs no Node module. It runs at
 * roughly a tenth of OpenSSL's speed, so the desktop entry injects `aes-gcm.node.ts`; both produce
 * identical bytes (`tests/aes-gcm.test.ts`).
 */
export interface AesGcm {
  seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Throws when the tag does not authenticate. */
  open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array;
}

export const portableAesGcm: AesGcm = {
  seal: (key, nonce, aad, plaintext) => gcm(key, nonce, aad).encrypt(plaintext),
  open: (key, nonce, aad, sealed) => gcm(key, nonce, aad).decrypt(sealed),
};

let active: AesGcm = portableAesGcm;

/** 入口注入平台实现；`null` 恢复纯 JS 缺省。 */
export function setAesGcm(port: AesGcm | null): void {
  active = port ?? portableAesGcm;
}

export function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return active.seal(key, nonce, aad, plaintext);
}

export function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  return active.open(key, nonce, aad, sealed);
}
