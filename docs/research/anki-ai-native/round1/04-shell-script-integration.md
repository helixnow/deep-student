# Round 1 子报告 #4 — Anki 制卡接入 `local_shell_execute` 可行性评估

> 任务：评估 Agent 在制卡闭环中「现写 Python/JS 做批量挖空、格式变换」的技术方案与安全边界。
> 交付：可行性报告 + `builtin-chatanki_transform` 工具 Schema 草案。
> 事实源以本仓库当前代码为准（commit `0e4c9fad`），关键位置见文末索引。

---

## 1. 结论（TL;DR）

| 问题 | 结论 |
|---|---|
| Rust 侧 shell 基建是否够用 | **够用且成熟**。沙箱、runtime root、审批分级、审计、变更回滚均已生产化，无需为制卡新造执行面 |
| 直接把 `builtin-local_shell_execute` 加进 chatanki skill | **不推荐**。数据面断裂（卡片在 SQLite 不在文件系统）、字段截断毒化、审批摩擦大、技能分工原则被破坏 |
| 是否应有 `builtin-chatanki_transform` | **应该有（推荐方案）**。把「无截断快照导出 → 沙箱脚本变换 → CAS 批量写回」封装成一次原子往返，计算面复用 local_shell 沙箱设施，数据面留在 chatanki 执行器 |
| 总体可行性 | **高**。全部依赖组件已存在，新增工作集中在一个新执行器 + 前端 skill Schema + 审批表登记 |

---

## 2. 现状盘点

### 2.1 `local_shell_execute` 安全基建（已生产化，可直接复用）

执行器 `src-tauri/src/chat_v2/tools/local_shell_execute_executor.rs`（约 2900 行）+ `shell_sandbox.rs` + `approval_scope.rs`，要点：

- **平台沙箱**：macOS Seatbelt（`macos_seatbelt`）、Linux bubblewrap（`linux_bwrap`，缺 bwrap 直接拒绝执行）、Windows AppContainer + kill-on-close Job（`windows_appcontainer_job`）；**移动端不支持本地 shell**。
- **Runtime roots 文件系统边界**：`workspace`（用户显式授权）/ `authorized_*` / `artifacts`（会话级读写）/ `temp`（会话级读写）/ `skill:<id>`（只读、注入 `SKILL_DIR`、不能作 cwd）。ReadOnly root 拒绝一切写能力命令；写命令的 path operand 越界（绝对路径、`..`、`$HOME` 展开）在启动前拒绝。
- **环境变量策略**：默认不继承父环境；敏感变量（TOKEN/SECRET/API_KEY/代理 URL 等）与执行控制变量（`PYTHONPATH`、`NODE_OPTIONS`、`LD_*`、`BASH_ENV` 等）无条件拒绝，`PATH` 只保留绝对路径去重白名单。
- **网络**：默认禁止，`allow_network=true` 显式声明且使用独立审批 scope。
- **敏感度分级**（`shell_command_tool_sensitivity`）：**任何 script runner（python/node/…）、管道、重定向、未知可执行 → 恒 High**；只读命令家族（ls/cat/rg/git status…）Medium。High 在谨慎/宽松档必须逐条审批且不可记忆。
- **不可覆盖灾难命令守卫**（`immutable_shell_command_guard`）：任何权限档位（含 Danger Full Access）都不能绕过。
- **审计与回滚**：命令 hash + 脱敏展示 + 审批 scope 指纹；`track_file_changes` 生成前后快照，产物变更可经 `workspace_change_revert` 回滚。
- **资源约束**：`timeout_ms` 1s–120s（默认 30s）强制生效；stdout/stderr 各自默认 64KB（上限 1MB）截断；进程组/Job 兜底清理。
- **档位联动**：做一做（Craft）+ Full/Danger Full Access → Unsandboxed 模式（免普通审批、撤沙箱但保留守卫）；问一问/想一想恒沙箱。

### 2.2 chatanki 工具面现状

- 28 个 `builtin-chatanki_*` 工具（`src/features/chat/skills/builtin/index.ts`），无任何 shell/script 能力。
- 卡片数据在 SQLite `anki_cards` 表；一切 Agent 写回走乐观锁（内容 `version` + 复习 `reviewVersion`）。
- `get_cards` / `list_library_cards` 单字段 **2000 字符截断**，配套 `truncated_source_overwrite` 防御拦截整字段覆盖。
- `chatanki_export`：JSON 落 **OS 全局 temp 目录**（`cmd/anki_connect.rs::save_json_file` → `std::env::temp_dir()`），APKG 落 **`~/Downloads`**——**两者都不在任何 runtime root 内，沙箱 shell 读不到**。

