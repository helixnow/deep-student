# tauri-plugin-mcp

调试用 MCP 工具定义（TypeScript），配合 `src-tauri` 的可选 feature `mcp-debug`（依赖 `tauri-plugin-mcp-bridge`）使用，用于在开发期通过 MCP 驱动/检查 Tauri 应用。

- `src/tools/index.ts` — 暴露给 MCP 客户端的工具定义
- 启用方式：`cargo build --features mcp-debug`（见 `src-tauri/Cargo.toml`）

生产构建不包含此目录的能力。
