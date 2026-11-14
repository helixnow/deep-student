import type { ProviderTombstoneStorage, TombstoneStorage } from '../api.ts';

/** 保留首发接口的 snake_case，转发至 L23 已发布的 camelCase 接口。 */
export function adaptTombstoneStorage(storage: ProviderTombstoneStorage): TombstoneStorage {
  return {
    instance_binding_hint: () => storage.instanceBindingHint(),
    list_outcome: prefix => storage.listOutcome(prefix),
    put: (key, data) => storage.put(key, data),
    get: key => storage.get(key),
    delete: key => storage.delete(key),
    stat: key => storage.stat(key),
  };
}