### 2.3 关键澄清：`allowedTools` 不是工具授权面

`src/features/chat/skills/types.ts` 明确声明：

> `allowedTools` 是 legacy SKILL.md `allowed-tools` 兼容元数据，**不过滤工具 Schema、不授权也不拦截工具执行**。

真正决定「模型能不能调某工具」的是技能激活时经 `progressiveDisclosure.loadSkillsToSession` 注入的 **`embeddedTools`**（多技能合并、按工具名去重，见 `TauriAdapter.ts` L5171–5200）；后端执行面（executor registry）对所有已注册工具常开，兜底安全靠审批 + 沙箱而非技能面。因此：

- 往 chatanki 的 `allowedTools` 数组里加 `builtin-local_shell_execute` **没有任何运行时效果**；
- 要暴露 shell，必须把完整 Schema 加进 chatanki 的 `embeddedTools`，或把 `workspace-tools` 声明为 `dependencies`（依赖闭包会随激活自动加载）。

---

## 3. 「Agent 现写脚本做批量变换」现状演练

假设用户要求「把这 80 张卡的术语全部挖空成 Cloze」。今天理论上的链路（需同时加载 workspace-tools）：

1. `chatanki_get_cards` 分页读全量（4 页 × 20）；
2. `workspace_artifact_write` 把卡片 JSON 写入 artifacts root；
3. `local_shell_execute`（root_id=artifacts）跑 Agent 现写的 Python 挖空脚本；
4. `workspace_file_read` 读回结果；
5. `chatanki_batch_update_cards` 携带 CAS 分批写回（>3 张先 `ask_user`）。

**六个断点**（按严重度排序）：

| # | 断点 | 性质 |
|---|---|---|
| 1 | **截断毒化**：任一字段 >2000 字符时，第 1 步拿到的就是残缺文本；写回要么被 `truncated_source_overwrite` 拦截，要么（`allowTruncatedSource=true`）真实毁掉超限内容。离线脚本变换会把截断文本二次加工，防御启发式（前缀重合判定）可能失灵 | 数据正确性，**硬伤** |
| 2 | **export 逃逸 runtime root**：`chatanki_export(json)` 落 OS temp、APKG 落 `~/Downloads`，沙箱只读挂载不含这两处 → 无截断的官方导出通道对 shell 不可达 | 数据面断裂 |
| 3 | **工具面割裂**：chatanki 激活 ≠ workspace-tools 激活；模型要先 `load_skills` 再跨技能编排，多数会话不会自发走通 | 可达性 |
| 4 | **CAS 时窗放大**：离线变换期间用户在预览块手改卡片 → 逐卡 `version_conflict`，需重读重跑，Agent 轮次膨胀 | 一致性（防御正确但代价高） |
| 5 | **审批摩擦**：Python/Node 脚本恒 High → 谨慎/宽松档每次 shell 调用都弹审批；一次变换至少 1 次脚本执行 + 若干文件读写 | UX |
| 6 | **stdout 预算**：单次 shell 输出默认 64KB，大批量卡片必须经文件传输，进一步加长链路 | 工程细节 |

结论：**现状「能拼但不可用」**——断点 1、2 使正确性无法保证，断点 3、5 使实际会话很难自发走通。这正是 README 中「`local_shell_execute` 存在但未接入 chatanki」的深层原因：不是没暴露工具名，而是数据面从未对齐。

---

## 4. 方案对比

### 方案 A：chatanki `embeddedTools` 直接追加 `builtin-local_shell_execute`

- 做法：把 workspace-tools 中 shell 相关 3 个工具（preflight/execute/artifact_write）的 Schema 复制进 chatanki，skill content 补工作流文案。
- 优点：改动纯前端；能力最通用（不限挖空，任意脚本）。
- 缺点：第 3 节断点 1、2、4、5、6 全部保留；chatanki 面向学习场景的技能被塞进通用 shell 全能力，工具描述预算膨胀（shell 合同文案约 2KB）；违背工具面总览确立的「数据修改走领域工具」分工纪律；两技能共存时 Schema 重复（虽有按名去重，但描述版本漂移会成为长期维护债）。
- **判定：不推荐作为主路径。**

