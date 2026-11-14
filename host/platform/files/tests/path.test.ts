/**
 * `files/path.ts`：纯函数，POSIX 与 Windows 两种风味在任何宿主 OS 上都能测。
 */
import { describe, expect, it } from 'vitest';
import type { PathFlavor } from '../api.ts';
import { formatPath, isWithin, parseAbsolute, parseRelative, relativePath, type ParsedPath } from '../path.ts';

function abs(path: string, flavor: PathFlavor): ParsedPath {
  const { parsed, problem } = parseAbsolute(path, flavor);
  if (parsed === null) throw new Error(`expected ${path} to parse: ${problem?.reason}`);
  return parsed;
}

function within(child: string, parent: string, flavor: PathFlavor): boolean {
  return isWithin(abs(child, flavor), abs(parent, flavor), flavor);
}

describe('parseAbsolute (posix)', () => {
  it('collapses separators, drops "." and resolves ".." lexically, clamping at the root', () => {
    expect(abs('/a//b/./c/', 'posix')).toEqual({ root: '/', parts: ['a', 'b', 'c'] });
    expect(abs('/a/b/../c', 'posix').parts).toEqual(['a', 'c']);
    expect(abs('/../..', 'posix').parts).toEqual([]);
    expect(formatPath(abs('/a//b/../c', 'posix'), 'posix')).toBe('/a/c');
    expect(formatPath(abs('/', 'posix'), 'posix')).toBe('/');
  });

  it('rejects relative paths and NUL bytes; backslashes are ordinary characters', () => {
    expect(parseAbsolute('a/b', 'posix').problem?.kind).toBe('invalid');
    expect(parseAbsolute('C:\\a', 'posix').problem?.kind).toBe('invalid');
    expect(parseAbsolute('/a\u0000b', 'posix').problem?.kind).toBe('invalid');
    expect(abs('/a\\b', 'posix').parts).toEqual(['a\\b']);
  });
});

describe('parseAbsolute (win32)', () => {
  it('accepts drive and UNC roots with either separator and normalizes the drive letter', () => {
    expect(abs('c:/Users\\heli', 'win32')).toEqual({ root: 'C:\\', parts: ['Users', 'heli'] });
    expect(abs('C:\\', 'win32')).toEqual({ root: 'C:\\', parts: [] });
    expect(abs('\\\\srv\\share\\a\\b', 'win32')).toEqual({ root: '\\\\srv\\share\\', parts: ['a', 'b'] });
    expect(abs('//srv/share', 'win32')).toEqual({ root: '\\\\srv\\share\\', parts: [] });
    expect(formatPath(abs('c:/a/./b/../c', 'win32'), 'win32')).toBe('C:\\a\\c');
  });

  it('strips verbatim prefixes and rejects device namespace, drive-relative and root-relative forms', () => {
    expect(abs('\\\\?\\C:\\data\\x', 'win32')).toEqual({ root: 'C:\\', parts: ['data', 'x'] });
    expect(abs('\\\\?\\UNC\\srv\\share\\x', 'win32')).toEqual({ root: '\\\\srv\\share\\', parts: ['x'] });
    expect(parseAbsolute('\\\\.\\PhysicalDrive0', 'win32').problem?.kind).toBe('invalid');
    expect(parseAbsolute('C:foo', 'win32').problem?.kind).toBe('invalid');
    expect(parseAbsolute('\\foo', 'win32').problem?.kind).toBe('invalid');
    expect(parseAbsolute('/foo', 'win32').problem?.kind).toBe('invalid');
  });

  it('rejects components Win32 would rewrite or map to devices', () => {
    for (const bad of ['C:\\data\\CON', 'C:\\data\\nul.txt', 'C:\\data\\COM1', 'C:\\data\\f.txt:stream', 'C:\\data\\x.', 'C:\\data\\x ', 'C:\\data\\a?b', 'C:\\data\\.. ']) {
      expect(parseAbsolute(bad, 'win32').problem?.kind, bad).toBe('invalid');
    }
    expect(abs('C:\\data\\console.log', 'win32').parts).toEqual(['data', 'console.log']);
  });
});

