/**
 * 结果类型收窄工具。
 *
 * 仓库根 tsconfig 的 `strict` 为 false（`strictNullChecks` 关闭），对 `if (result.ok)` 的布尔字面量
 * 判别联合不做负分支收窄；统一用类型谓词帮助函数，避免在调用处写断言。
 */
export type OkResult<T extends { readonly ok: boolean }> = Extract<T, { readonly ok: true }>;

export function succeeded<T extends { readonly ok: boolean }>(result: T): result is OkResult<T> {
  return result.ok === true;
}
