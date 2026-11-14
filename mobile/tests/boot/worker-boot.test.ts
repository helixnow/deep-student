/**
 * V06 §5.2 + V06-03：用 `mobile/vite.config.ts` 的插件与 Node shim 按生产模式打包 Host Worker，
 * - 闭包里没有诊断插件、files 一致性测试代码、7.9 MB 原生 wasm，有全部契约 JSON（V06-04）；
 * - 对照：`--mode diagnostics`（e2e 用的构建）的闭包含诊断插件；
 * - 在去掉 Node 全局的独立进程里启动产物（worker-boot-runner.ts），经 MobileShell 握手、迁移、调用、有序退出（V06-05）。
 * 与真实构建的差别只有 `@sqlite.org/sqlite-wasm` 换成运行器注入的 Node 版模块。
 *
 * 要构建，用 bin/heavy 运行。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOBILE_APP_COMMANDS } from '../../src/worker/command-acl.ts';
import { NODE_SHIM_ALIASES, compactContracts, mobileProfile, rejectNodeBuiltins } from '../../vite.config.ts';

const MOBILE = join(import.meta.dirname, '../..');
const REPO = join(MOBILE, '..');
const RESULT_PREFIX = 'W31-BOOT-RESULT ';
const BUILD_TIMEOUT_MS = 180_000;

function probeSqlite(): Plugin {
  const id = '\0w31-probe-sqlite';
  return {
    name: 'w31-probe-sqlite',
    enforce: 'pre',
    resolveId: source => (source === '@sqlite.org/sqlite-wasm' ? id : null),
    load: source => (source === id ? 'export default async () => globalThis.__probe.sqlite3;' : null),
  };
}

/** 运行时生成代码的写法（CSP 不含 `'unsafe-eval'` 时会被拒绝）。 */
const DYNAMIC_CODE = /(?<![\w$])(?:new\s+)?Function\s*\(|(?<![\w$])eval\s*\(/g;

interface Bundle {
  /** 产物的模块闭包（仓库相对路径）与输出文件名，相当于 esbuild metafile 的 inputs/outputs。 */
  readonly files: Set<string>;
  /** 渲染后的代码里含 {@link DYNAMIC_CODE} 的模块 → 命中的写法。 */
  readonly dynamicCode: Map<string, string[]>;
  /** 导入 `mobile/src/shims/`（Node 内建模块的替身）的模块 → 它导入的 shim 文件名。 */
  readonly nodeShimImporters: Map<string, string[]>;
}

const SHIMS_DIR = 'mobile/src/shims/';

function closure(into: Bundle): Plugin {
  return {
    name: 'w31-closure',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        into.files.add(output.fileName);
        if (output.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(output.modules)) {
          const name = id.startsWith('\0') ? id : relative(REPO, id);
          into.files.add(name);
          const hits = [...(module.code ?? '').matchAll(DYNAMIC_CODE)].map(match => match[0].replace(/\s+/g, ' '));
          if (hits.length > 0) into.dynamicCode.set(name, hits);
          const shims = (this.getModuleInfo(id)?.importedIds ?? []).map(imported => relative(REPO, imported)).filter(path => path.startsWith(SHIMS_DIR));
          if (shims.length > 0 && !name.startsWith(SHIMS_DIR)) into.nodeShimImporters.set(name, shims.map(path => path.slice(SHIMS_DIR.length)).sort());
        }
      }
    },
  };
}

/** 只把 host-worker.ts 对移动端 profile 的导入换成 ACL 夹具（夹具自己再导入真实 profile）。 */
function aclFixtureProfile(): Plugin {
  return {
    name: 'w31-acl-fixture-profile',
    enforce: 'pre',
    resolveId: (source, importer) =>
      (source === 'virtual:dstu-profile/mobile' && importer?.endsWith('/mobile/src/worker/host-worker.ts') ? join(MOBILE, 'tests/boot/acl-fixture-profile.ts') : null),
  };
}

