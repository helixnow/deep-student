# WP-068：L12 索引维护命令场景 v0

本目录只放 WAVE0 §3 v0 语料，不含实现。真实 A（Rust/Tauri）结果是 oracle；`expect: "error"`
只是按源码推出的注释。**全部场景未运行 A/B replay，不计 C。** `normalize` 全为 `[]`，时间/路径
候选见下文，须 A1/A2 双录后经 C2 批准才能加规则。

- `chat-optimize.json`：`optimize_chat_embeddings_table`，21 场景。
- `wrapper-only.json`：`clear_message_embeddings` 20 场景、`optimize_lance_database` 7 场景。
- 合计 48 场景、81 步。外层 `save_setting`/`get_setting`（owner L19，`src/cmd/web_search.rs:541,562`，
  前端 `src/utils/settingsApi.ts:15,27`）只用于建前置设置和读回，它们自己的分支不在本包。

## 命令清单与前端可达性（按实际调用复核，纠正 inventory）

| 命令 | Rust | 注册 | 前端 | 可达性 |
|---|---|---|---|---|
| `optimize_chat_embeddings_table` | `src-tauri/src/commands.rs:2089` → `crates/dstu-vfs/src/lance_vector_store.rs:932,884` | `lib.rs:2083` | `src/features/settings/components/IndexMaintenanceSection.tsx:57`（按钮 `:176`、`optimizeAll` `:73`），面板挂在 `DataGovernanceDashboard.tsx:2002` | **UI 真实可达**。inventory/contract 记为 `frontend: none`，原因是命令名经变量传入；X2 审计 `X2-frontend-contracts.md:358` 已识别 |
| `clear_message_embeddings` | `commands.rs:2013` | `lib.rs:2084` | 包装 `src/utils/testApi.ts:57-67`，经 `tauriApi.ts:10,17` 再导出 | **无调用点**：`src/` 中 `clearMessageEmbeddings(` 只有定义 |
| `optimize_lance_database` | `commands.rs:6899` | `lib.rs:2272` | 包装 `src/utils/systemApi.ts:149-150`，经 `tauriApi.ts:9,16` 再导出 | **无调用点**：`optimizeLanceDatabase(` 只有定义 |

inventory 写的是"3 条/前端 2 条"，实际只有 1 条有 UI 调用点，另外 2 条只有导出的包装函数。
后两条单独放在 `wrapper-only.json`，不计入 765 条前端可达命令；场景照样提供，因为
两端都注册了这两条命令，包装函数也能被调用。本 lane 的索引、embedding、unified_retriever
服务没有自己的 IPC，经 L13 `vfs_*` 等外层命令到达，归对应 owner 的语料包，本包不新增伪 IPC。

### 前端参数大小写（已有行为，不修）

`IndexMaintenanceSection.tsx:57-61` 传 `older_than_days`/`delete_unverified`（snake_case），
Tauri 按 camelCase 绑定 `olderThanDays`/`deleteUnverified`，所以这两个 snake_case 键实际被丢弃，
Rust 收到 `None`；只有 `force: true` 生效。场景 `frontend_snake_keys` 和 `frontend_days_omitted`
原样保留这种形状，B 端也必须同样忽略多余键。

## 分支覆盖：`optimize_chat_embeddings_table`

| Rust 分支 | 场景 |
|---|---|
| 前端真实形状，snake 键被忽略，`force=true` | `frontend_snake_keys`、`frontend_days_omitted` |
| 缺省 `force` 走 `unwrap_or(true)`（`commands.rs:2099`） | `no_args_default_force`、`camel_all_null` |
| `older_than_days=0` 不 prune / 最大安全整数；`delete_unverified=Some` 覆盖设置 | `camel_days_zero_delete_true`、`camel_days_max_safe` |
| `should_skip_optimization`：`force=false` 且距上次 < 1800s → `Ok(0)`，不写时间戳（`:757-785`） | `throttle_skip_second_call`、`throttle_future_timestamp_skips`、`throttle_future_offset_fraction_skips` |
| `force=true` 跳过节流 | `force_bypasses_throttle` |
| 过去时间戳 → 照常执行并覆盖 | `throttle_past_timestamp_runs` |
| 时间戳非 RFC3339 → `.ok()` 吞掉，当作没有时间戳 | `throttle_unparseable_timestamp_runs` |
| `resolve_delete_unverified` 读设置 `parse_bool_flag`（trim、大小写不敏感，`:351,797`） | `setting_delete_unverified_no_override` |
| 没有表，或 `open_table` 失败 → `continue`，info 日志，仍写 `lance.optimize.last.chat`（`:907-927`） | 上面所有空 seed 成功场景 |
| `resolve_lance_base`：相对路径 → warn，回写默认根（`:739-745`） | `lance_path_relative_fallback` |
| 绝对路径但 `ensure_dir` 失败 → error + warn，回写默认根（`:720-745`） | `lance_path_absolute_mkdir_fails`（`/proc` 下不可建目录，Linux 专用） |
| 空白设置值被过滤，不回写 | `lance_path_blank_ignored` |
| 参数解码失败（invoke 边界，不是 handler 分支） | `decode_days_negative`/`_fraction`/`_string`、`decode_force_string`、`decode_delete_unverified_number` |

`optimized == 0` 时有 debug 日志（`commands.rs:2103`），v0 不捕获日志。命令没有发事件。

## 分支覆盖：`clear_message_embeddings`

