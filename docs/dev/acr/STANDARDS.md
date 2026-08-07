# ACR 工程规范（所有子代理必读，违反即返工）

## 1. 硬性纪律

1. **禁止一切 cargo 命令**（build/check/test/clippy/fmt 都不行，防编译锁互抢）。Rust 代码写完靠肉眼与模板对齐，由协调者统一编译验收。
2. **前端自验命令**（必须跑，全绿才算完成）：
   - `npm run typecheck`
   - `npx vitest run <你名下的测试路径>`（不要跑全量测试套件）
   - 改了 i18n 的加跑 `npm run check:i18n`
3. **只改任务卡"名下文件"**。热点文件（见 §5）只允许在指定锚点追加，一行都不许重排/重构他人代码。
4. **不 commit、不 push、不 revert 他人工作区**。当前分支 `nightly` 有未提交修改，属正常状态，勿动。
5. **不新增任何 npm/cargo 依赖**（yjs、framer 之外的动画库等一律禁止；需要依赖找协调者）。
6. **不启动 dev server / tauri dev**。
7. 完成后必须写进度报告 `docs/dev/acr/progress/<任务ID>.md`（模板见 §6）。

## 2. 代码风格

- 注释与文件头：中文，多行 `/** */`，标注任务 ID（如 `R1-07`）与本文档路径。
- 前端：路径别名 `@/` = `src/`；tsconfig strict=false 但**新代码禁止 any 泛滥**（导出 API 必须显式类型）；组件用现有 UI 件（`DsButton` 等，禁 shadcn Button）；样式 tailwind + 设计 token，动画只用 transform/opacity。
- Rust：工具执行器契约 `Result<ToolResultInfo, String>`；业务失败 `Ok(ToolResultInfo::failure(...))`，只有执行器自身异常才 `Err`；`emit_tool_call_start/end/error` 必须成对；日志 `log::debug!/warn!` 带 `[模块名]` 前缀。
- i18n：所有用户可见文案 zh-CN + en-US 成对；workbench UI 用 `workbench` ns（`agent.*` 前缀段），chat 块用 `chatV2` ns（`blocks.workbenchOps.*`）；skill/工具描述面向 LLM，直接写中文，不走 i18n。
- 测试：vitest，co-located `__tests__/`；mock Tauri 用 `vi.mock('@tauri-apps/api/core')`（先 mock 再 import）；参考 `src/features/workbench/core/__tests__/windowStore.test.ts` 与 `tests/vitest/chat-v2/` 惯例。

## 3. 工具面设计规范（写 schema/描述时对照）

1. 工具对齐用户任务，不 1:1 包装 IPC；常串联无分支的步骤合并成一个工具。
2. 命名 `builtin-workbench_<verb>_<noun>`；参数名无歧义（`window_id` 不是 `target`）。
3. schema `additionalProperties: false`，枚举约束合法值；运行时已知的上下文（sessionId）不让模型填。
4. 描述必含：目的 / 何时用 / 何时不用 / 与相似工具边界 / 副作用（会开窗、会改数据）/ 成功返回什么。
5. 返回高信号：窗口标题+状态+下一步建议，不返回裸 UUID 堆；大列表分页截断并给"如何取更多"。
6. 错误结构化：`{ code, message, hint, retryable }` 塞进工具结果文本；禁止 "Error: failed"。
7. 长时工具（>300ms）必须发 progress；取消/打断必返回 partial（done/undone），禁止静默。

## 4. ACR 专用约定

