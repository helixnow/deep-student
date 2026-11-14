/**
 * tauri-plugin-updater 2.10.0 的 Electron 实现。
 *
 * 语义来源（只读）：
 * - `updater.rs::Updater::check`：endpoints 逐个尝试、`Accept: application/json`、
 *   204 视为无更新、静态 `platforms` / 动态 `url+signature` 两种 latest.json、
 *   `{{current_version}}`/`{{target}}`/`{{arch}}`/`{{bundle_type}}` 替换；
 * - `updater.rs::Update::download`：`Accept: application/octet-stream`、Started/Progress/Finished
 *   事件在签名校验前发送、minisign 外层 base64 + `trusted comment` 校验；
 * - `updater.rs::Update::install`：见 updater-install.ts。
 */
import { STATUS_CODES } from 'node:http';
import { ProxyAgent, fetch, type Dispatcher } from 'undici';
import { describeUnexpected, optInteger, optString, reqChannel, reqInteger, type InvokeInput } from './args.ts';
import { ShellCommandError } from './errors.ts';
import { verifyMinisign } from './minisign.ts';
import type { BuiltinPlugin, CommandContext, Resource } from './runtime.ts';
import type { EffectiveTauriConfig, ShellPlatform, TauriUpdaterConfig } from './tauri-config.ts';
import { installPackage } from './updater-install.ts';

const USER_AGENT = 'tauri-plugin-updater/2.10.0';
const DEFAULT_TIMEOUT = null;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly string[];
  readonly build: readonly string[];
  readonly text: string;
}

export function parseVersion(input: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(input);
  if (!match) throw new ShellCommandError(`unexpected character in version ${JSON.stringify(input)}`);
  const major = match[1]!, minor = match[2]!, patch = match[3]!;
  for (const part of [major, minor, patch]) {
    if (part.length > 1 && part.startsWith('0')) throw new ShellCommandError(`invalid leading zero in version ${JSON.stringify(input)}`);
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: (() => {
      const pre = match[4] === undefined ? [] : match[4].split('.');
      for (const identifier of pre) {
        if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
          throw new ShellCommandError(`invalid leading zero in pre-release identifier ${JSON.stringify(input)}`);
        }
      }
      return pre;
    })(),
    build: match[5] === undefined ? [] : match[5].split('.'),
    text: input,
  };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i], right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return Math.sign(diff);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** `semver::Version` 的优先级比较（build metadata 不参与）。 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = a[key] - b[key];
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(a.pre, b.pre);
}

