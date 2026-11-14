/**
 * 内置插件命令的错误形状。
 *
 * Tauri 命令以 `Err(E)` 结束时，前端收到 E 的 serde 序列化值；本外壳实现的插件命令全部以字符串报错
 * （各插件 `Error` 的 `Serialize` 实现均为 `serialize_str(self.to_string())`）。
 */
import koffi from 'koffi';
import type { ShellPlatform } from './tauri-config.ts';

/** 命令以指定值 reject（对应 Rust `Err(E)` 的序列化值）。 */
export class ShellCommandError extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super(typeof value === 'string' ? value : JSON.stringify(value));
    this.name = 'ShellCommandError';
    this.value = value;
  }
}

/** tauri `Error::InvalidArgs` 文本：`invalid args `{key}` for command `{cmd}`: {serde error}`。 */
export function invalidArgs(command: string, key: string, detail: string): ShellCommandError {
  return new ShellCommandError(`invalid args \`${key}\` for command \`${command}\`: ${detail}`);
}

export function missingKey(command: string, key: string): ShellCommandError {
  return invalidArgs(command, key, `command ${command} missing required key ${key}`);
}

/**
 * Rust `std::io::Error` 对 OS 错误的 Display：`{strerror} (os error {code})`。
 * Node 只给出 libuv 的错误码名；这里把常见错误码映射回 Rust 在各平台上的原文。
 */
const UNIX_MESSAGES: Record<string, [darwin: number, linux: number, text: string]> = {
  EPERM: [1, 1, 'Operation not permitted'],
  ENOENT: [2, 2, 'No such file or directory'],
  EIO: [5, 5, 'Input/output error'],
  EBADF: [9, 9, 'Bad file descriptor'],
  EACCES: [13, 13, 'Permission denied'],
  EBUSY: [16, 16, 'Resource busy'],
  EEXIST: [17, 17, 'File exists'],
  EXDEV: [18, 18, 'Cross-device link'],
  ENOTDIR: [20, 20, 'Not a directory'],
  EISDIR: [21, 21, 'Is a directory'],
  EINVAL: [22, 22, 'Invalid argument'],
  EMFILE: [24, 24, 'Too many open files'],
  ENOSPC: [28, 28, 'No space left on device'],
  EROFS: [30, 30, 'Read-only file system'],
  ELOOP: [62, 40, 'Too many levels of symbolic links'],
  ENAMETOOLONG: [63, 36, 'File name too long'],
  ENOTEMPTY: [66, 39, 'Directory not empty'],
};

const LINUX_TEXT_OVERRIDES: Record<string, string> = {
  EBUSY: 'Device or resource busy',
  EXDEV: 'Invalid cross-device link',
};

/** Windows 错误码 → 文案；`text` 是 en-US 系统上 FormatMessageW 的输出，只在拿不到系统文案时使用。 */
const WINDOWS_MESSAGES: Record<string, [number, string]> = {
  ENOENT: [2, 'The system cannot find the file specified.'],
  EACCES: [5, 'Access is denied.'],
  EPERM: [5, 'Access is denied.'],
  EEXIST: [183, 'Cannot create a file when that file already exists.'],
  ENOTEMPTY: [145, 'The directory is not empty.'],
  EBUSY: [32, 'The process cannot access the file because it is being used by another process.'],
  EINVAL: [87, 'The parameter is incorrect.'],
  ENOTDIR: [267, 'The directory name is invalid.'],
  EISDIR: [5, 'Access is denied.'],
  ENOSPC: [112, 'There is not enough space on the disk.'],
  ENAMETOOLONG: [206, 'The filename or extension is too long.'],
  EXDEV: [17, 'The system cannot move the file to a different disk drive.'],
};

/** Windows 系统错误文案的来源：返回错误码 `code` 的文案，拿不到时返回 `null`。 */
export type WindowsSystemMessage = (code: number) => string | null;

const FORMAT_MESSAGE_IGNORE_INSERTS = 0x200;
const FORMAT_MESSAGE_FROM_SYSTEM = 0x1000;
const FORMAT_MESSAGE_BUFFER_CHARS = 2048;
/** `undefined`：还没加载；`null`：加载失败，之后不再重试。 */
let formatMessageW: ((...args: unknown[]) => number) | null | undefined;

/**
 * Rust `std::io::Error` 在 Windows 上的文案（std `sys/pal/windows/os.rs` `error_string`）：
 * `FormatMessageW(FROM_SYSTEM | IGNORE_INSERTS, languageId 0)`，即用户的系统语言，再去掉结尾空白。
 */
export function systemWindowsMessage(code: number): string | null {
  if (process.platform !== 'win32') return null;
  if (formatMessageW === undefined) {
    try {
      formatMessageW = koffi.load('kernel32.dll')
        .func('uint32 __stdcall FormatMessageW(uint32 flags, void *source, uint32 messageId, uint32 languageId, void *buffer, uint32 size, void *args)');
    } catch {
      formatMessageW = null;
    }
  }
  if (formatMessageW === null) return null;
  try {
    const buffer = Buffer.alloc(FORMAT_MESSAGE_BUFFER_CHARS * 2);
    const length = formatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, null, code, 0, buffer, FORMAT_MESSAGE_BUFFER_CHARS, null);
    return length === 0 ? null : buffer.toString('utf16le', 0, length * 2).trimEnd();
  } catch {
    return null;
  }
}

export function formatIoError(error: unknown, platform: ShellPlatform, windowsMessage: WindowsSystemMessage = systemWindowsMessage): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') {
    if (platform === 'win32') {
      const win = WINDOWS_MESSAGES[code];
      if (win) return `${windowsMessage(win[0]) ?? win[1]} (os error ${win[0]})`;
    } else {
      const unix = UNIX_MESSAGES[code];
      if (unix) {
        const text = platform === 'linux' ? (LINUX_TEXT_OVERRIDES[code] ?? unix[2]) : unix[2];
        return `${text} (os error ${platform === 'linux' ? unix[1] : unix[0]})`;
      }
    }
    const errno = (error as NodeJS.ErrnoException).errno;
    const syscallText = error.message.replace(/^[A-Z]+: /, '').replace(/, \w+ .*$/, '');
    const text = syscallText.charAt(0).toUpperCase() + syscallText.slice(1);
    return typeof errno === 'number' ? `${text} (os error ${Math.abs(errno)})` : text;
  }
  return error.message;
}

export function errorText(error: unknown): string {
  if (error instanceof ShellCommandError) return typeof error.value === 'string' ? error.value : JSON.stringify(error.value);
  if (error instanceof Error) return error.message;
  return String(error);
}
