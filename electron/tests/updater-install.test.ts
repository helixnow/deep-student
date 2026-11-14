/**
 * tauri-plugin-updater 2.10.0 `Update::install` 语义测试：ZIP 解包（越界拒绝）、
 * NSIS / MSI 参数转义（Rust `it_escapes_correctly_for_nsis` / `it_escapes_correctly_for_msi` 原样用例）、
 * macOS / Linux 在临时目录里真实替换，
 * Windows 注入 ShellExecuteW 替身记录参数（不启动安装器；koffi 换成替身，确认缺省绑定与只在 Windows 加载 shell32.dll）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckedUpdate, UpdaterRuntime } from '../shell/updater.ts';
import { escapeMsiArg, escapeNsisArg, extractZip, installPackage, type ShellExecuteW } from '../shell/updater-install.ts';

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: unknown }>);
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (command: string, args: string[], options: unknown) => {
    spawned.push({ command, args, options });
    return { unref: () => undefined };
  },
}));
/** 对这个路径的 chmodSync 失败（EPERM），其余照常。 */
const failChmod = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    chmodSync: (path: string, mode: number) => {
      if (path === failChmod.path) throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: 'EPERM' });
      fs.chmodSync(path, mode);
    },
  };
});
const koffiLoad = vi.hoisted(() => vi.fn());
vi.mock('koffi', () => ({ default: { load: koffiLoad } }));
const koffiLoadsAtImport = koffiLoad.mock.calls.slice();

let scratch = '';
let temp = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'w06-updater-install-'));
  temp = join(scratch, 'tmp');
  mkdirSync(temp);
  vi.stubEnv('TMPDIR', temp);
  spawned.length = 0;
  koffiLoad.mockReset();
  failChmod.path = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

interface ZipEntry { readonly name: string; readonly data?: string; readonly method?: number }

function zip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function update(version = '1.2.0'): CheckedUpdate {
  return {
    currentVersion: '1.0.0',
    version,
    date: null,
    body: null,
    rawJson: {},
    downloadUrl: 'https://updates.example.invalid/pkg',
    signature: 'unused',
    headers: new Headers(),
    proxy: null,
  };
}

function runtime(overrides: Partial<UpdaterRuntime> = {}): UpdaterRuntime & { exits: number[] } {
  const exits: number[] = [];
  return {
    appName: 'DeepStudent',
    execPath: join(scratch, 'DeepStudent'),
    argv: [join(scratch, 'DeepStudent')],
    env: {},
    exit: (code) => { exits.push(code); },
    platform: 'linux',
    arch: 'x64',
    version: '1.0.0',
    debug: false,
    updater: { endpoints: [], pubkey: 'unused' },
    ...overrides,
    exits,
  };
}

