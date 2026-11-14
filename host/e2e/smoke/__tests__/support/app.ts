/**
 * Launch the real desktop app (production `electron/main.ts` `start()`, preload, Host profile) under
 * Playwright with every user-data location redirected into a throwaway root.
 *
 * Isolation follows X1's `__fixtures__/window-driver.mjs`: `DS_APP_DATA_DIR` alone is not enough, the
 * Host derives its main log (`$HOME/Library/Logs/<id>`) and sync state
 * (`$HOME/Library/Application Support/deep-student/sync`) from `$HOME`, so HOME/TMPDIR/XDG and
 * Electron userData are redirected too and the key seed stays file-only (no system keychain).
 *
 * The Electron entry is X1's `__fixtures__/window-main.mjs`, which records the renderer/main/Host
 * wire into `<root>/wire.jsonl` without substituting any handler.
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../../../../..');
const windowMain = join(repoRoot, 'host/e2e/smoke/__fixtures__/window-main.mjs');
/** Unroutable proxy: any proxy-aware client that tries to leave the machine fails fast. */
const BLACKHOLE_PROXY = 'http://127.0.0.1:9';

export type InvokeOutcome =
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout'; timeoutMs: number };

export interface WireRow {
  seq: number;
  time: number;
  phase: string;
  kind: string;
  message?: Record<string, unknown>;
  level?: string;
  [key: string]: unknown;
}

export interface LaunchedApp {
  readonly root: string;
  readonly dataDir: string;
  readonly homeDir: string;
  /** Where the shell puts OS dirs (logs, sync state, Application Support) for this data root. */
  readonly osHomeDir: string;
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly launchMs: number;
  readonly pageErrors: Array<{ phase: string; message: string }>;
  /** External http(s) requests the renderer attempted (aborted). */
  readonly blockedRequests: string[];
  stdout(): string;
  stderr(): string;
  mark(phase: string): Promise<void>;
  invoke(cmd: string, args?: unknown, timeoutMs?: number): Promise<InvokeOutcome>;
  /** `invoke` that throws unless the command resolved. */
  call<T = unknown>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T>;
  wire(): WireRow[];
  mainLog(): string;
  close(): Promise<void>;
}

export function newRoot(label: string): string {
  const base = realpathSync(tmpdir());
  mkdirSync(join(base, 'ds-w12-smoke'), { recursive: true });
  return mkdtempSync(join(base, 'ds-w12-smoke', `${label}-`));
}

export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  for (const dir of ['home', 'tmp', 'data', 'config', 'cache', 'local', 'userdata', 'runtime']) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    XDG_DATA_HOME: join(root, 'local'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'local'),
    DS_APP_DATA_DIR: join(root, 'data'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
    DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1', DEEP_STUDENT_BUILD_NUMBER: process.env.DEEP_STUDENT_BUILD_NUMBER ?? '20000',
    X1_TRACE: join(root, 'wire.jsonl'),
    HTTP_PROXY: BLACKHOLE_PROXY, HTTPS_PROXY: BLACKHOLE_PROXY, ALL_PROXY: BLACKHOLE_PROXY,
    http_proxy: BLACKHOLE_PROXY, https_proxy: BLACKHOLE_PROXY, all_proxy: BLACKHOLE_PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1',
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DS_ELECTRON_DEV_URL', 'DS_HOST_ENTRY', 'DS_HOST_PROFILE', 'DS_ELECTRON_CAPTURE', 'X1_RECORD_PROCESS_HOOKS']) {
    delete env[key];
  }
  return env;
}

export function readWire(root: string): WireRow[] {
  const file = join(root, 'wire.jsonl');
  if (!existsSync(file)) return [];
  const rows: WireRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as WireRow);
    } catch {
      // The writer may be mid-line on the last row.
    }
  }
  return rows;
}

/** OS home the shell derives from `DS_APP_DATA_DIR` (`electron/shell/os-dirs.ts`: `<data>.os/home`). */
export function osHomeOf(root: string): string {
  return join(root, 'data.os', 'home');
}

export function findMainLog(root: string): string | null {
  const logs = join(osHomeOf(root), 'Library', 'Logs');
  if (!existsSync(logs)) return null;
  for (const name of readdirSync(logs)) {
    const file = join(logs, name, 'deep-student.log');
    if (existsSync(file)) return file;
  }
  return null;
}

