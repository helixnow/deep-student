# L05 本轮迁移交付

## 最新续派结果（以下小节覆盖历史阻塞状态）

完成并小步提交：`c76e58868` VFS 真实服务装配；`3876393ff` 删除恒成功的
governance guard；`196c6c487` 完成 outbox 的宿主服务与 active DB 重借。
公开服务新增 `agentVfsResolver`、`agentCompletionOutbox`。L18 docs provider 已可用。

盘点结果：12/12 命令 A；21 pending 保持不变（VFS 12 等 L03/L04，outbox 9 等 L04）。
仅 provider 装配不会冒充实际业务调用。21 obsolete 仍待协调者审批。
SPEC 唯一未勾选项为 `chat_v2_delete_artifact` 的 Windows 原生错误文案。
接口名称、责任 lane 和影响范围详见 [BLOCKERS.md](BLOCKERS.md)。

```text
host typecheck: exit 0
lane vitest: Test Files 33 passed; Tests 401 passed | 16 skipped (417)

ledger: commands 1058 (A 73.5% B 1.8% C 0%), tests 8036 (A 66.3% B 0.4%);
problems: commands 0, tests 341, orphan registrations 0
L05: commands 12/12 A; tests 359/401 A; 本 lane 21 个问题均为 obsolete 审批项

合计 ported 359，其中所测模块未从 index.ts 接入 0（0.0%）

boundaries: scanned 111 files, 0 violation(s), 16 suppressed via boundary-allow
rules include erasable-syntax and console-log

node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts
importable: ok
```

## 可擦除语法硬门禁

- 已通过 `git merge --no-edit main` 合并协调者的 `0af04df83` 修复，
  合并提交 `820f17c48`；无冲突，保留 main 的显式字段声明和构造函数赋值。
- 已核对本 lane 合并后的构造函数：`SleepError`、`SubagentTaskError` 的字段
  赋值在 `super()` 之后；其余构造函数在使用依赖前完成赋值。
- 本分支新增模块同样通过 `erasable-syntax` 检查，无参数属性、enum 或带实现的 namespace。
- 提交前验证：
  - `node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts`：`importable: ok`。
  - lane strict：109 文件，0 违规，16 个既有允许项（规则包含 `erasable-syntax`）。
  - host typecheck：通过。
  - 9 个受构造函数改写影响的测试文件：81 个测试全部通过。

## 自动质量反馈补充：时间副本与测试删除

- 已删除 `file-manager` / `file-manager/objects` 中的 `nowRfc3339`、`rfc3339`
  函数；使用平台 `toRfc3339`，Date 值在调用处转换为 epoch nanos。
- 已删除 `workspace/util.ts` 的 `nowRfc3339`、`parseRfc3339Utc`、
  `parseOptionalRfc3339Utc` 及私有 `parseFields`/RFC3339 正则；各调用点直接使用
  `host/platform/time/index.ts` 的解析/格式化。保留业务层既有的非法值处理：
  required task 时间抛错、optional 时间返回 null、workspace/sleep 时间按原规则回退 epoch 并记录日志。
- 一并删除未使用的 `nowTimestampMillis`；损坏库备份名改用平台日历字段和
  `chronoStamp` 输出去分隔符，删除 `utcStampCompact` 本地格式化副本。
- 新增持久化 task 时间接缝测试，覆盖 UTC 偏移归一化、纳秒保留、optional 非法值
  与 required 非法日期；原 Rust 测试标题和断言均保留。

删除的三个测试文件是此前协调者 §8 裁定的 Rust 死代码清理，非降低活跃路径覆盖：

| 已删除文件 | 自动反馈记录的断言数 | TESTMAP Rust 行数 | 当前去向 | ported 行/悬空引用 |
|---|---:|---:|---|---:|
| `tests/adapters-llm.test.ts` | 41 | 12 | 全部 `obsolete:dead-in-rust` | 0 |
| `tests/adapters-tool.test.ts` | 31 | 5 | 全部 `obsolete:dead-in-rust` | 0 |
| `tests/adapters-vfs-rag.test.ts` | 8 | 4 | 全部 `obsolete:dead-in-rust` | 0 |

已逐行核对以上 21 行，没有虚报 ported；证据与完整 ID 见本报告末节。
断言数与 Rust 测试条目数是不同计数。obsolete 仍需协调者在 approvals.json 批准。

本次补充验证：host typecheck 通过；13 个相关测试文件、102 个测试全部通过；
wiring 仍为 ported 359 / 未接入 0。strict 扫描 1789 文件，外部 249 条违规
（console-log 213、empty-catch 36），本 lane 0 违规、16 个原有允许项。
`migration:ledger -- --check --no-write`：commands 1058（A 67.7%）、tests 8036
（A 66.1%），commands problems 0、tests problems 341；本 lane 的 21 个
obsolete 审批项未变。

## 完成项

