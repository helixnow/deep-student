/**
 * FE-A3 (W17): a Host plugin that fails to install is reported degraded and its paired UI half renders
 * `FeatureUnavailablePanel` instead of a broken view. The data root carries a valid user profile that
 * replaces `dstu.anki` with `__fixtures__/degraded-anki-plugin.ts` (its `apply` throws), so the kernel
 * isolates the failure per plugin and the rest of the app boots normally.
 *
 * Both desktop surfaces for the cards hub are checked: the Workbench app (product default) and the classic
 * shell view (the surface `dstu.ui.shell` pairs with `dstu.anki`).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, newRoot, repoRoot, type LaunchedApp } from '../support/app.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { dispatchWindowEvent, openDockApp } from '../support/renderer.ts';

/** Thrown by `__fixtures__/degraded-anki-plugin.ts`. */
const DEGRADED_ANKI_REASON = 'W12 smoke: dstu.anki apply failed on purpose';

/** FeatureUnavailablePanel: an `h2` title with a sibling "暂不可用" badge, the reason and a "查看详情" button. */
async function expectPanel(app: LaunchedApp, title: string): Promise<void> {
  const panel = app.page.locator('div').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
    .filter({ has: app.page.getByText('暂不可用', { exact: true }) })
    .filter({ has: app.page.getByRole('button', { name: '查看详情' }) }).last();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(DEGRADED_ANKI_REASON, { exact: false })).toBeVisible();
}

test.describe.serial('⑫ degraded Host plugin → FeatureUnavailablePanel (FE-A3)', () => {
  let app: LaunchedApp;

  test.beforeAll(async () => {
    const root = newRoot('host-degraded');
    mkdirSync(join(root, 'data', 'plugins'), { recursive: true });
    writeFileSync(join(root, 'data', 'plugins', 'user.profile.json'), `${JSON.stringify({
      extends: 'official',
      plugins: [{ id: 'dstu.anki', module: join(repoRoot, 'host/e2e/smoke/__fixtures__/degraded-anki-plugin.ts') }],
    }, null, 2)}\n`);
    app = await launchApp({ root });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('the Host reports dstu.anki degraded and keeps the rest of the profile', async () => {
    const degraded = await app.call<Array<{ id: string; reason: string }>>('plugin:host|status', {});
    const anki = degraded.find((d) => d.id === 'dstu.anki');
    expect(anki?.reason).toContain(DEGRADED_ANKI_REASON);
    expect(degraded.map((d) => d.id)).not.toContain('dstu.notes');
    expect(await app.invoke('get_anki_stats', {})).toMatchObject({ kind: 'error' });
    expect(app.mainLog()).not.toMatch(/falling back to the official profile/);
    await expect(app.page.getByTestId('wb-dock')).toBeVisible();
  });

  test('the Workbench flashcards app shows FeatureUnavailablePanel', async () => {
    // #22 (RF-W09-workbench-cards-host-degraded): the cards-hub windows used to show their empty dashboard
    // ("卡片库还是空的") while every anki command answered "Command not found", which reads as lost cards.
    await app.mark('degraded-workbench');
    await openDockApp(app.page, 'flashcards');
    await expectPanel(app, '闪卡');
  });

  test('the classic shell flashcards view shows FeatureUnavailablePanel', async () => {
    await app.mark('degraded-classic');
    await dispatchWindowEvent(app.page, 'workbench:mode-changed', { enabled: false });
    await expect(app.page.getByTestId('wb-dock')).toHaveCount(0, { timeout: 15_000 });
    await app.page.getByRole('button', { name: '闪卡', exact: true }).first().click();
    await expectPanel(app, '闪卡');
    expect(app.pageErrors, 'degraded view rendered without uncaught renderer errors').toEqual([]);
  });
});
