/**
 * Argon2id v0x13 for mobile / Web, where the `@node-rs/argon2` addon cannot
 * load: `@noble/hashes` (pure JS, already a root dependency) yields the same
 * raw bytes. It is far slower than the native addon at DSBK parameters, so
 * hosts should call it from a Web Worker.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import type { NativeArgon2 } from './api.ts';

export const webArgon2: NativeArgon2 = {
  async deriveKey(password, salt, memoryKiB, iterations, parallelism, length = 32) {
    return argon2idAsync(password, salt, { m: memoryKiB, t: iterations, p: parallelism, dkLen: length, version: 0x13 });
  },
};
