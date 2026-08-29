# 0824 release：VFS note props 兼容审计

## 范围与基线

- 隔离分支：`cursor/0824-rel-vfs-cde6`
- 基线：`origin/cursor/0824-cde6`
- 对照发行版：`v0.9.44`（VFS head 为 `V20260808`）
- 新迁移：`V20260824__note_props.sql`

`v0.9.44` 的 `notes` 表没有 `props` 列；升级后历史行应保持原内容，
并以 SQL `NULL` 表示“没有自定义属性”。

## 上游 backfill 状态

截至 2026-08-25 本次隔离时：

- `3d3516c349701c8f69c500e5d452861b65437673` 是 GitHub 上的原始
  “backfill VFS tables before change log repair”提交；
- `b2a85a6900034943a2bedb7c5ebcf95ec7854fea` 是已进入 `origin/main`
  的对应修复；
- `b2a85a69` 不是 `origin/cursor/0824-cde6` 的祖先，`0824` 尚未包含该修复。

该 backfill 修复的是更早的稀疏旧库（只有 `resources/notes`，缺少
`questions/review_plans/folders`）在重放 `V20260131` trigger 时失败的问题。
完整的 `v0.9.44` 数据库已经具有这些表，所以 note-props release 修复不依赖
该提交；若它并行落到 `0824`，本分支的 `V20260824` 专项 pre-repair 仍可独立工作。

## 发现与修复

### 1. duplicate-column 重跑会卡死

迁移 SQL 是 SQLite 必需的裸语句：

```sql
ALTER TABLE notes ADD COLUMN props TEXT;
```

仓库的通用 `make_alter_columns_safe` 只允许处理到 `V20260801`；
`V20260824` 超过冻结边界，因此原 SQL 注释所称的通用兜底实际不会运行。
若 SQLite 已提交 `ALTER`、进程却在写 `refinery_schema_history` 前退出，
下一次 Refinery 重放会报 `duplicate column name: props`。

修复是在 VFS pre-repair 中显式收敛：

- 列存在、history 缺失：按当前 runner 的 name/checksum 补 migration 记录；
- history 存在、列缺失：补 `notes.props TEXT`；
- 两者都缺失：不抢跑，仍由 Refinery 正常执行。

### 2. migration registry 漏登记

SQL 文件会被 `refinery::embed_migrations!` 执行，但静态 `VFS_MIGRATIONS`
此前仍停在 `V20260808`。结果是：

- `VFS_SCHEMA_VERSION` 错报旧版本；
- `MigrationVerifier` 不验证 `notes.props`；
- schema fingerprint/pending 迁移的静态契约与真实 runner 分叉。

现已登记 `V20260824_NOTE_PROPS`，并声明预期列 `notes.props`。

### 3. `NULL` 与 `{}` 双表示

统一契约如下：

- 数据库存储：无属性和空对象都规范化为 SQL `NULL`，不回填历史行；
- Rust：`VfsNote.props == None`；
- DSTU 输出：`metadata.props == {}`，调用方始终看到对象；
- DSTU 输入：`props: null` 与 `props: {}` 都表示清空；
- 有值时只允许 JSON object，值只允许 string/number/bool。

这样既避免数据库中同时存在 `NULL`/`'{}'`，也避免前端在 `null`/`{}`
两种等价 API 表示之间分叉。

### 4. metadata 写入会部分成功并静默丢字段

原 notes 分支依次调用 title/tags、favorite、props 三次写入：

- 后一步校验失败时，前一步已经提交；
- 一次用户操作推进多次 `updated_at`；
- 参数 `expected_updated_at` 被忽略；
- 非字符串 tag 被 `filter_map` 静默删除；
- 未识别的顶层字段被静默忽略。

现改为一次 repo CAS `UPDATE`：

- 所有字段先校验，再原子提交；
- `expected_updated_at` 接入同一条 SQL 的比较条件；
- 未提供的字段保持原值；
- 未知顶层字段明确报错，并提示自定义字段放入 `props`；
- `props` trim 后大小写重复键会被拒绝，避免规范化/搜索时静默覆盖。

### 5. FieldMerge / LWW 契约不清楚

`notes` 仍是 RowSync + FieldMerge：

- `tags`：集合并集（含单值 tag 归一）；
- `is_favorite`：布尔 OR；
- `props`：**不**进入自动 FieldMerge picklist，整个 JSON 对象按行级 LWW。

任意 JSON object 没有普适、交换且幂等的深合并规则。把 `props` 注册为
FieldMerge 会造成删除键复活或不同设备各自收敛到不同结果，因此这里明确测试
whole-object LWW，并把 classification 的 `has_json_blobs` 修正为 `true`。

### 6. `key:value` 搜索只在前端截断后过滤

原 full-text 模式先取有限候选，再在浏览器过滤 `metadata.props`。匹配项若排在
候选上限之后会漏搜；同时解析器只接受 ASCII 属性名，无法搜索合法的 Unicode
属性键。

现已：

- `DstuListOptions` 增加 `propFilters`，notes 后端在分页前过滤属性；
- 内容索引召回合并后再次守住属性过滤；
- 前端 full-text 请求下推 `propFilters`；
- 操作符解析支持 Unicode 键，例如 `状态:已完成`；
- 键匹配不区分大小写，值对 string/number/bool 做不区分大小写的包含匹配。

## 回归覆盖

- 从 `v0.9.44` VFS head 升级，历史 note 保留且 `props IS NULL`；
- `ALTER` 已落盘/history 缺失的 duplicate-column 重跑；
- history 已记录/列缺失的反向 schema gap；
- migration registry/schema head；
- props round-trip、清空、重复键与形状校验；
- 多字段 metadata 原子性和 stale OCC；
- DSTU `NULL -> {}` 边界规范化与未知字段拒绝；
- props whole-object LWW；
- Unicode `key:value` 与 full-text filter 下推。
