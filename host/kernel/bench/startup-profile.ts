/**
 * Host 启动剖析（STARTUP-PROFILE.md）。每次测量在独立的 Node 子进程里用生产 `serveHost`（与 main.ts 相同的 ACL、
 * 契约与 profile 选择）启动官方桌面 profile，经内存传输立即发握手，到 HostReady 为止；读取 `runtime.startup`。
 *
 *   node host/kernel/bench/startup-profile.ts [--runs=5] [--json=<file>] [--no-compile-cache]
 *
 * - cold：每次一个全新的数据目录（首次启动：建库、迁移）；
 * - warm：同一个数据目录，先启动一次丢弃，再测 `runs` 次（日常启动）。
 * 数据目录建在系统临时目录下，结束后删除。和 Electron 实测（W12 09-perf-baseline）相比，这里没有 fork 与
 * IPC 往返，`handshake` 阶段 ≈ Node 启动 + 加载 kernel 模块。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartupTimings } from '../startup-timing.ts';

interface ChildResult {
  timings: StartupTimings;
  degraded: { id: string; reason: string }[];
  shellOps: string[];
  rssMb: number;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function child(dataDir: string): Promise<void> {
  const { flushCompileCache } = await import('../compile-cache.ts');
  const [{ serveHost }, { CapabilityAcl }, { ContractSet }, { HOST_PROTOCOL_VERSION }] = await Promise.all([
    import('../connection.ts'), import('../acl.ts'), import('../contracts.ts'), import('../protocol.ts'),
  ]);
  type Listener = (message: unknown) => void;
  const listeners: Listener[] = [];
  const shellOps: string[] = [];
  const deliver = (message: unknown) => { for (const listener of listeners) listener(message); };
  const session = serveHost({
    send(message) {
      if (message.kind !== 'shell-request') return;
      shellOps.push(message.op);
      queueMicrotask(() => deliver({ kind: 'shell-result', id: message.id, ok: false, error: 'startup-profile harness has no shell' }));
    },
    onMessage(listener) { listeners.push(listener); },
    onClose() {},
    close() {},
  }, {
    acl: (app) => CapabilityAcl.fromDirectory(app.platform, undefined),
    contracts: () => ContractSet.fromDirectory(),
    exit: () => {},
  });
  deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: dataDir, appVersion: '0.0.0-startup-profile', platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', debug: false });
  const runtime = await session.ready;
  if (!runtime) throw new Error('Host did not become ready');
  const result: ChildResult = {
    timings: runtime.startup.snapshot(),
    degraded: runtime.degradedPlugins(),
    shellOps,
    rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
  process.stdout.write(`\n@@STARTUP@@${JSON.stringify(result)}\n`);
  flushCompileCache();
  await session.shutdown();
  process.exit(0);
}

function runChild(dataDir: string, cache: string | null): ChildResult {
  const env: NodeJS.ProcessEnv = { ...process.env, DEEP_STUDENT_BUILD_NUMBER: process.env.DEEP_STUDENT_BUILD_NUMBER ?? '20000' };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  if (cache === null) env.NODE_DISABLE_COMPILE_CACHE = '1';
  else env.NODE_COMPILE_CACHE = cache;
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${dataDir}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 2 ** 20, env,
  });
  const line = out.split('\n').find((text) => text.startsWith('@@STARTUP@@'));
  if (!line) throw new Error(`child produced no timings:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice('@@STARTUP@@'.length)) as ChildResult;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round((sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
};

function aggregate(results: ChildResult[]) {
  const phaseNames = results[0]!.timings.phases.map((phase) => phase.name);
  const phases = phaseNames.map((name, index) => ({
    name,
    at: median(results.map((r) => r.timings.phases[index]?.at ?? Number.NaN)),
    delta: index === 0 ? median(results.map((r) => r.timings.phases[0]!.at))
      : median(results.map((r) => (r.timings.phases[index]?.at ?? Number.NaN) - (r.timings.phases[index - 1]?.at ?? Number.NaN))),
  }));
  const perPlugin = (pick: (r: ChildResult) => { id: string; ms: number }[]) => {
    const byId = new Map<string, number[]>();
    for (const r of results) for (const item of pick(r)) byId.set(item.id, [...(byId.get(item.id) ?? []), item.ms]);
    return [...byId].map(([id, values]) => ({ id, ms: median(values) })).sort((a, b) => b.ms - a.ms);
  };
  return {
    runs: results.length,
    phases,
    installs: perPlugin((r) => r.timings.installs),
    imports: perPlugin((r) => r.timings.imports),
    degraded: results[0]!.degraded,
    shellOps: [...new Set(results.flatMap((r) => r.shellOps))],
    rssMb: median(results.map((r) => r.rssMb)),
  };
}

async function parent(): Promise<void> {
  const runs = Number(arg('runs') ?? 5);
  const root = mkdtempSync(join(tmpdir(), 'dstu-startup-profile-'));
  const cache = process.argv.includes('--no-compile-cache') ? null : join(root, 'compile-cache');
  try {
    // 第一次 cold 运行时编译缓存为空（等同升级后的首次启动），之后各次命中缓存。
    const cold: ChildResult[] = [];
    for (let i = 0; i < runs; i++) cold.push(runChild(mkdtempSync(join(root, 'cold-')), cache));
    const warmDir = mkdtempSync(join(root, 'warm-'));
    runChild(warmDir, cache);
    const warm: ChildResult[] = [];
    for (let i = 0; i < runs; i++) warm.push(runChild(warmDir, cache));
    const report = { node: process.version, platform: `${process.platform}-${process.arch}`, compileCache: cache !== null, cold: aggregate(cold), warm: aggregate(warm) };
    const json = arg('json');
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    for (const kind of ['cold', 'warm'] as const) {
      const r = report[kind];
      process.stdout.write(`\n## ${kind} (${r.runs} runs, median)\n`);
      for (const phase of r.phases) process.stdout.write(`  ${phase.name.padEnd(20)} at ${String(phase.at).padStart(7)}ms  +${phase.delta}ms\n`);
      process.stdout.write(`  rss ${r.rssMb}MB; degraded ${r.degraded.length}; shell ops ${r.shellOps.join(', ') || '(none)'}\n  slowest apply:\n`);
      for (const item of r.installs.slice(0, 12)) process.stdout.write(`    ${String(item.ms).padStart(7)}ms  ${item.id}\n`);
      process.stdout.write('  slowest import:\n');
      for (const item of r.imports.slice(0, 12)) process.stdout.write(`    ${String(item.ms).padStart(7)}ms  ${item.id}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const childDir = arg('child');
await (childDir ? child(childDir) : parent());
