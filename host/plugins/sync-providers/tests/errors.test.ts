import { constants } from 'node:os';
import { getSystemErrorMap } from 'node:util';
import { open } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ioError } from '../src/errors.ts';

/** The previous Node-bound implementation: platform errno plus libuv text. */
function nodeIoError(code: string): string {
  const errno = constants.errno[code as keyof typeof constants.errno];
  const message = getSystemErrorMap().get(-errno)?.[1] ?? code;
  return `${message.charAt(0).toUpperCase()}${message.slice(1)} (os error ${errno})`;
}

describe('ioError static errno table', () => {
  it('matches util.getSystemErrorMap for every code libuv maps on this platform', () => {
    const codes = [...getSystemErrorMap()]
      .filter(([errno, [code]]) => constants.errno[code as keyof typeof constants.errno] === -errno)
      .map(([, [code]]) => code);
    expect(codes.length).toBeGreaterThan(40);
    for (const code of codes) {
      const errno = -constants.errno[code as keyof typeof constants.errno];
      expect(ioError(Object.assign(new Error(code), { code, errno })), code).toBe(nodeIoError(code));
    }
  });

  it('formats a real fs error like std::io::Error', async () => {
    const error = await open('/definitely/missing/ds-errors-test', 'r').catch((e: unknown) => e);
    expect(ioError(error)).toBe(nodeIoError('ENOENT'));
  });

  it('uses the CRT errno for libuv synthetic codes and falls back to the message otherwise', () => {
    expect(ioError(Object.assign(new Error('x'), { code: 'ENOENT', errno: -4058 }))).toBe('No such file or directory (os error 2)');
    expect(ioError(Object.assign(new Error('plain'), { code: 'ENOENT' }))).toBe('plain');
    expect(ioError(Object.assign(new Error('odd'), { code: 'EUNKNOWNX', errno: -9 }))).toBe('odd');
    expect(ioError('text')).toBe('text');
    expect(ioError(null)).toBe('null');
  });
});
