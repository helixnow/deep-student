/**
 * Closing the main window (audit V04-02). Rust `lib.rs:1714-1783`: on the main window's `CloseRequested`, if an
 * enabled scheduled task exists (`chat_v2.automation_background_enabled` != "false", `automations.rs:4779-4792`),
 * the Super session is on, or the quick assistant stays resident, the window is hidden (`prevent_close` + `hide`)
 * and "Deep Student 正在后台运行" is shown unless the notification policy is `never`; otherwise macOS exits.
 * The Dock (macOS `Reopen`, `lib.rs:3270-3285`) and a second launch (`lib.rs:695-701`) bring the window back;
 * an explicit quit (`ExitRequested`, `lib.rs:3249-3252`) is never intercepted. Rust has no tray icon.
 *
 * W23 `electron/shell/background-residency.ts` and W06's production lifecycle wiring are integrated in
 * 891d75ed. These assertions exercise the actual window-close and Host residency chain.
 *
 * The OS notification surface is recorded in the main process instead of being shown (like the file dialogs in
 * `support/dialogs.ts`); the close itself is the BrowserWindow `close()` the title-bar button performs.
 */
import { expect, test, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isolatedEnv, launchApp, repoRoot, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

const NOTICE_TITLE = 'Deep Student 正在后台运行';
const AUTOMATION_REASON = '已启用的定时任务会继续按计划执行。';
const REMINDER = 'SMOKE-RESIDENCY-REMINDER';

interface WindowState { destroyed: boolean; visible: boolean; focused: boolean }

async function recordNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { __w12Notifications?: Array<{ title: string; body: string }> };
    g.__w12Notifications = [];
    Notification.prototype.show = function show(this: { title: string; body: string }) {
      g.__w12Notifications!.push({ title: this.title, body: this.body });
    };
  });
}

async function notifications(app: ElectronApplication): Promise<Array<{ title: string; body: string }>> {
  return app.evaluate(() => (globalThis as unknown as { __w12Notifications?: Array<{ title: string; body: string }> }).__w12Notifications ?? []);
}

/** The window the page lives in, as the title-bar close button and the Dock see it. */
async function mainWindow(app: LaunchedApp): Promise<WindowState> {
  const handle = await app.app.browserWindow(app.page);
  return handle.evaluate((win) => ({ destroyed: win.isDestroyed(), visible: !win.isDestroyed() && win.isVisible(), focused: !win.isDestroyed() && win.isFocused() }));
}

async function closeMainWindow(app: LaunchedApp): Promise<void> {
  const handle = await app.app.browserWindow(app.page);
  await handle.evaluate((win) => { win.close(); });
}

/** Taken from the child process captured at launch: Playwright drops its handle once the app is gone. */
function exited(child: ChildProcess): { code: number | null; signal: NodeJS.Signals | null } | null {
  return child.exitCode === null && child.signalCode === null ? null : { code: child.exitCode, signal: child.signalCode };
}

