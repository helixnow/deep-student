# X7 场景 v0：seed 与 SQLite 终态接口（WP-044）

## 可用 seed

| `scenario.seed` | 来源 | 内容 |
|---|---|---|
| `empty` | 空目录 | 空 `app-data/`、`local-data/`；首次启动的建库由 A/B 自己执行 |
| `historical-wp013-v1` | **SQL 构造**，复用 WP-013 夹具 | 五个 refinery 库 + audit/sync_state/workspace，共八库；47 个显式业务 seed 表 |
| `skill-zip-v0` | **合成文件**（WP-094），`provenance=synthetic-zip` | 空 `app-data/`、`local-data/`；`home/w0-zip-seeds/` 下 10 个 L07 技能 ZIP 输入，见文末 |
| `l22-temp-sessions-w0` | **SQL 构造**（WP-115），`provenance=sql-constructed` | 五个 refinery 库按当前迁移重放、无业务行；`mistakes.db` 再原样执行 L22 种子 SQL（24 行 `temp_sessions`、2 行 `settings`、1 个触发器），见文末 |
| `l15-review-cas-tombstone-w0` | **SQL 构造**（WP-116），`provenance=sql-constructed` | 五个 refinery 库按当前迁移重放；`mistakes.db` 按 Rust 原测试夹具 SQL 写入精确 i64 reviewVersion 卡片与 card/task 软删除，见文末 |
| `f3-llm-usage-rows-w0`、`l16-pending-memory-w0`、`wp227-legacy-chat-w0`、`l04-wp226-goal-todo` | **SQL 构造**（W21 `__fixtures__/slot-seeds.ts`） | 五库迁移重放后，对 owner 库原样执行 owner 种子 SQL（与场景同目录的 `<seed>.sql`），见文末 |
| `f3-inactive-slot-data-w0`、`f3-startup-recovery-incident-w0` | **SQL 构造**（W21 `slot-seeds.ts`） | 数据空间布局：slotA/slotB 均为迁移重放库 + `slots/state.json`；恢复事件种子另有旧版根目录库、无迁移完成标记，见文末 |

**目录布局（W21，2026-11-07）**：两端都打开 `$XDG_DATA_HOME/<identifier>`（A：Tauri `app_data_dir`；B：`appDataDir = dataDir/<identifier>`），
identifier 为 `com.deepstudent.differential`。所以槽位数据写在 `app-data/com.deepstudent.differential/slots/...`
（`scenario-seeds.ts` 的 `appDataRoot()`）；`dirs::data_local_dir()` 在 Linux 上就是 `XDG_DATA_HOME`，sync_state 在 `app-data/deep-student/sync/`。
此前写在 `app-data/slots/...` 的种子两端都读不到（B 上 L22 场景返回"临时会话不存在"）。`local-data/` 保持为空。

第二个名字是本 lane 的夹具版本，**不是历史发布 tag 或 A 端真实产物**。五库按当前 checkout 的
`src-tauri/migrations/{vfs,chat_v2,mistakes,llm_usage,browser}` 原 SQL 顺序构造，复用 F3
`refineryChecksum`；历史三库直接重放 `__fixtures__/historical/` 固定 Git 来源 SQL。
五库 132 条迁移，三库原生版本机制，不伪造 refinery history。该组合不是某个发行版完整目录。
记录实际运行 checkout SHA；只构造一次源目录，再复制给 A1/A2/B。真实发布产物待 WP-043 后另包接入。

历史固定来源及原行号见 [`__fixtures__/historical/SOURCES.md`](./__fixtures__/historical/SOURCES.md)：

- audit：`1813b3c9c16eff57768ad884d96b6f5a9b447a54`，无编号 schema。
- sync_state：`de1159c149c2b6064532443d87189ab3b56ed768`，六表版本，无事件发布表。
- workspace：`41a5ca8f1ff92f761eabd7594b676bcbc75d9e04`，真实 `user_version=1`。

## API（从仓库根目录 import）

