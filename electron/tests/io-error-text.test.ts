/** `formatIoError`：Rust `std::io::Error` 对 OS 错误的 Display（`{文案} (os error {code})`）在三个平台上的复刻。 */
import { describe, expect, it, vi } from 'vitest';
import { formatIoError, systemWindowsMessage } from '../shell/errors.ts';

function ioError(code: string, message = `${code}: failure, open '/x'`, errno?: number): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, ...(errno === undefined ? {} : { errno }) });
}

describe('macOS / Linux: strerror text and errno of each platform', () => {
  it.each([
    ['ENOENT', 'darwin', 'No such file or directory (os error 2)'],
    ['ENOENT', 'linux', 'No such file or directory (os error 2)'],
    ['EBUSY', 'darwin', 'Resource busy (os error 16)'],
    ['EBUSY', 'linux', 'Device or resource busy (os error 16)'],
    ['EXDEV', 'linux', 'Invalid cross-device link (os error 18)'],
    ['ELOOP', 'darwin', 'Too many levels of symbolic links (os error 62)'],
    ['ELOOP', 'linux', 'Too many levels of symbolic links (os error 40)'],
    ['ENOTEMPTY', 'darwin', 'Directory not empty (os error 66)'],
    ['ENOTEMPTY', 'linux', 'Directory not empty (os error 39)'],
  ] as const)('%s on %s', (code, platform, expected) => {
    const windowsMessage = vi.fn(() => 'never');
    expect(formatIoError(ioError(code), platform, windowsMessage)).toBe(expected);
    expect(windowsMessage).not.toHaveBeenCalled();
  });
});

describe('Windows: the system message for the Windows error code (Rust FormatMessageW, system language)', () => {
  it('uses the text the system gives for the mapped Windows code', () => {
    const texts: Record<number, string> = { 2: '系统找不到指定的文件。', 32: '另一个程序正在使用此文件，进程无法访问。', 5: '拒绝访问。' };
    const windowsMessage = vi.fn((code: number) => texts[code] ?? null);
    expect(formatIoError(ioError('ENOENT'), 'win32', windowsMessage)).toBe('系统找不到指定的文件。 (os error 2)');
    expect(formatIoError(ioError('EBUSY'), 'win32', windowsMessage)).toBe('另一个程序正在使用此文件，进程无法访问。 (os error 32)');
    expect(formatIoError(ioError('EPERM'), 'win32', windowsMessage)).toBe('拒绝访问。 (os error 5)');
    expect(windowsMessage.mock.calls).toEqual([[2], [32], [5]]);
  });

  it('falls back to the en-US text when the system message is unavailable', () => {
    expect(formatIoError(ioError('ENOENT'), 'win32', () => null)).toBe('The system cannot find the file specified. (os error 2)');
    expect(formatIoError(ioError('EEXIST'), 'win32', () => null)).toBe('Cannot create a file when that file already exists. (os error 183)');
  });

  it.runIf(process.platform === 'win32')('the real FormatMessageW text, trimmed like Rust', () => {
    const text = systemWindowsMessage(2);
    expect(text).toMatch(/\S$/);
    expect(formatIoError(ioError('ENOENT'), 'win32')).toBe(`${text} (os error 2)`);
  });

  it.skipIf(process.platform === 'win32')('no system message source outside Windows', () => {
    expect(systemWindowsMessage(2)).toBeNull();
  });
});

describe('errors without a mapped code', () => {
  it('keeps the libuv text with the errno, the plain message, or the value', () => {
    expect(formatIoError(ioError('ESOMETHING', 'ESOMETHING: odd thing happened, open \'/x\'', -77), 'linux')).toBe('Odd thing happened (os error 77)');
    expect(formatIoError(new Error('plain'), 'win32', () => 'never')).toBe('plain');
    expect(formatIoError('text', 'darwin')).toBe('text');
  });
});
