import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Arch } = require('builder-util');
const { installMacMainEntry } = require('../scripts/mac-main-stub.cjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(arch: number) {
  const appOutDir = mkdtempSync(join(tmpdir(), 'mac-main-stub-'));
  dirs.push(appOutDir);
  const app = join(appOutDir, 'Deep Student.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources/licenses'), { recursive: true });
  const executable = join(app, 'Contents/MacOS/Deep Student');
  writeFileSync(executable, 'old-main');
  const context = { appOutDir, arch, electronPlatformName: 'darwin', packager: {
    appInfo: { productFilename: 'Deep Student' }, info: { framework: { version: '45.2.1' } },
  } };
  return { context, app, executable };
}
describe('fixed Electron 45.2.1 mac main hook', () => {
  it.each([[Arch.arm64, 'arm64'], [Arch.x64, 'x86_64']])('builds the requested architecture, never the host default (%s)', (arch, expected) => {
    const { context, app, executable } = fixture(arch);
    const calls: Array<[string, string[]]> = [];
    installMacMainEntry(context, (command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === 'lipo') return expected;
      if (command === 'otool') return 'cmd LC_BUILD_VERSION\n minos 13.0\n sdk 26.5';
      expect(readFileSync(executable, 'utf8')).toBe('old-main');
      const outputIndex = args.indexOf('-o');
      const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
      if (output === undefined) throw new Error('compiler output argument missing');
      writeFileSync(output, 'new-main');
      return '';
    });
    const compilerCall = calls[2];
    if (compilerCall === undefined) throw new Error('compiler was not called');
    const [command, args] = compilerCall;
    expect(command).toBe('clang++');
    expect(args).toEqual(expect.arrayContaining(['-arch', expected, '-mmacosx-version-min=13.0', '-nostdlib++', '-Wl,-rpath,@executable_path/../Frameworks']));
    expect(readFileSync(executable, 'utf8')).toBe('new-main');
    expect(readdirSync(join(app, 'Contents/MacOS'))).toEqual(['Deep Student']);
    expect(readdirSync(context.appOutDir)).toEqual(['Deep Student.app']);
    expect(readFileSync(join(app, 'Contents/Resources/licenses/Electron-main-stub-MIT.txt'), 'utf8')).toContain('Electron contributors');
  });
  it('does not silently reuse this stub for another Electron version or unsupported architecture', () => {
    const { context } = fixture(Arch.arm64);
    context.packager.info.framework.version = '45.2.3';
    expect(() => installMacMainEntry(context)).toThrow(/requires Electron 45.2.1/);
    context.packager.info.framework.version = '45.2.1';
    context.arch = Arch.universal;
    expect(() => installMacMainEntry(context)).toThrow(/arm64\/x64 only/);
  });
  it('rejects a mismatched distribution and leaves the original main on compiler failure', () => {
    const { context, executable } = fixture(Arch.arm64);
    expect(() => installMacMainEntry(context, () => 'x86_64')).toThrow(/does not match/);
    expect(() => installMacMainEntry(context, (command: string) => {
      if (command === 'lipo') return 'arm64';
      if (command === 'otool') return 'minos 13.0';
      throw new Error('compiler failed');
    })).toThrow('compiler failed');
    expect(readFileSync(executable, 'utf8')).toBe('old-main');
    expect(readdirSync(context.appOutDir)).toEqual(['Deep Student.app']);
  });
  it('does not alter Windows or Linux packaging', () => {
    for (const electronPlatformName of ['win32', 'linux']) {
      expect(() => installMacMainEntry({ electronPlatformName }, () => { throw new Error('must not compile'); })).not.toThrow();
    }
  });
});