```ts
import { createSeed, resolveSeed, copySeed } from './host/e2e/data-compat/__fixtures__/scenario-seeds.ts';
import { snapshotDirectory, compareDatabaseStates, compareDatabaseDirectories }
  from './host/e2e/data-compat/__fixtures__/database-state.ts';

const catalog = 'host/e2e/data-compat/.tmp/scenario-catalog';
createSeed('historical-wp013-v1', catalog); // 源目录必须不存在或为空
const source = resolveSeed('historical-wp013-v1', catalog); // 纯解析，不建库
const a1 = copySeed(source.name, catalog, 'host/e2e/data-compat/.tmp/run/A1');
const a2 = copySeed(source.name, catalog, 'host/e2e/data-compat/.tmp/run/A2');
const b  = copySeed(source.name, catalog, 'host/e2e/data-compat/.tmp/run/B');
// 各 runner 配置 app data = *.dataDir；OS local data = *.dataLocalDir。
// 关闭各 runner 的写者后，分别保存不可变的 A1.raw.json/A2.raw.json/B.raw.json：
const rawA1 = snapshotDirectory(a1.directory);
const rawA2 = snapshotDirectory(a2.directory);
const rawB  = snapshotDirectory(b.directory);
const aDoubleRecord = compareDatabaseStates(rawA1, rawA2);
const rawAB = compareDatabaseStates(rawA1, rawB);
// 或 compareDatabaseDirectories(a1.directory, b.directory)
// 返回 { equal, before, after, differences }，两个原始快照均保留。
```

签名：

- `resolveSeed(name: string, catalog: string): SeedDirectory`
- `createSeed(name: string, catalog: string): SeedDirectory`
- `copySeed(name: string, catalog: string, destination: string): SeedDirectory`
- `enumerateDatabases(directory: string): string[]`
- `snapshotDatabase(filename: string): DatabaseState`
- `snapshotDirectory(directory: string): DirectoryState`
- `compareDatabaseStates(before: DirectoryState, after: DirectoryState): DatabaseDifference[]`
- `compareDatabaseDirectories(left: string, right: string): { equal, before, after, differences }`

`SeedDirectory` 有 `name/provenance/directory/dataDir/dataLocalDir`，路径全部绝对化。
复制要求源为已构造且停止写入的完整 seed；目标为空且不与源重叠。完整复制目录，不只复制 `.db`。
`DirectoryState.version=0`，`databases` 的 key 是相对输入目录的 POSIX 路径，不带隔离目录的随机前缀。
读取错误直接抛出，不把失败数据库当作空库或漏掉。

## 数据库与表枚举、排序

`historical-wp013-v1` 的八个相对文件名：

```text
app-data/com.deepstudent.differential/slots/slotA/browser.db
app-data/com.deepstudent.differential/slots/slotA/chat_v2.db
app-data/com.deepstudent.differential/slots/slotA/databases/audit.db
app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db
app-data/com.deepstudent.differential/slots/slotA/llm_usage.db
app-data/com.deepstudent.differential/slots/slotA/mistakes.db
app-data/com.deepstudent.differential/slots/slotA/workspaces/ws_ws_old.db
app-data/deep-student/sync/sync_state.db
```

比对器递归枚举输入目录；扩展名 `.db/.db3/.sqlite/.sqlite3` 或 SQLite 16 字节文件头均识别。
未知新库、额外 workspace 和本地 sync 库也参与。`-wal/-shm/-journal` 是伴随文件，不当独立库；
正常 SQLite 只读连接会看到已提交 WAL。非 SQLite 文件的差分由 X7 文件 owner 负责。
输入必须是隔离目录；符号链接只记录 `readlink` 原文，不跟随，也不跨到其他数据目录。
FIFO 等特殊条目只记录 `{kind:'special'}`，不得打开。坏的数据库后缀文件或报
`SQLITE_NOTADB`/`SQLITE_CORRUPT` 的文件在可选 `DirectoryState.files` 中记录
`{kind:'unreadable', size, sha256}`；链接记录 `{kind:'symlink', target}`。
`compareDatabaseStates` 以 `kind:'file'` 保留这些证据的新增、消失和变化。
普通目录不新增 `files` 字段；权限、忙锁等其它错误仍抛出，不伪装为损坏库。

