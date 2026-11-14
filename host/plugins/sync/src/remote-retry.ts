/** mod.rs:132-163: bounded outer attempts, never retry explicit cloud rate limits. */
import { isCloudRateLimited } from '../../sync-providers/api.ts';
import { SyncError } from './errors.ts';
import type { SyncLogger } from './log.ts';

const delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export async function retryRemote<T>(name: string, attempts: number, action: () => Promise<T>, logger?: SyncLogger | null): Promise<T> {
  let last: unknown = new SyncError(`Network error: ${name}: 未知错误`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); }
    catch (error) {
      last = error;
      const text = error instanceof Error ? error.message : String(error);
      if (isCloudRateLimited(text)) throw error;
      if (attempt + 1 < attempts) {
        const ms = 500 * 2 ** attempt;
        logger?.warn(`[Sync] ${name} 重试 ${attempt + 1}/${attempts}: ${text}（等待 ${ms}ms）`);
        await delay(ms);
      }
    }
  }
  throw last;
}
