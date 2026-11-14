/**
 * tauri-plugin-updater 2.10.0 `Update::install` 的 Electron 实现（从 updater.ts 拆出，行为不变）。
 *
 * 语义来源（只读）：`updater.rs::Update::install_inner`——macOS `.app.tar.gz` 解包替换、
 * Linux AppImage 同挂载点替换、Windows NSIS/MSI（含 `*.zip` 包装）启动安装器后退出；
 * `escape_nsis_current_exe_arg` / `escape_msi_property_arg` 转义当前进程参数。
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import koffi from 'koffi';
import { x as extractTar } from 'tar';
import { ShellCommandError } from './errors.ts';
import type { CheckedUpdate, UpdaterRuntime } from './updater.ts';

function ioText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function macAppPath(executable: string): string {
  const parent = dirname(executable);
  if (parent.includes(`Contents${sep}MacOS`) || parent.includes('Contents/MacOS')) return dirname(dirname(parent));
  return parent;
}

/** The installed app may live on a different volume from the updater's temp directory. */
function moveMacApp(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    rmSync(source, { recursive: true, force: true });
  }
}

const execFileAsync = promisify(execFile);

async function installMac(bytes: Uint8Array, execPath: string): Promise<void> {
  const appPath = macAppPath(execPath);
  const backup = mkdtempSync(join(tmpdir(), 'tauri_current_app'));
  const extract = mkdtempSync(join(tmpdir(), 'tauri_updated_app'));
  const archive = join(backup, 'update.app.tar.gz');
  writeFileSync(archive, bytes);
  try {
    // Electron's patched fs treats app.asar as a virtual directory. Use the
    // macOS system extractor so the sealed bundle is written to disk as-is.
    await execFileAsync('/usr/bin/tar', ['-xzf', archive, '--strip-components', '1', '--no-same-owner', '-C', extract]);
    const diskLstat = process.versions.electron
      ? (createRequire(import.meta.url)('original-fs') as { lstatSync: typeof lstatSync }).lstatSync
      : lstatSync;
    for (const required of ['Contents/Info.plist', join('Contents', 'MacOS', basename(execPath)), 'Contents/Resources/app.asar']) {
      if (!diskLstat(join(extract, required), { throwIfNoEntry: false })?.isFile()) {
        throw new ShellCommandError(`Invalid macOS update: missing ${required}`);
      }
    }
  } catch (error) {
    rmSync(extract, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    throw error instanceof ShellCommandError ? error : new ShellCommandError(ioText(error));
  }
  const backupApp = join(backup, 'current_app');
  try {
    moveMacApp(appPath, backupApp);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      rmSync(extract, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
      throw new ShellCommandError(ioText(error));
    }
    const script = `do shell script "rm -rf '${appPath}' && mv -f '${extract}' '${appPath}'" with administrator privileges`;
    try {
      execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
    } catch {
      if (!existsSync(appPath) && existsSync(backupApp)) moveMacApp(backupApp, appPath);
      rmSync(extract, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
      throw new ShellCommandError('Failed to move the new app into place');
    }
    rmSync(backup, { recursive: true, force: true });
    return;
  }
  try {
    rmSync(appPath, { recursive: true, force: true });
    moveMacApp(extract, appPath);
    const now = new Date();
    utimesSync(appPath, now, now);
  } catch (error) {
    if (existsSync(backupApp)) {
      // A failed cross-volume copy can leave a partial replacement behind.
      rmSync(appPath, { recursive: true, force: true });
      moveMacApp(backupApp, appPath);
    }
    rmSync(extract, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    throw new ShellCommandError(ioText(error));
  }
  // If restoring the backup throws, leave it available for recovery.
  rmSync(backup, { recursive: true, force: true });
}

function writeAppImage(bytes: Uint8Array, target: string, mode: number): void {
  writeFileSync(target, bytes);
  chmodSync(target, mode);
}

async function extractAppImage(bytes: Uint8Array, workDir: string, target: string): Promise<void> {
  const archive = join(workDir, 'update.tar.gz');
  const extracted = join(workDir, 'extracted');
  mkdirSync(extracted);
  writeFileSync(archive, bytes);
  await extractTar({ file: archive, cwd: extracted });
  const find = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = find(path);
        if (nested !== null) return nested;
      } else if (entry.name.endsWith('.AppImage')) return path;
    }
    return null;
  };
  const found = find(extracted);
  if (found === null) throw new ShellCommandError('binary for the current target not found in the archive');
  copyFileSync(found, target);
  chmodSync(target, statSync(found).mode);
}

