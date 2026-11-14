# WP-063：历史收件队列场景 v0

`inbox-recovery.json` 使用 WAVE0 §3 正式 v0：2 场景、3 个现有 IPC、8 步。
命令归 L04，触达的 WorkspaceCoordinator/MessageRouter 归 L05；不新增服务型伪命令。
前端入口 `src/features/chat/workspace/api.ts:198–230`；Rust
`workspace_handlers.rs:867–956`；Host `chat/src/register.ts:504–509`。

- `historical_read_twice`：加载 `ws_old`；worker_old 的 pending count 为 1，旧消息可见，
  重复读不得改旧行。打开时 user_version=1→2 属正常 schema 升级，所有旧业务列保留。
- `route_after_historical_load`：先加载，再给 worker_old 投递 task；count 1→2，
  旧 message/inbox 行保留，新消息/收件行和 message_received 事件交差分器比对。

来源是 X3 WP-044 的 `historical-wp013-v1`，其 workspace schema 固定 Git
`41a5ca8f1ff92f761eabd7594b676bcbc75d9e04`，SQL 构造样本，**不是 A 端录制产物**。
本 lane 不重建 seed SQL。C2 seed 作业 `20261105164200-825edc` 已 exit0；本包已复制其
workspace V1 文件用于真实 Host 服务回归，来源与边界见 `../tests/fixtures/wp063/README.md`。
`normalize: []`：旧 ID、状态、数量、顺序、JSON 原文均保留；新 ID/时间只有 A1/A2 双录并经
C2 批准后才可规范化，且返回值/事件/PK/FK 必须使用同一映射。

v0 只支持 cmd；peekInbox/drainInbox 没有直接 IPC。上述场景只覆盖加载/计数/后续路由的
可观察结果，不能代替队列恢复本身的验收。`tests/workspace-inbox-recovery.test.ts` 经真实
index provider/F3 验证重复 peek、全列不变、恢复队列与 router 共享、drain 和再次重装不重放。
精确历史 owner 回归仍由 X3 原断言及 C2 合 main 后独立复验；不把 listMessages 当 peek。
本包没有运行 A/B 差分，不计 C；全域 IPC 错误分支覆盖不在此修复包中宣称完成。

# WP-241：运行时根 11 条命令场景 v0（G3 分母 768 内）

- `runtime-roots.json`：12 个成功场景，134 步。
- `runtime-roots-errors.json`：9 个本域错误场景，153 步（L05 无 W-lane，按 D-158 在成功场景之后补写）。

格式为 WAVE0 §3 v0，seed 全部 `empty`。所有场景都含写操作，因此 `capture: {events:true, db:["*"]}`，`normalize: []`。
`expect:"error"` 只是注释，A 端真实输出为 oracle。最小检查作业 `20261106022958-95732c` exit 0，
检查内容：JSON 可解析、`validateScenario` 通过、21 个 id 唯一、每个 `${n.path}` 都占整值且指向更早的非 error 步骤。
**未运行 A/B 差分，不计 C。**

## 前置状态如何构造

v0 只支持 cmd、只支持整值引用，所以真实目录用别域的真实 IPC 串出来，不新增伪命令：

- 目录：L07 `skill_create {basePath:"~/.deep-student/skills/<base>", skillId, content}`，再调
  `skill_list_directories {path}`，取 `[0].path` 作为绝对目录（Rust `skills.rs:327 expand_path` 展开 `~/`；
  Host `agent-skills/index.ts:196-245`）。每个被列目录只放一个子目录，避免 readdir 顺序让下标不确定。
- 会话：L04 `chat_v2_create_session {mode:"chat", title, metadata:null}`，返回 `id`，并经
  `ensure_session_runtime_roots` 建好 artifacts/temp 根（Rust `handlers/manage_session.rs`；Host `chat/src/register.ts:368`）。
- 文件内容固定为 `"---\nname: w0-rt\ndescription: L05 runtime root seed\n---\n# 运行时根📚\n"`，74 字节，
  sha256 `35f62fb23f0fb3f82fa9f57894dccaef36ddc82084f8e7d49a166f047b472396`。`maxBytes:58` 截在一个多字节 UTF-8 字符中间，用来比对有损转换。
- `revert_workspace_change` 的成功场景使用按上述哈希手写的 `MutationReceipt`（`created`，以及带 `destination_path` 的 `moved`）。

运行器给每个场景单独设置 `HOME=<seed>/home`，所以返回值里的绝对路径和 `authorized_<sha256(path)[:16]>` id 每次运行都不同。
这些字段目前只标为规范化候选，等 A1/A2 双录和 C2 审核后再定规则；返回值、id 和后续引用必须用同一映射。

## 逐命令覆盖

