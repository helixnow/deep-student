import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import { fsPlugin } from '../shell/plugins/fs.ts';
import type { CommandContext } from '../shell/runtime.ts';

const dir = mkdtempSync(join(tmpdir(), 'dstu-fs-write-fd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness() {
  const scope = new FsScope({ platform: 'linux' });
  scope.allowDirectory(dir, true);
  const plugin = fsPlugin({ global: scope, runtime: scope });
  const context = {
    runtime: { debug: false, paths: { resolve: () => dir } },
    windowLabel: 'main',
    webviewLabel: 'main',
    scope: () => ({ allow: [], deny: [] }),
  } as unknown as CommandContext;
  return { plugin, context };
}

/** Linux 下 `open` 的 fd 会立刻出现在 `/proc/self/fd`，同步调用后即可判定是否泄漏。 */
const openFileDescriptors = () => readdirSync('/proc/self/fd').length;

it('leaks no file descriptor when the write body fails validation', () => {
  const { plugin, context } = harness();
  const target = join(dir, 'invalid.bin');
  const before = openFileDescriptors();
  expect(() => plugin.write_file!({
    command: 'write_file', json: [0, 256], raw: null, headers: { path: encodeURIComponent(target) },
  }, context)).toThrow('invalid value: integer `256`, expected u8');
  expect(openFileDescriptors()).toBe(before);
  // 校验先于 open：非法载荷不再留下被截断的空文件。
  expect(existsSync(target)).toBe(false);
});

it('leaks no file descriptor for an unexpected body shape', () => {
  const { plugin, context } = harness();
  const target = join(dir, 'unexpected.bin');
  const before = openFileDescriptors();
  expect(() => plugin.write_file!({
    command: 'write_file', json: { data: [1] }, raw: null, headers: { path: encodeURIComponent(target) },
  }, context)).toThrow('unexpected invoke body');
  expect(openFileDescriptors()).toBe(before);
});

it('still writes raw and JSON byte payloads after the reorder', () => {
  const { plugin, context } = harness();
  const raw = join(dir, 'raw.bin');
  plugin.write_file!({
    command: 'write_file', json: null, raw: new Uint8Array([1, 2, 3]), headers: { path: encodeURIComponent(raw) },
  }, context);
  expect([...readFileSync(raw)]).toEqual([1, 2, 3]);
  const json = join(dir, 'json.bin');
  plugin.write_file!({
    command: 'write_file', json: [4, 5], raw: null, headers: { path: encodeURIComponent(json) },
  }, context);
  expect([...readFileSync(json)]).toEqual([4, 5]);
});
