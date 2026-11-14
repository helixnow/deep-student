/**
 * `syncSupport` 服务装配：五个支撑模块 + 注入的 `state` / `notes`。
 *
 * L20 的 SyncManager 通过 `ctx.syncSupport` 消费；所有方法都是同步的
 * （better-sqlite3），异步方法只出现在云存储 I/O。
 */
import type { SyncSupportOptions, SyncSupportService } from '../api.ts';
import { createTombstoneSupport } from './tombstones.ts';
import { createNoteHistorySupport } from './note-history.ts';
import { createPomodoroCountsSupport } from './pomodoro.ts';
import { conflictSupport } from './conflicts.ts';

export function createSyncSupport(options: SyncSupportOptions): SyncSupportService {
  return {
    version: 1,
    state: options.state,
    tombstones: createTombstoneSupport(options.state, options.logger, options.localFiles),
    noteHistory: createNoteHistorySupport(options.notes),
    pomodoroCounts: createPomodoroCountsSupport(() => options.pomodoros?.()),
    conflicts: conflictSupport,
  };
}
