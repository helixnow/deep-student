/**
 * module-origin.ts 的可移植路径换算与 Node `url` / `path` 逐条对照（posix 与 win32 两种风格都在本机验证），
 * 以及来源判定。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_PATHS, fileUrlToPath, isAbsolutePath, isAppModuleUrl, isHostModuleUrl, moduleOrigin, moduleUrlOf,
  pathToFileHref, resolveRelativeFile, urlUnderRoots,
} from '../module-origin.ts';

const POSIX = ['/', '/a/b.ts', '/a b/c%d#e?f.ts', '/x/\\y', '/tab\there', '/naïve/文件.ts', '/a/../b/./c.ts', '/trailing/'];
const WIN = ['C:\\a\\b.ts', 'd:\\a b\\c%d#e?f.ts', 'C:/mixed\\sep.ts', '\\\\server\\share\\x.ts', 'C:\\naïve\\文件.ts'];

describe('module-origin path conversions match node:url', () => {
  it('pathToFileHref / fileUrlToPath (posix)', () => {
    for (const p of POSIX) {
      const href = pathToFileHref(p, false);
      expect(href, p).toBe(pathToFileURL(p, { windows: false }).href);
      expect(fileUrlToPath(href, false), p).toBe(fileURLToPath(href, { windows: false }));
    }
  });

  it('pathToFileHref / fileUrlToPath (win32)', () => {
    for (const p of WIN) {
      const href = pathToFileHref(p, true);
      expect(href, p).toBe(pathToFileURL(p, { windows: true }).href);
      expect(fileUrlToPath(href, true), p).toBe(fileURLToPath(href, { windows: true }));
    }
  });

  it('rejects what node rejects', () => {
    for (const [href, windows] of [['file:///a%2Fb', false], ['file:///C:/a%5Cb', true], ['file://host/a', false], ['file:///a/b', true], ['http://x/a', false]] as const) {
      expect(() => fileURLToPath(href, { windows }), href).toThrow();
      expect(() => fileUrlToPath(href, windows), href).toThrow(TypeError);
    }
  });

  it('isAbsolutePath', () => {
    for (const p of ['/a', 'a', './a', '../a', '']) expect(isAbsolutePath(p, false), p).toBe(path.posix.isAbsolute(p));
    for (const p of ['C:\\a', 'C:/a', '\\a', '/a', 'C:a', 'a\\b', '']) expect(isAbsolutePath(p, true), p).toBe(path.win32.isAbsolute(p));
  });

  it('resolveRelativeFile = path.resolve(dirname(module), relative)', () => {
    const base = '/pkg/dist/host.js';
    for (const rel of ['./ui.js', 'ui/index.js', '../ui#1.js', 'a%b?.js', '/abs/ui.js']) {
      const href = resolveRelativeFile(pathToFileHref(base, false), rel, false);
      expect(fileUrlToPath(href, false), rel).toBe(path.posix.resolve(path.posix.dirname(base), rel));
    }
    const winBase = 'C:\\pkg\\dist\\host.js';
    for (const rel of ['.\\ui.js', 'ui\\index.js', '..\\ui#1.js', 'D:\\abs\\ui.js']) {
      const href = resolveRelativeFile(pathToFileHref(winBase, true), rel, true);
      expect(fileUrlToPath(href, true), rel).toBe(path.win32.resolve(path.win32.dirname(winBase), rel));
    }
  });
});

describe('module origin', () => {
  it('detects the path style of the running process', () => {
    expect(WINDOWS_PATHS).toBe(process.platform === 'win32');
  });

  it('classifies app and community modules', () => {
    const hostFile = new URL('../runtime.ts', import.meta.url).href;
    const electronFile = new URL('../../../electron/main.ts', import.meta.url).href;
    const exampleFile = new URL('../../../examples/x/index.ts', import.meta.url).href;
    expect(moduleOrigin(hostFile)).toBe('builtin');
    expect(moduleOrigin(electronFile)).toBe('builtin');
    expect(moduleOrigin(null)).toBe('builtin');
    expect(moduleOrigin(exampleFile)).toBe('community');
    expect(isHostModuleUrl(electronFile)).toBe(false);
    expect(isAppModuleUrl('some-package')).toBe(false);
    expect(moduleUrlOf(fileURLToPath(hostFile))).toBe(hostFile);
    expect(moduleUrlOf('@w01/definitely-not-installed')).toBeNull();
  });

  it('Windows: the drive letter compares case-insensitively, the rest of the path exactly (V10 P3-6)', () => {
    const app = 'C:\\Program Files\\Deep Student\\resources\\app\\host\\';
    const lowerDrive = 'c:\\Program Files\\Deep Student\\resources\\app\\host\\';
    const pairs: [root: string, module: string][] = [[app, `${lowerDrive}kernel\\x.ts`], [lowerDrive, `${app}kernel\\x.ts`], [app, `${app}kernel\\x.ts`]];
    for (const [rootPath, modulePath] of pairs) {
      const roots = [pathToFileURL(rootPath, { windows: true }).href];
      expect(urlUnderRoots(pathToFileURL(modulePath, { windows: true }).href, roots, true), `${rootPath} ⊇ ${modulePath}`).toBe(true);
      expect(urlUnderRoots(roots[0]!.replace('file:///C:', 'file:///c:'), roots, true)).toBe(true);
    }
    const roots = [pathToFileURL(app, { windows: true }).href];
    for (const outside of [
      'c:\\Program Files\\Deep Student\\resources\\app\\hostile\\x.ts',
      'c:\\program files\\deep student\\resources\\app\\host\\x.ts',
      'D:\\Program Files\\Deep Student\\resources\\app\\host\\x.ts',
    ]) {
      expect(urlUnderRoots(pathToFileURL(outside, { windows: true }).href, roots, true), outside).toBe(false);
    }
    expect(urlUnderRoots(pathToFileURL(`${lowerDrive}x.ts`, { windows: true }).href, roots, false)).toBe(false);
  });
});
