# 第一轮补充：工具面与缓存

来源：[Tools and cache impact](d3ab2581-4092-434f-b965-925e046e6dee)

转换层本身不差：hosted 非 function 透传、`strict` 缺省钉 `false`、`function_call_output` 规范。短板在编排。

## 新发现

1. **G6 排序是 no-op。** `tool_loop.rs` 按顶层 `name` 排序，但 schema 是嵌套 CC，名字在 `function.name`。比较的全是空串，顺序仍跟前端拼装走。
2. **多变体写 `llm_context["tools"]`，管线只读 `custom_tools`。** 变体落到未排序的 legacy `build_tools_with_mcp`。
3. hosted `tool_choice`（如 `{"type":"web_search"}`）被静默丢弃。
4. `parallel_tool_calls` 转换层能透传，上游从不设置。

`function_call_output` 回传格式符合 Responses，不额外破坏前缀。hosted `web_search_call` 仍不进历史（与既有结论一致）。