### 方案 A'：零代码过渡 —— 文档化跨技能组合

- 做法：chatanki skill content 增加一节「复杂批量变换请 `load_skills(['workspace-tools'])` 后走 get_cards → 文件 → 脚本 → batch_update_cards」；同时把 `chatanki_export(json)` 的落盘改到会话 temp root（一行改动，`save_json_file` 增加 root 参数）以打通无截断数据源。
- 优点：立即可用，为方案 B 收集真实用例。
- 缺点：断点 4、5 仍在；截断问题仅对「先 export 后变换」的路径解决。
- **判定：可以做，作为 B 落地前的过渡。**

### 方案 B（推荐）：`builtin-chatanki_transform` 专用工具

把三段职责封装成一次原子往返：

```
┌─ Rust: 导出快照 ────────────────────────────────┐
│ 从 DB 读选中卡片全文（无 2000 字符截断），连同   │
│ version 写入 temp root 的 job 目录 cards.json    │
└──────────────────────┬──────────────────────────┘
                       ▼
┌─ 沙箱: 运行变换 ────────────────────────────────┐
│ 复用 shell_sandbox 的 SandboxPolicy/超时/清理：  │
│ cwd=job 目录、网络恒禁、CHATANKI_INPUT/OUTPUT    │
│ 环境变量指向输入/输出文件；脚本由 Agent 现写     │
└──────────────────────┬──────────────────────────┘
                       ▼
┌─ Rust: 校验写回 ────────────────────────────────┐
│ 读输出 JSON → 逐卡 CAS（复用 batch_update_cards │
│ 原语）→ 字段/Cloze 语法校验 → 逐卡结果报告 →    │
│ 一次预览块同步 + fsrs://changed                  │
└─────────────────────────────────────────────────┘
```

- **断点 1 消失**：快照直接出自 DB，永远是全文；写回是服务器端 CAS，不经过截断视图。
- **断点 2 消失**：job 目录在会话 temp root 内，天然沙箱可读写。
- **断点 3 消失**：工具就在 chatanki 技能面内。
- **断点 4 缓解**：快照→写回在一次工具调用内完成（脚本超时上限 120s），冲突时窗从「多轮对话」缩到「秒级」；冲突仍逐卡结构化返回。
- **断点 5 缓解**：一次变换 = 一次 High 审批（审批卡呈现脚本正文 + 目标文档 + 卡片数 + dry_run/apply），替代 N 次 shell 往返审批。
- **断点 6 消失**：数据走文件，stdout 只承载脚本日志。

### 方案 C：声明式 transform DSL（无任意代码）

内置 `regex_replace` / `cloze_wrap` / `tag_add` / `tag_remove` / `trim_whitespace` 等操作，纯 Rust 执行。最安全（可降 Medium、免脚本审批、**移动端也可用**），但表达力不满足「Agent 现写脚本」的 AI-Native 目标。

**推荐组合：B 为主体，把 C 作为 B 的 `transform.ops` 快速路径子集**（script 与 ops 二选一），A' 作为 B 落地前的文档过渡。

---

## 5. `builtin-chatanki_transform` 工具 Schema 草案

命名、CAS 语义（`expectedVersions` 对齐 `retemplate`）、逐卡结果报告（对齐 `batch_update_cards`）、`uiSync` 契约均沿用现有 chatanki 工具面约定。

