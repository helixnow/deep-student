import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/s3.ts';
import { WebDavStorage } from '../../src/webdav.ts';
import {
  S3_ACCESS_KEY_ID,
  S3_BUCKET,
  S3_REGION,
  S3_SECRET_ACCESS_KEY,
  WEBDAV_PASSWORD,
  WEBDAV_USERNAME,
  startCloudService,
  type CloudService,
} from '../__fixtures__/cloud-service.ts';

const SERVICE = fileURLToPath(new URL('../__fixtures__/cloud-service.ts', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../cloud.scenarios.json', import.meta.url));
const enc = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const dec = (bytes: Uint8Array | null): string | null => (bytes === null ? null : Buffer.from(bytes).toString('utf8'));

const running: CloudService[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(service => service.stop()));
});

async function start(seed?: string): Promise<CloudService> {
  const service = await startCloudService({ seed });
  running.push(service);
  return service;
}

function webdav(service: CloudService, options: { password?: string; root?: string } = {}): WebDavStorage {
  return new WebDavStorage(
    { endpoint: service.webdavEndpoint, username: WEBDAV_USERNAME, password: options.password ?? WEBDAV_PASSWORD },
    options.root ?? 'wave0',
    { rateLimitEnv: '0', requestWindowKey: `${service.webdavEndpoint}|${Math.random()}` },
  );
}