describe('isWithin', () => {
  it('posix compares whole components and is case-sensitive', () => {
    expect(within('/a/b/c', '/a/b', 'posix')).toBe(true);
    expect(within('/a/b', '/a/b', 'posix')).toBe(true);
    expect(within('/a/bc', '/a/b', 'posix')).toBe(false);
    expect(within('/a', '/a/b', 'posix')).toBe(false);
    expect(within('/A/b/c', '/a/b', 'posix')).toBe(false);
    expect(within('/a/b/../../etc/passwd', '/a/b', 'posix')).toBe(false);
    expect(within('/a/b/x/../y', '/a/b', 'posix')).toBe(true);
  });

  it('win32 compares case-insensitively across separators and keeps drives and shares apart', () => {
    expect(within('c:/users/HELI/AppData/x', 'C:\\Users\\heli\\AppData', 'win32')).toBe(true);
    expect(within('C:\\Users\\heli\\AppDataX', 'C:\\Users\\heli\\AppData', 'win32')).toBe(false);
    expect(within('D:\\Users\\heli\\AppData\\x', 'C:\\Users\\heli\\AppData', 'win32')).toBe(false);
    expect(within('\\\\SRV\\Share\\a', '\\\\srv\\share', 'win32')).toBe(true);
    expect(within('\\\\srv\\other\\a', '\\\\srv\\share', 'win32')).toBe(false);
    expect(within('C:\\data\\..\\Windows', 'C:\\data', 'win32')).toBe(false);
  });

  it('relativePath joins the remaining components with "/"', () => {
    expect(relativePath(abs('C:\\a\\b\\c', 'win32'), abs('C:\\a', 'win32'))).toBe('b/c');
    expect(relativePath(abs('/a', 'posix'), abs('/a', 'posix'))).toBe('');
  });
});

describe('parseRelative (untrusted scope-relative input)', () => {
  it('normalizes inner ".." and "." but refuses to climb above the scope root', () => {
    expect(parseRelative('a/b/../c', 'posix').parts).toEqual(['a', 'c']);
    expect(parseRelative('a/./b//c/', 'posix').parts).toEqual(['a', 'b', 'c']);
    expect(parseRelative('', 'posix').parts).toEqual([]);
    expect(parseRelative('.', 'posix').parts).toEqual([]);
    expect(parseRelative('../x', 'posix').problem?.kind).toBe('escape');
    expect(parseRelative('a/../../x', 'posix').problem?.kind).toBe('escape');
    expect(parseRelative('a\\..\\..\\x', 'win32').problem?.kind).toBe('escape');
  });

  it('treats "\\" as a separator only on win32', () => {
    expect(parseRelative('a\\b', 'win32').parts).toEqual(['a', 'b']);
    expect(parseRelative('a\\b', 'posix').parts).toEqual(['a\\b']);
    expect(parseRelative('..\\x', 'posix').parts).toEqual(['..\\x']);
  });

  it('rejects absolute paths, drive prefixes, NUL and invalid Windows names', () => {
    expect(parseRelative('/etc/passwd', 'posix').problem?.kind).toBe('invalid');
    expect(parseRelative('\\etc', 'win32').problem?.kind).toBe('invalid');
    expect(parseRelative('C:x', 'win32').problem?.kind).toBe('invalid');
    expect(parseRelative('a\u0000b', 'posix').problem?.kind).toBe('invalid');
    expect(parseRelative('dir/nul.txt', 'win32').problem?.kind).toBe('invalid');
    expect(parseRelative('a:b', 'win32').problem?.kind).toBe('invalid');
    expect(parseRelative('a:b', 'posix').parts).toEqual(['a:b']);
  });
});
