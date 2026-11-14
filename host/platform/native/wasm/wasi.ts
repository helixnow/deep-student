/**
 * In-memory WASI preview1 for the F7 command module on platforms without
 * `node:wasi` (WebView, browser, Web Worker). It implements exactly the
 * `wasi_snapshot_preview1` imports `f7-native-wasm.wasm` declares: argv/env,
 * clocks, randomness, stdio and flat files inside preopened directories.
 * There is no directory listing or sub-directory creation; the guest never
 * uses either. Errno, filetype and flag values are the preview1 witx values.
 */

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
const ERRNO_ROFS = 68;
const ERRNO_SPIPE = 69;
const ERRNO_NOTCAPABLE = 75;

const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const RIGHTS_FD_WRITE = 1n << 6n;
const RIGHTS_ALL = (1n << 30n) - 1n;

const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
const CLOCK_PROCESS_CPUTIME = 2;
const CLOCK_THREAD_CPUTIME = 3;

class MemoryFile {
  bytes: Uint8Array;
  size: number;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes.slice();
    this.size = bytes.length;
  }
  ensure(capacity: number): void {
    if (capacity <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(capacity, this.bytes.length * 2, 4096));
    grown.set(this.bytes.subarray(0, this.size));
    this.bytes = grown;
  }
}

/** A flat directory of files, keyed by guest-relative path (`a.png`, `sub/b.bin`). */
export class MemoryDirectory {
  readonly readonly: boolean;
  private readonly files = new Map<string, MemoryFile>();
  constructor(files: Record<string, Uint8Array> = {}, options: { readonly?: boolean } = {}) {
    this.readonly = options.readonly ?? false;
    for (const [name, bytes] of Object.entries(files)) this.write(name, bytes);
  }
  write(name: string, bytes: Uint8Array): void {
    this.files.set(name, new MemoryFile(bytes));
  }
  read(name: string): Uint8Array | undefined {
    const file = this.files.get(name);
    return file === undefined ? undefined : file.bytes.slice(0, file.size);
  }
  /** Snapshot of every file, copied out of the guest-visible buffers. */
  snapshot(): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    for (const [name, file] of this.files) result.set(name, file.bytes.slice(0, file.size));
    return result;
  }
  /** @internal */
  entry(name: string): MemoryFile | undefined {
    return this.files.get(name);
  }
  /** @internal */
  create(name: string): MemoryFile {
    const file = new MemoryFile(new Uint8Array(0));
    this.files.set(name, file);
    return file;
  }
  /** @internal */
  isDirectoryPrefix(name: string): boolean {
    for (const key of this.files.keys()) if (key.startsWith(`${name}/`)) return true;
    return false;
  }
}

/** `proc_exit` unwinds the guest through this; {@link MemoryWasi.start} turns it into the exit code. */
class WasiExit extends Error {
  readonly code: number;
  constructor(code: number) { super(`wasi exit ${code}`); this.name = 'WasiExit'; this.code = code; }
}

type Descriptor =
  | { kind: 'stdio'; stream: 0 | 1 | 2 }
  | { kind: 'dir'; dir: MemoryDirectory; prefix: string; preopen: string | null }
  | { kind: 'file'; dir: MemoryDirectory; file: MemoryFile; position: number; writable: boolean; append: boolean };

export interface MemoryWasiOptions {
  args: readonly string[];
  env?: Record<string, string>;
  /** Guest path (e.g. `/out`) to directory. */
  preopens: Record<string, MemoryDirectory>;
  /** Receives stderr one line at a time (without the newline); a trailing partial line is flushed on exit. */
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
}

