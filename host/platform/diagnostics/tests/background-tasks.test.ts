import { expect, it } from 'vitest';
import { createBackgroundTasks } from '../api.ts';

function collector() {
  const info: string[] = [];
  const warn: string[] = [];
  return { log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) }, info, warn };
}

it('tracked_tauri_spawn_does_not_require_an_entered_tokio_runtime', async () => {
  const tracker = createBackgroundTasks();
  expect(await tracker.spawn(async () => 42)).toBe(42);
  expect(tracker.size).toBe(0);
});
it('admission_closed_rejects_new_spawn_but_drains_admitted', async () => {
  const { log, info, warn } = collector();
  const tracker = createBackgroundTasks(log);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = tracker.spawn(async () => { await gate; return 7; });
  const shutdown = tracker.shutdown();
  release();
  expect(await running).toBe(7);
  await shutdown;
  let ran = false;
  expect(tracker.spawn(async () => { ran = true; return 9; })).toBe(null);
  expect(ran).toBe(false);
  expect(tracker.size).toBe(0);
  expect(warn).toEqual(['[background_tasks] spawn rejected: shutdown in progress']);
  expect(info).toEqual([
    '[background_tasks] shutdown: aborted 1 pending task(s), waiting up to 1000ms',
    '[background_tasks] shutdown: all background tasks finished',
  ]);
});