/** Local `HH:MM` and `YYYY-MM-DD` of the first whole minute at least 40 s away. */
function onceSlot(): { date: string; time: string; at: number } {
  const at = new Date(Date.now() + 40_000);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}`, at: at.getTime() };
}

test.describe('⑯ closing the main window (V04-02)', () => {
  test('with no background condition, closing the main window quits the app (macOS exit, lib.rs:1774-1780)', async () => {
    const app = await launchApp({ label: 'residency-off' });
    const child = app.app.process();
    try {
      await waitForBridge(app.page);
      await app.call('plugin:host|status', {}, 90_000);
      await passFirstRun(app.page);
      await waitForIpcIdle(app);
      await app.mark('residency-off');
      expect(await app.call('get_setting', { key: 'quick_assistant.background_enabled' })).toBeNull();
      expect(await app.call('get_setting', { key: 'super_agent.enabled' })).toBeNull();
      // A fresh library has only the built-in heartbeat (`auto_heartbeat_default`), disabled.
      const { automations } = await app.call<{ automations: Array<{ id: string; enabled: boolean }> }>('chat_v2_automation_list', {});
      expect(automations.filter((a) => a.enabled), 'no enabled scheduled task').toEqual([]);
      expect(describeFailures(collectHealth(app, ['residency-off']))).toBe('');
      await recordNotifications(app.app);

      await closeMainWindow(app);
      await expect.poll(() => exited(child), { timeout: 20_000, message: 'the app kept running after its only window closed' }).toEqual({ code: 0, signal: null });
      const wire = app.wire();
      expect(wire.some((r) => r.kind === 'host-shutdown-complete'), 'the Host was shut down in order').toBe(true);
      expect(wire.some((r) => r.kind === 'host-exit' && r.code === 0)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test.describe.serial('with an enabled scheduled task', () => {
    let app: LaunchedApp;
    let child: ChildProcess;
    let automationId = '';
    let slot: ReturnType<typeof onceSlot>;

    test.beforeAll(async () => {
      app = await launchApp({ label: 'residency-on' });
      child = app.app.process();
      await waitForBridge(app.page);
      await app.call('plugin:host|status', {}, 90_000);
      await passFirstRun(app.page);
      await waitForIpcIdle(app);
    });
    test.afterAll(async () => {
      await app?.close();
    });

    test('[V04-02] closing the main window hides it, notifies once, and the app, the Host and the schedule keep running', async () => {
      slot = onceSlot();
      const created = await app.call<{ id: string }>('chat_v2_automation_create', { request: {
        name: REMINDER, prompt: REMINDER, actionType: 'notify',
        schedule: { kind: 'once', date: slot.date, time: slot.time },
      } });
      automationId = created.id;
      expect(automationId).not.toBe('');
      await app.mark('residency-close');
      await recordNotifications(app.app);

      await closeMainWindow(app);
      await new Promise((resolve) => { setTimeout(resolve, 3_000); });
      expect(exited(child), 'the app is still running').toBeNull();
      expect(await mainWindow(app)).toEqual({ destroyed: false, visible: false, focused: false });
      await expect.poll(() => notifications(app.app)).toEqual([{ title: NOTICE_TITLE, body: AUTOMATION_REASON }]);
      expect(await app.call('plugin:host|status', {})).toBeTruthy();

      // The once-task fires while the window stays hidden (scheduler poll 15 s, automation-runtime.ts:30): a notify
      // task's reminder is the "自动化：<name>" notification with its prompt, never suppressed
      // (automation-runtime.ts:340-350), and the run finishes as `success`.
      type Run = { status?: string };
      const finished = async () => (await app.call<{ runs: Run[] }>('chat_v2_automation_runs', { automationId, limit: 5 })).runs
        .filter((r) => r.status !== 'running' && r.status !== 'queued');
      await expect.poll(async () => (await finished()).length,
        { timeout: Math.max(0, slot.at - Date.now()) + 60_000, intervals: [5_000], message: 'the scheduled task did not run while the window was hidden' })
        .toBeGreaterThan(0);
      const runs = await finished();
      test.info().annotations.push({ type: 'runs', description: JSON.stringify(runs).slice(0, 600) });
      expect(runs.map((r) => r.status), 'one successful run of the once-task').toEqual(['success']);
      await expect.poll(() => notifications(app.app)).toContainEqual({ title: `自动化：${REMINDER}`, body: expect.stringContaining(REMINDER) });
      expect(await mainWindow(app), 'still hidden after the run').toMatchObject({ destroyed: false, visible: false });
      expect(exited(child)).toBeNull();
    });

    test('[V04-02] the Dock (macOS Reopen) and a second launch bring the hidden window back; an explicit quit is not intercepted', async () => {
      expect(exited(child), 'precondition: the app survived the previous close').toBeNull();
      expect(await mainWindow(app), 'precondition: hidden by the previous close').toMatchObject({ destroyed: false, visible: false });
      // The once-task disabled itself after its run; a daily task keeps a background condition for the closes below.
      await app.call('chat_v2_automation_create', { request: {
        name: 'SMOKE-RESIDENCY-DAILY', prompt: 'SMOKE-RESIDENCY-DAILY', actionType: 'notify', schedule: { kind: 'daily', time: '03:00' },
      } });
      await app.app.evaluate(({ app: electronApp }) => { electronApp.emit('activate', {}, false); });
      await expect.poll(() => mainWindow(app)).toMatchObject({ destroyed: false, visible: true });

      await closeMainWindow(app);
      await expect.poll(() => mainWindow(app)).toMatchObject({ destroyed: false, visible: false });
      // The production entry on the same data: runApp() loses the single-instance lock and quits
      // (electron/shell/bootstrap.ts:42-44); the running instance gets `second-instance`.
      const require = createRequire(import.meta.url);
      // boundary-allow native-import: the electron package only yields the binary path the second instance runs; no Electron API is used here.
      const second = spawn(require('electron') as string, [join(repoRoot, 'electron/main.ts')],
        { cwd: app.root, env: isolatedEnv(app.root), stdio: 'ignore' });
      try {
        await expect.poll(() => mainWindow(app), { timeout: 30_000, message: 'a second launch did not bring the window back' })
          .toMatchObject({ destroyed: false, visible: true });
        await expect.poll(() => second.exitCode !== null || second.signalCode !== null, { timeout: 30_000, message: 'the second instance kept running' }).toBe(true);
      } finally {
        if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL');
      }
      expect(exited(child)).toBeNull();

      await app.app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
      await expect.poll(() => exited(child), { timeout: 20_000, message: 'an explicit quit was intercepted' }).toEqual({ code: 0, signal: null });
    });
  });
});
