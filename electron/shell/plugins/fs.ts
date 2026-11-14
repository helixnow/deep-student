/**
 * `plugin:fs|*`（tauri-plugin-fs-2.4.5 `src/commands.rs`）。路径校验与 Rust `resolve_path` 相同：
 * `SafeFilePath`（拒绝 `..`，`file:` URL 转路径）→ 可选 `baseDir` 解析 → deny 优先 → allow（运行时作用域 ∪ ACL 作用域）。
 * ACL 作用域是本次调用经 capability 解析出的命令作用域 ∪ 全局作用域（`CommandContext.scope`），并且不超出
 * 构造时传入的 `global`（全部 capability 的并集）。
 * 文件句柄（open/create）放入调用方 webview 的资源表，自行维护读写游标以实现 `seek`。
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeUnexpected, optInteger, optObject, raw, reqInteger, type InvokeInput } from '../args.ts';
import { scopeString, type ScopeEntries } from '../capabilities.ts';
import { formatIoError, invalidArgs, missingKey, ShellCommandError } from '../errors.ts';
import { components } from '../path-ops.ts';
import { UnknownPathError } from '../paths.ts';
import { fsScopeFromPatterns, type FsScope } from '../scope.ts';
import type { ShellPlatform } from '../tauri-config.ts';
import type { BuiltinPlugin, CommandContext, Resource } from '../runtime.ts';

const UNSAFE = 'cannot traverse directory, rewrite the path without the use of `../`';

class FileResource implements Resource {
  fd: number;
  pos = 0;
  readonly append: boolean;
  constructor(fd: number, append: boolean) {
    this.fd = fd;
    this.append = append;
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

class LinesResource implements Resource {
  readonly fd: number;
  private buffer = Buffer.alloc(0);
  private eof = false;
  constructor(fd: number) {
    this.fd = fd;
  }
  /** `LinesBytes::next`：读到 `\n`，去掉 `\n` 与紧邻的 `\r`；EOF 返回 null。 */
  next(): Buffer | null {
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl >= 0) {
        let line = this.buffer.subarray(0, nl);
        this.buffer = this.buffer.subarray(nl + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        return Buffer.from(line);
      }
      if (this.eof) {
        if (this.buffer.length === 0) return null;
        const line = this.buffer;
        this.buffer = Buffer.alloc(0);
        return Buffer.from(line);
      }
      const chunk = Buffer.alloc(64 * 1024);
      const n = fs.readSync(this.fd, chunk, 0, chunk.length, null);
      if (n === 0) this.eof = true;
      else this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, n)]);
    }
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

const isFile = (r: Resource): r is FileResource => r instanceof FileResource;
const isLines = (r: Resource): r is LinesResource => r instanceof LinesResource;

export interface FsScopes {
  /** 全部 capability 中 fs 作用域条目的并集：逐次调用的 ACL 作用域不能超出它。 */
  global: FsScope;
  /** 运行时作用域（对话框、拖放加入的路径；对应 plugin 的 `crate::Scope`）。 */
  runtime: FsScope;
}

/**
 * `SafePathBuf::new` 拒绝的路径：含 `ParentDir` 组件。
 * RUST-FIX(RF-W23-fs-win32-verbatim-parent-segment): Windows 上 Rust 不在 `\\?\UNC\srv\share/..`、`\\?\GLOBALROOT/..` 这类前缀里拆 `/`，
 * 交给系统时整段非法；Node 的 fs 先经 `path.win32.toNamespacedPath` 把它们规范化成别处，所以按两种分隔符逐段再查一次 `..`。
 */
export function traversesParent(path: string, platform: ShellPlatform): boolean {
  if (components(path, platform).some((c) => c.kind === 'parent')) return true;
  return platform === 'win32' && path.split(/[\\/]/).includes('..');
}

