/** WP-089: per-take offline CONNECT endpoint. No upstream forwarding or DNS lookup. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

export const ILINK_HOST = 'ilinkai.weixin.qq.com';
export const QR = "x5 offline !'()* /+中文";
export const QR_PATH = '/ilink/bot/get_bot_qrcode?bot_type=3';
export const STATUS_PATH = '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(QR)
  .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface RequestRecord {
  seq: number;
  method: string;
  path: string;
  host: string;
  sni: string | false | null;
  httpVersion: string;
  rawHeaders: string[];
  bodyBase64: string;
  responseStatus: number;
  responseBody: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing TCP address'));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function startIlinkService(parent = '/tmp/opencode') {
  const dir = mkdtempSync(join(parent, 'x5-ilink-'));
  chmodSync(dir, 0o700);
  const tlsDir = join(dir, 'tls');
  mkdirSync(tlsDir, { mode: 0o700 });
  const caFile = join(tlsDir, 'ca.pem');
  const requests: RequestRecord[] = [];
  const faults: { kind: string; detail: string }[] = [];
  const journal = (file: string, value: unknown) => appendFileSync(join(dir, file), JSON.stringify(value) + '\n');
  const fault = (kind: string, detail: string) => {
    const entry = { kind, detail };
    faults.push(entry);
    journal('transport.jsonl', entry);
  };
  writeFileSync(join(dir, 'requests.jsonl'), '');
  writeFileSync(join(dir, 'transport.jsonl'), '');
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', error => fault('socket-error', error.message));
  };
  let target: ReturnType<typeof httpsServer> | undefined;
  let proxy: ReturnType<typeof httpServer> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    for (const socket of sockets) socket.destroy();
    try {
      await Promise.all([target ? close(target) : undefined, proxy ? close(proxy) : undefined]);
    } finally {
      rmSync(tlsDir, { recursive: true, force: true });
      journal('transport.jsonl', { kind: 'stopped', certificatesRemoved: true });
    }
  })();
  try {
    const openssl = async (...args: string[]) => promisify(execFile)('openssl', args, { cwd: tlsDir });
    await openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=X5 per-take offline CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    await openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${ILINK_HOST}`);
    writeFileSync(join(tlsDir, 'server.ext'), `subjectAltName=DNS:${ILINK_HOST}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
    await openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', '2', '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext');

    const handle = async (request: IncomingMessage, response: import('node:http').ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const path = request.url ?? '';
      const host = request.headers.host ?? '';
      let status = 200;
      let body: string;
      if (host !== ILINK_HOST && host !== `${ILINK_HOST}:443`) {
        status = 421; body = '{"error":"x5 unexpected Host"}';
      } else if (request.method === 'GET' && path === QR_PATH) {
        body = JSON.stringify({ qrcode: QR, qrcode_img_content: 'x5-offline-not-a-login' });
      } else if (request.method === 'GET' && path === STATUS_PATH) {
        body = '{"status":"wait"}';
      } else if (request.method === 'POST' && path === '/ilink/bot/getupdates') {
        body = '{"ret":0,"msgs":[],"get_updates_buf":"x5-fixed","longpolling_timeout_ms":35000}';
      } else {
        status = 501; body = '{"error":"x5 unscripted method/path"}';
      }
      const entry: RequestRecord = { seq: requests.length, method: request.method ?? '', path, host,
        sni: (request.socket as TLSSocket).servername, httpVersion: request.httpVersion,
        rawHeaders: request.rawHeaders, bodyBase64: Buffer.concat(chunks).toString('base64'),
        responseStatus: status, responseBody: body };
      requests.push(entry);
      journal('requests.jsonl', entry);
      if (status !== 200) fault('unscripted-request', `${request.method} ${host}${path} -> ${status}`);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    };
    target = httpsServer({ key: readFileSync(join(tlsDir, 'server.key')), cert: readFileSync(join(tlsDir, 'server.pem')) },
      (request, response) => { handle(request, response).catch(error => {
        fault('request-error', String(error)); response.destroy();
      }); });
    target.on('connection', track);
    target.on('tlsClientError', error => fault('tls-error', error.message));
    target.on('clientError', (error, socket) => { fault('http-error', error.message); socket.destroy(); });
    const targetPort = await listen(target);
    proxy = httpServer((request, response) => {
      fault('non-connect', `${request.method} ${request.url}`);
      response.writeHead(405); response.end('x5: CONNECT required');
    });
    proxy.on('connection', track);
    proxy.on('clientError', (error, socket) => { fault('proxy-http-error', error.message); socket.destroy(); });
    proxy.on('connect', (request, downstream, head) => {
      journal('transport.jsonl', { kind: 'connect', authority: request.url, rawHeaders: request.rawHeaders });
      if (request.url !== `${ILINK_HOST}:443`) {
        fault('denied-connect', request.url ?? '');
        downstream.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      // Only ever dial our own loopback TLS port. Preserve tunneled bytes verbatim.
      const upstream = connect(targetPort, '127.0.0.1');
      track(upstream);
      upstream.once('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      upstream.once('error', () => downstream.destroy());
      downstream.once('close', () => upstream.destroy());
      upstream.once('close', () => downstream.destroy());
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(https?|all|no)_proxy$/i.test(key) || /^(NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)) delete env[key];
    }
    for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'tmp']) mkdirSync(join(dir, name), { mode: 0o700 });
    Object.assign(env, { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl,
      ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
      NODE_EXTRA_CA_CERTS: caFile, SSL_CERT_FILE: caFile, SSL_CERT_DIR: tlsDir,
      X5_ILINK_PROXY: proxyUrl, X5_ILINK_CA: caFile, X5_ILINK_RUN: dir,
      HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
      XDG_CACHE_HOME: join(dir, 'cache'), XDG_RUNTIME_DIR: join(dir, 'runtime'), TMPDIR: join(dir, 'tmp') });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ schema: 'x5.ilink-isolation.v0', proxyUrl,
      authority: `${ILINK_HOST}:443`, caFile, routes: [QR_PATH, STATUS_PATH, '/ilink/bot/getupdates'],
      trust: 'per-child only; A requires verified native-root support', golden: false }, null, 2));
    return { dir, caFile, proxyUrl, targetPort, env, requests, faults, stop };
  } catch (error) {
    fault('startup-error', String(error));
    await stop();
    throw new Error(`x5 iLink startup failed; evidence ${dir}`, { cause: error });
  }
}
