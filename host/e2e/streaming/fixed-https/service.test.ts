import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, fetch as realFetch } from 'undici';
import { expect, it } from 'vitest';
import { ILINK_HOST, QR, QR_PATH, STATUS_PATH, startIlinkService } from './service.ts';
import { runIsolated } from './run.ts';

const local = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const url = `https://${ILINK_HOST}`;
const childArgs = ['--import', local('node-proxy.mjs'), local('probe-b.ts')];
const execute = promisify(execFile);
const agentFor = (service: Awaited<ReturnType<typeof startIlinkService>>) =>
  new ProxyAgent({ uri: service.proxyUrl, requestTls: { ca: readFileSync(service.caFile) } });
const body = '{"get_updates_buf":"原始 cursor /+ \\\"","base_info":{"channel_version":"1.0.0"}}';

it('two isolated B production clients retain fixed host/SNI, encoded paths, methods and original POST bytes', async () => {
  const before = { ...process.env };
  const one = await startIlinkService();
  const two = await startIlinkService();
  try {
    const outputs = await Promise.all([one, two].map(service => execute(process.execPath, childArgs, { env: service.env })));
    expect(outputs[0]!.stdout).toBe(outputs[1]!.stdout);
    expect(JSON.parse(outputs[0]!.stdout)).toEqual({ evidence: 'B-production-client-only',
      qr: { qrcode: QR, qrcode_img_content: 'x5-offline-not-a-login' },
      status: { status: 'wait', bot_token: null, ilink_bot_id: null, ilink_user_id: null, baseurl: null },
      updates: { ret: 0, errcode: null, errmsg: null, msgs: [], get_updates_buf: 'x5-fixed', longpolling_timeout_ms: 35000 } });
    expect(one.dir).not.toBe(two.dir);
    expect(one.proxyUrl).not.toBe(two.proxyUrl);
    expect(readFileSync(one.caFile).equals(readFileSync(two.caFile))).toBe(false);
    for (const service of [one, two]) {
      expect(service.requests.map(r => [r.seq, r.method, r.path, r.host, r.sni, r.bodyBase64])).toEqual([
        [0, 'GET', QR_PATH, ILINK_HOST, ILINK_HOST, ''],
        [1, 'GET', STATUS_PATH, ILINK_HOST, ILINK_HOST, ''],
        [2, 'POST', '/ilink/bot/getupdates', ILINK_HOST, ILINK_HOST, Buffer.from(body).toString('base64')],
      ]);
      expect(service.requests[1]!.rawHeaders).toContain('iLink-App-ClientVersion');
      expect(service.requests[2]!.rawHeaders).toContain('Bearer x5-offline-token');
      expect(readFileSync(`${service.dir}/requests.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(service.requests);
      expect(service.faults).toEqual([]);
      expect(service.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(service.env.HOME).toBe(`${service.dir}/home`);
      expect(service.env.NO_PROXY).toBe('');
    }
    // Response bytes deterministic; random production x-wechat-uin headers remain raw, not normalized.
    expect(one.requests.map(r => r.responseBody)).toEqual(two.requests.map(r => r.responseBody));
  } finally {
    await Promise.all([one.stop(), two.stop()]);
  }
  expect(process.env).toEqual(before);
  expect(existsSync(one.caFile)).toBe(false);
  expect(existsSync(two.caFile)).toBe(false);
});

it('records arbitrary body bytes without JSON/text conversion, and releases ports and private keys', async () => {
  const service = await startIlinkService();
  const agent = agentFor(service);
  const bytes = Buffer.from([0, 255, 128, 13, 10, 123, 125]);
  try {
    const response = await realFetch(`${url}/ilink/bot/getupdates`, { method: 'POST', body: bytes, dispatcher: agent });
    expect(response.status).toBe(200);
    await response.text();
    expect(service.requests[0]!.bodyBase64).toBe(bytes.toString('base64'));
    expect(service.requests[0]!.method).toBe('POST');
  } finally {
    await agent.destroy();
    await service.stop();
    await service.stop();
  }
  expect(existsSync(`${service.dir}/tls`)).toBe(false);
  expect(existsSync(`${service.dir}/requests.jsonl`)).toBe(true);
  for (const port of [service.targetPort, Number(new URL(service.proxyUrl).port)]) {
    const error = await new Promise<Error>(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('error', resolve);
      socket.once('connect', () => { socket.destroy(); resolve(new Error('port still open')); });
    });
    expect(error.message).toContain('ECONNREFUSED');
  }
});

it('rejects untrusted CA and wrong hostname rather than disabling TLS verification', async () => {
  const service = await startIlinkService();
  const untrusted = new ProxyAgent(service.proxyUrl);
  try {
    await expect(realFetch(`${url}${QR_PATH}`, { dispatcher: untrusted })).rejects.toMatchObject({
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    });
    const error = await new Promise<Error>(resolve => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: service.targetPort,
        servername: 'github.com', ca: readFileSync(service.caFile), path: QR_PATH }, response => {
        response.resume(); resolve(new Error('wrong hostname accepted'));
      });
      request.once('error', resolve); request.end();
    });
    expect(error).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(service.requests).toHaveLength(0);
  } finally {
    await untrusted.destroy(); await service.stop();
  }
});

it('denies other fixed domains and logs unknown method/path failures without forwarding', async () => {
  const service = await startIlinkService();
  const agent = agentFor(service);
  try {
    for (const domain of ['github.com', 'codeload.github.com', 'clawhub.ai']) {
      await expect(realFetch(`https://${domain}/`, { dispatcher: agent })).rejects.toThrow();
    }
    for (const [method, path] of [['DELETE', QR_PATH], ['GET', '/not-scripted']]) {
      const response = await realFetch(`${url}${path}`, { method, dispatcher: agent });
      expect(response.status).toBe(501);
      expect(await response.text()).toBe('{"error":"x5 unscripted method/path"}');
    }
    expect(service.faults.filter(f => f.kind === 'denied-connect').map(f => f.detail)).toEqual([
      'github.com:443', 'codeload.github.com:443', 'clawhub.ai:443',
    ]);
    expect(service.requests.map(r => r.responseStatus)).toEqual([501, 501]);
  } finally {
    await agent.destroy(); await service.stop();
  }
});

it('launcher reports child failure and no-traffic success explicitly, and removes each CA', async () => {
  for (const code of [0, 7]) {
    const result = await runIsolated(process.execPath, ['-e', `process.exit(${code})`]);
    expect(result).toMatchObject({ ok: false, code, signal: null });
    expect(JSON.parse(readFileSync(`${result.dir}/result.json`, 'utf8'))).toMatchObject({ ok: false, requests: 0 });
    expect(existsSync(`${result.dir}/tls`)).toBe(false);
  }
});

it('launcher SIGTERM forwards to its child and leaves a failed result and released CA', async () => {
  const child = spawn(process.execPath, [local('run.ts'), '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  let text = '';
  const ready = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', data => {
      text += String(data);
      const first = text.split('\n')[0];
      if (first && text.includes('\n')) resolve(JSON.parse(first).dir);
    });
    child.once('close', () => reject(new Error('launcher closed before ready')));
  });
  try {
    const dir = await ready;
    child.kill('SIGTERM');
    expect(await finished).toBe(1);
    expect(JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'))).toMatchObject({ ok: false, signal: 'SIGTERM' });
    expect(existsSync(`${dir}/tls`)).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
});
