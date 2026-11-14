# L22 波次0场景：临时会话（temp_sessions）跨域命令

按 `board/WAVE0-EQUIVALENCE.md` §3 v0 编写。这里只有场景和来源，未经 A/B 重放，不算 C 级。

## 命令与 owner

L22 没有自己的 IPC 命令：inventory 中 L22 为 0 命令 / 前端 0，`host/plugins/integration/index.ts` 的 `meta.commands` 为空。
L22 拥有的是 `commands.rs:166-285` 的临时会话状态（内存表 + `temp_sessions` 表），Host 侧对应
`ctx.appCommandState.modifyTempSession`（`api.ts`）。这部分状态只能经下表中其他 lane 的真实命令触达，本包没有新增任何 IPC。

| 命令 | owner（契约） | Rust | Host 注册 | 前端调用点 | 在场景中的用途 |
|---|---|---|---|---|---|
| `pin_images` | L18-media-docs | `src-tauri/src/commands.rs:357-381`，注册 `src-tauri/src/lib.rs:1969` | `host/plugins/media/index.ts:1202` | 无（契约 `frontend:"none"`；`audit/commands.json` uncalledCommands，前端生产/测试引用均为 0） | 被测命令，唯一调用 `modify_temp_session` 的写入口 |
| `unpin_images` | L18-media-docs | `src-tauri/src/commands.rs:385-395`，注册 `lib.rs:1970` | `host/plugins/media/index.ts:1204` | 无（同上，disposition `candidate-needs-coordinator-approval`） | 被测命令 |
| `save_setting` | L19-mcp-browser | `src-tauri/src/cmd/web_search.rs:541-558` | `host/plugins/browser/index.ts:339` | `src/quick-assistant/config.ts:35` | 前置：写 `pinned_images:<id>`，验证错误提前返回时设置未被改动 |
| `get_setting` | L19-mcp-browser | `src-tauri/src/cmd/web_search.rs:562-569` | `host/plugins/browser/index.ts:346` | `src/quick-assistant/config.ts:18` | 观察 `pinned_images:<id>` 镜像 |

`pin_images` / `unpin_images` 没有前端入口：`rg 'pin_images|unpin_images' src` 为空，v0.9.2 首个提交
（`1813b3c9c`）的 `src/` 中也没有。两条命令都在 `generate_handler!` 中注册，且 ACL
`src-tauri/permissions/application-commands.toml:657,924` 放行，因此 harness 经 `__TAURI_INTERNALS__.invoke`
可以直接调用。是否算"前端可达"由 X2/C1 判定，本包只如实记录。`save_setting`/`get_setting` 只用于构造前置状态和观察结果，它们自身的分支归 L19 的场景包。

## 场景文件

| 文件 | seed | 场景 / 步骤 | 状态 |
|---|---|---|---|
| `temp-sessions.json` | `empty` | 13 / 26 | 可执行 |
| `temp-sessions.seeded.json` | `l22-temp-sessions-w0` | 21 / 59 | 可执行（种子见 `host/e2e/data-compat/__fixtures__/temp-sessions-seeds.ts`） |
| `pending-seed/l22-temp-sessions-w0.sql` | — | 24 行 `temp_sessions`、2 行 `settings`、1 个触发器 | 种子规格，需应用到"已启动过一次、已停止"的数据目录的 `mistakes.db`；`temp-sessions-seeds.ts` 按提交 + 路径 + blob 钉住，所以留在原处 |

为什么需要种子：真实命令无法创建 `temp_sessions` 行。`cache_temp_session`（`commands.rs:202`）没有调用者；
`modify_temp_session` 只修改已存在的行；该表是 `LocalRuntime` 分类，不参与同步（`crates/dstu-sync/src/data_governance/sync/classification.rs:1143-1150`）。
现实中这些行只来自历史数据目录或备份恢复（L21 `data_governance_import_zip`/`restore_backup`，前提是已有含这些行的备份）。
所以在全新数据目录（`empty`）里只能走到"会话不存在"和参数反序列化错误。命中、恢复、持久化失败这三类分支都依赖种子。

种子 owner：X3（`host/e2e/data-compat/` 种子目录机制）。需要的能力：在 A、B 两端，把同一段 SQL 原样应用到已完成迁移的
`mistakes.db`（`session_data` 必须逐字节保留：数字词素、键顺序、转义、时区偏移都属于输入），再启动应用运行场景。
种子名 `l22-temp-sessions-w0` 是暂定名，X3 可以改名，届时同步改场景里的 `seed` 字段并把文件移到顶层。

## 分支覆盖（`src-tauri/src/commands.rs`）

