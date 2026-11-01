# OpenCode Go 订阅接入（建议仅用于 Agent 对话）

日期：2026-10-31
参考来源：
- OpenCode Go 文档：<https://opencode.ai/docs/go/>（第三方客户端要求、端点表、额度规则）
- OpenCode 服务条款：<https://opencode.ai/legal/terms-of-service>（2026-08-15 版）
- OpenChamber 实现（`packages/vscode/src/opencodeGoQuota.ts`、`packages/web/server/lib/quota/DOCUMENTATION.md`，提交 d4a5a0e）

## 背景与规则

OpenCode Go 是面向「OpenCode 及产生同类请求的编程 agent」的订阅网关，不需要申请白名单，第三方客户端满足三条即可接入：

1. 发送典型的 agent 流量；
2. 用自己的 User-Agent 标识身份，不得用通用 SDK / HTTP 库名，更不能冒充浏览器或 OpenCode；
3. 每个会话携带稳定的 `x-opencode-session`（官方用于路由与 prompt 缓存；OpenChamber 记录该头自 2026-09-06 起强制）。

官方另有滥用监控，服务条款保留「任意理由暂停服务」的权利，并禁止程序化批量提取输出。被处置的是用户自己的 OpenCode 账号，因此本项目按最保守的方式接入。

## 决策

> **2026-11-01 修订：限制改为建议。** 用户决定不再强制拦截：非 Agent 功能（制卡、翻译、批改、OCR、定时自动化、fallback 等）只要用户手动选了 Go 就照常执行，请求仍带 DeepStudent 身份头，会话标识依次取 Agent 会话 ID → 调用方 session_id → 固定的 `deepstudent-task`。自动分配与 OCR 引擎自动注册仍不会选 Go；一键分配只设置对话默认模型、会话标题、上下文压缩；设置页对用到 Go 的非 Agent 功能给出提示。下表「拒绝」各行已不再生效，保留作历史记录。

**（原决策）只在 Agent 对话中允许使用 OpenCode Go。**

| 场景 | 是否允许 | 实现位置 |
|---|---|---|
| chat_v2 主对话（含多变体） | 允许，`x-opencode-session` = 会话 ID | `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 对话流：能从 stream_event 还原 chat_v2 会话才走 `prepare_agent_provider_request` |
| 子代理会话 | 允许，使用子代理自己的会话 ID | 同上（子代理是独立 chat_v2 会话） |
| 该会话的标题生成、上下文压缩 | 允许，使用所属会话 ID | `call_agent_chat_title_raw_prompt` / `call_agent_compaction_raw_prompt`（`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs`，调用方 `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/summary.rs`、`src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`） |
| 定时自动化（headless） | 拒绝 | `src-tauri/crates/dstu-agent/src/chat_v2/headless.rs::execute_headless_pipeline` 预检 |
| OCR、制卡、翻译、批改、出题、记忆决策、embedding 等 | 拒绝 | 请求准备处默认拒绝：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs::prepare_plain_provider_request` 对 Go 配置一律报错；作文批改模型列表另在 `src-tauri/crates/dstu-tutor/src/essay_grading/mod.rs` 过滤 |
| 模型 fallback | 后台任务不会降级到 Go | `src-tauri/crates/dstu-llm/src/llm_manager/routing.rs::run_with_failover` |
| 连接测试 | 只调用公开用量接口，不发推理请求 | `src-tauri/src/commands.rs::test_api_connection` |

前端同步把 Go 模型从非对话功能的选择器里去掉（设置页功能模型、OCR、出题、试卷导入、作文批改、插件），对话默认模型、会话标题、压缩模型仍可选 Go；供应商详情页常驻「仅用于 Agent 对话」说明与用量。

**身份**：Go 请求使用 `User-Agent: DeepStudent/<版本>`，不附带其余供应商仍在使用的浏览器伪装 UA / `Accept-Language` / `Origin` / `Referer`。供应商自定义头不能覆盖这两个身份头。其他供应商的伪装头本次保持不变。

**端点**：Go 按模型原生协议使用不同根地址。内置模型显式声明 `api_protocol`，`merge_vendor_profile`（`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs`，Go 相关逻辑集中在 `src-tauri/crates/dstu-llm/src/llm_manager/opencode_go.rs`）按生效协议把官方 Go 根地址改写为 `openai/v1`、`anthropic/v1` 或 `google/v1beta`；模型 ID 原样透传（Hermes 曾因把 `.` 改成 `-` 被拒）。

**内置模型**：13 个，覆盖四种协议。未内置 Muse Spark / Iceman 等 Contributor 型号（官方说明其数据可用于训练）与限时免费型号，用户可手动添加。

## Console 接口能不能用

结论：**技术上能用，但不采用。**

- OpenChamber 读取 `GET https://opencode.ai/console/api/go/status`（API Key 作 Bearer、不带 `x-org-id`），2026-10-22 实测可返回与 Console 页面一致的精确用量；余额来自 `GET /console/api/billing/status`，该接口对 API Key 返回 403，只接受 Console 登录会话。
- 这两个接口**未公开文档化**，OpenChamber 自己也注明「随时可能变化，需对照线上 Console 页面复核」。Console 登录会话属于 OpenCode 自己的 OAuth 客户端，第三方复用它等同冒充 OpenCode。
- 本项目只用公开的 `GET https://opencode.ai/zen/go/v1/usage`（返回 5 小时 / 周 / 月三个窗口的整数百分比与重置时间），代价是百分比为向下取整、比 Console 页面最多低 1 个百分点，且不显示余额。

## 各模型额度（静态数据）

官方原文：「Each model has the following usage limits: 5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%. Each model's monthly limit below determines how its usage counts toward those allowances.」即**所有模型共用一组 5 小时 / 周 / 月额度**，各模型的月额度是换算系数（按标价在该模型上花掉月额度对应金额 = 用完 100% 月额度）。公开用量接口也只返回三个总百分比。

官方没有公开接口提供各模型月额度，只在文档页表格里给出，且套餐档位（Go / Go Plus / Go Teams）只有未公开的 Console 接口能查到。因此：

- `scripts/generate-opencode-go-plans.mjs` 解析文档页表格，生成 `scripts/opencode-go-plans.json`（30 个模型 × 3 档套餐的月额度与官方预估请求数、协议、是否允许训练，带 `verified_at`）。官网变更时重新运行并核对 diff；`--check` 可做一致性检查。
- 套餐档位由用户在 OpenCode Go 供应商页选择（设置键 `opencode_go.plan`，默认 Go）。
- 供应商页列出各模型月额度与预估请求数（默认只列已添加的模型，可展开全部；允许训练的型号带警示）；聊天模型选择器在 Go 模型下显示「约 N 次/5 小时」。
- Rust 测试 `builtin_models_match_official_plans_table`（`src-tauri/crates/dstu-llm/src/llm_manager/opencode_go.rs`）保证内置模型的 ID、协议与该表一致，且不内置允许训练或免费型号。

## 未做 / 后续

- 解析响应中的 `opencode.allowance` 字段（逐次用量；官方字段结构未公开）。
- 若后续需要，可向 OpenCode 申请进入「已验证客户端」列表。
