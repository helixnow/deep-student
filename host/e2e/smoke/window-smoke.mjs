#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { artifactRoot, launchWindow, invoke, traceAt, callsFromTrace, save, repo } from './__fixtures__/window-driver.mjs';
import { createDialogAnswer } from './__fixtures__/dialog-answer.mjs';
import { unexpectedIpcFailures } from './__fixtures__/g1-ipc-verdict.ts';

// Enumerate the actual production registries instead of a second hand-maintained route list.
const shellSource = 'src/ui-plugins/official/shell/index.ts';
const settingsSource = 'src/ui-plugins/official/settings/index.ts';
const shellText = readFileSync(join(repo, shellSource), 'utf8').split('const nav:')[0];
const views = [...shellText.matchAll(/\{ id: '([^']+)', contentKey:[^\n]+/g)].map(match => ({
  id: match[1], source: shellSource, declaration: match[0],
  // src/app/navigation/canonicalView.ts:20 redirects the retained registry alias.
  target: match[1] === 'dashboard' ? 'data-management' : match[1],
  gate: match[0].includes('({ dev })') ? 'development-only' : match[0].includes('uiLabEnabled') ? 'ui-lab-enabled' : null,
}));
const settings = [...readFileSync(join(repo, settingsSource), 'utf8').split('const definitions:')[1].matchAll(/\{ id: '([^']+)', group:/g)].map(match => ({ id: match[1], source: settingsSource }));
const workbench = [
  ...['todo', 'skills', 'templates', 'taskDashboard', 'flashcards', 'media', 'settings', 'pomodoro'].map(id => ({ id, source: 'system/register.tsx' })),
  ...['textbook', 'exam', 'translation', 'essay', 'image', 'file'].map(id => ({ id, source: 'content/register.ts',
  })),
  { id: 'chat', source: 'chat/register.ts' }, { id: 'chat-session', source: 'chat/register.ts' },
  { id: 'notes', source: 'notes/register.ts' }, { id: 'files', source: 'files/register.ts' },
  { id: 'file-preview', source: 'preview/register.tsx' },
  { id: 'sandbox', source: 'sandbox/register.tsx' }, { id: 'browser', source: 'browser/register.tsx' },
  { id: 'aiDashboard', source: 'ai-dashboard/register.tsx' },
].map(entry => ({ ...entry, source: `src/features/workbench/apps/${entry.source}` }));
const root = artifactRoot('x1-real-dist');
mkdirSync(join(root, 'routes'));
save(join(root, 'inventory.json'), { views, settings, workbench, auxiliary: ['pomodoro-mini', 'quick-assistant'],
  excluded: { mindmap: 'registerAll.ts explicitly does not import standalone mindmap; notes hosts this resource', desktop: 'virtual agent target, not an app route' } });
process.stdout.write(`Artifacts: ${root}\n`);
const driver = await launchWindow(root);
const { page } = driver;
page.setDefaultTimeout(5_000);
const routes = [];
const probes = [];
const traceReadErrors = [];
const dialogAnswer = createDialogAnswer(driver.application);
let status;
// X1_STAGES=a,b: run only the listed stages (prefix match) for targeted retests under load.
// Boot/onboarding always run; a filtered run is never G1 evidence (summary.g1 = false).
const stageFilter = process.env.X1_STAGES ? process.env.X1_STAGES.split(',').map(s => s.trim()).filter(Boolean) : null;
const stageSelected = id => !stageFilter || /^(boot-|onboarding:)/.test(id) || stageFilter.some(prefix => id.startsWith(prefix));
async function snapshot(id, navigation, selector, gate = null, target = () => page) {
  if (!stageSelected(id)) return;
  await driver.mark(id);
  let navigationError;
  try {
    await navigation();
    if (selector) await target().locator(selector).first().waitFor({ state: 'visible', timeout: 5_000 });
  } catch (error) { navigationError = String(error); }
  // Bounded observation after rendering also catches asynchronous invoke failures.
  await page.waitForTimeout(750);
  const view = target();
  const file = id.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const dom = await view.evaluate(() => ({
    url: location.href, title: document.title, text: document.body.innerText,
    activeViews: [...document.querySelectorAll('[data-view-layer-shell].pointer-events-auto')].map(el => el.getAttribute('data-view-layer-shell')),
    settingsTabs: [...document.querySelectorAll('[data-wb-settings-active-tab]')].map(el => el.getAttribute('data-wb-settings-active-tab')),
    windows: [...document.querySelectorAll('[data-wb-window-id]')].map(el => ({ id: el.getAttribute('data-wb-window-id'),
      label: el.getAttribute('aria-label'), focused: el.getAttribute('data-focused') })),
  }));
  await view.screenshot({ path: join(root, 'routes', `${file}.png`) });
  writeFileSync(join(root, 'routes', `${file}.aria.txt`), await view.locator('body').ariaSnapshot());
  const row = { id, gate, navigationError, ...dom,
    contentState: dom.text.trim() === '…' ? 'waiting-for-main-window-state' : 'observed',
    screenshot: `routes/${file}.png` };
  save(join(root, 'routes', `${file}.json`), row);
  routes.push(row);
}

try {
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__), { timeout: 10_000 });
  status = await invoke(page, 'plugin:host|status', {}, 60_000);
  save(join(root, 'host-status.json'), status);
  await snapshot('boot-landing', async () => {
    await page.getByRole('button', { name: /I have read and agree|我已阅读并同意/ }).waitFor({ timeout: 30_000 });
  });
  await snapshot('onboarding:accept', async () => {
    // Fresh test identity: use the visible production first-run button. Its
    // save_setting invoke stays in the trace; no preseeded acceptance or DOM bypass.
    await page.getByRole('button', { name: /I have read and agree|我已阅读并同意/ }).click();
    await page.locator('[data-view-layer-shell], [data-wb-desktop]').first().waitFor({ timeout: 30_000 });
  });
  await snapshot('onboarding:browse', async () => {
    await page.getByRole('button', { name: /Just look around first|先随便看看/ }).click();
    await page.getByRole('button', { name: /Just look around first|先随便看看/ }).waitFor({ state: 'hidden' });
    await page.getByTestId('wb-empty-tour-skip').click();
  }, '[data-wb-desktop]');

  const focusedWindow = page.locator('[data-wb-window][data-focused="true"]');
  const closeAllWindows = async () => {
    // A maximized app moves the Dock outside the viewport; close stacked windows
    // through their real titlebars, topmost first.
    for (let guard = 0; guard < 6 && await focusedWindow.count(); guard++) {
      const id = await focusedWindow.getAttribute('data-wb-window-id');
      await focusedWindow.locator('.wb-traffic-close').click();
      await page.locator(`[data-wb-window-id="${id}"]`).waitFor({ state: 'hidden' });
    }
  };
  const launch = async appId => {
    await closeAllWindows();
    const panel = page.getByTestId('wb-apps-panel');
    if (await panel.count() === 0 || await panel.getAttribute('data-wb-apps-open') !== 'true') {
      await page.getByTestId('wb-dock-apps-button').click();
    }
    await page.getByTestId(`wb-apps-item-${appId}`).click();
  };
  // Apps kept registered only for prior desktop snapshots (sandbox register.tsx:88–90;
  // textbook/image/file are showInLauncher:false, their resources now open in
  // file-preview, typeMap.ts). Seed a prior snapshot with that window through production
  // save_setting (desktop.workbenchSnapshot) after Workbench flushes its empty layout, then
  // press the empty desktop's real Restore button (WorkbenchDesktop.tsx:486–490, 505–517).
  // Resource windows still pass the real pruneSnapshotWindows existence check.
  const restoreSeededWindow = async window => {
    await closeAllWindows();
    await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: false } })));
    await page.locator('[data-wb-desktop]').waitFor({ state: 'detached' });
    await page.waitForTimeout(2_500);
    const now = Date.now();
    const seeded = await invoke(page, 'save_setting', { key: 'desktop.workbenchSnapshot', value: JSON.stringify({
      version: 1, dockPinned: [], tilingRatios: {},
      windows: [{ frame: { x: 120, y: 80, w: 960, h: 680 }, restoreFrame: null, displayMode: 'floating',
        minimized: false, zIndex: 1, createdAt: now, lastFocusedAt: now, ...window }] }) });
    if (seeded.kind !== 'result') throw new Error(`snapshot seed failed: ${JSON.stringify(seeded)}`);
    await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: true } })));
    await page.locator('[data-wb-desktop]').waitFor();
    // Entering Workbench from a classic view may reopen that view's app; the probed
    // snapshot is already held in memory (restorableSnapshot), so close it first.
    await page.waitForTimeout(1_000);
    await closeAllWindows();
    await page.getByTestId('wb-empty-restore-session').click({ timeout: 10_000 });
    await page.locator(`[data-wb-window-id="${window.id}"]`).waitFor();
  };

  // Real resources for the resource-instance routes: Files > New > Import files… runs the
  // production import chain (importPathsIntoLibrary -> textbooks_add / staged attachment
  // upload). Only the OS file chooser's answer is supplied: Electron's
  // dialog.showOpenDialog returns fixture copies inside this run's isolated root; the
  // shell dialog plugin, its scope grant and every IPC stay production.
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures);
  const fixtureSource = join(repo, 'host/plugins/media/equivalence/fixtures');
  const tone = Buffer.alloc(44 + 1600);
  tone.write('RIFF', 0); tone.writeUInt32LE(36 + 1600, 4); tone.write('WAVEfmt ', 8);
  tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
  tone.writeUInt32LE(8000, 24); tone.writeUInt32LE(16000, 28); tone.writeUInt16LE(2, 32);
  tone.writeUInt16LE(16, 34); tone.write('data', 36); tone.writeUInt32LE(1600, 40);
  const fixtureFiles = {
    textbook: ['x1-g1-textbook.pdf', readFileSync(join(fixtureSource, 'tiny.pdf'))],
    image: ['x1-g1-image.png', readFileSync(join(fixtureSource, 'pixel.png'))],
    file: ['x1-g1-audio.wav', tone],
  };
  for (const [name, bytes] of Object.values(fixtureFiles)) writeFileSync(join(fixtures, name), bytes);
  const imported = {};
  await snapshot('seed:import-resources', async () => {
    await launch('files');
    // Importing auto-opens the first document in File Preview, so address Files by id.
    const files = page.locator(`[data-wb-window-id="${await focusedWindow.getAttribute('data-wb-window-id')}"]`);
    // Installed only in this harness's Electron main process via Playwright (CDP); the
    // production dist has no switch or injection point for it. Every answered call is
    // recorded and its returned files hashed into summary.dialogStub.
    await dialogAnswer.install(Object.values(fixtureFiles).map(([name]) => join(fixtures, name)));
    await files.getByRole('button', { name: /^(New|新建)$/ }).click();
    await page.getByRole('menuitem', { name: /^(Import files…|导入资料…)$/ }).click();
    for (const [kind, [name]] of Object.entries(fixtureFiles)) {
      const item = files.locator('[data-item-id]').filter({ hasText: name.replace(/\.[^.]+$/, '') }).first();
      await item.waitFor({ state: 'attached', timeout: 20_000 });
      imported[kind] = { id: await item.getAttribute('data-item-id'), name };
    }
    await dialogAnswer.capture();
    save(join(root, 'seeded-resources.json'), imported);
  }, '[data-wb-window][data-focused="true"]');

  for (const app of workbench) {
    await snapshot(`workbench:${app.id}`, async () => {
      if (app.gate) throw new Error(`${app.id}: hidden from launcher; requires a resource/session seed (not supplied in empty-data probe)`);
      if (app.id === 'browser') {
        // desktop.workbenchBrowserEnabled is an explicit opt-in (gates.ts); turn it on
        // as a user would, via Settings > Study Desktop > Built-in Browser.
        await launch('settings');
        await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'workbench' } })));
        await focusedWindow.locator('[data-wb-settings-active-tab="workbench"]').waitFor();
        const toggle = focusedWindow.getByRole('switch', { name: /^(Built-in Browser|内置浏览器)$/ });
        if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
        await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', await toggle.elementHandle());
      }
      if (app.id === 'sandbox') {
        await restoreSeededWindow({ id: 'x1-sandbox-seed', typeId: 'sandbox', instanceKey: null, title: 'Sandbox' });
        return;
      }
      if (['textbook', 'image', 'file'].includes(app.id)) {
        const resource = imported[app.id];
        if (!resource?.id) throw new Error(`${app.id}: no imported resource (see seed:import-resources)`);
        await restoreSeededWindow({ id: `x1-${app.id}-seed`, typeId: app.id, instanceKey: resource.id, title: resource.name });
        return;
      }
      if (app.id === 'file-preview') {
        // Production double-click in Files opens textbook/image/file resources in
        // file-preview (typeMap.ts RESOURCE_TYPE_TO_APP_TYPE_ID).
        const resource = imported.textbook;
        if (!resource?.id) throw new Error('file-preview: no imported resource (see seed:import-resources)');
        await launch('files');
        const filesId = await focusedWindow.getAttribute('data-wb-window-id');
        await focusedWindow.locator(`[data-item-id="${resource.id}"]`).dblclick();
        await page.locator(`[data-wb-window][data-focused="true"]:not([data-wb-window-id="${filesId}"])`).waitFor();
        return;
      }
      if (app.id === 'chat-session') {
        // chat/register.ts:338: reachable only from a session row ("Open in New Window",
        // SessionRow.tsx:397). Create a real session with the menu/command-palette event
        // (CHAT_NEW_SESSION -> launchNewChatSession -> chat_v2_create_session), then
        // use that row's context menu.
        await closeAllWindows();
        await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('CHAT_NEW_SESSION')));
        await focusedWindow.waitFor();
        const chatId = await focusedWindow.getAttribute('data-wb-window-id');
        const row = page.locator(`[data-wb-window-id="${chatId}"]`)
          .getByRole('navigation', { name: /^(Conversations|对话)$/ }).getByRole('button').first();
        await row.waitFor({ timeout: 10_000 });
        await row.click({ button: 'right' });
        await page.getByRole('menuitem', { name: /^(Open in New Window|在新窗口打开)$/ }).click();
        await page.locator(`[data-wb-window][data-focused="true"]:not([data-wb-window-id="${chatId}"])`).waitFor();
        return;
      }
      await launch(app.id);
    }, '[data-wb-window][data-focused="true"]', app.gate ?? null);
  }

  // Exercise the classic routes via the same public navigation event used by app components.
  // First record the default desktop; changing its supported UI mode is recorded explicitly.
  await driver.mark('mode:classic');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: false } })));
  for (const view of views) {
    await snapshot(`view:${view.id}`, () => page.evaluate(view => {
      window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view } }));
    }, view.id), `[data-view-layer-shell="${view.target}"].pointer-events-auto`, view.gate);
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'settings' } })));
  // Settings restores its last tab; wait for it to mount and listen before switching tabs.
  await snapshot('settings:mount', () => page.locator('[data-wb-settings-active-tab]').first().waitFor());
  for (const tab of settings) {
    await snapshot(`settings:${tab.id}`, () => page.evaluate(tab => {
      window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab } }));
    }, tab.id), `[data-wb-settings-active-tab="${tab.id}"]`);
  }
  // Auxiliary windows are opened through their production entries so they are
  // real second BrowserWindows fed by the main window (not a main-page goto).
  const auxiliary = async (label, open) => {
    await open();
    // Poll the real Electron windows by URL; the created BrowserWindow is found
    // regardless of whether Playwright's 'window' event raced the creation.
    const deadline = performance.now() + 10_000;
    for (;;) {
      const found = driver.application.windows().find(win => win.url().includes(`window=${label}`));
      if (found) { await found.waitForLoadState('domcontentloaded'); return found; }
      if (performance.now() > deadline) throw new Error(`${label}: no Electron window with ?window=${label} within 10s`);
      await page.waitForTimeout(100);
    }
  };
  let mini;
  await snapshot('window:pomodoro-mini', async () => {
    // A real focus session (pop-out exists only with an active session), started from
    // the classic todo view's PomodoroPanel (TodoMainPanel.tsx:1262) in classic mode.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'todo' } })));
    await page.locator('[data-view-layer-shell="todo"].pointer-events-auto').waitFor({ timeout: 5_000 });
    await page.locator('[data-view-layer-shell="todo"]').getByRole('button', { name: /^(Start focus|开始专注)$/i }).first().click();
    // GlobalPomodoroWidget.tsx:420–426: the pill shows outside the todo host with an active session.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'settings' } })));
    // GlobalPomodoroWidget.tsx:490–495: the pill body is the fixed rounded-full button with the clock.
    const pill = page.locator('button.rounded-full[aria-label]').filter({ hasText: /\d{1,2}:\d{2}/ }).first();
    await pill.hover();
    mini = await auxiliary('pomodoro-mini', () => page.getByRole('button', { name: /Pop out floating window|弹出置顶小窗/ }).click());
    await mini.waitForFunction(() => document.body.innerText.trim() !== '…' && document.body.innerText.trim() !== '', null, { timeout: 5_000 });
  }, '#root > *', null, () => mini ?? page);
  let assistant;
  // Workbench is the default desktop mode; observe the assistant from it as a user would.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbench:mode-changed', { detail: { enabled: true } })));
  await snapshot('window:quick-assistant', async () => {
    // Real copied text first (an empty Xvfb clipboard is a valid rejection the window catches).
    await invoke(page, 'plugin:clipboard-manager|write_text', { text: 'X1 G1 quick assistant clipboard' });
    assistant = await auxiliary('quick-assistant', () => invoke(page, 'quick_assistant_show', {}));
  }, '#root > *', null, () => assistant ?? page);

  await driver.mark('platform-probes');
  const probe = async (plugin, cmd, args, expected) => {
    const outcome = await invoke(page, cmd, args);
    probes.push({ plugin, cmd, args, expected, outcome });
    return outcome;
  };
  await probe('opener', 'plugin:opener|open_url', { url: 'x1-invalid-url' }, 'scope rejection, no external app');
  await probe('notification', 'plugin:notification|is_permission_granted', {}, true);
  await probe('notification', 'plugin:notification|request_permission', {}, 'granted');
  await probe('clipboard', 'plugin:clipboard-manager|write_text', { text: 'WP-041 isolated Xvfb clipboard' }, null);
  await probe('clipboard', 'plugin:clipboard-manager|read_text', {}, 'WP-041 isolated Xvfb clipboard');
  await probe('updater', 'plugin:updater|check', { timeout: -1 }, 'invalid u64; no download/install');
  const handler = await page.evaluate(() => window.__TAURI_INTERNALS__.transformCallback(() => {}));
  const shortcut = 'Control+Alt+Shift+F11';
  await probe('global-shortcut', 'plugin:global-shortcut|register', { shortcuts: [shortcut], handler: `__CHANNEL__:${handler}` }, null);
  await probe('global-shortcut', 'plugin:global-shortcut|is_registered', { shortcut }, true);
  await probe('global-shortcut', 'plugin:global-shortcut|unregister', { shortcuts: [shortcut] }, null);
  await probe('global-shortcut', 'plugin:global-shortcut|is_registered', { shortcut }, false);
  // App-initiated calls still in flight (e.g. the background update check's fetch_send)
  // get a bounded chance to settle, so "pending" means a hang, not the harness closing.
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    let calls = [];
    try { calls = callsFromTrace(traceAt(root)); }
    catch (error) {
      // The writer can be between writes of the final JSONL row. Preserve the
      // exact error before the next bounded observation; final traceAt is strict.
      const failure = { phase: 'drain-inflight', message: String(error), stack: error.stack };
      traceReadErrors.push(failure);
      save(join(root, 'trace-read-errors.json'), traceReadErrors);
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (calls.length && !calls.some(call => call.outcome === 'pending')) break;
    await page.waitForTimeout(500);
  }
} finally { await driver.close(); }

