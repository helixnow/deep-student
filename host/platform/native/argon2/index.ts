import { createRequire } from 'node:module';
import type { NativeArgon2 } from './api.ts';

interface Binding {
  hashRaw(password: Uint8Array, options: { salt: Uint8Array; memoryCost: number; timeCost: number;
    parallelism: number; outputLen: number; algorithm: 2; version: 1 }): Promise<Uint8Array>;
}

export const argon2: NativeArgon2 = {
  async deriveKey(password, salt, memoryKiB, iterations, parallelism, length = 32) {
    const binding = createRequire(import.meta.url)('@node-rs/argon2') as Binding;
    return binding.hashRaw(password, { salt, memoryCost: memoryKiB, timeCost: iterations,
      parallelism, outputLen: length, algorithm: 2, version: 1 });
  },
};