export function versionText(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}${version.pre.length ? `-${version.pre.join('.')}` : ''}${version.build.length ? `+${version.build.join('.')}` : ''}`;
}

function sameVersion(a: ParsedVersion, b: ParsedVersion): boolean {
  return compareVersions(a, b) === 0 && a.build.join('.') === b.build.join('.');
}

interface ReleasePlatform {
  readonly url: string;
  readonly signature: string;
}

export type ReleaseSource =
  | { readonly kind: 'dynamic'; readonly platform: ReleasePlatform }
  | { readonly kind: 'platforms'; readonly platforms: ReadonlyMap<string, ReleasePlatform> };

export interface RemoteRelease {
  readonly version: ParsedVersion;
  readonly notes: string | null;
  readonly pubDate: string | null;
  readonly source: ReleaseSource;
  readonly rawJson: unknown;
}

function typeProblem(value: unknown, expected: string): ShellCommandError {
  return new ShellCommandError(`invalid type: ${describeUnexpected(value)}, expected ${expected}`);
}

function parseUrl(value: unknown): string {
  if (typeof value !== 'string') throw typeProblem(value, 'a string');
  try {
    new URL(value);
  } catch {
    throw new ShellCommandError('relative URL without a base');
  }
  return value;
}

/** `ReleaseManifestPlatform`（derive Deserialize：两个字段都必填）。 */
function readReleasePlatform(value: unknown): ReleasePlatform {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw typeProblem(value, 'struct ReleaseManifestPlatform');
  const record = value as Record<string, unknown>;
  if (!('url' in record)) throw new ShellCommandError('missing field `url`');
  if (!('signature' in record)) throw new ShellCommandError('missing field `signature`');
  return { url: parseUrl(record.url), signature: mustString(record.signature) };
}

function mustString(value: unknown): string {
  if (typeof value !== 'string') throw typeProblem(value, 'a string');
  return value;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(year: number, month: number): number {
  if (month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return 29;
  return DAYS[month - 1]!;
}

/**
 * `OffsetDateTime::parse(.., Rfc3339)` + `format(&Rfc3339)`：分隔符可以是任意单字节，
 * 小数秒右补零到 9 位后按 time crate 的规则输出最短表示；±00:00 输出 `Z`。
 */
function formatRfc3339(value: string): string {
  const invalid = () => new ShellCommandError(`invalid value for \`pub_date\`: the input is not a valid RFC 3339 date`);
  const match = /^(\d{4})-(\d{2})-(\d{2})[\s\S](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw invalid();
  if (hour > 23 || minute > 59 || second > 59) throw invalid();
  const fraction = match[7] ?? '';
  const nanos = Number((fraction + '000000000').slice(0, 9));
  const zone =
    match[8] !== undefined
      ? 'Z'
      : (() => {
          const offsetHour = Number(match[10]);
          const offsetMinute = Number(match[11]);
          if (offsetHour > 23 || offsetMinute > 59) throw invalid();
          return offsetHour === 0 && offsetMinute === 0 ? 'Z' : `${match[9]}${match[10]}:${match[11]}`;
        })();
  const subsecond = nanos === 0 ? '' : `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}`;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${subsecond}${zone}`;
}

/** `RemoteRelease::deserialize`：`version` 允许前导 v，`pub_date` 必须是 RFC3339。 */
export function parseReleaseJson(raw: unknown): RemoteRelease {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw typeProblem(raw, 'struct RemoteRelease');
  const record = raw as Record<string, unknown>;
  const hasVersion = 'version' in record;
  if (!hasVersion && !('name' in record)) throw new ShellCommandError('missing field `version`');
  const version = parseVersion(mustString(hasVersion ? record.version : record.name).replace(/^v+/, ''));
  const notes = record.notes === undefined || record.notes === null ? null : mustString(record.notes);
  const rawDate = record.pub_date;
  if (rawDate !== undefined && rawDate !== null && typeof rawDate !== 'string') throw typeProblem(rawDate, 'a string');
  const pubDate = typeof rawDate === 'string' ? formatRfc3339(rawDate) : null;
  if (record.platforms !== undefined && record.platforms !== null) {
    if (typeof record.platforms !== 'object' || Array.isArray(record.platforms)) throw typeProblem(record.platforms, 'a map');
    const platforms = new Map<string, ReleasePlatform>();
    for (const [target, platform] of Object.entries(record.platforms as Record<string, unknown>)) platforms.set(target, readReleasePlatform(platform));
    return { version, notes, pubDate, source: { kind: 'platforms', platforms }, rawJson: raw };
  }
  if (!('url' in record)) throw new ShellCommandError('the `url` field was not set on the updater response');
  if (!('signature' in record)) throw new ShellCommandError('the `signature` field was not set on the updater response');
  return {
    version,
    notes,
    pubDate,
    source: { kind: 'dynamic', platform: { url: parseUrl(record.url), signature: mustString(record.signature) } },
    rawJson: raw,
  };
}

function updaterOs(platform: ShellPlatform): string {
  return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
}

function updaterArch(arch: string): string {
  switch (arch) {
    case 'x64': return 'x86_64';
    case 'ia32': return 'i686';
    case 'arm': return 'armv7';
    case 'arm64': return 'aarch64';
    case 'riscv64': return 'riscv64';
    default: throw new ShellCommandError('Unsupported application architecture, expected one of `x86`, `x86_64`, `arm` or `aarch64`.');
  }
}

function installerFor(platform: ShellPlatform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return 'app';
  if (platform === 'win32') return 'nsis';
  return env.APPIMAGE !== undefined ? 'appimage' : 'deb';
}

function targetCandidates(platform: ShellPlatform, arch: string, installer: string): string[] {
  const os = updaterOs(platform);
  return [`${os}-${arch}-${installer}`, `${os}-${arch}`];
}

function downloadFor(release: RemoteRelease, target: string | null, candidates: string[]): ReleasePlatform {
  if (release.source.kind === 'dynamic') return release.source.platform;
  if (target !== null) {
    const platform = release.source.platforms.get(target);
    if (!platform) throw new ShellCommandError(`the platform \`${target}\` was not found in the response \`platforms\` object`);
    return platform;
  }
  for (const candidate of candidates) {
    const platform = release.source.platforms.get(candidate);
    if (platform) return platform;
  }
  throw new ShellCommandError(`None of the fallback platforms \`[${candidates.map((candidate) => JSON.stringify(candidate)).join(', ')}]\` were found in the response \`platforms\` object`);
}

