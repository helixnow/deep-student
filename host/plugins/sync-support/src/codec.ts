/**
 * `tombstone.rs:48-64` `PayloadCodec` / `PlainCodec`。
 *
 * `SyncManager` 在有 E2EE 密码时提供走 DSBK 容器的实现；`plainCodec` 保留明文行为
 * （单元测试与向后兼容场景）。
 */
import type { SyncPayloadCodec } from '../api.ts';
export type { PayloadCodec, SyncPayloadCodec, AsyncPayloadCodec } from '../api.ts';

export const plainCodec: SyncPayloadCodec = {
  encode: plaintext => plaintext,
  decode: data => data,
};
