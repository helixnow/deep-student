/**
 * 注册库文件的相对布局（可移植：无运行时 import）。桌面 `locations.ts` 用 `node:path` 拼成本机路径，
 * 移动端用 OPFS 虚拟路径拼接；两端的库位置因此只有这一处定义。
 */
import type { DatabaseName } from './api.ts';

/** `active` = 活动数据空间槽目录；`dataLocal` = `dirs::data_local_dir()`（不随槽切换）。 */
export type DatabaseRoot = 'active' | 'dataLocal';

export interface DatabaseLocation {
  readonly root: DatabaseRoot;
  readonly segments: readonly string[];
}

/**
 * - 核心库：`commands_backup.rs::resolve_database_path`（vfs 在 `databases/` 下，其余在槽根）；
 * - `audit`：`databases/audit.db`；`browser`：槽根 `browser.db`；
 * - `sync_state`：`dstu-sync/src/data_governance/sync/state.rs:22-29` `open_default()`，
 *   `<dataLocalDir>/deep-student/sync/sync_state.db`，**不在**数据空间槽内。
 */
export function databaseLocation(name: DatabaseName): DatabaseLocation {
  switch (name) {
    case 'vfs':
      return { root: 'active', segments: ['databases', 'vfs.db'] };
    case 'audit':
      return { root: 'active', segments: ['databases', 'audit.db'] };
    case 'sync_state':
      return { root: 'dataLocal', segments: ['deep-student', 'sync', 'sync_state.db'] };
    case 'mistakes':
    case 'chat_v2':
    case 'llm_usage':
    case 'browser':
      return { root: 'active', segments: [`${name}.db`] };
  }
}