```ts
{
  name: 'builtin-chatanki_transform',
  description:
    '对当前会话文档的卡片执行批量程序化变换（批量挖空、格式变换、字段清洗）。后端将选中卡片的无截断全文快照导出到会话 temp root 的 job 目录，在本地 shell 沙箱内运行你提供的脚本（或声明式 ops），再经逐卡乐观锁校验写回。默认 mode=dry_run 只返回 diff 摘要不写库；apply 必须携带与最近一次 get_cards 一致的完整 expectedVersions。脚本模式为 High 敏感度（平台审批卡统一承接，不要在正文自行索要确认）；ops 模式 Medium。脚本网络恒禁、只能读 CHATANKI_INPUT 与写 CHATANKI_OUTPUT，不能触达数据库。移动端不支持脚本模式，ops 模式仍可用。一次 apply 影响超过 3 张卡前必须先用 ask_user 征得用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: '目标制卡任务 documentId（当前会话拥有；来自 run/start/wait/import_apkg）',
      },
      selection: {
        type: 'object',
        description: '可选：变换范围。缺省为文档全部 live 非诊断卡。cardIds 与 filter 互斥。',
        properties: {
          cardIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 500,
            description: '精确选择的真实卡片 ID（来自 get_cards，不得使用序号或临时 ID）',
          },
          filter: {
            type: 'string',
            enum: ['all', 'edited_only', 'error_only'],
            description: '按状态筛选（与 get_cards 的 filter 同语义）',
          },
        },
        additionalProperties: false,
      },
      mode: {
        type: 'string',
        enum: ['dry_run', 'apply'],
        default: 'dry_run',
        description:
          'dry_run：执行变换但不写库，返回逐卡 diff 摘要，用于向用户展示效果；apply：校验 expectedVersions 后写回。首次变换必须先 dry_run。',
      },
      transform: {
        type: 'object',
        description: '变换定义：script（Agent 现写脚本，能力全集）或 ops（声明式安全子集）二选一。',
        oneOf: [{ required: ['script'] }, { required: ['ops'] }],
        properties: {
          script: {
            type: 'object',
            properties: {
              language: {
                type: 'string',
                enum: ['python', 'node'],
                description: '解释器。执行前按 skill_requires 探测逻辑确认本机可用，缺失时结构化返回 interpreter_unavailable。',
              },
              code: {
                type: 'string',
                maxLength: 65536,
                description:
                  '脚本正文。合同：从环境变量 CHATANKI_INPUT 指向的 JSON 文件读卡片数组，把变换结果写到 CHATANKI_OUTPUT 指向的路径；输入输出结构见工具文档；stdout 仅用于日志（默认 64KB 截断）。禁止网络与文件系统漫游（沙箱强制）。',
              },
              timeoutMs: {
                type: 'integer',
                minimum: 1000,
                maximum: 120000,
                default: 30000,
                description: '脚本超时；超时终止进程组并返回 timed_out=true，不写库。',
              },
            },
            required: ['language', 'code'],
            additionalProperties: false,
          },
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: '声明式操作序列，按序应用到每张选中卡片。纯 Rust 执行，移动端可用。',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'regex_replace',
                    'cloze_wrap',
                    'tag_add',
                    'tag_remove',
                    'trim_whitespace',
                    'field_copy',
                  ],
                  description:
                    'regex_replace：字段内正则替换；cloze_wrap：把每个 pattern 匹配变成递增的 {{cN::匹配}}（自动跳过已有 cloze 区间）；tag_add/tag_remove：整选择集增删标签；trim_whitespace：字段首尾与连续空白规整；field_copy：字段间复制（如 back → extraFields.note）。',
                },
                field: {
                  type: 'string',
                  enum: ['front', 'back', 'text'],
                  description: 'regex_replace / cloze_wrap / trim_whitespace 的目标字段',
                },
                pattern: {
                  type: 'string',
                  maxLength: 1024,
                  description: 'Rust regex 语法（regex crate；无回溯灾难），regex_replace / cloze_wrap 必填',
                },
                replacement: {
                  type: 'string',
                  maxLength: 4096,
                  description: 'regex_replace 的替换串，支持 $1 捕获组引用',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'tag_add / tag_remove 的标签列表',
                },
                from: { type: 'string', description: 'field_copy 源字段（front/back/text/extraFields.<key>）' },
                to: { type: 'string', description: 'field_copy 目标字段' },
              },
              required: ['op'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      expectedVersions: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'apply 模式必填：cardId -> version 完整映射，必须与本次选择集精确一致（与 retemplate 相同 CAS 语义）。dry_run 可省略。缺卡/多卡返回 expected_versions_mismatch，任一版本过期返回 version_conflict 且整批不写。',
      },
      purpose: {
        type: 'string',
        description: '变换目的的一句话说明，展示在审批卡与审计记录中。',
      },
    },
    required: ['documentId', 'transform'],
    additionalProperties: false,
  },
}
```

### 5.1 脚本 I/O 合同