- 合并 main 后从自动检查点继续；已有 dead-adapter 删除和 TESTMAP 调整保留。
- `approval-scope.ts` 拆成核心类型、工具分类、环境计划、指纹、作用域、shell 分析、
  shell guard、持久化键；入口 12 行，最大子模块 787 行。
- `tools/file-manager.ts` 保留 plan/commit/restore 与执行器（390 行），
  文件校验/转换 324 行，任务对象/血缘与序列化 192 行。
- `tools/shell-execute.ts` 保留执行与审计（357 行），上下文/策略 272 行、
  进程/流生命周期 179 行、快照 111 行。
- VFS resolver 按模型、资源文本、PDF/教材、题目集、资产、分发拆分；补齐
  Image/File/PDF/Note/Essay（含 session）/Translation/MindMap/InsightCard。
  修正 SQL 字段别名，保留 XML 转义、字符/轮次预算、PDF 模式选择和解析失败回退。
- 文件内容通过 `vfs-repos/api.ts` 的 `files.getContent` 读取；解析通过
  `media/api.ts` 的 `DocsService.extractTextFromBase64`；不再复制 VFS 文件读取实现。
  `api.ts` 发布 `createVfsResolver(vfs, { vfsRepo, docs }, logger)`，调用方须 await。
- F4 time/util 已切换；F7 Rust regex 已用于用户输入正则。IO 错误文案仍引用平台
  paths/compat 的现有实现。死适配器删除后无本 lane HTTP 地址校验路径。

## 验证

```text
npx tsc --noEmit -p tsconfig.host.json
exit 0

npx vitest run --config vitest.host.config.ts host/plugins/agent-workspace/tests --maxWorkers 2
Test Files 31 passed
Tests 396 passed | 16 skipped (412)

npm run migration:wiring -- --lane agent-workspace
合计 ported 359，其中所测模块未从 index.ts 接入 0（0.0%）

npm run migration:boundaries:strict -- host/plugins/agent-workspace
scanned 109 files, 0 violation(s), 16 suppressed via boundary-allow

npm run migration:boundaries:strict
scanned 1641 files, 279 violation(s) {"console-log":235,"empty-catch":44}
全部违规位于其他 lane / 平台层；本 lane 仅有上述显式允许项。

npm run migration:ledger -- --check --no-write
commands 1058 (A 70% B 1.8% C 0%), tests 8036 (A 56.3% B 0.4%)
problems: commands 0, tests 341, orphan registrations 0
L05: commands 12/12 A; tests 359/401 A (89.5%)
L05 的 21 个问题均为 obsolete 尚未批准；其余 320 个属于外部 lane。
```

全量测试后仅调整 PDF preview 的 serde 必填字段验证和 VFS 工厂接缝测试，
`vfs-resolver-branches.test.ts` 5/5 与 host typecheck 再次通过。
16 个 skip 保留平台/原生/实机条件，未修改为通过。

## 待接线

- L03 `pipeline/history.rs`、L04 `handlers/send_message.rs` / `variant_handlers.rs`：
  消费 `createVfsResolver` 的异步入口。12 个 resolver Rust 测试继续 pending。
- `待接线：docs.extractTextFromBase64`：L18 已有契约，当前尚无 docs provider；
  生产工厂要求注入服务，不以静默缺省代替旧数据解析。
- L04 `completion_dispatcher.rs` / `handlers/workspace_handlers.rs`：消费
  `CompletionOutbox`；9 个 Rust 测试继续 pending。
- L04 工具花名册、worker 会话删除、L21 operation guard、F3 journal、
  L24 card-read-scope 的既有缺口详见 `LANE.md`。
- 审批服务更名已由 main 上 chat 的 `ctx.get('agentApproval')` 对齐。

## 21 个 obsolete ID（待协调者核实批准）

证据：`src-tauri/crates/dstu-agent/src/chat_v2/adapters/mod.rs:3–10` 明确说明
三个模块均为历史死代码；12–27 行只有 deprecated 模块声明与重导出。
`llm_adapter.rs:3–5` 另说明生产 pipeline 使用另一份内联实现。TS 无生产使用者，
5 个适配器/辅助模块和 3 个测试文件已删除。未修改 `migration/approvals.json`。

```text
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_generate_block_id_format
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_generate_block_id_uniqueness
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_block_id_created_once
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_finalized_before_content
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_multiple_tool_calls_unique_block_ids
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_tool_result_removes_from_map
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_tool_result_unknown_call_id
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_disabled_no_block
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_ended_no_new_block
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_content_block_created_once
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_finalize_all_clears_tool_blocks
crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_content_ended_prevents_double_finalize
crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_image_gen_options_serialization
crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_image_gen_options_default
crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_start_payload_format
crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_web_search_start_payload_format
crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_constants
crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_generate_block_id
crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_empty
crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_filters_low_scores
crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_relative_threshold
```
