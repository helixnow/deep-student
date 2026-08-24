# Round 3 子报告 #1 — `chatanki_transform` script 模式生产化

> 任务：把 `builtin-chatanki_transform` 的沙箱脚本模式从 TODO（`script_mode_unimplemented`）
> 做成生产可用，实现 Round 1 调研报告
> `docs/research/anki-ai-native/round1/04-shell-script-integration.md` 方案 B 的完整闭环。
> 本文是实现说明与契约权威记录；工具面用户文档见 `docs/anki-agent-tools.md` transform 专节。

---

## 1. 交付概览

| 层 | 文件 | 内容 |
|---|---|---|
| 脚本模式核心（新增） | `src-tauri/src/chat_v2/tools/chatanki_transform_script.rs` | 参数归一化、CHATANKI_INPUT/OUTPUT I/O 合同、解释器探测、沙箱执行、输出严格校验；约 20 个单测 + 5 个真实沙箱 e2e |
| 参数面 | `src-tauri/src/chat_v2/tools/chatanki_transform.rs` | `NormalizedTransformKind::Script(NormalizedTransformScript)` 携带载荷；新增 `TransformCardPlan`（ops/script 共用的逐卡计划）与 `plan_transform_ops` |
| 执行器 | `src-tauri/src/chat_v2/tools/chatanki_executor.rs` | `execute_transform` Script 分支（`run_transform_script_mode`）；dry_run/apply 重构为消费 `TransformCardPlan`，两模式共用同一条 CAS 写回；`sensitivity_level_for_call`：script→High |
| 模块注册 | `src-tauri/src/chat_v2/tools/mod.rs` | `pub mod chatanki_transform_script`（一行） |
| 前端 Schema | `src/features/chat/skills/builtin/index.ts` | transform 工具 `transform.script` 参数 + `oneOf` 互斥 + skill 文案 script 工作流一节 |
| 测试 | `tests/vitest/chat-v2/skills/chatAnkiTransformSchema.test.ts` | script 必填字段/超时边界/互斥/合同文案契约 |
| 文档 | `docs/anki-agent-tools.md` | transform 专节（ops + script 合同全量） |

## 2. 执行链（与调研报告 §4 方案 B 对齐）

```
┌─ Rust: 快照导出 ─────────────────────────────────────────────┐
│ execute_transform：参数归一化 → 文档所有权校验 → DB 全文快照   │
│（get_cards_for_document_for_session，无 2000 字符截断）→      │
│ 选择集解析（与 ops 模式共用 select_transform_cards）→         │
│ apply 模式先 check_expected_versions（沙箱执行前 fail-fast）  │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ 沙箱: 运行变换（chatanki_transform_script.rs）──────────────┐
│ 1. PlatformSandboxBackend.capability()：移动端/缺 bwrap/缺    │
│    sandbox-exec → 结构化 script_sandbox_unavailable           │
│ 2. resolve_interpreter：python3/python 或 node（目录直查，    │
│    与 skill_requires::probe_bin 同思路）→ interpreter_unavailable │
│ 3. prepare_transform_job：temp root/chatanki_transform/       │
│    job-<millis>-<seq>/ 写 CHATANKI_INPUT.json + 脚本正文      │
│ 4. SandboxPolicy{ writable=[job], allow_network=false 恒定 }  │
│ 5. env_clear + 白名单注入（CHATANKI_INPUT/OUTPUT、净化 PATH、 │
│    HOME/TMPDIR=job、C.UTF-8、PYTHONUTF8=1；python 加 -I）     │
│ 6. spawn → tokio timeout 看门狗 → 超时 terminate_process_group│
│    杀整个进程组；stdout/stderr 有界尾部捕获（各 16KB）        │
│ 7. 输出文件闸门：常规文件（拒 symlink）、≤32 MiB              │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ Rust: 校验写回（与 ops 模式同一条路径）─────────────────────┐
│ evaluate_script_output：顶层 schema + 逐卡合同校验 →          │
│ Vec<TransformCardPlan>（After / Invalid）→                    │
│ dry_run：transform_dry_run_payload 出 diff；                  │
│ apply：apply_transform 逐卡 CAS（update_anki_card_if_version_ │
│ for_session，ChatAnkiCardPatch 保持模板别名字段同步）→        │
│ 一次预览块 patch + fsrs://changed                              │
└──────────────────────────────────────────────────────────────┘
```

关键结构决策：**`TransformCardPlan` 把两种模式在「逐卡计划」处会师**。ops 模式经
`plan_transform_ops`（纯 Rust 应用编译后的操作序列）、script 模式经
`evaluate_script_output`（沙箱输出合同校验）各自产出与选择集等长同序的
`Vec<TransformCardPlan>`，此后 dry_run diff 与 apply CAS 写回完全共用同一套代码——
不存在「脚本模式绕过 ops 模式防线」的可能。