function s3(service: CloudService, options: { accessKeyId?: string; root?: string } = {}): S3Storage {
  return new S3Storage({
    endpoint: service.s3Endpoint,
    bucket: S3_BUCKET,
    accessKeyId: options.accessKeyId ?? S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    region: S3_REGION,
    pathStyle: true,
  }, options.root ?? 'wave0');
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const statuses = (service: CloudService): Array<[string, string, number | 'reset']> =>
  service.requests().map(entry => [entry.method, entry.path, entry.status]);

describe('WebDAV boundary with the production WebDavStorage client', () => {
  it('serves put/get/list/stat/delete with logical timestamps', async () => {
    const service = await start('basic');
    const storage = webdav(service);
    await storage.checkConnection();
    expect(dec(await storage.get('docs/a.txt'))).toBe('alpha');
    await storage.put('docs/new/c.txt', enc('charlie'));
    expect(dec(await storage.get('docs/new/c.txt'))).toBe('charlie');

    const stat = await storage.stat('docs/new/c.txt');
    expect(stat).toMatchObject({ size: 7 });
    // One clock for both backends: the 'basic' seed's 4 objects take 00:00..00:03, the PUT is the 5th write.
    expect(new Date(stat!.lastModified).toISOString()).toBe('2021-01-01T00:00:04.000Z');

    const listed = (await storage.list('docs')).map(file => [file.key, file.size]).sort();
    expect(listed).toEqual([['docs/a.txt', 5], ['docs/b.txt', 5], ['docs/new/c.txt', 7]]);

    await storage.delete('docs/a.txt');
    expect(await storage.get('docs/a.txt')).toBeNull();
    expect(service.snapshot().webdav.objects.map(object => object.key)).toEqual(['wave0/docs/b.txt', 'wave0/docs/new/c.txt']);
  });

  it('reports missing keys as null and treats deleting a missing key as success', async () => {
    const service = await start('basic');
    const storage = webdav(service);
    expect(await storage.get('docs/missing.txt')).toBeNull();
    expect(await storage.stat('docs/missing.txt')).toBeNull();
    expect(await storage.list('nowhere')).toEqual([]);
    await storage.delete('docs/missing.txt');
    expect(statuses(service).filter(([method]) => method === 'DELETE')).toEqual([['DELETE', '/wave0/docs/missing.txt', 404]]);
  });

  it('retries an injected 503 / connection reset and then succeeds', async () => {
    const service = await start('basic');
    service.setFaults([
      { service: 'webdav', method: 'PUT', pathIncludes: 'retry.txt', respond: { status: 503, headers: { 'Retry-After': '0' } } },
      { service: 'webdav', method: 'GET', pathIncludes: 'a.txt', respond: 'reset' },
    ]);
    const storage = webdav(service);
    await storage.put('docs/retry.txt', enc('again'));
    expect(dec(await storage.get('docs/a.txt'))).toBe('alpha');
    const tail = statuses(service).filter(([method]) => method === 'PUT' || method === 'GET');
    expect(tail).toEqual([
      ['PUT', '/wave0/docs/retry.txt', 503],
      ['PUT', '/wave0/docs/retry.txt', 201],
      ['GET', '/wave0/docs/a.txt', 'reset'],
      ['GET', '/wave0/docs/a.txt', 200],
    ]);
  });

  it('surfaces exhausted retries, non-retried 429 and wrong credentials as errors', async () => {
    const service = await start('basic');
    service.setFaults([
      { service: 'webdav', method: 'GET', pathIncludes: 'a.txt', times: 3, respond: { status: 500, headers: { 'Retry-After': '0' } } },
      { service: 'webdav', method: 'GET', pathIncludes: 'b.txt', respond: { status: 429, headers: { 'Retry-After': '0' } } },
    ]);
    const storage = webdav(service);
    expect((await failure(storage.get('docs/a.txt'))).message).toContain('500');
    expect((await failure(storage.get('docs/b.txt'))).message).toContain('429');
    const gets = statuses(service).filter(([method]) => method === 'GET').map(([, path, status]) => `${path}:${status}`);
    expect(gets).toEqual(['/wave0/docs/a.txt:500', '/wave0/docs/a.txt:500', '/wave0/docs/a.txt:500', '/wave0/docs/b.txt:429']);

    const denied = webdav(service, { password: 'wrong' });
    await expect(denied.checkConnection()).rejects.toThrow();
    await expect(denied.put('docs/x.txt', enc('x'))).rejects.toThrow();
    expect(service.snapshot().webdav.objects.map(object => object.key)).toEqual(['wave0/docs/a.txt', 'wave0/docs/b.txt']);
  });
});

describe('S3 boundary with the production S3Storage client (AWS SDK)', () => {
  it('serves put/get/list/stat/delete and paginates with continuation tokens', async () => {
    const service = await start('s3-paged');
    const storage = s3(service);
    await storage.checkConnection();
    await storage.put('docs/a.txt', enc('alpha'));
    expect(dec(await storage.get('docs/a.txt'))).toBe('alpha');
    expect(await storage.stat('docs/a.txt')).toMatchObject({ key: 'docs/a.txt', size: 5 });

    const paged = (await storage.list('paged/')).map(file => file.key).sort();
    expect(paged).toEqual(['paged/p0.txt', 'paged/p1.txt', 'paged/p2.txt', 'paged/p3.txt', 'paged/p4.txt']);
    const lists = service.requests().filter(entry => entry.method === 'GET' && entry.query.includes('list-type=2'));
    expect(lists).toHaveLength(3); // maxKeys=2 → pages of 2, 2, 1

    await storage.delete('docs/a.txt');
    expect(await storage.get('docs/a.txt')).toBeNull();
  });

  it('reports missing keys as null and treats deleting a missing key as success', async () => {
    const service = await start('basic');
    const storage = s3(service);
    expect(await storage.get('docs/missing.txt')).toBeNull();
    expect(await storage.stat('docs/missing.txt')).toBeNull();
    expect(await storage.list('nowhere/')).toEqual([]);
    await storage.delete('docs/missing.txt');
    expect(statuses(service)).toEqual([
      ['GET', `/${S3_BUCKET}/wave0/docs/missing.txt`, 404],
      ['HEAD', `/${S3_BUCKET}/wave0/docs/missing.txt`, 404],
      ['GET', `/${S3_BUCKET}`, 200],
      ['DELETE', `/${S3_BUCKET}/wave0/docs/missing.txt`, 204],
    ]);
  });

  it('lets the SDK retry an injected 503 / reset, and fails after 3 attempts of 500', async () => {
    const service = await start('basic');
    service.setFaults([
      { service: 's3', method: 'PUT', pathIncludes: 'retry.txt', respond: { status: 503, headers: { 'Retry-After': '0' } } },
      { service: 's3', method: 'GET', pathIncludes: 'a.txt', respond: 'reset' },
      { service: 's3', method: 'GET', pathIncludes: 'b.txt', times: 3, respond: { status: 500 } },
    ]);
    const storage = s3(service);
    await storage.put('docs/retry.txt', enc('again'));
    expect(dec(await storage.get('docs/a.txt'))).toBe('alpha');
    expect((await failure(storage.get('docs/b.txt'))).message).toContain('S3 下载失败');
    expect(statuses(service).map(([method, path, status]) => `${method} ${path.split('/').pop()} ${status}`)).toEqual([
      'PUT retry.txt 503', 'PUT retry.txt 200',
      'GET a.txt reset', 'GET a.txt 200',
      'GET b.txt 500', 'GET b.txt 500', 'GET b.txt 500',
    ]);
  });

  it('rejects an unknown access key with InvalidAccessKeyId', async () => {
    const service = await start('basic');
    const denied = s3(service, { accessKeyId: 'WRONGKEY' });
    expect((await failure(denied.put('docs/x.txt', enc('x')))).message).toContain('InvalidAccessKeyId');
    expect(service.snapshot().s3.objects.map(object => object.key)).toEqual(['wave0/docs/a.txt', 'wave0/docs/b.txt']);
  });
});

describe('determinism, reset and isolation', () => {
  const script = async (service: CloudService): Promise<unknown[]> => {
    const dav = webdav(service);
    const bucket = s3(service);
    const out: unknown[] = [];
    await dav.put('docs/c.txt', enc('charlie'));
    out.push(dec(await dav.get('docs/c.txt')), await dav.stat('docs/c.txt'), await dav.list('docs'));
    await dav.delete('docs/b.txt');
    await bucket.put('docs/c.txt', enc('charlie'));
    out.push(await bucket.stat('docs/c.txt'), await bucket.list('docs/'));
    await bucket.delete('docs/b.txt');
    out.push(await bucket.get('docs/b.txt'));
    return out;
  };

  it('gives two same-seed instances byte-identical results, transcripts and state', async () => {
    const [first, second] = await Promise.all([start('basic'), start('basic')]);
    expect(first.webdavEndpoint).not.toBe(second.webdavEndpoint);
    expect(first.dataDir).not.toBe(second.dataDir);
    const [a, b] = await Promise.all([script(first), script(second)]);
    expect(b).toEqual(a);
    expect(second.requests()).toEqual(first.requests());
    expect(second.snapshot()).toEqual(first.snapshot());
  });

  it('reset restores the seed, the logical clock, counters and clears faults', async () => {
    const service = await start('basic');
    const before = service.snapshot();
    const firstRun = await script(service);
    const firstLog = service.requests();
    service.setFaults([{ service: 's3', respond: { status: 500 } }]);
    service.reset();
    expect(service.snapshot()).toEqual(before);
    expect(service.requests()).toEqual([]);
    expect(await script(service)).toEqual(firstRun);
    expect(service.requests()).toEqual(firstLog);

    service.reset('empty');
    expect(service.seedName).toBe('empty');
    expect(service.snapshot()).toEqual({ webdav: { dirs: [], objects: [] }, s3: { objects: [], uploads: [] } });
    expect(() => service.reset('nope')).toThrow(/unknown cloud seed/);
  });

  it('stop frees every port and removes the private data directory', async () => {
    const service = await startCloudService({ seed: 'basic' });
    const ports = [service.webdavEndpoint, service.s3Endpoint, service.controlUrl].map(url => Number(new URL(url).port));
    expect(existsSync(`${service.dataDir}/requests.jsonl`)).toBe(true);
    await service.stop();
    expect(existsSync(service.dataDir)).toBe(false);
    for (const port of ports) expect(await portIsFree(port)).toBe(true);
  });

  it('builds cloud_config_publish payloads and resolves scenario endpoint placeholders', async () => {
    const service = await start('basic');
    expect(service.config('webdav')).toEqual({
      publish: {
        config: { provider: 'webdav', webdav: { endpoint: service.webdavEndpoint, username: WEBDAV_USERNAME }, root: 'wave0' },
        credentials: { webdavPassword: WEBDAV_PASSWORD },
        encryptionPasswordIsPreexisting: false,
      },
      runtime: { provider: 'webdav', webdav: { endpoint: service.webdavEndpoint, username: WEBDAV_USERNAME, password: '' }, root: 'wave0' },
    });
    const s3Config = service.config('s3');
    expect(s3Config.publish.credentials).toEqual({ s3SecretAccessKey: S3_SECRET_ACCESS_KEY });
    expect(JSON.stringify(s3Config.publish.config)).not.toContain('secret');
    expect(s3Config.runtime).toMatchObject({ provider: 's3', s3: { secretAccessKey: '', pathStyle: true } });
    expect(service.resolve({ a: ['${cloud.webdav.endpoint}x', { b: '${cloud.s3.endpoint}' }], n: 1 }))
      .toEqual({ a: [`${service.webdavEndpoint}x`, { b: service.s3Endpoint }], n: 1 });
  });

  it('exposes state, faults, reset and requests over the control API', async () => {
    const service = await start('basic');
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${service.controlUrl}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    expect((await call('POST', '/__cloud/faults', { faults: [{ service: 'webdav', method: 'GET', respond: { status: 500 } }] })).json)
      .toEqual({ faults: 1 });
    const storage = webdav(service);
    expect(dec(await storage.get('docs/a.txt'))).toBe('alpha');
    expect((await call('GET', '/__cloud/requests')).json.map((entry: { status: number }) => entry.status)).toEqual([500, 200]);
    expect((await call('POST', '/__cloud/reset', { seed: 's3-paged' })).json).toEqual({ seed: 's3-paged' });
    const state = (await call('GET', '/__cloud/state')).json;
    expect(state).toMatchObject({ seed: 's3-paged', requests: 0, webdav: service.webdavEndpoint, s3: service.s3Endpoint });
    expect(state.snapshot.s3.objects).toHaveLength(5);
    expect((await call('POST', '/__cloud/reset', { seed: 'nope' })).status).toBe(400);
    expect((await call('GET', '/__cloud/unknown')).status).toBe(404);
  });
});

describe('CLI process', () => {
  const runCli = (args: string[]) => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', SERVICE, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = (child: ReturnType<typeof runCli>): { next(): Promise<any>; stderr(): string } => {
    let buffer = '';
    let stderr = '';
    const queue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line); else queue.push(line);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    return {
      next: () => new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) { resolve(JSON.parse(queued)); return; }
        const onExit = (): void => reject(new Error(`CLI exited early: ${stderr}`));
        child.once('exit', onExit);
        waiters.push(line => { child.off('exit', onExit); resolve(JSON.parse(line)); });
      }),
      stderr: () => stderr,
    };
  };

  const exited = (child: ReturnType<typeof runCli>): Promise<number | null> =>
    new Promise(resolve => { child.once('exit', code => resolve(code)); });

  it('starts, serves, prints the transcript on SIGTERM and cleans its data directory', async () => {
    const child = runCli(['--seed', 'basic']);
    const out = lines(child);
    const ready = await out.next();
    expect(ready).toMatchObject({ seed: 'basic', seeds: ['empty', 'basic', 's3-paged'] });
    expect(existsSync(ready.dataDir)).toBe(true);
    const res = await fetch(`${ready.webdav}wave0/docs/a.txt`, {
      headers: { authorization: `Basic ${Buffer.from(`${WEBDAV_USERNAME}:${WEBDAV_PASSWORD}`).toString('base64')}` },
    });
    expect(await res.text()).toBe('alpha');
    const done = exited(child);
    child.kill('SIGTERM');
    const stopped = await out.next();
    expect(stopped).toMatchObject({ stopped: true, requests: [{ seq: 0, method: 'GET', path: '/wave0/docs/a.txt', status: 200 }] });
    expect(await done).toBe(0);
    expect(existsSync(ready.dataDir)).toBe(false);
  });

  it('stops on stdin EOF', async () => {
    const child = runCli([]);
    const out = lines(child);
    const ready = await out.next();
    const done = exited(child);
    child.stdin!.end();
    expect(await out.next()).toEqual({ stopped: true, requests: [] });
    expect(await done).toBe(0);
    expect(existsSync(ready.dataDir)).toBe(false);
  });
});

