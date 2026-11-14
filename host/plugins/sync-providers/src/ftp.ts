/**
 * FTP/FTPS transport (ftp.rs).
 *
 * Replaces `suppaftp` + `rustls` with a direct implementation over `node:net` /
 * `node:tls`. The wire behaviour that ftp.rs depends on is preserved:
 * - explicit FTPS (AUTH TLS) happens before USER/PASS so credentials are encrypted;
 * - transfers are always binary (TYPE I), so SIZE is the exact byte count;
 * - writes go to `name.tmp-<nonce>` and are RNFR/RNTO renamed into place;
 * - MLSD is preferred over LIST, and unparsable listing lines fail closed;
 * - 550 is a multi-purpose status code, so only the explicit "missing" whitelist is
 *   classified as not-found (ftp.rs:250-300).
 */

import { sha256Hasher } from './hashing.ts';
import { once } from 'node:events';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from '../../../platform/util/path.ts';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { DownloadProgressCallback, FileInfo, FtpConfig, ListOutcome, UploadProgressCallback } from '../api.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { parseListEntry, parseMlsxTimestamp } from './ftp-listing.ts';
import { defaultLogSink } from './logging.ts';
import { chronoAutoSiZ } from './time.ts';
import { openFile, randomTempName, renameOver, statFile } from './fsutil.ts';
import {
  BoundedMemoryBody,
  CloudStorageBase,
  MEMORY_GET_BUDGET_EXCEEDED,
  MEMORY_GET_DEFAULT_BUDGET_BYTES,
  ensureDeclaredLenWithinBudget,
  ensureMemoryGetMatchesDeclaredLen,
} from './traits.ts';
import { randomHex } from './random.ts';
import {
  absolutePath, isBudgetExceededError, isMissingDirectoryError, isNotFoundError, joinPaths, splitParentFilename,
  transferTimeoutMs, withRetry,
} from './ftp-rules.ts';

export {
  absolutePath, extractStatusCode, isBudgetExceededError, isMissingDirectoryError, isNotFoundError, joinPaths,
  splitParentFilename, transferTimeoutMs, withRetry,
} from './ftp-rules.ts';

// Pure listing/date decoding lives in `ftp-listing.ts`; keep the established
// `ftp.ts` import surface for tests and the production `FtpStorage` listing path.
export type { FtpListEntry } from './ftp-listing.ts';
export {
  parseMlsxLine,
  parseMlsxTimestamp,
  parsePosixLine,
  parseLsTime,
  parseDosLine,
  parseDosTime,
  parseListEntry,
} from './ftp-listing.ts';

/** ftp.rs:38: passive data-channel steps must never hang forever. */
export const FTP_DATA_TIMEOUT_MS = 60_000;
/** ftp.rs:42: recursion bound for `list_outcome`, reported as `truncated`. */
export const FTP_LIST_MAX_DIRS = 200;
/** ftp.rs:127: connect + banner + login must finish within 45 s. */
export const FTP_CONNECT_TIMEOUT_MS = 45_000;

const READ_BLOCK = 64 * 1024;

/** FTP RETR/REST 没有定长结束位置；只允许在此预算内整对象读取后切片。 */
export const FTP_RANGE_MAX_OBJECT_BYTES = 8 * 1024 * 1024;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CloudStorageError('Network', message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

// ------------------------------------------------------------------ control channel

interface FtpReply {
  code: number;
  text: string;
}

class LineReader {
  private queue: string[] = [];
  private partial = '';
  private waiter: ((line: string | null) => void) | null = null;
  private failure: Error | null = null;
  private closed = false;

  push(text: string): void {
    this.partial += text;
    let index = this.partial.indexOf('\n');
    while (index >= 0) {
      this.queue.push(this.partial.slice(0, index).replace(/\r$/, ''));
      this.partial = this.partial.slice(index + 1);
      index = this.partial.indexOf('\n');
    }
    this.flush();
  }

  close(error?: Error): void {
    if (error) this.failure = error;
    this.closed = true;
    this.flush();
  }

  private flush(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    if (this.queue.length > 0) {
      this.waiter = null;
      waiter(this.queue.shift()!);
    } else if (this.failure !== null || this.closed) {
      this.waiter = null;
      waiter(null);
    }
  }

  async readLine(): Promise<string | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.failure !== null) throw this.failure;
    if (this.closed) return null;
    return new Promise<string | null>(resolve => { this.waiter = resolve; });
  }
}