## 3. I/O 合同

### 3.1 输入（`$CHATANKI_INPUT`，UTF-8 JSON）

```json
{
  "documentId": "…",
  "cards": [
    {
      "id": "…",
      "index": 1,
      "front": "全文，无 2000 字符截断",
      "back": "…",
      "text": null,
      "tags": ["…"],
      "templateId": "design-swiss",
      "extraFields": {},
      "version": "2026-08-24T01:00:00Z"
    }
  ]
}
```

`version` = 快照时的 `updated_at`（与 `get_cards` 的 version 语义一致），仅供脚本参考。

### 3.2 输出（脚本写 `$CHATANKI_OUTPUT`，UTF-8 JSON，≤32 MiB）

```json
{
  "cards": [
    { "id": "…", "text": "变换后的 {{c1::术语}} 全文" },
    { "id": "…", "front": "更新的问题", "tags": ["生物", "重点"] }
  ]
}
```

逐卡规则（违反者逐卡 `invalid`，**不整批失败**）：

| 规则 | 逐卡 `error` |
|---|---|
| 更新键只允许 `front`/`back`/`text`/`tags`；输入合同键（`id`/`version`/`index`/`templateId`/`extraFields`）回显静默忽略（容忍脚本整对象回写的常见模式）；其余键 fail-closed 拒绝 | `unknown_output_field` |
| `null`/缺省 = 不修改；字符串 trim 后必须非空（**空字段拒绝**，v1 不支持清空字段） | `empty_field` |
| 类型必须匹配（字符串 / 字符串数组） | `invalid_field_type` |
| 修改 `text` 必须携带合法 `{{cN::答案}}`（N≥1、答案非空、允许 `::hint`；校验器与 `database::contains_valid_anki_cloze_markup` 同语义并有单测锁定） | `invalid_cloze_text` |
| 单卡 tags 去重后 ≤100 | `tags_limit_exceeded` |

顶层规则（违反者整批 `invalid_script_output`，不写库）：必须是含 `cards` 数组的 JSON
对象；条目必须是带非空字符串 `id` 的对象；`id` 不得重复；顶层多余键（脚本自报统计）忽略。

### 3.3 硬防线

- **`version` 回传一律忽略**：`evaluate_script_output` 根本不读取输出条目的 `version`；
  CAS 写回使用快照时 Rust 记录的版本 + Agent 显式携带的 `expectedVersions` 双保险
  （后者在沙箱执行**之前**校验，篡改/过期都到不了写库那一步）。
- **v1 禁止增删卡**：输出未提及的卡 = 不修改；快照之外的 `id` 记入顶层
  `unknownCardIds`（逐项报告，不写库）。增删卡走 `add_cards`/`delete_cards` 正门。
- **网络恒禁**：`SandboxPolicy.allow_network` 硬编码 `false`，参数面无豁免入口；
  e2e 用例验证沙箱内 TCP 连接失败。
- **文件系统**：只有 job 目录可写（bwrap `--bind`、Seatbelt `allow file-write*` subpath）；
  macOS 下对 `/opt/<x>/...` 解释器额外放行只读前缀（Homebrew Cellar）。
- **环境变量**：`env_clear()` 后白名单重建（合同变量、净化 PATH、job 目录 temp 指向、
  UTF-8 locale 强制），与 local_shell 的敏感变量硬拒绝语义等价但更严（白名单而非黑名单）；
  python 追加 `-I` 隔离模式双保险。
- **资源**：超时 1s–120s（默认 30s）强制，超时 `terminate_process_group` 杀整个进程组；
  沙箱自带 CPU 130s / 文件 4GiB / NPROC rlimit；stdout/stderr 各 16KB 尾部；
  输出文件 32 MiB 闸门（读入内存前按 metadata 检查，拒 symlink）。
- **审计**：job 目录（输入快照 + 脚本正文 + 输出）保留至会话 temp root 生命周期结束；
  返回值携带 `jobPath`（`runtime-root://temp/...`）与完整 `script` 执行报告。

## 4. 敏感度与审批

- 名字级基线（`sensitivity_level`）：`chatanki_transform` = Medium（ops 模式，与
  `batch_update_cards` 等批量写工具对齐）。
- 按参数动态分级（`sensitivity_level_for_call` + `has_dynamic_sensitivity=true`）：
  `arguments.transform.script` 非 null → **High**，对齐
  `shell_command_tool_sensitivity` 中「任何 script runner 恒 High」的纪律；
  script+ops 同时提供（参数非法，稍后被归一化拒绝）时同样按 High fail-closed。
