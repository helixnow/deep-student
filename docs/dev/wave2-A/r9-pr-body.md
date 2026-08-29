# 0824 Wave2-A: Agent 架构与 LLM 缓存命中深化（pipeline/prefix-freeze/provider 协议/流式过滤）

> 状态：**Draft**。本文中的“已落地”只表示源码/文档层面的静态落地，不表示已经通过编译、测试、CI 或真实 provider 请求验证。

## 方向与分支

- 工作分支：`cursor/0824-wave2-agent-cache-a875`
- 基座：`origin/cursor/0824-cde6` @ `061b4815`
- 本 PR 聚焦 Agent 管线、缓存前缀冻结与换代、provider 协议、流式过滤和可观测性。
- 这是独立演进枝，**不整支合回官方 0824**；后续是否以及如何吸收，应按独立变更面审阅和选择。

## 已落地摘要

1. **P1——方案 A 代际治理**：多变体 fan-out 前统一取得 `(generation, prefix)` 快照，环内只推进本地状态，join 后按变体索引序确定性收敛；只有真实分叉才切代，单变体普通追加不切代。变体 metadata 支持前缀逐字节重放，后续又补上 `toolSchemaDigest` 共识采纳链路。
2. **P2——技能正文 digest 门禁**：锚点记录与实际渲染正文同源的 `skill_body_digest`；历史重放遇正文变更时 warn + skip，禁止用新正文伪装旧历史，并通过去重信号触发目录换代意图。
3. **P3——统一冻结**：名字序、schema 字节和 digest 收敛到统一的 tool-face 冻结入口；单变体、多变体和恢复路径共享会话级持久化前缀语义。
4. **P4——目录原子首发与 compaction pending**：`availableSkillsSnapshot` 在首个请求前等待持久化裁决，失败则不发送；compaction 与技能 digest 冲突可写入 `availableSkillsSnapshotPendingGeneration`，由前端在后续稳定窗口兑现新代。
5. **P5——early persist**：主对话当前 user 的 `llm_content` 在首个 provider 请求前轻量早写，后续正常保存不抹掉该值，缩小“已发送但 sidecar 尚未保存”的崩溃窗口。retry 与 multi-variant 仍有单列缺口，见“未验证”。
6. **P6——删除 24h retention 死实现**：移除全仓零调用且在 GPT-5.6+ 路径会构造非法 `ttl:"24h"` 的两段实现；不新增网络行为，并在原位保留未来若复活时的端点、合法值和快照测试约束。
7. **P7——遥测分列**：将 `session_id`、`variant_id`、`run_id` 分列记录，增加 system/tools/history/current-user 四段指纹，并更新 migration 与 `cache-hit-report.py` 的分组口径。
8. **P8——hooks 卫生**：删除只写字段，文档化“准入先于审计”的依赖和 trait 失败语义，用泛型 helper 收敛两段取消等待逻辑；十五段准入、TOCTOU 和默认 hook 顺序不改。
9. **P9——流式过滤收口**：reasoning 通道使用独立过滤器实例；`consume_prefix` 改为游标推进，避免大 chunk 的重复前移；模型特殊 token 常量表收敛为单一来源，并接入已授权的非流式出口。第 6 轮另修复了 close token 后连续空白行导致 tail-hold 泄漏的问题。
10. **P10——provider 协议**：保留并静态复核 Step 22 已修的 P0（Responses 显式断点形状、模型/端点双门控）与 P1（`include_usage` 终止状态机、`stream_options` 端点门控）；补 P2 的调用方 tool marker 透传与 Anthropic 最多四个显式断点的预算守卫。
11. **P11——架构矩阵**：形成 21 行“新 Agent 体系 vs 本仓”矩阵（Agent 结构 14 行、provider 缓存契约 7 行），沉淀会话内 tools append-only、system 稳定前缀、子代理不复用母前缀三项原则，并明确标出仍未契合的结构面。

## 已验证（仅静态证据）

- 证据仅来自 `grep`、源码/文档阅读、`git diff`/`git log` 与跨席位静态复核。
- 已静态确认上述实现符号、调用点、metadata/migration 键、测试源码和文档矩阵均在树中；第 6 轮二检还静态发现并修正了 digest 死接线、tail-hold 空白泄漏和遥测脚本的两处口径问题。
- 已静态确认本会话未碰 `coordinator.rs`，`ApprovalGateHook` 仍位于默认 hook 链首，过滤器等既有负例测试未删除。
- **第 1–8 轮均未运行测试。**第 8 轮只做环境探针：本机为 `rustc 1.83.0`，与要求的 `1.98.0` 不符，随后立即停测；未运行 `cargo test`、`cargo check`、`cargo build` 或 `rustfmt`。前端依赖未物化，Vitest 也未运行。

## 未验证 / 开放项

### 运行门禁

- 当前分支尚未重跑四项硬门禁：
  1. `npm run version:generate && npm run typecheck`
  2. `npx vite build`
  3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`
  4. `node scripts/check-migrations.mjs`
- `cargo test` 六族均未执行：`tool_loop`、`hooks`、`helpers`、`providers`、`model_special_tokens`、`prefix_snapshot`。
- TauriAdapter 的定向 Vitest 未执行；当前环境没有 `node_modules/.bin/vitest`，本轮未安装依赖。
- 第 7 轮新增/强化的测试虽有源码，但存在生产 seam 覆盖强弱不一的问题；不能用测试数量或静态推演替代执行证据。
- 尚无真实 provider 请求、真实 SQLite 升级/中断恢复、缓存命中率或 mutation test 证据。

### 产品与架构缺口

- **retry early-persist 缺口**：retry 使用新 `user_message_id`，早写与最终保存都可能找不到原 user 行，下一轮重放字节可能漂移。
- **multi_variant 崩溃窗**：扇出路径仍没有与主对话等价的发送前早写，崩溃后可能丢失当轮 live 包装。
- **catalog delta 未接线**：delta 仍未贯通 `TauriAdapter`/`SendOptions` 到 Rust 注入点，当前只有设计与局部原语。
- **G-CC400 未修**：Chat Completions 严格端点仍可能收到 system 数组与块级 `cache_control`；官方 DeepSeek V3.x 协议回落路径存在确定性 400 风险。
- **G3 未修**：Anthropic 仍可能在包含 `user_profile` 等易变内容的整块 system 尾打断点；尚未完成稳定块/易变块拆分，实际缓存命中收益无证据。
- **issue #122 未修**：本枝只增加 UTF-8 定位 warn 探针，不改变 U+FFFD 替换语义，不声称修复乱码问题。
- **V20260826 coordinator 缺口（归 D）**：若两条 `ALTER TABLE` 已落盘但 refinery history 尚未落盘，重跑可能因重复列硬失败；`coordinator.rs` 与 `llm_usage/database.rs` 的成对收敛及对应测试均未做，本会话按边界未碰 coordinator。

## 18 不变量与合入边界

- 基座 `061b4815` 留有 Step 23 的 18 不变量记录，但该记录不能替代本分支的重新验证。
- 本会话未碰 `src-tauri/src/data_governance/migration/coordinator.rs`。
- `ApprovalGateHook` 仍为 `default_pipeline_hooks()` 链首；准入序列和 TOCTOU 语义未改。
- 保守过滤、技能重放、目录 first-write-wins 等负例测试未删除或弱化。

## PR 状态

**保持 Draft。**是否转为 Ready for review、是否选择性吸收以及最终合入方式，均由人工审阅后决定。
