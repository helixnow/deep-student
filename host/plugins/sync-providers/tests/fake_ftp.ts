/**
 * In-process fake FTP server for transport tests.
 *
 * Implements the subset of RFC 959 / RFC 3659 that `ftp.rs` drives: explicit
 * AUTH TLS (rejectable, so the login ordering can be asserted without a
 * certificate), USER/PASS, TYPE I, CWD/MKD/DELE/RNFR/RNTO, SIZE/MDTM, passive
 * data channels (EPSV/PASV), and MLSD/LIST/RETR/STOR. No Docker, no credentials.
 */

import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FtpReply {
  code: number;
  text: string;
}

export interface FakeFtpOptions {
  files?: Record<string, string | Uint8Array>;
  dirs?: string[];
  /** Intercept a command before the default handler. Return null to fall through. */
  intercept?: (command: string, server: FakeFtp) => FtpReply | null;
  /** Reject MLSD with this code to force the LIST fallback. */
  mlsdStatus?: number;
  /** Reject RNTO with this code. */
  rntoStatus?: number;
  /** Store only this many bytes on STOR, simulating a short write. */
  storeLimit?: number;
  /** Reply to AUTH TLS; the default is a rejection so no TLS handshake is attempted. */
  authTlsStatus?: number;
}

function normalize(path: string): string {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(part => part !== '');
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function parentOf(path: string): string {
  const normalized = normalize(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function baseOf(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export class FakeFtp {
  readonly commands: string[] = [];
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(['/']);
  readonly modified = new Map<string, string>();
  readonly errors: Error[] = [];

  private readonly options: FakeFtpOptions;
  private control: Server | null = null;
  private passive: Server | null = null;
  private cwd = '/';
  private renameFrom: string | null = null;
  private queuedData: Socket | null = null;
  private dataWaiter: ((socket: Socket) => void) | null = null;
  private readonly sockets = new Set<Socket>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: FakeFtpOptions = {}) {
    this.options = options;
    for (const dir of options.dirs ?? []) this.addDir(dir);
    for (const [path, data] of Object.entries(options.files ?? {})) this.addFile(path, data);
  }

  addDir(path: string): void {
    let current = normalize(path);
    for (;;) {
      this.dirs.add(current);
      if (current === '/') return;
      current = parentOf(current);
    }
  }

  addFile(path: string, data: string | Uint8Array, modified = '20260101120000'): void {
    const normalized = normalize(path);
    this.addDir(parentOf(normalized));
    this.files.set(normalized, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
    this.modified.set(normalized, modified);
  }

  async start(): Promise<{ host: string; port: number }> {
    const server = createTcpServer(socket => this.accept(socket));
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    this.control = server;
    const address = server.address() as AddressInfo;
    return { host: '127.0.0.1', port: address.port };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.closePassive();
    await new Promise<void>(resolve => {
      if (this.control === null) { resolve(); return; }
      this.control.close(() => resolve());
    });
    this.control = null;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    this.reply(socket, { code: 220, text: 'Fake FTP ready' });

    let partial = '';
    socket.on('data', chunk => {
      partial += chunk.toString('utf8');
      for (;;) {
        const index = partial.indexOf('\n');
        if (index < 0) break;
        const line = partial.slice(0, index).replace(/\r$/, '');
        partial = partial.slice(index + 1);
        if (!line) continue;
        this.commands.push(line);
        this.queue = this.queue.then(() => this.handle(line, socket)).catch(error => {
          this.errors.push(error instanceof Error ? error : new Error(String(error)));
          this.reply(socket, { code: 451, text: 'Internal error' });
        });
      }
    });
  }

  private reply(socket: Socket, reply: FtpReply): void {
    if (!socket.destroyed) socket.write(`${reply.code} ${reply.text}\r\n`);
  }

  private resolvePath(argument: string): string {
    return normalize(argument.startsWith('/') ? argument : `${this.cwd}/${argument}`);
  }

  private async handle(line: string, socket: Socket): Promise<void> {
    const override = this.options.intercept?.(line, this);
    if (override !== undefined && override !== null) {
      this.reply(socket, override);
      return;
    }
    const space = line.indexOf(' ');
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const argument = space < 0 ? '' : line.slice(space + 1);
    const path = this.resolvePath(argument);

    switch (verb) {
      case 'USER':
        this.reply(socket, { code: 331, text: 'Password required' });
        return;
      case 'PASS':
        this.reply(socket, { code: 230, text: 'Login successful' });
        return;
      case 'TYPE':
        this.reply(socket, { code: 200, text: 'Type set' });
        return;
      case 'AUTH':
        this.reply(socket, this.options.authTlsStatus === undefined
          ? { code: 500, text: 'AUTH TLS not supported' }
          : { code: this.options.authTlsStatus, text: 'AUTH TLS' });
        return;
      case 'PBSZ':
      case 'PROT':
        this.reply(socket, { code: 200, text: 'OK' });
        return;
      case 'CWD':
        if (this.dirs.has(path)) {
          this.cwd = path;
          this.reply(socket, { code: 250, text: 'Directory changed' });
        } else {
          this.reply(socket, { code: 550, text: 'No such file or directory.' });
        }
        return;
      case 'MKD':
        if (this.dirs.has(path) || this.files.has(path)) {
          this.reply(socket, { code: 550, text: 'Directory already exists.' });
        } else {
          this.addDir(path);
          this.reply(socket, { code: 257, text: `"${path}" created` });
        }
        return;
      case 'DELE':
        if (this.files.delete(path)) this.modified.delete(path);
        this.reply(socket, { code: 250, text: 'File deleted' });
        return;
      case 'RNFR':
        if (this.files.has(path)) {
          this.renameFrom = path;
          this.reply(socket, { code: 350, text: 'Ready for RNTO' });
        } else {
          this.reply(socket, { code: 550, text: 'No such file or directory.' });
        }
        return;
      case 'RNTO': {
        if (this.options.rntoStatus !== undefined) {
          this.reply(socket, { code: this.options.rntoStatus, text: 'Rename rejected' });
          return;
        }
        const from = this.renameFrom;
        const data = from === null ? undefined : this.files.get(from);
        if (from === null || data === undefined) {
          this.reply(socket, { code: 550, text: 'RNFR required first.' });
          return;
        }
        this.files.delete(from);
        this.files.set(path, data);
        const modified = this.modified.get(from);
        this.modified.delete(from);
        if (modified !== undefined) this.modified.set(path, modified);
        this.renameFrom = null;
        this.reply(socket, { code: 250, text: 'Renamed' });
        return;
      }
      case 'SIZE': {
        const data = this.files.get(path);
        this.reply(socket, data === undefined
          ? { code: 550, text: 'No such file or directory.' }
          : { code: 213, text: String(data.byteLength) });
        return;
      }
      case 'MDTM': {
        const modified = this.modified.get(path);
        this.reply(socket, modified === undefined
          ? { code: 550, text: 'No such file or directory.' }
          : { code: 213, text: modified });
        return;
      }
      case 'EPSV': {
        const port = await this.openPassive();
        this.reply(socket, { code: 229, text: `Entering Extended Passive Mode (|||${port}|)` });
        return;
      }
      case 'PASV': {
        const port = await this.openPassive();
        this.reply(socket, {
          code: 227,
          text: `Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})`,
        });
        return;
      }
      case 'MLSD':
        if (this.options.mlsdStatus !== undefined) {
          this.reply(socket, { code: this.options.mlsdStatus, text: 'MLSD rejected' });
          return;
        }
        await this.sendListing(socket, path, false);
        return;
      case 'LIST':
        await this.sendListing(socket, path, true);
        return;
      case 'RETR': {
        const data = this.files.get(path);
        if (data === undefined) {
          this.reply(socket, { code: 550, text: 'No such file or directory.' });
          return;
        }
        this.reply(socket, { code: 150, text: 'Opening data connection' });
        const channel = await this.takeDataSocket();
        channel.end(data, () => {
          this.reply(socket, { code: 226, text: 'Transfer complete' });
          this.closePassive();
        });
        return;
      }
      case 'STOR': {
        this.reply(socket, { code: 150, text: 'Opening data connection' });
        const channel = await this.takeDataSocket();
        const chunks: Buffer[] = [];
        channel.on('data', chunk => { chunks.push(chunk); });
        await new Promise<void>(resolve => { channel.on('end', () => resolve()); });
        const received = Buffer.concat(chunks);
        const stored = this.options.storeLimit === undefined
          ? received
          : received.subarray(0, this.options.storeLimit);
        this.files.set(path, Buffer.from(stored));
        this.modified.set(path, '20260101120000');
        this.reply(socket, { code: 226, text: 'Transfer complete' });
        this.closePassive();
        return;
      }
      case 'QUIT':
        this.reply(socket, { code: 221, text: 'Goodbye' });
        socket.end();
        return;
      default:
        this.reply(socket, { code: 502, text: 'Command not implemented' });
    }
  }

  private async openPassive(): Promise<number> {
    this.closePassive();
    const server = createTcpServer(socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      if (this.dataWaiter !== null) {
        const waiter = this.dataWaiter;
        this.dataWaiter = null;
        waiter(socket);
      } else {
        this.queuedData = socket;
      }
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    this.passive = server;
    return (server.address() as AddressInfo).port;
  }

  private closePassive(): void {
    if (this.passive !== null) {
      this.passive.close();
      this.passive = null;
    }
    this.queuedData = null;
    this.dataWaiter = null;
  }

  private async takeDataSocket(): Promise<Socket> {
    if (this.queuedData !== null) {
      const socket = this.queuedData;
      this.queuedData = null;
      return socket;
    }
    return new Promise<Socket>(resolve => { this.dataWaiter = resolve; });
  }

  private listing(path: string, posix: boolean): string | null {
    if (!this.dirs.has(path)) return null;
    const entries: string[] = [];
    for (const dir of this.dirs) {
      if (dir === path || parentOf(dir) !== path) continue;
      entries.push(posix
        ? `drwxr-xr-x 1 user group 0 Jan 1 2026 ${baseOf(dir)}`
        : `type=dir;modify=20260101120000; ${baseOf(dir)}`);
    }
    for (const [file, data] of this.files) {
      if (parentOf(file) !== path) continue;
      entries.push(posix
        ? `-rw-r--r-- 1 user group ${data.byteLength} Jan 1 2026 ${baseOf(file)}`
        : `type=file;size=${data.byteLength};modify=${this.modified.get(file) ?? '20260101120000'}; ${baseOf(file)}`);
    }
    entries.sort();
    return entries.length === 0 ? '' : `${entries.join('\r\n')}\r\n`;
  }

  private async sendListing(socket: Socket, path: string, posix: boolean): Promise<void> {
    const body = this.listing(path, posix);
    if (body === null) {
      this.reply(socket, { code: 550, text: 'No such file or directory.' });
      return;
    }
    this.reply(socket, { code: 150, text: 'Opening data connection' });
    const channel = await this.takeDataSocket();
    channel.end(body, () => {
      this.reply(socket, { code: 226, text: 'Transfer complete' });
      this.closePassive();
    });
  }
}

/** The server never accepts AUTH TLS by default; the client must fail before USER. */
export async function spawnFakeFtp(options: FakeFtpOptions = {}): Promise<{ server: FakeFtp; host: string; port: number }> {
  const server = new FakeFtp(options);
  const address = await server.start();
  return { server, ...address };
}
