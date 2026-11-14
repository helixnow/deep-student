/**
 * 浏览器窗口面集成测试专用的 Host 替身（仅测试使用）。
 *
 * 主页面调用 `browser_surface_probe` 后，按 L19 `surface-host.ts` 的 op 名与参数形状
 * 依次请求 F2 的 `browser.*` shell op，把结果写入 `BROWSER_REPORT`。
 * 关键环境变量：BROWSER_REPORT、BROWSER_PAGE_ORIGIN、BROWSER_PROFILE_DIR；
 * BROWSER_SCENARIO=label-taken 时只建一次 browser-content 并记下页面随探测传来的参数。
 */
import { writeFileSync } from 'node:fs';

interface PortLike {
  on(event: 'message', listener: (e: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}

interface ShellResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const parentPort = (process as unknown as {
  parentPort: {
    on(event: 'message', listener: (e: { data: { kind?: string }; ports: PortLike[] }) => void): void;
  };
}).parentPort;

const reportPath = process.env.BROWSER_REPORT;
const origin = process.env.BROWSER_PAGE_ORIGIN;
const localOrigin = process.env.BROWSER_LOCAL_ORIGIN;
const profileDir = process.env.BROWSER_PROFILE_DIR;
const scenario = process.env.BROWSER_SCENARIO;
let started = false;
let port: PortLike | null = null;
let sequence = 0;
const pending = new Map<string, { resolve: (result: ShellResult) => void; timer: ReturnType<typeof setTimeout> }>();
const probes: Array<{ args?: unknown; source?: unknown; headers?: unknown }> = [];
/** browser-content 的原生回调（`dstu-browser://*` frontend-event）。 */
const contentEvents: Array<{ event: unknown; payload: unknown; source: unknown; native: unknown }> = [];

const BRIDGE_SCRIPT = `(function () {
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  function envelope(data) { return { ok: true, v: 1, epoch: 1, data: data }; }
  function state() {
    var layer = document.querySelector('[data-ds-browser-occlusion-layer]');
    var html = document.documentElement;
    var body = document.body;
    return {
      path: window.location.pathname,
      title: document.title,
      clipPath: html.style.clipPath,
      htmlBackground: html.style.background,
      bodyBackground: body.style.background,
      layer: layer !== null,
      layerBackground: layer === null ? null : window.getComputedStyle(layer).backgroundColor
    };
  }
  window.__dsBrowserBridge = {
    snapshot: function (opts) {
      return envelope({ text: JSON.stringify({ state: state(), opts: opts }) });
    },
    click: function (target) { return envelope({ method: 'click', target: target }); },
    type: function (ref, text, opts) {
      return envelope({ method: 'type', ref: ref, text: text, opts: opts });
    },
    setInputFiles: function (ref, files) {
      return envelope({ method: 'setInputFiles', ref: ref, files: files });
    },
    scroll: function (opts) { return envelope({ method: 'scroll', opts: opts }); }
  };
})();`;

function callShell(op: string, args?: unknown): Promise<ShellResult> {
  if (port === null) return Promise.resolve({ ok: false, error: 'host port was not connected' });
  const id = `browser-op-${++sequence}`;
  return new Promise<ShellResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `shell request timed out: ${op}` });
    }, 30_000);
    pending.set(id, { resolve, timer });
    port!.postMessage({ kind: 'shell-request', id, op, args: args ?? {} });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function snapshotState(): Promise<Record<string, unknown>> {
  const result = await callShell('browser.snapshot', { interactiveOnly: true });
  if (!result.ok) return { error: result.error ?? 'snapshot failed' };
  const value = result.value;
  if (typeof value !== 'object' || value === null) return { error: 'snapshot value was not an object' };
  const text = (value as { text?: unknown }).text;
  if (typeof text !== 'string') return { error: 'snapshot text was not a string' };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return { error: `snapshot text was not JSON: ${String(error)}` };
  }
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = { error: 'no snapshot attempt' };
  while (Date.now() < deadline) {
    last = await snapshotState();
    const state = last.state;
    if (typeof state === 'object' && state !== null && (state as { path?: unknown }).path === path) return last;
    await sleep(150);
  }
  return { error: `timed out waiting for ${path}`, last };
}

