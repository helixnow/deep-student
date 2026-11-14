/**
 * `bilibili_transport/session.rs` 的任务取消表：`BiliAttempt::task` 插入
 * （同 id 旧令牌立即取消），`TaskGuard` drop 移除，`media_bilibili_cancel`
 * 取出并取消。命令在任务不存在时是幂等 no-op。
 */
import { CancellationToken } from './handout.ts';

export class BiliTaskRegistry {
  _tasks = new Map<string, CancellationToken>();

  /** `BiliAttempt::task`：同 id 的旧任务先取消，再换成新令牌。 */
  register(taskId: string, token: CancellationToken): void {
    const old = this._tasks.get(taskId);
    this._tasks.set(taskId, token);
    old?.cancel();
  }

  /** `TaskGuard` drop：只按 id 移除。 */
  remove(taskId: string): void {
    this._tasks.delete(taskId);
  }

  /** `media_bilibili_cancel`：未知 id 不报错。 */
  cancel(taskId: string): void {
    const token = this._tasks.get(taskId);
    if (token === undefined) return;
    this._tasks.delete(taskId);
    token.cancel();
  }

  size(): number {
    return this._tasks.size;
  }
}
