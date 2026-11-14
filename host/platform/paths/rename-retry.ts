/**
 * `std::fs::rename` 的 Node 对应里的重试策略：Windows 上对瞬时占用做退避重试。
 *
 * Rust 在 Windows 上先用 `SetFileInformationByHandle(FileRenameInfoEx, REPLACE_IF_EXISTS | POSIX_SEMANTICS)`，
 * 目标正被杀毒、索引或云盘客户端以共享删除方式打开时照样能替换；libuv 只用 `MoveFileExW`，同样场景返回
 * EPERM / EACCES / EBUSY。Node 没有 POSIX 语义的入口，只能像 graceful-fs 那样等占用方释放。
 * 其他平台、其他错误码：调用一次，原样抛出。重试用尽后抛最后一次的错误。
 *
 * 不依赖 Node：平台与 rename 操作由调用方传入（`paths/compat.ts`、`storage/data-space-files.ts` 的包装）。
 */

// RUST-FIX(RF-W07-windows-rename-retry): Rust 不重试而靠 POSIX rename 语义；Node 缺这条路径，改为 win32 上退避重试。
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** 第 n 次失败后的等待（毫秒），合计 1270 ms。 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];

function retryDelay(platform: string, error: unknown, attempt: number): number | undefined {
  if (platform !== 'win32') return undefined;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || !RETRY_CODES.has(code)) return undefined;
  return RENAME_RETRY_DELAYS_MS[attempt];
}

export function retryRenameSync(platform: string, renameOnce: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameOnce();
      return;
    } catch (error) {
      const delay = retryDelay(platform, error, attempt);
      if (delay === undefined) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export async function retryRename(platform: string, renameOnce: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameOnce();
      return;
    } catch (error) {
      const delay = retryDelay(platform, error, attempt);
      if (delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
