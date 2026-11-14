// workspace/card_read_scope.rs —— worker 会话的 coordinator 只读卡面作用域。
//
// 默认所有权模型是「会话独占」；本注册表为只读卡面工具（get_cards / status）
// 开一个唯一豁免：worker 会话可读取同 workspace coordinator 完整拥有的文档。
// 写路径不经过这里，仍按 `ctx.session_id` 做所有权检查。
//
// fail-closed：空 id、自映射、未安装都返回拒绝/None；作用域寿命由调用方的
// `WorkspaceCardReadScopeGuard.release()`（或 `using`）绑定到 worker 管线。

import { rustTrim } from '../../../../platform/util/portable.ts';

export interface WorkspaceCardReadScope {
  workspaceId: string;
  coordinatorSessionId: string;
}

const scopes = new Map<string, WorkspaceCardReadScope>();

/**
 * RAII guard：释放时撤销 worker 会话的只读作用域。
 *
 * Node 没有确定性析构，调用方应在 worker 管线结束/取消/异常时
 * `release()`；`Symbol.dispose` 支持 `using guard = install...`。
 */
export class WorkspaceCardReadScopeGuard {
  private released = false;

  private readonly workerSessionId: string;

  constructor(workerSessionId: string) {
    this.workerSessionId = workerSessionId;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    scopes.delete(this.workerSessionId);
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

/**
 * 为 worker 会话安装「同 workspace coordinator 文档可读」的只读作用域。
 *
 * 仅供后端 worker 启动路径调用；任一 id 为空或 worker 即 coordinator 都拒绝。
 */
export function installWorkspaceCardReadScope(
  workerSessionId: string,
  workspaceId: string,
  coordinatorSessionId: string,
): WorkspaceCardReadScopeGuard {
  const worker = rustTrim(workerSessionId);
  const workspace = rustTrim(workspaceId);
  const coordinator = rustTrim(coordinatorSessionId);
  if (worker === '' || workspace === '' || coordinator === '') {
    throw new Error('workspace card read scope requires non-empty ids');
  }
  if (worker === coordinator) {
    throw new Error(
      'workspace card read scope must map a worker to a distinct coordinator session',
    );
  }
  scopes.set(worker, { workspaceId: workspace, coordinatorSessionId: coordinator });
  return new WorkspaceCardReadScopeGuard(worker);
}

/** 查询会话当前安装的只读作用域（未安装返回 `null`）。 */
export function workspaceCardReadScope(sessionId: string): WorkspaceCardReadScope | null {
  return scopes.get(sessionId) ?? null;
}
