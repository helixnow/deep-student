export interface NativeArgon2 {
  /** Raw Argon2id v0x13, no secret/AD. F4 owns DSBK parameter validation/error wrapping. */
  deriveKey(password: Uint8Array, salt: Uint8Array, memoryKiB: number, iterations: number,
    parallelism: number, length?: number): Promise<Uint8Array>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeArgon2: NativeArgon2 }
}
