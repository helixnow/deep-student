# X7-differential：Rust ↔ TS 差分对照（C 级证据，原 F6 职责）

先读 `docs/dev/electron-migration/standard-v2.md`、`README.md` §4.1、`lanes.md` 的 F6 一节。

目标：同一输入，Rust 与 TS 各跑一次，比较返回值 / 错误 / 事件 / 数据库变化。这是迁移质量最硬的证据，不依赖任何人的判断。

## 约束
- **Rust 编译极耗资源（用户明确要求），尽量只编一次，之后反复用：**
  - Rust 侧只做**一个**数据驱动的程序 `dstu-differential`：读入 JSON 请求 `{fn, args}`，分派到对应的 Rust 函数，输出 JSON 结果。
    新增用例只加数据文件，不重新编译。Rust 源码是冻结的对照基准，不会变；编好的产物长期复用。
  - 开编之前，先把第 1、2 项需要的**全部**可调用函数一次列全，写进审计文档，交协调者批准，然后只编这一次。
    以后确实要新增函数时，攒成一批再申请，不要零星重编。
  - 编译一律走作业队列，设置 `CARGO_BUILD_JOBS=8 nice -n 10`，复用同一个 `target/`，不清理缓存，不加 `cargo clean`。
    用 release 档还是 dev 档，以总耗时最小为准，并写明理由。
  - 能用**代码对照**（静态审读、从 Rust 源码提取常量和结构定义）解决的，就不跑 Rust。
    比如 serde 结构的字段名、可选性、`rename_all`，可以直接解析 Rust 源码生成期望值，不需要编译。
- 本 lane 是唯一允许运行 cargo 的 lane。服务器暂未安装 Rust 工具链：在工具链就绪前，先完成所有不需要 cargo 的部分（框架、TS 侧、剧本、规范化、比对器）。
- cargo 构建一律经作业队列（`job.mjs submit -- cargo ...`，归 build 类），用隔离数据目录，绝不碰任何用户数据。
- 只写 `fixtures/`、`scripts/electron-migration/record/`、`host/e2e/differential/`、`src-tauri/crates/dstu-differential/`（新建的独立 crate，依赖既有 crate，不改既有 Rust 源码）与 `docs/dev/electron-migration/audits/X7-differential.md`。

## 交付（按价值排序）
1. **纯函数向量差分**：挑出可直接调用的纯逻辑（FSRS、KDF/加密、分块、token 估算、cloze/模板渲染、路径规范化、serde 结构解码等），Rust 侧用 examples 二进制读 JSON 输入、写 JSON 输出；TS 侧调用对应生产函数；随机 + 边界输入生成器；比对器输出首个差异。
2. **serde 往返差分**：对所有持久化 / IPC 结构（从 contracts 与 Rust struct 收集），用 Rust 生成规范样本（含缺省字段、未知字段、大整数、枚举各变体），TS 解码再编码，比较；这一项直接覆盖标准 v2 §1.3。
3. **命令回放框架**：同一份规范化 SQLite 快照 + 同样 IPC 调用序列，分别驱动 Rust（headless 命令调用 harness）与 TS Host，比较返回 / 错误 / 事件 / 规范化 DB diff（按主键排序，易变列按契约 volatile 归一）。外部依赖用脚本化假供应商。
4. 接入 `ledger.mjs --golden`，让 C 级有真实数据；按 lane 输出差异清单交协调者分发。

每完成一项，把覆盖范围与发现的差异写进审计文档，并经 `coord.mjs queue` 交协调者分发。
