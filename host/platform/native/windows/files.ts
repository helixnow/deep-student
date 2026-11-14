import koffi from 'koffi';
import type { NativeWindowsFiles, WindowsFileInformation, WindowsRegularFile } from './api.ts';

let bindings: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== 'win32') throw new Error('Windows native file operations require Windows');
  const kernel = koffi.load('kernel32.dll');
  return {
    create: kernel.func('void * __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template_file)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    info: kernel.func('int __stdcall GetFileInformationByHandle(void *handle, void *information)'),
    attributes: kernel.func('uint32 __stdcall GetFileAttributesW(str16 path)'),
    error: kernel.func('uint32 __stdcall GetLastError()'),
    message: kernel.func('uint32 __stdcall FormatMessageW(uint32 flags, void *source, uint32 code, uint32 language, void *buffer, uint32 size, void *arguments)'),
    seek: kernel.func('int __stdcall SetFilePointerEx(void *handle, int64 distance, void *position, uint32 method)'),
    read: kernel.func('int __stdcall ReadFile(void *handle, void *buffer, uint32 count, void *read, void *overlapped)'),
  };
}
function api(): ReturnType<typeof load> { return bindings ??= load(); }

function ioError(code: number): string {
  const buffer = Buffer.alloc(65536 * 2);
  const count = api().message(0x1000 | 0x0200, null, code, 0, buffer, 65536, null) as number;
  const message = count === 0 ? 'unknown error' : buffer.subarray(0, count * 2).toString('utf16le').replace(/[\r\n]+$/u, '');
  return `${message} (os error ${code})`;
}

function open(path: string, access: number, flags: number): unknown {
  const handle: unknown = api().create(path, access, 7, null, 3, flags, null);
  if (handle === null || koffi.address(handle) === 0xffffffffffffffffn) throw new Error(ioError(api().error() as number));
  return handle;
}

function information(handle: unknown): WindowsFileInformation {
  // BY_HANDLE_FILE_INFORMATION: 13 DWORDs, FILETIME alignment4 on both Windows targets.
  const buffer = Buffer.alloc(52);
  if (api().info(handle, buffer) === 0) throw new Error(ioError(api().error() as number));
  return {
    attributes: buffer.readUInt32LE(0), volume_serial_number: buffer.readUInt32LE(28),
    size: (BigInt(buffer.readUInt32LE(32)) << 32n) | BigInt(buffer.readUInt32LE(36)),
    file_index: (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48)),
  };
}

export const windowsFiles: NativeWindowsFiles = {
  ioError,
  runtimeRootIdentity(path) {
    let handle: unknown;
    try { handle = open(path, 0, 0x02000000); } // FILE_FLAG_BACKUP_SEMANTICS
    catch (error) { throw new Error(`Failed to open runtime root identity: ${String(error instanceof Error ? error.message : error)}`); }
    try {
      let info: WindowsFileInformation;
      try { info = information(handle); }
      catch (error) { throw new Error(`Failed to inspect runtime root identity: ${String(error instanceof Error ? error.message : error)}`); }
      return { kind: 'windows', volume_serial_number: info.volume_serial_number, file_index: info.file_index };
    } finally { api().close(handle); } // Rust File::drop ignores CloseHandle's return value.
  },
  openRegularFileNoFollow(path, label): WindowsRegularFile {
    const attributes = api().attributes(path) as number;
    if (attributes === 0xffffffff) throw new Error(`Failed to inspect ${label}: ${ioError(api().error() as number)}`);
    if ((attributes & (0x10 | 0x400)) !== 0) throw new Error(`${label} must be a regular file, not a symlink`);
    let handle: unknown;
    try { handle = open(path, 0x80000000, 0x00200000); } // GENERIC_READ / OPEN_REPARSE_POINT
    catch (error) { throw new Error(`Failed to open ${label}: ${String(error instanceof Error ? error.message : error)}`); }
    let info: WindowsFileInformation;
    try {
      try { info = information(handle); }
      catch (error) { throw new Error(`Failed to inspect opened ${label}: ${String(error instanceof Error ? error.message : error)}`); }
      if ((info.attributes & 0x10) !== 0) throw new Error(`${label} changed while it was being opened`);
      if ((info.attributes & 0x400) !== 0) throw new Error(`${label} must be a regular file, not a symlink`);
    } catch (error) { api().close(handle); throw error; }
    let closed = false;
    return {
      information: info,
      read(maxBytes) {
        if (closed) throw new Error('file handle is closed');
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || info.size > BigInt(maxBytes)) throw new RangeError('file exceeds read limit');
        if (api().seek(handle, 0n, null, 0) === 0) throw new Error(ioError(api().error() as number));
        const chunks: Buffer[] = [];
        let length = 0;
        for (;;) {
          const count = Buffer.alloc(4);
          const buffer = Buffer.alloc(Math.min(1024 * 1024, maxBytes - length + 1));
          if (api().read(handle, buffer, buffer.length, count, null) === 0) throw new Error(ioError(api().error() as number));
          const read = count.readUInt32LE(0);
          if (read === 0) break;
          length += read;
          if (length > maxBytes) throw new RangeError('file exceeds read limit');
          chunks.push(buffer.subarray(0, read));
        }
        return Buffer.concat(chunks, length);
      },
      readAt(offset, maxBytes) {
        if (closed) throw new Error('file handle is closed');
        if (typeof offset !== 'bigint' || offset < 0n || offset > 0x7fffffffffffffffn) throw new RangeError('invalid file offset');
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 0xffffffff) throw new RangeError('invalid read length');
        if (maxBytes === 0) return new Uint8Array(0);
        if (api().seek(handle, offset, null, 0) === 0) throw new Error(ioError(api().error() as number));
        const count = Buffer.alloc(4);
        const buffer = Buffer.alloc(maxBytes);
        if (api().read(handle, buffer, maxBytes, count, null) === 0) throw new Error(ioError(api().error() as number));
        return buffer.subarray(0, count.readUInt32LE(0));
      },
      refreshInformation() {
        if (closed) throw new Error('file handle is closed');
        return information(handle);
      },
      close() { if (!closed) { api().close(handle); closed = true; } },
    };
  },
};