每库一个只读事务，读取 `user_version/application_id`、`sqlite_schema` 的
`type/name/tbl_name/sql`（无物理 rootpage），所有 `type=table` 的表全部进入快照，
包括空表、`sqlite_sequence`、refinery history、FTS 虚表及 shadow 表；无表/列忽略表单。
schema 保存索引、trigger、view 定义，不把 view 结果重复当存储表。
每表 `PRAGMA table_xinfo` 保留声明列信息，显式投影所有列及其 `typeof()`，含 generated/hidden 列。

行排序按主键 `pk` 序号（支持复合键、WITHOUT ROWID），同键再按其余全列；无主键按全列排序，
保留重复行数量，以零基 ordinal 标识。非唯一 nullable 主键另带同键 `occurrence`。
排序 storage class 次序 `null/integer/real/text/blob`；整数用 BigInt 数值，REAL 用数值，
TEXT 用 JS 二进制字符串序，BLOB 用 hex 字节序，不依赖语言区域或底层行插入顺序。
ordinal 只用于无逻辑主键的多重集合，不能当业务 ID；修改其中一行可能导致多个 ordinal 差异。

## 值、HashMap 与规范化接缝

每个 cell 为 `{ storageClass, value }`，可以直接 JSON.stringify 保存而不损失整数精度：

| class | `value` |
|---|---|
| integer | 完整 i64 十进制字符串，读取 `safeIntegers`，从不先过 Number |
| real | 8 字节 IEEE754 big-endian hex，保留精确值，无 epsilon |
| text | SQLite 返回的原字符串，JSON TEXT 保留空白/数字字面量/字段排列 |
| blob | 原字节 hex |
| null | JSON null；与 TEXT `"null"`、空字符串和缺列有别 |

`storageClass` 始终参与比较，`INTEGER 1` 与 `REAL 1.0` 产生 `storageClass` 差异；
任何后继规范化都不得抹掉它。没有复用 X7 `record/database.mjs:27–28` 的 types volatile 替换。
数据库/表/行字段/主键映射等 **对象 key 顺序无意义**，比较遍历键集合，不 stringify HashMap 判断等价。
数组仍是有序值。JSON TEXT 则是原始数据库证据，不自动 JSON.parse，以免丢 u64 原文或数组顺序。

**`equal` 只表示原始 SQLite 证据一致，不是最终业务等价裁决。** 例如 Rust HashMap 序列化
导致持久化 JSON 对象字段重排，必须保留原文 raw diff，不能单凭此判业务不等价；
由对应 scenario owner 指明允许的 JSONPath、Rust 类型和 A1/A2 双录证据，交 C2 批准后，
X7 在独立投影上作对象键无序比较。原始 A1/A2/B 不覆盖；本包没有注册任何 normalize 规则。
schema SQL 格式差异同样是 raw evidence，不在此自动重写为“等价 DDL”。

动态 ID 保持原样；需要规范化的场景交 X7/C2 建立一对一映射，并跨返回值、事件、PK/FK
共同应用/核验，不能将所有 ID 替成同一个 volatile 字符串。无证据的 ID/时间不擅自忽略。
事件顺序、JSON 数组顺序由对应 owner 保留；DB 表的行排序不授权对返回/事件数组排序。

Rust 类型依据（路径前缀 `src-tauri/crates/`）：

- `dstu-agent/src/chat_v2/workspace/types.rs:139–150,194–201,214–223,252–258`：
  message `Option<Value>`、inbox `i64/i32`、document `i32`、context `Value`；
  `database.rs:160–218` 原生升级，历史 V1 来源见前述 SOURCES。
- `dstu-storage/src/audit/mod.rs:24–68,193–224`：`duration_ms: Option<u64>`、
  `details: Value`、`Backup.total_size: u64`、原始九列 schema。SQL INTEGER 是有符号 i64，
  JSON `total_size` 的 u64 最大值保持 TEXT 原文。
- `dstu-sync/src/data_governance/sync/state.rs:59–117,119–173,224–287`：
  复合主键、SQLite i64 的序号存储与 u64 API；不以 Number 或全局字符串转换代替类型边界。
- `src-tauri/vendor/refinery-core/src/runner.rs` 的 `Migration::unapplied` 与
  `traits/sync.rs`：复用既有 `fixtures.ts` 的 SQL 重放及 F3 SipHash-1-3 checksum，不另造算法。