/** `SafeFilePath::from_str` + `into_path`。 */
function safePath(input: InvokeInput, key: string, value: unknown): string {
  if (value === undefined) throw missingKey(input.command, key);
  if (typeof value !== 'string') {
    throw invalidArgs(input.command, key, `invalid type: ${describeUnexpected(value)}, expected a string representing an file URL or a path`);
  }
  const urlMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (urlMatch && (urlMatch[1] as string).length !== 1) {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (url !== null) {
      if (url.protocol !== 'file:') throw new ShellCommandError('URL is not a valid path');
      return fileURLToPath(url);
    }
  }
  if (traversesParent(value, process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux')) {
    throw invalidArgs(input.command, key, `invalid value: string ${JSON.stringify(value)}, expected Unsafe PathBuf: ${UNSAFE}`);
  }
  return value;
}

function baseDir(options: Record<string, unknown> | null, key = 'baseDir'): number | null {
  const v = options?.[key];
  return typeof v === 'number' ? v : null;
}

/**
 * serde `Vec<u8>`：每个元素必须是 `0..=255` 的整数。Tauri 反序列化失败时直接报错，
 * 不会过滤掉非整数或按 `& 0xff` 截断，所以这里同样拒绝，避免静默写出错误的字节。
 */
function byteArray(input: InvokeInput, key: string, value: unknown): Uint8Array {
  if (!Array.isArray(value)) {
    throw invalidArgs(input.command, key, `invalid type: ${describeUnexpected(value)}, expected a sequence`);
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255) {
      bytes[index] = item;
      continue;
    }
    const detail = typeof item === 'number' && Number.isInteger(item)
      ? `invalid value: ${describeUnexpected(item)}, expected u8`
      : `invalid type: ${describeUnexpected(item)}, expected u8`;
    throw invalidArgs(input.command, key, detail);
  }
  return bytes;
}

const NO_SCOPE: ScopeEntries = { allow: [], deny: [] };

/** 写模式打开（任一写入/创建标志）：Rust 的 `open` 属于 `read-all`，这里按 `write_file` 的作用域判定。 */
function opensForWrite(options: Record<string, unknown> | null): boolean {
  return ['write', 'append', 'truncate', 'create', 'createNew'].some((key) => options?.[key] === true);
}