const trace = traceAt(root);
const calls = callsFromTrace(trace);
save(join(root, 'calls.json'), calls);
save(join(root, 'platform-probes.json'), probes);
const contracts = new Map();
for (const file of readdirSync(join(repo, 'contracts/ipc')).filter(name => name.endsWith('.json'))) {
  const contract = JSON.parse(readFileSync(join(repo, 'contracts/ipc', file), 'utf8'));
  for (const cmd of contract.commands ?? []) contracts.set(cmd.name, { lane: cmd.lane ?? contract.lane, rust: cmd.rust });
}
const issues = calls.filter(call => call.outcome !== 'result').map(call => ({ ...call,
  ...(contracts.get(call.cmd) ?? { lane: call.cmd.startsWith('plugin:') ? 'F2-shell' : 'unattributed' }),
}));
save(join(root, 'ipc-issues.json'), issues);
const unexpectedIssues = unexpectedIpcFailures(issues);
save(join(root, 'unexpected-ipc-issues.json'), unexpectedIssues);
const errors = trace.filter(row => row.kind === 'console' && row.level === 'error');
for (const route of routes) {
  const routeTrace = trace.filter(row => row.phase === route.id);
  const routeCalls = calls.filter(call => call.phase === route.id);
  route.consoleErrors = routeTrace.filter(row => row.kind === 'console' && row.level === 'error').length;
  route.invokeFailures = routeCalls.filter(call => call.outcome !== 'result').length;
  const file = route.id.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  save(join(root, 'routes', `${file}.log.json`), { trace: routeTrace, calls: routeCalls, pageErrors: driver.errors.filter(row => row.phase === route.id) });
}
const ready = trace.some(row => row.kind === 'host-in' && row.message.kind === 'ready');
const profileFailed = trace.filter(row => row.kind === 'host-in' && row.message.event === 'host://plugin-profile-failed');
const profile = JSON.parse(readFileSync(join(repo, 'host/profiles/desktop.json'), 'utf8'));
const host = { ready, status, profileFailed, expected: profile.plugins.length,
  installedByProfileOutcome: ready && !profileFailed.length && status.kind === 'result' && Array.isArray(status.value)
    ? profile.plugins.length - status.value.length : null,
  basis: 'HostReady + production profile + real plugin:host|status degraded array; not a direct plugins() enumeration' };
const summary = { root, host, ...dialogAnswer.evidence(), traceReadErrors, stageFilter, routeCount: routes.length, routes, invokeCount: calls.length,
  ipcErrors: issues.length, consoleErrors: errors.length, pageErrors: driver.errors.length,
  unexpectedIpcErrors: unexpectedIssues.length, expectedProbeErrors: issues.length - unexpectedIssues.length,
  g1: !stageFilter && ready && host.installedByProfileOutcome === profile.plugins.length && !errors.length && !driver.errors.length
    && !unexpectedIssues.length
    && routes.every(row => ['development-only', 'ui-lab-enabled'].includes(row.gate)
      || (!row.navigationError && row.contentState === 'observed')) };
save(join(root, 'summary.json'), summary);
process.stdout.write(JSON.stringify({ root, routeCount: summary.routeCount, host, invokeCount: calls.length,
  ipcErrors: issues.length, unexpectedIpcErrors: unexpectedIssues.length, consoleErrors: errors.length, pageErrors: driver.errors.length, g1: summary.g1 }) + '\n');
process.exitCode = summary.g1 ? 0 : 1;
