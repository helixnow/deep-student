import { expect, it } from 'vitest';
import { CloudStorageBase, BoundedMemoryBody, ensureDeclaredLenWithinBudget, ensureMemoryGetMatchesDeclaredLen, MEMORY_GET_BUDGET_EXCEEDED } from '../src/traits.ts';
import type { FileInfo } from '../api.ts';

class FixedBodyStorage extends CloudStorageBase {
  body = new Uint8Array(512).fill(7);
  present = true;
  providerName() { return 'fixed-body-test'; }
  async checkConnection() {}
  async put() {}
  async get() { return this.present ? this.body.slice() : null; }
  async list(): Promise<FileInfo[]> { return []; }
  async delete() {}
  async stat(): Promise<FileInfo | null> { return null; }
}

it('memory_get_accepts_matching_or_missing_length', () => {
  expect(() => ensureMemoryGetMatchesDeclaredLen('S3', 'a', 12, 12)).not.toThrow();
  expect(() => ensureMemoryGetMatchesDeclaredLen('WebDAV', 'a', 12, null)).not.toThrow();
});

it('memory_get_rejects_short_body_when_length_declared', () => {
  expect(() => ensureMemoryGetMatchesDeclaredLen('S3', 'changes/1', 4, 12)).toThrow('内存对象下载不完整或对象已变更');
  expect(() => ensureMemoryGetMatchesDeclaredLen('S3', 'changes/1', 4, 12)).toThrow('changes/1');
});

it('get_budget_small_chunks_flooding_aborts_and_buffer_stays_bounded', () => {
  const body = new BoundedMemoryBody('S3', 'manifests/flood.json', 1000);
  const chunk = new Uint8Array(100).fill(0x42);
  for (let i = 0; i < 10; i++) {
    body.push(chunk);
    expect(body.len()).toBeLessThanOrEqual(1000);
  }
  expect(body.len()).toBe(1000);
  expect(() => body.push(chunk)).toThrow(MEMORY_GET_BUDGET_EXCEEDED);
  expect(() => body.push(chunk)).toThrow('manifests/flood.json');
  expect(body.len()).toBe(1000);
});

it.each([
  ['Node Buffer', () => Buffer.from([1, 2, 3])],
  ['Buffer view', () => Buffer.from([0, 1, 2, 3, 255]).subarray(1, 4)],
  ['Uint8Array control', () => Uint8Array.from([1, 2, 3])],
] as const)('bounded memory body owns the copied bytes from %s', (_label, input) => {
  // traits.rs:273-276 extends its Vec from a borrowed slice. Both network
  // readers pass Buffer chunks, whose slice() aliases rather than copies.
  const body = new BoundedMemoryBody('WebDAV', 'snapshot', 3);
  const chunk = input();
  body.push(chunk);
  chunk.fill(9);
  expect([...body.intoBytes()]).toEqual([1, 2, 3]);
  expect(body.len()).toBe(3);
});

it('get_budget_rejects_oversized_declared_length_before_body', () => {
  expect(() => ensureDeclaredLenWithinBudget('WebDAV', 'changes/huge.bin', 18446744073709551615n, 4096)).toThrow(MEMORY_GET_BUDGET_EXCEEDED);
  expect(() => ensureDeclaredLenWithinBudget('WebDAV', 'changes/huge.bin', 18446744073709551615n, 4096)).toThrow('读取响应体前');
  expect(() => ensureDeclaredLenWithinBudget('S3', 'k', 4097, 4096)).toThrow(MEMORY_GET_BUDGET_EXCEEDED);
  expect(() => ensureDeclaredLenWithinBudget('S3', 'k', 4096, 4096)).not.toThrow();
});

it('get_budget_unknown_length_stream_aborts_over_budget', () => {
  expect(() => ensureDeclaredLenWithinBudget('WebDAV', 'chunked/no-len', null, 256)).not.toThrow();
  const body = new BoundedMemoryBody('WebDAV', 'chunked/no-len', 256);
  body.push(new Uint8Array(200));
  expect(() => body.push(new Uint8Array(200))).toThrow(MEMORY_GET_BUDGET_EXCEEDED);
  expect(body.len()).toBeLessThanOrEqual(256);
});

it('default_get_prefix_fails_closed', async () => {
  const storage = new FixedBodyStorage();
  expect(storage.supportsPrefixRead()).toBe(false);
  await expect(storage.getPrefix('backups/x.zip', 64)).rejects.toThrow('不支持对象前缀读取');
});

it('default_get_bounded_enforces_budget_for_test_doubles', async () => {
  const storage = new FixedBodyStorage();
  expect((await storage.getBounded('k', 512))!.length).toBe(512);
  await expect(storage.getBounded('k', 511)).rejects.toThrow(MEMORY_GET_BUDGET_EXCEEDED);
  const missing = new FixedBodyStorage();
  missing.present = false; missing.body = new Uint8Array();
  await expect(missing.getBounded('k', 1)).resolves.toBeNull();
});