输入（`$CHATANKI_INPUT`，UTF-8 JSON）：

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
      "version": "2026-08-24T…Z"
    }
  ]
}
```

输出（脚本写 `$CHATANKI_OUTPUT`，UTF-8 JSON）：

```json
{
  "cards": [
    { "id": "…", "text": "变换后的 {{c1::术语}} 全文", "front": null, "back": null }
  ]
}
```

- 只允许 `id` + 可选的 `front`/`back`/`text`/`tags`/`extraFields`；**`version` 不接受脚本回传**（写回比对用的是导出快照时 Rust 记下的 version，脚本篡改无效）。
- 输出中缺失的卡片 = 不修改；出现快照之外的 `id` = 该项 `invalid`；不认识的字段 = 该项 `invalid`（不整批失败）。
- v1 不允许脚本新增或删除卡片（`add_cards`/`delete_cards` 已有正门）；后续如放开需独立参数 + High 审批。

### 5.2 返回值草案

```json
{
  "status": "ok | partial | conflict | blocked | rejected | failed",
  "mode": "dry_run",
  "documentId": "…",
  "total": 80,
  "changed": 76,
  "unchanged": 4,
  "conflicts": 0,
  "invalid": 0,
  "diff": [
    { "cardId": "…", "fields": ["text"], "before": "术语解释…(截断展示)", "after": "{{c1::术语}}解释…(截断展示)" }
  ],
  "results": [],
  "script": { "exitCode": 0, "durationMs": 812, "timedOut": false, "stdoutTail": "…", "sandbox": "macos_seatbelt" },
  "jobPath": "runtime-root://temp/chatanki_transform/job-20260824-001",
  "mutationApplied": false,
  "retryable": false,
  "uiSync": { "status": "not_required", "eventAttempted": false }
}
```

- `diff` 的 before/after 仅为展示用途按 2000 字符截断——**写库路径不经过它**，截断毒化不复发。
- apply 模式的 `results[]` 逐卡语义与 `batch_update_cards` 一致（`ok`/`conflict`/`invalid`/`failed`），成功项汇总为一次预览块 patch + `fsrs://changed`。
- 脚本非零退出 / 超时 / 输出不可解析 → `status=failed`，`mutationApplied=false`，附 `stderrTail`。

---

## 6. 安全边界声明

| 边界 | 机制 | 来源 |
|---|---|---|
| 脚本不能触达数据库 | 只挂载 job 目录（temp root 子目录）为可写；输入/输出是普通文件 | 复用 `SandboxPolicy`（Seatbelt/bwrap/AppContainer） |
| 脚本不能改写他人卡片 | 快照只含选中卡；写回逐卡校验文档归属 + 会话所有权（既有统一 not-found 语义） | chatanki 执行器既有原语 |
| 版本安全 | CAS 用 Rust 侧记录的快照 version，脚本回传值忽略；`apply` 还要求 Agent 显式携带 `expectedVersions`（双保险：防 Agent 在过期快照上盲写） | `retemplate`/`batch_update_cards` 同源 |
| 网络 | job 沙箱恒 `allow_network=false`，无豁免参数 | `SandboxPolicy.allow_network` |
| 环境变量 | 继承 local_shell 的敏感/执行控制变量硬拒绝；额外注入仅 `CHATANKI_INPUT`/`CHATANKI_OUTPUT` | `build_env_plan` 同源 |
| 资源 | 超时 1s–120s 强制、进程组/Job 清理、stdout/stderr 截断、脚本正文 ≤64KB、快照卡数 ≤500 | local_shell 既有机制 + 新增上限 |
| 内容有效性 | 写回前校验「非空 front+back 或非空 Cloze text」、`{{cN::…}}` 语法有效性（对齐 `retemplate` 的 `invalid_cloze_text`） | chatanki 既有校验 |
| 审批 | `transform.script` 恒 High（对齐 shell script-runner 分级，审批卡展示脚本正文与影响面）；`transform.ops` Medium；Craft+FullAccess 免审批但灾难守卫与所有权校验不豁免 | `tool_approval_policy` 登记 |
| 破坏性确认 | apply 影响 >3 张卡先 `ask_user`（技能层纪律，对齐 batch_update/delete） | skill content |
| 平台降级 | 移动端 / bwrap 缺失 → `script` 模式结构化返回 `platform_unavailable`，`ops` 模式纯 Rust 不受影响 | `local_shell_contract_for_platform` 同源 |
| 审计 | job 目录保留输入/输出/脚本正文至会话清理；审批 scope 含脚本 hash | temp root 生命周期 + 既有审计管线 |

