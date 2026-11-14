import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';
import { DSBK_GCM_TAG_LEN, DSBK_V2_HEADER_LEN, STREAM_PLAINTEXT_CHUNK } from '../backup-crypto.ts';

// P04: backup_crypto.rs:628-741 takes `object_len: u64`; the public chain must accept the exact value.
const U64_MAX = (1n << 64n) - 1n;
const ABOVE_2_53 = (1n << 53n) + 1n;
const FULL_PREFIX = DSBK_V2_HEADER_LEN + STREAM_PLAINTEXT_CHUNK + DSBK_GCM_TAG_LEN;

let host: TestHost;
let dir: string;
let multi: Buffer;
let single: Buffer;

async function encrypt(len: number): Promise<Buffer> {
  const input = join(dir, `in-${len}`), output = join(dir, `enc-${len}`);
  await writeFile(input, Buffer.from(Array.from({ length: len }, (_, i) => i % 251)));
  const session = await host.ctx.secrets.backup.createFileCipherSession('u64-pw', { mCost: 8, tCost: 1, pCost: 1 });
  try { await session.encryptFile(input, output); } finally { session.dispose(); }
  return readFile(output);
}

beforeAll(async () => {
  host = await createTestHost();
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  await host.install(secrets);
  dir = await mkdtemp(join(tmpdir(), 'f4-u64-'));
  multi = await encrypt(STREAM_PLAINTEXT_CHUNK * 2 + 7);
  single = await encrypt(100);
});
afterAll(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }); });

it('P04 speculative prefix clamps exact u64 lengths to the bounded prefix', () => {
  const bc = host.ctx.secrets.backup;
  for (const len of [ABOVE_2_53 - 2n, ABOVE_2_53, U64_MAX]) expect(bc.dsbkFirstChunkSpeculativePrefixLen(len)).toBe(FULL_PREFIX);
  expect(bc.dsbkFirstChunkSpeculativePrefixLen(100n)).toBe(100);
  expect(bc.dsbkFirstChunkSpeculativePrefixLen(100)).toBe(100);
});

it('P04 plan_first_chunk_trial matches Rust for lengths above 2^53 and at u64::MAX', () => {
  const bc = host.ctx.secrets.backup;
  for (const len of [ABOVE_2_53, U64_MAX]) expect(bc.planFirstChunkTrial(multi, len)).toEqual({ kind: 'StreamV2', prefixLen: FULL_PREFIX });
  expect(bc.planFirstChunkTrial(multi, BigInt(multi.length))).toEqual(bc.planFirstChunkTrial(multi, multi.length));
  // Rust checked_sub/filter error path keeps the exact decimal length.
  expect(() => bc.planFirstChunkTrial(multi, BigInt(DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN - 1)))
    .toThrow(`加密备份缺少数据块（对象总长 ${DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN - 1} 字节，装不下 v2 头 + GCM tag）`);
});

it('P04 trial_decrypt_first_chunk derives the final flag from the exact u64 length', async () => {
  const bc = host.ctx.secrets.backup;
  const prefix = multi.subarray(0, FULL_PREFIX);
  // First chunk of a multi-chunk object is non-final: any larger object_len still proves the password.
  for (const len of [BigInt(multi.length), ABOVE_2_53, U64_MAX]) await bc.trialDecryptFirstChunk(prefix, len, 'u64-pw');
  await expect(bc.trialDecryptFirstChunk(prefix, U64_MAX, 'wrong-pw')).rejects.toThrow('备份解密失败（密码错误或数据损坏）');
  // A single-chunk object claimed to be huge needs header+1MiB+tag bytes: Rust returns 前缀不足 (:700-705).
  await bc.trialDecryptFirstChunk(single, BigInt(single.length), 'u64-pw');
  for (const len of [ABOVE_2_53, U64_MAX]) {
    await expect(bc.trialDecryptFirstChunk(single, len, 'u64-pw'))
      .rejects.toThrow(`对象前缀不足以覆盖首个密文块：需要 ${FULL_PREFIX} 字节，实得 ${single.length} 字节`);
  }
  // With a long enough prefix the final flag is wrong (is_final=false) and the tag fails.
  const padded = Buffer.concat([single, Buffer.alloc(FULL_PREFIX - single.length)]);
  await expect(bc.trialDecryptFirstChunk(padded, U64_MAX, 'u64-pw')).rejects.toThrow('备份解密失败（密码错误或数据损坏）');
});

it('P04 inexact number and out-of-range bigint are rejected instead of rounded', async () => {
  const bc = host.ctx.secrets.backup;
  for (const len of [2 ** 53, Number.MAX_VALUE, -1, 1.5, Number.NaN]) {
    expect(() => bc.planFirstChunkTrial(multi, len)).toThrow(RangeError);
    expect(() => bc.dsbkFirstChunkSpeculativePrefixLen(len)).toThrow(RangeError);
  }
  for (const len of [-1n, U64_MAX + 1n]) {
    expect(() => bc.planFirstChunkTrial(multi, len)).toThrow(RangeError);
    await expect(bc.trialDecryptFirstChunk(multi, len, 'u64-pw')).rejects.toThrow(RangeError);
  }
});