## 精确差异样例

将 B 的真实业务列 `document.title` 从 `旧文档📚` 改成 `改动📚`，只报告一条：

```json
{
  "kind": "value",
  "db": "app-data/com.deepstudent.differential/slots/slotA/workspaces/ws_ws_old.db",
  "table": "document",
  "key": { "kind": "primary", "values": { "id": { "storageClass": "text", "value": "document_old" } }, "occurrence": 0 },
  "column": "title",
  "before": { "storageClass": "text", "value": "旧文档📚" },
  "after": { "storageClass": "text", "value": "改动📚" }
}
```

差异 kind：`database/metadata/schema/table/column/row/value/storageClass`。
非行差异 `key=null`；非表差异 `table=null`；新增/删除一侧用 null，SQL NULL cell 仍有 class tag。
另有真实 `notes.title` 更新用例：明确同时保留 FTS、`__change_log`、`sqlite_sequence` 的全部差异，
不为“一个业务值变化”隐藏 SQL trigger 副作用。

## CLI

Node 26 + 已安装的 better-sqlite3；测试/执行经既有 job 队列。Node CLI 直接加载 TS：

```bash
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/data-compat/__fixtures__/scenario-cli.ts seed historical-wp013-v1 host/e2e/data-compat/.tmp/catalog
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/data-compat/__fixtures__/scenario-cli.ts copy historical-wp013-v1 host/e2e/data-compat/.tmp/catalog host/e2e/data-compat/.tmp/A1
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/data-compat/__fixtures__/scenario-cli.ts snapshot host/e2e/data-compat/.tmp/A1
```

`compare LEFT RIGHT` 输出完整 before/after/differences。exit 0=原始一致，1=有差异，2=参数/读取/构造错误。
新验收 `scenario-v0.test.ts` 是工具本身真实 SQLite 正/负对照，不计入 Rust ported 或 A/B 差分等级。
`scenario-cli.test.ts` 以真实 Node 子进程验证 seed/copy/snapshot/compare 和 0/1/2 退出码，
job `20261105161500-ecc220` 2 passed / 0 failed / 0 skipped、Errors 0、exit 0；无需 TS transpiler 参数。

## `skill-zip-v0`：L07 技能 ZIP 输入（WP-094）

给 L07 WP-050 `skill_import_zip` 未覆盖的 ZIP 字节分支提供真实文件。全部是本 lane **合成构造**的 ZIP
（`__fixtures__/skill-zip-seeds.ts`），**不是历史 A 发布物，也不是 Rust/Tauri 产物**；SQL 历史 seed 的标签不变。
字节确定：stored（method 0）、DOS 时间固定为 1980-01-01 00:00、无 extra/comment、条目名全 ASCII，不依赖时钟或 zlib 版本。
该 seed 不含数据库，`snapshotDirectory` 结果为 `{ version: 0, databases: {} }`。

同一 API：`createSeed('skill-zip-v0', catalog)` 一次，再 `copySeed` 给 A1/A2/B；文件清单另由
`SKILL_ZIP_SEED_FILES`（`file/relativePath/homePath/synthetic/rustBranch/construction`）导出。
`SeedDirectory` 字段不变。Rust 行号相对 `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs`。

