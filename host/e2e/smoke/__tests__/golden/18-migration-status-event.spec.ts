/**
 * Startup `data-governance-migration-status` (review V03-02, ruling A; W30 → W12 handoff AL-05). Rust emits it
 * synchronously inside Tauri `setup` (`lib.rs:1117,1133,1181,1212,1284`), before the page has any listener, so the
 * webview never receives it; the startup notice comes only from the listener's own pull of
 * `data_governance_get_migration_status` (`src/hooks/useMigrationStatusListener.ts:160-190`). Ruling A keeps that:
 * the Host records the status but does not push the event to the shell (W30 `41bdba3a`).
 *
 * Before ruling A the storage finalizer pushed it about 100 ms before the page's `listen` on an idle machine, so
 * whether the page saw it was a race. The push itself is the deterministic observation, the page's receipt and
 * notice are the user-visible ones.
 */
import { expect, test } from '@playwright/test';
import { launchApp, waitForIpcIdle, type WireRow } from '../support/app.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

const EVENT = 'data-governance-migration-status';
const NOTICE = /数据库迁移存在警告|数据库迁移失败|数据库已升级到版本/;
const LAUNCHES = 3;

type Message = { kind?: string; type?: string; event?: string };
const messageOf = (r: WireRow) => (r.message ?? {}) as Message;

/** One launch's rows: a reused root appends every launch to the same wire.jsonl and `seq` restarts at 1. */
function lastLaunch(rows: readonly WireRow[]): readonly WireRow[] {
  return rows.slice(rows.findLastIndex((r) => r.seq === 1));
}

test('[V03-02] three launches on one library: the Host never pushes data-governance-migration-status and the page shows no migration notice', async () => {
  test.setTimeout(4 * 60_000);
  let root: string | undefined;
  for (let launch = 1; launch <= LAUNCHES; launch++) {
    const app = await launchApp(root === undefined ? { label: 'migration-status' } : { root });
    try {
      root = app.root;
      await waitForBridge(app.page);
      await app.call('plugin:host|status', {}, 90_000);
      if (launch === 1) await passFirstRun(app.page);
      await waitForIpcIdle(app);
      const rows = lastLaunch(app.wire());
      const pushed = rows.filter((r) => r.kind === 'host-in' && messageOf(r).kind === 'event' && messageOf(r).event === EVENT);
      const delivered = rows.filter((r) => r.kind === 'renderer-result' && messageOf(r).type === 'emit-js' && messageOf(r).event === EVENT);
      const pull = await app.call<unknown>('data_governance_get_migration_status');
      test.info().annotations.push({ type: `launch-${launch}`, description: JSON.stringify({
        pushedAt: pushed.map((r) => Math.round(r.time)), deliveredAt: delivered.map((r) => Math.round(r.time)), pull,
      }).slice(0, 600) });
      expect(delivered, `launch ${launch}: the page received the startup event`).toEqual([]);
      expect(await app.page.getByText(NOTICE).count(), `launch ${launch}: a migration notice is shown`).toBe(0);
      expect(pushed.map((r) => r.message), `launch ${launch}: the Host pushed the startup event to the shell`).toEqual([]);
    } finally {
      await app.close();
    }
  }
});
