# X2-frontend-contracts：前后端契约对账

目标：现有前端（`src/`，保持不变）发出的每个 IPC 调用和监听的每个事件，Host 侧都有严格等价的实现。

## 交付（只写 `scripts/electron-migration/frontend-audit/` 与 `docs/dev/electron-migration/audits/X2-frontend-contracts.md`）
1. 静态扫描工具（TS/Node 脚本 + 测试）：用 TypeScript AST 扫描 `src/` 中所有 `invoke(...)`、`listen(...)`/`once(...)`、`emit(...)` 及项目内的封装（如 TauriAdapter、各 api 模块对 invoke 的包装——先找出封装层，按封装的参数位置提取），得到：命令名、参数对象的键与类型（能从 TS 类型推断的就推断）、事件名与 payload 类型。动态命令名要列出并人工归类。
2. 与 `contracts/ipc/*.json`（Rust 抽取的权威契约）和 Host 实际注册表（运行时加载插件取 `meta.commands` / 注册结果）三方对账，输出：前端调用但 Host 未注册；Host 注册但契约缺失；参数键名/大小写不一致（Tauri 的 camelCase ↔ snake_case 转换规则必须按 Tauri 2 原行为核对）；事件名或 payload 字段不一致。
3. 产出机器可读结果（JSON）+ 人读报告，按归属 lane 分组；提供 `--check` 模式供以后接入门禁。
4. 不改前端、不改插件：问题由协调者分发。

完成后贴出：调用点总数、命令/事件对账统计、按 lane 的不一致清单（前 30 条）。
