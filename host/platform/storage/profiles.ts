/**
 * 每个库的连接 PRAGMA，逐项对应 Rust 源码（行号见 API.md 表格）。
 *
 * 关于 synchronous：better-sqlite3 以 `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` 编译，进入 WAL 后
 * 未显式设置的连接会降为 NORMAL；rusqlite bundled 没有该选项，默认保持 FULL。因此 Rust 未显式
 * 设置 synchronous 的连接在这里显式设为 FULL。
 */
import type { ConnectionProfile, ConnectionProfileName } from './api.ts';

export const PROFILES: Readonly<Record<ConnectionProfileName, ConnectionProfile>> = {
  // database/mod.rs:1208-1209 主连接 foreign_keys=ON、busy_timeout=3000（synchronous 未设 → FULL）；
  // database/manager.rs:85-90 连接池额外设置 journal_mode=WAL、synchronous=NORMAL。
  // 两者写同一文件，WAL 是文件级持久属性；synchronous 取主连接（占绝大多数写入）的 FULL。
  mistakes: { foreignKeys: true, journalMode: 'WAL', synchronous: 'FULL', busyTimeoutMs: 3000 },
  // dstu-vfs/src/vfs/database.rs:131-140
  vfs: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 5000 },
  // dstu-agent/src/chat_v2/database.rs:113-125
  chat_v2: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 10_000, autoVacuum: 'INCREMENTAL' },
  // dstu-storage/src/llm_usage/database.rs:152-160
  llm_usage: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 3000 },
  // dstu-storage/src/audit/mod.rs:169-171：裸 Connection::open（busy_timeout=5000，foreign_keys 编译默认 ON）
  audit: { synchronous: 'FULL', busyTimeoutMs: 5000 },
  // dstu-browser/src/browser/database.rs:191-196
  browser: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 3000 },
  // dstu-sync/src/data_governance/sync/state.rs:31-36
  sync_state: { synchronous: 'FULL', busyTimeoutMs: 5000 },
  // dstu-agent/src/chat_v2/workspace/database.rs:286 `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`
  workspace: { foreignKeys: true, journalMode: 'WAL', synchronous: 'FULL', busyTimeoutMs: 5000 },
  // 裸 rusqlite `Connection::open`（迁移协调器、备份等使用）
  plain: { synchronous: 'FULL', busyTimeoutMs: 5000 },
};

/** 迁移诊断的测试槽（Rust `commands.rs` 的 Slot C / Slot D）：每次诊断前清空、跑完即清空，不存放用户数据。 */
export const DIAGNOSTIC_SANDBOX_SLOTS = ['slotC', 'slotD'] as const;

/** `<数据根>/slots/slotC|slotD`（两种分隔符都认，本文件也在移动端闭包里，不用 `node:path`）。 */
export function isDiagnosticSandboxDir(dir: string): boolean {
  const parts = dir.split(/[\\/]+/).filter((part) => part !== '');
  const slot = parts.at(-1);
  return parts.at(-2) === 'slots' && (DIAGNOSTIC_SANDBOX_SLOTS as readonly (string | undefined)[]).includes(slot);
}

// RUST-FIX(RF-W07-diagnostic-sandbox-no-fsync): Rust 的 Slot C/D 诊断（commands.rs:237、338）用 coordinator 的裸 `Connection::open`
// （synchronous=FULL），每次提交 fsync，为跑完即删的库付出持久化开销；这里只对测试槽免 fsync。
const DIAGNOSTIC_SANDBOX_PROFILE: ConnectionProfile = Object.freeze({ ...PROFILES.plain, journalMode: 'MEMORY', synchronous: 'OFF' });

/**
 * 只给诊断测试槽里的一次性库用：在 `plain` 基础上不 fsync、回滚日志留在内存（仍能 ROLLBACK，`journal_mode=OFF` 则不能），
 * 掉电或崩溃会损坏这些库，但它们跑完即删。不放进 {@link PROFILES}，只能按目录取得；目录不是测试槽时抛错，绝不落到用户库上。
 */
export function diagnosticSandboxProfile(dir: string): ConnectionProfile {
  if (!isDiagnosticSandboxDir(dir)) throw new Error(`拒绝对非诊断测试槽目录使用免 fsync 的连接设置: ${dir}`);
  return DIAGNOSTIC_SANDBOX_PROFILE;
}