async function installLinux(bytes: Uint8Array, runtime: UpdaterRuntime): Promise<void> {
  const executable = runtime.env.APPIMAGE ?? runtime.execPath;
  const executableStat = statSync(executable);
  const locations = [tmpdir(), runtime.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), dirname(executable)];
  for (const location of locations) {
    if (!existsSync(location)) continue;
    const workDir = mkdtempSync(join(location, 'tauri_current_app'));
    if (statSync(workDir).dev !== executableStat.dev) {
      rmSync(workDir, { recursive: true, force: true });
      continue;
    }
    chmodSync(workDir, 0o700);
    const backup = join(workDir, 'current_app.AppImage');
    renameSync(executable, backup);
    try {
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) await extractAppImage(bytes, workDir, executable);
      else writeAppImage(bytes, executable, executableStat.mode);
    } catch (error) {
      // 同 Rust（updater.rs:1017、1026、1036）无条件复原：新文件可能已写出一半，rename 直接覆盖它。
      renameSync(backup, executable);
      rmSync(workDir, { recursive: true, force: true });
      throw error instanceof ShellCommandError ? error : new ShellCommandError(ioText(error));
    }
    rmSync(workDir, { recursive: true, force: true });
    return;
  }
  throw new ShellCommandError('temp directory is not on the same mount point as the AppImage');
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function safeTarget(root: string, name: string): string | null {
  if (name.endsWith('/')) return null;
  if (isAbsolute(name)) throw new ShellCommandError('invalid Zip archive: absolute path');
  const path = normalize(join(root, name));
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ShellCommandError('invalid Zip archive: path traversal');
  return path;
}

