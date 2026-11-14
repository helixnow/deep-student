import { CommandError, AppError, type AppErrorType } from '../../../platform/errors/api.ts';

export class CloudStorageError extends CommandError {
  declare readonly value: AppError;

  constructor(type: AppErrorType, message: string, details: AppError['details'] = null) {
    super(AppError.with_details(type, message, details));
    this.message = message;
  }
}

/**
 * libuv `uv_strerror` text (identical on every platform) and the MSVC CRT errno used on Windows,
 * where libuv reports its own synthetic codes (`UV_ENOENT = -4058`) instead of the OS number.
 * `tests/errors.test.ts` pins the text against `util.getSystemErrorMap()`.
 */
const SYSTEM_ERRORS: Readonly<Record<string, readonly [message: string, windowsErrno: number]>> = {
  E2BIG: ['argument list too long', 7],
  EACCES: ['permission denied', 13],
  EADDRINUSE: ['address already in use', 100],
  EADDRNOTAVAIL: ['address not available', 101],
  EAFNOSUPPORT: ['address family not supported', 102],
  EAGAIN: ['resource temporarily unavailable', 11],
  EALREADY: ['connection already in progress', 103],
  EBADF: ['bad file descriptor', 9],
  EBUSY: ['resource busy or locked', 16],
  ECANCELED: ['operation canceled', 105],
  ECONNABORTED: ['software caused connection abort', 106],
  ECONNREFUSED: ['connection refused', 107],
  ECONNRESET: ['connection reset by peer', 108],
  EDESTADDRREQ: ['destination address required', 109],
  EEXIST: ['file already exists', 17],
  EFAULT: ['bad address in system call argument', 14],
  EFBIG: ['file too large', 27],
  EHOSTUNREACH: ['host is unreachable', 110],
  EILSEQ: ['illegal byte sequence', 42],
  EINTR: ['interrupted system call', 4],
  EINVAL: ['invalid argument', 22],
  EIO: ['i/o error', 5],
  EISCONN: ['socket is already connected', 113],
  EISDIR: ['illegal operation on a directory', 21],
  ELOOP: ['too many symbolic links encountered', 114],
  EMFILE: ['too many open files', 24],
  EMLINK: ['too many links', 31],
  EMSGSIZE: ['message too long', 115],
  ENAMETOOLONG: ['name too long', 38],
  ENETDOWN: ['network is down', 116],
  ENETUNREACH: ['network is unreachable', 118],
  ENFILE: ['file table overflow', 23],
  ENOBUFS: ['no buffer space available', 119],
  ENODATA: ['no data available', 120],
  ENODEV: ['no such device', 19],
  ENOENT: ['no such file or directory', 2],
  ENOEXEC: ['exec format error', 8],
  ENOMEM: ['not enough memory', 12],
  ENOPROTOOPT: ['protocol not available', 123],
  ENOSPC: ['no space left on device', 28],
  ENOSYS: ['function not implemented', 40], // boundary-allow todo-marker: libuv ENOSYS text, not a TODO
  ENOTCONN: ['socket is not connected', 126],
  ENOTDIR: ['not a directory', 20],
  ENOTEMPTY: ['directory not empty', 41],
  ENOTSOCK: ['socket operation on non-socket', 128],
  ENOTSUP: ['operation not supported on socket', 129],
  ENOTTY: ['inappropriate ioctl for device', 25],
  ENXIO: ['no such device or address', 6],
  EOVERFLOW: ['value too large for defined data type', 132],
  EPERM: ['operation not permitted', 1],
  EPIPE: ['broken pipe', 32],
  EPROTO: ['protocol error', 134],
  EPROTONOSUPPORT: ['protocol not supported', 135],
  EPROTOTYPE: ['protocol wrong type for socket', 136],
  ERANGE: ['result too large', 34],
  EROFS: ['read-only file system', 30],
  ESPIPE: ['invalid seek', 29],
  ESRCH: ['no such process', 3],
  ETIMEDOUT: ['connection timed out', 138],
  ETXTBSY: ['text file is busy', 139],
  EXDEV: ['cross-device link not permitted', 18],
};

/** libuv's own codes (Windows errors, `UV_EAI_*`, …) are all at or below this value. */
const UV_SYNTHETIC_ERRNO_MAX = -3000;

/** `std::io::Error` Display: `<Message> (os error N)` for OS errors, otherwise the error text. */
export function ioError(error: unknown): string {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  const known = typeof code === 'string' && Object.hasOwn(SYSTEM_ERRORS, code) ? SYSTEM_ERRORS[code] : undefined;
  if (known !== undefined && typeof errno === 'number' && errno < 0) {
    const osErrno = errno > UV_SYNTHETIC_ERRNO_MAX ? -errno : known[1];
    return `${known[0].charAt(0).toUpperCase()}${known[0].slice(1)} (os error ${osErrno})`;
  }
  return error instanceof Error ? error.message : String(error);
}
