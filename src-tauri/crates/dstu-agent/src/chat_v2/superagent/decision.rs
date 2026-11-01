//! Router 决策协议。
//!
//! Router 不亲自执行任务，它在每个回合的最终输出里附带一个围栏代码块：
//!
//! ````text
//! ```superagent-decisions
//! {"decisions":[
//!   {"op":"dispatch","thread":"ilink:abc","title":"整理错题","task":"…","trigger":"trg_x"},
//!   {"op":"reply","thread":"ilink:abc","text":"已开始整理，完成后告诉你。"}
//! ]}
//! ```
//! ````
//!
//! 为什么用文本协议而不是新增工具：内建工具需要同步登记到 ToolDescriptor、
//! 执行器注册表、前端 schema 与白名单（互相有对齐测试），而 Router 的动作集合
//! 很小且全部由后端 Hub 执行——文本协议让决策面保持在本模块内、可单测、不扩大
//! 模型的工具权限面。解析失败的条目被丢弃并记录，不会影响同块里的其他条目。

use serde::Deserialize;
use serde_json::Value;

pub const FENCE_TAG: &str = "superagent-decisions";
/// 一个批次里最多采纳的决策条数（防御异常输出）。
pub const MAX_DECISIONS_PER_TURN: usize = 40;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Decision {
    /// 明确不处理某个事件（仅用于审计；未被提及的事件同样视为已处理）。
    Ignore {
        #[serde(default)]
        trigger: Option<String>,
    },
    /// 为一个新话题创建 Worker 并订阅该话题。
    Dispatch {
        thread: String,
        #[serde(default)]
        title: Option<String>,
        task: String,
        #[serde(default)]
        trigger: Option<String>,
    },
    /// 把事件或一段说明转交给已有 Worker（跨话题协调）。
    Forward {
        worker: String,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        trigger: Option<String>,
    },
    Subscribe {
        worker: String,
        thread: String,
    },
    Unsubscribe {
        worker: String,
        thread: String,
    },
    /// 关闭 Worker（任务完结）。
    Close {
        worker: String,
    },
    /// 向用户回复。Worker 的输出不会直接发给用户，统一由 Router 回复。
    Reply {
        #[serde(default)]
        thread: Option<String>,
        text: String,
    },
    /// 链式召回：请求某对象的完整内容（trg_* / swk_* / thr:*）。
    Recall {
        #[serde(rename = "ref")]
        reference: String,
        #[serde(default)]
        offset: Option<usize>,
    },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedDecisions {
    pub decisions: Vec<Decision>,
    /// 解析失败的条目说明（用于日志/反馈给 Router）。
    pub errors: Vec<String>,
    /// 是否找到了决策块。
    pub found_block: bool,
}

/// 取输出里**最后一个** `superagent-decisions` 围栏块；找不到时尝试把整段输出当 JSON。
pub fn extract_block(output: &str) -> Option<String> {
    let mut last: Option<String> = None;
    let mut rest = output;
    let open = format!("```{FENCE_TAG}");
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        // 跳到行尾
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after[body_start..];
        match body.find("```") {
            Some(end) => {
                last = Some(body[..end].trim().to_string());
                rest = &body[end + 3..];
            }
            None => break,
        }
    }
    last.or_else(|| {
        let trimmed = output.trim();
        (trimmed.starts_with('{') || trimmed.starts_with('[')).then(|| trimmed.to_string())
    })
}

pub fn parse_decisions(output: &str) -> ParsedDecisions {
    let Some(block) = extract_block(output) else {
        return ParsedDecisions::default();
    };
    let mut parsed = ParsedDecisions {
        found_block: true,
        ..Default::default()
    };
    let value: Value = match serde_json::from_str(&block) {
        Ok(v) => v,
        Err(e) => {
            parsed.errors.push(format!("决策块不是合法 JSON: {e}"));
            return parsed;
        }
    };
    let items: Vec<Value> = match value {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("decisions") {
            Some(Value::Array(items)) => items,
            _ => {
                parsed.errors.push("决策块缺少 decisions 数组".to_string());
                return parsed;
            }
        },
        _ => {
            parsed.errors.push("决策块必须是对象或数组".to_string());
            return parsed;
        }
    };
    for (idx, item) in items.into_iter().enumerate() {
        if parsed.decisions.len() >= MAX_DECISIONS_PER_TURN {
            parsed.errors.push(format!(
                "决策条数超过上限 {MAX_DECISIONS_PER_TURN}，其余已忽略"
            ));
            break;
        }
        match serde_json::from_value::<Decision>(item) {
            Ok(d) => parsed.decisions.push(d),
            Err(e) => parsed
                .errors
                .push(format!("第 {} 条决策无效: {e}", idx + 1)),
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_block_and_keeps_good_items() {
        let out = r#"好的，我来安排。
```superagent-decisions
{"decisions":[
  {"op":"dispatch","thread":"t1","title":"整理","task":"整理错题","trigger":"trg_a"},
  {"op":"reply","thread":"t1","text":"收到"},
  {"op":"explode"},
  {"op":"recall","ref":"trg_b","offset":600}
]}
```
"#;
        let p = parse_decisions(out);
        assert!(p.found_block);
        assert_eq!(p.decisions.len(), 3);
        assert_eq!(p.errors.len(), 1, "unknown op is reported, not fatal");
        assert!(matches!(&p.decisions[0], Decision::Dispatch { thread, .. } if thread == "t1"));
        assert!(
            matches!(&p.decisions[2], Decision::Recall { reference, offset: Some(600) } if reference == "trg_b")
        );
    }

    #[test]
    fn last_block_wins_and_array_form_is_accepted() {
        let out = "```superagent-decisions\n[{\"op\":\"ignore\"}]\n```\n再想想\n```superagent-decisions\n[{\"op\":\"close\",\"worker\":\"swk_1\"}]\n```";
        let p = parse_decisions(out);
        assert_eq!(
            p.decisions,
            vec![Decision::Close {
                worker: "swk_1".into()
            }]
        );
    }

    #[test]
    fn bare_json_fallback_and_garbage() {
        let p = parse_decisions("{\"decisions\":[{\"op\":\"ignore\"}]}");
        assert_eq!(p.decisions.len(), 1);
        let none = parse_decisions("没有任何决策");
        assert!(!none.found_block && none.decisions.is_empty());
        let bad = parse_decisions("```superagent-decisions\n{not json}\n```");
        assert!(bad.found_block && bad.decisions.is_empty() && bad.errors.len() == 1);
    }

    #[test]
    fn caps_decision_count() {
        let items = (0..60)
            .map(|_| "{\"op\":\"ignore\"}")
            .collect::<Vec<_>>()
            .join(",");
        let p = parse_decisions(&format!("```superagent-decisions\n[{items}]\n```"));
        assert_eq!(p.decisions.len(), MAX_DECISIONS_PER_TURN);
        assert_eq!(p.errors.len(), 1);
    }
}
