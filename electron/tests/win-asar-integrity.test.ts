/**
 * Windows / Linux 打包产物的静态校验（SEC-E08，`verify-fuses.mjs --win|--linux`、`win-asar-integrity.mjs`）。
 *
 * 本机没有 win32 版 Electron，这里用合成的解包目录走完与真实打包相同的步骤：electron-builder 自己的
 * `computeData`（asar 头部哈希）与 `addWinAsarIntegrity`（写 exe 资源），再用 afterPack 同一份 `fuseConfig` 翻转
 * fuses（fuse 区复制自本机 Electron 45 的二进制，默认值与 win32 版相同）。真实 Windows 产物上的"篡改后拒绝启动"
 * 仍需在 Windows 上手工验证。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readWinAsarIntegrity } from '../scripts/win-asar-integrity.mjs';

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, '..', '..');
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit');
const { addWinAsarIntegrity } = require('app-builder-lib/out/electron/electronWin.js') as {
  addWinAsarIntegrity(executable: string, integrity: Record<string, { algorithm: string; hash: string }>): Promise<void>;
};
const { computeData } = require('app-builder-lib/out/asar/integrity.js') as {
  computeData(options: { resourcesPath: string; resourcesRelativePath: string; resourcesDestinationPath: string; extraResourceMatchers: unknown[] }): Promise<Record<string, { algorithm: string; hash: string }>>;
};
const { flipFuses } = require('@electron/fuses') as { flipFuses(file: string, config: unknown): Promise<number> };
const asar = require('@electron/asar') as { createPackageWithOptions(src: string, dest: string, options: { unpack: string }): Promise<unknown> };
const { fuseConfig } = require('../scripts/app-hardening.cjs') as { fuseConfig(platform: string, options?: { signed?: boolean }): unknown };
const { editWindowsResources } = require('app-builder-lib/out/util/resEdit.js') as {
  editWindowsResources(options: { file: string; versionStrings: Record<string, string>; fileVersion: string; productVersion: string; iconPath: string | null }): Promise<void>;
};
const builderConfig = require('../electron-builder.config.cjs') as { productName: string; copyright: string; win: { icon: string } & Record<string, unknown> };

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const tmp = mkdtempSync(join(tmpdir(), 'dstu-win-integrity-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 本机 Electron 二进制里未翻转的 fuse 区：哨兵 + 版本 + 长度 + 各 fuse 状态。 */
function electronFuseWire(): Buffer {
  const dist = dirname(require('electron') as string);
  const binary = process.platform === 'darwin'
    ? join(dist, '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
    : join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const bytes = readFileSync(binary);
  const at = bytes.indexOf(SENTINEL);
  expect(at).toBeGreaterThanOrEqual(0);
  const length = bytes[at + SENTINEL.length + 1]!;
  return Buffer.from(bytes.subarray(at, at + SENTINEL.length + 2 + length));
}

/** 带版本信息（addWinAsarIntegrity 需要恰好一种语言）的最小 PE，fuse 区放在一个 RCDATA 资源里。 */
function syntheticExe(file: string): void {
  const exe = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(exe);
  const version = Resource.VersionInfo.createEmpty();
  version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Deep Student' });
  version.outputToResourceEntries(resources.entries);
  resources.entries.push({ type: 10, id: 1, lang: 1033, codepage: 1200, bin: electronFuseWire() });
  resources.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

async function unpackedDir(name: string, platform: 'win32' | 'linux'): Promise<{ dir: string; executable: string; archive: string }> {
  const dir = join(tmp, name);
  const resources = join(dir, 'resources');
  const app = join(tmp, `${name}-app`);
  mkdirSync(join(app, 'native'), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{ "name": "deep-student", "main": "electron/main.ts" }\n');
  writeFileSync(join(app, 'native', 'addon.node'), 'binary');
  const archive = join(resources, 'app.asar');
  await asar.createPackageWithOptions(app, archive, { unpack: '*.node' });
  const executable = join(dir, platform === 'win32' ? 'Deep Student.exe' : 'deep-student');
  if (platform === 'win32') syntheticExe(executable);
  else writeFileSync(executable, Buffer.concat([Buffer.from('\x7fELF'), electronFuseWire()]));
  return { dir, executable, archive };
}

function verify(platform: 'win32' | 'linux', dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [join(repoRoot, 'electron', 'scripts', 'verify-fuses.mjs'), platform === 'win32' ? '--win' : '--linux', '--unpacked', dir], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe('readWinAsarIntegrity', () => {
  it('reads back exactly what electron-builder writes, and null when the resource is missing', async () => {
    const file = join(tmp, 'roundtrip.exe');
    syntheticExe(file);
    expect(readWinAsarIntegrity(readFileSync(file))).toBeNull();
    await addWinAsarIntegrity(file, { 'resources/app.asar': { algorithm: 'SHA256', hash: 'ab'.repeat(32) } });
    expect(readWinAsarIntegrity(readFileSync(file))).toEqual([{ file: 'resources\\app.asar', alg: 'SHA256', value: 'ab'.repeat(32) }]);
  });
});

describe('verify-fuses --win / --linux (static)', () => {
  it('a Windows build passes when the exe carries the asar header hash and the win32 fuses', async () => {
    const { dir, executable } = await unpackedDir('win-unpacked', 'win32');
    const resources = join(dir, 'resources');
    await addWinAsarIntegrity(executable, await computeData({ resourcesPath: resources, resourcesRelativePath: 'resources', resourcesDestinationPath: resources, extraResourceMatchers: [] }));
    await flipFuses(executable, fuseConfig('win32'));
    const { code, output } = verify('win32', dir);
    expect(output).toMatch(/^PASS fuses: wire matches expectedFuses\(win32\)/m);
    expect(output).toMatch(/^PASS integrity: exe resource INTEGRITY\/ELECTRONASAR = SHA256\(app\.asar header\)/m);
    expect(output).toMatch(/^PASS asar: native binaries unpacked/m);
    expect(output).toMatch(/^NOT RUN: behaviour checks/m);
    expect(code, output).toBe(0);
  }, 60_000);

  it('a modified app.asar header, a missing integrity resource or unflipped fuses fail', async () => {
    const tampered = await unpackedDir('win-tampered', 'win32');
    const resources = join(tampered.dir, 'resources');
    await addWinAsarIntegrity(tampered.executable, await computeData({ resourcesPath: resources, resourcesRelativePath: 'resources', resourcesDestinationPath: resources, extraResourceMatchers: [] }));
    await flipFuses(tampered.executable, fuseConfig('win32'));
    const fd = openSync(tampered.archive, 'r+');
    const head = Buffer.alloc(4096);
    readSync(fd, head, 0, head.length, 0);
    const at = head.indexOf('"size":') + '"size":'.length;
    writeSync(fd, head[at] === 0x39 ? '8' : '9', at);
    closeSync(fd);
    let result = verify('win32', tampered.dir);
    expect(result.output).toMatch(/^FAIL integrity: exe resource INTEGRITY\/ELECTRONASAR/m);
    expect(result.code).toBe(1);

    const missing = await unpackedDir('win-missing', 'win32');
    await flipFuses(missing.executable, fuseConfig('win32'));
    result = verify('win32', missing.dir);
    expect(result.output).toMatch(/^FAIL integrity: exe resource INTEGRITY\/ELECTRONASAR = SHA256\(app\.asar header\) — null vs/m);
    expect(result.output).toMatch(/^PASS fuses/m);

    const unflipped = await unpackedDir('linux-unflipped', 'linux');
    result = verify('linux', unflipped.dir);
    expect(result.output).toMatch(/^FAIL fuses: wire matches expectedFuses\(linux\)/m);
    expect(result.code).toBe(1);
  }, 60_000);

  it('the exe gets the app icon and version strings from electron-builder\'s resource edit, and keeps the integrity resource and fuses', async () => {
    // signAndEditExecutable:false 会连同图标与版本信息一起跳过；signExecutable:false 只跳过签名。
    expect(builderConfig.win.signExecutable).toBe(false);
    expect(builderConfig.win).not.toHaveProperty('signAndEditExecutable');
    const { dir, executable } = await unpackedDir('win-icon', 'win32');
    const resources = join(dir, 'resources');
    await addWinAsarIntegrity(executable, await computeData({ resourcesPath: resources, resourcesRelativePath: 'resources', resourcesDestinationPath: resources, extraResourceMatchers: [] }));
    await flipFuses(executable, fuseConfig('win32'));
    // WinPackager.signApp → signAndEditResources 在 afterPack（fuses）之后执行，参数形状同此。
    await editWindowsResources({
      file: executable,
      versionStrings: { FileDescription: builderConfig.productName, ProductName: builderConfig.productName, LegalCopyright: builderConfig.copyright, InternalName: 'Deep Student', OriginalFilename: '' },
      fileVersion: '1.2.3',
      productVersion: '1.2.3.0',
      iconPath: join(repoRoot, builderConfig.win.icon),
    });
    const { code, output } = verify('win32', dir);
    expect(output).toMatch(/^PASS fuses: wire matches expectedFuses\(win32\)/m);
    expect(output).toMatch(/^PASS integrity: exe resource INTEGRITY\/ELECTRONASAR = SHA256\(app\.asar header\)/m);
    expect(code, output).toBe(0);

    const edited = NtExecutableResource.from(NtExecutable.from(readFileSync(executable)));
    const groups = Resource.IconGroupEntry.fromEntries(edited.entries);
    expect(groups.map((group: { id: number }) => group.id)).toEqual([1]);
    const ico = readFileSync(join(repoRoot, builderConfig.win.icon));
    const images = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const at = 6 + 16 * index;
      return ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
    });
    const iconEntries = edited.entries.filter((entry: { type: number }) => entry.type === 3);
    expect(iconEntries.map((entry: { bin: ArrayBuffer }) => Buffer.from(entry.bin).toString('base64'))).toEqual(images.map((image) => image.toString('base64')));
    expect(Data.IconFile.from(ico).icons).toHaveLength(images.length);
    const [version] = Resource.VersionInfo.fromEntries(edited.entries);
    expect(version.getStringValues({ lang: 1033, codepage: 1200 })).toMatchObject({ ProductName: 'Deep Student', FileDescription: 'Deep Student', FileVersion: '1.2.3' });
  }, 60_000);

  it('a Linux build passes with the linux fuses (no asar integrity on Linux)', async () => {
    const { dir, executable } = await unpackedDir('linux-unpacked', 'linux');
    await flipFuses(executable, fuseConfig('linux'));
    const { code, output } = verify('linux', dir);
    expect(output).toMatch(/^PASS fuses: wire matches expectedFuses\(linux\)/m);
    expect(output).not.toMatch(/^(PASS|FAIL) integrity/m);
    expect(output).toMatch(/Linux has no asar integrity/);
    expect(code, output).toBe(0);
  }, 60_000);
});
