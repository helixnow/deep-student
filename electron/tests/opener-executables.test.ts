import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveScopes } from '../shell/capabilities.ts';
import { executableTarget } from '../shell/plugins/executable-files.ts';
import { openerPlugin } from '../shell/plugins/system.ts';
import type { CommandContext } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'w23-opener-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const file = (dir: string, name: string, content: string | Uint8Array = 'text', mode = 0o644) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

describe('RF-W23-opener-open-path-executables', () => {
  it('RF-W23-opener-open-path-executables: executable file types are refused per platform, documents are not', () => {
    const dir = temp();
    for (const name of ['setup.exe', 'run.BAT', 'evil.lnk', 'x.ps1', 'a.js', 'tool.jar', 'x.exe.', 'x.exe::$DATA']) {
      expect(executableTarget(join(dir, name), 'win32', {}), name).toMatch(/^executable file type /);
    }
    for (const name of ['Calculator.app', 'go.command', 'go.Tool', 'a.terminal', 'b.workflow', 'i.pkg', 'loc.fileloc', 'x.webloc', 's.zsh']) {
      expect(executableTarget(join(dir, name), 'darwin', {}), name).toMatch(/^executable file type /);
    }
    for (const name of ['app.desktop', 'x.AppImage', 'installer.run', 'a.sh']) {
      expect(executableTarget(join(dir, name), 'linux', {}), name).toMatch(/^executable file type /);
    }
    for (const name of ['thesis.pdf', 'notes.md', 'slides.pptx', 'photo.jpeg', 'book.epub', 'deck.apkg', '.hidden']) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) expect(executableTarget(join(dir, name), platform, {}), `${platform} ${name}`).toBeNull();
    }
    expect(executableTarget(join(dir, 'a.js'), 'darwin', {})).toBeNull();
    expect(executableTarget(join(dir, 'x.foo'), 'win32', { PATHEXT: '.COM;.EXE;.FOO' })).toBe('executable file type .foo');
  });

  it('RF-W23-opener-open-path-executables: content, permission bits, bundles and symlinks are checked on the real target', () => {
    const dir = temp();
    expect(executableTarget(file(dir, 'report.pdf', new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7])), 'darwin', {})).toBe('executable content');
    expect(executableTarget(file(dir, 'notes.txt', new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), 'linux', {})).toBe('executable content');
    expect(executableTarget(file(dir, 'readme.txt', 'MZ\x90\x00'), 'win32', {})).toBe('executable content');
    expect(executableTarget(file(dir, 'script.txt', '#!/bin/sh\nid\n'), 'linux', {})).toBe('executable content');
    if (process.platform !== 'win32') {
      expect(executableTarget(file(dir, 'payload', 'id\n', 0o755), 'darwin', {})).toBe('executable permission bits');
      expect(executableTarget(file(dir, 'payload-ro', 'id\n', 0o644), 'darwin', {})).toBeNull();
      expect(executableTarget(file(dir, 'from-usb.pdf', '%PDF-1.7', 0o777), 'darwin', {})).toBeNull();
      const link = join(dir, 'innocent.pdf');
      symlinkSync(file(dir, 'real.command', 'id'), link);
      expect(executableTarget(link, 'darwin', {})).toBe('executable file type .command');
    }
    const bundle = join(dir, 'Plain Folder');
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    expect(executableTarget(bundle, 'darwin', {})).toBe('application bundle');
    expect(executableTarget(bundle, 'linux', {})).toBeNull();
    mkdirSync(join(dir, 'Course Notes'));
    expect(executableTarget(join(dir, 'Course Notes'), 'darwin', {})).toBeNull();
    expect(executableTarget(join(dir, 'missing.pdf'), 'darwin', {})).toBeNull();
  });

  it('RF-W23-opener-open-path-executables: plugin:opener|open_path refuses an in-scope executable before handing it to the OS', async () => {
    const dir = temp();
    const scope = new FsScope({ platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux' });
    scope.allowPattern(join(dir, '**'));
    const plugin = openerPlugin({ urlAllow: [], paths: scope, pathApps: [null] }, process.platform);
    const target = file(dir, process.platform === 'win32' ? 'dropped.bat' : 'dropped.sh', 'echo pwned');
    const ctx = {
      runtime: { paths: { parseVariablePath: (p: string) => p } },
      scope: () => ({ allow: [{ path: join(dir, '**') }], deny: [] }),
    } as unknown as CommandContext;
    const input = { command: 'open_path', json: { path: target }, raw: null, headers: {} };
    await expect(Promise.resolve().then(() => plugin.open_path!(input, ctx))).rejects.toThrow(`Not allowed to open path ${target}: executable file type`);
  });
});

describe('opener `with`', () => {
  it('S01-r2 I1 [W23] no capability lets a page pick the program, so openWith (Windows: cmd /c start, unquoted) stays unreachable', () => {
    const capabilities = join(import.meta.dirname, '..', '..', 'resources/app', 'capabilities');
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const derived = deriveScopes(capabilities, platform);
      expect(derived.openerUrlAllow.length, platform).toBeGreaterThan(0);
      expect(derived.openerPathAllow.length, platform).toBeGreaterThan(0);
      // An entry with `app` lets open_url / open_path reach openWith. Rust opens with ShellExecuteExW there
      // (tauri-plugin-opener enables open's `shellexecute-on-windows`); cmd would expand %VAR% and split on & | < >.
      expect(derived.openerUrlAllow.filter((entry) => entry.app !== null), platform).toEqual([]);
      expect(derived.openerPathAllow.filter((entry) => entry.app !== null), platform).toEqual([]);
    }
  });
});
