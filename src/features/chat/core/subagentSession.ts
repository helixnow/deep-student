/**
 * 子代理会话判定（SSOT）
 *
 * 子代理会话由 subagent_call 在后端创建：
 * - 新格式：`subagent_{profile}_{ulid}`（subagent_executor.rs）
 * - 旧格式：`agent_` 前缀（早期 workspace worker 会话）
 *
 * 子代理会话在主界面以「只读」呈现：可查看完整触发指令与执行过程，
 * 但禁止编辑/重发/删除消息与继续输入——这些操作会绕过 workspace
 * 运行时（inbox / 任务状态机 / 完成信封），导致状态错乱。
 */
export function isSubagentSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith('subagent_') || sessionId.startsWith('agent_');
}

/**
 * 判定完整会话记录是否属于子代理。
 *
 * ID 前缀兼容早期 worker；新会话以 mode 和 metadata 作为持久化语义，
 * 因此所有 UI/Store 调用方必须通过此函数而非自行猜测。
 */
export function isSubagentSession(opts: {
  sessionId?: string | null;
  mode?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return opts.metadata?.is_subagent === true
    || opts.mode === 'subagent'
    || isSubagentSessionId(opts.sessionId);
}

/**
 * 根据 Chat Store 中持久化的会话字段判定子代理会话。
 */
export function isStoreSubagentSession(state: {
  sessionId?: string | null;
  mode?: string | null;
  sessionMetadata?: Record<string, unknown> | null;
}): boolean {
  return isSubagentSession({
    sessionId: state.sessionId,
    mode: state.mode,
    metadata: state.sessionMetadata,
  });
}