interface RequestOptions {
  readonly accept: string;
  readonly headers: Headers;
  readonly timeout: number | null;
  readonly proxy: string | null;
}

interface Fetched {
  readonly response: Awaited<ReturnType<typeof fetch>>;
  readonly dispatcher: Dispatcher | null;
}

async function request(url: string, options: RequestOptions): Promise<Fetched> {
  const headers = new Headers(options.headers);
  if (!headers.has('accept')) headers.set('accept', options.accept);
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
  let dispatcher: Dispatcher | null = null;
  if (options.proxy !== null) {
    let proxy: URL;
    try {
      proxy = new URL(options.proxy);
    } catch {
      throw new ShellCommandError('relative URL without a base');
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new ShellCommandError('unsupported proxy scheme');
    dispatcher = new ProxyAgent(proxy.href);
  }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: [...headers],
      redirect: 'follow',
      ...(dispatcher !== null ? { dispatcher } : {}),
      ...(timeout !== null ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    return { response, dispatcher };
  } catch (error) {
    if (dispatcher !== null) await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

async function closeFetched(fetched: Fetched): Promise<void> {
  // Error responses and abandoned downloads must not keep the connection busy.
  // ProxyAgent.close() waits for active responses, so cancel before closing it.
  await fetched.response.body?.cancel().catch(() => undefined);
  if (fetched.dispatcher !== null) await fetched.dispatcher.close().catch(() => undefined);
}

function endpointUrl(endpoint: string, version: string, target: string, arch: string, installer: string): string {
  const encoded = encodeURIComponent(version).replace(/%2B/g, '%2B');
  return endpoint
    .replace(/%7B%7Bcurrent_version%7D%7D/gi, encoded)
    .replace(/%7B%7Btarget%7D%7D/gi, target)
    .replace(/%7B%7Barch%7D%7D/gi, arch)
    .replace(/%7B%7Bbundle_type%7D%7D/gi, installer)
    .replace(/\{\{current_version\}\}/g, encoded)
    .replace(/\{\{target\}\}/g, target)
    .replace(/\{\{arch\}\}/g, arch)
    .replace(/\{\{bundle_type\}\}/g, installer);
}

export interface CheckOptions {
  readonly headers: Headers;
  readonly timeout: number | null;
  readonly proxy: string | null;
  readonly target: string | null;
  readonly allowDowngrades: boolean;
}

export interface CheckedUpdate {
  readonly currentVersion: string;
  readonly version: string;
  readonly date: string | null;
  readonly body: string | null;
  readonly rawJson: unknown;
  readonly downloadUrl: string;
  readonly signature: string;
  readonly headers: Headers;
  readonly proxy: string | null;
}

/** 由 Electron main 注入的应用信息（安装器需要进程路径、参数与退出钩子）。 */
export interface UpdaterApp {
  readonly appName: string;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  exit(code: number): void;
}

export interface UpdaterRuntime extends UpdaterApp {
  readonly platform: ShellPlatform;
  readonly arch: string;
  readonly version: string;
  readonly debug: boolean;
  readonly updater: TauriUpdaterConfig;
}

/** `Updater::check`：endpoints 顺序尝试；只有成功解析的响应会清除 last_error。 */
export async function checkForUpdate(runtime: UpdaterRuntime, options: CheckOptions): Promise<CheckedUpdate | null> {
  if (runtime.updater.endpoints.length === 0) throw new ShellCommandError('Updater does not have any endpoints set.');
  if (!runtime.debug) {
    for (const endpoint of runtime.updater.endpoints) {
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        throw new ShellCommandError(`relative URL without a base: ${JSON.stringify(endpoint)}`);
      }
      if (parsed.protocol !== 'https:') throw new ShellCommandError('The configured updater endpoint must use a secure protocol like `https`.');
    }
  }
  const arch = updaterArch(runtime.arch);
  const target = options.target ?? updaterOs(runtime.platform);
  const installer = installerFor(runtime.platform, runtime.env);
  let release: RemoteRelease | null = null;
  let lastError: unknown = null;
  for (const endpoint of runtime.updater.endpoints) {
    let fetched: Fetched;
    try {
      fetched = await request(endpointUrl(endpoint, runtime.version, target, arch, installer), {
        accept: 'application/json',
        headers: options.headers,
        timeout: options.timeout,
        proxy: options.proxy,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      if (fetched.response.status === 204) return null;
      if (!fetched.response.ok) continue;
      let json: unknown;
      try {
        json = await fetched.response.json();
      } catch {
        throw new ShellCommandError('error decoding response body');
      }
      try {
        release = parseReleaseJson(json);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    } finally {
      await closeFetched(fetched);
    }
  }
  if (lastError !== null) throw lastError;
  if (release === null) throw new ShellCommandError('Could not fetch a valid release JSON from the remote');
  const current = parseVersion(runtime.version);
  const shouldUpdate = options.allowDowngrades ? !sameVersion(release.version, current) : compareVersions(release.version, current) > 0;
  const selected = downloadFor(release, options.target, targetCandidates(runtime.platform, arch, installer));
  if (!shouldUpdate) return null;
  return {
    currentVersion: runtime.version,
    version: versionText(release.version),
    date: release.pubDate,
    body: release.notes,
    rawJson: release.rawJson,
    downloadUrl: selected.url,
    signature: selected.signature,
    headers: options.headers,
    proxy: options.proxy,
  };
}

class UpdateResource implements Resource {
  readonly update: CheckedUpdate;
  constructor(update: CheckedUpdate) { this.update = update; }
  close(): void {}
}

class DownloadedBytesResource implements Resource {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  close(): void {}
}

function isUpdateResource(resource: Resource): resource is UpdateResource {
  return resource instanceof UpdateResource;
}

function isBytesResource(resource: Resource): resource is DownloadedBytesResource {
  return resource instanceof DownloadedBytesResource;
}

export interface DownloadEvents {
  started(contentLength: number | null): void;
  progress(chunkLength: number): void;
  finished(): void;
}

/** `Update::download`：成功后校验 minisign；事件在校验前按 Rust 顺序发送。 */
export async function downloadPackage(update: CheckedUpdate, pubkey: string, events: DownloadEvents, headers: Headers, timeout: number | null): Promise<Uint8Array> {
  const fetched = await request(update.downloadUrl, {
    accept: 'application/octet-stream',
    headers,
    timeout,
    proxy: update.proxy,
  });
  try {
    if (!fetched.response.ok) {
      const status = fetched.response.status;
      const reason = STATUS_CODES[status] ?? '<unknown status code>';
      throw new ShellCommandError(`Download request failed with status: ${status} ${reason}`);
    }
    const rawLength = fetched.response.headers.get('content-length') ?? '';
    const total = /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const chunks: Uint8Array[] = [];
    let first = true;
    let size = 0;
    const body = fetched.response.body;
    if (body !== null) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (first) { first = false; events.started(total); }
          events.progress(value.length);
          chunks.push(value);
          size += value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    events.finished();
    const bytes = Buffer.concat(chunks, size);
    verifyMinisign(bytes, update.signature, pubkey);
    return bytes;
  } finally {
    await closeFetched(fetched);
  }
}

function updaterConfig(ctx: CommandContext): TauriUpdaterConfig {
  const updater = ctx.runtime.config.updater;
  if (!updater) throw new ShellCommandError('Updater does not have any endpoints set.');
  return updater;
}

function updaterRuntime(ctx: CommandContext, app: UpdaterApp): UpdaterRuntime {
  return {
    ...app,
    platform: ctx.runtime.platform,
    arch: process.arch,
    version: ctx.runtime.config.version,
    debug: ctx.runtime.debug,
    updater: updaterConfig(ctx),
  };
}

function sendEvent(ctx: CommandContext, channel: number, event: unknown): void {
  ctx.runtime.sendChannel(ctx.webviewLabel, channel, event);
}

function timeoutOf(input: InvokeInput): number | null {
  return optInteger(input, 'timeout', 'u64');
}

function targetOf(input: InvokeInput): string | null {
  return optString(input, 'target');
}

/**
 * RUST-FIX(RF-W23-updater-ignore-page-options)：页面传入的 `allowDowngrades`、`proxy`、`headers` 不生效
 * （Rust 插件照单全收）：降级安装旧的已签名版本、经页面指定的代理取更新、向更新服务器附加任意请求头都只该由
 * 应用自身决定。检查与下载一律用空请求头、直连、只接受更高版本；`timeout` 与 `target` 仍按页面参数。
 */
export function updaterPlugin(app: UpdaterApp): BuiltinPlugin {
  return {
    check: async (input, ctx) => {
      const update = await checkForUpdate(updaterRuntime(ctx, app), {
        headers: new Headers(),
        timeout: timeoutOf(input),
        proxy: null,
        target: targetOf(input),
        allowDowngrades: false,
      });
      if (update === null) return null;
      const rid = ctx.runtime.addResource(ctx.webviewLabel, new UpdateResource(update));
      return {
        rid,
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body,
        rawJson: update.rawJson,
      };
    },
    download: async (input, ctx) => {
      const rid = reqInteger(input, 'rid', 'u32');
      const update = ctx.runtime.getResource(ctx.webviewLabel, rid, isUpdateResource).update;
      const channel = reqChannel(input, 'onEvent');
      const bytes = await downloadPackage(
        update,
        updaterConfig(ctx).pubkey,
        {
          started: (contentLength) => sendEvent(ctx, channel, { event: 'Started', data: { contentLength } }),
          progress: (chunkLength) => sendEvent(ctx, channel, { event: 'Progress', data: { chunkLength } }),
          finished: () => sendEvent(ctx, channel, { event: 'Finished' }),
        },
        update.headers,
        timeoutOf(input),
      );
      return ctx.runtime.addResource(ctx.webviewLabel, new DownloadedBytesResource(bytes));
    },
    install: async (input, ctx) => {
      const updateRid = reqInteger(input, 'updateRid', 'u32');
      const bytesRid = reqInteger(input, 'bytesRid', 'u32');
      const update = ctx.runtime.getResource(ctx.webviewLabel, updateRid, isUpdateResource).update;
      const bytes = ctx.runtime.getResource(ctx.webviewLabel, bytesRid, isBytesResource).bytes;
      await installPackage(update, bytes, updaterRuntime(ctx, app));
      await ctx.runtime.closeResource(ctx.webviewLabel, bytesRid).catch(() => undefined);
      return null;
    },
    download_and_install: async (input, ctx) => {
      const rid = reqInteger(input, 'rid', 'u32');
      const update = ctx.runtime.getResource(ctx.webviewLabel, rid, isUpdateResource).update;
      const channel = reqChannel(input, 'onEvent');
      const bytes = await downloadPackage(
        update,
        updaterConfig(ctx).pubkey,
        {
          started: (contentLength) => sendEvent(ctx, channel, { event: 'Started', data: { contentLength } }),
          progress: (chunkLength) => sendEvent(ctx, channel, { event: 'Progress', data: { chunkLength } }),
          finished: () => sendEvent(ctx, channel, { event: 'Finished' }),
        },
        update.headers,
        timeoutOf(input),
      );
      await installPackage(update, bytes, updaterRuntime(ctx, app));
      return null;
    },
  };
}
