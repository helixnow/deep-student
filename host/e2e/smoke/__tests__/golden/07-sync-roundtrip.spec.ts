/**
 * Sync round trip: two isolated data roots act as devices A and B against one local WebDAV server
 * (`support/fake-webdav.ts`). Each device configures the server from Settings › 数据治理 › 同步 (cloud settings
 * editor: endpoint, credentials, root, end-to-end encryption password, 测试连接, 保存配置); A presses 上传,
 * B presses 下载, and B must then hold A's records. The uploaded objects must not contain plaintext.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callsFromWire, launchApp, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { IMPLEMENTED_METHODS, startFakeWebDav, type FakeWebDav } from '../support/fake-webdav.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { navigateSettingsTab } from '../support/renderer.ts';

const SYNC_ROOT = 'smoke-sync';
const E2EE_PASSWORD = 'Smoke-Sync-E2EE-2026!';
const BODIES: Record<string, string> = { 'SYNC-NOTE-1': 'SYNC-BODY-ONE 第一条', 'SYNC-NOTE-2': 'SYNC-BODY-TWO 第二条' };
/** `notes_list` rows carry no body; `notes_get` does. */
interface NoteRow { id: string; title: string; content_md: string }
interface SyncResult { success?: boolean; error_message?: string | null; skipped_changes?: number; [key: string]: unknown }

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

async function startDevice(label: string): Promise<LaunchedApp> {
  const app = await launchApp({ label });
  await waitForBridge(app.page);
  await app.call('plugin:host|status', {}, 90_000);
  await passFirstRun(app.page);
  return app;
}

/** Open Settings › 数据治理 › 同步 and publish the WebDAV config through the cloud settings editor. */
async function configureCloud(app: LaunchedApp, dav: FakeWebDav): Promise<void> {
  const { page } = app;
  await app.mark('sync-configure');
  await page.getByTestId('wb-dock-item-settings').click();
  await expect(focused(page).locator('[data-wb-settings-active-tab]').first()).toBeVisible();
  const win = focused(page);
  const openEditor = win.getByRole('button', { name: /^(去配置云存储|打开云存储设置)$/ }).first();
  await expect.poll(async () => {
    await navigateSettingsTab(page, { tab: 'data-governance', dataGovernanceTab: 'sync' });
    return openEditor.isVisible();
  }).toBe(true);
  await openEditor.click();
  const endpoint = win.locator('#webdav-endpoint');
  await expect(endpoint).toBeVisible();
  await endpoint.fill(dav.url);
  await win.locator('#webdav-username').fill(dav.username);
  await win.locator('#webdav-password').fill(dav.password);
  await win.locator('#cloud-storage-root').fill(SYNC_ROOT);
  await win.locator('#cloud-encryption-password').fill(E2EE_PASSWORD);
  await win.getByRole('button', { name: /^测试连接$/ }).click();
  await expect(page.getByText(/连接成功/).first()).toBeVisible({ timeout: 30_000 });
  await win.getByRole('button', { name: /^保存配置$/ }).click();
  await expect(page.getByText(/配置已保存/).first()).toBeVisible({ timeout: 30_000 });
}

/** Once sync ran, its state database lives under the data root's OS home and `$HOME` stays untouched. */
function expectSyncStateIsolated(app: LaunchedApp): void {
  expect(existsSync(join(app.osHomeDir, 'Library', 'Application Support', 'deep-student', 'sync', 'sync_state.db')),
    'sync_state.db not under <DS_APP_DATA_DIR>.os/home').toBe(true);
  expect(readdirSync(app.homeDir), 'nothing may be written to $HOME once DS_APP_DATA_DIR is set').toEqual([]);
}

function lastSyncResult(app: LaunchedApp): { outcome: string; body: unknown } | null {
  const call = callsFromWire(app.wire()).filter((c) => c.cmd === 'data_governance_run_sync_with_progress' && c.outcome !== 'pending').at(-1);
  return call ? { outcome: call.outcome, body: call.body } : null;
}