describe('cloud.scenarios.json (WAVE0 §3 v0)', () => {
  const file = JSON.parse(readFileSync(SCENARIOS, 'utf8')) as {
    domain: string;
    commands: string[];
    scenarios: Array<{
      id: string;
      seed: string;
      cloud?: { seed: string; faults?: unknown[] };
      steps: Array<{ cmd: string; args: Record<string, unknown>; expect?: string }>;
      capture: { events: boolean; db: string[] };
      normalize: unknown[];
    }>;
  };

  it('has unique ids, declared commands, backward step references and write captures', async () => {
    const ids = file.scenarios.map(scenario => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    const used = new Set<string>();
    for (const scenario of file.scenarios) {
      expect(scenario.normalize).toEqual([]);
      expect(scenario.capture).toEqual({ events: true, db: ['*'] });
      scenario.steps.forEach((step, index) => {
        used.add(step.cmd);
        for (const match of JSON.stringify(step.args).matchAll(/\$\{(\d+)\./g)) {
          expect(Number(match[1]), `${scenario.id} step ${index}`).toBeLessThan(index);
        }
      });
    }
    expect([...used].sort()).toEqual([...file.commands].sort());
  });

  it('only uses cloud seeds and faults the service accepts', async () => {
    const service = await start('empty');
    for (const scenario of file.scenarios) {
      expect(scenario.cloud, scenario.id).toBeDefined();
      service.reset(scenario.cloud!.seed);
      service.setFaults((scenario.cloud!.faults ?? []) as never);
      const resolved = JSON.stringify(service.resolve(scenario.steps));
      expect(resolved, scenario.id).not.toContain('${cloud.');
    }
  });
});