export interface LaunchOptions {
  /** Reuse an existing root (relaunch on the same data). */
  root?: string;
  label?: string;
  env?: Record<string, string>;
  /** Electron/Chromium switches placed before the entry, e.g. `--js-flags=--expose-gc`. */
  electronArgs?: string[];
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const root = options.root ?? newRoot(options.label ?? 'app');
  const env = { ...isolatedEnv(root), ...options.env };
  if (!existsSync(join(repoRoot, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing: run `npx vite build` first (see host/e2e/smoke/W12-PROGRESS.md)');
  }
  if (!existsSync(join(repoRoot, 'electron', '.build', 'preload.cjs'))) {
    throw new Error('electron/.build/preload.cjs missing: run `node electron/scripts/build-preload.mjs` first');
  }
  const started = performance.now();
  const require = createRequire(import.meta.url);
  const app = await _electron.launch({
    // boundary-allow native-import: the electron package only yields the binary path Playwright launches; no Electron API is used here.
    executablePath: require('electron') as string,
    args: [...(options.electronArgs ?? []), windowMain],
    cwd: root,
    env: env as Record<string, string>,
    timeout: 90_000,
  });
  let stdout = '';
  let stderr = '';
  const child = app.process();
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
  const blockedRequests: string[] = [];
  await app.context().route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/]|\[::1\])/, (route) => {
    blockedRequests.push(route.request().url());
    void route.abort('internetdisconnected');
  });
  const page = await app.firstWindow({ timeout: 90_000 });
  const launchMs = performance.now() - started;
  let phase = 'boot';
  const pageErrors: Array<{ phase: string; message: string }> = [];
  page.on('pageerror', (error) => pageErrors.push({ phase, message: `${error.message}\n${error.stack ?? ''}` }));

  const invoke = async (cmd: string, args: unknown = {}, timeoutMs = 15_000): Promise<InvokeOutcome> =>
    page.evaluate(async ({ cmd, args, timeoutMs }) => {
      const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        internals.invoke(cmd, args).then(
          (value) => ({ kind: 'result' as const, value: value === undefined ? null : value }),
          (error: unknown) => ({ kind: 'error' as const, error: error instanceof Error ? `${error.name}: ${error.message}` : error })),
        new Promise<{ kind: 'timeout'; timeoutMs: number }>((r) => { timer = setTimeout(() => r({ kind: 'timeout', timeoutMs }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      return outcome;
    }, { cmd, args, timeoutMs });

  const launched: LaunchedApp = {
    root,
    dataDir: join(root, 'data'),
    homeDir: join(root, 'home'),
    osHomeDir: osHomeOf(root),
    app,
    page,
    launchMs,
    pageErrors,
    blockedRequests,
    stdout: () => stdout,
    stderr: () => stderr,
    async mark(name) {
      phase = name;
      await app.evaluate((_electron, n) => (globalThis as unknown as { __x1Mark(n: string): number }).__x1Mark(n), name);
    },
    invoke,
    async call<T>(cmd: string, args: unknown = {}, timeoutMs = 15_000): Promise<T> {
      const outcome = await invoke(cmd, args, timeoutMs);
      if (outcome.kind !== 'result') throw new Error(`${cmd} did not resolve: ${JSON.stringify(outcome)}`);
      return outcome.value as T;
    },
    wire: () => readWire(root),
    mainLog() {
      const file = findMainLog(root);
      return file === null ? '' : readFileSync(file, 'utf8');
    },
    async close() {
      try {
        await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20_000))]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        writeFileSync(join(root, 'stdout.log'), stdout);
        writeFileSync(join(root, 'stderr.log'), stderr);
        writeFileSync(join(root, 'page-errors.json'), `${JSON.stringify(pageErrors, null, 2)}\n`);
        writeFileSync(join(root, 'blocked-requests.json'), `${JSON.stringify(blockedRequests, null, 2)}\n`);
      }
    },
  };
  return launched;
}

/** Wait until the renderer has issued no new invoke for `quietMs` (e.g. a page finished loading its settings). */
export async function waitForIpcIdle(app: LaunchedApp, quietMs = 1_000, timeoutMs = 20_000): Promise<void> {
  const invokes = () => app.wire().filter((r) => r.kind === 'renderer-invoke').length;
  const deadline = Date.now() + timeoutMs;
  let last = invokes();
  let since = Date.now();
  while (Date.now() < deadline) {
    await app.page.waitForTimeout(200);
    const now = invokes();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
  throw new Error(`renderer IPC did not go quiet for ${quietMs}ms within ${timeoutMs}ms`);
}

/** IPC calls from the wire trace, correlated by webContents + callback id (X1 `callsFromTrace`). */
export interface WireCall {
  phase: string;
  cmd: string;
  outcome: 'pending' | 'result' | 'error';
  body?: unknown;
}

export function callsFromWire(rows: readonly WireRow[]): WireCall[] {
  const pending = new Map<string, { call: WireCall; ok: boolean; other: string }>();
  const calls: WireCall[] = [];
  for (const row of rows) {
    const m = row.message as { type?: string; cmd?: string; callback?: number; error?: number; callbackId?: number; body?: unknown } | undefined;
    if (!m) continue;
    const wc = String(row.webContents);
    if (row.kind === 'renderer-invoke' && m.type === 'invoke' && typeof m.cmd === 'string') {
      const call: WireCall = { phase: row.phase, cmd: m.cmd, outcome: 'pending' };
      calls.push(call);
      pending.set(`${wc}:${m.callback}`, { call, ok: true, other: `${wc}:${m.error}` });
      pending.set(`${wc}:${m.error}`, { call, ok: false, other: `${wc}:${m.callback}` });
    } else if (row.kind === 'renderer-result' && m.type === 'result') {
      const key = `${wc}:${m.callbackId}`;
      const found = pending.get(key);
      if (found) {
        found.call.outcome = found.ok ? 'result' : 'error';
        found.call.body = m.body;
        pending.delete(key);
        pending.delete(found.other);
      }
    }
  }
  return calls;
}
