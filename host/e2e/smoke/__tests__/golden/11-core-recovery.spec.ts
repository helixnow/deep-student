/**
 * Core recovery startup (W08, Rust lib.rs core-recovery branch): an existing install whose active-slot
 * `databases/vfs.db` is no longer a SQLite file. The startup migration as a whole returns Ok, vfs is blocked
 * and chat_v2 / mistakes are skipped behind it; storage raises the maintenance barrier before business
 * plugins are applied. The renderer must show the component recovery screen (`ComponentRecoveryShell`)
 * instead of the desktop, the broken file must stay where it was (never replaced by an empty database),
 * business commands must answer MAINTENANCE_MODE and unaffected databases must keep working.
 */
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir } from '../support/db.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

interface ComponentHealth { component: string; status: string; reason: string | null; dependency: string | null }
interface MaintenanceStatus {
  is_in_maintenance_mode: boolean;
  blocked_components: string[];
  component_health?: { components: ComponentHealth[] };
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test.describe.serial('⑪ core recovery start (corrupt vfs.db)', () => {
  let app: LaunchedApp;
  let vfsFile = '';
  let corruptHash = '';

  test.beforeAll(async () => {
    const first = await launchApp({ label: 'core-recovery' });
    await waitForBridge(first.page);
    await first.call('plugin:host|status', {}, 90_000);
    await passFirstRun(first.page);
    await first.close();

    vfsFile = join(activeSlotDir(first.dataDir), 'databases', 'vfs.db');
    for (const side of ['-wal', '-shm']) rmSync(`${vfsFile}${side}`, { force: true });
    writeFileSync(vfsFile, Buffer.alloc(8192, 0x5a));
    corruptHash = sha256(vfsFile);

    app = await launchApp({ root: first.root });
    await waitForBridge(app.page);
    await app.mark('core-recovery');
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('the renderer shows the component recovery screen instead of the desktop', async () => {
    const { page } = app;
    await expect(page.getByText('部分数据库升级未能安全完成')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Deep Student 数据恢复')).toBeVisible();
    await expect(page.getByText('数据文件仍在原位置，没有被当作空数据覆盖', { exact: false })).toBeVisible();
    // RF-W09-recovery-reason-localized: the Chinese UI shows Rust's Chinese sentence with the underlying error verbatim;
    // the IPC reason stays English (next test).
    await expect(page.getByText(/^数据库 vfs 升级失败：Database error: file is not a database。/)).toBeVisible();
    await expect(page.getByTestId('wb-dock')).toHaveCount(0);

    // RF-W09-recovery-shell-tab-roles: the two views are a named tablist with selectable tabs and labelled panels.
    test.info().annotations.push({ type: 'recovery-text', description: (await page.locator('body').innerText()).slice(0, 1500) });
    const tabs = page.getByRole('tablist', { name: '部分数据库升级未能安全完成' });
    await expect(tabs.getByRole('tab', { name: '组件状态' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: '组件状态' })).toBeVisible();
    await tabs.getByRole('tab', { name: '下一步' }).click();
    await expect(tabs.getByRole('tab', { name: '下一步' })).toHaveAttribute('aria-selected', 'true');
    const nextStep = page.getByRole('tabpanel', { name: '下一步' });
    await expect(nextStep.getByRole('button', { name: '重启并重试' })).toBeVisible();
    await expect(nextStep.getByRole('button', { name: '导出诊断报告' })).toBeVisible();
    expect(app.pageErrors, 'recovery screen rendered without uncaught renderer errors').toEqual([]);
  });

  test('the Host reports maintenance, blocks business commands and keeps unaffected databases', async () => {
    const status = await app.call<MaintenanceStatus>('data_governance_get_maintenance_status', {});
    expect(status.is_in_maintenance_mode).toBe(true);
    expect(status.blocked_components).toEqual(['main', 'manager', 'vfs', 'chat_v2']);
    const vfs = status.component_health?.components.find((c) => c.component === 'vfs');
    expect(vfs?.status).toBe('blocked');
    expect(vfs?.reason).toMatch(/^Database 'vfs' migration failed: Database error: file is not a database\./);

    expect(await app.call<{ recovery_required: boolean }>('get_startup_recovery_status', {})).toMatchObject({ recovery_required: false });
    const notes = await app.invoke('notes_list', {});
    expect(notes).toMatchObject({
      kind: 'error',
      error: { error_type: 'Database', message: 'MAINTENANCE_MODE: notes is temporarily unavailable', details: { code: 'MAINTENANCE', component: 'notes' } },
    });
    expect(await app.call('llm_usage_summary', {})).toMatchObject({ totalRequests: 0 });

    const degraded = await app.call<Array<{ id: string; reason: string }>>('plugin:host|status', {});
    expect(degraded.map((d) => d.id)).toContain('dstu.notes');
    for (const id of ['dstu.platform.storage', 'dstu.backup', 'dstu.shell']) expect(degraded.map((d) => d.id)).not.toContain(id);
  });

  test('the corrupt core database is left untouched on disk', async () => {
    // The recovery screen promises "数据文件仍在原位置，没有被当作空数据覆盖". This startup takes no snapshot
    // (unreadable versions skip it, Rust coordinator.rs:686-699), so the per-database restore has no trusted
    // snapshot and must not fall back to the first-run one with `copied_files: []`, which Rust
    // (coordinator.rs:965-1046) reads as "did not exist before migration" and deletes vfs.db
    // (RF-W20-restore-stale-snapshot-deletes-db).
    expect(existsSync(vfsFile), 'vfs.db must still exist').toBe(true);
    expect(sha256(vfsFile), 'vfs.db must not be replaced, truncated or migrated').toBe(corruptHash);
    // The migration coordinator runs in a worker; its log lines must reach deep-student.log (W20, was #21).
    const log = app.mainLog();
    expect(log, 'the restore decision is logged').toContain('[MigrationCoordinator] 没有本次迁移前建立的可信快照，未删除或覆盖数据库，原文件保留在原位置');
    expect(log).toContain(vfsFile.replace(/^\/private/, ''));
  });

  test('a relaunch after the recovery start still reports the damaged library', async () => {
    await app.close();
    app = await launchApp({ root: app.root });
    await waitForBridge(app.page);
    await app.mark('core-recovery-relaunch');
    await app.call('plugin:host|status', {}, 90_000);
    const status = await app.call<MaintenanceStatus>('data_governance_get_maintenance_status', {});
    test.info().annotations.push({ type: 'relaunch-maintenance', description: JSON.stringify({ mode: status.is_in_maintenance_mode, blocked: status.blocked_components }) });
    test.info().annotations.push({ type: 'relaunch-notes', description: JSON.stringify(await app.invoke('notes_list', {})).slice(0, 300) });
    expect(status.is_in_maintenance_mode, 'the second start must not open an empty library in place of the damaged one').toBe(true);
    await expect(app.page.getByText('部分数据库升级未能安全完成')).toBeVisible({ timeout: 90_000 });
    await expect(app.page.getByTestId('wb-dock')).toHaveCount(0);
    // The fixed line "数据文件仍在原位置…" is W09's copy (src/locales/zh-CN/data.json); recorded, not asserted.
    test.info().annotations.push({ type: 'relaunch-recovery-text', description: (await app.page.locator('body').innerText()).slice(0, 1500) });
    expect(sha256(vfsFile), 'the relaunch leaves vfs.db untouched too').toBe(corruptHash);
  });
});
