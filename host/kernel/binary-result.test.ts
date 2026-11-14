/**
 * X2-R05：Host 命令的二进制返回边界。
 *
 * Rust `tauri::ipc::Response` 返回原始字节，前端收到 ArrayBuffer。Host 对 `result.x-binary === true`
 * 的契约跳过 JSON 复制与 `findNonJson`，把字节原样交给传输层（structured clone）；F2 现有的
 * `{ "__dstuRawBytes": "<base64>" }` JSON 信封继续被接受，供纯 JSON 传输与尚未切换的 `read_file_bytes`。
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { definePlugin } from './api.ts';
import type { LaneContract } from './contract.ts';
import { ContractSet } from './contracts.ts';
import greeter from './__fixtures__/greeter.plugin.ts';
import { createTestHost } from './testing.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const contracts = () => ContractSet.fromDirectory(`${FIXTURES}contracts`);

describe('binary command results (X2-R05)', () => {
  it('passes raw Uint8Array through the production dispatcher', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    try {
      const value = await host.invoke<Uint8Array>('fixture_binary');
      expect(value).toBeInstanceOf(Uint8Array);
      expect(Array.from(value)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await host.dispose();
    }
  });

  it('keeps the __dstuRawBytes envelope for JSON-only transports', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    try {
      await expect(host.invoke('fixture_binary_envelope')).resolves.toEqual({ __dstuRawBytes: 'AQIDBA==' });
    } finally {
      await host.dispose();
    }
  });

  it('carries the real convert_heic_to_jpeg contract: raw Request body in, bytes out', async () => {
    let received: unknown;
    const plugin = definePlugin({
      meta: { id: 'fixture.heic-boundary', commands: ['convert_heic_to_jpeg'] },
      apply(ctx) {
        ctx.commands.register('convert_heic_to_jpeg', (_args, call) => {
          received = call.payload;
          return new Uint8Array([0xff, 0xd8, 0xff]);
        });
      },
    });
    // 使用仓库真实 contracts/ipc：验证 L18 的 `Request` 注入 + `result.x-binary` 形状，
    // 不注册 media 插件、不改 L18/F7 代码。
    const host = await createTestHost({ plugins: [plugin] });
    try {
      const bytes = new Uint8Array([0, 1, 2, 3]);
      const result = await host.invoke<Uint8Array>('convert_heic_to_jpeg', bytes);
      expect(received).toBe(bytes);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([0xff, 0xd8, 0xff]);
    } finally {
      await host.dispose();
    }
  });

  it('accepts ArrayBuffer and still rejects binary for JSON contracts in debug', async () => {
    const plugin = definePlugin({
      meta: { id: 'fixture.binary-extra', commands: ['fixture_binary_buffer', 'fixture_binary_wrong'] },
      apply(ctx) {
        ctx.commands.register('fixture_binary_buffer', () => new Uint8Array([1, 2, 3]).buffer);
        ctx.commands.register('fixture_binary_wrong', () => new Uint8Array([1]));
      },
    });
    const extra: LaneContract = {
      lane: 'F1-binary-extra',
      generator: 'hand-written fixture',
      events: [],
      $defs: {},
      commands: [
        {
          name: 'fixture_binary_buffer',
          lane: 'F1-binary-extra',
          rust: { file: 'src/fixture.rs', line: 80, fn: 'fixture_binary_buffer' },
          async: true,
          args: [],
          injected: [],
          result: { 'x-rust': 'tauri::ipc::Response', 'x-binary': true },
          frontend: 'none',
        },
        {
          name: 'fixture_binary_wrong',
          lane: 'F1-binary-extra',
          rust: { file: 'src/fixture.rs', line: 90, fn: 'fixture_binary_wrong' },
          async: true,
          args: [],
          injected: [],
          result: { type: 'string' },
          frontend: 'none',
        },
      ],
    };
    const host = await createTestHost({
      plugins: [plugin],
      contracts: contracts().with([{ file: 'F1-binary-extra.json', contract: extra }]),
    });
    try {
      const value = await host.invoke<ArrayBuffer>('fixture_binary_buffer');
      expect(value).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(value))).toEqual([1, 2, 3]);
      await expect(host.invoke('fixture_binary_wrong')).rejects.toContain('returned a value that violates its contract');
    } finally {
      await host.dispose();
    }
  });
});
