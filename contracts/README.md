# Node IPC 契约

`ipc/*.json` 是 Node Host 和前端共同使用的 JSON Schema **源文件**，不再从 Rust 声明抽取。

新增或修改命令：

1. 在所属 `ipc/<领域>.json` 中维护 `commands` 的 `name`、有序 `args`、`result`，必要时声明 `error`；共享类型放 `_shared.json`。
2. 在 Host 插件中实现并注册命令，补齐应用 ACL。
3. 运行 `npm run contracts:generate` 生成 `ipc/generated/*.ts` 与报告。
4. 运行 `npm run contracts:check` 校验 Schema、引用及生成物，并运行相关命令测试。

`source` 可注明当前 TS 实现的仓库相对路径。新命令不需要 `rust`、`rustName` 或 Rust 文件。
存量 `rust` / `x-rust` 只记录历史迁移来源；`x-int`、`x-option`、枚举等运行时语义注解仍有效，不能批量删除。
`generator` 是原始契约的来源信息，不意味着 JSON 仍由该生成器管理。

不要手改 `ipc/generated/`；修改契约时在 `CHANGES.md` 记录接口变化。
