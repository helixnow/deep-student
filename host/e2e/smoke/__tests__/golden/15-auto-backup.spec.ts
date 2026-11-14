/**
 * Automatic backup (audit V04-01, W30 `host/plugins/backup/src/auto-backup-scheduler.ts`). Rust starts
 * `start_auto_backup_scheduler` in setup (`lib.rs:1680-1694`, `backup_config.rs:278-313`): first check 120 s
 * after start, then one check per 3600 s. Each check re-reads `backup.config` and, when the switch is on and
 * `autoBackupIntervalHours` have passed since `backup.last_auto_backup_time` (never → due), writes
 * `auto-backup-YYYYmmdd-HHMMSS.zip` (UTC) without the key material, records the time and
 * `backup.auto_backup_status`, and rotates to `maxBackupCount` (`backup_config.rs:316-628`).
 *
 * The switch is turned on in Settings › 数据治理 › 备份. The relaunch scales only the scheduler's own two delays
 * (120 s → 8 s, 3600 s → 5 s) through the test-only Host entry wrapper `__fixtures__/host-timer-scale.mjs`; the
 * product delays and every other timer are unchanged.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { navigateSettingsTab } from '../support/renderer.ts';

const AUTO_BACKUP_ZIP = /^auto-backup-\d{8}-\d{6}\.zip$/;
const TIMER_SCALE = 'file=auto-backup-scheduler&delays=120000:8000,3600000:5000';
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

/** Every `auto-backup-*.zip` under the data root (the default backup directory lives below it). */
function autoBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) found.push(...autoBackups(path));
    else if (AUTO_BACKUP_ZIP.test(entry.name)) found.push(path);
  }
  return found;
}

test.describe.serial('⑮ automatic backup (V04-01)', () => {
  let app: LaunchedApp;
  let root = '';

  test.beforeAll(async () => {
    app = await launchApp({ label: 'auto-backup' });
    root = app.root;
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('turning on 自动备份 in Settings saves backup.config with the 24 h interval and 5 kept backups', async () => {
    const { page } = app;
    await app.mark('auto-backup-settings');
    await page.getByTestId('wb-dock-item-settings').click();
    await expect(focused(page).locator('[data-wb-settings-active-tab]').first()).toBeVisible();
    const row = focused(page).locator('div.flex.items-center.justify-between').filter({ has: page.getByText('定时自动创建备份', { exact: true }) });
    await expect.poll(async () => {
      await navigateSettingsTab(page, { tab: 'data-governance', dataGovernanceTab: 'backup' });
      return row.getByRole('switch').isVisible();
    }).toBe(true);
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row.getByRole('switch').click();
    await expect(page.getByText('备份设置已保存').first()).toBeVisible();
    await waitForIpcIdle(app);
    const config = JSON.parse(await app.call<string>('get_setting', { key: 'backup.config' })) as Record<string, unknown>;
    expect(config).toMatchObject({ autoBackupEnabled: true, autoBackupIntervalHours: 24, maxBackupCount: 5 });
    await expect(focused(page).getByText('每 24 小时').first()).toBeVisible();
    expect(autoBackups(root), 'nothing is backed up when the switch is turned on (Rust waits for the scheduler)').toEqual([]);
    expect(describeFailures(collectHealth(app, ['auto-backup-settings']))).toBe('');
  });

  test('[V04-01] the scheduler writes one auto-backup ZIP after its first delay and the 24 h interval holds off the next check', async () => {
    await app.close();
    const started = Date.now();
    app = await launchApp({ root, label: 'auto-backup', env: { W12_HOST_TIMER_SCALE: TIMER_SCALE } });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await app.mark('auto-backup-run');

    await expect.poll(() => autoBackups(root).length, { timeout: 60_000, message: 'no auto-backup ZIP was written' }).toBe(1);
    const zip = autoBackups(root)[0]!;
    await expect.poll(async () => app.call<string | null>('get_setting', { key: 'backup.last_auto_backup_time' }),
      { message: 'backup.last_auto_backup_time was not recorded' }).toMatch(RFC3339);
    const last = (await app.call<string>('get_setting', { key: 'backup.last_auto_backup_time' }))!;
    expect(Date.parse(last)).toBeGreaterThanOrEqual(started - 1_000);
    expect(Date.parse(last)).toBeLessThanOrEqual(Date.now());
    const status = JSON.parse(await app.call<string>('get_setting', { key: 'backup.auto_backup_status' })) as Record<string, unknown>;
    test.info().annotations.push({ type: 'auto-backup', description: JSON.stringify({ zip: zip.slice(root.length), last, status }) });
    expect(status).toMatchObject({ lastError: null, lastSuccessAt: expect.stringMatching(RFC3339), lastJobId: expect.any(String) });
    expect(Date.parse(String(status.nextDueAt)) - Date.parse(last), 'next due one interval (24 h) after this backup').toBeGreaterThan(23 * 3_600_000);

    // The key material is stripped from the portable archive (backup_config.rs:496-510).
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(entries.some((e) => /(^|\/)manifest\.json$/.test(e)), entries.slice(0, 20).join(', ')).toBe(true);
    expect(entries.filter((e) => /(^|\/)crypto\//.test(e))).toEqual([]);

    // Two more scaled checks: not due again within 24 h, nothing new is written.
    await app.page.waitForTimeout(12_000);
    expect(autoBackups(root)).toEqual([zip]);
    expect(await app.call('get_setting', { key: 'backup.last_auto_backup_time' })).toBe(last);
    expect(app.mainLog()).toContain('[AutoBackup] 自动备份调度器已启动');
    expect(describeFailures(collectHealth(app, ['auto-backup-run']))).toBe('');
  });
});
