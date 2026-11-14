#!/usr/bin/env node
/**
 * 打包版冒烟：启动 electron-builder 产出的 `.app`（不是 dev Electron + 源码），在隔离数据目录里验证
 * 冷启动、Host 插件、原生模块（SQLite / koffi）、FSRS WASM 与一次本地假 LLM 流式对话。
 *
 *   node electron/scripts/__tests__/packaged-smoke.mjs [--app "<path>/Deep Student.app"] [--keep]
 *
 * - 仓库内的 `.app` 先 `ditto` 到仓库外临时目录再启动：仓库内运行时 Node 会沿父目录找到 W06/node_modules，
 *   掩盖包内缺失的依赖。
 * - 不能用 Playwright `_electron.launch`：它依赖 Node `--inspect`，被 EnableNodeCliInspectArguments 熔丝禁用；
 *   这里用 Chromium `--remote-debugging-port` + `connectOverCDP` 驱动渲染进程。
 * - 隔离方式与 W12 冒烟（host/e2e/smoke/support/app.ts）一致；外网请求走不可路由代理。
 * - SEC-E02：开发用变量（`electron/shell/launch-env.ts` 的 DEV_ONLY_ENV）全部指向金丝雀后启动，任何一个生效都会
 *   留下痕迹或让其余检查失败。
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DEV_ONLY_ENV, MAC_NATIVE_CACHE_ENV } from '../../shell/launch-env.ts';
import { auditLaunchEnvironment } from '../launch-env-audit.mjs';
import { defaultSourceApp, isInside, isolatedEnv, prepareApp, readAppFile, workBase } from '../packaged-app.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const REPLY_CHUNKS = ['你好，', '我是本地', '假模型。', ' SMOKE-REPLY-', 'OK'];
const REPLY_TEXT = REPLY_CHUNKS.join('');
const API_KEY = 'sk-smoke-local';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const keep = argv.includes('--keep');
const sourceApp = resolve(opt('--app') ?? defaultSourceApp());

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function startFakeLlm() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      const rec = { path: req.url, authorization: req.headers.authorization ?? null, body, finished: false };
      requests.push(rec);
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-chat', object: 'model' }] }));
        return;
      }
      const model = body?.model ?? 'fake-chat';
      const id = `chatcmpl-packaged-${Date.now()}`;
      if (body?.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: '冒烟标题' }, finish_reason: 'stop' }] }));
        rec.finished = true;
        return;
      }
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(chunk({ role: 'assistant', content: '' }));
      for (const text of REPLY_CHUNKS) {
        await sleep(40);
        res.write(chunk({ content: text }));
      }
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
      rec.finished = true;
    });
  });
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => {
    resolveServer({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      chatRequests: () => requests.filter((r) => r.path?.endsWith('/chat/completions') && r.body?.stream === true),
      close: () => new Promise((r) => server.close(() => r())),
    });
  }));
}

const CANARY = 'W06-SEC-E02-CANARY';

/** 每个开发变量一个金丝雀：Host 入口写标记文件、开发 URL 记录访问、前端目录 / profile / migrations 都是假的。 */
async function startDevOverrides(root) {
  const dir = join(root, 'dev-overrides');
  for (const sub of ['dist', 'migrations', 'capabilities']) mkdirSync(join(dir, sub), { recursive: true });
  const marker = join(dir, 'host-entry-ran');
  writeFileSync(join(dir, 'host-entry.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\n`);
  writeFileSync(join(dir, 'profile.json'), '{ "plugins": [] }\n');
  writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html><title>${CANARY}</title>\n`);
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>${CANARY}</title>\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = {
    DS_HOST_ENTRY: join(dir, 'host-entry.mjs'),
    DS_HOST_PROFILE: join(dir, 'profile.json'),
    DS_ELECTRON_DEV_URL: `http://127.0.0.1:${server.address().port}/`,
    DS_ELECTRON_FRONTEND_DIST: join(dir, 'dist'),
    // The app must ignore this missing config rather than fail at startup.
    DS_ELECTRON_DEV_CONFIG: join(dir, 'missing-app-config.json'),
    DS_ELECTRON_CAPTURE: join(dir, 'capture.png'),
    DS_ELECTRON_CAPTURE_DELAY_MS: '0',
    DS_MIGRATIONS_DIR: join(dir, 'migrations'),
    DS_CAPABILITIES_DIR: join(dir, 'capabilities'),
    NODE_COMPILE_CACHE: join(dir, 'compile-cache'),
    NODE_COMPILE_CACHE_PORTABLE: '1',
  };
  const missing = DEV_ONLY_ENV.filter((name) => !(name in env));
  if (missing.length > 0) throw new Error(`no SEC-E02 canary for ${missing.join(', ')}`);
  return { env, marker, hits, close: () => new Promise((r) => server.close(() => r())) };
}

/** 进程及其全部子孙 pid（Host utilityProcess、renderer、GPU 等）。 */
function processTree(pid) {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map();
  for (const line of out.trim().split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  const all = [pid];
  for (let i = 0; i < all.length; i += 1) all.push(...(children.get(all[i]) ?? []));
  return all;
}

/** 进程树已映射的 `.node` 原生模块（lsof 列出 dlopen 的文件），返回相对包内 `Contents` 的路径。 */
function loadedNativeModules(pid, contentsDir) {
  const pids = processTree(pid).join(',');
  let out = '';
  try { out = execFileSync('lsof', ['-p', pids, '-Fn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (error) { out = error.stdout ?? ''; }
  const contents = realpathSync(contentsDir);
  return [...new Set(out.split('\n').filter((l) => l.startsWith('n') && l.endsWith('.node')).map((l) => l.slice(1)))]
    .map((file) => (isInside(file, contents) ? relative(contents, file) : `OUTSIDE:${file}`)).sort();
}

function findLogDir(root) {
  const logs = join(root, 'data.os', 'home', 'Library', 'Logs');
  if (!existsSync(logs)) return null;
  for (const name of readdirSync(logs)) if (existsSync(join(logs, name, 'deep-student.log'))) return join(logs, name);
  return null;
}

function query(dbFile, sql) {
  const dir = mkdtempSync(join(dirname(dbFile), '.smoke-query-'));
  try {
    const copy = join(dir, 'copy.db');
    copyFileSync(dbFile, copy);
    if (existsSync(`${dbFile}-wal`)) copyFileSync(`${dbFile}-wal`, `${copy}-wal`);
    const out = execFileSync('sqlite3', ['-json', copy, sql], { encoding: 'utf8' }).trim();
    return out === '' ? [] : JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function findAppPage(browser) {
  return waitFor('the app window', async () => {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (await page.evaluate(() => Boolean(globalThis.__TAURI_INTERNALS__)).catch(() => false)) return page;
      }
    }
    return null;
  }, 90_000);
}

async function invoke(page, cmd, args = {}, timeoutMs = 20_000) {
  const outcome = await page.evaluate(async ({ cmd, args, timeoutMs }) => {
    let timer;
    const result = await Promise.race([
      globalThis.__TAURI_INTERNALS__.invoke(cmd, args).then(
        (value) => ({ kind: 'result', value: value === undefined ? null : value }),
        (error) => ({ kind: 'error', error: error instanceof Error ? `${error.name}: ${error.message}` : error })),
      new Promise((r) => { timer = setTimeout(() => r({ kind: 'timeout' }), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return result;
  }, { cmd, args, timeoutMs });
  if (outcome.kind !== 'result') throw new Error(`${cmd} did not resolve: ${JSON.stringify(outcome)}`);
  return outcome.value;
}

async function passFirstRun(page) {
  await page.getByRole('button', { name: /我已阅读并同意|I have read and agree/ }).click({ timeout: 60_000 });
  await page.getByTestId('wb-dock').waitFor({ state: 'visible', timeout: 30_000 });
  const browse = page.getByRole('button', { name: /先随便看看|Just look around first/ });
  const skip = page.getByTestId('wb-empty-tour-skip');
  const deadline = Date.now() + 45_000;
  let quietSince = 0;
  while (Date.now() < deadline) {
    if (await browse.isVisible().catch(() => false)) {
      await browse.click({ timeout: 3_000 }).catch(() => undefined);
      quietSince = 0;
    } else if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 3_000 }).catch(() => undefined);
      quietSince = 0;
    } else if (quietSince === 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince > 2_500) {
      return;
    }
    await sleep(200);
  }
  throw new Error('first-run dialogs did not settle within 45s');
}

async function configureFakeModel(page, baseUrl) {
  const vendors = await invoke(page, 'get_vendor_configs');
  await invoke(page, 'save_vendor_configs', {
    configs: [...vendors.filter((v) => v.id !== 'smoke-vendor'), {
      id: 'smoke-vendor', name: 'Smoke Local', providerType: 'general', authMode: 'api_key',
      apiProtocol: 'openai_chat_completions', baseUrl, apiKey: API_KEY, apiKeys: [API_KEY],
    }],
  });
  const profiles = await invoke(page, 'get_model_profiles');
  await invoke(page, 'save_model_profiles', {
    profiles: [...profiles.filter((p) => p.id !== 'smoke-model'), {
      id: 'smoke-model', vendorId: 'smoke-vendor', label: 'Smoke Fake Chat', model: 'fake-chat', modelAdapter: 'general',
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false, supportsTools: true,
      contextWindow: 1_048_576,
    }],
  });
  const assignments = await invoke(page, 'get_model_assignments');
  await invoke(page, 'save_model_assignments', { assignments: { ...assignments, model2_config_id: 'smoke-model' } });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('packaged smoke currently drives the macOS .app only');
  const { appPath, contentsDir, executable } = prepareApp(sourceApp);
  const root = mkdtempSync(join(workBase(), 'run-'));
  console.log(`app: ${appPath}\nroot: ${root}`);

  const llm = await startFakeLlm();
  const dev = await startDevOverrides(root);
  const started = performance.now();
  const child = spawn(executable, ['--remote-debugging-port=0'], { cwd: root, env: isolatedEnv(root, dev.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  let browser = null;
  let completed = false;
  try {
    const wsEndpoint = await waitFor('the DevTools endpoint', () => {
      if (exited) throw new Error(`app exited early: ${JSON.stringify(exited)}\n${stderr.slice(-2000)}`);
      return /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] ?? null;
    }, 60_000, 100);
    browser = await chromium.connectOverCDP(wsEndpoint);
    const page = await findAppPage(browser);
    const firstWindowMs = Math.round(performance.now() - started);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // 1. 冷启动：Host 就绪且 profile 内插件全部安装（status 只列出未安装的插件）。
    const profile = JSON.parse(readAppFile(contentsDir, 'host/profiles/desktop.json'));
    const degraded = await invoke(page, 'plugin:host|status', {}, 90_000);
    const hostReadyMs = Math.round(performance.now() - started);
    check('cold start: window + Host ready', Array.isArray(degraded), `first window ${firstWindowMs}ms, Host ready ${hostReadyMs}ms`);
    check('cold start: every profile plugin installed', Array.isArray(degraded) && degraded.length === 0 && profile.plugins.length >= 39,
      `${profile.plugins.length - (degraded?.length ?? 0)}/${profile.plugins.length} installed${degraded?.length ? `; degraded ${JSON.stringify(degraded)}` : ''}`);
    const title = await page.title();
    check('SEC-E02: window loads the bundled frontend (dev URL / frontend dist ignored)',
      page.url().startsWith('tauri://localhost/') && title !== CANARY && dev.hits.length === 0, `${page.url()} title ${JSON.stringify(title)}, dev URL hits ${dev.hits.length}`);
    await passFirstRun(page);

    // 2. 原生模块：进程树真实 dlopen 的 .node 必须都来自包内。
    const natives = loadedNativeModules(child.pid, contentsDir);
    const outside = natives.filter((n) => n.startsWith('OUTSIDE:'));
    check('native: every loaded .node comes from the bundle', natives.length > 0 && outside.length === 0, outside.join(', '));
    check('native: koffi loaded (main process, browser occlusion)', natives.some((n) => /koffi/.test(n)), natives.filter((n) => /koffi/.test(n)).join(', '));
    check('native: better-sqlite3 loaded (Host)', natives.some((n) => /node_modules\/better-sqlite3\/.+\.node$/.test(n)), natives.filter((n) => /sqlite/.test(n)).join(', '));

    // 3. SQLite 读写 + FSRS WASM：建卡 → 入队 → 预览间隔 → 评分，再从 mistakes.db 读回。
    const saved = await invoke(page, 'save_anki_cards', {
      request: { document_id: 'packaged-smoke', options: null, cards: [{ id: null, front: 'PKG 正面', back: 'PKG 背面', text: null, tags: ['pkg'], images: [], fields: { Front: 'PKG 正面', Back: 'PKG 背面' }, template_id: null }] },
    });
    const queued = await invoke(page, 'fsrs_enqueue_cards', { ankiCardIds: saved.savedIds });
    const due = await invoke(page, 'fsrs_get_due', { limit: 50 });
    const stateId = queued.states?.[0]?.id;
    check('sqlite: cards saved, queued and read back', saved.failed.length === 0 && saved.savedIds.length === 1 && queued.enqueued === 1
      && due.some((d) => d.ankiCardId === saved.savedIds[0]), `card ${saved.savedIds[0]}, state ${stateId}`);
    const preview = await invoke(page, 'fsrs_preview_intervals', { cardStateId: stateId });
    const rated = await invoke(page, 'fsrs_rate', { cardStateId: stateId, rating: 3, durationMs: 1234 });
    const slots = JSON.parse(readFileSync(join(root, 'data', 'slots', 'state.json'), 'utf8'));
    const logs = query(join(root, 'data', 'slots', slots.active, 'mistakes.db'), `select id, rating from fsrs_review_logs where id = '${rated.logId}'`);
    check('wasm: FSRS preview and rate computed', preview !== null && typeof preview === 'object' && rated.cardState?.reps === 1 && rated.cardState.state !== 0,
      `preview ${JSON.stringify(preview).slice(0, 160)}; after Good: state=${rated.cardState?.state} stability=${rated.cardState?.stability}`);
    check('sqlite: review log persisted in mistakes.db', logs.length === 1 && logs[0].rating === 3, `log ${rated.logId}`);

    // 3b. worker_threads 从包内加载 .ts 入口（asar 内也必须可用）：存储工作池与诊断包导出。
    const tags = await invoke(page, 'notes_list_tags');
    check('worker: storage worker pool (notes_list_tags)', Array.isArray(tags), JSON.stringify(tags));
    const bundle = join(root, 'diagnostics.zip');
    await invoke(page, 'export_diagnostics_bundle', { options: { destination: bundle, includeDebugLogs: false } }, 60_000);
    check('worker: diagnostics bundle export', existsSync(bundle) && statSync(bundle).size > 0, existsSync(bundle) ? `${statSync(bundle).size} bytes` : 'no file');

    // 4. LLM：经 UI 发送一条消息，假 LLM 流式回复完整渲染。
    await configureFakeModel(page, llm.baseUrl);
    await page.getByTestId('wb-dock-item-chat').click({ timeout: 15_000 });
    const input = page.getByTestId('input-bar-v2-textarea').first();
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.fill('你好，打包冒烟');
    await page.getByTestId('btn-send').first().click();
    await page.getByText(REPLY_TEXT).first().waitFor({ state: 'visible', timeout: 60_000 });
    const [request] = llm.chatRequests();
    check('llm: streamed reply rendered', llm.chatRequests().length === 1 && request.authorization === `Bearer ${API_KEY}`
      && request.body.model === 'fake-chat' && request.finished, `${llm.chatRequests().length} streaming request(s)`);
    await page.screenshot({ path: join(root, 'chat.png') });

    // 5. 日志：主日志与壳日志无 ERROR。
    await sleep(1_000);
    const logDir = findLogDir(root);
    const mainLog = logDir ? readFileSync(join(logDir, 'deep-student.log'), 'utf8') : '';
    const shellLog = logDir && existsSync(join(logDir, 'electron-main.log')) ? readFileSync(join(logDir, 'electron-main.log'), 'utf8') : '';
    const errors = [...mainLog.split('\n'), ...shellLog.split('\n')].filter((l) => /\[ERROR\]|\bERROR\b/.test(l));
    check('logs: main log exists', mainLog.length > 0, logDir ?? 'no log dir');
    // 隔离数据目录名是 `data`：Host 与外壳都按 DS_APP_IDENTIFIER 拼 app_log_dir，两份日志才在同一目录。
    const identifier = JSON.parse(readAppFile(contentsDir, 'resources/app/tauri.conf.json')).identifier;
    check('logs: shell log beside the Host log under the bundle identifier', logDir !== null && basename(logDir) === identifier && shellLog.length > 0, logDir ?? 'no log dir');
    check('logs: no ERROR in main/shell logs', errors.length === 0, errors.slice(0, 5).join(' | '));
    const shellLines = [...mainLog.split('\n'), ...shellLog.split('\n'), ...stdout.split('\n')];
    const audit = auditLaunchEnvironment(stdout, child.pid, MAC_NATIVE_CACHE_ENV,
      DEV_ONLY_ENV.filter((name) => !MAC_NATIVE_CACHE_ENV.includes(name)));
    check('SEC-E02: native and JS deletion audit covers every ignored development variable', audit.ok,
      `native: ${audit.native || 'missing'}; JS: ${audit.js || 'missing'}`);
    const profileLine = shellLines.find((l) => l.includes('[host] profile '));
    check('SEC-E02: Host entry, Host profile and capture overrides ignored',
      !existsSync(dev.marker) && !existsSync(dev.env.DS_ELECTRON_CAPTURE) && profileLine !== undefined && profileLine.endsWith('/Resources/app.asar/host/profiles/desktop.json'),
      `host entry canary ${existsSync(dev.marker) ? 'RAN' : 'not run'}; capture ${existsSync(dev.env.DS_ELECTRON_CAPTURE) ? 'WRITTEN' : 'absent'}; ${profileLine ?? 'no profile line'}`);
    const compileCache = join(root, 'userdata', 'host-compile-cache');
    check('SEC-E02: Host compile cache under userData, inherited NODE_COMPILE_CACHE ignored',
      !existsSync(dev.env.NODE_COMPILE_CACHE) && existsSync(compileCache),
      `canary dir ${existsSync(dev.env.NODE_COMPILE_CACHE) ? 'CREATED' : 'absent'}; ${compileCache} ${existsSync(compileCache) ? 'present' : 'missing'}`);
    const warnings = [...mainLog.split('\n'), ...shellLog.split('\n')].filter((l) => /\[WARN\]|:warning\]/.test(l));
    writeFileSync(join(root, 'report.json'), `${JSON.stringify({ app: appPath, firstWindowMs, hostReadyMs, natives, pageErrors, warnings, results }, null, 2)}\n`);
    console.log(`native modules loaded: ${natives.length}\nwarnings: ${warnings.length}\npage errors: ${pageErrors.length}`);
    for (const w of warnings.slice(0, 20)) console.log(`  WARN ${w.slice(0, 240)}`);
    for (const e of pageErrors.slice(0, 10)) console.log(`  PAGEERROR ${e.slice(0, 240)}`);
    completed = true;
  } finally {
    await browser?.close().catch(() => undefined);
    if (!exited) {
      child.kill('SIGTERM');
      await waitFor('app exit', () => exited, 20_000).catch(() => child.kill('SIGKILL'));
    }
    await llm.close();
    await dev.close();
    writeFileSync(join(root, 'stdout.log'), stdout);
    writeFileSync(join(root, 'stderr.log'), stderr);
    if (!keep && completed && results.every((r) => r.ok)) rmSync(root, { recursive: true, force: true });
    else if (!completed) console.error(`artifacts kept: ${root}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length || keep ? ` (artifacts: ${root})` : ''}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`packaged smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