- ACR 3.0 传输 `runId = acr3:<session 字节长度>:<sessionId>:<toolCallId>`；`toolCallId` 另字段保留原值。所有活跃表、presence、账本和工具卡查找必须同时绑定 session，禁止用裸 toolCallId 跨会话索引。
- `act`、领域工具 `apply_ops` 与 undo 共享事务、租约、取消及权威终态规则；不得把其中一条路径当作另一条的风险或 OCC 旁路。
- 精确窗口操作必须把 probe/observe 回执中的 `windowId` 传到 apply/act；多窗时禁止只按 typeId/resourceId 选择“最近挂载”实例。
- `RESULT_UNKNOWN` 必须先重新 observe/read；禁止原样重试或后台写回落。
- undo 统一为 High、每次确认、不可记忆授权；Notes 后台写必须携带最新 `expected_updated_at` 并走 CAS。
- presence 只从 `presenceStore` 读写；驱动器不得直接改 DOM 光环。
- 域事件 payload 必须符合 DESIGN §5.6；前端消费一律 `hubListen`，禁止组件内裸 `listen`（chat per-session 通道除外）。
- Driver 的 `apply` 内每个 op 之间必须 `await run.checkPaused()` 且调用 `run.reportProgress(...)`。
- 所有新“兜底/降级”行为必须出现在工具回执 message 里告知 LLM，不许静默降级。

## 5. 热点文件写权表（只追加、按锚点）

| 文件 | 唯一写权人 | 其他人 |
|---|---|---|
| `src-tauri/src/lib.rs` generate_handler! | R1-01 | 禁碰 |
| `src-tauri/src/chat_v2/pipeline.rs` 注册区(~L222-303) | R1-02 | 禁碰 |
| `src-tauri/src/chat_v2/tools/mod.rs` | R1-01（预留段一次加齐 mod/pub use） | 禁碰 |
| `src-tauri/src/chat_v2/events.rs` event_types / types.rs block_types | R1-01 | 禁碰 |
| `src-tauri/src/feature_flags.rs` | R1-17 | 禁碰 |
| `src/features/chat/skills/builtin-tools/index.ts` | R1-08 | 禁碰 |
| `src/features/chat/plugins/{blocks,events}/index.ts` | R1-09 | 禁碰 |
| `src/features/chat/plugins/events/toolCall.ts` remap 段 | R1-09 | 禁碰 |
| `src/features/workbench/index.ts` 末尾 export | R1-06 | 禁碰 |
| `src/features/workbench/components/WorkbenchDesktop.tsx` | R1-06 | 禁碰 |
| `src/features/workbench/components/WindowShell.tsx` | R1-10 | 禁碰 |
| `src/features/workbench/apps/*/register.ts(x)` | 对应 driver 任务各管各的 | 不跨应用 |
| `src/features/settings/.../WorkbenchSettingsSection.tsx` | R1-17 | 禁碰 |
| `src/locales/*/workbench.json` | 按 key 段分区：`agent.core.*`=R1-06/07/10、`agent.apps.<app>.*`=各 driver | 不碰他人段 |
| `src/locales/*/chatV2.json` `blocks.workbenchOps.*` | R1-09 | 禁碰 |
| `src/i18n.ts` / `src/App.tsx` / `registerAll.ts` | 协调者 | 全员禁碰 |
| `src/features/workbench/agent/**`（除 types.ts） | 按任务卡分文件 | types.ts 全员只读（协调者脚手架） |

冲突处理：确需改他人名下文件 → 在自己进度报告"跨界申请"一节写明，交 R2 接线轮处理，本轮绕开。

## 6. 进度报告模板（`docs/dev/acr/progress/<ID>.md`）

```markdown
# <ID> — <标题>
- 状态：已完成 / 部分完成（原因）
- 名下文件：<全列，含新建/修改>
## checklist
- [x] ...
## 自验
- typecheck: PASS / vitest <路径>: N passed / check:i18n: PASS
## 设计决策与偏差
## 跨界申请（需要动谁的文件、为什么）
## 遗留给 R2 的事项
## 新增 i18n keys
```

## 7. 验收流程（协调者执行，供知悉）

每轮结束：`cargo check`（协调者跑）→ `npm run typecheck` → `npm run lint` → `npx vitest run`（全量）→ `check:i18n` → 按 SCENARIOS.md 冒烟 → 汇总返工单 → 进下一轮。SOTA 终验标准见 DESIGN §7 + SCENARIOS.md。
