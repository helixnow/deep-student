/**
 * 模型配置快照（api 配置 / 厂商 / 模型分配）的共享读取层。
 *
 * 打开聊天面板时 `ModelPicker` / `RuntimeModelMenu` / `ModelPanel` 各自都会读同一组
 * 三份数据，此前每个组件内部还是「配置 → 厂商 → 分配」串行 await：
 * 一次打开最多 9 次往返，公网 RTT 150–250ms 下累计 1–2 秒。
 *
 * 这里做两件事：
 * - 三条命令 `Promise.all` 并发（单组件从 3 个串行 RTT 降到 1 个）；
 * - 3 秒 TTL + in-flight 去重，多个面板同时挂载时共享同一轮请求。
 *
 * 保存类事件（`api_configurations_changed` / `model_assignments_changed`）在
 * `invalidateModelConfigSnapshot()` 里清空，调用方 reload 时传 `force: true`。
 */

import { invoke } from '@tauri-apps/api/core';

export interface ModelConfigSnapshot<TConfig = unknown, TVendor = unknown> {
  configs: TConfig[];
  vendorConfigs: TVendor[];
  assignments: Record<string, string | null>;
}

interface CachedSnapshot extends ModelConfigSnapshot {
  loadedAt: number;
}

/** 同一轮往返里三份配置足够一致；超过这个时间就重新取，避免设置页改完迟迟不生效。 */
const SNAPSHOT_TTL_MS = 3_000;

let cachedSnapshot: CachedSnapshot | null = null;
let inFlight: Promise<CachedSnapshot> | null = null;

/** 配置/分配发生变更后调用：下一次读取重新走 IPC。 */
export function invalidateModelConfigSnapshot(): void {
  cachedSnapshot = null;
  inFlight = null;
}

function isFresh(snapshot: CachedSnapshot | null): snapshot is CachedSnapshot {
  return snapshot !== null && Date.now() - snapshot.loadedAt <= SNAPSHOT_TTL_MS;
}

export function loadModelConfigSnapshot<TConfig = unknown, TVendor = unknown>(
  options: { force?: boolean } = {},
): Promise<ModelConfigSnapshot<TConfig, TVendor>> {
  if (!options.force && isFresh(cachedSnapshot)) {
    return Promise.resolve(cachedSnapshot as ModelConfigSnapshot<TConfig, TVendor>);
  }
  if (inFlight) {
    return inFlight as Promise<ModelConfigSnapshot<TConfig, TVendor>>;
  }

  // 单条命令失败不影响另外两条：与各组件原先的分段 catch 语义一致
  // （厂商/分配失败留空，配置失败按空列表处理）。
  const batch = Promise.all([
    invoke<TConfig[]>('get_api_configurations').catch(() => [] as TConfig[]),
    invoke<TVendor[]>('get_vendor_configs').catch(() => [] as TVendor[]),
    invoke<Record<string, string | null>>('get_model_assignments').catch(
      () => ({}) as Record<string, string | null>,
    ),
  ]).then(([configs, vendorConfigs, assignments]) => {
    const next: CachedSnapshot = {
      configs: configs ?? [],
      vendorConfigs: vendorConfigs ?? [],
      assignments: assignments ?? {},
      loadedAt: Date.now(),
    };
    cachedSnapshot = next;
    return next;
  });

  inFlight = batch;
  void batch.finally(() => {
    if (inFlight === batch) inFlight = null;
  }).catch(() => undefined);
  return batch as Promise<ModelConfigSnapshot<TConfig, TVendor>>;
}