async function waitForProbe(tag: string, sourceOrigin: string, timeoutMs = 10_000): Promise<{ args?: unknown; source?: unknown; headers?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = probes.find((entry) => {
      const args = entry.args as { tag?: unknown } | undefined;
      const source = entry.source;
      return args?.tag === tag
        && typeof source === 'object' && source !== null
        && (source as { origin?: unknown }).origin === sourceOrigin;
    });
    if (probe !== undefined) return probe;
    await sleep(100);
  }
  return { source: { error: `timed out waiting for origin_probe ${tag} from ${sourceOrigin}` }, headers: null, args: { tag } };
}

async function runScenario(): Promise<Record<string, unknown>> {
  if (reportPath === undefined || origin === undefined || localOrigin === undefined || profileDir === undefined) {
    throw new Error('BROWSER_REPORT, BROWSER_PAGE_ORIGIN, BROWSER_LOCAL_ORIGIN and BROWSER_PROFILE_DIR are required');
  }
  const report: Record<string, unknown> = {};
  // X1 的 filestream_check_access 依赖该 shell op；返回的根目录必须来自隔离的 DS_APP_DATA_DIR。
  report.pdfStreamDirs = await callShell('app.pdfStreamAllowedDirs');
  // Host 业务端可调用的通知命令：成功结果与参数错误都必须经真实 main 的 shellRequest 往返。
  report.notificationPermission = await callShell('plugin:notification|is_permission_granted');
  report.notificationArgError = await callShell('plugin:notification|notify', {});
  report.mainWindowActive = await callShell('app.mainWindowActive');
  report.viewport = await callShell('browser.mainViewportSize');
  report.screenshotBeforeCreate = await callShell('browser.screenshot');
  report.boundsBeforeCreate = await callShell('browser.setContentBounds', { x: 0, y: 0, width: 100, height: 100 });
  report.create = await callShell('browser.createContentWindow', {
    url: `${origin}/a`,
    title: 'Browser probe',
    width: 800,
    height: 600,
    focused: false,
    profileDir,
    initializationScript: BRIDGE_SCRIPT,
  });
  report.createAgain = await callShell('browser.createContentWindow', {
    url: `${origin}/a`,
    title: 'Browser probe',
    width: 800,
    height: 600,
    focused: false,
    profileDir,
    initializationScript: BRIDGE_SCRIPT,
  });
  report.bounds = await callShell('browser.setContentBounds', { x: 40, y: 30, width: 600, height: 400 });
  report.visibility = await callShell('browser.setContentVisibility', { visible: true, focus: false });
  report.pathA = await waitForPath('/a');
  report.originProbe = await waitForProbe('remote', origin);
  report.localNavigate = await callShell('browser.navigate', { url: `${localOrigin}/local-content` });
  report.localPath = await waitForPath('/local-content');
  report.localProbe = await waitForProbe('local', 'null');
  report.remoteNavigate = await callShell('browser.navigate', { url: `${origin}/a` });
  report.remotePath = await waitForPath('/a');
  report.screenshot = await callShell('browser.screenshot');
  report.occlusions = await callShell('browser.setContentOcclusions', {
    occlusions: [{ x: 100, y: 90, width: 120, height: 80 }],
    inputOcclusions: [{ x: 80, y: 70, width: 160, height: 120 }],
  });
  report.occlusionSnapshot = await snapshotState();
  report.clearOcclusions = await callShell('browser.setContentOcclusions', { occlusions: [], inputOcclusions: [] });
  report.clearSnapshot = await snapshotState();
  report.click = await callShell('browser.click', { ref: 'ref-1' });
  report.type = await callShell('browser.typeText', { ref: 'ref-2', text: 'hello' });
  report.inputFiles = await callShell('browser.setInputFiles', {
    ref: 'file-1',
    files: [{ name: 'a.txt', base64: 'YQ==' }],
  });
  report.scroll = await callShell('browser.scroll', { direction: 'down', amount: 300, ref: null });
  report.focus = await callShell('browser.focusContentWindow');
  report.release = await callShell('browser.releaseContentFocus');
  const eventsBeforeB = contentEvents.length;
  report.navigateB = await callShell('browser.navigate', { url: `${origin}/b` });
  report.pathB = await waitForPath('/b');
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.contentEventsB = contentEvents.slice(eventsBeforeB);
  report.back = await callShell('browser.goBack');
  report.pathBack = await waitForPath('/a');
  report.forward = await callShell('browser.goForward');
  report.pathForward = await waitForPath('/b');
  report.reload = await callShell('browser.reload');
  report.pathReload = await waitForPath('/b');
  report.securityNavigate = await callShell('browser.navigate', { url: `${origin}/security` });
  report.securityProbe = await waitForProbe('security', origin);
  report.securityPath = await waitForPath('/security');
  // Agent 控制下的内网地址字面量被外壳拦下（main.ts createAgentGuard → navigation-blocked）。
  const eventsBeforeBlocked = contentEvents.length;
  report.agentGuardOn = await callShell('browser.setAgentNavigationPolicy', { agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
  report.agentBlockedNavigate = await callShell('browser.navigate', { url: 'http://10.255.255.1/agent-blocked' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  report.agentGuardOff = await callShell('browser.setAgentNavigationPolicy', { agentPrivateNetworkGuard: false, agentAllowInsecureHttp: false });
  report.contentEventsBlocked = contentEvents.slice(eventsBeforeBlocked);
  report.hide = await callShell('browser.setContentVisibility', { visible: false, focus: false });
  report.destroy = await callShell('browser.destroyContentWindow');
  report.destroyAgain = await callShell('browser.destroyContentWindow');
  report.afterDestroySnapshot = await callShell('browser.snapshot', { interactiveOnly: true });
  report.afterDestroyScreenshot = await callShell('browser.screenshot');
  report.afterDestroyBounds = await callShell('browser.setContentBounds', { x: 0, y: 0, width: 10, height: 10 });
  report.unknown = await callShell('browser.nope');
  return report;
}

/** 页面已用 `create_webview_window` 占了 browser-content 这个 label。 */
async function runLabelTakenScenario(probeArgs: unknown): Promise<Record<string, unknown>> {
  return {
    page: probeArgs,
    create: await callShell('browser.createContentWindow', {
      url: `${origin}/a`, title: 'Browser probe', width: 800, height: 600, focused: false, profileDir, initializationScript: BRIDGE_SCRIPT,
    }),
    screenshot: await callShell('browser.screenshot'),
  };
}

parentPort.on('message', (event) => {
  if (event.data.kind !== 'connect') return;
  const connected = event.ports[0];
  if (!connected) return;
  port = connected;
  connected.on('message', ({ data }) => {
    switch (data.kind) {
      case 'handshake':
        connected.postMessage({ kind: 'ready', protocol: 1 });
        break;
      case 'shell-result': {
        const id = String(data.id);
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (data.ok === true) entry.resolve({ ok: true, value: data.value });
        else entry.resolve({ ok: false, error: String(data.error) });
        break;
      }
      case 'invoke':
        if (data.cmd === 'origin_probe') {
          probes.push({ args: data.args, source: data.source, headers: data.headers });
          connected.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
        } else if (data.cmd === 'browser_surface_probe' && !started) {
          started = true;
          void (scenario === 'label-taken' ? runLabelTakenScenario(data.args) : runScenario()).then(
            (report) => {
              writeFileSync(reportPath as string, JSON.stringify(report));
              connected.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
            },
            (error: unknown) => {
              writeFileSync(reportPath as string, JSON.stringify({ fatal: String(error) }));
              connected.postMessage({ kind: 'result', id: data.id, ok: false, error: String(error) });
            },
          );
        } else {
          connected.postMessage({ kind: 'result', id: data.id, ok: false, error: `${String(data.cmd)} not allowed. Command not found` });
        }
        break;
      case 'frontend-event':
        if (typeof data.event === 'string' && data.event.startsWith('dstu-browser://')) {
          contentEvents.push({ event: data.event, payload: data.payload, source: data.source, native: data.native });
        }
        break;
      case 'shutdown':
        process.exit(0);
    }
  });
  connected.start();
});
