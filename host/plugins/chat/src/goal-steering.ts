import type { RuntimeGoalRecord } from '../repository/goals.ts';

/** goal/steering.rs:13-49; XML content escaping is supplied by its L05 owner. */
export function continuationSteering(goal: RuntimeGoalRecord, escapeObjective: (text: string) => string): string {
  const difference = goal.tokenBudget === null ? null : goal.tokenBudget - goal.tokensUsed;
  const budgetLine = difference === null
    ? `已用 tokens：${goal.tokensUsed}；预算：不限`
    : `已用 tokens：${goal.tokensUsed}；预算：${goal.tokenBudget}；剩余：${difference < 0n ? 0n : difference}`;
  return `继续推进当前会话目标。

<objective>${escapeObjective(goal.objective)}</objective>

账目：${budgetLine}

【续跑行为】目标跨轮次持续存在；本轮结束不代表目标收缩。保持目标完整，禁止把成功重新定义成更小更容易的任务；方向正确的推进优于表面稳定。

【证据优先】以当前权威状态为准（VFS 文件、Anki 卡片库 dstu 查询、todo 表、测验记录等真实查询结果）；对话记忆只用于定位，依赖前必须重新核查现状。

【无进展检查】把上一轮分类为：进展 / 已验证等待（轮询一个当前确认存活的句柄）/ 无进展；无进展则换下一个安全动作继续。

【计划可见】多步工作用 todo_init / todo_update 维护计划，并随进展及时更新。

【完成审计】标记完成前默认"未完成"：从目标逐条推导需求，每条需求找当前状态的权威证据（文件、查询结果、测试输出）；证据弱、间接或缺失 = 继续工作。审计必须证明完成，而非仅仅没发现剩余工作。确证完成后调用 goal_update(status="complete")。

【阻塞审计】首次遇到阻塞不要标 blocked；同一阻塞条件连续至少 3 个目标轮次重复，才调用 goal_update(status="blocked")。难、慢、不确定都不算阻塞。

【等待用户】需要用户回答或输入才能继续时（如出题后等待作答），调用 goal_update(status="waiting_user") 并结束本轮；不要空转轮询用户。

不要仅因为预算将尽或准备停手就标记完成。`;
}
