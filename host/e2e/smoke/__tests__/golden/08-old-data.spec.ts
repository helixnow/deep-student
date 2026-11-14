/**
 * Cold start on old data. The data root is built from the closest available old-data fixture, X7's
 * `historical-wp013-v1` seed (host/e2e/data-compat): the five refinery databases replayed from the Rust SQL
 * migrations with every refinery database one migration behind, plus the pinned historical audit /
 * sync_state / workspace-v1 owner databases, each with explicit Unicode/i64 seed rows
 * (`support/build-old-data.ts`).
 *
 * Two layouts are launched: the slot layout (`slots/slotA`) and the pre-slot layout (databases directly
 * under the data root), which DataSpaceManager must move into slotA. Either way the pending migrations must
 * be applied, no seeded row may be lost, and the old notes and chat session must be visible in the app.
 * Gaps between this fixture and a real old install are listed in W12-PROGRESS.md.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, newRoot, osHomeOf, repoRoot, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { dismissWelcome, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

interface NoteRow { id: string; title: string; content_md: string }
type Counts = Record<string, number>;
interface OldData {
  latest: Record<string, number>;
  seeds: Record<string, Counts>;
  owners: { audit: Counts; workspace: Counts; sync_state: Counts };
  workspaceFile: string;
  localStorage: Record<string, string>;
}

const dbFile = (slot: string, db: string) => (db === 'vfs' ? join(slot, 'databases/vfs.db') : join(slot, `${db}.db`));
const rowCount = (file: string, table: string) => query<{ n: number }>(file, `SELECT count(*) AS n FROM "${table}"`)[0]!.n;

for (const layout of ['slots', 'pre-slot'] as const) {
  test.describe.serial(`⑧ cold start on old data (${layout} layout)`, () => {
    let app: LaunchedApp;
    let old: OldData;
    let hostReadyMs = 0;

    test.beforeAll(async () => {
      const root = newRoot(`old-data-${layout}`);
      old = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'host/e2e/smoke/__tests__/support/build-old-data.ts'), root, layout],
        { encoding: 'utf8' })) as OldData;
      app = await launchApp({ root });
      const started = performance.now();
      await waitForBridge(app.page);
      await app.call('plugin:host|status', {}, 90_000);
      hostReadyMs = Math.round(app.launchMs + performance.now() - started);
    });
    test.afterAll(async () => {
      await app?.close();
    });

    test('pending migrations are applied and no seeded row is lost', async () => {
      test.info().annotations.push({ type: `old-data-${layout}-timing`, description: `first window ${Math.round(app.launchMs)}ms, host ready ${hostReadyMs}ms` });
      const slot = activeSlotDir(app.dataDir);
      expect(slot.endsWith(join('slots', 'slotA'))).toBe(true);
      if (layout === 'pre-slot') {
        expect(readdirSync(app.dataDir).filter((n) => n.endsWith('.db') || n === 'databases' || n === 'workspaces'),
          'legacy root entries are moved into slotA').toEqual([]);
      }
      const versions: Record<string, string> = {};
      for (const [db, latest] of Object.entries(old.latest)) {
        const file = dbFile(slot, db);
        const v = query<{ v: number }>(file, 'SELECT max(version) AS v FROM refinery_schema_history')[0]!.v;
        versions[db] = `${v}/${latest}`;
        expect(v, `${db} migrated to the latest refinery version`).toBe(latest);
        for (const [table, n] of Object.entries(old.seeds[db]!)) expect(rowCount(file, table), `${db}.${table} keeps its seeded rows`).toBeGreaterThanOrEqual(n);
      }
      const owners = {
        audit: join(slot, 'databases/audit.db'),
        workspace: join(slot, old.workspaceFile),
        sync_state: join(osHomeOf(app.root), 'Library', 'Application Support', 'deep-student', 'sync', 'sync_state.db'),
      };
      for (const [owner, file] of Object.entries(owners) as Array<[keyof typeof owners, string]>) {
        for (const [table, n] of Object.entries(old.owners[owner])) expect(rowCount(file, table), `${owner}.${table} keeps its seeded rows`).toBeGreaterThanOrEqual(n);
      }
      test.info().annotations.push({ type: `old-data-${layout}-versions`, description: JSON.stringify(versions) });
    });

    test('old notes and chat sessions are visible after the upgrade', async () => {
      const notes = await app.call<NoteRow[]>('notes_list', {});
      expect(notes.map((n) => n.title)).toContain('中文笔记📚');
      expect((await app.call<NoteRow>('notes_get', { id: 'note_old' })).content_md).toContain('旧用户内容');
      const sessions = await app.call<Array<{ id: string; title: string | null }>>('chat_v2_list_sessions', { status: 'active' });
      expect(sessions.map((s) => s.title)).toContain('旧会话📚');

      // The old user accepted the agreement before; the Tauri WebView localStorage is carried into the renderer.
      const agreement = app.page.getByRole('button', { name: /我已阅读并同意|I have read and agree/ });
      await expect(app.page.getByTestId('wb-dock')).toBeVisible({ timeout: 60_000 });
      await expect(agreement).toBeHidden();
      for (const [key, value] of Object.entries(old.localStorage)) {
        const migrated = await app.page.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key);
        expect(migrated, `localStorage ${key} migrated from WKWebView`).toBe(value);
      }
      await dismissWelcome(app.page);

      await app.mark('old-data-ui');
      await openDockApp(app.page, 'notes');
      await expect(app.page.getByText('中文笔记📚').first()).toBeVisible({ timeout: 30_000 });
      expect(describeFailures(collectHealth(app, ['old-data-ui']))).toBe('');
    });

    test('the upgrade boot (with a pending WebView migration) logs no error', async () => {
      // The migration page is served with CSP `default-src 'none'` (electron/shell/protocols.ts:150); the preload's
      // drag-region CSS must not trip it (W06 58cf4104 injects it with webFrame.insertCSS instead of a <style>).
      expect(describeFailures(collectHealth(app, ['boot']))).toBe('');
    });
  });
}
