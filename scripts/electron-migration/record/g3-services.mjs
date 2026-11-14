// Per-scenario external services for the A and B runners. Both sides run in their own
// network namespace (g3-batch: unshare -rn), so fixed loopback ports give byte-identical
// inputs on A1, A2 and B; nothing else about the run is shared.
//  - X5 mock LLM (host/e2e/streaming/wave0): started when a scenario declares `llm` or
//    uses `${llm.*}` / `${provider.*}`. Without `llm` the script id is the scenario id
//    (wave0/README "external runner"), with `<suite>.provider.json` scripts when present.
//  - WP-046 cloud service (host/plugins/sync-providers/equivalence): started when a
//    scenario uses `${cloud.*}` (sync-providers, `scenario.cloud.{seed,faults}`) or
//    `${mock.webdav.*}` (sync-support README §运行前提 1: empty remote per scenario).
//  - MCP service (host/plugins/mcp/equivalence, README "G3 接线"): started when a scenario
//    uses `${mcp.*}`, self-contained under the worker's private MCP_DIR (g3-worker.mjs mounts
//    a tmpfs there and exports G3_MCP_DIR) with this runner's node, so every launch value
//    (command, args, cwd, tools list) is the same bytes on A1, A2 and B.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
//  - SearXNG mock (g3-search-service.mjs): started when a scenario uses `${search.*}`.
import { LLM_PORT, WAIT_DEADLINE_MS } from './g3-wait.mjs';
import { QUIET } from './g3-quiet.mjs';
import { parseExact, stringifyExact } from './json.mjs';
import { aProducedBindings, runnerBindingKind } from './scenario-v0.mjs';
import { SEARCH_PORT, searchBindingKinds, searchGap, startSearchService } from './g3-search-service.mjs';

export const CLOUD_PORTS = { webdav: 47120, s3: 47121, control: 47122 };
export const MCP_PORT = 47130;
export const MCP_DIR = '/tmp/g3-mcp';
/** Per-step limit for MCP scenarios: above A's 60 s SSE probe and 30 s stdio disconnect probes (README G3 接线 7). */
export const MCP_STEP_MS = 90_000;
const uses = (scenario, prefix) => stringifyExact(scenario.steps).includes(`\${${prefix}.`);
export const SERVICE_NAMESPACES = ['llm', 'provider', 'cloud', 'mock', 'mcp', 'search'];
/**
 * Resolved by the run itself, not by a service: `${wait.N…}` (scenario-v0, a prior step's matched
 * waitAfter) and `${runner.*}` (scenario-v0 prepareScenarioRun / executeScenario).
 */
const RUN_NAMESPACES = ['wait', 'runner'];

/**
 * Why the runners cannot provide this scenario's inputs, or null: a `${ns.…}` binding of a
 * namespace nothing here supplies (e.g. `${fixture.*}`), `${seed.*}` when the scenario's seed
 * supplies no such key (seedBindingKinds), a `${runner.*}` / `${search.*}` key the run / the
 * search mock does not supply, a `scenario.search` response the mock does not have, or, given
 * the MCP service's keys (mcpBindingKinds), an `${mcp.…}` key it does not supply (pending OAuth /
 * WebSocket mocks): each would throw mid-run on every side, after the app has started.
 */
export function serviceGap(scenario, { mcp = null, seed = null } = {}) {
  const text = stringifyExact(scenario.steps);
  const namespaces = new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_-]*)[.}]/g)].map(match => match[1]));
  const missing = [...namespaces].filter(name => !SERVICE_NAMESPACES.includes(name) && !RUN_NAMESPACES.includes(name) && name !== 'seed').sort();
  if (missing.length) return `binding namespace ${missing.map(name => `\${${name}.…}`).join(', ')} is not provided by g3-services.mjs`;
  if (namespaces.has('seed') && !seed) return `seed ${scenario.seed} provides no \${seed.…} bindings (a-produced-seeds.ts seedBindings)`;
  const runnerKeys = Object.fromEntries([...text.matchAll(/\$\{(runner\.[^}]+)\}/g)].filter(match => runnerBindingKind(match[1])).map(match => [match[1], 'string']));
  for (const [namespace, keys, provider] of [['mcp', mcp, 'the MCP service'], ['seed', seed, `seed ${scenario.seed}`],
    ['search', searchBindingKinds(), 'the search service'], ['runner', runnerKeys, 'the run (scenario-v0 runner bindings)']]) {
    if (!keys) continue;
    const unknown = [...new Set([...text.matchAll(new RegExp(`\\$\\{(${namespace}\\.[^}]+)\\}`, 'g'))].map(match => match[1]))].filter(key => !Object.hasOwn(keys, key)).sort();
    if (unknown.length) return `binding ${unknown.map(key => `\${${key}}`).join(', ')} is not provided by ${provider}`;
  }
  return searchGap(scenario);
}