/** 最小 ZIP 读取器（Tauri 的 NSIS/MSI `*.zip` 产物使用 store/deflate）。 */
export function extractZip(bytes: Uint8Array, root: string): void {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_558); i--) {
    if (readUInt32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ShellCommandError('invalid Zip archive: Could not find central directory end');
  const count = readUInt16(bytes, eocd + 10);
  let cursor = readUInt32(bytes, eocd + 16);
  for (let index = 0; index < count; index++) {
    if (readUInt32(bytes, cursor) !== 0x02014b50) throw new ShellCommandError('invalid Zip archive: Invalid central directory header');
    const method = readUInt16(bytes, cursor + 10);
    const compressedSize = readUInt32(bytes, cursor + 20);
    const nameLength = readUInt16(bytes, cursor + 28);
    const extraLength = readUInt16(bytes, cursor + 30);
    const commentLength = readUInt16(bytes, cursor + 32);
    const localOffset = readUInt32(bytes, cursor + 42);
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    const target = safeTarget(root, name);
    if (target === null) continue;
    if (readUInt32(bytes, localOffset) !== 0x04034b50) throw new ShellCommandError('invalid Zip archive: Invalid local file header');
    const localName = readUInt16(bytes, localOffset + 26);
    const localExtra = readUInt16(bytes, localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const compressed = bytes.subarray(start, start + compressedSize);
    let content: Uint8Array;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed);
    else throw new ShellCommandError(`invalid Zip archive: Unsupported compression method ${method}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function escapeNsisArg(arg: string): string {
  const quote = arg === '' || /[ \t/]/.test(arg);
  let output = quote ? '"' : '';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') backslashes++;
    else {
      if (char === '"') output += '\\'.repeat(backslashes + 1);
      backslashes = 0;
    }
    output += char;
  }
  if (quote) output += '\\'.repeat(backslashes) + '"';
  return output;
}

export function escapeMsiArg(arg: string): string {
  if (arg === '') return '""""';
  if (!arg.includes(' ') && !arg.includes('"')) return arg;
  const escaped = arg.replace(/"/g, '""""');
  return escaped.startsWith('-') && escaped.includes('=') ? escaped.replace('=', '=""') + '""' : `""${escaped}""`;
}

/** Tauri 用 semver 原文拼临时目录前缀；替换路径分隔符避免越界。 */
function versionSegment(version: string): string {
  return version.replace(/[\\/]/g, '_');
}

/** `write_to_temp`：`make_temp_dir()`（`{app}-{version}-updater-` + 随机后缀）里的 `{app}-{version}-installer{ext}`。 */
function writeToTemp(update: CheckedUpdate, runtime: UpdaterRuntime, bytes: Uint8Array, ext: '.exe' | '.msi'): string {
  const prefix = `${runtime.appName}-${versionSegment(update.version)}`;
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-updater-`));
  const installer = join(dir, `${prefix}-installer${ext}`);
  try { writeFileSync(installer, bytes); }
  catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return installer;
}

/** Win32 `ShellExecuteW(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd)`，在调用返回时完成。 */
export type ShellExecuteW = (hwnd: null, operation: string, file: string, parameters: string, directory: null, showCmd: number) => Promise<unknown>;

const SW_SHOW = 5;
let shell32ShellExecuteW: ShellExecuteW | undefined;

/**
 * shell32.dll 只在 Windows 上安装时加载。在 koffi 的工作线程上调用：需要提权时 ShellExecuteW 要等 UAC 结束才返回，
 * Rust 也是在 tokio 工作线程里调用，期间界面照常响应。
 */
function systemShellExecuteW(): ShellExecuteW {
  if (shell32ShellExecuteW === undefined) {
    const native = koffi.load('shell32.dll')
      .func('intptr_t __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)');
    shell32ShellExecuteW = (...args) => new Promise((resolve, reject) => {
      native.async(...args, (error: unknown, result: unknown) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
  return shell32ShellExecuteW;
}

async function installWindows(update: CheckedUpdate, bytes: Uint8Array, runtime: UpdaterRuntime, shellExecute: ShellExecuteW | undefined): Promise<void> {
  let installer: string;
  let isMsi = false;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const dir = mkdtempSync(join(tmpdir(), `${runtime.appName}-${versionSegment(update.version)}-updater-`));
    try {
      extractZip(bytes, dir);
      const files = readdirSync(dir).map((name) => join(dir, name));
      const exe = files.find((path) => path.endsWith('.exe'));
      const msi = files.find((path) => path.endsWith('.msi'));
      if (exe !== undefined) installer = exe;
      else if (msi !== undefined) { installer = msi; isMsi = true; }
      else throw new ShellCommandError('binary for the current target not found in the archive');
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  } else if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    installer = writeToTemp(update, runtime, bytes, '.exe');
  } else if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    installer = writeToTemp(update, runtime, bytes, '.msi');
    isMsi = true;
  } else {
    throw new ShellCommandError('invalid updater binary format');
  }
  const currentArgs = runtime.argv.slice(1);
  const extra = runtime.updater.windows?.installerArgs ?? [];
  const mode = runtime.updater.windows?.installMode ?? 'passive';
  let file: string;
  let args: string[];
  if (!isMsi) {
    const modeArgs = mode === 'passive' ? ['/P', '/R'] : mode === 'quiet' ? ['/S', '/R'] : [];
    file = installer;
    args = [...modeArgs, '/UPDATE', '/ARGS', ...currentArgs.map(escapeNsisArg), ...extra];
  } else {
    const escaped = currentArgs.map(escapeMsiArg).join(' ');
    const modeArg = mode === 'basicUi' ? '/qb+' : mode === 'quiet' ? '/quiet' : '/passive';
    file = runtime.env.SystemRoot === undefined ? 'msiexec.exe' : `${runtime.env.SystemRoot}\\System32\\msiexec.exe`;
    args = ['/i', `"${installer}"`, modeArg, '/promptrestart', ...extra, 'AUTOLAUNCHAPP=True', `LAUNCHAPPARGS="${escaped}"`];
  }
  // 参数原样以空格拼接、不再加引号（转义已由 escapeNsisArg / escapeMsiArg 完成）。
  try {
    const result = await (shellExecute ?? systemShellExecuteW())(null, 'open', file, args.join(' '), null, SW_SHOW);
    if (typeof result !== 'number' || !Number.isFinite(result) || result <= 32) {
      throw new ShellCommandError(`Failed to launch updater installer (ShellExecuteW: ${String(result)})`);
    }
  } catch (error) {
    rmSync(dirname(installer), { recursive: true, force: true });
    throw error;
  }
  runtime.exit(0);
}

/** `shellExecute` 只供测试注入；缺省在 Windows 上加载 shell32.dll。 */
export async function installPackage(update: CheckedUpdate, bytes: Uint8Array, runtime: UpdaterRuntime, shellExecute?: ShellExecuteW): Promise<void> {
  if (runtime.platform === 'darwin') return installMac(bytes, runtime.execPath);
  if (runtime.platform === 'linux') return installLinux(bytes, runtime);
  return installWindows(update, bytes, runtime, shellExecute);
}