| 命令 | 前端 | Rust | 成功场景 | 错误场景（触发的分支） |
|---|---|---|---|---|
| `chat_v2_list_runtime_roots` | `GroupEditorDialog.tsx:223`、`skills/loader.ts:81`、`useToolPermissions.tsx:126` | `runtime_roots.rs:1673` | `list_roots.defaults`（省略/null/空白/`session-preview`/怪 id）、`list_roots.created_session_and_authorized` | `list_roots.workspace_setting_unparsable`（`chat_v2.runtime.workspace_root` 非法 JSON）、`list_roots.authorized_roots_unparsable`（`chat_v2.runtime.authorized_roots` 非法 JSON）；其余为 DB/IO/文件系统故障，逐条见 WP-276 节 |
| `chat_v2_set_workspace_root` | `taskWorkspaceApi.ts:50`、`useToolPermissions.tsx:396` | `runtime_roots.rs:1813` | `set_workspace.variants`（缺省/read_only/read_write、label 修剪与空白、`/` 只读） | `set_workspace.errors`：空/空白路径、不存在、`~` 不展开（Rust 直接 canonicalize）、绝对文件路径不是目录、`/` `/home` `/root` 读写高危、非法 access 值、缺 path |
| `chat_v2_reset_workspace_root` | `useToolPermissions.tsx:413` | `runtime_roots.rs:1854` | `reset_workspace.set_then_reset`（未设置时 reset、设置后 reset、null sessionId） | `reset_workspace.authorized_roots_unparsable`（authorized 设置非法 JSON）；`delete_setting` 只有 DB 故障，见 WP-276 节 |
| `chat_v2_authorize_runtime_root` | `useToolPermissions.tsx:378` | `runtime_roots.rs:1871` | `authorize.labels_sort_idempotent`（默认 label、修剪、重复授权保留旧 label、按 label 排序） | `authorize.errors`：空/空白、不存在、`~` 不展开、绝对文件路径不是目录、缺 path（宽泛目录只打 risk 标签，不报错） |
| `chat_v2_revoke_runtime_root` | `useToolPermissions.tsx:424` | `runtime_roots.rs:1884` | `revoke.one_of_two`（按排序下标撤销，再撤销剩余项） | `revoke.errors`：未知 id、空 id、`workspace`、带空格 id、重复撤销、缺 rootId |
| `chat_v2_resolve_runtime_path` | `AgentTaskPanel.tsx:328,346` | `runtime_roots.rs:1941` | `resolve_path.roots`（workspace 文件/目录/根、artifacts、temp、authorized） | `resolve_path.errors`：workspace 未配置、未知会话、未知根、`..`、绝对路径、文件不存在、缺 relativePath |
| `chat_v2_list_runtime_directory` | `taskWorkspaceApi.ts:42` | `runtime_roots.rs:1785` | `list_directory.filter_sort_page`（隐藏/私有项过滤、排序、cursor/limit 边界 0/1/5000/越界）、`list_directory.session_and_authorized_roots`（`artifacts`/`artifact` 别名/`temp`/authorized） | `list_directory.errors`：未配置、未知会话/根、`..`、绝对路径、文件、目录不存在、非法 cursor、负数/小数 limit、多错误同现（验优先级）、缺 sessionId、reset 后；另 `filter_sort_page` 末步 cursor `' 0 '` |
| `chat_v2_read_runtime_file` | `ChangesSection.tsx:89,96,177` | `runtime_roots.rs:2551` | `read_file.limits_and_roots`（maxBytes 缺省/null/等长/少 1/截在 UTF-8 中间/0 和 1 被 clamp/超大、子目录、authorized 根） | `read_file.errors`：未配置、未知会话、目录、空路径、不存在、`..`、空 rootId、temp 下不存在的备份、负 maxBytes、缺 rootId |
| `chat_v2_set_skill_trust` | `skillTrustStorage.ts:156,162` | `runtime_roots.rs:1601` | `skill_trust.trust_retrust_revoke`（未信任时撤销、信任、修剪后重复信任、绝对路径别名、撤销忽略 packageRoot） | `skill_trust.errors`：空/空白/含 `/` `.`/非 ASCII id、trusted 时缺/空 packageRoot、不存在、缺 SKILL.md、是文件、子目录、白名单外、缺 trusted、trusted 类型错 |
| `chat_v2_revert_workspace_change` | `ChangesSection.tsx:123` | `runtime_roots.rs:2510` | `revert_workspace.created_and_moved`（created 删除文件、moved 移回，大写哈希） | `revert_workspace.errors`：receipt 非对象/缺字段/未知 op、非 workspace 根、未配置、只读、哈希不符/非法/缺失、空路径、`.git` `node_modules` 等受保护路径、`..`、绝对路径、文件不存在、modified 缺/错 backup_ref、deleted、moved 缺 destination/同路径/目标不存在、缺 receipt |
| `chat_v2_revert_artifact_write` | `ChangesSection.tsx:128` | `runtime_roots.rs:2454` | **无**（见下） | `revert_artifact.errors`：空/非十六进制/63 位哈希、空路径、`.`、`..`、绝对路径、未知会话、文件不存在、空白 backupRef、父目录不存在、backupRef 不在备份区/只有目录/多级/`..`/备份不存在、大写加空格哈希、缺 expectedAfterHash |

