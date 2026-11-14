/**
 * `plugin:fs` 的 `SafeFilePath` 校验（`traversesParent`）在 Windows 路径语义下的行为，路径用 `path.win32` 拼与观察。
 */
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { components } from '../shell/path-ops.ts';
import { traversesParent } from '../shell/plugins/fs.ts';

const rustSeesParent = (path: string) => components(path, 'win32').some((c) => c.kind === 'parent');

describe('SafeFilePath on Windows', () => {
  it('RF-W23-fs-win32-verbatim-parent-segment: `..` hidden inside a verbatim or device prefix is rejected, because Node fs would resolve it somewhere else', () => {
    const cases: Array<[string, string]> = [
      ['\\\\?\\UNC\\srv\\share/../other\\f.txt', '\\\\?\\UNC\\srv\\other\\f.txt'],
      ['\\\\?\\GLOBALROOT/../C:\\Windows\\f.txt', '\\\\?\\C:\\Windows\\f.txt'],
      ['\\\\.\\C:/../Windows/f.txt', '\\\\.\\Windows\\f.txt'],
      ['\\\\?\\x/../C:\\f.txt', '\\\\?\\C:\\f.txt'],
    ];
    for (const [path, nodeOpens] of cases) {
      expect(rustSeesParent(path)).toBe(false);
      // Node fs 在 Windows 上把路径交给 path.win32.toNamespacedPath，它先 win32.resolve。
      expect(win32.resolve(path)).toBe(nodeOpens);
      expect(traversesParent(path, 'win32')).toBe(true);
    }
  });

  it('RF-W23-fs-win32-verbatim-parent-segment: everything Rust rejects is still rejected, and names that only contain dots are not', () => {
    for (const path of ['C:\\x\\..\\y', 'C:/x/../y', '\\\\?\\C:\\x/../y', '\\\\?\\C:\\x\\..\\y', 'C:..\\x', '..\\x', '\\\\srv\\share\\..\\other', 'C:\\x\\..\\..\\y']) {
      expect(rustSeesParent(path)).toBe(true);
      expect(traversesParent(path, 'win32')).toBe(true);
    }
    for (const path of ['C:\\a..b\\c', 'C:\\x\\...\\f', 'C:\\x\\..foo', '\\\\?\\C:\\x\\.\\f', '\\\\?\\UNC\\srv\\share\\notes..md']) {
      expect(traversesParent(path, 'win32')).toBe(false);
    }
  });

  it('RF-W23-fs-win32-verbatim-parent-segment: Unix keeps Rust semantics (`\\` is an ordinary character)', () => {
    expect(traversesParent('/a/../b', 'linux')).toBe(true);
    expect(traversesParent('/a/b\\..\\c', 'linux')).toBe(false);
    expect(traversesParent('/a/b\\..\\c', 'darwin')).toBe(false);
  });
});