export function fsPlugin(scopes: FsScopes): BuiltinPlugin {
  const platform = () => (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');
  const io = (error: unknown) => formatIoError(error, platform());
  const aclScopes = new Map<string, FsScope>();

  /**
   * 调用方对 `commands`（缺省为本命令）可用的 ACL 作用域。RUST-FIX(RF-W23-fs-read-write-scope-split)：
   * 写模式 `open` 用 `write_file` 的作用域，`copy_file` 的源路径另可用 `read_file` 的作用域。
   */
  function aclScope(ctx: CommandContext, commands: readonly (string | undefined)[]): FsScope {
    const allow: string[] = [];
    const deny: string[] = [];
    for (const command of commands) {
      const entries = ctx.scope ? ctx.scope(command) : NO_SCOPE;
      for (const entry of entries.allow) {
        const value = scopeString(entry, 'path');
        if (value !== null && !allow.includes(value)) allow.push(value);
      }
      for (const entry of entries.deny) {
        const value = scopeString(entry, 'path');
        if (value !== null && !deny.includes(value)) deny.push(value);
      }
    }
    const key = JSON.stringify([allow, deny]);
    let scope = aclScopes.get(key);
    if (scope === undefined) {
      // RUST-FIX(RF-W23-fs-deny-webview-data-user-data): deny-default 的 $ELECTRON_USERDATA 在每次调用的作用域里展开。
      scope = fsScopeFromPatterns(ctx.runtime.paths, platform(), allow, deny, ctx.runtime.userDataDir);
      aclScopes.set(key, scope);
    }
    return scope;
  }

  function resolvePath(permission: string, ctx: CommandContext, path: string, dir: number | null, commands: readonly (string | undefined)[] = [undefined]): string {
    let resolved = path;
    if (dir !== null) {
      try {
        resolved = ctx.runtime.paths.resolve(dir, path);
      } catch (error) {
        if (error instanceof UnknownPathError) throw new ShellCommandError(error.message);
        throw error;
      }
    }
    const acl = aclScope(ctx, commands);
    if (scopes.runtime.isForbidden(resolved) || scopes.global.isForbidden(resolved) || acl.isForbidden(resolved)) {
      throw new ShellCommandError(`forbidden path: ${resolved}`);
    }
    if (scopes.runtime.isAllowed(resolved) || (scopes.global.isAllowed(resolved) && acl.isAllowed(resolved))) return resolved;
    if (ctx.runtime.debug) {
      throw new ShellCommandError(
        `forbidden path: ${resolved}, maybe it is not allowed on the scope for \`allow-${permission}\` permission in your capability file`,
      );
    }
    throw new ShellCommandError(`forbidden path: ${resolved}`);
  }

  /**
   * rename 的两端、递归 remove 的目录：之下有受保护的目录时拒绝。改名或删掉上级目录会把受保护的内容搬到 deny 之外
   * 或删掉，改名到这里能一次放进准备好的受保护目录（`staging` → `slots/<新>` 带着 `browser-profiles`）。
   * RUST-FIX(RF-W23-fs-deny-protected-ancestor): Rust 版的 fs 作用域没有 deny；Electron 的 deny 只比较请求路径本身，改名或递归删除上级目录就能绕过。
   */
  function refuseProtectedBelow(ctx: CommandContext, path: string): void {
    const acl = aclScope(ctx, [undefined]);
    if (scopes.runtime.forbidsBelow(path) || scopes.global.forbidsBelow(path) || acl.forbidsBelow(path)) {
      throw new ShellCommandError(`forbidden path: ${path}`);
    }
  }

  function pathArg(input: InvokeInput, ctx: CommandContext, permission: string, key = 'path', dirKey = 'baseDir'): string {
    const options = optObject(input, 'options');
    return resolvePath(permission, ctx, safePath(input, key, raw(input, key)), baseDir(options, dirKey));
  }

  interface OpenFlags {
    read: boolean;
    write: boolean;
    append: boolean;
    truncate: boolean;
    create: boolean;
    createNew: boolean;
    mode: number | null;
  }

  /** Rust `OpenOptions::open` 的访问/创建模式校验与 flag 组合。 */
  function openFd(path: string, o: OpenFlags): number {
    const c = fs.constants;
    let flags: number;
    if (o.read && !o.write && !o.append) flags = c.O_RDONLY;
    else if (!o.read && (o.write || o.append)) flags = c.O_WRONLY;
    else if (o.read && (o.write || o.append)) flags = c.O_RDWR;
    else throw Object.assign(new Error('invalid'), { code: 'EINVAL', errno: -22 });
    if (!o.write && !o.append && (o.truncate || o.create || o.createNew)) {
      throw Object.assign(new Error('invalid'), { code: 'EINVAL', errno: -22 });
    }
    if (o.append && o.truncate && !o.createNew) throw Object.assign(new Error('invalid'), { code: 'EINVAL', errno: -22 });
    if (o.append) flags |= c.O_APPEND;
    if (o.createNew) flags |= c.O_CREAT | c.O_EXCL;
    else {
      if (o.create) flags |= c.O_CREAT;
      if (o.truncate) flags |= c.O_TRUNC;
    }
    return fs.openSync(path, flags, o.mode ?? 0o666);
  }

  function openOptions(options: Record<string, unknown> | null): OpenFlags {
    const b = (k: string, d: boolean) => (typeof options?.[k] === 'boolean' ? (options[k] as boolean) : d);
    return {
      read: b('read', true),
      write: b('write', false),
      append: b('append', false),
      truncate: b('truncate', false),
      create: b('create', false),
      createNew: b('createNew', false),
      mode: typeof options?.mode === 'number' ? options.mode : null,
    };
  }

  function stat(s: fs.Stats, isSymlink: boolean): unknown {
    const unix = process.platform !== 'win32';
    const birth = s.birthtimeMs > 0 ? Math.trunc(s.birthtimeMs) : null;
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink,
      size: s.size,
      mtime: Math.trunc(s.mtimeMs),
      atime: Math.trunc(s.atimeMs),
      birthtime: birth,
      readonly: (s.mode & 0o222) === 0,
      fileAttribues: null,
      dev: unix ? s.dev : null,
      ino: unix ? s.ino : null,
      mode: unix ? s.mode : null,
      nlink: unix ? s.nlink : null,
      uid: unix ? s.uid : null,
      gid: unix ? s.gid : null,
      rdev: unix ? s.rdev : null,
      blksize: unix ? s.blksize : null,
      blocks: unix ? s.blocks : null,
    };
  }

  function dirSize(path: string): number {
    let size = 0;
    for (const entry of fs.readdirSync(path)) {
      const p = `${path}${path.endsWith('/') || path.endsWith('\\') ? '' : platform() === 'win32' ? '\\' : '/'}${entry}`;
      const m = fs.statSync(p);
      if (m.isFile()) size += m.size;
      else if (m.isDirectory()) size += dirSize(p);
    }
    return size;
  }

  function writeFileInner(permission: string, input: InvokeInput, ctx: CommandContext): null {
    const header = input.headers.path;
    if (header === undefined) throw new ShellCommandError('missing file path');
    let decoded: string;
    try {
      decoded = decodeURIComponent(header);
    } catch (error) {
      if (error instanceof URIError) throw new ShellCommandError('path is not a valid UTF-8');
      throw error;
    }
    const pathInput: InvokeInput = { ...input, json: { path: decoded } };
    const filePath = safePath(pathInput, 'path', decoded);
    let options: Record<string, unknown> | null = null;
    if (input.headers.options !== undefined) {
      try {
        const parsed = JSON.parse(input.headers.options) as unknown;
        if (parsed !== null && typeof parsed === 'object') options = parsed as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const resolved = resolvePath(permission, ctx, filePath, baseDir(options));
    const append = options?.append === true;
    const flags: OpenFlags = options
      ? {
          read: false,
          write: true,
          create: options.create !== false,
          truncate: !append,
          append,
          createNew: options.createNew === true,
          mode: typeof options.mode === 'number' ? options.mode : null,
        }
      : { read: false, write: true, truncate: true, create: true, createNew: false, append: false, mode: null };
    let data: Uint8Array;
    if (input.raw !== null) data = input.raw;
    else if (Array.isArray(input.json)) data = byteArray(input, 'data', input.json);
    else throw new ShellCommandError('unexpected invoke body');
    let fd: number;
    try {
      fd = openFd(resolved, flags);
    } catch (error) {
      throw new ShellCommandError(`failed to open file at path: ${resolved} with error: ${io(error)}`);
    }
    try {
      fs.writeSync(fd, data);
    } catch (error) {
      throw new ShellCommandError(`failed to write bytes to file at path: ${resolved} with error: ${io(error)}`);
    } finally {
      fs.closeSync(fd);
    }
    return null;
  }

  function readAll(permission: string, input: InvokeInput, ctx: CommandContext): Uint8Array {
    const path = pathArg(input, ctx, permission);
    let fd: number;
    try {
      fd = openFd(path, { read: true, write: false, append: false, truncate: false, create: false, createNew: false, mode: null });
    } catch (error) {
      throw new ShellCommandError(`failed to open file at path: ${path} with error: ${io(error)}`);
    }
    try {
      return fs.readFileSync(fd);
    } catch (error) {
      throw new ShellCommandError(`failed to read file as text at path: ${path} with error: ${io(error)}`);
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    create: (input, ctx) => {
      const path = pathArg(input, ctx, 'create');
      let fd: number;
      try {
        fd = openFd(path, { read: false, write: true, append: false, truncate: true, create: true, createNew: false, mode: null });
      } catch (error) {
        throw new ShellCommandError(`failed to create file at path: ${path} with error: ${io(error)}`);
      }
      return ctx.runtime.addResource(ctx.webviewLabel, new FileResource(fd, false));
    },
    open: (input, ctx) => {
      const options = optObject(input, 'options');
      const path = resolvePath('open', ctx, safePath(input, 'path', raw(input, 'path')), baseDir(options), [opensForWrite(options) ? 'write_file' : undefined]);
      const flags = openOptions(options);
      let fd: number;
      try {
        fd = openFd(path, flags);
      } catch (error) {
        throw new ShellCommandError(`failed to open file at path: ${path} with error: ${io(error)}`);
      }
      return ctx.runtime.addResource(ctx.webviewLabel, new FileResource(fd, flags.append));
    },
    copy_file: (input, ctx) => {
      const options = optObject(input, 'options');
      const from = resolvePath('copy-file', ctx, safePath(input, 'fromPath', raw(input, 'fromPath')), baseDir(options, 'fromPathBaseDir'), [undefined, 'read_file']);
      const to = resolvePath('copy-file', ctx, safePath(input, 'toPath', raw(input, 'toPath')), baseDir(options, 'toPathBaseDir'));
      try {
        fs.copyFileSync(from, to);
      } catch (error) {
        throw new ShellCommandError(`failed to copy file from path: ${from}, to path: ${to} with error: ${io(error)}`);
      }
      return null;
    },
    mkdir: (input, ctx) => {
      const path = pathArg(input, ctx, 'mkdir');
      const options = optObject(input, 'options');
      const mode = (typeof options?.mode === 'number' ? options.mode : 0o777) & 0o777;
      try {
        if (options?.recursive === true) fs.mkdirSync(path, { recursive: true, mode });
        else fs.mkdirSync(path, { mode });
      } catch (error) {
        throw new ShellCommandError(`failed to create directory at path: ${path} with error: ${io(error)}`);
      }
      return null;
    },
    read_dir: (input, ctx) => {
      const path = pathArg(input, ctx, 'read-dir');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path, { withFileTypes: true });
      } catch (error) {
        throw new ShellCommandError(`failed to read directory at path: ${path} with error: ${io(error)}`);
      }
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }));
    },
    read: (input, ctx) => {
      const rid = reqInteger(input, 'rid');
      const len = reqInteger(input, 'len', 'usize');
      const file = ctx.runtime.getResource(ctx.webviewLabel, rid, isFile);
      const data = Buffer.alloc(len + 8);
      let nread: number;
      try {
        nread = fs.readSync(file.fd, data, 0, len, file.pos);
      } catch (error) {
        throw new ShellCommandError(`faied to read bytes from file with error: ${io(error)}`);
      }
      file.pos += nread;
      data.writeBigUInt64BE(BigInt(nread), len);
      return new Uint8Array(data.buffer, data.byteOffset, data.length);
    },
    read_file: (input, ctx) => readAll('read-file', input, ctx),
    read_text_file: (input, ctx) => readAll('read-text-file', input, ctx),
    read_text_file_lines: (input, ctx) => {
      const path = pathArg(input, ctx, 'read-text-file-lines');
      let fd: number;
      try {
        fd = fs.openSync(path, 'r');
      } catch (error) {
        throw new ShellCommandError(`failed to open file at path: ${path} with error: ${io(error)}`);
      }
      return ctx.runtime.addResource(ctx.webviewLabel, new LinesResource(fd));
    },
    read_text_file_lines_next: async (input, ctx) => {
      const rid = reqInteger(input, 'rid');
      const lines = ctx.runtime.getResource(ctx.webviewLabel, rid, isLines);
      let line: Buffer | null;
      try {
        line = lines.next();
      } catch (error) {
        // Rust `read_text_file_lines_next` 把读取错误转成 `Error::Io`；返回空行会让前端在
        // EIO/EACCES/EISDIR 上无限循环。
        throw new ShellCommandError(`failed to read line from file with error: ${io(error)}`);
      }
      if (line === null) {
        await ctx.runtime.closeResource(ctx.webviewLabel, rid);
        return Uint8Array.of(1);
      }
      const out = new Uint8Array(line.length + 1);
      out.set(line, 0);
      out[line.length] = 0;
      return out;
    },
    remove: (input, ctx) => {
      const path = pathArg(input, ctx, 'remove');
      const options = optObject(input, 'options');
      let meta: fs.Stats;
      try {
        meta = fs.lstatSync(path);
      } catch (error) {
        throw new ShellCommandError(`failed to get metadata of path: ${path} with error: ${io(error)}`);
      }
      if (options?.recursive === true && meta.isDirectory()) refuseProtectedBelow(ctx, path);
      try {
        if (meta.isFile()) fs.unlinkSync(path);
        else if (options?.recursive === true) fs.rmSync(path, { recursive: true });
        else if (meta.isSymbolicLink()) fs.unlinkSync(path);
        else if (meta.isDirectory()) fs.rmdirSync(path);
        else fs.unlinkSync(path);
      } catch (error) {
        throw new ShellCommandError(`failed to remove path: ${path} with error: ${io(error)}`);
      }
      return null;
    },
    rename: (input, ctx) => {
      const options = optObject(input, 'options');
      const from = resolvePath('rename', ctx, safePath(input, 'oldPath', raw(input, 'oldPath')), baseDir(options, 'oldPathBaseDir'));
      const to = resolvePath('rename', ctx, safePath(input, 'newPath', raw(input, 'newPath')), baseDir(options, 'newPathBaseDir'));
      refuseProtectedBelow(ctx, from);
      refuseProtectedBelow(ctx, to);
      try {
        fs.renameSync(from, to);
      } catch (error) {
        throw new ShellCommandError(`failed to rename old path: ${from} to new path: ${to} with error: ${io(error)}`);
      }
      return null;
    },
    seek: (input, ctx) => {
      const rid = reqInteger(input, 'rid');
      const offset = reqInteger(input, 'offset', 'i64');
      const whence = reqInteger(input, 'whence', 'u16');
      const file = ctx.runtime.getResource(ctx.webviewLabel, rid, isFile);
      let next: number;
      if (whence === 0) next = offset;
      else if (whence === 1) next = file.pos + offset;
      else if (whence === 2) next = fs.fstatSync(file.fd).size + offset;
      else throw invalidArgs(input.command, 'whence', `invalid value: ${whence}, expected one of 0, 1, 2`);
      if (next < 0) throw new ShellCommandError('failed to seek file with error: Invalid argument (os error 22)');
      file.pos = next;
      return next;
    },
    stat: (input, ctx) => {
      const path = pathArg(input, ctx, 'stat');
      try {
        return stat(fs.statSync(path), false);
      } catch (error) {
        throw new ShellCommandError(`failed to get metadata of path: ${path} with error: ${io(error)}`);
      }
    },
    lstat: (input, ctx) => {
      const path = pathArg(input, ctx, 'lstat');
      try {
        const s = fs.lstatSync(path);
        return stat(s, s.isSymbolicLink());
      } catch (error) {
        throw new ShellCommandError(`failed to get metadata of path: ${path} with error: ${io(error)}`);
      }
    },
    fstat: (input, ctx) => {
      const file = ctx.runtime.getResource(ctx.webviewLabel, reqInteger(input, 'rid'), isFile);
      try {
        return stat(fs.fstatSync(file.fd), false);
      } catch (error) {
        throw new ShellCommandError(`failed to get metadata of file with error: ${io(error)}`);
      }
    },
    truncate: (input, ctx) => {
      const path = pathArg(input, ctx, 'truncate');
      const len = optInteger(input, 'len', 'u64') ?? 0;
      let fd: number;
      try {
        fd = fs.openSync(path, 'r+');
      } catch (error) {
        throw new ShellCommandError(`failed to open file at path: ${path} with error: ${io(error)}`);
      }
      try {
        fs.ftruncateSync(fd, len);
      } catch (error) {
        throw new ShellCommandError(`failed to truncate file at path: ${path} with error: ${io(error)}`);
      } finally {
        fs.closeSync(fd);
      }
      return null;
    },
    ftruncate: (input, ctx) => {
      const file = ctx.runtime.getResource(ctx.webviewLabel, reqInteger(input, 'rid'), isFile);
      try {
        fs.ftruncateSync(file.fd, optInteger(input, 'len', 'u64') ?? 0);
      } catch (error) {
        throw new ShellCommandError(`failed to truncate file with error: ${io(error)}`);
      }
      return null;
    },
    write: (input, ctx) => {
      const file = ctx.runtime.getResource(ctx.webviewLabel, reqInteger(input, 'rid'), isFile);
      const data = raw(input, 'data');
      if (data === undefined) throw missingKey(input.command, 'data');
      if (!Array.isArray(data)) throw invalidArgs(input.command, 'data', `invalid type: ${describeUnexpected(data)}, expected a sequence`);
      const bytes = byteArray(input, 'data', data);
      try {
        const n = file.append ? fs.writeSync(file.fd, bytes) : fs.writeSync(file.fd, bytes, 0, bytes.length, file.pos);
        if (!file.append) file.pos += n;
        return n;
      } catch (error) {
        throw new ShellCommandError(`failed to write bytes to file with error: ${io(error)}`);
      }
    },
    write_file: (input, ctx) => writeFileInner('write-file', input, ctx),
    write_text_file: (input, ctx) => writeFileInner('write-text-file', input, ctx),
    exists: (input, ctx) => fs.existsSync(pathArg(input, ctx, 'exists')),
    size: (input, ctx) => {
      const path = pathArg(input, ctx, 'size');
      let meta: fs.Stats;
      try {
        meta = fs.statSync(path);
      } catch (error) {
        throw new ShellCommandError(io(error));
      }
      if (meta.isFile()) return meta.size;
      try {
        return dirSize(path);
      } catch (error) {
        throw new ShellCommandError(`failed to get size at path: ${path} with error: ${io(error)}`);
      }
    },
  };
}
