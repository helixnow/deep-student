/**
 * Golden path ①: cold start on an empty data root. The main window must reach the workbench desktop, the
 * Host must install the whole desktop profile, and neither the IPC wire, the renderer console nor the
 * Host main log may carry an error.
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findMainLog, launchApp, repoRoot, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures, saveHealth, type Health } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

const profile = JSON.parse(readFileSync(join(repoRoot, 'host/profiles/desktop.json'), 'utf8')) as { plugins: unknown[] };

test.describe.serial('① cold start', () => {
  let app: LaunchedApp;
  let health: Health;

  test.beforeAll(async () => {
    app = await launchApp({ label: 'cold-start' });
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('empty data root boots to the workbench desktop with the whole Host profile', async () => {
    const { page } = app;
    await waitForBridge(page);
    const degraded = await app.call<unknown[]>('plugin:host|status', {}, 90_000);
    expect(degraded, 'plugin:host|status lists plugins the profile failed to install').toEqual([]);

    const wire = app.wire();
    const hostStart = wire.find((r) => r.kind === 'host-start');
    const ready = wire.find((r) => r.kind === 'host-in' && r.message?.kind === 'ready');
    const profileFailed = wire.filter((r) => r.kind === 'host-in' && r.message?.event === 'host://plugin-profile-failed');
    expect(ready, 'Host never sent ready').toBeDefined();
    expect(profileFailed).toEqual([]);
    expect(wire.filter((r) => r.kind === 'host-exit'), 'Host process exited during startup').toEqual([]);

    await passFirstRun(page);
    await expect(page.locator('[data-wb-desktop]')).toBeVisible();
    await expect(page.getByTestId('wb-dock-item-chat')).toBeVisible();
    await page.screenshot({ path: join(app.root, 'cold-start-desktop.png') });

    const timing = {
      firstWindowMs: Math.round(app.launchMs),
      hostReadyMs: hostStart && ready ? Math.round(ready.time - hostStart.time) : null,
      profilePlugins: profile.plugins.length,
    };
    test.info().annotations.push({ type: 'timing', description: JSON.stringify(timing) });
    test.info().annotations.push({ type: 'artifacts', description: app.root });

    // Let deferred startup work (update probe, indexers) settle before judging health.
    await page.waitForTimeout(3_000);
    health = collectHealth(app);
    saveHealth(app, 'cold-start', health);
    expect(describeFailures(health), 'IPC / console / page / main-log errors during cold start').toBe('');
    for (const call of health.externalBlocked) {
      expect(call.cmd, 'only the shell http plugin may try to leave the machine (update probe)').toBe('plugin:http|fetch_send');
    }
  });

  test('every user-data location stays inside the isolated root', () => {
    const log = findMainLog(app.root);
    expect(log, 'Host main log not under <DS_APP_DATA_DIR>.os/home').not.toBeNull();
    expect(existsSync(join(app.dataDir, '.device_id'))).toBe(true);
    expect(existsSync(join(app.dataDir, 'slots', 'state.json'))).toBe(true);
    expect(readFileSync(log!, 'utf8')).toContain(app.dataDir);
    // sync_state.db is opened on first sync use only (Rust `open_default()` inside sync commands; W08 ca0c332b),
    // so a cold start creates no sync dir anywhere. Its isolation is asserted once sync runs (⑦).
    expect(existsSync(join(app.osHomeDir, 'Library', 'Application Support', 'deep-student', 'sync')),
      'cold start must not open sync_state eagerly').toBe(false);
    expect(readdirSync(app.homeDir), 'nothing may be written to $HOME once DS_APP_DATA_DIR is set').toEqual([]);
  });

  test('Host gate enumerates every profile plugin (runtime.plugins())', () => {
    const gate = spawnSync(process.execPath, [join(repoRoot, 'host/e2e/smoke/run.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, DS_SMOKE_STARTUP_ONLY: '1', DS_SMOKE_RUNTIME: 'electron', DEEP_STUDENT_BUILD_NUMBER: process.env.DEEP_STUDENT_BUILD_NUMBER ?? '20000' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    test.info().annotations.push({ type: 'host-gate', description: gate.stdout.trim().split('\n').join(' / ') });
    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    const match = /startup (\d+)\/(\d+)/.exec(gate.stdout);
    expect(match?.[1]).toBe(String(profile.plugins.length));
    expect(match?.[2]).toBe(String(profile.plugins.length));
  });

  test('quick assistant initialises in the production bundle', () => {
    // Regression guard for W09 3592a356: a `.then()` chained on a destructured dynamic import let Vite's
    // dynamic-import tree-shaking drop getQuickAssistantConfig, so the shortcut never registered (the Tauri
    // production bundle has the same bug).
    expect(health.consoleWarnings.filter((w) => w.includes('[QuickAssistant] initialization failed'))).toEqual([]);
  });
});
