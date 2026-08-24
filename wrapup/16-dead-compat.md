# Dead compatibility / CardForge 收尾（子代理 #6）

日期：2026-08-24

## 结论

| 残留 | 仓内消费者 / 测试证据 | 处置 |
|---|---|---|
| `chat_v2_anki_cards_result` | 全仓搜索只命中 handler、重导出、Tauri 注册、权限和历史文档；`src` 无 `invoke`，测试无调用或 request 类型依赖 | 删除 handler 与私有 request 类型，并同步删除重导出、注册和权限 |
| `CardAgent` / `cardforge` 前端模块 | `selectionCardGeneration.ts` 的划词制卡生产路径调用 `cardAgent.startGeneration`；聊天 APKG 导出消费 `validateCardsForExport`；`CardAgent.test.ts` 覆盖事件与生成契约 | 保留。它不是聊天内 ChatAnki 主执行器，但仍是划词入口与共享导出工具的兼容 facade |
| `anki_generate_cards` 历史工具名 | 无执行器、无 schema、无白名单入口；只在 headless 禁止清单中出现 | 隔离保留，防历史会话或外部注入在无 WebView 时挂起；新增定向测试锁定 fail-closed 状态 |
| `call_llm_for_boundary` | `ExplainPopover` 和 `CardAgent.analyzeContent` 仍调用 | 保持注册；名称陈旧不等于死命令，本轮不做破坏性重命名 |
| Rust 中 “CardForge 2.0” 注释下的模板、流事件与定界服务 | `streaming_anki_service`、`enhanced_anki_service` 和现行生成 options 仍在 ChatAnki 共用生产管线中 | 保留实现；这些是被现役管线复用的服务，不是旧前端桥 |

## 删除边界

旧结果回调依赖的前端 `anki_tool_call → CardAgent.handleToolCall` 桥和后端
`AnkiToolExecutor` 已先行删除。当前应用不会再发起该 Tauri 调用，因此继续暴露
回调只会扩大命令面并制造“仍有消费者”的错觉。删除会终止对仍直接调用该命令的
旧客户端兼容；这是本次 dead-compat 收口的明确边界，不影响当前 ChatAnki、划词制卡、
任务台、导出或复习路径。

没有改动 `chatanki_executor.rs` 主执行逻辑。

## 守卫

- `block_actions` 单测读取 handler、handler 重导出、`lib.rs` 注册表和应用权限清单，
  断言旧回调不得重新出现在任一命令面。
- `headless` 单测断言 `anki_generate_cards` 必须留在 `frontend-bridge` 隔离清单，
  且不得进入允许集或模型可见 schema。

## 验证命令

```bash
cargo test --lib removed_cardforge_callback_stays_off_command_surfaces
cargo test --lib retired_frontend_anki_tool_stays_fail_closed
npx vitest run tests/vitest/anki/cardforge/CardAgent.test.ts \
  src/features/chat/services/__tests__/selectionCardGeneration.test.ts
```
