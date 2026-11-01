//! Super-agent（实验性）：持续在线、事件驱动、多任务并发的 Agent 运行模式。
//!
//! 设计来源：DeepSeek Harness 团队《Super-agent 设计探索》。核心是把
//! “单 Session ReAct Loop”升级为四个特征——连续、高效、主动、持久——并映射到
//! 本项目既有设施上：
//!
//! | 文章模块            | 本项目实现                                                             |
//! |---------------------|------------------------------------------------------------------------|
//! | 双层架构 Router/Worker | `hub`：常驻 Router 会话 + 每话题一个命名 Worker 会话（headless 管线） |
//! | 事件驱动 Trigger     | `filter`（Fast Path 程序过滤）+ `hub::ingest`（语义层交给 Router 提示词） |
//! | 订阅直通             | `store` 的 Thread↔Worker 多对多订阅；已绑定话题的事件绕过 Router        |
//! | Router 批处理        | 回合期间积压的事件在下一回合一次性注入                                  |
//! | Inline & Spill / 链式召回 | `render`：内联摘要 + 续读入口 + trg_/swk_/thr: 引用图                |
//! | 计算/状态分离        | `store`：全部状态落盘，进程无状态可重启（`watchdog::recover`）          |
//! | Watchdog             | `watchdog`：确定性巡检，异常信号交给 Router 做语义判断                  |
//! | 面向人的交互         | Worker 不对外；Router 统一回复（`superagent_reply` 事件）               |
//!
//! 安全边界：事件正文视为不可信输入；Router/Worker 只拥有 headless 只读工具面；
//! Router 的动作被限制在 [`decision::Decision`] 枚举内并由 Hub 校验后执行；
//! 一键断电（kill switch）同样覆盖本模块。默认关闭，需显式启用。
//!
//! 刻意未实现（见文章“开放问题”）：Router 水平切分、跨实例 A2A、云端 Loop +
//! 端侧 daemon 的存算分离第二层、工具调用异步化 `start()/stop()`。

pub mod decision;
pub mod feed;
pub mod filter;
pub mod hub;
pub mod render;
pub mod runtime;
pub mod store;
pub mod types;
pub mod watchdog;

pub use hub::{HubConfig, IngestOutcome, SuperAgentHub, TurnPorts};
pub use runtime::{emit_trigger, init};
pub use store::SuperAgentStore;
pub use types::IncomingTrigger;