async function runSync(app: LaunchedApp, button: '上传' | '下载'): Promise<SyncResult> {
  const { page } = app;
  await app.mark(`sync-${button === '上传' ? 'upload' : 'download'}`);
  const before = callsFromWire(app.wire()).filter((c) => c.cmd === 'data_governance_run_sync_with_progress').length;
  // The settings window may have been closed by the editor; reach the sync tab again.
  await navigateSettingsTab(page, { tab: 'data-governance', dataGovernanceTab: 'sync' });
  const trigger = focused(page).getByRole('button', { name: new RegExp(`^${button}$`) });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await expect.poll(() => callsFromWire(app.wire()).filter((c) => c.cmd === 'data_governance_run_sync_with_progress').length,
    { message: `${button} did not start a sync` }).toBeGreaterThan(before);
  await expect.poll(() => lastSyncResult(app)?.outcome ?? 'pending', { timeout: 120_000, message: `${button} sync did not finish` }).not.toBe('pending');
  const result = lastSyncResult(app)!;
  const body = result.body as { kind?: string; data?: string } | undefined;
  const parsed = body?.kind === 'json' && body.data !== undefined ? JSON.parse(body.data) as SyncResult : { success: false, error_message: JSON.stringify(result.body) };
  test.info().annotations.push({ type: `sync-${button}`, description: JSON.stringify(parsed).slice(0, 1500) });
  expect(result.outcome, JSON.stringify(result.body)).toBe('result');
  return parsed;
}

test.describe.serial('⑦ sync round trip over WebDAV', () => {
  let dav: FakeWebDav;
  let deviceA: LaunchedApp;
  let deviceB: LaunchedApp | undefined;
  let notesA: NoteRow[] = [];

  test.beforeAll(async () => {
    dav = await startFakeWebDav();
    deviceA = await startDevice('sync-a');
  });
  test.afterAll(async () => {
    if (deviceA) writeFileSync(join(deviceA.root, 'dav-requests.json'), `${JSON.stringify(dav.requests, null, 2)}\n`);
    await deviceA?.close();
    await deviceB?.close();
    await dav?.close();
  });

  test('device A configures WebDAV from Settings and uploads its records', async () => {
    for (const [title, content_md] of Object.entries(BODIES)) {
      await deviceA.call('notes_create', { note: { title, content_md, tags: ['smoke'] } });
    }
    notesA = await deviceA.call<NoteRow[]>('notes_list', {});
    expect(notesA.map((n) => n.title).sort()).toEqual(['SYNC-NOTE-1', 'SYNC-NOTE-2']);

    await configureCloud(deviceA, dav);
    const result = await runSync(deviceA, '上传');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.skipped_changes ?? 0).toBe(0);

    const objects = dav.objects();
    test.info().annotations.push({ type: 'dav-objects', description: objects.map((o) => `${o.path}:${o.size}`).join(' ') });
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((o) => o.path.startsWith(`dav/${SYNC_ROOT}/`))).toBe(true);
    const leaked = objects.filter((o) => /SYNC-BODY|SYNC-NOTE/.test(dav.read(o.path)!.toString('latin1'))).map((o) => o.path);
    expect(leaked, 'end-to-end encryption is on: no uploaded object may contain note plaintext').toEqual([]);
    expect(dav.requests.filter((r) => !IMPLEMENTED_METHODS.includes(r.method)).map((r) => `${r.method} ${r.path}`), 'unimplemented WebDAV method').toEqual([]);
    expectSyncStateIsolated(deviceA);
    expect(describeFailures(collectHealth(deviceA, ['sync-configure', 'sync-upload']))).toBe('');
  });

  test('device B configures the same WebDAV root, downloads, and holds exactly A\'s notes', async () => {
    deviceB = await startDevice('sync-b');
    expect(await deviceB.call<NoteRow[]>('notes_list', {})).toEqual([]);
    await configureCloud(deviceB, dav);
    const result = await runSync(deviceB, '下载');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.skipped_changes ?? 0).toBe(0);

    const notesB = await deviceB.call<NoteRow[]>('notes_list', {});
    const shape = (rows: NoteRow[]) => rows.map((n) => ({ id: n.id, title: n.title })).sort((a, b) => a.title.localeCompare(b.title));
    expect(shape(notesB)).toEqual(shape(notesA));
    for (const note of notesA) {
      expect((await deviceB.call<NoteRow>('notes_get', { id: note.id })).content_md.trim()).toBe(BODIES[note.title]);
    }
    expectSyncStateIsolated(deviceB);
    expect(describeFailures(collectHealth(deviceB, ['sync-configure', 'sync-download']))).toBe('');
  });
});