| Rust 分支（`commands.rs:2013-2085`） | 场景 |
|---|---|
| `message_ids` 为空 → 立即 `Ok`（`:2017`） | `empty_vec_early_ok` |
| 全部 trim 后为空 → warn，`Ok`（`:2057-2059`）；Rust `trim` 去掉 U+3000/U+00A0/U+0085/U+2028 | `all_blank_tokens_warn_ok` |
| `parse::<i64>` 成功：`+`、前导零、`-0`、i64 边界值、全角空格包裹；排序去重 → Lance 删除（无表时 `Ok`）→ `chat_user_embeddings` DELETE 失败只记 error（`:2080-2082`）→ `Ok` | `numeric_ids_dedup_sort`、`numeric_single` |
| 有 stable token → `prepare` 失败 → `AppError::database`（`:2043-2047`） | `stable_token_query_error` |
| 数字和 stable 混在一起：先查 stable 报错，Lance 路径没有被触达 | `mixed_numeric_and_stable_error` |
| i64 解析失败，于是归为 stable token：溢出、下溢、`1e3`、`+-1`、`1_000`、全角数字、BOM（Rust 不 trim U+FEFF）、零宽空格 | `i64_overflow_…`、`i64_underflow_…`、`exponent_…`、`double_sign_…`、`underscore_digits_…`、`fullwidth_digits_…`、`bom_not_trimmed_…`、`zero_width_space_not_trimmed` |
| `get_lance_path` 相对路径回写默认根（与 optimize 共用） | `lance_path_relative_fallback` |
| 历史 seed：大 id 9007199254740993 / 相邻值 ...992，精度不得经过 f64；同一 schema 下 stable 仍报错 | `historical_large_id` |
| 参数解码失败（invoke 边界） | `decode_missing_key`、`decode_null`、`decode_number_item`、`decode_snake_key` |

最小检查作业 `20261105183134-ca4172` 在当前迁移上实测了 schema 事实：`chat_messages` 只有
`stable_id`，没有 `persistent_stable_id`，prepare 报 `no such column: persistent_stable_id`；
没有 `chat_user_embeddings` 表，DELETE prepare 报 `no such table`。所以在当前 schema 下，任何
stable token 都会走错误分支，数字分支的 DB 删除也必然只记 error。

## 分支覆盖：`optimize_lance_database`

Rust（`commands.rs:6899-6910`）忽略参数，返回固定 JSON。成功场景：`frontend_default`
（包装函数默认的 `{parallelism: undefined, force: true}`）、`no_args`、`all_null`、
`parallelism_bounds`（0、4、2^53-1）。解码错误：`decode_parallelism_negative`/`_fraction`、
`decode_force_string`。handler 本身没有 Err 分支。

## 被阻塞的分支（逐条列出，其余场景都可执行）

| 分支 | 缺什么 | owner |
|---|---|---|
| clear：Lance `delete` 真正删行，及 delete 失败 → `Err("清空向量失败: …")`（`:2070-2073`） | 带 `chat_embeddings_v2_d*` Lance 表的 seed；当前前端没有能写这些表的路径（唯一写入 `upsert_chat_embeddings_batch` 只由已退役的迁移入口调用，`lance_vector_store.rs:4034,4116`） | X3 seed + F7 Lance 目录格式 |
| optimize：`optimize_table_internal` compact/prune/index 实际执行，`older_than_days` prune 时长，`delete_unverified` 生效，单表失败 error 后继续，`optimized>0` info | 同上，需要 chat v2 / legacy `chat_embeddings_d*` / `chat_embeddings` 表 | X3 + F7 |
| clear：`chat_user_embeddings` DELETE 成功 | 当前迁移和 Rust 运行时都不建这张表（只有 DELETE 引用它，`dstu-storage/src/database/mod.rs:3835`），需要带这张表的旧库 seed | X3（需先确认是否存在这样的历史版本） |
| clear：stable token 命中行 | `mistakes.chat_messages` 没有 `persistent_stable_id` 列，查询必定 prepare 失败；需要带该列的旧库 seed | X3（同上） |
| `LanceVectorStore::new` 失败：clear 静默跳过（`:2069` `if let Ok`），optimize 返回 database 错误（`:2096-2097`） | 让 `ensure_base_rag_schema` DDL 失败的 seed，例如 `rag_document_chunks` 是 VIEW | X3 |
| 自定义绝对 `rag.lance.path` 建目录成功并采用 | runner 需要提供每个实例数据目录内的路径变量（如 `${dataDir}`）；写固定路径会让 A1/A2/B 共用目录 | X7 runner |
| `get_conn_safe`、默认根 `ensure_dir`、`save_setting` 回写、`table_names` 失败、`record_optimization_timestamp` warn | 需要文件系统/DB 故障注入，没有 IPC 能触发 | 不可经 IPC 执行 |
| `lance` feature 关闭的 stub 分支（`lance_vector_store.rs:3044-3067`） | 默认构建 `Cargo.toml:596` 启用 `lance` | 不在默认构建内 |
| KB_MUTATION_LOCK 并发互斥 | v0 是顺序步骤，没有并发 | 人工审读项 |

这三条命令都不调用远端 embedding，所以没有远端 embedding 阻塞项。

## 规范化候选（只是候选，未经双录）

- 设置 `lance.optimize.last.chat` 的值（`Utc::now().to_rfc3339()`），以及 `settings.updated_at`。
- `rag.lance.path` 回写的默认根是实例目录下的绝对路径（`<db 目录>/lance`），A/B 实例路径不同。
- `ensure_base_rag_schema` 插入的 `rag_sub_libraries` default 行的 `created_at/updated_at`。
- 错误文案中 rusqlite 与 better-sqlite3 的原样 Display，以真实 A 为准，不预先忽略。

最小检查脚本 `/tmp/opencode/l12-w0-check.mjs`（只读）检查了：v0 键集合、id 唯一、引用只指向
之前的步骤、seed 名合法、每条命令都在 contracts / Rust `generate_handler` / Host 注册中存在，
以及上面的 schema 事实。
