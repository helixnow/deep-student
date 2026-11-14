import { createRequire } from 'node:module';

/**
 * Root dependencies requested from the architect but not yet in package.json
 * (tiktoken, @node-rs/argon2; see NEEDS.md). Tests that need one
 * skip only while it cannot be resolved from the consuming module, so they run
 * unchanged wherever the package is installed. A skip is not a pass.
 */
export function dependencyMissing(name: string, consumer: URL): boolean {
  try {
    createRequire(consumer).resolve(name);
    return false;
  } catch {
    return true;
  }
}

export const tiktokenMissing = dependencyMissing('tiktoken', new URL('../tokenizer/index.ts', import.meta.url));
export const argon2Missing = dependencyMissing('@node-rs/argon2', new URL('../argon2/index.ts', import.meta.url));