/** `seed.*` binding keys seed `name` supplies → 'string' or the JSON type of the value, or null when it supplies none. */
export async function seedBindingKinds(name, bindingsFor = aProducedBindings) {
  const bindings = await bindingsFor(name, '/');
  if (!bindings) return null;
  const kinds = {};
  const visit = (value, key) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) for (const [part, item] of Object.entries(value)) visit(item, `${key}.${part}`);
    else kinds[key] = typeof value === 'string' ? 'string' : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  };
  visit(bindings, 'seed');
  return kinds;
}

/** `mcp.*` binding keys the MCP service supplies → 'string' or the JSON type of the value (a throwaway service on a free port). */
export async function mcpBindingKinds() {
  const { startMcpService } = await import('../../../host/plugins/mcp/equivalence/mcp-service.ts');
  const logDir = mkdtempSync(join(tmpdir(), 'g3-mcp-keys-'));
  try {
    const service = await startMcpService({ host: '127.0.0.1', port: 0, logDir, nodeCommand: process.execPath, selfContained: true });
    try {
      return Object.fromEntries(Object.entries(service.placeholders()).map(([key, value]) => [key,
        typeof value === 'string' ? 'string' : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value]));
    } finally { await service.stop(); }
  } finally { rmSync(logDir, { recursive: true, force: true }); }
}

/** The runner's per-step limit for this scenario. */
export const stepTimeout = (scenario, fallback) => (usesMcp(scenario) ? Math.max(fallback, MCP_STEP_MS) : fallback);
export const usesMcp = scenario => uses(scenario, 'mcp');
/** An MCP OAuth scenario: its app opens the authorization URL in the service's stand-in browser (mcp README G3 接线 9). */
export const opensBrowser = scenario => usesMcp(scenario) && (scenario.mcp?.oauth === true || uses(scenario, 'mcp.oauth'));
/** `env` with `pathDir` first on PATH, so the app's opener (xdg-open) is the stand-in. */
export const browserPath = (env, pathDir) => ({ ...env, PATH: env.PATH ? `${pathDir}${delimiter}${env.PATH}` : pathDir });

/** What an MCP take's launch values depend on besides the service source (g3-inputs `launch.mcp`); runtime.ts canonicalizes the node path. */
export const mcpLaunch = (node = process.execPath) => ({ port: MCP_PORT, logDir: MCP_DIR, node: realpathSync(node) });