| 相对 seed 目录的路径 | 场景参数（HOME=`<副本>/home`） | 目标 Rust 分支 | 构造 |
|---|---|---|---|
| `home/w0-zip-seeds/zero-bytes.zip` | `~/w0-zip-seeds/zero-bytes.zip` | `:2142-2145` Skill package is empty | 0 字节文件 |
| `home/w0-zip-seeds/empty-archive.zip` | `~/w0-zip-seeds/empty-archive.zip` | `:1340-1378` 预检 0 条 → `:1436-1437` 缺 SKILL.md | 仅 22 字节 EOCD，0 条目 |
| `home/w0-zip-seeds/no-skill-md.zip` | `~/w0-zip-seeds/no-skill-md.zip` | `:1436-1437` Zip must contain a SKILL.md | `README.md`、`scripts/run.sh` |
| `home/w0-zip-seeds/root-frontmatter-name.zip` | `~/w0-zip-seeds/root-frontmatter-name.zip` | `:923-924` 根前缀 → `:1520-1523` frontmatter 名 `w0-zip-root` | 根 `SKILL.md` + `notes.md` |
| `home/w0-zip-seeds/root-invalid-frontmatter-name.zip` | `~/w0-zip-seeds/root-invalid-frontmatter-name.zip` | `:943-973` 名称被拒 → 保留 `:924` `imported-skill` | 根 `SKILL.md`，`name: "bad name!"` |
| `home/w0-zip-seeds/multi-file-folder.zip` | `~/w0-zip-seeds/multi-file-folder.zip` | `:926-937` 目录前缀 `w0-zip-multi`；`:1453` 跳过目录项、`:1457` 跳过 node_modules、`:1472-1475` 跳过前缀外 | 目录项、SKILL.md（2 个 allowed-tools）、scripts/、references/、256 字节二进制、`outside.txt`、node_modules |
| `home/w0-zip-seeds/duplicate-entry.zip` | `~/w0-zip-seeds/duplicate-entry.zip` | `:1485-1486` duplicate path `notes.md` | 两条同名 `notes.md` 中央目录记录，内容不同 |
| `home/w0-zip-seeds/case-conflict.zip` | `~/w0-zip-seeds/case-conflict.zip` | `:1485-1486` 大小写折叠后重复 | `references/Guide.md` 与 `references/guide.md` |
| `home/w0-zip-seeds/not-a-zip.zip` | `~/w0-zip-seeds/not-a-zip.zip` | `:1380` missing end-of-central-directory record | >22 字节纯文本，无任何 `PK` |
| `home/w0-zip-seeds/truncated-central-directory.zip` | `~/w0-zip-seeds/truncated-central-directory.zip` | `:1410` `ZipArchive::new` 失败 → `Invalid zip: <zip 0.6.6 原文>` | 3 条目包删去最后一条中央记录，EOCD 仍声明 3 条及原 CD 大小/偏移 |

“目标 Rust 分支”是构造意图，**不是 oracle**。`skill-zip-seeds.test.ts` 只用独立的 EOCD/中央目录解析、
zlib CRC32 和 JSZip 证明文件里确实有目标元数据（例如截断包 EOCD 声明 3 条、实际只有 2 条中央记录，
缺少的字节数恰为 `46 + "extra.md".length`）。Rust/TS 的实际返回值、错误原文与 `package_sha256` 由 A 端录制决定。
zip 0.6.6 对同名条目全部保留在 `files` 中（`read.rs:428-431`），因此 duplicate-entry 预期走到 `:1485`；以 A 实录为准。

首组不含：64 MiB 包上限、条目数 2000/条目名 1024/单文件 8 MiB/总量上限、ZIP64、多卷、符号链接、秘密/密钥内容。

### v0 接缝：场景无法引用 seed 路径（如实 blocked）

v0 场景参数只有字面量和 `${n.path}`，没有指向 seed 目录的占位符；WP-050 场景都是 `seed: "empty"`，
且约定每个场景独立 HOME。本 seed 只需要运行器做一件事：**把 HOME 设为复制后 seed 的 `home/`**，
场景即可写 `"zipPath": "~/w0-zip-seeds/<文件>"`，两端各自展开（Rust `skills.rs:327-339`，TS `files.ts:131-135`）。
当前 `scripts/electron-migration/record/replay.mjs:15-24` 只按 `scenario.snapshot` 从 `fixtures/db` 复制并只传 `dataDir`，
既不解析 `scenario.seed`，也不设置 HOME。因此这些文件现在**不能被任何 runner 消费**：需要 X7 支持 `scenario.seed` →
`copySeed`、以及 HOME=`<副本>/home`（或经 C2 批准的 seed 路径占位符），L07 再新增引用这些路径的场景。本包不改 runner、
不改 v0 格式、不改 L07 语料。

## `l22-temp-sessions-w0`：L22 temp_sessions 历史输入（WP-115）

给 L22 `temp-sessions.seeded.json`（21 场景 / 59 步，`seed: "l22-temp-sessions-w0"`）提供数据目录。
名称沿用 L22 暂定名，**不改名**，场景 `seed` 字段无需修改。**SQL 构造**，不是 A 端历史产物、Rust 产物或真实备份。

