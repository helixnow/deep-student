/**
 * Golden path ⑤: export an encrypted backup ZIP from Settings › 数据治理 › 备份, change the data, import the ZIP
 * from the same page, restore it, relaunch, and get exactly the exported data back.
 *
 * Runs with X1's recorded process hooks (`X1_RECORD_PROCESS_HOOKS=1`): a restart requested after restore is
 * recorded instead of relaunching an Electron instance outside Playwright's control.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callsFromWire, launchApp, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { answerNextOpenDialog, answerNextSaveDialog, dialogCalls } from '../support/dialogs.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { navigateSettingsTab } from '../support/renderer.ts';

const PASSWORD = 'Smoke-Backup-Pass-2026!';
interface NoteRow { id: string; title: string; content_md: string }
interface Job { status: string; result?: { success?: boolean; stats?: Record<string, unknown> } | null }

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

/** The job id returned by the last renderer call of `cmd` (the UI starts jobs; the test only observes). */
function lastJobId(app: LaunchedApp, cmd: string): string | null {
  const call = callsFromWire(app.wire()).filter((c) => c.cmd === cmd && c.outcome === 'result').at(-1);
  const body = call?.body as { kind?: string; data?: string } | undefined;
  if (body?.kind !== 'json' || body.data === undefined) return null;
  return (JSON.parse(body.data) as { job_id?: string }).job_id ?? null;
}

async function waitForJob(app: LaunchedApp, cmd: string): Promise<Job> {
  await expect.poll(() => lastJobId(app, cmd), { message: `${cmd} was not started by the UI` }).not.toBeNull();
  const jobId = lastJobId(app, cmd)!;
  let job: Job = { status: 'unknown' };
  await expect.poll(async () => {
    job = await app.call<Job>('data_governance_get_backup_job', { jobId });
    return job.status;
  }, { timeout: 60_000, message: `${cmd} job did not finish` }).toMatch(/^(completed|failed|cancelled)$/);
  return job;
}

test.describe.serial('⑤ backup export / import', () => {
  let app: LaunchedApp;
  let root = '';
  let zip = '';
  let noteA: NoteRow;

  test.beforeAll(async () => {
    app = await launchApp({ label: 'backup', env: { X1_RECORD_PROCESS_HOOKS: '1' } });
    root = app.root;
    zip = join(root, 'export', 'smoke-backup.zip');
    mkdirSync(join(root, 'export'), { recursive: true });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    noteA = await app.call<NoteRow>('notes_create', { note: { title: 'BACKUP-NOTE-A', content_md: 'alpha body', tags: [] } });
    await app.page.getByTestId('wb-dock-item-settings').click();
    // Settings listens for SETTINGS_NAVIGATE_TAB only once mounted (it first restores its last tab).
    await expect(focused(app.page).locator('[data-wb-settings-active-tab]').first()).toBeVisible();
    const exportPassword = focused(app.page).locator('#e2ee-export-password');
    await expect.poll(async () => {
      await navigateSettingsTab(app.page, { tab: 'data-governance', dataGovernanceTab: 'backup' });
      return exportPassword.isVisible();
    }).toBe(true);
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('an encrypted backup ZIP is exported from Settings', async () => {
    const win = focused(app.page);
    await app.mark('backup-export');
    // Keep the export out of the backup list so the imported copy is the only restorable entry later.
    const addToList = win.getByRole('switch', { name: /同时加入备份列表/ }).or(win.getByRole('checkbox', { name: /同时加入备份列表/ }));
    if ((await addToList.getAttribute('aria-checked')) === 'true' || (await addToList.isChecked().catch(() => false))) await addToList.click();
    await win.locator('#e2ee-export-password').fill(PASSWORD);
    // The snapshot barrier refuses settings reads while it holds mistakes.db (same as Rust get_conn_safe), so
    // let the Settings page finish loading its keys before exporting, as a user would.
    await waitForIpcIdle(app);
    await answerNextSaveDialog(app, zip);
    await win.getByRole('button', { name: /^导出备份$/ }).click();
    const job = await waitForJob(app, 'data_governance_backup_and_export_zip');
    expect(job.status, JSON.stringify(job)).toBe('completed');
    expect(existsSync(zip)).toBe(true);
    expect(statSync(zip).size).toBeGreaterThan(0);
    expect(await dialogCalls(app)).toEqual([{ kind: 'save', answer: zip }]);
    expect(describeFailures(collectHealth(app, ['backup-export']))).toBe('');
  });

  test('the ZIP is imported back from Settings as a restorable backup', async () => {
    await app.call('notes_create', { note: { title: 'BACKUP-NOTE-B', content_md: 'beta body', tags: [] } });
    await app.call('notes_delete', { id: noteA.id });
    expect((await app.call<NoteRow[]>('notes_list', {})).map((n) => n.title)).toEqual(['BACKUP-NOTE-B']);

    const { page } = app;
    await app.mark('backup-import');
    await focused(page).getByRole('button', { name: /^导入$/ }).click();
    // Workbench windows are role=dialog too; take the one holding the import password field.
    const dialog = page.getByRole('dialog').filter({ has: page.locator('#e2ee-import-password') }).last();
    await dialog.locator('#e2ee-import-password').fill(PASSWORD);
    await answerNextOpenDialog(app, [zip]);
    await dialog.getByRole('button', { name: /^导入$/ }).click();
    const job = await waitForJob(app, 'data_governance_import_zip');
    expect(job.status, JSON.stringify(job)).toBe('completed');
    expect(job.result?.stats).toMatchObject({ restorable: true });
    const backups = await app.call<Array<{ path: string; restorable: boolean }>>('data_governance_get_backup_list', {});
    expect(backups).toHaveLength(1);
    expect(backups[0]?.restorable).toBe(true);
    expect(describeFailures(collectHealth(app, ['backup-import']))).toBe('');
  });

  test('restoring the imported backup brings back exactly the exported data', async () => {
    const { page } = app;
    await app.mark('backup-restore');
    // A finished import offers "备份导入完成 — 是否立即恢复此备份？"; take its "立即恢复".
    await page.getByRole('button', { name: /^立即恢复$/ }).click();
    const job = await waitForJob(app, 'data_governance_restore_backup');
    expect(job.status, JSON.stringify(job)).toBe('completed');
    expect(describeFailures(collectHealth(app, ['backup-restore']))).toBe('');

    await app.close();
    app = await launchApp({ root, env: { X1_RECORD_PROCESS_HOOKS: '1' } });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    const notes = await app.call<NoteRow[]>('notes_list', {});
    expect(notes.map((n) => n.title)).toEqual(['BACKUP-NOTE-A']);
    expect((await app.call<NoteRow>('notes_get', { id: noteA.id })).content_md.trim()).toBe('alpha body');
    expect(describeFailures(collectHealth(app))).toBe('');
  });
});
