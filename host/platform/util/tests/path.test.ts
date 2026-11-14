/** `util/path.ts`（Node `lib/path.js` 的移植）与 `node:path` 逐例一致；没有工作目录的平台上 `resolve` 的边界。 */
import nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { createPathModules } from '../node-path-port.ts';
import * as path from '../path.ts';

const ROOT = new URL('../../../../', import.meta.url).pathname;

const SEGMENTS = [
  '', '.', '..', '...', 'a', 'b.txt', '.hidden', 'name.tar.gz', 'dir/', 'a/b', 'a//b', './a', '../a', 'a/..', 'a/./b',
  '/', '//', '///', '/a', '//a', '//server/share', '//server/share/', '\\', '\\\\', '\\a', '\\\\server\\share', '\\\\server\\share\\x',
  'C:', 'C:\\', 'C:/', 'c:\\a', 'C:a', 'C:\\a\\..\\..', '\\\\?\\C:\\a', '\\\\.\\pipe\\x', 'CON', 'con:', 'NUL.txt', 'a:b', 'file.', 'x\\y/z',
  '中文', '目录/文件.md', '😀.png', ' sp ace ', 'trailing.', 'a?b', '..\\..\\x',
];

/** 确定性伪随机，保证失败可复现。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function samples(count: number, seed: number): string[][] {
  const next = rng(seed);
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(next() * 4);
    out.push(Array.from({ length }, () => SEGMENTS[Math.floor(next() * SEGMENTS.length)]!));
  }
  return out;
}

const CASES = samples(3000, 20261107);

describe.each([
  ['posix', path.posix, nodePath.posix],
  ['win32', path.win32, nodePath.win32],
] as const)('%s matches node:path', (_flavor, ours, node) => {
  it('join / normalize / dirname / basename / extname / isAbsolute / parse / format / toNamespacedPath', () => {
    for (const args of CASES) {
      const label = JSON.stringify(args);
      expect(ours.join(...args), label).toBe(node.join(...args));
      for (const one of args) {
        expect(ours.normalize(one), one).toBe(node.normalize(one));
        expect(ours.dirname(one), one).toBe(node.dirname(one));
        expect(ours.basename(one), one).toBe(node.basename(one));
        expect(ours.basename(one, '.txt'), one).toBe(node.basename(one, '.txt'));
        expect(ours.extname(one), one).toBe(node.extname(one));
        expect(ours.isAbsolute(one), one).toBe(node.isAbsolute(one));
        expect(ours.parse(one), one).toEqual(node.parse(one));
        expect(ours.format(ours.parse(one)), one).toBe(node.format(node.parse(one)));
        expect(ours.toNamespacedPath(one), one).toBe(node.toNamespacedPath(one));
      }
    }
    expect(ours.sep).toBe(node.sep);
    expect(ours.delimiter).toBe(node.delimiter);
  });

  it('resolve / relative (including relative inputs resolved against the process cwd)', () => {
    for (const args of CASES) {
      const label = JSON.stringify(args);
      expect(ours.resolve(...args), label).toBe(node.resolve(...args));
      const [from = '', to = ''] = args;
      expect(ours.relative(from, to), label).toBe(node.relative(from, to));
    }
    expect(ours.resolve()).toBe(node.resolve());
  });

  it('rejects non-string arguments with a TypeError like node:path', () => {
    expect(() => ours.join('a', 1 as unknown as string)).toThrow(TypeError);
    expect(() => node.join('a', 1 as unknown as string)).toThrow(TypeError);
  });
});

describe('host style and platforms without a working directory', () => {
  it('the top-level functions follow node:path’s default flavor on this host', () => {
    expect(path.hostPath).toBe(nodePath.sep === '\\' ? path.win32 : path.posix);
    expect(path.join('a', '..', 'b', 'c.txt')).toBe(nodePath.join('a', '..', 'b', 'c.txt'));
    expect(path.sep).toBe(nodePath.sep);
  });

  it('a win32 host picks win32 and uses the per-drive cwd from the environment, like Node on Windows', () => {
    const modules = createPathModules({ platform: 'win32', cwd: () => 'C:\\work', env: { '=D:': 'D:\\proj' } });
    expect(modules.isWindows).toBe(true);
    expect(modules.win32.resolve('D:x')).toBe('D:\\proj\\x');
    expect(modules.win32.resolve('x')).toBe('C:\\work\\x');
    expect(modules.posix.resolve('x')).toBe('/work/x');
  });

  it('without process (mobile Worker) pure functions work and resolve needs an absolute segment', () => {
    const { posix, win32, isWindows } = createPathModules(undefined);
    expect(isWindows).toBe(false);
    expect(posix.join('/opfs/data', 'vfs.db')).toBe('/opfs/data/vfs.db');
    expect(posix.resolve('/opfs', 'a', '../b')).toBe('/opfs/b');
    expect(posix.relative('/opfs/a', '/opfs/b/c')).toBe('../b/c');
    expect(() => posix.resolve('relative')).toThrow(/working directory/);
    expect(() => posix.resolve()).toThrow(/working directory/);
    expect(() => posix.relative('a', '/b')).toThrow(/working directory/);
    expect(win32.resolve('C:\\a', 'b')).toBe('C:\\a\\b');
    expect(() => win32.resolve('C:rel')).toThrow(/working directory/);
  });

  it('path.ts carries no Node dependencies', () => {
    expect(checkModulesClosure(ROOT, ['host/platform/util/path.ts'])).toEqual([]);
  });
});