class FtpControl {
  private socket: Socket | TLSSocket;
  private readonly reader = new LineReader();
  private readonly onData = (chunk: Buffer): void => { this.reader.push(chunk.toString('utf8')); };
  private readonly onError = (error: Error): void => { this.reader.close(error); };
  private readonly onClose = (): void => { this.reader.close(); };

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setNoDelay(true);
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private detach(socket: Socket | TLSSocket): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
  }

  /** ftp.rs:145: AUTH TLS upgrade; the caller re-issues PBSZ/PROT afterwards. */
  async upgradeTls(servername: string): Promise<void> {
    const raw = this.socket;
    this.detach(raw);
    const secure = tlsConnect({ socket: raw, servername, minVersion: 'TLSv1.2' });
    await withTimeout(
      once(secure, 'secureConnect').then(() => undefined),
      FTP_CONNECT_TIMEOUT_MS,
      `FTP TLS 升级失败：TLS 握手超时（${Math.round(FTP_CONNECT_TIMEOUT_MS / 1000)} 秒）`,
    ).catch((error: unknown) => {
      secure.destroy();
      throw new CloudStorageError('Network', `FTP TLS 升级失败：${error instanceof Error ? error.message : String(error)}`);
    });
    this.socket = secure;
    this.attach(secure);
  }

  async write(line: string): Promise<void> {
    if (!this.socket.write(`${line}\r\n`)) await once(this.socket, 'drain');
  }

  async readReply(): Promise<FtpReply> {
    const lines: string[] = [];
    let pending: number | null = null;
    for (;;) {
      const line = await this.reader.readLine();
      if (line === null) {
        throw new CloudStorageError('Network', 'FTP 连接已断开（服务器未返回响应）');
      }
      lines.push(line);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) continue;
      const code = Number(match[1]);
      if (pending === null) {
        if (match[2] === ' ') return { code, text: lines.join('\n') };
        pending = code;
        continue;
      }
      if (code === pending && match[2] === ' ') return { code, text: lines.join('\n') };
    }
  }

  async command(line: string): Promise<FtpReply> {
    await this.write(line);
    return this.readReply();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ------------------------------------------------------------------ data channel

async function openDataSocket(control: FtpControl, host: string, secure: boolean): Promise<Socket | TLSSocket> {
  const epsv = await control.command('EPSV');
  let targetHost = host;
  let targetPort: number;
  if (epsv.code === 229) {
    const match = /\(\|\|\|(\d+)\|\)/.exec(epsv.text);
    if (match === null) throw new CloudStorageError('Network', `FTP EPSV 响应缺少端口: ${epsv.text}`);
    targetPort = Number(match[1]);
  } else {
    const pasv = await control.command('PASV');
    if (pasv.code !== 227) throw new CloudStorageError('Network', `FTP PASV 失败: ${pasv.code} ${pasv.text}`);
    const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
    if (match === null) throw new CloudStorageError('Network', `FTP PASV 响应缺少地址: ${pasv.text}`);
    targetHost = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
    targetPort = Number(match[5]) * 256 + Number(match[6]);
  }
  const socket = netConnect({ host: targetHost, port: targetPort });
  await withTimeout(
    once(socket, 'connect').then(() => undefined),
    FTP_DATA_TIMEOUT_MS,
    `FTP 数据通道连接超时（${Math.round(FTP_DATA_TIMEOUT_MS / 1000)} 秒），已中断以避免无限挂起`,
  ).catch((error: unknown) => {
    socket.destroy();
    throw new CloudStorageError('Network', `FTP 数据通道连接失败：${error instanceof Error ? error.message : String(error)}`);
  });
  socket.setNoDelay(true);
  if (!secure) return socket;
  const tlsSocket = tlsConnect({ socket, servername: host, minVersion: 'TLSv1.2' });
  await withTimeout(
    once(tlsSocket, 'secureConnect').then(() => undefined),
    FTP_DATA_TIMEOUT_MS,
    `FTP 数据通道 TLS 握手超时（${Math.round(FTP_DATA_TIMEOUT_MS / 1000)} 秒），已中断以避免无限挂起`,
  ).catch((error: unknown) => {
    tlsSocket.destroy();
    throw new CloudStorageError('Network', `FTP 数据通道 TLS 升级失败：${error instanceof Error ? error.message : String(error)}`);
  });
  return tlsSocket;
}

/** ftp.rs:520: a per-read idle timeout; a slow but flowing transfer is never cut off. */
async function* idleGuarded(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    const next = await withTimeout(
      iterator.next(),
      FTP_DATA_TIMEOUT_MS,
      `FTP 数据通道读取超时（${Math.round(FTP_DATA_TIMEOUT_MS / 1000)} 秒），已中断以避免无限挂起`,
    );
    if (next.done) return;
    yield next.value;
  }
}