11 条命令全部有场景，其中 10 条有成功覆盖。错误分支覆盖 11 条命令（`list_runtime_roots`、`reset_workspace_root`
由 WP-276 补齐，见下一节）。

## WP-276：`list_runtime_roots` / `reset_workspace_root` 可达 Err 判定

`g3w-agent-workspace-01.json`，3 个场景，均 seed `empty`、`capture {events:true, db:["*"]}`、`normalize: []`。

设置项损坏是**真实可由 IPC 触达**的输入：通用 `save_setting`（Rust `src-tauri/src/cmd/web_search.rs:542-556`，
前端调用点 `src/components/WebSearchAdvancedConfig.tsx:239-241`；Host `host/plugins/browser/index.ts:339-345`）
只拦截 `internal.oauth.` 前缀（`web_search.rs:15-24`），`chat_v2.runtime.*` 走 `save_secret` → 非敏感键落到同一
settings 表（`dstu-storage/src/database/mod.rs:4230-4233`；Host `host/platform/settings/index.ts:82-83`）。
键名常量与读取点：`runtime_roots.rs:26-27`、Host `src/runtime-roots.ts:27-28`。因此 WP-241 记录的“需要 X3 损坏设置 seed”
不成立，改为本文件内先用 `save_setting` 写入非法值再调用被测命令。

| 命令 | 场景 id | 触发分支 |
|---|---|---|
| `chat_v2_list_runtime_roots` | `g3w.agent-workspace.chat_v2_list_runtime_roots.workspace_setting_unparsable` | `load_workspace_record` 的 serde 解析失败（`runtime_roots.rs:648-653`），经 `workspace_root:708` → `runtime_roots_for_session:1666` 返回 |
| 同上 | `...authorized_roots_unparsable` | `load_authorized_records` 的 serde 解析失败（`runtime_roots.rs:980-983`），经 `authorized_roots:1319-1330` → `runtime_roots_for_session:1667` 返回 |
| `chat_v2_reset_workspace_root` | `g3w.agent-workspace.chat_v2_reset_workspace_root.authorized_roots_unparsable` | 删除 workspace 键后调用 `chat_v2_list_runtime_roots`（`runtime_roots.rs:1868`），authorized 解析失败同上 |

### 判为不可达的分支（逐条）

`chat_v2_list_runtime_roots`（`runtime_roots.rs:1674-1685`）：

- `state.get_setting` 的 DB 错误 → `639-644`：只有 DB/连接故障，v0 无法注入；判不可达。
- `std::env::current_dir()` 失败 → `726-727`：进程环境故障；判不可达。
- `app.path().app_data_dir()` 失败 → `747-748`（artifacts）、`766-767`（temp）：平台路径解析故障；判不可达。
- `resolve_session_runtime_root`（`312-438`）的容器/会话根为符号链接或非目录（`339-345`、`389-391`）、
  逃逸容器（`349-351`、`396-398`）、legacy 根迁移/创建/inspect 失败（`361-386`、`424-436`）：
  需要对 app data 目录预置符号链接或制造 IO 错误，IPC 无此能力；判不可达（同 README 末节 G3 例外候选）。
- `authorized_root` 的身份校验失败不返回 Err，只降级 `configured:false`（`1015-1028`、`1319-1330`），不是错误分支。
- workspace 记录存在但路径失效/身份不符同样不报错，只降级（`708-720` 的 `is_ok()`）。
- `session_id` 是 `Option<String>`（`1677-1683`），只 trim/空值回退，不做校验，不存在入参 Err；
  非字符串入参属 Tauri 反序列化错误，三个真实调用点都不产生，故不写场景。

`chat_v2_reset_workspace_root`（`runtime_roots.rs:1855-1868`）：

- `delete_setting` 失败 → `1863-1866`：只有 DB 故障；判不可达。
- workspace 键损坏的分支在 reset 中不可达：`1863-1866` 先删除该键，成功后才进入 list；删除失败则在 `1866` 已返回，
  不会走到解析。故 reset 的可达错误只剩 authorized 解析。
- 之后与 list 相同的 `current_dir`/`app_data_dir`/`resolve_session_runtime_root` 故障，原因同上。

`equivalence/g3w-agent-workspace-01.json` 的 3 个场景已通过 `validateScenario`；未运行 A/B 差分，不计 C。


## 阻塞与 owner

- `chat_v2_revert_artifact_write` 成功路径：需要会话 artifacts 根里有一个已知哈希的文件。只有脚本化 LLM 工具轮次的
  `workspace_artifact_write` 能写入（skills 白名单不含 artifacts 根）。owner：X5 模拟 LLM + L03/L04 工具轮次，或 X3 提供带 artifact 的 seed。
- 设置项损坏分支（`Failed to parse ... runtime root(s)`，影响 list/authorize/revoke/workspace）：已由 WP-276 用通用
  `save_setting` 在场景内构造，不再需要 X3 seed；authorize/revoke 的同类场景仍归其原覆盖包。
- 符号链接、打开后被替换、IO 失败等分支只能靠故障注入触达，登记为 G3 例外候选。