async function tarGz(root: string, entries: Record<string, string>, top: string): Promise<Buffer> {
  const source = join(scratch, `tar-src-${Object.keys(entries).length}-${top}`);
  for (const [path, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  const archive = join(root, `${top}.tar.gz`);
  await createTar({ gzip: true, file: archive, cwd: source }, [top]);
  return readFileSync(archive);
}

describe('extract_zip', () => {
  it('extracts stored and deflated entries, creating nested directories and skipping directory entries', () => {
    const root = join(scratch, 'out');
    mkdirSync(root);
    extractZip(zip([
      { name: 'Deep_1.2.0_x64-setup.exe', data: 'MZ stored payload' },
      { name: 'docs/' },
      { name: 'docs/readme.txt', data: 'deflated '.repeat(64), method: 8 },
    ]), root);
    expect(readFileSync(join(root, 'Deep_1.2.0_x64-setup.exe'), 'utf8')).toBe('MZ stored payload');
    expect(readFileSync(join(root, 'docs/readme.txt'), 'utf8')).toBe('deflated '.repeat(64));
    expect(readdirSync(root).sort()).toEqual(['Deep_1.2.0_x64-setup.exe', 'docs']);
  });

  it('refuses entries that escape the extraction directory and writes nothing outside it', () => {
    const root = join(scratch, 'out');
    mkdirSync(root);
    expect(() => extractZip(zip([{ name: '../escaped.exe', data: 'x' }]), root)).toThrow('invalid Zip archive: path traversal');
    expect(() => extractZip(zip([{ name: 'a/../../escaped.exe', data: 'x' }]), root)).toThrow('invalid Zip archive: path traversal');
    expect(() => extractZip(zip([{ name: join(scratch, 'absolute.exe'), data: 'x' }]), root)).toThrow('invalid Zip archive: absolute path');
    expect(existsSync(join(scratch, 'escaped.exe'))).toBe(false);
    expect(existsSync(join(scratch, 'absolute.exe'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects data without an end-of-central-directory record and unsupported compression methods', () => {
    const root = join(scratch, 'out');
    mkdirSync(root);
    expect(() => extractZip(Buffer.from('PK\u0003\u0004 not really a zip'), root)).toThrow('invalid Zip archive: Could not find central directory end');
    expect(() => extractZip(zip([{ name: 'setup.exe', data: 'x', method: 12 }]), root)).toThrow('invalid Zip archive: Unsupported compression method 12');
  });
});

describe('escape_nsis_current_exe_arg', () => {
  it('matches the tauri-plugin-updater 2.10.0 it_escapes_correctly_for_nsis vectors', () => {
    const cases: Array<[string, string]> = [
      ['something', 'something'],
      ['--flag', '--flag'],
      ['--empty=', '--empty='],
      ['--arg=value', '--arg=value'],
      ['some space', '"some space"'],
      ['--arg value', '"--arg value"'],
      ['--arg=unwrapped space', '"--arg=unwrapped space"'],
      ['--arg="wrapped"', '--arg=\\"wrapped\\"'],
      ['--arg="wrapped space"', '"--arg=\\"wrapped space\\""'],
      ['--arg=midword"wrapped space"', '"--arg=midword\\"wrapped space\\""'],
      ['', '""'],
    ];
    for (const [input, escaped] of cases) expect(escapeNsisArg(input), input).toBe(escaped);
  });

  it('quotes "/" so NSIS does not read it as its own switch and doubles trailing backslashes before the closing quote', () => {
    expect(escapeNsisArg('/S')).toBe('"/S"');
    expect(escapeNsisArg('C:\\Some Dir\\')).toBe('"C:\\Some Dir\\\\"');
    expect(escapeNsisArg('a\\\\"b')).toBe('a\\\\\\\\\\"b');
  });
});

describe('escape_msi_property_arg', () => {
  it('matches the tauri-plugin-updater 2.10.0 it_escapes_correctly_for_msi vectors (each inner quote becomes four quotes)', () => {
    const cases: Array<[string, string]> = [
      ['something', 'something'],
      ['--flag', '--flag'],
      ['--empty=', '--empty='],
      ['--arg=value', '--arg=value'],
      ['some space', '""some space""'],
      ['--arg value', '""--arg value""'],
      ['--arg=unwrapped space', '--arg=""unwrapped space""'],
      ['--arg="wrapped"', '--arg=""""""wrapped""""""'],
      ['--arg="wrapped space"', '--arg=""""""wrapped space""""""'],
      ['--arg=midword"wrapped space"', '--arg=""midword""""wrapped space""""""'],
      ['', '""""'],
    ];
    for (const [input, escaped] of cases) expect(escapeMsiArg(input), input).toBe(escaped);
  });
});

// The production path uses /usr/bin/tar, available on macOS and Linux.
describe.skipIf(process.platform === 'win32')('install on macOS', () => {
  it('replaces the .app bundle with the archive contents (top-level directory stripped) and removes its temp directories', async () => {
    const app = join(scratch, 'Deep Student.app');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/MacOS/Deep Student'), 'old binary');
    writeFileSync(join(app, 'Contents/stale.txt'), 'removed by the update');
    const bytes = await tarGz(scratch, {
      'Deep Student.app/Contents/MacOS/Deep Student': 'new binary',
      'Deep Student.app/Contents/Info.plist': '<plist/>',
      'Deep Student.app/Contents/Resources/app.asar': 'sealed app content',
    }, 'Deep Student.app');
    await installPackage(update(), bytes, runtime({ platform: 'darwin', execPath: join(app, 'Contents/MacOS/Deep Student') }));
    expect(readFileSync(join(app, 'Contents/MacOS/Deep Student'), 'utf8')).toBe('new binary');
    expect(readFileSync(join(app, 'Contents/Info.plist'), 'utf8')).toBe('<plist/>');
    expect(readFileSync(join(app, 'Contents/Resources/app.asar'), 'utf8')).toBe('sealed app content');
    expect(existsSync(join(app, 'Contents/stale.txt'))).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('keeps the current bundle when a valid archive omits the packaged application', async () => {
    const app = join(scratch, 'Deep Student.app');
    const executable = join(app, 'Contents/MacOS/Deep Student');
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, 'old binary');
    const bytes = await tarGz(scratch, {
      'Deep Student.app/Contents/MacOS/Deep Student': 'new binary',
      'Deep Student.app/Contents/Info.plist': '<plist/>',
    }, 'Deep Student.app');
    await expect(installPackage(update(), bytes, runtime({ platform: 'darwin', execPath: executable })))
      .rejects.toThrow('Invalid macOS update: missing Contents/Resources/app.asar');
    expect(readFileSync(executable, 'utf8')).toBe('old binary');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('keeps the current bundle and cleans up when the archive cannot be extracted', async () => {
    const app = join(scratch, 'Deep Student.app');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/MacOS/Deep Student'), 'old binary');
    await expect(installPackage(update(), Buffer.from('not a tarball'), runtime({ platform: 'darwin', execPath: join(app, 'Contents/MacOS/Deep Student') })))
      .rejects.toThrow();
    expect(readFileSync(join(app, 'Contents/MacOS/Deep Student'), 'utf8')).toBe('old binary');
    expect(readdirSync(temp)).toEqual([]);
  });
});

describe('install on Linux (AppImage)', () => {
  function appImage(): string {
    const path = join(scratch, 'Deep_Student.AppImage');
    writeFileSync(path, 'old AppImage');
    chmodSync(path, 0o755);
    return path;
  }

  it('writes a raw AppImage over $APPIMAGE keeping its mode, through a work directory on the same mount', async () => {
    const path = appImage();
    await installPackage(update(), Buffer.from('new AppImage'), runtime({ env: { APPIMAGE: path } }));
    expect(readFileSync(path, 'utf8')).toBe('new AppImage');
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('takes the first *.AppImage from a gzip tarball', async () => {
    const path = appImage();
    const bytes = await tarGz(scratch, { 'bundle/nested/Deep_Student_1.2.0.AppImage': 'new from tarball', 'bundle/README': 'x' }, 'bundle');
    await installPackage(update(), bytes, runtime({ env: { APPIMAGE: path } }));
    expect(readFileSync(path, 'utf8')).toBe('new from tarball');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('restores the current AppImage when the tarball has no AppImage', async () => {
    const path = appImage();
    const bytes = await tarGz(scratch, { 'bundle/README': 'x' }, 'bundle');
    await expect(installPackage(update(), bytes, runtime({ env: { APPIMAGE: path } })))
      .rejects.toThrow('binary for the current target not found in the archive');
    expect(readFileSync(path, 'utf8')).toBe('old AppImage');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('restores the current AppImage over a new one already written when a later step fails, raw or from a tarball (updater.rs:1017, 1036)', async () => {
    const path = appImage();
    failChmod.path = path;
    await expect(installPackage(update(), Buffer.from('new AppImage'), runtime({ env: { APPIMAGE: path } }))).rejects.toThrow('EPERM');
    expect(readFileSync(path, 'utf8')).toBe('old AppImage');
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readdirSync(temp)).toEqual([]);
    const bytes = await tarGz(scratch, { 'bundle/Deep_Student_1.2.0.AppImage': 'new from tarball' }, 'bundle');
    await expect(installPackage(update(), bytes, runtime({ env: { APPIMAGE: path } }))).rejects.toThrow('EPERM');
    expect(readFileSync(path, 'utf8')).toBe('old AppImage');
    expect(readdirSync(temp)).toEqual([]);
  });
});

describe('install on Windows (ShellExecuteW injected; updater.rs install_inner, Windows branch)', () => {
  const nsis = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]);
  const msi = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const argv = ['C:\\Program Files\\Deep Student\\deep-student.exe', '--flag', 'some space'];
  const SW_SHOW = 5;

  function recorder() {
    const calls: Array<Parameters<ShellExecuteW>> = [];
    const shellExecute: ShellExecuteW = async (...args) => { calls.push(args); return 42; };
    return { calls, shellExecute };
  }

  // updater.rs:801-816、849-862：nsis_args() + /UPDATE /ARGS + escape_nsis_current_exe_arg(argv[1..]) + installer_args，
  // 以 " " 拼成一个参数串，ShellExecuteW(null, w!("open"), installer, parameters, null, SW_SHOW)，然后 exit(0)。
  it('NSIS: ShellExecuteW(NULL, "open", installer, mode switches /UPDATE /ARGS escaped args installerArgs joined by one space, NULL, SW_SHOW), then exit 0', async () => {
    const app = runtime({ platform: 'win32', argv, updater: { endpoints: [], pubkey: 'unused', windows: { installerArgs: ['/D=C:\\Deep'] } } });
    const shell = recorder();
    await installPackage(update(), nsis, app, shell.shellExecute);
    expect(shell.calls).toHaveLength(1);
    const [[, , file]] = shell.calls as [Parameters<ShellExecuteW>];
    expect(shell.calls).toEqual([[null, 'open', file, '/P /R /UPDATE /ARGS --flag "some space" /D=C:\\Deep', null, SW_SHOW]]);
    expect(relative(temp, file)).toMatch(/^DeepStudent-1\.2\.0-updater-[^/\\]+[/\\]DeepStudent-1\.2\.0-installer\.exe$/);
    expect(readFileSync(file)).toEqual(nsis);
    expect(app.exits).toEqual([0]);
    expect(spawned).toEqual([]);
  });

  it('maps installMode to NSIS switches like InstallMode::nsis_args (quiet → /S /R, basicUi → none)', async () => {
    const shell = recorder();
    await installPackage(update(), nsis, runtime({ platform: 'win32', updater: { endpoints: [], pubkey: 'unused', windows: { installMode: 'quiet' } } }), shell.shellExecute);
    await installPackage(update(), nsis, runtime({ platform: 'win32', updater: { endpoints: [], pubkey: 'unused', windows: { installMode: 'basicUi' } } }), shell.shellExecute);
    expect(shell.calls.map((call) => call[3])).toEqual(['/S /R /UPDATE /ARGS', '/UPDATE /ARGS']);
  });

  // updater.rs:818-833、842-848：msiexec.exe（有 SYSTEMROOT 时 "{SYSTEMROOT}\System32\msiexec.exe"），
  // /i <msi> msiexec_args() /promptrestart installer_args AUTOLAUNCHAPP=True LAUNCHAPPARGS="<escape_msi_property_arg 以空格拼接>"。
  it('MSI: ShellExecuteW runs msiexec with /i <msi> <mode> /promptrestart installerArgs AUTOLAUNCHAPP=True LAUNCHAPPARGS="…" joined by one space', async () => {
    const app = runtime({ platform: 'win32', argv, updater: { endpoints: [], pubkey: 'unused', windows: { installerArgs: ['TARGETDIR=C:\\Deep'], installMode: 'basicUi' } } });
    const shell = recorder();
    await installPackage(update(), msi, app, shell.shellExecute);
    await installPackage(update(), msi, runtime({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }), shell.shellExecute);
    const [first, second] = shell.calls as [Parameters<ShellExecuteW>, Parameters<ShellExecuteW>];
    const firstMsi = /^\/i "([^"]+)" /.exec(first[3])![1]!;
    const secondMsi = /^\/i "([^"]+)" /.exec(second[3])![1]!;
    expect(first).toEqual([null, 'open', 'msiexec.exe', `/i "${firstMsi}" /qb+ /promptrestart TARGETDIR=C:\\Deep AUTOLAUNCHAPP=True LAUNCHAPPARGS="--flag ""some space"""`, null, SW_SHOW]);
    expect(second).toEqual([null, 'open', 'C:\\Windows\\System32\\msiexec.exe', `/i "${secondMsi}" /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=""`, null, SW_SHOW]);
    expect(relative(temp, firstMsi)).toMatch(/^DeepStudent-1\.2\.0-updater-[^/\\]+[/\\]DeepStudent-1\.2\.0-installer\.msi$/);
    expect(readFileSync(firstMsi)).toEqual(msi);
    expect(app.exits).toEqual([0]);
    expect(spawned).toEqual([]);
  });

  it('prefers the .exe inside a zip, keeps the version-named temp directory inside the temp root, and refuses zips without an installer', async () => {
    const shell = recorder();
    await installPackage(update('1.2.0/../../escape'), zip([
      { name: 'Deep_1.2.0_x64.msi', data: 'msi' },
      { name: 'Deep_1.2.0_x64-setup.exe', data: 'exe', method: 8 },
    ]), runtime({ platform: 'win32' }), shell.shellExecute);
    const [[, , file]] = shell.calls as [Parameters<ShellExecuteW>];
    expect(relative(temp, file)).toMatch(/^DeepStudent-1\.2\.0_\.\._\.\._escape-updater-[^/\\]+[/\\]Deep_1\.2\.0_x64-setup\.exe$/);
    expect(readFileSync(file, 'utf8')).toBe('exe');
    await expect(installPackage(update(), zip([{ name: 'notes.txt', data: 'x' }]), runtime({ platform: 'win32' }), shell.shellExecute))
      .rejects.toThrow('binary for the current target not found in the archive');
    await expect(installPackage(update(), Buffer.from('garbage'), runtime({ platform: 'win32' }), shell.shellExecute))
      .rejects.toThrow('invalid updater binary format');
    expect(shell.calls).toHaveLength(1);
  });

  it('quotes MSI installer paths containing spaces for msiexec', async () => {
    const shell = recorder();
    await installPackage(update(), msi, runtime({ platform: 'win32', appName: 'Deep Student' }), shell.shellExecute);
    const parameters = shell.calls[0]![3];
    const path = /^\/i "([^"]+)" \/passive /.exec(parameters)?.[1];
    expect(path).toContain('Deep Student');
    expect(readFileSync(path!)).toEqual(msi);
  });

  it('keeps the app open when ShellExecuteW reports a declined or failed launch', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const returned = new Promise((resolve) => { finish = resolve; });
    const app = runtime({ platform: 'win32' });
    const installing = installPackage(update(), nsis, app, () => returned);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.exits).toEqual([]);
    finish(5);
    await expect(installing).rejects.toThrow('Failed to launch updater installer (ShellExecuteW: 5)');
    expect(app.exits).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('a call koffi itself cannot make fails the install instead of exiting with no installer started', async () => {
    const app = runtime({ platform: 'win32' });
    await expect(installPackage(update(), nsis, app, async () => { throw new Error('koffi: call failed'); })).rejects.toThrow('koffi: call failed');
    expect(app.exits).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('removes partially extracted archives and archives without an installer', async () => {
    const shell = recorder();
    await expect(installPackage(update(), zip([{ name: 'readme.txt', data: 'no installer' }]), runtime({ platform: 'win32' }), shell.shellExecute)).rejects.toThrow('not found');
    expect(readdirSync(temp)).toEqual([]);
    await expect(installPackage(update(), zip([
      { name: 'readme.txt', data: 'written before failure' },
      { name: 'setup.exe', data: 'unsupported', method: 12 },
    ]), runtime({ platform: 'win32' }), shell.shellExecute)).rejects.toThrow('Unsupported compression');
    expect(readdirSync(temp)).toEqual([]);
    expect(shell.calls).toHaveLength(0);
  });

  it('without an injected function, shell32.dll is loaded once with the ShellExecuteW prototype and called on a koffi worker thread', async () => {
    const workerCalls: unknown[][] = [];
    const native = {
      async: vi.fn((...args: unknown[]) => {
        const done = args.pop() as (error: unknown, result: unknown) => void;
        workerCalls.push(args);
        done(null, 42);
      }),
    };
    const func = vi.fn(() => native);
    koffiLoad.mockReturnValue({ func });
    const app = runtime({ platform: 'win32', argv });
    await installPackage(update(), nsis, app);
    await installPackage(update(), nsis, app);
    expect(koffiLoad.mock.calls).toEqual([['shell32.dll']]);
    expect(func.mock.calls).toEqual([['intptr_t __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)']]);
    expect(workerCalls.map((call) => [call[0], call[1], call[3], call[4], call[5]])).toEqual([
      [null, 'open', '/P /R /UPDATE /ARGS --flag "some space"', null, SW_SHOW],
      [null, 'open', '/P /R /UPDATE /ARGS --flag "some space"', null, SW_SHOW],
    ]);
    expect(app.exits).toEqual([0, 0]);
  });

  it('macOS and Linux never load shell32.dll, neither when the module is imported nor when installing', async () => {
    expect(koffiLoadsAtImport).toEqual([]);
    const path = join(scratch, 'Deep_Student.AppImage');
    writeFileSync(path, 'old AppImage');
    await installPackage(update(), Buffer.from('new AppImage'), runtime({ env: { APPIMAGE: path } }));
    expect(koffiLoad).not.toHaveBeenCalled();
  });
});
