/** Isolated subprocess; no business plugin is imported before run.mjs sets the environment. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { serveHost } from '../../../kernel/connection.ts';
import { ContractSet, REPO_CONTRACTS_DIR } from '../../../kernel/contracts.ts';
import { generateDesktopProfile } from '../../../profiles/generate.ts';
import { importProfile, resolveProfile } from '../../../kernel/profile.ts';
import { HOST_PROTOCOL_VERSION } from '../../../kernel/protocol.ts';
import { MinimalArguments } from './minimal.ts';
import { classifyResponse, environmentBlocked } from './probe.ts';
import { selectCommands, shardCommands } from './selection.ts';

const root = process.env.DS_SMOKE_ROOT!;
const reportPath = join(root, 'result.json');
const report: any = {
  runtime: process.versions.electron ? 'electron' : 'node', versions: process.versions,
  mode: process.env.DS_SMOKE_STARTUP_ONLY === '1' ? 'startup-only' : 'commands',
  startup: { expected: 0, installed: [], degraded: [], missingProvides: [], issues: [] },
  probes: [], unregistered: [], uncaught: [], shellRequests: [],
};
const started = Date.now();
const save = () => writeFileSync(reportPath, JSON.stringify({ ...report, durationMs: Date.now() - started }, null, 2));
const detail = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
// The generator rejects an invalid pre-storage bootstrap before any plugin metadata is loaded.
// Attribute that contract failure to the declaring plugin, not to this smoke lane.
function startupIssueLane(error: unknown): string {
  const provider = /(?:^|\n)Error: ([\w.-]+): (?:pre-storage bootstrap must inject only paths|multiple storageStartupSync bootstrap providers)/.exec(detail(error))?.[1];
  return provider ? `provider:${provider}` : 'X1-e2e-smoke';
}
const commandContext = new AsyncLocalStorage<string>();
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, error => { report.uncaught.push({ command: commandContext.getStore(), error: detail(error) }); save(); });
}
save();

async function main() {
  // Relative file arguments such as "" must never resolve inside the repository.
  process.chdir(root);
  const generated = await generateDesktopProfile();
  const official = fileURLToPath(new URL('../../../profiles/desktop.json', import.meta.url));
  const profile = JSON.parse(generated);
  report.startup.expected = profile.plugins.length;
  if (readFileSync(official, 'utf8') !== generated) {
    report.startup.issues.push({ lane: 'F1-kernel', reason: 'desktop.json differs from generateDesktopProfile()' });
  }
  // Relocate only module URLs, never config / inject / provides / plugin implementations.
  for (const entry of profile.plugins) entry.module = new URL(entry.module, pathToFileURL(official)).href;
  const profilePath = join(root, 'desktop.json');
  writeFileSync(profilePath, JSON.stringify(profile));
  const installs = await importProfile(await resolveProfile(profilePath));
  const contracts = ContractSet.fromDirectory();
  const minimal = new MinimalArguments(REPO_CONTRACTS_DIR);
  let receive!: (message: unknown) => void;
  const pending = new Map<string, (message: any) => void>();
  let serial = 0;
  const session = serveHost({
    onMessage(listener) { receive = listener; }, onClose() {}, close() {},
    send(message: any) {
      if (message.kind === 'result') pending.get(message.id)?.(message);
      if (message.kind === 'fatal') report.startup.issues.push({ lane: 'F1-kernel', reason: message.message });
      if (message.kind === 'shell-request') {
        report.shellRequests.push({ command: commandContext.getStore(), op: message.op });
        // There is deliberately no GUI / main shell in ELECTRON_RUN_AS_NODE mode.
        queueMicrotask(() => receive({ kind: 'shell-result', id: message.id, ok: false, error: `smoke: shell unavailable (${message.op})` }));
      }
    },
  }, {
    contracts: () => contracts,
    officialProfile: profilePath,
    onRuntime(runtime) {
      runtime.ctx.logger.exporter({ export(message) {
        const text = format(...message.args);
        process.stderr.write(`[${message.type}] [${message.name}] ${text}\n`);
        // Observe a kernel-reported panic immediately, not as a synthetic IPC reply.
        // Ordinary missing replies still hit invoke's timeout below.
        const panic = message.name === 'commands' && /\(invoke (smoke-\d+)\) panicked;/.exec(text);
        if (panic) pending.get(panic[1]!)?.({ panic: text });
      } });
    },
  });
  receive({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: join(root, 'data'), appVersion: '0.11.0', platform: process.platform, debug: false });
  const runtime = await session.ready;
  if (!runtime) { save(); return; }
  report.startup.installed = runtime.plugins().map(entry => entry.id);
  report.startup.durationMs = Date.now() - started;
  report.startup.degraded = runtime.degradedPlugins().map(item => ({ ...item, lane: installs.find(e => e.plugin.meta.id === item.id)?.plugin.meta.lane }));
  for (const { plugin } of installs) {
    for (const service of plugin.meta.provides ?? []) {
      if (runtime.ctx.get(service) === undefined) report.startup.missingProvides.push({ plugin: plugin.meta.id, lane: plugin.meta.lane, service });
    }
  }
  async function invoke(cmd: string, args: unknown, timeoutMs: number): Promise<any> {
    const id = `smoke-${++serial}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id);
        receive({ kind: 'abandon', id, reason: 'reloaded' });
        resolve({ timeout: true });
      }, timeoutMs);
      pending.set(id, response => { clearTimeout(timer); pending.delete(id); resolve(response); });
      receive({ kind: 'invoke', id, cmd, args, source: { window: 'main', webview: 'main' } });
    });
  }
  const status = await invoke('plugin:host|status', {}, 1000);
  report.startup.status = status;
  if (!status.ok || JSON.stringify(status.value) !== JSON.stringify(runtime.degradedPlugins())) {
    report.startup.issues.push({ lane: 'F1-kernel', reason: 'plugin:host|status did not match kernel degraded list' });
  }
  // Snapshot registration before commands can mutate state. No private handler / per-lane test host.
  const registered = [...contracts.commands.values()].filter(command => runtime.commands.has(command.name));
  report.unregistered = [...contracts.commands.values()].filter(command => !runtime.commands.has(command.name)).map(c => ({ command: c.name, lane: c.lane }));
  report.registered = registered.length;
  report.registrations = registered.map(command => ({ command: command.name, lane: command.lane }));
  const selectedAll = report.mode === 'startup-only' ? [] : selectCommands(registered, process.env.DS_SMOKE_COMMAND);
  const { commands: selected, shard } = shardCommands(selectedAll, process.env.DS_SMOKE_SHARD);
  report.shard = shard && { ...shard, of: selectedAll.length };
  if (report.mode !== 'startup-only' && !selected.length) throw new Error(`no registered command selected: ${process.env.DS_SMOKE_COMMAND ?? '(all)'}${process.env.DS_SMOKE_SHARD ? ` shard ${process.env.DS_SMOKE_SHARD}` : ''}`);
  report.selected = selected.length;
  save();
  const timeoutMs = process.env.DS_SMOKE_SLOW === '1' ? 60000 : 5000;
  // Serialize mutating commands: concurrent purge / clone / maintenance commands
  // on the same production data space would test a race, not basic reachability.
  for (const command of selected) {
    await commandContext.run(command.name, async () => {
      const owner = runtime.plugins().find(entry => entry.plugin.meta.commands?.includes(command.name));
      const probe: any = { lane: owner?.plugin.meta.lane ?? command.lane, contractLane: command.lane, command: command.name, args: {}, outcome: 'crash' };
      const probeStarted = Date.now();
      report.probes.push(probe);
      // result.json is saved every 32 probes; this names the in-flight command if run.mjs kills the worker.
      writeFileSync(join(root, 'current.json'), JSON.stringify({ index: report.probes.length, command: command.name, lane: probe.lane, elapsedMs: probeStarted - started }));
      try {
        probe.args = minimal.args(command);
        if (command.name === 'test_mcp_sse' && typeof process.env.DS_SMOKE_SSE_ENDPOINT === 'string') {
          probe.args.endpoint = process.env.DS_SMOKE_SSE_ENDPOINT;
        }
        const valid = contracts.checkArgs(command, probe.args);
        if (!valid.ok) throw new Error(`probe generation failed (not invoked): ${valid.error}`);
        const response = await invoke(command.name, probe.args, timeoutMs);
        Object.assign(probe, classifyResponse(contracts, command, response));
        if (response.timeout) probe.reason += ` (${timeoutMs}ms; see stderr.log)`;
      } catch (error) { probe.category = 'probe-error'; probe.reason = detail(error); }
      probe.durationMs = Date.now() - probeStarted;
      probe.shellRequests = report.shellRequests.filter((request: { command: string }) => request.command === command.name);
      Object.assign(probe, environmentBlocked(probe, probe.shellRequests));
    });
    if (report.probes.length % 32 === 0) save();
  }
  save();
  // Hung calls may ignore abort; do not let cleanup hold the gate forever.
  await Promise.race([session.shutdown(), new Promise(resolve => setTimeout(resolve, 2000))]);
}

main().catch(error => { report.startup.issues.push({ lane: startupIssueLane(error), reason: detail(error) }); }).finally(() => {
  save();
  process.exit(report.startup.issues.length || report.startup.degraded.length || report.startup.missingProvides.length || report.probes.some((p: { outcome: string }) => p.outcome === 'crash') || report.uncaught.length ? 1 : 0);
});
