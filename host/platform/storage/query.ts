/**
 * 命名查询声明（可移植叶子模块：只有类型导入）。
 *
 * `api.ts` 原样重导出 {@link defineQuery}。只需要声明查询的仓储（移动端实现、要装进 mobile profile 的插件）
 * 可以直接从这里导入，不经 `api.ts` 加载桌面值；类型仍从 `api.ts` 用 `import type` 取。
 */
import type { Query, QueryOptions, Row, SqlParams } from './api.ts';

/** 零逻辑：声明一个命名查询。 */
export function defineQuery<P extends SqlParams | void = void, R = Row>(
  sql: string,
  meta?: { name?: string; options?: QueryOptions },
): Query<P, R> {
  return { sql, name: meta?.name, options: meta?.options };
}
