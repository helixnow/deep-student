/**
 * Rust `io::Error` Display 的可移植复刻（不依赖 Node 内建与 `process`）。平台由调用方传入；
 * `compat.ts` 的 `ioMessage` 按 `process.platform` 包装本模块。
 */

/** Node `fs` 错误码。 */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/** glibc `strerror` 文案。 */
const STRERROR_GLIBC: Record<string, string> = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EACCES: 'Permission denied',
  EBUSY: 'Device or resource busy',
  EEXIST: 'File exists',
  EXDEV: 'Invalid cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EAGAIN: 'Resource temporarily unavailable',
  EMFILE: 'Too many open files',
  ENFILE: 'Too many open files in system',
  ETXTBSY: 'Text file busy',
  EFBIG: 'File too large',
  ENOTSUP: 'Operation not supported',
  ETIMEDOUT: 'Connection timed out',
  EILSEQ: 'Invalid or incomplete multibyte or wide character',
};

/** macOS libc 与 glibc 文案不同的码（其余相同）。 */
const STRERROR_DARWIN: Record<string, string> = {
  ...STRERROR_GLIBC,
  EBUSY: 'Resource busy',
  EXDEV: 'Cross-device link',
  ETIMEDOUT: 'Operation timed out',
  EILSEQ: 'Illegal byte sequence',
};

/**
 * Rust `io::Error` 的 Display：OS 错误为 `<strerror> (os error N)`，文案取运行平台 libc 的 `strerror`。
 * `platform` 为 Node 平台名：darwin 用 macOS 文案，win32 退回错误自身的 message（Win32 错误码文案无法复刻），
 * 其余按 glibc；表外的码同样退回 message。
 */
export function ioMessageFor(error: unknown, platform: string): string {
  if (typeof error === 'object' && error !== null && platform !== 'win32') {
    const e = error as { code?: unknown; errno?: unknown };
    const code = typeof e.code === 'string' ? e.code : undefined;
    const text = code !== undefined ? (platform === 'darwin' ? STRERROR_DARWIN : STRERROR_GLIBC)[code] : undefined;
    if (text !== undefined && typeof e.errno === 'number') return `${text} (os error ${Math.abs(e.errno)})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * {@link ioMessageFor} on the running platform (`globalThis.process.platform`; without `process`, as in the
 * mobile Worker, glibc wording, which only applies to errors carrying a Node errno anyway).
 */
export function ioMessage(error: unknown): string {
  return ioMessageFor(error, (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux');
}
