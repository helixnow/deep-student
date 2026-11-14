/**
 * 迁移版本集合（dstu-storage/src/migration/{vfs,chat_v2,llm_usage,mistakes}.rs）。
 *
 * Rust 侧 `MigrationSet::migrations` 的 `refinery_version` 与 `resources/app/migrations/<db>/`
 * 下的文件名一一对应；此处只保留版本号，用于 `latest_version()` 与 `pending()`。
 */

export type CoordinatedId = 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage';

/** `DatabaseId::all_ordered()`：拓扑序，无依赖优先。 */
export const DATABASE_IDS: readonly CoordinatedId[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];

/** `DatabaseId::dependencies()`。 */
export const DATABASE_DEPENDENCIES: Readonly<Record<CoordinatedId, readonly CoordinatedId[]>> = {
  vfs: [],
  llm_usage: [],
  chat_v2: ['vfs'],
  mistakes: ['vfs'],
};

const VFS_VERSIONS: readonly number[] = [
  20260130, 20260131, 20260201, 20260202, 20260203, 20260204, 20260205, 20260206, 20260207, 20260208,
  20260209, 20260210, 20260211, 20260212, 20260213, 20260214, 20260215, 20260227, 20260302, 20260303,
  20260304, 20260305, 20260306, 20260308, 20260309, 20260310, 20260311, 20260312, 20260523, 20260524,
  20260525, 20260526, 20260527, 20260610, 20260611, 20260612, 20260613, 20260614, 20260615, 20260714,
  20260715, 20260718, 20260719, 20260720, 20260721, 20260722, 20260723, 20260724, 20260725, 20260726,
  20260727, 20260728, 20260801, 20260806, 20260807, 20260808, 20260824, 20260907, 20260908, 20260909,
  20260910, 20260911, 20260912, 20260921, 20260922, 20260923, 20260924, 20261005, 20261006, 20261023,
  20261027, 20261111,
];

const CHAT_V2_VERSIONS: readonly number[] = [
  20260130, 20260131, 20260201, 20260202, 20260203, 20260204, 20260207, 20260221, 20260301, 20260302,
  20260306, 20260502, 20260510, 20260516, 20260523, 20260524, 20260527, 20260528, 20260711, 20260717,
  20260719, 20260720, 20260721, 20260806, 20260905, 20260907, 20260908, 20260909, 20260910, 20261111,
];

const LLM_USAGE_VERSIONS: readonly number[] = [
  20260130, 20260131, 20260201, 20260202, 20260524, 20260525, 20260824, 20260826,
];

const MISTAKES_VERSIONS: readonly number[] = [
  20260130, 20260131, 20260201, 20260207, 20260208, 20260209, 20260523, 20260524, 20260705, 20260709,
  20260710, 20260711, 20260712, 20260713, 20260714, 20260715, 20260720, 20260721, 20260722, 20260723,
  20260724, 20260824, 20261005,
];

const VERSIONS: Readonly<Record<CoordinatedId, readonly number[]>> = {
  vfs: VFS_VERSIONS,
  chat_v2: CHAT_V2_VERSIONS,
  mistakes: MISTAKES_VERSIONS,
  llm_usage: LLM_USAGE_VERSIONS,
};

/** `MigrationSet::latest_version()`：最后一项的 refinery_version，空集合为 0。 */
export function latestVersion(id: CoordinatedId): number {
  const versions = VERSIONS[id];
  return versions.length === 0 ? 0 : versions[versions.length - 1]!;
}

/** `MigrationSet::pending(current)`：`refinery_version > current` 的数量。 */
export function pendingCount(id: CoordinatedId, current: number): number {
  let count = 0;
  for (const version of VERSIONS[id]) if (version > current) count += 1;
  return count;
}

/** `get_migration_set(id.as_str())`：未知 id 返回 undefined。 */
export function migrationVersions(id: string): readonly number[] | undefined {
  return (VERSIONS as Record<string, readonly number[] | undefined>)[id];
}
