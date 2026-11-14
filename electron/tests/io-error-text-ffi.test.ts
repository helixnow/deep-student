/**
 * `systemWindowsMessage` 的 kernel32 加载：koffi 换成替身、`process.platform` 设成 win32，每例重新导入 errors.ts。
 * 真实 FormatMessageW 的文案在 `io-error-text.test.ts`（仅 Windows）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('koffi', () => ({ default: { load } }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  load.mockReset();
  vi.resetModules();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

const ENOENT = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\x'"), { code: 'ENOENT' });

it('a kernel32.dll that fails to load is not loaded again on every later error; the en-US text is used', async () => {
  load.mockImplementation(() => { throw new Error('kernel32.dll: cannot load'); });
  const { formatIoError, systemWindowsMessage } = await import('../shell/errors.ts');
  expect(systemWindowsMessage(2)).toBeNull();
  expect(systemWindowsMessage(5)).toBeNull();
  expect(formatIoError(ENOENT, 'win32')).toBe('The system cannot find the file specified. (os error 2)');
  expect(load).toHaveBeenCalledTimes(1);
});

it('a loaded FormatMessageW is bound once and reused; a call that throws gives null without dropping it', async () => {
  const formatMessageW = vi.fn((_flags: number, _source: null, code: number, _language: number, buffer: Buffer, _size: number, _args: null) => {
    if (code === 87) throw new Error('call failed');
    const text = Buffer.from(`message ${code}\r\n`, 'utf16le');
    text.copy(buffer);
    return text.length / 2;
  });
  const func = vi.fn(() => formatMessageW);
  load.mockReturnValue({ func });
  const { systemWindowsMessage } = await import('../shell/errors.ts');
  expect(systemWindowsMessage(2)).toBe('message 2');
  expect(systemWindowsMessage(87)).toBeNull();
  expect(systemWindowsMessage(5)).toBe('message 5');
  expect(load.mock.calls).toEqual([['kernel32.dll']]);
  expect(func).toHaveBeenCalledTimes(1);
  expect(formatMessageW.mock.calls.map((call) => [call[0], call[2], call[3], call[5]])).toEqual([
    [0x1200, 2, 0, 2048],
    [0x1200, 87, 0, 2048],
    [0x1200, 5, 0, 2048],
  ]);
});
