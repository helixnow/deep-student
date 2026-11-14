/**
 * tauri-plugin-updater 2.10.0 语义测试：latest.json 解析、target 选择、endpoint 轮询、
 * semver 比较、下载事件与 minisign 校验。安装器只在本机替换应用，不在测试中执行。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import {
  checkForUpdate,
  compareVersions,
  downloadPackage,
  parseReleaseJson,
  parseVersion,
  versionText,
  type CheckedUpdate,
  type UpdaterRuntime,
} from '../shell/updater.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function runtime(overrides: Partial<UpdaterRuntime> = {}): UpdaterRuntime {
  return {
    appName: 'DeepStudent',
    execPath: '/tmp/DeepStudent',
    argv: ['/tmp/DeepStudent'],
    env: {},
    exit: () => undefined,
    platform: 'linux',
    arch: 'x64',
    version: '1.0.0',
    debug: true,
    updater: { endpoints: [], pubkey: 'unused' },
    ...overrides,
  };
}

const options = (overrides: Partial<Parameters<typeof checkForUpdate>[1]> = {}) => ({
  headers: new Headers(),
  timeout: null,
  proxy: null,
  target: null,
  allowDowngrades: false,
  ...overrides,
});

const release = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

it('cancels an unfinished download when a progress callback throws', async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const base = await listen((_request, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('first chunk'); // Intentionally never end: only cancellation can release it.
  });
  const update: CheckedUpdate = { currentVersion: '1.0.0', version: '2.0.0', date: null, body: null,
    rawJson: {}, downloadUrl: base, signature: 'unused', headers: new Headers(), proxy: null };
  await expect(downloadPackage(update, 'unused', {
    started() {}, progress() { throw new Error('renderer closed'); }, finished() {},
  }, new Headers(), null)).rejects.toThrow('renderer closed');
  await disconnected;
}, 5000);

it('cancels an unfinished HTTP error body before trying the next endpoint', async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const base = await listen((request, response) => {
    if (request.url === '/error') {
      response.on('close', closed);
      response.writeHead(503);
      response.write('busy');
    } else response.writeHead(204).end();
  });
  expect(await checkForUpdate(runtime({ updater: { endpoints: [`${base}/error`, `${base}/none`], pubkey: 'unused' } }), options())).toBeNull();
  await disconnected;
}, 5000);

it('parse_version_strips_leading_v_and_accepts_the_name_alias', () => {
  const parsed = parseReleaseJson({ name: 'v1.2.3-rc.1+build.5', url: 'https://example.com/app', signature: 'sig' });
  expect(versionText(parsed.version)).toBe('1.2.3-rc.1+build.5');
  expect(parsed.version.pre).toEqual(['rc', '1']);
  expect(parsed.version.build).toEqual(['build', '5']);
  expect(() => parseReleaseJson({ version: '1.2', url: 'https://example.com/app', signature: 'sig' })).toThrow(/unexpected character/);
  expect(() => parseReleaseJson({ version: '1.0.0-01', url: 'https://example.com/app', signature: 'sig' })).toThrow(/leading zero/);
});

it('semver comparison ignores build metadata and orders pre-releases like the semver crate', () => {
  const compare = (left: string, right: string) => compareVersions(parseVersion(left), parseVersion(right));
  expect(compare('1.0.0', '1.0.0')).toBe(0);
  expect(compare('1.0.0+2', '1.0.0+1')).toBe(0);
  expect(compare('1.0.0-rc.1', '1.0.0')).toBe(-1);
  expect(compare('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
  expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  expect(compare('2.0.0', '10.0.0')).toBe(-1);
});

it('parseReleaseJson handles static platforms, dynamic url+signature and pub_date formatting', () => {
  const raw = {
    version: 'v2.0.0',
    notes: 'notes',
    pub_date: '2025-01-02T03:04:05.120Z',
    platforms: { 'linux-x86_64-deb': { url: 'https://example.com/app.deb', signature: 'sig' } },
  };
  const staticRelease = parseReleaseJson(raw);
  expect(staticRelease.source.kind).toBe('platforms');
  expect(staticRelease.pubDate).toBe('2025-01-02T03:04:05.12Z');
  expect(staticRelease.rawJson).toBe(raw);

  const dynamic = parseReleaseJson({ name: '1.0.0', url: 'https://example.com/app', signature: 'sig', pub_date: '2025-01-02 03:04:05z' });
  expect(dynamic.source.kind).toBe('dynamic');
  expect(dynamic.pubDate).toBe('2025-01-02T03:04:05Z');

  expect(() => parseReleaseJson({ version: '1.0.0', signature: 'sig' })).toThrow('the `url` field was not set on the updater response');
  expect(() => parseReleaseJson({ version: '1.0.0', url: 'https://example.com/app' })).toThrow('the `signature` field was not set on the updater response');
  expect(() => parseReleaseJson({ version: '1.0.0', platforms: { target: { url: 'https://example.com/app' } } }))
    .toThrow('missing field `signature`');
});

it('pub_date uses Rfc3339 minute offsets and rejects impossible calendar dates', () => {
  const date = (value: string) => parseReleaseJson({ version: '1.0.0', url: 'https://example.com/app', signature: 'sig', pub_date: value }).pubDate;
  expect(date('2025-01-02T03:04:05.0500000000+05:30')).toBe('2025-01-02T03:04:05.05+05:30');
  expect(date('2025-01-02T03:04:05-00:00')).toBe('2025-01-02T03:04:05Z');
  expect(date('2024-02-29T00:00:00.100+08:00')).toBe('2024-02-29T00:00:00.1+08:00');
  expect(() => date('2025-02-30T00:00:00Z')).toThrow('invalid value for `pub_date`');
  expect(() => date('2025-01-02T24:00:00Z')).toThrow('invalid value for `pub_date`');
});

it('check_treats_204_as_no_update_without_requesting_later_endpoints', async () => {
  const hits: string[] = [];
  const base = await listen((request, response) => {
    hits.push(request.url ?? '');
    if (request.url === '/none') {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(500).end();
  });
  const update = await checkForUpdate(
    runtime({ updater: { endpoints: [`${base}/none`, `${base}/later`], pubkey: 'unused' } }),
    options(),
  );
  expect(update).toBeNull();
  expect(hits).toEqual(['/none']);
});

it('check_falls_back_after_http_and_deserialization_errors_but_not_after_invalid_json', async () => {
  const base = await listen((request, response) => {
    if (request.url === '/bad-shape') release({ version: 42 }).arrayBuffer().then((body) => response.writeHead(200).end(Buffer.from(body)), () => response.writeHead(500).end());
    else if (request.url === '/invalid-json') response.writeHead(200, { 'content-type': 'application/json' }).end('not json');
    else if (request.url === '/error') response.writeHead(500).end();
    else release({ version: '2.0.0', url: `${base}/pkg`, signature: 'sig' }).arrayBuffer().then((body) => response.writeHead(200).end(Buffer.from(body)), () => response.writeHead(500).end());
  });
  const check = (paths: string[]) => checkForUpdate(runtime({ updater: { endpoints: paths.map((path) => `${base}${path}`), pubkey: 'unused' } }), options());

  const afterHttpError = await check(['/error', '/ok']);
  expect(afterHttpError?.version).toBe('2.0.0');

  const afterShapeError = await check(['/bad-shape', '/ok']);
  expect(afterShapeError?.version).toBe('2.0.0');

  await expect(check(['/invalid-json', '/ok'])).rejects.toThrow('error decoding response body');
  await expect(check(['/error'])).rejects.toThrow('Could not fetch a valid release JSON from the remote');
  await expect(check(['/bad-shape'])).rejects.toThrow('invalid type: integer `42`, expected a string');
});

it('check_treats_204_after_a_previous_error_as_no_update', async () => {
  const base = await listen((request, response) => {
    if (request.url === '/none') response.writeHead(204).end();
    else response.writeHead(500).end();
  });
  const update = await checkForUpdate(runtime({ updater: { endpoints: [`${base}/error`, `${base}/none`], pubkey: 'unused' } }), options());
  expect(update).toBeNull();
});

it('check_substitutes_target_arch_and_version_and_uses_the_installer_first_platform', async () => {
  let seen: { url?: string; accept?: string; agent?: string } = {};
  const base = await listen((request, response) => {
    seen = { url: request.url, accept: request.headers.accept, agent: request.headers['user-agent'] };
    release({
      version: '2.0.0',
      notes: 'release notes',
      pub_date: '2025-05-06T07:08:09Z',
      platforms: {
        'linux-x86_64-deb': { url: `${base}/by-installer`, signature: 'sig-deb' },
        'linux-x86_64': { url: `${base}/fallback`, signature: 'sig-fallback' },
      },
    }).arrayBuffer().then((body) => response.writeHead(200, { 'content-type': 'application/json' }).end(Buffer.from(body)));
  });
  const update = await checkForUpdate(
    runtime({ updater: { endpoints: [`${base}/{{target}}/{{arch}}/{{current_version}}`], pubkey: 'unused' } }),
    options(),
  );
  expect(seen.url).toBe('/linux/x86_64/1.0.0');
  expect(seen.accept).toBe('application/json');
  expect(seen.agent).toBe('tauri-plugin-updater/2.10.0');
  expect(update).toMatchObject({
    currentVersion: '1.0.0',
    version: '2.0.0',
    date: '2025-05-06T07:08:09Z',
    body: 'release notes',
    downloadUrl: `${base}/by-installer`,
    signature: 'sig-deb',
  });
  expect(update?.rawJson).toMatchObject({ version: '2.0.0' });
});

it('check_prefers_appimage_and_falls_back_to_the_generic_platform', async () => {
  const base = await listen((_request, response) => {
    release({
      version: '2.0.0',
      platforms: {
        'linux-x86_64-appimage': { url: `${base}/appimage`, signature: 'sig-appimage' },
        'linux-x86_64': { url: `${base}/fallback`, signature: 'sig-fallback' },
      },
    }).arrayBuffer().then((body) => response.writeHead(200).end(Buffer.from(body)));
  });
  const appimage = await checkForUpdate(
    runtime({ env: { APPIMAGE: '/home/user/DeepStudent.AppImage' }, updater: { endpoints: [base], pubkey: 'unused' } }),
    options({ target: null }),
  );
  expect(appimage?.downloadUrl).toBe(`${base}/appimage`);

  const fallback = await checkForUpdate(
    runtime({
      env: {},
      updater: {
        endpoints: [base],
        pubkey: 'unused',
      },
    }),
    options(),
  );
  expect(fallback?.downloadUrl).toBe(`${base}/fallback`);
});

it('check_honours_an_explicit_target_and_reports_missing_platforms', async () => {
  const base = await listen((_request, response) => {
    release({
      version: '2.0.0',
      platforms: { 'custom-target': { url: `${base}/custom`, signature: 'sig' } },
    }).arrayBuffer().then((body) => response.writeHead(200).end(Buffer.from(body)));
  });
  const update = await checkForUpdate(runtime({ updater: { endpoints: [base], pubkey: 'unused' } }), options({ target: 'custom-target' }));
  expect(update?.downloadUrl).toBe(`${base}/custom`);
  await expect(
    checkForUpdate(runtime({ updater: { endpoints: [base], pubkey: 'unused' } }), options({ target: 'missing' })),
  ).rejects.toThrow('the platform `missing` was not found in the response `platforms` object');
});

it('check_resolves_the_platform_even_when_no_update_is_available', async () => {
  const base = await listen((_request, response) => {
    release({ version: '2.0.0', platforms: {} }).arrayBuffer().then((body) => response.writeHead(200).end(Buffer.from(body)));
  });
  await expect(checkForUpdate(runtime({ updater: { endpoints: [base], pubkey: 'unused' } }), options())).rejects.toThrow(
    'None of the fallback platforms `["linux-x86_64-deb", "linux-x86_64"]` were found in the response `platforms` object',
  );
});

it('check_allowDowngrades_uses_full_version_equality', async () => {
  const base = await listen((_request, response) => {
    release({ version: '1.0.0+build.2', url: 'https://example.com/app', signature: 'sig' }).arrayBuffer()
      .then((body) => response.writeHead(200).end(Buffer.from(body)));
  });
  const current = runtime({ version: '1.0.0+build.1', updater: { endpoints: [base], pubkey: 'unused' } });
  expect(await checkForUpdate(current, options())).toBeNull();
  expect(await checkForUpdate(current, options({ allowDowngrades: true }))).toMatchObject({ version: '1.0.0+build.2' });

  const newerCurrent = runtime({ version: '2.0.0', updater: { endpoints: [base], pubkey: 'unused' } });
  expect(await checkForUpdate(newerCurrent, options())).toBeNull();
  expect(await checkForUpdate(newerCurrent, options({ allowDowngrades: true }))).toMatchObject({ version: '1.0.0+build.2' });
});

it('check_requires_endpoints_and_https_outside_development', async () => {
  await expect(checkForUpdate(runtime(), options())).rejects.toThrow('Updater does not have any endpoints set.');
  await expect(
    checkForUpdate(runtime({ debug: false, updater: { endpoints: ['http://127.0.0.1:1/latest.json'], pubkey: 'unused' } }), options()),
  ).rejects.toThrow('The configured updater endpoint must use a secure protocol like `https`.');
});

const key = 'untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
const signature = 'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==';
const encoded = (text: string) => Buffer.from(text).toString('base64');

function checkedUpdate(url: string, overrides: Partial<CheckedUpdate> = {}): CheckedUpdate {
  return {
    currentVersion: '1.0.0',
    version: '2.0.0',
    date: null,
    body: null,
    rawJson: {},
    downloadUrl: url,
    signature: encoded(signature),
    headers: new Headers(),
    proxy: null,
    ...overrides,
  };
}

function recorder() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    hooks: {
      started: (contentLength: number | null) => events.push({ event: 'Started', contentLength }),
      progress: (chunkLength: number) => events.push({ event: 'Progress', chunkLength }),
      finished: () => events.push({ event: 'Finished' }),
    },
  };
}

it('download_emits_started_progress_finished_before_signature_verification', async () => {
  const base = await listen((request, response) => {
    expect(request.headers.accept).toBe('application/octet-stream');
    expect(request.headers['user-agent']).toBe('tauri-plugin-updater/2.10.0');
    response.writeHead(200, { 'content-length': '4' });
    response.write('te');
    response.end('st');
  });
  const { events, hooks } = recorder();
  const bytes = await downloadPackage(checkedUpdate(`${base}/pkg`), encoded(key), hooks, new Headers(), null);
  expect(Buffer.from(bytes).toString()).toBe('test');
  expect(events[0]).toEqual({ event: 'Started', contentLength: 4 });
  expect(events.filter((event) => event.event === 'Progress').reduce((sum, event) => sum + Number(event.chunkLength), 0)).toBe(4);
  expect(events.at(-1)).toEqual({ event: 'Finished' });
});

it('download_rejects_a_bad_signature_after_finishing_the_event_stream', async () => {
  const base = await listen((_request, response) => {
    response.writeHead(200, { 'content-length': '7' }).end('changed');
  });
  const { events, hooks } = recorder();
  await expect(downloadPackage(checkedUpdate(`${base}/pkg`), encoded(key), hooks, new Headers(), null))
    .rejects.toThrow('The signature verification failed');
  expect(events.at(-1)).toEqual({ event: 'Finished' });
});

it('download_keeps_explicit_headers_and_reports_http_failures', async () => {
  let accept: string | undefined;
  const base = await listen((request, response) => {
    accept = request.headers.accept;
    if (request.url === '/missing') response.writeHead(404).end();
    else response.writeHead(200).end('test');
  });
  const { hooks } = recorder();
  await downloadPackage(checkedUpdate(`${base}/pkg`), encoded(key), hooks, new Headers({ accept: 'text/plain' }), null);
  expect(accept).toBe('text/plain');

  const failure = recorder();
  await expect(downloadPackage(checkedUpdate(`${base}/missing`), encoded(key), failure.hooks, new Headers(), null))
    .rejects.toThrow('Download request failed with status: 404 Not Found');
});