| 分支 | 位置 | 场景 |
|---|---|---|
| `pin_images` 空数组 → `pinned_images=None`、`delete_setting` | :362-366, :375-376 | `seeded.pin.empty_images_clears_existing`、`pin.missing_empty_images`（提前返回） |
| `pin_images` 非空 → `Some(images)`、`save_setting(JSON)` | :362-366, :377-378 | `seeded.pin.restore_full_then_memory_hit`、`seeded.pin.restore_minimal_alias_defaults`、`seeded.pin.same_images_twice` |
| `pin_images` `modify?` 错误时在写设置前返回 | :368-371 | `pin.missing_keeps_existing_setting`、`seeded.pin.persist_failure_restore_then_memory`（设置 `["R"]` 保持不变） |
| `unpin_images` 成功并删设置（有行 / 无行） | :386-392 | `seeded.unpin.restore_clears_existing`、`seeded.unpin.no_setting_row` |
| `unpin_images` 错误时在删设置前返回 | :386-389 | `unpin.missing_keeps_existing_setting`、`seeded.unpin.persist_failure_restore` |
| `modify_temp_session` 内存命中 | :256-259 | `seeded.pin.restore_full_then_memory_hit` 第 3 步、`seeded.unpin.memory_hit_after_pin`、`seeded.pin.row_key_mismatch` 第 2 步、`seeded.pin.persist_failure_restore_then_memory` 第 3、4 步 |
| 未命中 → DB 读取失败 `Database("读取临时会话失败: …")` | :263-267 | `seeded.read_failure.*`（9 个：缺字段、非 JSON、BLOB 列、负 usize、usize 溢出、未知 stream_state、重复字段、孤立代理、非法 created_at） |
| 未命中 → 行不存在 `NotFound("临时会话不存在")` | :268 | `temp-sessions.json` 中 7 个 `missing*` 场景（含空 / 非 ASCII / 带引号的 tempId） |
| 未命中 → 从 DB 恢复、写回内存、超上限驱逐 | :269-275, :185-199 | `seeded.pin.restore_*`、`seeded.pin.eviction_over_cap`（9 行，cap 8，`tmp_evict_1/2` created_at 相同，按 temp_id 决胜） |
| 持久化失败 `Database("持久化临时会话失败: …")`（恢复路径 / 命中路径） | :279-281, :166-171 | `seeded.pin.persist_failure_restore_then_memory`、`seeded.unpin.persist_failure_restore`（触发器 `RAISE(ABORT)`） |
| upsert 写入 JSON 内部的 `temp_id`，而不是行键 | `dstu-storage/src/database/mod.rs:4177-4192` | `seeded.pin.row_key_mismatch`（会插入 `tmp_mismatch_inner` 新行；再按内部键 unpin 走 DB 恢复） |
| 参数反序列化错误（Tauri 层，不属处理函数分支） | — | `pin.args_*`、`unpin.args_*`（缺 images、images 为 null、非字符串元素、snake_case 键、缺 tempId、tempId 为数字） |

深层结构：`tmp_full` 行包含 Value 字段内的 `null` 成员、`Option` 字段显式 `null`（应按 `skip_serializing_if` 省略）、
未知键（应丢弃）、Value 内重复键、任意精度词素（`0.1000000000000000055511151231257827`、30 位整数、`-0.0`、`1E400`、`5e-324`、`1.0e+2`、`2.000`）、
f32 字段（`score`、`bbox`）、`u64::MAX` 的 `size_bytes`、`+08:00` 纳秒时间戳、转义与 U+2028。恢复后 upsert 写回的 `session_data`
由 `db:["*"]` 完整捕获；以 A 端实际结果为准，场景不写期望值。`tmp_f32_overflow`（score `1e40`）是成功还是失败，同样由 A 端决定。

## 不可达或不观察的分支（附证据）

| 分支 | 原因 |
|---|---|
| `cache_temp_session`（:202-210）、`remove_temp_session`（:212-223，含唯一 `error!`）、`get_or_restore_temp_session`（:225-246） | Rust 全仓没有调用者（`rg` 只命中定义；`modify_temp_session` 的调用者只有 :367、:386）。任何 IPC 都到不了 |
| `modify_temp_session` 末尾 `ok_or_else(NotFound)`（:284） | 前面两条路径都已把 `updated` 设为 `Some`，这里不会是 `None` |
| `evict` 中 `None => break`（:195-196） | 只在 `len > 8` 时进入循环，此时 `min_by` 总有结果 |
| `upsert_temp_session` 序列化失败（mod.rs:4172-4173） | StreamContext 全部字段都可序列化；按 serde_json 实现，非有限 f32 写成 `null`、不报错；这一点待 A 端用 `tmp_f32_overflow` 确认 |
| `get_conn_safe` 维护模式拒绝（mod.rs:729-735） | 只在备份/恢复的维护窗口期间出现，顺序执行的 runner 无法确定性地命中；用触发器制造 SQL 失败代替 |
| `pin_images` 中 `serde_json::to_string(&images)` 失败（:377） | `Vec<String>` 序列化不会失败 |
| 设置写入 / 删除失败被 `let _ =` 忽略（:376, :378, :392） | 同上，只在维护模式下出现；被忽略后不可观察 |

## 规范化候选（暂不应用）

Rust 双录尚未完成，`normalize` 全部为 `[]`。下面只列候选，等 A1/A2 原始差异出来后由 C2 审核：
`temp_sessions.updated_at`（`Utc::now`）；`row_key_mismatch` 新插入行的 `created_at` 列（来自 JSON，确定）与 `updated_at`（不确定）；
`settings.updated_at`（`save_setting` 与 `pin_images` 写入时）。错误文案、事件序列和存储类型都不做规范化。

## 剩余与阻塞

- 已覆盖的命令：`pin_images`、`unpin_images`（被测）；`save_setting`、`get_setting`（仅前置和观察）。共 4 个，未超过上限 10。
- 种子场景 21 个等 X3 种子机制（见上文）。在此之前，`empty` 场景只覆盖错误路径，成功分支还没有可执行场景。
- 未运行 A/B 重放，不计 C 级。
