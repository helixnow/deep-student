# 数据库迁移目录

本目录包含所有数据库的迁移脚本，由 vendored 的 [Refinery](https://github.com/rust-db/refinery) 0.9
（`src-tauri/vendor/refinery-core`）执行，并由 L1 静态门禁（`scripts/check-migrations.mjs`）锁定。

## 目录结构

```
migrations/
├── vfs/                 # VFS 虚拟文件系统数据库（纳入数据治理）
├── chat_v2/             # Chat V2 对话历史数据库（纳入数据治理）
├── mistakes/            # Mistakes 错题本数据库（纳入数据治理）
├── llm_usage/           # LLM Usage 使用统计数据库（纳入数据治理）
├── browser/             # 内置浏览器独立库（一期豁免治理，见下）
└── migration-lock.json  # L1 静态门禁 lock manifest（勿手工编辑）
```

### `browser/`（一期豁免）

- **文件**：`{active_slot}/browser.db`；配套 profile 目录 `{active_slot}/browser-profiles/default/`（不进本目录 SQL）
- **迁移**：模块内 Refinery embed（`src-tauri/src/browser/`），**不**挂 `MigrationCoordinator::run_all()`，**不**进 `DatabaseId`
- **懒加载**：仅当 workbench + browser 双闸开启且首次 `browser_open_session` 时建库迁移
- **清除**：清历史 = DB；清 Cookie = profile；全部 = 两者；禁用浏览器 flag = **保留**文件
- **规格**：`docs/dev/workbench-browser-design.md` §9
- **门禁**：纳入 lock manifest 与危险扫描，但豁免 Rust `MigrationDef` 对应检查

## 迁移文件命名规范

### 格式

```
V{version}__{description}.sql
```

- **version**：纯数字，本仓库约定为日期形态 `YYYYMMDD`（如 `20260130`）
- **description**：小写字母 + 下划线（snake_case）

### 示例

```
V20260130__init.sql                  # 2026-01-30 初始化
V20260201__add_sync_fields.sql       # 2026-02-01 添加同步字段
```

### 为什么必须是纯数字版本（没有 `_NNN` 序号段）？

Refinery 0.9 用正则 `^([U|V])(\d+(?:\.\d+)?)__(\w+)` 解析文件名，
版本被解析为 **i32**。这意味着：

- `V20260130_001__init.sql` **不可解析**（`_001` 不是 `__` 分隔符的一部分），
  文件会被 Refinery **静默忽略**——严禁使用这种带序号段的旧格式
- `V20260130.1__x.sql` 小数版本在 i32 版本类型下解析失败
- 版本必须 ≤ 2147483647（i32 上限）
- 本仓库只允许 `V` 前缀（版本化迁移），不使用 `U` 前缀

**同日多个迁移冲突时**：同一数据库目录内版本号必须唯一。
第二个迁移取下一个未被占用的纯数字版本（通常是下一天的数字，如
`V20260723` 已占用则用 `V20260724`），静态门禁会拦截同版本冲突与
低于已锁定最大版本的乱序新增。

## 重要规则

1. **已发布的迁移不可修改/删除/重命名**：lock manifest + CI base-ref 校验会拦截，
   即使同步改掉 manifest 也会失败；修复问题请新增迁移
2. **回滚通过新增迁移实现**
3. **每个迁移必须有配套 Rust `MigrationDef`**（browser 除外）：
   版本号、`include_str!` 路径与文件名一一对应，静态门禁校验
4. **危险 SQL 必须显式声明**：见下方“危险 SQL 与机器可读注解”

## L1 静态门禁（lock manifest）

`src-tauri/migrations/migration-lock.json` 记录每个迁移的
数据库归属 / 版本 / 路径 / SHA-256 / 存量危险豁免。常用命令：

```bash
# 本地全量校验（manifest 完整性、版本唯一、hash、Rust 对应、危险 SQL）
node scripts/check-migrations.mjs

# CI 不可变性校验：base 分支已锁定的条目不得被修改/删除/重命名，
# 危险豁免只信 base manifest（同步篡改当前 manifest 无效）；
# base 上尚无 manifest 时自动跳过（首次引入 bootstrap）
node scripts/check-migrations.mjs --base-ref origin/main

# 新增迁移后更新 lock manifest（新条目不会自动继承危险豁免）
node scripts/check-migrations.mjs --update

# 审计模式：盘点全部危险发现（含存量豁免/已声明），不影响门禁结论
node scripts/check-migrations.mjs --all

# 机器可读输出
node scripts/check-migrations.mjs --json
```

### 危险 SQL 与机器可读注解

静态识别的风险类别：`delete_without_where`、`drop_table`、`drop_column`、
`unique_constraint`、`add_not_null_column`、`table_rebuild`、`add_column_backfill`。

新迁移触发上述规则时，必须在脚本内添加机器可读注解声明（`@allow-data-change` 为等价别名）：

```sql
-- @danger-ack: drop_table reason="legacy 表已由 V20260131 替代，确认无数据引用"
DROP TABLE legacy_cache;
```

注解只声明风险类别与理由，**不包含 reviewer 身份**——门禁不从 SQL 文本信任
任何审批人，审批体现在 code review 本身。历史迁移的存量危险已在首次建锁时
grandfather 进 manifest，不会阻塞现有仓库；条目内容一旦变化（hash 不一致）豁免即失效。

## 迁移定义（Rust 侧）

每个迁移在 `src-tauri/src/data_governance/migration/{vfs,chat_v2,mistakes,llm_usage}.rs`
中注册 `MigrationDef` 并声明验证配置：

```rust
// src-tauri/src/data_governance/migration/vfs.rs

pub const V20260201_ADD_SYNC_FIELDS: MigrationDef = MigrationDef::new(
    20260201,
    "add_sync_fields",
    include_str!("../../../migrations/vfs/V20260201__add_sync_fields.sql"),
)
.with_expected_columns(&[
    ("resources", "device_id"),
    ("resources", "local_version"),
])
.with_expected_indexes(&["idx_resources_local_version"])
.idempotent();
```

新增后记得追加到该库的迁移数组（如 `VFS_MIGRATIONS`），否则静态门禁会报
“缺少对应的 Rust MigrationDef”。

## 本地测试迁移

```bash
# L1 静态门禁 + 自测
node scripts/check-migrations.mjs
node --test scripts/__tests__/check-migrations.test.mjs

# 生产迁移框架单元测试（带最小测试数校验，防假绿）
bash scripts/migration-ci/run-migration-tests.sh
# 等价于：cargo test --lib data_governance::migration（在 src-tauri/ 下）
```

## 参考文档

- [Refinery 文档](https://docs.rs/refinery/)（本仓库 vendored 0.9：`src-tauri/vendor/refinery-core`）
- `scripts/migration-ci/README.md`（分层 CI 门禁：PR / nightly / release）
- [SQLite Backup API](https://www.sqlite.org/backup.html)