/** `llmPort` / `searchPort`: only tests outside a g3 worker namespace pass 0 (two of them would collide on the fixed ports). */
export async function startScenarioServices(scenario, scenarioFile, { mcpDir = process.env.G3_MCP_DIR ?? null, llmPort = LLM_PORT, searchPort = SEARCH_PORT } = {}) {
  const bindings = {}, evidence = {}, stops = [];
  let llm = null;
  try {
    const wantsLlm = scenario.llm !== undefined || uses(scenario, 'llm') || uses(scenario, 'provider');
    if (wantsLlm) {
      const { startLlmService, providerScripts } = await import('../../../host/e2e/streaming/wave0/llm-service.ts');
      const sidecar = scenarioFile.replace(/\.json$/, '.provider.json');
      const extraScripts = existsSync(sidecar) ? providerScripts(JSON.parse(readFileSync(sidecar, 'utf8'))) : {};
      const script = scenario.llm ?? scenario.id;
      const service = await startLlmService({ port: llmPort, extraScripts });
      stops.push(() => service.stop());
      const baseUrl = service.baseUrl(script);
      llm = { service };
      bindings.llm = { baseUrl };
      bindings.provider = { url: baseUrl };
      evidence.llm = { script, sidecar: existsSync(sidecar) ? sidecar : null, port: Number(new URL(service.url).port) };
    }
    if (uses(scenario, 'search')) {
      const gap = searchGap(scenario);
      if (gap) throw new Error(gap);
      const searxng = scenario.search?.searxng ?? ['success'];
      const service = await startSearchService({ port: searchPort, searxng });
      stops.push(() => service.stop());
      bindings.search = { searxngUrl: service.searxngUrl };
      evidence.search = { service, searxng };
    }
    const wantsCloud = uses(scenario, 'cloud'), wantsMock = uses(scenario, 'mock.webdav');
    if (wantsCloud || wantsMock) {
      const { startCloudService, WEBDAV_USERNAME, WEBDAV_PASSWORD } = await import('../../../host/plugins/sync-providers/equivalence/__fixtures__/cloud-service.ts');
      const seed = wantsCloud ? scenario.cloud?.seed : 'empty';
      const cloud = await startCloudService({ seed, webdavPort: CLOUD_PORTS.webdav, s3Port: CLOUD_PORTS.s3, controlPort: CLOUD_PORTS.control });
      stops.push(() => cloud.stop());
      if (wantsCloud && scenario.cloud?.faults) cloud.setFaults(scenario.cloud.faults);
      bindings.cloud = { webdav: { endpoint: cloud.webdavEndpoint }, s3: { endpoint: cloud.s3Endpoint } };
      bindings.mock = { webdav: { endpoint: cloud.webdavEndpoint, endpointAlias: cloud.webdavEndpoint.replace('//127.0.0.1:', '//localhost:'),
        username: WEBDAV_USERNAME, password: WEBDAV_PASSWORD } };
      evidence.cloud = { seed: cloud.seedName, faults: wantsCloud ? scenario.cloud?.faults ?? [] : [], ports: CLOUD_PORTS, service: cloud };
    }
    if (uses(scenario, 'mcp')) {
      // Two workers sharing one host path would interleave stdio logs and fixture copies.
      if (!mcpDir) throw new Error(`MCP scenario needs the worker's private ${MCP_DIR} (G3_MCP_DIR from g3-worker.mjs); not running in a g3 worker namespace?`);
      const { startMcpService } = await import('../../../host/plugins/mcp/equivalence/mcp-service.ts');
      const service = await startMcpService({ host: '127.0.0.1', port: MCP_PORT, logDir: mcpDir, nodeCommand: process.execPath, selfContained: true });
      stops.push(() => service.stop());
      bindings.mcp = service.bindings();
      evidence.mcp = { service, port: MCP_PORT, logDir: mcpDir, scripts: scenario.mcp?.scripts ?? null,
        browser: opensBrowser(scenario) ? service.browserLaunch().pathDir : null };
    }
  } catch (error) {
    for (const stop of stops.reverse()) await stop().catch(() => {});
    throw error;
  }
  return {
    bindings: Object.keys(bindings).length ? bindings : null,
    llm,
    /** The environment the app (A, A2) or Host (B) starts with: an MCP OAuth scenario's stand-in browser first on PATH. */
    appEnv: env => (evidence.mcp?.browser ? browserPath(env, evidence.mcp.browser) : env),
    /**
     * Before a capture (ahead of N-013): MCP HTTP/SSE requests have ended; before the last one
     * (`after`) the stdio children have exited too (README G3 接线 6). A child alive mid-session
     * is the scenario's state, not a finding. Not idle in time is recorded, not an error.
     */
    async settle(phase) {
      if (!evidence.mcp) return null;
      const { service } = evidence.mcp;
      const started = Date.now();
      let idle;
      if (phase === 'after') idle = await service.whenIdle(WAIT_DEADLINE_MS);
      else {
        while (service.openCount() && Date.now() - started < QUIET.maxMs) await new Promise(resolve => setTimeout(resolve, QUIET.pollMs));
        idle = service.openCount() === 0;
      }
      return { mcp: { phase, idle, open: service.openCount(), liveStdio: service.liveStdio().length, waitedMs: Date.now() - started } };
    },
    /** Request logs and the remote end state, recorded before the services stop. */
    record: () => ({
      llmRequests: llm ? structuredClone(llm.service.requests) : null,
      ...(evidence.llm ? { llmService: evidence.llm } : {}),
      ...(evidence.cloud ? { cloud: { seed: evidence.cloud.seed, faults: evidence.cloud.faults, ports: evidence.cloud.ports,
        requests: evidence.cloud.service.requests(), finalSnapshot: evidence.cloud.service.snapshot() } } : {}),
      // Server-side evidence only: stdio pids and session numbers vary between runs.
      ...(evidence.mcp ? { mcp: { port: evidence.mcp.port, logDir: evidence.mcp.logDir, scripts: evidence.mcp.scripts, records: evidence.mcp.service.records() } } : {}),
      ...(evidence.search ? { search: { port: evidence.search.service.port, searxng: evidence.search.searxng, requests: evidence.search.service.requests() } } : {}),
    }),
    async stop() { for (const stop of stops.reverse()) await stop(); },
  };
}

/** `${ns.a.b}` bindings (ns: llm, provider, cloud, mock, mcp, search) as exact JSON (strings as is); null when the path is not bound. */
export function lookupBinding(bindings, path) {
  let value = bindings;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = value[key];
  }
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text === undefined ? null : parseExact(text);
}
