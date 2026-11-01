//! Goal 续跑提示词（steering）渲染
//!
//! 续跑轮以 wake 语义起 turn：`content` 不落用户消息库，只作为本轮的
//! 系统指令输入。本模块负责把目标状态渲染为该指令文本。

use crate::chat_v2::repo::GoalRecord;
use crate::chat_v2::vfs_resolver::escape_xml_content;

/// 渲染目标续跑轮的 steering 提示词。
///
/// `objective` 是用户自由输入，必须 XML 转义（`&` / `<` / `>`）后再包进
/// `<objective>` 标签，防止伪造提示词结构。
pub(crate) fn continuation_steering(goal: &GoalRecord) -> String {
    let budget_line = match goal.token_budget {
        Some(budget) => {
            let remaining = (budget - goal.tokens_used).max(0);
            format!(
                "已用 tokens：{}；预算：{}；剩余：{}",
                goal.tokens_used, budget, remaining
            )
        }
        None => format!("已用 tokens：{}；预算：不限", goal.tokens_used),
    };

    format!(
        r#"继续推进当前会话目标。

<objective>{objective}</objective>

账目：{budget_line}

【续跑行为】目标跨轮次持续存在；本轮结束不代表目标收缩。保持目标完整，禁止把成功重新定义成更小更容易的任务；方向正确的推进优于表面稳定。

【证据优先】以当前权威状态为准（VFS 文件、Anki 卡片库 dstu 查询、todo 表、测验记录等真实查询结果）；对话记忆只用于定位，依赖前必须重新核查现状。

【无进展检查】把上一轮分类为：进展 / 已验证等待（轮询一个当前确认存活的句柄）/ 无进展；无进展则换下一个安全动作继续。

【计划可见】多步工作用 todo_init / todo_update 维护计划，并随进展及时更新。

【完成审计】标记完成前默认"未完成"：从目标逐条推导需求，每条需求找当前状态的权威证据（文件、查询结果、测试输出）；证据弱、间接或缺失 = 继续工作。审计必须证明完成，而非仅仅没发现剩余工作。确证完成后调用 goal_update(status="complete")。

【阻塞审计】首次遇到阻塞不要标 blocked；同一阻塞条件连续至少 3 个目标轮次重复，才调用 goal_update(status="blocked")。难、慢、不确定都不算阻塞。

【等待用户】需要用户回答或输入才能继续时（如出题后等待作答），调用 goal_update(status="waiting_user") 并结束本轮；不要空转轮询用户。

不要仅因为预算将尽或准备停手就标记完成。"#,
        objective = escape_xml_content(&goal.objective),
        budget_line = budget_line,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_goal() -> GoalRecord {
        GoalRecord {
            session_id: "sess_test".to_string(),
            goal_id: "goal_test".to_string(),
            objective: "完成<高数>第3章习题 & 整理错题".to_string(),
            status: "active".to_string(),
            token_budget: Some(100_000),
            tokens_used: 12_345,
            time_used_seconds: 600,
            continuation_count: 2,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn steering_contains_objective_budget_and_waiting_user() {
        let text = continuation_steering(&sample_goal());
        assert!(text.contains("继续推进当前会话目标"));
        // objective 必须 XML 转义后包裹
        assert!(text.contains("<objective>完成&lt;高数&gt;第3章习题 &amp; 整理错题</objective>"));
        // 账目行：已用 / 预算 / 剩余
        assert!(text.contains("已用 tokens：12345"));
        assert!(text.contains("预算：100000"));
        assert!(text.contains("剩余：87655"));
        // 关键行为指令
        assert!(text.contains("waiting_user"));
        assert!(text.contains("goal_update(status=\"complete\")"));
        assert!(text.contains("goal_update(status=\"blocked\")"));
        assert!(text.contains("不要仅因为预算将尽或准备停手就标记完成"));
    }

    #[test]
    fn steering_without_budget_shows_unlimited() {
        let mut goal = sample_goal();
        goal.token_budget = None;
        let text = continuation_steering(&goal);
        assert!(text.contains("已用 tokens：12345；预算：不限"));
        // 无预算时账目行不得出现"剩余：<数字>"（正文"剩余工作"字样不在此列）
        assert!(!text.contains("剩余："));
    }
}