- 来源（只读消费，不复制 L22 文件）：`host/plugins/integration/equivalence/pending-seed/l22-temp-sessions-w0.sql`，
  固定于 L22 提交 `cf9e3e01528c0e9bf54bbb36b6f75ff842eecf20`，git blob `3f666bc674993b724e8c4a82bfbb8e2cbb4d95a9`。
  `__fixtures__/temp-sessions-seeds.ts` 优先读工作树同路径文件（L22 进 main 后），否则 `git show <commit>:<path>`；
  两种来源都必须与 blob id 一致，否则构造报错。导出 `TEMP_SESSIONS_SEED_SQL`、`readTempSessionsSql()`。
- 构造：`slots/slotA/` 下五库（`browser/chat_v2/databases/vfs/llm_usage/mistakes`）按当前 checkout 的
  `src-tauri/migrations/` 原 SQL 与 refinery history 重放（同 `historical-wp013-v1`，F3 `refineryChecksum`），**不插入任何业务 seed 行**；
  然后对 `mistakes.db` 在一个事务内 `exec` 整段 L22 SQL，`session_data` 由 SQLite 字面量原样存入。`local-data/` 为空。
  对应 L22 README:29、36–37 的"已完成迁移、已停止"的 `mistakes.db`；audit/sync_state/workspace 等懒建库不预建，由两端首次启动自行创建。
- 同一 API：`createSeed('l22-temp-sessions-w0', catalog)` 一次，再 `copySeed` 给 A1/A2/B；`SeedDirectory` 字段不变。
  CLI：`scenario-cli.ts seed l22-temp-sessions-w0 <catalog>`（需在仓库内运行以便 git 回退读取）。

```text
app-data/com.deepstudent.differential/slots/slotA/browser.db
app-data/com.deepstudent.differential/slots/slotA/chat_v2.db
app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db
app-data/com.deepstudent.differential/slots/slotA/llm_usage.db
app-data/com.deepstudent.differential/slots/slotA/mistakes.db
```

已证（`temp-sessions-seeds.test.ts`，真实 SQLite）：24 个 `temp_id`；除 `tmp_bad_blob`（BLOB `7b7d`）外 `session_data` 均为 TEXT，
且逐行等于 SQL 字符串字面量（仅 `''` 反转义），`0.1000000000000000055511151231257827`、30 位整数、`-0.0`、`1E400`、
`"dup":1,"dup":2`、`18446744073709551615/…616`、`\ud800`、`\u2028` 等词素原样；2 行 `settings` 全列；`temp_sessions/settings`
上只有 `w0_temp_sessions_readonly` 一个触发器，原 DDL 文本；refinery `version` 为 integer 原值。隔离副本上执行 Rust
`upsert_temp_session` 原 SQL（`dstu-storage/src/database/mod.rs:4177-4183`）：`tmp_readonly` 被 `RAISE(ABORT)` 拒绝且行不变，
其他行正常 upsert（`created_at` 不更新），内部键新行可插入。源目录与 A1/A2/B 在此之后逐字节不变。

注意：迁移自带默认行的 `datetime('now')` 时间戳（`vfs.db` 的 `memory_config.updated_at`、`vfs_indexing_config.updated_at`，
`mistakes.db` 的 `__change_log.changed_at`）取构造时刻，**重建不逐字节相同**；必须构造一次后复制，不能两端各自重建。
除这三列外，与无业务行的纯迁移重放相比只多 L22 的 26 行和 1 个触发器。

不做：runner 解析 `scenario.seed`/HOME（X7，同 WP-094 阻塞）、把 L22 场景移到顶层（L22）、真实 A 发布目录。

## `l15-review-cas-tombstone-w0`：L15/L24 reviewVersion CAS 与软删除输入（WP-116）

解除 L15 WP-053 报告所列前置（大整数 reviewVersion、card/task tombstone）。**SQL 构造**，不是 A 端历史产物、Rust 产物，
也**不代表业务 CAS 已通过**；返回值/错误由 A 端录制决定。构造在 `__fixtures__/review-cas-tombstone-seeds.ts`，
验收 `review-cas-tombstone-seeds.test.ts`（5 条）。同一 API：`createSeed('l15-review-cas-tombstone-w0', catalog)` 一次，
再 `copySeed` 给 A1/A2/B；`local-data/` 为空，数据库同 `l22-temp-sessions-w0` 的五个相对路径。

