import { randomUUID } from 'node:crypto';
import { CommandError } from '../../kernel/api.ts';
import type { SecretPromptHandle } from '../../../contracts/ipc/generated/F4-security.ts';

/** dstu-platform/secret_prompt.rs: memory-only, monotonic TTL, consume removes even on mismatch. */
export class SecretPromptStore {
  private entries = new Map<string, { purpose: string; secret: Buffer; expiresAt: number }>();
  private prune() {
    const now = performance.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.discard(id);
  }
  insert(purpose: string, secret: string, ttlSeconds: number): SecretPromptHandle {
    const now = performance.now();
    const handleId = `secret_prompt:${randomUUID()}`;
    this.prune();
    this.entries.set(handleId, { purpose, secret: Buffer.from(secret), expiresAt: now + ttlSeconds * 1000 });
    return { handleId, purpose, expiresInSeconds: ttlSeconds, memoryOnly: true, oneShot: true, consumerAvailable: false };
  }
  consume(id: string, purpose: string): Buffer {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new Error('SECRET_PROMPT_NOT_FOUND_OR_EXPIRED');
    this.entries.delete(id);
    if (entry.purpose !== purpose) {
      entry.secret.fill(0);
      throw new Error('SECRET_PROMPT_PURPOSE_MISMATCH');
    }
    return entry.secret;
  }
  discard(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.secret.fill(0);
    return this.entries.delete(id);
  }
  contains(id: string): boolean { this.prune(); return this.entries.has(id); }
  dispose(): void { for (const id of this.entries.keys()) this.discard(id); }
}
/** Rust currently rejects before purpose/secret validation: preserve this observable behavior. */
export function submitSecretPrompt(): never { throw new CommandError('DECRYPTOR_INTEGRATION_UNAVAILABLE'); }
export function secretPromptCapabilities() {
  return { memoryOnly: true, oneShot: true, defaultTtlSeconds: 300, maxTtlSeconds: 600, chatToolAvailable: false,
    decryptorIntegration: { available: false, reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE' } };
}
