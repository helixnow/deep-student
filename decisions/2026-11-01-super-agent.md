# Super-agent 模式（实验）

日期：2026-11-01
状态：随本版本发布，默认关闭
来源：DeepSeek Harness 团队《Super-agent 设计探索》（用户提供的文章，未存入仓库）。
原始实现：会话 deep-student-c9（快照分支 `feat/super-agent-wip`，3eb84221）；移植到拆分后的 workspace 并补完：`wt/split-main`。

## 是什么

和「按会话聊天」并列的另一种工作方式：只有一个持续的对话，用户可以连续抛出多件事；
一个常驻的 Router 判断每条消息该直接回复、转给已有任务，还是新开后台任务（Worker）；
Worker 并行推进，做完后把结果交回 Router，由 Router 统一回复用户。窗口关到托盘后照常工作。

## 架构

后端在 `src-tauri/crates/dstu-agent/src/chat_v2/superagent/`，模块与文章概念的对应见该目录 `mod.rs` 顶部的表格。要点：

| 模块 | 职责 |
|---|---|
| `store` | 独立 SQLite（`<app_data>/superagent/superagent.db`）：事件、投递、Worker、订阅、回复、配置。进程无状态，可重启恢复 |
| `filter` | 调用模型前的程序过滤：来源模式、发送者白名单、仅响应提及、幂等去重、速率限制 |
| `hub` | Router / Worker 调度、订阅直通（已绑定话题的事件绕过 Router）、Router 批处理 |
| `decision` | Router 的动作协议：输出末尾的 `superagent-decisions` JSON 围栏块，动作限定在枚举内，由 Hub 校验执行 |
| `render` | 事件内联前 600 字 + 续读入口；`trg_` / `swk_` / `thr:` 稳定 ID 做链式召回 |
| `watchdog` | 确定性巡检：停滞 / 空转 Worker、孤儿投递、过期订阅、保留期清理；异常交给 Router 判断 |
| `runtime` | Tauri 接线：headless 管线端口、后台循环、9 个 `superagent_*` 命令 |

Router 与 Worker 都是普通的 chat_v2 headless 会话（`run_headless_agent_turn`），因此：
- 工具面是 headless 只读白名单（fail-closed），不能写数据、不能执行命令；
- 一键断电（kill switch）同样能停住它；
- 选 OpenCode Go 作为模型时属于 Agent 对话场景，带会话标识。

前端在 `src/features/super-agent/`（页面）、`src/features/settings/components/SuperAgent*`（开关与高级设置）、
`src/stores/superAgentEnabledStore.ts`（启用状态镜像，侧栏读取）。

## 安全与隔离

- **默认关闭**，唯一开关在「设置 → 自动化」。未启用时不创建数据库、不启动后台任务、侧栏无入口。
- **事件正文是不可信输入**：包进 `<untrusted_event>`，其中伪造的围栏和结束标签会被中和。
- **前端只能以 `chat` / `manual` 来源投递事件**；`ilink`、`automation` 等渠道来源只能由后端模块经 `emit_trigger` 喂入。
- **内部会话不出现在普通会话列表 / 计数 / 搜索里**，学习概览的会话统计也排除它们（依据会话 metadata 的 `superagent` 键）。
- **内部会话不做对话后自动记忆提取**（`SendOptions.auto_memory_extraction = Some(false)`）。
  端到端测试发现 Router / Worker 的回合会把事件正文和模型推断自动写进用户记忆，已修复；记忆的读取与记忆工具不受影响。
- **保留期**：默认 30 天，Watchdog 每小时最多清理一次已处理完的事件、回复与已关闭 Worker；在途投递永不清理。

## 验证

- Rust：superagent 模块 52 个测试（含移植后新增的来源限制、保留期、记忆开关测试）通过；chat_v2 repo 的可见性回归测试通过。
- 前端：页面、开关、高级设置的测试通过；类型检查、eslint、前端分层校验通过。
- **真实模型端到端**（本机桌面端，默认模型 DeepSeek V4.1 Flash / OpenCode Go）：
  - 单条消息：Router 直接回复；
  - 「同时做两件事」：Router 开出两个并行 Worker，各自用只读工具查真实数据，结果经 Router 分两次回复，先完成的先报；
  - 前端伪造 `ilink` 来源被拒绝；启用前磁盘上没有数据库，启用时才创建；
  - 内部会话不出现在会话列表；关闭开关后状态正确。
  测试产生的会话、记忆和数据库已全部清理。

## 已知限制 / 后续

- 除页面输入外还没有真实事件源：iLink（微信）桥接、复习到期、自动化钩子都未接入，`emit_trigger` 已备好。
  接 iLink 需要决定微信消息走 Super-agent 还是原有 TaskCommand 路径，属于产品决策。
- Router 决策依赖模型按格式输出文本协议块；解析失败的条目会被丢弃并记录。本次端到端中输出稳定，但只测了一个模型。
- 关闭开关不取消正在运行的回合，跑完后不再启动新的。
- Router 会话长期增长，依赖管线自身的上下文压缩，未专门验证长时间运行。
- 移动端启动器未加入口（其测试固定 7 个入口），目前仅桌面端。
- 未实现：工具调用异步化、Router 水平切分、跨实例协作（文章列为开放问题）。
