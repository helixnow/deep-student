/**
 * Build an old-style data root from X7's `historical-wp013-v1` fixtures (host/e2e/data-compat), with every
 * refinery database one migration behind, an accepted user agreement and a legacy Tauri WKWebView
 * localStorage file. Run with plain `node` (native type stripping): the fixtures import
 * Host storage code that Playwright's Babel transform cannot load.
 *
 *   node host/e2e/smoke/__tests__/support/build-old-data.ts <root> <slots|pre-slot>
 *
 * Prints a JSON summary: latest refinery version per database and the seeded row count per table.
 */
// boundary-allow native-import: writes Tauri-era files (settings row, WKWebView localStorage) before the app starts, like the X7 fixtures it extends; the Host never loads this file.
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATABASES, SEEDS, buildOwnerDatabase, buildSlot, sqlMigrations } from '../../../data-compat/__fixtures__/fixtures.ts';
import { OWNER_SEEDS, WORKSPACE_ID, historicalSql } from '../../../data-compat/__fixtures__/owner-fixtures.ts';

const LOCAL_STORAGE: Record<string, string> = { 'w12.smoke.legacy': '旧值📚\u0000尾' };

const [root, layout] = process.argv.slice(2);
if (!root || (layout !== 'slots' && layout !== 'pre-slot')) throw new Error('usage: build-old-data.ts <root> <slots|pre-slot>');

const dataDir = join(root, 'data');
const slot = buildSlot(dataDir, 'slotA', true);
buildOwnerDatabase(join(slot, 'databases/audit.db'), historicalSql('audit'), OWNER_SEEDS.audit);
buildOwnerDatabase(join(slot, `workspaces/ws_${WORKSPACE_ID}.db`), historicalSql('workspace-v1'), OWNER_SEEDS.workspace, 1);
// Rust kept sync state under the OS local-data dir; the shell maps that to `<data>.os/home/Library/Application Support`.
buildOwnerDatabase(join(root, 'data.os', 'home', 'Library', 'Application Support', 'deep-student', 'sync', 'sync_state.db'),
  historicalSql('sync-state'), OWNER_SEEDS.sync_state);
// An existing user has accepted the agreement (UserAgreementDialog: settings key, version 1.0.0).
const mistakes = new Database(join(slot, 'mistakes.db'));
mistakes.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('user_agreement_accepted', '1.0.0', '2026-10-01 01:02:03');
mistakes.close();
// Tauri WKWebView localStorage, legacy macOS layout (electron/storage-migration/sources.ts): UTF-16LE values.
const webkit = join(root, 'data.os', 'home', 'Library', 'WebKit', 'com.deepstudent.app', 'WebsiteData', 'LocalStorage');
mkdirSync(webkit, { recursive: true });
const storage = new Database(join(webkit, 'tauri_localhost_0.localstorage'));
storage.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
for (const [key, value] of Object.entries(LOCAL_STORAGE)) storage.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(key, Buffer.from(value, 'utf16le'));
storage.close();
if (layout === 'pre-slot') {
  for (const name of readdirSync(slot)) renameSync(join(slot, name), join(dataDir, name));
  rmdirSync(slot);
  rmdirSync(join(dataDir, 'slots'));
}

const count = (seeds: Record<string, unknown[]>) => Object.fromEntries(Object.entries(seeds).map(([t, rows]) => [t, rows.length]));
console.log(JSON.stringify({
  latest: Object.fromEntries(DATABASES.map((db) => [db, Math.max(...sqlMigrations(db).map((m) => m.version))])),
  seeds: Object.fromEntries(DATABASES.map((db) => [db, count(SEEDS[db])])),
  owners: { audit: count(OWNER_SEEDS.audit), workspace: count(OWNER_SEEDS.workspace), sync_state: count(OWNER_SEEDS.sync_state) },
  workspaceFile: `workspaces/ws_${WORKSPACE_ID}.db`,
  localStorage: LOCAL_STORAGE,
}));
