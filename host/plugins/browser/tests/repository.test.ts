import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { BrowserDatabase } from '../src/database.ts';
import { MAX_HISTORY } from '../src/session.ts';
import {
  closeSession, getActive, getSetting, getSitePermission, listHistory, pushHistory,
  setSetting, truncateHistoryForward, updateCurrentHistory, upsertSession,
  upsertSitePermission,
} from '../repository/index.ts';

describe('crates/dstu-browser/src/browser/repository.rs::tests', { timeout: 120_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let db: BrowserDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'browser-repository-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    db = new BrowserDatabase(storage);
    db.ensureOpen();
  });

  afterEach(() => {
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  /** Simulate a process restart: close the handle and open a fresh storage service. */
  function reopen(): BrowserDatabase {
    db.close();
    storage.dispose();
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    db = new BrowserDatabase(storage);
    return db;
  }

  it('upsert_get_active_and_close', () => {
    const session = upsertSession(db, {
      id: 'sess_1',
      currentUrl: 'https://example.com',
      title: 'Example',
    });
    expect(session.isActive).toBe(true);
    expect(session.currentUrl).toBe('https://example.com');

    const active = getActive(db);
    expect(active?.id).toBe('sess_1');

    // A second active session replaces the first.
    upsertSession(db, { id: 'sess_2' });
    expect(getActive(db)?.id).toBe('sess_2');

    closeSession(db, 'sess_2');
    expect(getActive(db)).toBeUndefined();
  });

  it('push_and_truncate_history', () => {
    upsertSession(db, { id: 'sess_h' });

    pushHistory(db, 'sess_h', {
      url: 'https://a.example', title: 'A', transition: 'typed', typed: true,
    });
    pushHistory(db, 'sess_h', {
      url: 'https://b.example', title: 'B', transition: 'link', typed: false,
    });
    pushHistory(db, 'sess_h', {
      url: 'https://c.example', title: 'C', transition: 'link', typed: false,
    });

    const list = listHistory(db, 'sess_h', null);
    expect(list.length).toBe(3);
    expect(list[2]!.url).toBe('https://c.example');

    // Back to seq 0, then navigate: truncate before pushing.
    const deleted = truncateHistoryForward(db, 'sess_h', 0);
    expect(deleted).toBe(2);
    const truncated = listHistory(db, 'sess_h', null);
    expect(truncated.length).toBe(1);
    expect(truncated[0]!.url).toBe('https://a.example');

    pushHistory(db, 'sess_h', {
      url: 'https://d.example', title: 'D', transition: 'typed', typed: true,
    });
    const after = listHistory(db, 'sess_h', null);
    expect(after.length).toBe(2);
    expect(after[1]!.url).toBe('https://d.example');

    const session = getActive(db);
    expect(session?.historyIndex).toBe(1);
    expect(session?.currentUrl).toBe('https://d.example');
  });

  it('push_truncates_forward_automatically', () => {
    upsertSession(db, { id: 'sess_nav' });

    for (const url of ['https://1', 'https://2', 'https://3']) {
      pushHistory(db, 'sess_nav', { url, title: null, transition: null, typed: false });
    }

    // Move the index back to 0 manually; the next push must drop 1 and 2.
    db.getConn().run("UPDATE sessions SET history_index = 0 WHERE id = 'sess_nav'");

    pushHistory(db, 'sess_nav', {
      url: 'https://x', title: null, transition: null, typed: false,
    });

    const list = listHistory(db, 'sess_nav', null);
    expect(list.length).toBe(2);
    expect(list[0]!.url).toBe('https://1');
    expect(list[1]!.url).toBe('https://x');
  });

  it('push_history_rebases_at_runtime_history_limit', () => {
    upsertSession(db, { id: 'sess_bounded', historyIndex: -1 });

    const total = MAX_HISTORY + 5;
    let last: ReturnType<typeof pushHistory> | undefined;
    for (let index = 0; index < total; index += 1) {
      last = pushHistory(db, 'sess_bounded', {
        url: `https://example.com/${index}`,
        title: null,
        transition: 'link',
        typed: false,
      });
    }

    const history = listHistory(db, 'sess_bounded', null);
    expect(history.length).toBe(MAX_HISTORY);
    expect(history[0]!.url).toBe('https://example.com/5');
    expect(history[history.length - 1]!.url).toBe('https://example.com/54');
    for (const [index, row] of history.entries()) expect(row.seq).toBe(index);

    const session = getActive(db);
    expect(session?.historyIndex).toBe(MAX_HISTORY - 1);
    expect(session?.currentUrl).toBe('https://example.com/54');
    expect(last?.seq).toBe(MAX_HISTORY - 1);
  });

  it('navigation_and_current_entry_updates_survive_database_reopen', () => {
    upsertSession(db, { id: 'sess_reopen', historyIndex: -1 });
    for (const [url, title] of [
      ['https://a.example', 'A'],
      ['https://b.example', 'B'],
      ['https://c.example', 'C'],
    ] as const) {
      pushHistory(db, 'sess_reopen', {
        url, title, transition: 'link', typed: false,
      });
    }

    // Persist a back navigation, then reopen the database as a process restart would.
    upsertSession(db, {
      id: 'sess_reopen',
      currentUrl: 'https://b.example',
      title: 'B',
      historyIndex: 1,
      isActive: true,
    });
    const reopened = reopen();

    const afterBack = getActive(reopened);
    expect(afterBack?.historyIndex).toBe(1);
    expect(afterBack?.currentUrl).toBe('https://b.example');

    // Forward, then replace/redirect the current URL and update its title.
    upsertSession(reopened, {
      id: 'sess_reopen',
      currentUrl: 'https://c.example',
      title: 'C',
      historyIndex: 2,
      isActive: true,
    });
    updateCurrentHistory(reopened, 'sess_reopen', 2, 'https://c.example/final', null);
    updateCurrentHistory(reopened, 'sess_reopen', 2, null, 'Final C');
    const reopenedAgain = reopen();

    const session = getActive(reopenedAgain);
    expect(session?.historyIndex).toBe(2);
    expect(session?.currentUrl).toBe('https://c.example/final');
    expect(session?.title).toBe('Final C');

    const history = listHistory(reopenedAgain, 'sess_reopen', null);
    expect(history.length, 'replace/redirect must not push history').toBe(3);
    expect(history[1]!.url).toBe('https://b.example');
    expect(history[1]!.title).toBe('B');
    expect(history[2]!.url).toBe('https://c.example/final');
    expect(history[2]!.title).toBe('Final C');
  });

  it('settings_get_set', () => {
    expect(getSetting(db, 'homepage')).toBeUndefined();
    setSetting(db, 'homepage', 'https://start.local');
    expect(getSetting(db, 'homepage')?.value).toBe('https://start.local');
    setSetting(db, 'homepage', 'https://other');
    expect(getSetting(db, 'homepage')?.value).toBe('https://other');
  });

  it('site_permissions_upsert_get', () => {
    const row = upsertSitePermission(db, {
      origin: 'https://example.com',
      permission: 'navigate',
      decision: 'allow',
      scope: null,
      source: 'user',
      expiresAt: null,
    });
    expect(row.decision).toBe('allow');

    const got = getSitePermission(db, 'https://example.com', 'navigate');
    expect(got?.id).toBe(row.id);

    const updated = upsertSitePermission(db, {
      origin: 'https://example.com',
      permission: 'navigate',
      decision: 'deny',
      scope: 'origin',
      source: 'policy',
      expiresAt: null,
    });
    expect(updated.id).toBe(row.id);
    expect(updated.decision).toBe('deny');
    expect(updated.source).toBe('policy');
  });
});
