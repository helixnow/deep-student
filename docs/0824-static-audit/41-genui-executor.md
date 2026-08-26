model=gpt-5.6-sol-xhigh-fast
# 41 — GenerativeUiExecutor 注册与块类型映射审计

审计范围：`GenerativeUiExecutor` 的注册时机、相对 catch-all 的顺序，以及
`render_generative_ui` 在实时保存和上下文保存路径中的块类型映射。

## 结论

**PASS。`GenerativeUiExecutor` 在 Pipeline 构造注册表时注册，稳定早于
`GeneralToolExecutor` catch-all；`render_generative_ui` 与
`builtin-render_generative_ui` 均会由专用执行器接管，并映射为
`generative_ui` 块。未发现注册过晚、被 catch-all 抢占或落入
`mcp_tool` 的生产路径。**

本轮不改代码。

## 注册时机

- `src-tauri/src/chat_v2/pipeline.rs:212-243`：`ChatV2Pipeline::new()` 在返回实例前
  调用 `create_executor_registry()`，因此执行任何工具前注册表已经完整。
- `pipeline.rs:299-347`：注册表由
  `create_executor_registry_with_workspace(None)` 构造，并在第 347 行加入
  `GenerativeUiExecutor`。
- `pipeline.rs:275-278`：绑定 `WorkspaceCoordinator` 时会重建注册表；该路径仍复用
  `create_executor_registry_with_workspace(Some(...))`，不会丢失或延后
  `GenerativeUiExecutor`。

## catch-all 之前

- `pipeline.rs:347` 先加入 `GenerativeUiExecutor`；`pipeline.rs:404-410` 最后才在
  `Arc::new_cyclic` 中加入 `ToolPackExecutor` 和
  `GeneralToolExecutor`，且注释明确后者必须最后。
- `tools/executor_registry.rs:233-264` 按注册顺序调用 `can_handle` 并返回第一个匹配项，
  所以上述相对顺序是实际路由语义，不只是排列习惯。
- `tools/general_executor.rs:56-60` 的 `GeneralToolExecutor::can_handle` 接受所有非
  Canvas 工具，确属 catch-all；若专用执行器移到其后就会不可达，但当前没有该问题。
- `tools/generative_ui_executor.rs:19,347-351` 以
  `strip_tool_namespace(tool_name) == "render_generative_ui"` 匹配；
  `tools/types.rs:180-189` 会剥离 `builtin-`，故裸名和 builtin 名均在到达
  catch-all 前命中专用执行器。

## `render_generative_ui` 映射

- 非 interleaved 的 Pipeline 持久化路径在
  `pipeline/persistence.rs:936-958` 调用 `tool_name_to_block_type`；
  `pipeline.rs:432-453` 先规范化工具名，再将 `render_generative_ui` 映射为
  `block_types::GENERATIVE_UI`。因此裸名和 `builtin-` 前缀形式都得到
  `generative_ui`。
- 上下文聚合与执行器直接保存分别经
  `context.rs:979-1003` 和 `tools/executor.rs:592-603` 调用
  `PipelineContext::get_block_type_for_tool_static`；该函数在
  `context.rs:1043-1069` 同样剥离 `builtin-` 并完成相同映射。
- `tools/generative_ui_executor.rs:493-504` 的单元测试显式锁定
  `render_generative_ui` 与 `builtin-render_generative_ui` 两种名称均映射为
  `GENERATIVE_UI`；`tests/vitest/generative-ui/generativeUiRustMapping.contract.test.ts`
  还对 Pipeline 与 Context 两处源码映射建立契约检查。

综上，执行器选择与块类型保存两层均覆盖实际 builtin 工具名；注册顺序和映射没有
断点。
