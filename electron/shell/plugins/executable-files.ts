/**
 * `plugin:opener|open_path` 不交给系统打开的可执行目标。RUST-FIX(RF-W23-opener-open-path-executables)：
 * tauri-plugin-opener 2.5.3 只校验作用域就调用 `open::that_detached`，而系统默认程序“打开”可执行文件就是运行它
 * （Windows .exe/.bat/.lnk，macOS .app/.command/无扩展名的可执行文件，Linux .desktop/.AppImage）。主窗口对
 * $TEMP/$DOCUMENT/$DOWNLOAD 有 `plugin:fs` 写权限（`write_file` 还能带 `mode`），页面里一处脚本注入即可落地并启动程序。
 *
 * 判定（任一命中即拒绝）：给定路径或其真实路径的扩展名在可执行类型表中（Windows 另加 `PATHEXT`）；macOS 上带
 * `Contents/MacOS` 的目录（应用包）；普通文件以 ELF / Mach-O / PE 或 `#!` 开头；POSIX 上无扩展名且带执行位的
 * 普通文件。带执行位但有扩展名的文档（FAT/exFAT 拷来的文件常是 0777）不拒绝：系统按扩展名选程序打开它们。
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { join, posix, win32 } from 'node:path';

const SHELL_SCRIPTS = ['.sh', '.bash', '.zsh', '.csh', '.ksh', '.tcsh', '.fish'];

/** 各平台默认程序会运行、安装或转去启动别的程序的类型（小写，含点）。 */
const EXECUTABLE_EXTENSIONS: Readonly<Record<'win32' | 'darwin' | 'linux', ReadonlySet<string>>> = {
  // 可执行、脚本宿主、安装包、快捷方式与会执行内容的文档；.sh 在装了 Git for Windows 时由 bash 运行
  win32: new Set([
    '.exe', '.com', '.bat', '.cmd', '.pif', '.scr', '.cpl', '.msc', '.msi', '.msp', '.mst', '.msix', '.msixbundle',
    '.appx', '.appxbundle', '.appref-ms', '.application', '.gadget', '.xbap', '.hta', '.chm', '.lnk', '.url', '.scf',
    '.inf', '.reg', '.ps1', '.ps1xml', '.ps2', '.ps2xml', '.psc1', '.psc2', '.psd1', '.psm1', '.vb', '.vbe', '.vbs',
    '.js', '.jse', '.ws', '.wsc', '.wsf', '.wsh', '.settingcontent-ms', '.library-ms', '.diagcab', '.xll', '.jar',
    '.sh', '.bash',
  ]),
  // 应用与安装包、终端会话、Automator、位置文件（可指向程序或 file: URL）
  darwin: new Set([
    '.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.pkg', '.mpkg', '.prefpane', '.saver',
    '.fileloc', '.webloc', '.inetloc', '.jar', ...SHELL_SCRIPTS,
  ]),
  linux: new Set(['.desktop', '.appimage', '.run', '.bin', '.jar', ...SHELL_SCRIPTS]),
};

const NATIVE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca], // Mach-O universal
  [0x4d, 0x5a], // PE（MZ）
  [0x23, 0x21], // #!
];

/** 路径最后一段的扩展名（小写）；Windows 先去掉备用数据流后缀与结尾的点和空格（系统打开时同样忽略）。 */
function extensionOf(path: string, platform: NodeJS.Platform): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  let name = paths.basename(path);
  if (platform === 'win32') name = name.replace(/:.*$/, '').replace(/[. ]+$/, '');
  const ext = paths.extname(name).toLowerCase();
  return ext === '' ? null : ext;
}

function executableExtensions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ReadonlySet<string> {
  if (platform === 'darwin') return EXECUTABLE_EXTENSIONS.darwin;
  if (platform !== 'win32') return EXECUTABLE_EXTENSIONS.linux;
  const extra = (env.PATHEXT ?? '').split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith('.'));
  return new Set([...EXECUTABLE_EXTENSIONS.win32, ...extra]);
}

function leadingBytes(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(4);
    return buffer.subarray(0, readSync(fd, buffer, 0, 4, 0));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function realPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** `path` 是可执行目标时返回原因，否则 null（不存在的路径交给 `open_path` 自己的存在性检查报错）。 */
export function executableTarget(path: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const real = realPath(path);
  const extensions = executableExtensions(platform, env);
  for (const candidate of real === null || real === path ? [path] : [path, real]) {
    const ext = extensionOf(candidate, platform);
    if (ext !== null && extensions.has(ext)) return `executable file type ${ext}`;
  }
  const target = real ?? path;
  const stats = statOf(target);
  if (stats === null) return null;
  if (stats.isDirectory()) {
    return platform === 'darwin' && existsSync(join(target, 'Contents', 'MacOS')) ? 'application bundle' : null;
  }
  if (!stats.isFile()) return null;
  const head = leadingBytes(target);
  if (head !== null && NATIVE_MAGIC.some((magic) => magic.length <= head.length && magic.every((byte, i) => head[i] === byte))) {
    return 'executable content';
  }
  if (platform !== 'win32' && (stats.mode & 0o111) !== 0 && extensionOf(target, platform) === null) return 'executable permission bits';
  return null;
}