class LineSink {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  private readonly target: ((line: string) => void) | undefined;
  constructor(target: ((line: string) => void) | undefined) {
    this.target = target;
  }
  push(bytes: Uint8Array): void {
    if (this.target === undefined) return;
    this.pending += this.decoder.decode(bytes, { stream: true });
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      this.target(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
  }
  flush(): void {
    if (this.target === undefined) return;
    this.pending += this.decoder.decode();
    if (this.pending.length > 0) this.target(this.pending);
    this.pending = '';
  }
}

/** Resolves `path` below `base`; `null` when `..` would leave the preopen. */
function normalize(base: string, path: string): string | null {
  const parts = base === '' ? [] : base.split('/');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

function encodeStrings(values: readonly string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return values.map(value => encoder.encode(`${value}\0`));
}

export class MemoryWasi {
  private readonly fds = new Map<number, Descriptor>();
  private readonly args: Uint8Array[];
  private readonly env: Uint8Array[];
  private readonly stdout: LineSink;
  private readonly stderr: LineSink;
  private memory: WebAssembly.Memory | null = null;
  private nextFd: number;

  constructor(options: MemoryWasiOptions) {
    this.args = encodeStrings(options.args);
    this.env = encodeStrings(Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`));
    this.stdout = new LineSink(options.stdout);
    this.stderr = new LineSink(options.stderr);
    this.fds.set(0, { kind: 'stdio', stream: 0 });
    this.fds.set(1, { kind: 'stdio', stream: 1 });
    this.fds.set(2, { kind: 'stdio', stream: 2 });
    let fd = 3;
    for (const [path, dir] of Object.entries(options.preopens)) {
      this.fds.set(fd, { kind: 'dir', dir, prefix: '', preopen: path });
      fd += 1;
    }
    this.nextFd = fd;
  }

  /** Runs `_start`; returns the `proc_exit` code (0 when `_start` returns). Traps propagate. */
  start(instance: WebAssembly.Instance): number {
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('WASI command does not export its memory');
    this.memory = memory;
    const start = instance.exports._start;
    if (typeof start !== 'function') throw new TypeError('WASI command does not export _start');
    try {
      (start as () => void)();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      throw error;
    } finally {
      this.stdout.flush();
      this.stderr.flush();
    }
  }

  imports(): WebAssembly.Imports {
    return { wasi_snapshot_preview1: this.syscalls() };
  }

  private view(): DataView {
    return new DataView(this.memory!.buffer);
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.memory!.buffer);
  }

  private writeStrings(values: Uint8Array[], pointers: number, buffer: number): number {
    const view = this.view();
    const bytes = this.bytes();
    let offset = buffer;
    values.forEach((value, index) => {
      view.setUint32(pointers + index * 4, offset, true);
      bytes.set(value, offset);
      offset += value.length;
    });
    return ERRNO_SUCCESS;
  }

  private writeSizes(values: Uint8Array[], count: number, size: number): number {
    const view = this.view();
    view.setUint32(count, values.length, true);
    view.setUint32(size, values.reduce((total, value) => total + value.length, 0), true);
    return ERRNO_SUCCESS;
  }

  private iovecs(pointer: number, count: number): { buf: number; len: number }[] {
    const view = this.view();
    const result: { buf: number; len: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      result.push({ buf: view.getUint32(pointer + index * 8, true), len: view.getUint32(pointer + index * 8 + 4, true) });
    }
    return result;
  }

  private open(dirFd: number, path: string, oflags: number, rights: bigint, fdflags: number): Descriptor | number {
    const base = this.fds.get(dirFd);
    if (base === undefined) return ERRNO_BADF;
    if (base.kind !== 'dir') return ERRNO_NOTDIR;
    const name = normalize(base.prefix, path);
    if (name === null) return ERRNO_NOTCAPABLE;
    const existing = name === '' ? undefined : base.dir.entry(name);
    if (existing === undefined && (name === '' || base.dir.isDirectoryPrefix(name))) {
      if ((oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0) return ERRNO_ISDIR;
      return { kind: 'dir', dir: base.dir, prefix: name, preopen: null };
    }
    if ((oflags & OFLAGS_DIRECTORY) !== 0) return existing === undefined ? ERRNO_NOENT : ERRNO_NOTDIR;
    const append = (fdflags & FDFLAGS_APPEND) !== 0;
    const writable = (rights & RIGHTS_FD_WRITE) !== 0n || append;
    const mutates = writable || (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0;
    if (mutates && base.dir.readonly) return ERRNO_ROFS;
    if (existing !== undefined && (oflags & OFLAGS_CREAT) !== 0 && (oflags & OFLAGS_EXCL) !== 0) return ERRNO_EXIST;
    let file = existing;
    if (file === undefined) {
      if ((oflags & OFLAGS_CREAT) === 0) return ERRNO_NOENT;
      file = base.dir.create(name);
    } else if ((oflags & OFLAGS_TRUNC) !== 0) file.size = 0;
    return { kind: 'file', dir: base.dir, file, position: 0, writable, append };
  }

  private syscalls(): Record<string, (...args: never[]) => number> {
    const now = (): bigint => BigInt(Date.now()) * 1_000_000n;
    const monotonic = (): bigint => BigInt(Math.round(performance.now() * 1_000_000));
    return {
      args_sizes_get: (count: number, size: number) => this.writeSizes(this.args, count, size),
      args_get: (pointers: number, buffer: number) => this.writeStrings(this.args, pointers, buffer),
      environ_sizes_get: (count: number, size: number) => this.writeSizes(this.env, count, size),
      environ_get: (pointers: number, buffer: number) => this.writeStrings(this.env, pointers, buffer),
      random_get: (pointer: number, length: number) => {
        const bytes = this.bytes();
        for (let offset = 0; offset < length; offset += 65_536) {
          // TS 5.7+ 的 getRandomValues 只接受普通 ArrayBuffer 上的视图；subarray 保留边界裁剪。
          const chunk = bytes.subarray(pointer + offset, pointer + Math.min(length, offset + 65_536));
          crypto.getRandomValues(new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength));
        }
        return ERRNO_SUCCESS;
      },
      clock_time_get: (id: number, _precision: bigint, out: number) => {
        let value: bigint;
        if (id === CLOCK_REALTIME) value = now();
        else if (id === CLOCK_MONOTONIC || id === CLOCK_PROCESS_CPUTIME || id === CLOCK_THREAD_CPUTIME) value = monotonic();
        else return ERRNO_INVAL;
        this.view().setBigUint64(out, value, true);
        return ERRNO_SUCCESS;
      },
      fd_close: (fd: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        if (descriptor.kind === 'dir' && descriptor.preopen !== null) return ERRNO_NOTCAPABLE;
        this.fds.delete(fd);
        return ERRNO_SUCCESS;
      },
      fd_fdstat_get: (fd: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        const view = this.view();
        const filetype = descriptor.kind === 'stdio' ? FILETYPE_CHARACTER_DEVICE : descriptor.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE;
        view.setUint8(out, filetype);
        view.setUint16(out + 2, descriptor.kind === 'file' && descriptor.append ? FDFLAGS_APPEND : 0, true);
        view.setBigUint64(out + 8, RIGHTS_ALL, true);
        view.setBigUint64(out + 16, RIGHTS_ALL, true);
        return ERRNO_SUCCESS;
      },
      fd_filestat_get: (fd: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        const view = this.view();
        for (let offset = 0; offset < 64; offset += 8) view.setBigUint64(out + offset, 0n, true);
        const filetype = descriptor.kind === 'stdio' ? FILETYPE_CHARACTER_DEVICE : descriptor.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE;
        view.setUint8(out + 16, filetype);
        view.setBigUint64(out + 24, 1n, true);
        if (descriptor.kind === 'file') view.setBigUint64(out + 32, BigInt(descriptor.file.size), true);
        return ERRNO_SUCCESS;
      },
      fd_prestat_get: (fd: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined || descriptor.kind !== 'dir' || descriptor.preopen === null) return ERRNO_BADF;
        const view = this.view();
        view.setUint8(out, 0);
        view.setUint32(out + 4, new TextEncoder().encode(descriptor.preopen).length, true);
        return ERRNO_SUCCESS;
      },
      fd_prestat_dir_name: (fd: number, pointer: number, length: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined || descriptor.kind !== 'dir' || descriptor.preopen === null) return ERRNO_BADF;
        const name = new TextEncoder().encode(descriptor.preopen);
        if (length < name.length) return ERRNO_INVAL;
        this.bytes().set(name, pointer);
        return ERRNO_SUCCESS;
      },
      fd_read: (fd: number, iovs: number, count: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        if (descriptor.kind === 'dir') return ERRNO_ISDIR;
        let total = 0;
        if (descriptor.kind === 'file') {
          const memory = this.bytes();
          for (const { buf, len } of this.iovecs(iovs, count)) {
            const available = Math.max(0, descriptor.file.size - descriptor.position);
            const chunk = Math.min(len, available);
            memory.set(descriptor.file.bytes.subarray(descriptor.position, descriptor.position + chunk), buf);
            descriptor.position += chunk;
            total += chunk;
            if (chunk < len) break;
          }
        } else if (descriptor.stream !== 0) return ERRNO_BADF;
        this.view().setUint32(out, total, true);
        return ERRNO_SUCCESS;
      },
      fd_write: (fd: number, iovs: number, count: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        if (descriptor.kind === 'dir') return ERRNO_ISDIR;
        if (descriptor.kind === 'stdio' && descriptor.stream === 0) return ERRNO_BADF;
        if (descriptor.kind === 'file' && !descriptor.writable) return ERRNO_BADF;
        const memory = this.bytes();
        let total = 0;
        for (const { buf, len } of this.iovecs(iovs, count)) {
          const chunk = memory.subarray(buf, buf + len);
          if (descriptor.kind === 'stdio') (descriptor.stream === 1 ? this.stdout : this.stderr).push(chunk);
          else {
            const file = descriptor.file;
            if (descriptor.append) descriptor.position = file.size;
            file.ensure(descriptor.position + len);
            if (descriptor.position > file.size) file.bytes.fill(0, file.size, descriptor.position);
            file.bytes.set(chunk, descriptor.position);
            descriptor.position += len;
            file.size = Math.max(file.size, descriptor.position);
          }
          total += len;
        }
        this.view().setUint32(out, total, true);
        return ERRNO_SUCCESS;
      },
      fd_seek: (fd: number, offset: bigint, whence: number, out: number) => {
        const descriptor = this.fds.get(fd);
        if (descriptor === undefined) return ERRNO_BADF;
        if (descriptor.kind === 'stdio') return ERRNO_SPIPE;
        if (descriptor.kind === 'dir') return ERRNO_ISDIR;
        const origin = whence === WHENCE_SET ? 0 : whence === WHENCE_CUR ? descriptor.position : whence === WHENCE_END ? descriptor.file.size : -1;
        if (origin < 0) return ERRNO_INVAL;
        const target = BigInt(origin) + offset;
        if (target < 0n || target > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO_INVAL;
        descriptor.position = Number(target);
        this.view().setBigUint64(out, target, true);
        return ERRNO_SUCCESS;
      },
      path_open: (dirFd: number, _dirflags: number, pointer: number, length: number, oflags: number,
        rights: bigint, _inheriting: bigint, fdflags: number, out: number) => {
        const path = new TextDecoder().decode(this.bytes().subarray(pointer, pointer + length));
        const opened = this.open(dirFd, path, oflags, rights, fdflags);
        if (typeof opened === 'number') return opened;
        const fd = this.nextFd;
        this.nextFd += 1;
        this.fds.set(fd, opened);
        this.view().setUint32(out, fd, true);
        return ERRNO_SUCCESS;
      },
      proc_exit: (code: number) => { throw new WasiExit(code); },
      sched_yield: () => ERRNO_SUCCESS,
    };
  }
}
