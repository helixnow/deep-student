import type { SyncStateStore } from '../../sync-support/api.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * R10 混沌测试共用的内存同步状态与可篡改 CloudStorage。
 *
 * `SyncStateStore` 的语义与生产 `sync_state` 表一致：上传序列单调递增、
 * 下载游标按设备持久化、legacy 对象只处理一次。这里只替换存储介质，
 * 不复制被测的下载/应用算法。
 */
export interface MemorySyncState {
  readonly state: SyncStateStore;
  readonly cursors: Map<string, bigint>;
}

export function createMemorySyncState(): MemorySyncState {
  const cursors = new Map<string, bigint>();
  const legacy = new Set<string>();
  let localNext = 1n;
  const state: SyncStateStore = {
    bindInstance: () => undefined,
    getTombstoneWatermark: () => 0n,
    setTombstoneWatermark: () => undefined,
    reserveTombstoneEventSeq: (_instance, _device, _kind, _operation, cloudMax) => cloudMax + 1n,
    reserveTombstoneEventSeqWithExisting: (_instance, _device, _kind, _operation, cloudMax, existing) =>
      (existing ?? cloudMax) + 1n,
    deviceRotationsForNew: () => [],
    nextUploadSeq: (_instance, _device, cloudMax) => {
      const seq = localNext > cloudMax ? localNext : cloudMax + 1n;
      localNext = seq + 1n;
      return seq;
    },
    markPublishedSeq: () => undefined,
    publishedMaxSeq: () => 0n,
    getCursor: (_instance, device) => cursors.get(device) ?? 0n,
    setCursor: (_instance, device, seq) => { cursors.set(device, seq); },
    cursors: () => new Map(cursors),
    isLegacyProcessed: (_instance, key) => legacy.has(key),
    markLegacyProcessed: (_instance, key) => { legacy.add(key); },
    recordDeviceRotation: () => undefined,
    resetDefaultAfterLocalPurge: () => { cursors.clear(); legacy.clear(); },
  };
  return { state, cursors };
}

/** LIST 撒谎但 GET/STAT 仍能读到对象：模拟分页丢条目的静默截断。 */
export class HiddenListCloud extends MemoryCloud {
  private readonly hidden = new Set<string>();

  hide(key: string): void { this.hidden.add(key); }
  unhide(key: string): void { this.hidden.delete(key); }

  override async list(prefix: string) {
    return (await super.list(prefix)).filter(file => !this.hidden.has(file.key));
  }
}
