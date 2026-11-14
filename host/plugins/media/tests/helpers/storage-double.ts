import type { StorageService } from '../../../../platform/storage/api.ts';

/**
 * `media` injects `storage` (WP-279) because ASR/voice usage and the recent-document
 * command write through `ctx.storage.database(...)`. Hosts that never exercise those
 * paths still have to satisfy the required injection, so this double fails loudly on
 * any use instead of handing back fabricated rows.
 */
export function unusedStorage(): StorageService {
  const fail = (property: string): never => {
    throw new Error(`media test host accessed storage.${property} without a real storage service`);
  };
  return new Proxy({} as StorageService, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => fail(String(property));
    },
  });
}
