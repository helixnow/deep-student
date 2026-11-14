/**
 * 移动端 Host 入口（Web Worker）。
 *
 * 主线程创建 `MessageChannel`，把 port 经 `{ kind: 'dstu-connect', port }` 交给本 Worker；之后所有
 * Host 协议消息（握手 / invoke / 事件 / shell 请求）都走这条 port，与桌面 Electron main ↔ utilityProcess
 * 的 MessagePort 完全同构（`host/kernel/connection.ts` 的 `serveHost`）。
 *
 * 插件装配 = 外壳绑定（`dstu.mobile.shell` 提供 `sqliteRuntime`）+ `host/profiles/mobile.json` 条目
 * （构建期静态导入）+ 原型诊断插件（只在开发服务器与 `vite build --mode diagnostics` 中）。
 */
import { definePlugin } from '../../../host/kernel/core.ts';
import { serveHost } from '../../../host/kernel/connection.ts';
import type { PluginInstall } from '../../../host/kernel/runtime.ts';
import type { SqliteRuntime } from '../../../host/platform/storage-mobile/index.ts';
import mobileProfile from 'virtual:dstu-profile/mobile';
import { mobileCommandAcl } from './command-acl.ts';
import { bundledContracts } from './contracts.ts';
import { exitReportingTransport } from './exit-report.ts';
import { createSqliteRuntime, type SqliteRuntimeTimings } from './sqlite-runtime.ts';

/** Worker timeOrigin 起到全部 Host 模块求值完成（import 已提升，本行在依赖求值之后执行）。 */
const modulesEvaluatedMs = performance.now();

/**
 * `LoggerLevel.WARN`（Cordis：ERROR 0 / INFO 1 / WARN 2 / DEBUG 3）。exporter 不设 `levels` 时阈值是 INFO，
 * warn 会被丢弃；与桌面 `host/kernel/log-export.ts` 一样显式取 WARN（error / warn / info 输出，debug 不输出）。
 */
const CORDIS_LEVEL_WARN = 2;

/** 外壳绑定插件：相当于桌面 Electron 打包进 Host 进程的原生驱动。 */
function shellPlugin(runtime: SqliteRuntime, timings: SqliteRuntimeTimings) {
  return definePlugin({
    meta: { id: 'dstu.mobile.shell', lane: 'W14-portable', provides: ['sqliteRuntime'], platforms: ['mobile'] },
    apply(ctx) {
      if (timings.poolError !== null) {
        ctx.logger('storage').error(`SQLite pool unavailable after ${timings.poolAttempts} attempts; databases open as locked: ${timings.poolError}`);
      }
      ctx.provide('sqliteRuntime', runtime);
    },
  });
}

interface ConnectMessage {
  kind: 'dstu-connect';
  port: MessagePort;
}

function isConnect(data: unknown): data is ConnectMessage {
  return typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === 'dstu-connect';
}

// SQLite WASM 初始化与握手并行：Host 收到握手后才需要它。
const sqliteReady = createSqliteRuntime();

self.addEventListener('message', (event: MessageEvent) => {
  if (!isConnect(event.data)) return;
  const host = exitReportingTransport(event.data.port);
  serveHost(host.transport, {
    contracts: bundledContracts,
    platform: 'mobile',
    acl: app => mobileCommandAcl(app.platform),
    // 条目不带 `source`：插件都打包在应用里，没有可解析的模块 URL；kernel 把没有来源的安装视为官方插件（builtin）。
    installs: async (): Promise<PluginInstall[]> => {
      const { runtime, timings } = await sqliteReady;
      const installs: PluginInstall[] = [
        { plugin: shellPlugin(runtime, timings) },
        ...mobileProfile.map(entry => ({ plugin: entry.plugin, config: entry.config })),
      ];
      // 诊断插件会改写真实库并对 renderer 开放全部方法。生产构建里条件是常量 false，
      // 整个分支连同动态 import 被删掉，它的模块闭包不进产物（mobile/tests/boot/worker-boot.test.ts）。
      if (import.meta.env.DEV || import.meta.env.MODE === 'diagnostics') {
        const { createDiagnosticsPlugin } = await import('./diagnostics-plugin.ts');
        installs.push({ plugin: createDiagnosticsPlugin(runtime, { modulesEvaluatedMs, ...timings }) });
      }
      return installs;
    },
    onRuntime: (runtime) => {
      runtime.ctx.logger.exporter({
        levels: { default: CORDIS_LEVEL_WARN },
        export(message) {
          const text = `[${message.name}] ${(message.args as unknown[]).map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`;
          if (message.type === 'error') console.error(text);
          else if (message.type === 'warn') console.warn(text);
          else console.info(text);
        },
      });
    },
    exit: (code) => {
      host.exit(code);
      self.close();
    },
  });
});

self.postMessage({ kind: 'dstu-worker-loaded', modulesEvaluatedMs });
