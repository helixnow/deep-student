/**
 * 内存版 `TombstoneStorage`（Rust 测试 `MemoryStorage` 的等价物）。
 *
 * 只实现 tombstone 模块需要的最小面：put/get/list/delete/stat。可注入
 * “清单 PUT 损坏/失败”以模拟回读闸与撕裂双写窗口。
 */
import type { TombstoneListOutcome, TombstoneStorage } from '../api.ts';

export type PutBehavior = 'normal' | 'corrupt-manifest' | 'fail-manifest' | 'drop-manifest';

export class MemoryStorage implements TombstoneStorage {
  readonly files = new Map<string, Uint8Array>();
  behavior: PutBehavior = 'normal';
  /** 记录每次 PUT 的 key，便于断言“重试不重复写事件”。 */
  readonly puts: string[] = [];

  instanceBindingHint(): string {
    return 'memory-test';
  }

  instance_binding_hint(): string {
    return this.instanceBindingHint();
  }

  list_outcome(prefix: string): Promise<TombstoneListOutcome> {
    return this.listOutcome(prefix);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.puts.push(key);
    if (key.startsWith('data_governance/tombstones/') && this.behavior !== 'normal') {
      if (this.behavior === 'fail-manifest') {
        throw new Error('注入：每设备 tombstone 清单 PUT 失败（撕裂双写窗口）');
      }
      if (this.behavior === 'drop-manifest') return;
      this.files.set(key, new Uint8Array(Buffer.from('corrupted-tombstone-manifest', 'utf8')));
      return;
    }
    this.files.set(key, new Uint8Array(data));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.files.get(key);
    return value === undefined ? null : new Uint8Array(value);
  }

  async listOutcome(prefix: string): Promise<TombstoneListOutcome> {
    const files = [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => ({ key, size: value.length }));
    return { files, truncated: false };
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async stat(key: string): Promise<{ key: string; size: number } | null> {
    const value = this.files.get(key);
    return value === undefined ? null : { key, size: value.length };
  }
}
