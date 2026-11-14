# X6-gate-checks：机械门禁检测器（质量标准 v2 §4）

先读 `docs/dev/electron-migration/standard-v2.md`（尤其 §1、§4）和 `quality.md`。

目标：把复核里反复出现的问题类型变成**机器能拦的门禁**。检测器必须准，宁可漏报也不要大量误报——误报多了大家会学会绕过它。

## 交付（只写 `scripts/electron-migration/gate-checks/` 与 `docs/dev/electron-migration/audits/X6-gate-checks.md`）

按顺序做，每个检测器单独可用、单独提交，都带测试，都支持 `--check`（有违规退出 1）和 `--changed <文件...>`（只查改动文件，供集成门禁使用），以及 `--json` 报告：

1. **single-writer**：从各插件 SPEC/ARCHITECTURE/contracts 与 Rust schema 推出"表 → 所有者插件"映射（落盘为 `gate-checks/table-owners.json`，有歧义的列出来交协调者裁定），扫描 `host/plugins/*/` 生产代码中对每张表的写 SQL（INSERT/UPDATE/DELETE/REPLACE/UPSERT，含模板字符串与 SqlExecutor 调用），报告越权写入与重复仓储。
2. **unchecked-decode**：生产代码里 `JSON.parse(...)` 的结果直接 `as T` / 传给类型断言、`as unknown as`，以及 IPC 入参未经解码直接解构。允许名单只接受经批准的解码器模块。
3. **prod-reachable**：对每个 TESTMAP `ported:` 行，取测试文件 import 的被测符号，判断它能否从插件 `index.ts` 的 register/provide 静态到达（TS 编译器 API 建调用图，保守处理动态分派）；输出不可达清单。完成后与 C1/C2 协调把它接进 `lib/ledger-core.mjs` 的 A 级条件（改 ledger 的提交由你做，但须先在审计文档里列出受影响的命令/测试数）。
4. **assert-parity**：Rust 测试的 `assert!/assert_eq!/assert_ne!/assert_matches!/panics` 计数 vs 对应 TS 用例的 `expect` 计数（按 TESTMAP 对应），TS 更少即违规；输出明细。
5. **log-parity**：按 SPEC 中的 Rust→TS 函数映射（无映射时按文件对应），Rust `warn!/error!` 次数 vs TS logger warn/error 调用；输出缺失明细（这一项先只报告不拦截）。

每完成一个：在全仓跑一遍，把结果（按插件计数 + 典型样例）写进审计文档，并用 `coord.mjs queue C1-app/C2-platform` 交给协调者分发给各 lane 负责人；协调者确认误报率可接受后，你再把它接进 `integrate-parallel.mjs` 的检查列表（对改动文件生效）。
