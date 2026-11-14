# X6-PR-0113：Rust test-only schema 的裁定请求

精确测试 ID：`src/chat_v2/tools/user_todo_executor.rs::mfjs_schema_tests::mfjs_normalizes_real_rust_builtin_tool_schemas`。

2026-11-04 对 main `879e0a56b` 执行 `git grep -n get_user_todo_schemas main -- src-tauri`，仅有：

- `src-tauri/src/chat_v2/tools/user_todo_executor.rs:441`：`get_user_todo_schemas` 定义。
- 同文件 `:1823`：上述 MFJS 测试中调用。没有生产调用点。

TS 现状：

- `src/user-todo-schemas.ts:39` 的 `getUserTodoSchemas` 只被 `tests/user-todo-executor.test.ts` 调用，没有生产 register/provide 可达路径。
- 该测试 `:240-241` 先取 schema，再调用本测试内 `normalizeMfjsForTest`（定义在 `:152`）。它是 L02 算法的测试替身，不能证明真实 L02 规范化行为。
- main 的 `host/plugins/llm/api.ts` 当前无正式 MFJS 规范化出口；已有缺口 B-MFJS 不因此解除。

处理原则（按 C1 最新要求）：保留原测试、原断言及新规则下该精确行不计 A 的事实，不新造生产调用、不假 export、不擅自标 obsolete，也不把 Rust test-only 当成已批准例外。

请求 C1/C2 裁定此精确行的登记方式，并请 L02 发布真实规范化入口。未裁定前保持 X6-PR-0113 / B-MFJS 未闭合；不影响其余生产 executor 的注册测试。