async function bundleWorker(mode: 'production' | 'diagnostics', outDir: string, write: boolean, extra: Plugin[] = []): Promise<Bundle> {
  const result: Bundle = { files: new Set(), dynamicCode: new Map(), nodeShimImporters: new Map() };
  const nodeEnv = process.env.NODE_ENV;
  // `vite build` 在 NODE_ENV 未设置时按 production；vitest 把它设成 test，会让 import.meta.env.DEV 为 true。
  process.env.NODE_ENV = 'production';
  try {
    await build({
      configFile: false,
      root: MOBILE,
      mode,
      appType: 'custom',
      publicDir: false,
      logLevel: 'warn',
      plugins: [...extra, rejectNodeBuiltins(), mobileProfile(), compactContracts(), probeSqlite(), closure(result)],
      resolve: { alias: NODE_SHIM_ALIASES },
      build: {
        target: 'es2022',
        outDir,
        emptyOutDir: true,
        write,
        minify: false,
        modulePreload: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: {
            'host-worker': join(MOBILE, 'src/worker/host-worker.ts'),
            'boot-driver': join(MOBILE, 'tests/boot/boot-driver.ts'),
          },
          preserveEntrySignatures: 'exports-only',
          output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
        },
      },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  return result;
}

function runBundle(bundleDir: string, extraInvokes: readonly [string, unknown][] = []): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [join(MOBILE, 'tests/boot/worker-boot-runner.ts'), bundleDir, JSON.stringify(extraInvokes)], {
    cwd: MOBILE,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = stdout.split('\n').find(text => text.startsWith(RESULT_PREFIX));
  expect(line, stdout).toBeDefined();
  return JSON.parse(line!.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
}

/** Worker 内 Host logger 写到 console 的 warn / error 行（info 行是迁移与启动进度）。 */
const warningsAndErrors = (result: Record<string, unknown>) => (result.console as string[]).filter(line => !line.startsWith('info: '));

/**
 * mobile profile 的服务闭环缺口：只有提供方也在同一 profile（或外壳 `dstu.mobile.shell`）里的服务才算可用。
 * 先声明 mobile、提供方仍只在桌面的业务插件装配后 inactive，这里按同样的级联算出预期，而不是写死名单。
 */
async function mobileServiceGaps(): Promise<{ id: string; missing: string[]; unavailable: Map<string, string> }[]> {
  const entries = (JSON.parse(readFileSync(join(REPO, 'host/profiles/mobile.json'), 'utf8')) as { plugins: { id: string; module: string }[] }).plugins;
  const plugins = await Promise.all(entries.map(async (entry) => {
    const loaded = await import(pathToFileURL(resolve(REPO, 'host/profiles', entry.module)).href) as {
      default: { inject?: readonly string[] | Record<string, unknown>; meta: { provides?: readonly string[] } };
    };
    const inject = Array.isArray(loaded.default.inject) ? loaded.default.inject : Object.keys(loaded.default.inject ?? {});
    return { id: entry.id, inject, provides: loaded.default.meta.provides ?? [] };
  }));
  const provided = new Set(['sqliteRuntime']);
  let pending = plugins;
  while (pending.length > 0) {
    const ready = pending.filter(plugin => plugin.inject.every(name => provided.has(name)));
    if (ready.length === 0) break;
    pending = pending.filter(plugin => !ready.includes(plugin));
    for (const plugin of ready) for (const name of plugin.provides) provided.add(name);
  }
  const unavailable = new Map<string, string>();
  for (const plugin of pending) {
    for (const name of plugin.provides) {
      if (!unavailable.has(name)) unavailable.set(name, plugin.id);
    }
  }
  return pending
    .map(plugin => ({ id: plugin.id, missing: plugin.inject.filter(name => !provided.has(name)), unavailable }));
}

/** 已知的服务缺口与新激活业务插件在空白库/无桌面治理服务时的启动 warn 之外的 warn / error。 */
const unexpectedWarnings = (result: Record<string, unknown>) =>
  warningsAndErrors(result).filter(
    line =>
      !line.includes(' is inactive: SERVICE_MISSING: ') &&
      !line.includes('[VfsIndexWorker] Text embedding model not configured; skipping text indexing batch.') &&
      !line.includes('[RAG] 找不到多模态嵌入模型配置') &&
      !line.includes('[AppSetup] 跳过启动删除恢复：'),
  );

const FORBIDDEN = /diagnostics-plugin|host\/platform\/files\/tests\/|f7-native-wasm/;

describe('production Host Worker bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w31-worker-boot-'));
  let production: Bundle = { files: new Set(), dynamicCode: new Map(), nodeShimImporters: new Map() };

  beforeAll(async () => {
    production = await bundleWorker('production', join(dir, 'production'), true);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves out the diagnostics plugin, files test code and the native wasm; bundles every IPC contract', () => {
    expect(production.files.has('mobile/src/worker/host-worker.ts')).toBe(true);
    expect([...production.files].filter(entry => FORBIDDEN.test(entry))).toEqual([]);
    const contracts = readdirSync(join(REPO, 'contracts/ipc')).filter(name => name.endsWith('.json')).sort();
    const bundled = [...new Set([...production.files].filter(entry => entry.startsWith('contracts/ipc/')).map(entry => entry.slice('contracts/ipc/'.length).replace(/\?raw$/, '')))].sort();
    expect(bundled).toEqual(contracts);
  });

  it('generates code at run time only in Ajv schema compilation and Schemastery callback revival (V06-L9)', () => {
    // Ajv 编译每个契约 schema（contract-set.ts 模块求值时就编译一次），CSP 不含 'unsafe-eval' 时契约校验不可用；
    // Schemastery 只在反序列化带字符串 callback 的 schema 时用，且包在 try 里。
    const packagePath = (id: string) => (id.includes('node_modules/') ? id.slice(id.lastIndexOf('node_modules/') + 'node_modules/'.length) : id);
    expect(Object.fromEntries([...production.dynamicCode].map(([id, hits]) => [packagePath(id), hits]))).toEqual({
      'ajv/dist/compile/index.js': ['new Function('],
      '@deepseek-ai/schemastery/lib/index.mjs': ['new Function('],
      'jszip/dist/jszip.min.js': ['new Function('],
    });
  });

  it('Node built-ins reach the Worker only through the kernel bootstrap modules, as shims (mobile/vite.config.ts)', () => {
    // acl.ts 的文件读取只给桌面 `CapabilityAcl.fromDirectory` 用，拆分交 W01（mobile/W31-PROGRESS.md 第二轮交接）。
    // M1：`connection.ts` 静态导入桌面插件管理器（`PluginAdmin`）后，它的闭包（profile 存储、同意账本、插件包、
    // Node files、zip 的 Node 编解码、AsyncLocalStorage）跟着进了 Worker；移动端走 `installs`，这些模块只求值不调用。
    // 改成按需 import 属 kernel（交接见 W31-PROGRESS.md「M1」节），落地后这张表应缩回上面四个 kernel 引导模块。
    expect(Object.fromEntries([...production.nodeShimImporters].sort(([a], [b]) => (a < b ? -1 : 1)))).toEqual({
      'host/kernel/acl.ts': ['fs.ts', 'path.ts', 'url.ts'],
      'host/kernel/community-consent.ts': ['crypto.ts', 'fs-promises.ts', 'path.ts'],
      'host/kernel/connection.ts': ['fs-promises.ts', 'path.ts'],
      'host/kernel/contracts.ts': ['fs.ts', 'path.ts', 'url.ts'],
      'host/kernel/plugin-admin.ts': ['crypto.ts', 'fs-promises.ts', 'path.ts', 'url.ts'],
      'host/kernel/plugin-execution.ts': ['async-hooks.ts'],
      'host/kernel/plugin-packages/index.ts': ['crypto.ts'],
      'host/kernel/profile-store.ts': ['crypto.ts', 'fs-promises.ts', 'path.ts'],
      'host/kernel/profile.ts': ['fs-promises.ts', 'path.ts', 'url.ts'],
      'host/kernel/workshop-paths.ts': ['path.ts'],
      'host/platform/files/index.ts': ['crypto.ts', 'fs-promises.ts', 'fs.ts'],
      'host/platform/util/durable-fs.ts': ['fs.ts'],
      'host/platform/zip/node/file.ts': ['fs-promises.ts', 'stream.ts', 'zlib.ts'],
    });
  });

  it('the diagnostics build (used by the Playwright e2e) does include the diagnostics plugin', async () => {
    const diagnostics = await bundleWorker('diagnostics', join(dir, 'diagnostics'), false);
    expect(diagnostics.files.has('mobile/src/worker/diagnostics-plugin.ts')).toBe(true);
  }, BUILD_TIMEOUT_MS);

  it('the production Worker applies the mobile command ACL: a registered command missing from the manifest is refused', async () => {
    const out = join(dir, 'acl');
    await bundleWorker('production', out, true, [aclFixtureProfile()]);
    const result = runBundle(out, [['test_rmcp_streamable_http', { url: 'https://example.com/mcp' }]]);
    expect(result.error).toBeUndefined();
    expect(result.ready).toBe('ready');
    const manifest = result.manifest as { body: { plugins: { id: string }[] } };
    expect(manifest.body.plugins.map(p => p.id)).toContain('fixture.acl');
    expect(Object.values(MOBILE_APP_COMMANDS).flat()).not.toContain('test_rmcp_streamable_http');
    expect(result.extra).toEqual([{ ok: false, body: 'Command test_rmcp_streamable_http not allowed by ACL' }]);
    expect(unexpectedWarnings(result)).toEqual([]);
    expect(result.workerExits).toEqual([0]);
  }, BUILD_TIMEOUT_MS);

  it('boots without Node globals: handshake, migrations, invoke, orderly exit, invokes after exit fail at once', async () => {
    // 第二个参数：Worker 里 `plugin:host|call` 不带 caller —— 移动端 Host 入口没有覆盖 kernel 默认（require），必须拒绝。
    const result = runBundle(join(dir, 'production'), [['plugin:host|call', { service: 'mobileDiagnostics', method: 'ping', args: [] }]]);

    expect(result.error).toBeUndefined();
    expect(result.uncaught).toEqual([]);
    expect(result.nodeGlobalsAtBoot).toEqual({ process: 'undefined', Buffer: 'undefined', setImmediate: 'undefined', clearImmediate: 'undefined', global: 'undefined' });
    expect(result.ready).toBe('ready');
    expect(result.poolInstalls).toBe(1);
    expect(result.listened).toMatchObject({ ok: true });

    const sqlFiles = ['vfs', 'chat_v2', 'mistakes', 'llm_usage']
      .flatMap(db => readdirSync(join(REPO, 'resources/app/migrations', db)).filter(name => name.endsWith('.sql')));
    const statusEvents = (result.events as { event: string; payload: Record<string, unknown> }[]).filter(e => e.event === 'data-governance-migration-status');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]!.payload).toMatchObject({ success: true, migrations_applied: sqlFiles.length, warnings: [] });

    // 只允许“提供方还没进 mobile profile”造成的 SERVICE_MISSING inactive；其他降级（apply 失败、版本不符）都算启动失败。
    const gaps = (await mobileServiceGaps()).sort((a, b) => a.id.localeCompare(b.id));
    const status = result.status as { ok: boolean; body: { id: string; reason: string }[] };
    expect({
      ok: status.ok,
      body: [...status.body].sort((a, b) => a.id.localeCompare(b.id)),
    }).toEqual({
      ok: true,
      body: gaps.map(({ id, missing, unavailable }) => ({
        id,
        reason: `SERVICE_MISSING: ${missing.map(name => {
          const provider = unavailable.get(name);
          return provider === undefined ? `missing service "${name}"` : `missing service "${name}" (provided by inactive plugin "${provider}")`;
        }).join(', ')}`,
      })),
    });
    // V06-L10：打包进应用的插件是官方插件（不是按打包产物 URL 判成 community）。
    const profile = JSON.parse(readFileSync(join(REPO, 'host/profiles/mobile.json'), 'utf8')) as { plugins: { id: string }[] };
    const manifest = result.manifest as { ok: boolean; body: { plugins: { id: string; origin: string; platforms: string[] }[] } };
    expect(manifest.ok).toBe(true);
    // 服务缺口里的条目按 inactive 安装（不进清单）；其余 profile 条目全部装上，外壳排第一。
    const installed = profile.plugins.map(entry => entry.id).filter(id => !gaps.some(gap => gap.id === id));
    const manifestIds = manifest.body.plugins.map(plugin => plugin.id);
    expect(manifestIds[0]).toBe('dstu.mobile.shell');
    expect([...manifestIds].sort()).toEqual(['dstu.mobile.shell', ...installed].sort());
    // 命令 ACL 清单按插件列出的正是 mobile profile 的条目（inactive 条目的命令按维护占位拒绝）。
    expect(Object.keys(MOBILE_APP_COMMANDS)).toEqual(['dstu.mobile.shell', ...profile.plugins.map(entry => entry.id)]);
    for (const plugin of manifest.body.plugins) {
      expect(plugin.origin, plugin.id).toBe('builtin');
      expect(plugin.platforms, plugin.id).toContain('mobile');
    }
    expect(result.diagnostics).toEqual({ ok: false, body: { error_type: 'Validation', message: 'unknown service "mobileDiagnostics"', details: null } });
    expect(result.extra).toEqual([{ ok: false, body: { error_type: 'Validation', message: 'plugin:host|call requires "caller", the plugin id of the calling UI half (SEC-E06)', details: null } }]);
    expect(unexpectedWarnings(result)).toEqual([]);
    expect(result.workerExits).toEqual([0]);
    expect(result.closeCalls).toBe(1);
    expect(result.logs).not.toContain('[host] shutdown timed out, terminating');
    expect(result.afterShutdown).toEqual({ ok: false, body: 'Mobile Host exited (code 0)' });
  });
});