- 审批卡脚本正文展示：`approval_scope::redact_tool_arguments_for_display` 对非 shell
  运行时工具**原样透传参数**，因此 `transform.script.code` 完整呈现在审批卡上，
  无需（也不应）在 chatanki 侧另做展示通道。skill 文案明确「由平台审批卡统一承接，
  不要在正文自行索要确认」。

## 5. 平台降级矩阵（结构化失败，永不 panic）

| 环境 | 行为 |
|---|---|
| 移动端（Android/iOS，无硬沙箱后端） | `capability()` Unavailable → `script_sandbox_unavailable`（rejected）；ops 模式不受影响 |
| Linux 桌面缺 bwrap / macOS 缺 sandbox-exec | 同上（拒绝执行，绝不静默降级为无沙箱） |
| 无窗口环境（headless 集成测试）拿不到 AppHandle/temp root | `script_environment_unavailable`（rejected）——先于 `window_ref()` 的 panic 路径拦截 |
| 本机无 python3/python 或 node | `interpreter_unavailable`（rejected），提示装解释器/换 language/改用 ops |
| 脚本超时 | `script_timed_out`（failed），进程组已终止 |
| 非零退出 / 信号杀死 | `script_failed`（failed），`exitCode` 为空表示信号终止，附 `stderrTail` |
| 0 退出未写输出 / 输出超限 / 输出非法 | `script_output_missing` / `script_output_too_large` / `invalid_script_output`（failed） |

## 6. 测试

### 6.1 Rust（`cargo test -p deep-student --lib chatanki_transform`）

`chatanki_transform_script.rs`（20 个）：

- 归一化：python/node + 默认超时；空/超长 code、未知 language、越界 timeoutMs、未知键拒绝（4）
- 输入合同：全文无截断、index、Rust 记录的 version（1）
- 输出顶层：非 JSON / 缺 cards / cards 非数组 / 重复 id / 缺 id / 超 32 MiB（3）
- 输出逐卡：未提及不修改 + 整对象回显容忍、字段更新 + version 忽略 + tags 去重、
  未知字段逐卡拒绝不连坐、空字段/类型错误、Cloze 只校验被修改的 text、
  Cloze 校验器语义锁定、快照外 id、tags 上限（8）
- 解释器/命令行/策略：候选顺序 + 执行位、POSIX/PowerShell 引号、
  策略只挂 job 目录且恒禁网、/opt 前缀放行、job 目录写入（5）
- **真实沙箱 e2e**（环境缺 bwrap/解释器时打印跳过，不失败）：python happy path、
  沙箱断网验证、超时杀进程组、非零退出 + 输出缺失、node happy path（5）

`chatanki_transform.rs`：既有 ops 测试全保留；script 归一化载荷、合同错误透传、
`plan_transform_ops` 顺序（3 个新增/改写）。

### 6.2 vitest（`tests/vitest/chat-v2/skills/chatAnkiTransformSchema.test.ts`）

script 必填字段（language/code）、timeoutMs 边界（1000/120000/默认 30000）、
`oneOf` 互斥、I/O 合同与安全边界文案、敏感度/增删卡禁令/平台降级文案、
ops 子集不回归、skill 工作流文案。

## 7. 已知边界与剩余风险

1. **macOS 解释器可读面**：Seatbelt 默认只读集含 `/System /usr /bin /sbin /Library/Apple`，
   实现对 `/opt/<x>` 前缀（Homebrew）做了放行，但 pyenv（`~/.pyenv`）、nvm（`~/.nvm`）等
   HOME 内解释器在 macOS 下不可读 → 表现为脚本启动失败（`script_failed` + stderrTail），
   不是安全问题。后续可按需扩展放行规则。
2. **Windows AppContainer 未实测**：命令行按 `windows_powershell` 契约生成
   （`& '<interpreter>' ...`，单引号翻倍转义），复用 local_shell 的同一 backend；
   本轮 CI 为 Linux，Windows 路径仅有编译与纯函数覆盖。
3. **v1 不支持 `extraFields` 更新与清空字段**：输出中的 `extraFields` 作为输入回显被
   忽略（不报错也不生效）；清空 text/front/back 无表达方式（空串被拒）。均为有意收窄，
   放开需要独立的 diff/校验语义设计。
4. **dry_run → apply 之间的快照漂移**：两次调用各跑一次脚本，若脚本含随机性，
   apply 写入的可能与 dry_run 展示的 diff 不同——这是脚本自身的确定性问题，
   合同文档已要求脚本纯函数化；CAS 版本防线保证不会覆盖用户并发手改。
5. **执行器外层看门狗**：`executor_registry` 对 `chatanki_*` 已有 600s 兜底，
   覆盖脚本 120s 上限 + 快照/写回 IO，无需改动。