**明确不做的事**：不给脚本 stdin/PTY；不提供持久解释器会话；不允许脚本经 transform 触发导出/同步/复习状态变更（那些各有正门工具与确认纪律）。

---

## 7. 实施要点与工程量标定

| 层 | 改动 | 侵入度 |
|---|---|---|
| Rust 新执行器 | `chatanki_transform_executor.rs`：快照导出（复用 get_cards 的 DB 查询去掉截断）→ 沙箱执行（复用 `shell_sandbox::SandboxBackend` + `build_env_plan` 的过滤逻辑）→ ops 解释器（regex crate）→ CAS 写回（复用 `batch_update_cards` 的 IMMEDIATE 事务原语与 uiSync） | 新文件为主，`tools/mod.rs`/`pipeline.rs` 各一行注册 |
| 审批/敏感度 | `tool_approval_policy.rs` 按参数动态分级（script→High / ops→Medium）；`executor_registry.rs` 超时表（建议 180s 覆盖脚本上限+快照 IO） | 两处小改 |
| 前端 | chatanki skill `embeddedTools` 追加 + skill content 工作流一节 + `skills.json`/`chatV2.json` i18n | 纯增量 |
| 文档 | `docs/anki-agent-tools.md` 增补第 29 个工具 | 纯增量 |
| 测试 | vitest Schema 契约测试；Rust e2e：happy path（Python 挖空）、version_conflict、invalid 输出、超时、沙箱拒网、ops-only 移动端路径 | 对齐 `chatanki_apkg_executor_e2e.rs` 模式 |
| 过渡项（方案 A'） | `save_json_file` 支持落会话 temp root；chatanki skill content 指引跨技能链路 | 一行改动 + 文案 |

主要风险：

1. **Windows AppContainer 下解释器可用性**——`skill_requires::probe_bin` 已有探测逻辑可复用，执行前探测并结构化报错即可。
2. **快照与预览块的一致性窗口**——dry_run→apply 之间用户手改卡片会 CAS 冲突，这是既有语义（返回 `current` 重试），不引入新问题，但 skill 文案要求 apply 前重新 get_cards 刷新 `expectedVersions`。
3. **ops 的 regex 供给面**——使用 regex crate（无灾难回溯），pattern 长度限 1024，编译失败结构化返回 `invalid_pattern`。

---

## 8. 关键代码位置索引

| 事实 | 位置 |
|---|---|
| shell 执行器主体 | `src-tauri/src/chat_v2/tools/local_shell_execute_executor.rs` |
| 平台沙箱后端 | `src-tauri/src/chat_v2/tools/shell_sandbox.rs`（Seatbelt/bwrap/AppContainer） |
| 命令分析/敏感度/灾难守卫 | `src-tauri/src/chat_v2/approval_scope.rs`（`analyze_shell_command` L1930、`shell_command_tool_sensitivity` L2614、`immutable_shell_command_guard` L2646） |
| Craft 免沙箱判定 | `local_shell_execute_executor.rs::shell_security_mode` L461–472 |
| runtime roots（temp/artifacts 会话根） | `src-tauri/src/chat_v2/runtime_roots.rs`（`temp_root` L761、`artifact_root` L738） |
| `allowedTools` 仅兼容元数据 | `src/features/chat/skills/types.ts` L176–182 |
| embeddedTools 注入与按名去重 | `src/features/chat/adapters/TauriAdapter.ts` L5171–5200；`skills/progressiveDisclosure.ts` |
| chatanki 技能定义（28 工具） | `src/features/chat/skills/builtin/index.ts` L129 起 |
| shell 工具生产 Schema | `src/features/chat/skills/builtin-tools/workspace-tools.ts` L588–667 |
| export 落盘逃逸 runtime root | `src-tauri/src/chat_v2/tools/chatanki_executor.rs` L4787–4837；`src-tauri/src/cmd/anki_connect.rs::save_json_file` L2119–2133 |
| get_cards 2000 字符截断与防御 | `docs/anki-agent-tools.md` `get_cards`/`update_card` 章节 |
| CAS 批量写回原语 | `chatanki_executor.rs` `batch_update_cards`（IMMEDIATE 事务逐卡） |
| skill requires 解释器探测 | `src-tauri/src/chat_v2/skill_requires.rs`（`probe_bin`/`probe_requires`） |