function socketChunks(socket: Socket | TLSSocket): AsyncIterable<Uint8Array> {
  return socket as AsyncIterable<Uint8Array>;
}

/** ftp.rs:565 `stream_to_file`: hash + size guard; a short or long stream is never saved. */
export async function streamToFile(
  source: AsyncIterable<Uint8Array>,
  tempPath: string,
  totalSize: number,
  progress?: DownloadProgressCallback | null,
): Promise<string> {
  let handle;
  try {
    handle = await open(tempPath, 'w');
  } catch (error) {
    throw new CloudStorageError('FileSystem', `创建临时下载文件失败：${ioError(error)}`);
  }
  const hasher = sha256Hasher();
  let downloaded = 0;
  try {
    for await (const chunk of source) {
      try { await handle.write(chunk); }
      catch (error) { throw new CloudStorageError('FileSystem', `写入临时下载文件失败：${ioError(error)}`); }
      hasher.update(chunk);
      downloaded += chunk.byteLength;
      if (downloaded > totalSize) {
        throw new CloudStorageError('Network', `FTP 下载不完整或对象已变更：服务端声明 ${totalSize} 字节，实际已收到 ${downloaded} 字节且数据仍在继续，已中断`);
      }
      progress?.(downloaded, totalSize);
    }
    try { await handle.sync(); }
    catch (error) { throw new CloudStorageError('FileSystem', `刷新临时下载文件失败：${ioError(error)}`); }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (downloaded !== totalSize) {
    throw new CloudStorageError('Network', `FTP 下载不完整：服务端声明 ${totalSize} 字节，实际收到 ${downloaded} 字节，已拒绝保存（请重试）`);
  }
  return hasher.digestHex();
}

// ------------------------------------------------------------------ session

interface Retrieval {
  /** Raw data channel, kept so uploads can write to it. */
  socket: Socket | TLSSocket;
  stream: AsyncIterable<Uint8Array>;
  /** Reads the final 226/250 reply and closes the data channel. */
  finalize(): Promise<void>;
}

class FtpSession {
  private readonly control: FtpControl;
  private readonly host: string;
  private readonly secure: boolean;

  private constructor(
    control: FtpControl,
    host: string,
    secure: boolean,
  ) {
    this.control = control;
    this.host = host;
    this.secure = secure;
  }

  static async connect(host: string, port: number, secure: boolean): Promise<FtpSession> {
    const socket = netConnect({ host, port });
    await withTimeout(
      once(socket, 'connect').then(() => undefined),
      FTP_CONNECT_TIMEOUT_MS,
      `FTP 连接超时（${Math.round(FTP_CONNECT_TIMEOUT_MS / 1000)} 秒）: ${host}:${port}`,
    ).catch((error: unknown) => {
      socket.destroy();
      throw new CloudStorageError('Network', `FTP 连接失败 ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const control = new FtpControl(socket);
    const session = new FtpSession(control, host, secure);
    const greeting = await control.readReply();
    if (greeting.code !== 220) {
      control.destroy();
      throw new CloudStorageError('Network', `FTP 连接失败 ${host}:${port}: 服务器拒绝连接（${greeting.code} ${greeting.text}）`);
    }
    return session;
  }

  async login(username: string, password: string): Promise<void> {
    if (this.secure) {
      const auth = await this.control.command('AUTH TLS');
      if (auth.code !== 234) {
        throw new CloudStorageError('Network', `FTP TLS 升级失败：${auth.code} ${auth.text}`);
      }
      await this.control.upgradeTls(this.host);
      const pbsz = await this.control.command('PBSZ 0');
      if (pbsz.code !== 200) throw new CloudStorageError('Network', `FTP TLS 升级失败：PBSZ 0 返回 ${pbsz.code}`);
      const prot = await this.control.command('PROT P');
      if (prot.code !== 200) throw new CloudStorageError('Network', `FTP TLS 升级失败：PROT P 返回 ${prot.code}`);
    }

    const user = await this.control.command(`USER ${username}`);
    if (user.code === 331) {
      const pass = await this.control.command(`PASS ${password}`);
      if (pass.code !== 230 && pass.code !== 202) {
        throw new CloudStorageError('Network', `FTP 登录失败：${pass.code} ${pass.text}`);
      }
    } else if (user.code !== 230) {
      throw new CloudStorageError('Network', `FTP 登录失败：${user.code} ${user.text}`);
    }

    const type = await this.control.command('TYPE I');
    if (type.code !== 200) {
      throw new CloudStorageError('Unknown', `设置 FTP 传输类型失败：${type.code} ${type.text}`);
    }
  }

  private async expect(line: string, codes: number[], failure: (reply: FtpReply) => CloudStorageError): Promise<FtpReply> {
    const reply = await this.control.command(line);
    if (!codes.includes(reply.code)) throw failure(reply);
    return reply;
  }

  async cwd(path: string): Promise<void> {
    await this.expect(`CWD ${path}`, [250], reply =>
      new CloudStorageError('FileSystem', `FTP CWD 失败：Invalid response: [${reply.code}] ${reply.text}`));
  }

  async mkdir(path: string): Promise<void> {
    await this.expect(`MKD ${path}`, [257], reply =>
      new CloudStorageError('FileSystem', `FTP MKDIR 失败：Invalid response: [${reply.code}] ${reply.text}`));
  }

  async rm(path: string): Promise<void> {
    await this.expect(`DELE ${path}`, [250], reply =>
      new CloudStorageError('FileSystem', `FTP DELETE 失败：Invalid response: [${reply.code}] ${reply.text}`));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.expect(`RNFR ${from}`, [350], reply =>
      new CloudStorageError('FileSystem', `FTP RENAME 失败：Invalid response: [${reply.code}] ${reply.text}`));
    await this.expect(`RNTO ${to}`, [250], reply =>
      new CloudStorageError('FileSystem', `FTP RENAME 失败：Invalid response: [${reply.code}] ${reply.text}`));
  }

  async size(path: string): Promise<number> {
    const reply = await this.expect(`SIZE ${path}`, [213], reply =>
      new CloudStorageError('FileSystem', `FTP SIZE 失败：Invalid response: [${reply.code}] ${reply.text}`));
    const payload = reply.text.replace(/^\d{3}[ -]/, '');
    const match = /(\d+)/.exec(payload);
    if (match === null) throw new CloudStorageError('FileSystem', `FTP SIZE 失败：无法解析大小（${reply.text}）`);
    return Number(match[1]);
  }

  /** ftp.rs:800: MDTM is UTC. */
  async mdtm(path: string): Promise<number> {
    const reply = await this.expect(`MDTM ${path}`, [213], reply =>
      new CloudStorageError('FileSystem', `FTP MDTM 失败：Invalid response: [${reply.code}] ${reply.text}`));
    const payload = reply.text.replace(/^\d{3}[ -]/, '');
    const match = /(\d{14})/.exec(payload);
    if (match === null) throw new CloudStorageError('FileSystem', `FTP MDTM 失败：无法解析时间（${reply.text}）`);
    // suppaftp MDTM uses NaiveTime::from_hms_opt, unlike MLSD's strptime:
    // its seconds field cannot contain a leap second.
    const parsed = Number(match[1]!.slice(12)) > 59 ? null : parseMlsxTimestamp(match[1]!);
    if (parsed === null) throw new CloudStorageError('FileSystem', `FTP MDTM 失败：无法解析时间（${reply.text}）`);
    return parsed;
  }

  async quit(): Promise<void> {
    try {
      await this.control.command('QUIT');
    } catch (error) {
      throw new CloudStorageError('Network', `FTP 断开失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.control.destroy();
    }
  }

  close(): void { this.control.destroy(); }

  private async beginData(command: string): Promise<Retrieval> {
    const socket = await openDataSocket(this.control, this.host, this.secure);
    try {
      const reply = await this.control.command(command);
      if (reply.code !== 125 && reply.code !== 150) {
        socket.destroy();
        throw new CloudStorageError('FileSystem', `FTP ${command.split(' ')[0]} 失败：Invalid response: [${reply.code}] ${reply.text}`);
      }
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return {
      socket,
      stream: idleGuarded(socketChunks(socket)),
      finalize: async () => {
        socket.destroy();
        const reply = await withTimeout(
          this.control.readReply(),
          FTP_DATA_TIMEOUT_MS,
          `FTP 传输收尾超时（${Math.round(FTP_DATA_TIMEOUT_MS / 1000)} 秒），已中断以避免无限挂起`,
        );
        if (reply.code !== 226 && reply.code !== 250) {
          throw new CloudStorageError('FileSystem', `FTP 传输收尾失败：Invalid response: [${reply.code}] ${reply.text}`);
        }
      },
    };
  }

  private async readAll(command: string, operation: string): Promise<string[]> {
    const retrieval = await this.beginData(command);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of retrieval.stream) {
        total += chunk.byteLength;
        if (total > 64 * 1024 * 1024) {
          throw new CloudStorageError('Network', `FTP ${operation} 响应超过 64 MiB，已拒绝继续读取`);
        }
        chunks.push(chunk);
      }
      await retrieval.finalize();
    } catch (error) {
      throw error instanceof CloudStorageError
        ? error
        : new CloudStorageError('FileSystem', `FTP ${operation} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return Buffer.concat(chunks, total).toString('utf8').split(/\r?\n/);
  }

  async list(path: string): Promise<string[]> {
    try {
      return await this.readAll(`LIST ${path}`, 'LIST');
    } catch (error) {
      if (error instanceof CloudStorageError && error.message.startsWith('FTP LIST 失败')) throw error;
      throw new CloudStorageError('FileSystem', `FTP LIST 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async mlsd(path: string): Promise<string[]> {
    try {
      return await this.readAll(`MLSD ${path}`, 'MLSD');
    } catch (error) {
      if (error instanceof CloudStorageError && error.message.startsWith('FTP MLSD 失败')) throw error;
      throw new CloudStorageError('FileSystem', `FTP MLSD 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async retr(filename: string): Promise<Retrieval> {
    try {
      return await this.beginData(`RETR ${filename}`);
    } catch (error) {
      throw new CloudStorageError('FileSystem', `FTP 下载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** ftp.rs:700: STOR into `filename`; the whole copy is bounded by `transfer_timeout`. */
  async stor(filename: string, source: AsyncIterable<Uint8Array>, totalSize: number, progress?: UploadProgressCallback | null): Promise<void> {
    const retrieval = await this.beginData(`STOR ${filename}`);
    const socket = retrieval.socket;
    const timeoutMs = transferTimeoutMs(totalSize);
    const copy = async (): Promise<void> => {
      let sent = 0;
      for await (const chunk of source) {
        sent += chunk.byteLength;
        if (!socket.write(chunk)) await once(socket, 'drain');
        progress?.(sent, totalSize);
      }
      await new Promise<void>(resolve => { socket.end(resolve); });
    };
    try {
      await withTimeout(
        copy(),
        timeoutMs,
        `FTP STOR 数据通道超时（${Math.round(timeoutMs / 1000)} 秒），已中断以避免无限挂起`,
      );
      await retrieval.finalize();
    } catch (error) {
      socket.destroy();
      if (error instanceof CloudStorageError && error.message.includes('数据通道超时')) throw error;
      throw new CloudStorageError('FileSystem', `FTP 上传失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class FtpStorage extends CloudStorageBase {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly useTls: boolean;
  private readonly root: string;

  constructor(config: FtpConfig, root: string) {
    super();
    const host = config.host.trim();
    if (!host) throw new CloudStorageError('Validation', 'FTP host 不能为空');
    this.host = host;
    this.port = config.port ?? 21;
    this.username = config.username;
    this.password = config.password;
    this.useTls = config.useTls ?? false;
    this.root = root.replace(/^\/+|\/+$/g, '');
  }

  override providerName(): string { return 'FTP'; }

  override instanceBindingHint(): string {
    return `ftp|host=${this.host}|port=${this.port}|user=${this.username}|tls=${this.useTls}|root=${this.root}`;
  }

  private remotePath(key: string): string { return joinPaths(this.root, key); }

  /** ftp.rs:127: connect + login share one 45 s budget. */
  private async createClient(): Promise<FtpSession> {
    return withTimeout(
      this.createClientInner(),
      FTP_CONNECT_TIMEOUT_MS,
      `FTP 连接超时（${Math.round(FTP_CONNECT_TIMEOUT_MS / 1000)} 秒）: ${this.host}:${this.port}`,
    );
  }

  private async createClientInner(): Promise<FtpSession> {
    const session = await FtpSession.connect(this.host, this.port, this.useTls);
    try {
      await session.login(this.username, this.password);
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }

  private withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(operation);
  }

  /** ftp.rs:390: best-effort recursive MKD; failures surface on the later write. */
  private async ensureDirectory(client: FtpSession, path: string): Promise<void> {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(part => part !== '');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        await client.mkdir(`/${current}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('550') || message.includes('already exists')) {
          defaultLogSink().debug(`[FtpStorage] MKDIR /${current} 已存在（忽略）：${message}`);
          continue;
        }
        // The current semantics still do not fail here; the later write reports it.
        defaultLogSink().warn(`[FtpStorage] MKDIR /${current} 失败：${message}`);
        continue;
      }
    }
  }

  /** ftp.rs:381: write to a nonce-suffixed object, then RNFR/RNTO into place. */
  private async uploadReaderAtomic(
    client: FtpSession,
    finalName: string,
    source: AsyncIterable<Uint8Array>,
    fileSize: number,
    progress?: UploadProgressCallback | null,
  ): Promise<void> {
    const tempName = `${finalName}.tmp-${randomHex(16)}`;
    await client.stor(tempName, source, fileSize, progress);
    try {
      await client.rename(tempName, finalName);
    } catch (error) {
      await client.rm(tempName).catch(() => undefined);
      throw error;
    }
  }

  override async checkConnection(): Promise<void> {
    await this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        await this.ensureDirectory(client, this.root);
        await client.cwd(absolutePath(this.root));
      } finally {
        await client.quit();
      }
    });
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    await this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        await this.ensureDirectory(client, this.root);
        await client.cwd(absolutePath(this.root));

        const [parentPath, filename] = splitParentFilename(key);
        if (parentPath) {
          const fullParent = this.remotePath(parentPath);
          await this.ensureDirectory(client, fullParent);
          await client.cwd(absolutePath(fullParent));
        }

        await this.uploadReaderAtomic(client, filename, bufferSource(data), data.byteLength, null);
      } finally {
        await client.quit();
      }
    });
  }

  override async get(key: string): Promise<Uint8Array | null> {
    return this.getBounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES);
  }

  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (length === 0) return new Uint8Array(0);
    if (offset + length > FTP_RANGE_MAX_OBJECT_BYTES) {
      throw new CloudStorageError('Configuration', 'FTP Range 超出小对象安全阈值（8 MiB）；FTP 不支持定长区间读取');
    }
    // getBounded checks SIZE before RETR and enforces the same cap during transfer.
    const bytes = await this.getBounded(key, FTP_RANGE_MAX_OBJECT_BYTES);
    if (bytes === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    if (offset + length > bytes.byteLength) throw new CloudStorageError('Configuration', 'FTP Range 请求越界');
    return bytes.slice(offset, offset + length);
  }

  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    return this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        const [parentPath, filename] = splitParentFilename(key);
        const fullParent = joinPaths(this.root, parentPath);
        try {
          await client.cwd(absolutePath(fullParent));
        } catch (error) {
          if (isNotFoundError(error)) return null;
          throw error;
        }

        let size: number;
        try {
          size = await client.size(filename);
        } catch (error) {
          if (isNotFoundError(error)) return null;
          throw error;
        }

        // The declared length is rejected before RETR: no data bytes are read.
        ensureDeclaredLenWithinBudget('FTP', key, size, maxBytes);

        if (size === 0) {
          try {
            await client.mdtm(filename);
          } catch (error) {
            if (isNotFoundError(error)) return null;
            throw error;
          }
        }

        const tempPath = join(tmpdir(), `ftp-get-${randomHex(8)}`);
        try {
          const retrieval = await client.retr(filename);
          const checksum = await streamToFile(retrieval.stream, tempPath, size, null);
          await retrieval.finalize();
          void checksum;
          const data = await readFile(tempPath).catch(error => {
            throw new CloudStorageError('FileSystem', `读取临时文件失败：${ioError(error)}`);
          });
          ensureMemoryGetMatchesDeclaredLen('FTP', key, data.byteLength, size);
          return new Uint8Array(data);
        } finally {
          await unlink(tempPath).catch(() => undefined);
        }
      } finally {
        await client.quit();
      }
    });
  }

  override async list(prefix: string): Promise<FileInfo[]> {
    return (await this.listOutcome(prefix)).files;
  }

  override async listOutcome(prefix: string): Promise<ListOutcome> {
    return this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        const files: FileInfo[] = [];
        const start = prefix.replace(/^\/+|\/+$/g, '');
        const dirs: string[] = [start];
        const visited = new Set<string>();
        let truncated = false;

        for (let relativeDir = dirs.pop(); relativeDir !== undefined; relativeDir = dirs.pop()) {
          if (visited.has(relativeDir)) continue;
          visited.add(relativeDir);
          if (visited.size > FTP_LIST_MAX_DIRS) {
            defaultLogSink().warn(
              `[FtpStorage] 递归列举已访问 ${FTP_LIST_MAX_DIRS} 个目录，停止遍历并将结果标记为截断`,
            );
            truncated = true;
            break;
          }
          const fullDir = joinPaths(this.root, relativeDir);
          const fullDirAbs = absolutePath(fullDir);

          let rawEntries: string[];
          try {
            rawEntries = await client.mlsd(fullDirAbs);
          } catch (mlsdError) {
            if (isNotFoundError(mlsdError)) continue;
            try {
              rawEntries = await client.list(fullDirAbs);
            } catch (listError) {
              if (isNotFoundError(listError)) continue;
              throw listError;
            }
          }

          for (const raw of rawEntries) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            if (/^total \d+$/.test(trimmed)) continue;
            const entry = parseListEntry(raw);
            if (entry === null) {
              throw new CloudStorageError('Network', `FTP 列表包含无法解析的条目，已拒绝把不完整结果当作成功: ${raw}`);
            }
            if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue;
            const key = joinPaths(relativeDir, entry.name);
            if (entry.isDir) dirs.push(key);
            else files.push({ key, size: entry.size, lastModified: chronoAutoSiZ(entry.modified) });
          }
        }

        files.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
        return { files, truncated };
      } finally {
        await client.quit();
      }
    });
  }

  override async delete(key: string): Promise<void> {
    await this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        await this.ensureDirectory(client, this.root);
        await client.cwd(absolutePath(this.root));

        const [parentPath, filename] = splitParentFilename(key);
        if (parentPath) {
          const fullParent = this.remotePath(parentPath);
          try {
            await client.cwd(absolutePath(fullParent));
          } catch (error) {
            if (!isMissingDirectoryError(error)) throw error;
            return;
          }
        }

        try {
          await client.rm(filename);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      } finally {
        await client.quit();
      }
    });
  }

  override async stat(key: string): Promise<FileInfo | null> {
    return this.withRetry(async () => {
      const client = await this.createClient();
      try {
        await client.cwd('/');
        const [parentPath, filename] = splitParentFilename(key);
        const fullParent = joinPaths(this.root, parentPath);
        try {
          await client.cwd(absolutePath(fullParent));
        } catch (error) {
          if (isNotFoundError(error)) return null;
          throw error;
        }

        let size: number;
        try {
          size = await client.size(filename);
        } catch (error) {
          if (isNotFoundError(error)) return null;
          throw error;
        }

        let modified: number;
        try {
          modified = await client.mdtm(filename);
        } catch (error) {
          if (isNotFoundError(error)) return null;
          throw error;
        }

        return { key, size, lastModified: chronoAutoSiZ(modified) };
      } finally {
        await client.quit();
      }
    });
  }

  override async putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string> {
    const checksum = await this.withRetry(async () => {
      let fileSize: number;
      try { fileSize = (await statFile(localPath)).size; }
      catch (error) { throw new CloudStorageError('FileSystem', `读取文件元信息失败：${ioError(error)}`); }

      const hash = await this.hashFile(localPath);
      progress?.(0, fileSize);

      const client = await this.createClient();
      try {
        await client.cwd('/');
        await this.ensureDirectory(client, this.root);
        await client.cwd(absolutePath(this.root));

        const [parentPath, filename] = splitParentFilename(key);
        if (parentPath) {
          const fullParent = this.remotePath(parentPath);
          await this.ensureDirectory(client, fullParent);
          await client.cwd(absolutePath(fullParent));
        }

        const source = await this.fileSource(localPath);
        await this.uploadReaderAtomic(client, filename, source, fileSize, progress);
      } finally {
        await client.quit();
      }
      return hash;
    });

    // STOR success is not enough: SIZE the object outside the retry loop so a
    // deterministic short write is not repeated three times.
    const fileSize = (await statFile(localPath)).size;
    await this.verifyRemoteObjectSize(key, fileSize);
    return checksum;
  }

  override async getFile(key: string, localPath: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string> {
    return this.withRetry(async () => {
      const client = await this.createClient();
      try {
        const info = await this.stat(key);
        if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
        const totalSize = info.size;
        progress?.(0, totalSize);

        await client.cwd('/');
        await client.cwd(absolutePath(this.root));

        const [parentPath, filename] = splitParentFilename(key);
        if (parentPath) {
          const fullParent = this.remotePath(parentPath);
          try {
            await client.cwd(absolutePath(fullParent));
          } catch (error) {
            if (isNotFoundError(error)) throw new CloudStorageError('NotFound', '云端文件不存在');
            throw error;
          }
        }

        const parentDir = localPath.includes('/') ? localPath.slice(0, localPath.lastIndexOf('/')) : '.';
        await mkdir(parentDir, { recursive: true }).catch(error => {
          throw new CloudStorageError('FileSystem', `创建目录失败：${ioError(error)}`);
        });

        const tempPath = await randomTempName(localPath, 'ftp-download-', '');
        try {
          const retrieval = await client.retr(filename);
          const checksum = await streamToFile(retrieval.stream, tempPath, totalSize, progress);
          await retrieval.finalize();

          if (expectedChecksum != null && checksum !== expectedChecksum) {
            throw new CloudStorageError('Validation', `校验和不匹配：期望 ${expectedChecksum.slice(0, 8)}, 实际 ${checksum.slice(0, 8)}`);
          }

          progress?.(totalSize, totalSize);

          const handle = await openFile(tempPath, 'r');
          try { await handle.sync(); } finally { await handle.close(); }
          await renameOver(tempPath, localPath);
          return checksum;
        } catch (error) {
          await unlink(tempPath).catch(() => undefined);
          throw error;
        }
      } finally {
        await client.quit();
      }
    });
  }

  private async hashFile(path: string): Promise<string> {
    const handle = await open(path, 'r').catch(error => {
      throw new CloudStorageError('FileSystem', `打开文件失败：${ioError(error)}`);
    });
    const hasher = sha256Hasher();
    try {
      const buffer = Buffer.alloc(READ_BLOCK);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, READ_BLOCK, null);
        if (bytesRead === 0) break;
        hasher.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hasher.digestHex();
  }

  private async fileSource(path: string): Promise<AsyncIterable<Uint8Array>> {
    const handle = await open(path, 'r').catch(error => {
      throw new CloudStorageError('FileSystem', `打开文件失败：${ioError(error)}`);
    });
    return {
      async *[Symbol.asyncIterator]() {
        const buffer = Buffer.alloc(READ_BLOCK);
        try {
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, READ_BLOCK, null);
            if (bytesRead === 0) return;
            yield buffer.subarray(0, bytesRead);
          }
        } finally {
          await handle.close();
        }
      },
    };
  }
}

/** Kept for parity with `FtpStorage::get_budget_exceeded` call sites in tests. */
export function isBudgetExceeded(error: unknown): boolean { return isBudgetExceededError(error); }

export { MEMORY_GET_BUDGET_EXCEEDED };
export { BoundedMemoryBody };

/** Wrap an in-memory payload in the async-iterable shape `stor` expects. */
function bufferSource(data: Uint8Array): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { yield data; } };
}