字段归属（以 Rust 与迁移为准，路径前缀 `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs`，记 `S`）：

- reviewVersion **不是独立列**：`S:4791-4818` 读 `COALESCE(fsrs_card_states.local_version, 0)`，`S:2903`/`S:3042` 比较，
  `S:2922-2938`/`S:3085-3117` 的 UPDATE 再以同一表达式作 CAS 并 `+1`。列由 `V20260711__fsrs_sync_coverage.sql:7` 添加。
  注意 IPC `fsrs_rate` 的 CAS 是 `lastReviewMs`，不是 reviewVersion（L15 WP-053 报告）；reviewVersion 入口是
  `set_suspended_for_session/library`（`S:2838/2856`）与 `undo_last_review_for_session/library`（`S:2972/2992`）。
- 软删除：`anki_cards.deleted_at`（`V20260201__add_sync_fields.sql:35`）、`document_tasks.deleted_at`（`V20260523__add_missing_sync_coverage.sql:91`）；
  会话归属 `document_tasks.source_session_id`（`S:1834-1851`）。生产 `delete_anki_card`/`delete_document_session`
  （`dstu-storage/src/database/mod.rs:6053-6128`）是物理 DELETE；本 seed 没有任何 DELETE，tombstone 仅来自 Rust 测试夹具的 UPDATE。

SQL 文本取自 Rust 测试夹具（`S:6037-6059` `insert_task_and_card`、`S:6101-6116` `insert_card_for_task`、`S:6118-6127` `set_task_owner`、
`S:7179-7189`、`S:7366-7376`）与入队 `insert_state_in_tx`（`S:1424-1452`，新卡值 `S:957-970`，`deck_default`/`fsrs-rs-6.6` `S:21-24`，
保持率 0.9 来自迁移默认牌组）。在 `mistakes.db` 一个事务内按 Rust 测试顺序执行。

| 组 | document / task / owner | 卡片 id | `fsrs_card_states` id → `local_version`（INTEGER） | 软删除 |
|---|---|---|---|---|
| CAS | `doc-review-cas` / `task-review-cas` / `session-review-cas` | `card-rv-<V>` | `fsrs-state-card-rv-<V>` → `<V>` | 无 |
| 卡 tombstone（`S:7150`） | `doc-card-tombstone` / `task-card-tombstone` / `session-owner` | `card-tombstone`、`card-still-live` | `fsrs-state-card-tombstone` → 0（`card-still-live` 无 state，同 Rust） | `card-tombstone.deleted_at='2026-07-14T01:00:00Z'`、`card_order_in_task=99` |
| 任务 tombstone（`S:7327`） | `doc-task-tombstone` / `task-tombstone` / `session-owner` | `card-live-child`（活） | `fsrs-state-card-live-child` → 0（活） | task `status='Processing'`、`updated_at='2000-01-01T00:00:00Z'`、`deleted_at='2026-07-14T02:00:00Z'` |

`<V>` 六个（十进制原文）：`9007199254740992`、`9007199254740993`、`9223372036854774784`、`9223372036854774785`、
`9223372036854775806`、`9223372036854775807`（i64::MAX）。三对相邻值各自在 IEEE double 下相等，均为对方的 stale 版本；
其余 stale 输入（如 `9007199254740994`）由场景直接传参。场景须以 JSON 整数原文/BigInt 传 `expectedReviewVersion`，不能经 Number。

固定值（Rust 夹具留给 DEFAULT 或 `Utc::now()` 的列，改成同格式的固定字面量，以便卡片 CAS 令牌 `updated_at` 可写进场景）：
`document_tasks/anki_cards.created_at=updated_at='2026-07-13T00:00:00.000Z'`（任务 tombstone 的 `updated_at` 按 Rust 改为 2000 年）；
state `created_at=updated_at='2026-07-13T00:00:00+00:00'`、`due_ms=1783900800000`（同刻，已到期）、state `id` 用确定性
`fsrs-state-<card>` 而非 UUID v4。其余列（New、0 reps、NULL stability/difficulty、`leech/learning_step=0` 等）为 SQL 默认或 Rust 新卡值。

与 Rust 原测试的差异，消费者须知：
- `S:7327` 在 tombstone 前对活子卡 `rate` 一次（产生 review log 与非 New 状态）；本 seed **不计算 FSRS、无 review log**，子卡 state 保持 New/local_version 0。
- 三组同库：全局读（`get_due`/`get_stats`/library 列表）会看到 CAS 组 6 张活卡（均已到期），不会等于 Rust 单测里的 0/1。
- 构造触发 `__change_log` 31 行（20 INSERT、11 UPDATE、0 DELETE），`changed_at` 为构造时刻；同 L22 seed，必须构造一次后复制。

已证（真实 SQLite，A1/A2/B 与源逐字节一致）：23 列 state、23 列 card、14 列 task 逐字段与 storage class；六个 `local_version`
为 integer 且两两不同；与纯迁移重放相比只多 3 task、9 card、8 state、31 条 change_log（加 `sqlite_sequence`）；
隔离副本上执行 `S:2922-2938` 原 SQL：stale（含 double 相等的邻值）0 行，精确值 1 行且 `+1` 仍为 integer，
tombstone 卡与 tombstone 任务的活子卡 0 行；源与副本此后不变。

SQLite 事实（非业务结论）：对 `local_version=i64::MAX` 执行上述 UPDATE 成功 1 行，`COALESCE(local_version,0)+1` 溢出存为
**REAL 2^63**（`typeof='real'`）。Rust 随后以 `i64` 读该列的行为、以及 TS 是否一致，归 L15/L24 由 A/B 录制判断。

2026-11-06 恢复更新：main 已有 X7 `scripts/electron-migration/record/scenario-v0.mjs:38-55`
`prepareScenarioRun(scenario, { catalog, directory, env })`，按 `scenario.seed` 调用 resolveSeed/copySeed，
并设副本 HOME/XDG。前文 WP-094/115 的“runner 不解析 seed”描述保留为历史状态；现在可交此准备入口消费。
真实工具外层调用和 A1/A2/B 录制仍由 X7/L15/L24 完成。本包未扩跨日/成熟记忆、随机或故障注入。

## W21 slot seeds（`__fixtures__/slot-seeds.ts`）

验收 `g3-slot-seeds.test.ts`。都不是 A 端产物；数据库按当前 `src-tauri/migrations/` 重放，构造一次再复制给 A/B。

- owner SQL 种子：`slots/slotA/` 五库重放后，在 owner 库上 `foreign_keys=ON`、一个事务内 `exec` 整段 SQL，再做
  `foreign_key_check` 与 `integrity_check`。`f3-llm-usage-rows-w0` → `llm_usage.db`（`host/platform/storage/equivalence/`），
  `l16-pending-memory-w0` → `mistakes.db`（`host/plugins/anki/equivalence/`），`wp227-legacy-chat-w0` → `mistakes.db`
  （`host/plugins/chat-pipeline/equivalence/`），`l04-wp226-goal-todo` → `chat_v2.db`（`host/plugins/chat/equivalence/`）。
  测试证明：等于"新重放 + 原样执行该 SQL 文件"，差异只在 owner 库。
- `f3-inactive-slot-data-w0`：slotA、slotB 都是重放库；`slots/state.json` 为 `serde_json::to_string_pretty(SlotState)` 文本
  `{"active":"slotA","pending":null}`（两空格缩进）；`slots/.legacy_migration_complete` 内容 `1`（`data_space.rs` ensure_layout）。
- `f3-startup-recovery-incident-w0`：同上两槽 + `state.json`，但**没有**迁移完成标记，且应用根目录下有旧版库
  `mistakes.db`、`chat_v2.db`、`llm_usage.db`、`databases/vfs.db`；启动时 `prepare_startup_recovery` 据此建恢复事件，推荐 slotA。
  B 已证恢复模式下 `vfs_set_indexing_config` 未注册，运行器准备步骤失败，所以该 suite 仍在 `pending-seed/`，等 W13。
