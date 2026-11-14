结论：完成，WP-C2-VERIFY-022 独立审读建议 N-008 待补目录身份原件；N-009 仅两处已核实 cell 的顶层 map 键重排可窄批，拒绝通用 DB text 归一化；两规则仍 proposed，交 C2 最终裁定。

# WP-C2-VERIFY-022：N-008 / N-009 环境投影窄审读（2026-11-07）

## 1. 固定输入与取证范围

- 开工工作区干净，检测到其他 lane 的并行 Vitest。正常 `git merge --no-edit main` 后审读基线为
  `16b573121d3f64afa30fd00f0300b935edc37aef`。已读 WORKER、R3 dispatch、standard-v2、quality，
  以及本树 vfs-repos/index/handlers 的 LANE、BLOCKERS、TESTMAP；reviewer 没有独立实现目录。
- 申请固定为 `ds-mig/X7-differential@974e1fbea`，前件 `40c0d3fc6`。使用 `git show` 读取固定
  DIFF-TRIAGE 与候选识别代码，未合入申请方分支。下文源码行号取固定审读基线；L05 runtime-roots、
  L16 两仓储/模板解码、Rust runtime_roots/database 主体与 974e1fbea 的 diff 为空。
- 原始场景、compare、A1/A2/B trace 在 X7 工作树只读取得。本文只判断三处样本及可建议规则，
  不把 1373/631 等截断样本计数当作全部同类 cell 已验，也不把 artifact equal 当作命令通过。
- `environmentProposals` 实际只有 N-008 workspace 与 N-009 template 两个代表；第二个 N-009
  卡片位置从同一固定 JSON 的 `groups` 中按 `anki_cards/extra_fields_json/N-009` 找到并取得 A2。
- 只编辑本 audit。命令 B/C、ACCEPTANCE、TESTMAP、active run/report/normalizer/approvals 均未改。

## 2. 唯一比较 probe 与原件清单

唯一 job **`20261106160726-81252a`**，cwd 为本 lane，分类 `other`，UTC
`2026-11-06T16:07:26.535Z` → `16:07:35.692Z`，**exit 0**。命令为：
`node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run --tail 500 -- python3 -c <内联只读比较程序>`。
完整命令（含程序）保存在 `/home/dsdev/.oc-jobs/done/20261106160726-81252a.json` 的 `cmd`，
原始 stdout 在同名 `.log`；工具展示被大段模板输出截断后，直接读取该完整日志，没有重跑。

程序先核 stored bytes 的 SHA-256，再解 gzip，按 db/table/完整 primary key（含 storageClass、
occurrence=0）查原 cell。**3 场景 + 3 compare + 9 trace，15/15 哈希一致**；两 proposal 内嵌的
六个 cell 与原 trace 完全相同。业务 Vitest 未运行（passed/failed/skipped 不适用），Rust 未运行。
最初两次只读结构探查分别误用 `steps` / `call.after`，以 KeyError/exit1 结束；随后按原件的
`calls[i].capture.databases` 读取。这两次不是比较成功证据，正式比较仅上述一次。

无损比较使用 Python stdlib JSON 的 `parse_int` / `parse_float` 保存**原数字 token**（不转 float），
`object_pairs_hook` 保留成员序列并检测所有层级重复 key；类型带标签区分 bool/number/string/null，
数组保持顺序，字符串不再递归当 JSON 解析。分别比较“仅根对象排序”和“所有对象排序”，两 N-009
样本两种结果均相等，说明只需最窄的根 map 重排。10 个方法护栏通过：2^53 相邻整数、1/1.0、
1e0/1、-0/0、true/1、null/对象、数组交换、null/missing、内嵌 JSON 字符串重排均区分，重复键拒投影。
这是比较器方法校验，不冒称业务测试或生产解码器认证。

### 固定申请文件（git blob 内容的 SHA-256）

| `974e1fbea:` 路径 | SHA-256 |
|---|---|
| `fixtures/differential/g3/runs/full/DIFF-TRIAGE.json.gz` | `6f9de78fce589f697388d0a071c21c203f81eeda16af6ca60218232cd1900776` |
| `fixtures/differential/g3/runs/full/DIFF-TRIAGE.md` | `97d20fd595724050c6062318386ff8fdbc2a44ed95a75e833d461ca08a0ae8c8` |

### 原件路径的精确定义

以下是可逐字展开的路径缩写，不是 glob：

- `X=/home/dsdev/dev/ds-mig/X7-differential`，`F=fixtures/differential/g3/runs/full`。
- `R=host__plugins__agent-workspace__equivalence__runtime-roots-errors`，
  `r=agent_workspace.runtime.list_directory.errors`。
- `T=host__plugins__anki__equivalence__cards-crud`，
  `t=anki.cards.builtin-template-referenced-delete-deactivates`。
- `C=host__plugins__anki__equivalence__anki-connect-import`，`c=anki.connect.import-package`。
- trace 路径：`X/F/A/<组>/000/<场景>/A1/trace.json.gz`、
  `X/F/A2/<组>/000/<场景>/A2/trace.json.gz`、`X/F/B/<组>/000/<场景>/B/trace.json.gz`。
- compare 路径：`X/F/compare/<组>/<场景>.compare.json.gz`。

| 组/场景 | A1 stored-byte SHA-256 | A2 stored-byte SHA-256 | B stored-byte SHA-256 |
|---|---|---|---|
| R/r | `c729e4facde4367d34cd02673012193d959f4696774bb43de20ee2a707552abb` | `1dd9b0f460468045bec2cf2aabe1e168a45cdb8e1be2f44ca96a7ba7bde6fbbd` | `bb4bf8053fc63738cfea163ac56d8921d9cf15cc05759368f915c8bef1c0949f` |
| T/t | `0678ea7ff2c7c3bea48291e418f55fb2f220e3362020d34c8f8d38c0e46b7c1c` | `19c7e2dd5d9b58a7cdd7c95c02d89245e6dea156d9eae286e90766137795ac78` | `f05f75bafc297220611f81ac07f6e0346ba100f8767212066ab6f592a9f1590d` |
| C/c | `26a60a3fea9759533994ebefbd36ba77d9f1db250d7c0a2b33528b10c79bf159` | `93e3cb3539faf4c05bd27636c8f260a6fe2dcf8cbe87e73c5f2085735bb1b171` | `e347f600737a96c86c6a0c7c315e9abd923f31bfc5ee3456e04100400067591e` |

| compare | stored-byte SHA-256 |
|---|---|
| R/r | `64366917da66343eb2d418bcbdafc8a7610ba319616be1332124a2191e723a6a` |
| T/t | `d34e01e3b3908e828c6ffa6933f0311418ff2a57f96b4b50bd0bf8683ac80f01` |
| C/c | `46eaf212d5f0f16d03d2edbd906970a1f96c41ce3d22fa88be1f55df01013337` |

| 场景文件（相对 X） | SHA-256（同时对应各 trace.inputSha256） |
|---|---|
| `host/plugins/agent-workspace/equivalence/runtime-roots-errors.json` | `6c29d71ec991ec933455e1c6934292db2660c66a47a20769cc8315c1aac9a96a` |
| `host/plugins/anki/equivalence/cards-crud.json` | `3a2eac789c35af31eb0e7c6b457871080e51b1f9db545f92f1d161f83a7c68c9` |
| `host/plugins/anki/equivalence/anki-connect-import.json` | `2149962c478019fccd77528dde527a9f260b30ae1bc0daeed5e622f8a67addc4` |

A1/A2 的 trace.build 均记 Rust job `20261106023719-bc16bc`、binary SHA-256
`102b48358f08f7f0d2d9b5a887b7337bacbc03f3ff217f3553d5900ec00cac7c`；B 的 build 字段未提供。
这些是原 trace 的自带元数据，本包不据此认证二进制/Host 源码闭包。

## 3. N-008：身份绑定不能作为任意随机字段删除

### 完整 A1/A2/B 样本与跨步骤核对

精确地址：`app-data/com.deepstudent.differential/slots/slotA/mistakes.db` /
`settings` / primary `key:text="chat_v2.runtime.workspace_root"` / occurrence `0` / column `value:text`。
三方 step9 的 JSON 均为 `path,label,access,identity`；逻辑 root id 为 **workspace**，label=`pkg`，
access=`read_only`，identity.kind=`unix`。真实路径为对应 trace 所在目录下
`run/home/.deep-student/skills/w0-lde/pkg`；即上述三个不同 take 根下的同一相对目录，不能只按 basename 配对。

| take | device（u64） | inode（u64） |
|---|---:|---:|
| A1 | 65025 | 352360126 |
| A2 | 65025 | 337527912 |
| B | 65025 | 413020848 |

亲读三方全部23个 call：before/step0–8 无该 setting；step7 `skill_create` 创建 pkg/SKILL.md，
step8 `skill_list_directories` 返回 pkg 路径，场景 step9 以 `${8.0.path}` 选择该目录。
所以这里精确说是 **empty seed 的独立 run 中由步骤创建的目录**，不是 seed 内某固定 inode 被复制。
step9 成功返回 workspace configured=true/read_only；step9–20 的上述 tuple 与 path/label/access
每方各自恒定，没有逐步重新分配映射。step10–20 依次保留 traversal、绝对路径、文件非目录、missing、
cursor、limit 与缺 sessionId 的原失败；step21 reset 后行消失，workspace configured=false；step22
拒绝未配置根；after/finalDatabases 也无该行。三方对应错误相同，完整 args/outcome/cell 在唯一 probe 日志。

**物理原件缺口**：probe 对三条已存 path 均得到 `exists=False`，未能取得目录 stat/realpath。
`is_symlink=False` 对不存在路径不证明历史上无 symlink；不能补写“实际 inode 已复核一致”。trace 能证明
记录稳定及所述调用结果，不能独立证明录制时 filesystem target 与 stored tuple 一致。没有猜测清理原因。

### 源码约束

- `host/plugins/agent-workspace/src/runtime-roots.ts:111–123` 先确认目录，再用 bigint stat 读取
  `dev/ino`；Rust `src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:183–199,569–583`
  是 `Unix { device:u64, inode:u64 }`，不是 inode 单值，也不是业务随机 ID。
- TS `:126–143` / Rust `:611–636` 先 canonicalize 且路径必须等于已存路径，随后 identity 缺失拒绝、
  当前 tuple 不同拒绝；TS `:199–212,335–340` / Rust `:708–723` 把旧绑定列为未配置或在使用前拒绝。
- Rust `:1814–1851` 选择目录时规范化、按缺省 read_only、做风险校验、读 identity 后持锁落库；
  TS `:159–171` 落库原字段。identity 的精确编码/读取在 `runtime-root-records.ts:5–7,196–216`。
- TS `:394–421` / Rust `:1067–1103` 将 identity 与 root id、canonical path、access、session scope
  一起纳入授权 digest。**摘要不能当随机字符串一起 mask**；本样本未执行 shell 审批，不授摘要规则。

### 裁定与最窄候选允许列表

**当前建议：待证，不批准执行 N-008；驳回递归剥除任意 identity.device/inode 的通用规则。**
申请代码 `974e1fbea:scripts/electron-migration/record/g3-triage.mjs:35–43` 只是候选发现器，
递归删除两字段没有 exact db/key、跨步双射或身份验证条件，不能原样升级 normalizer。

补证后可提交 C2 的最窄规则仅为：上述 R/r 三条固定 trace、step9–20、上述唯一 db/table/key/column，
只投影 JSON `/identity/inode`；**此样本 device 三方相同，保留 `/identity/device=65025` 原值**。
若以后需跨设备，另证后也必须把 `(kind,device,inode)` 作为完整对象身份建立一致双射，不能将 dev/ino
分别任意抹掉。规则绑定同一逻辑 root、同一 N-007 run-relative canonical path 及首次授权时刻；
每个 take→公共对象标签的映射固定于整个场景，重复引用复用、不同 tuple 不折叠，不按每步重新学习。
除获批数字槽外的原 record、storageClass、存在性、path、access、kind、configured、错误与事件均须保留。

必须保留的反例（源码反例，不声称本包动态运行）：

1. 同路径目录移走后新建：Rust `:2949–2966` 要拒绝，`:2970–2992` 必须 configured=false；
   不能把新 inode 再映射为旧标签。
2. symlink/目录改绑到另一 canonical target：`:611–621` 要拒绝；session symlink 原测试 `:2722`。
3. 两 root/两真实对象身份合并，或同一 tuple 的跨步骤引用断裂：双射必须失败，不可按显示名对齐。
4. root path、access 或 session scope 改变：授权 token 必须改变（`:3026–3082`）；不能只比较目录名。
5. identity missing/null、kind 换平台、u64 越界/数字类型变化、reset 后行残留：保留为差异。

待补：X7/L05 提供该固定录制的目录创建/绑定时 canonical-path、lstat/stat 与 tuple 原件（若历史已无则
如实不可恢复），及候选投影对上述目录替换/改绑/引用冲突反例的证明。需要新录制时由 C2 另包授权；
本包不恢复目录、不重放。当前可启用 allowlist 为空。

## 4. N-009：两处顶层 HashMap 顺序差可窄批

### 原始 cell 与任意精度比较

两处共用上面的 mistakes.db，primary key 均为 `id:text`、occurrence=0；只审指定 step0 的 `value:text`。

| 位置 / 场景 | A1 顶层键序 | A2 顶层键序 | B 顶层键序 | 独立结果 |
|---|---|---|---|---|
| `custom_anki_templates[id=design-architect].field_extraction_rules_json`，T/t step0 import_builtin_templates | Question, Expl, ID, Formula | Formula, ID, Question, Expl | ID, Question, Formula, Expl | 仅根 map 重排即可相等；各子对象字段顺序、值和数字 token 均相等 |
| `anki_cards[id=w233-ac-1].extra_fields_json`，C/c step0 save_anki_cards | Back, Front | Front, Back | Front, Back | 同上；两个值均为 string，A1/A2 自身已有顺序差 |

第一处四个规则的 `field_type="Text"`、`default_value=null`、`validation_pattern=null` 相同；
is_required 仅 ID=false，其余=true；`max_length` 分别 Question=30、Expl=60、ID=12、Formula=60，
描述逐字一致，全文保存在上面的 fixed proposal 与 probe RAW CELL。未将 null 当 missing，未转浮点。
第二处原文：A1=`{"Back":"Anki 的 HTTP 插件","Front":"什么是 AnkiConnect？"}`；
A2/B=`{"Front":"什么是 AnkiConnect？","Back":"Anki 的 HTTP 插件"}`。
C/c step1 三方 `get_document_cards` 返回相同两键/值的 `extra_fields` map；step2 返回 APKG 路径，
step3/4 均为端口8765拒连错误。这不证明 APKG 字节或 AnkiConnect 成功导入等价。

### 业务值与不透明 text 边界（Rust 与 TS 都存在两种边界）

| 边界 | Rust | TS | 对 N-009 的意义 |
|---|---|---|---|
| 模板规则业务写/读 | `dstu-storage/src/database/mod.rs:2539,2566–2570,2643–2647`，`dstu-core/src/models.rs:1505,1542–1571`：HashMap<String,FieldExtractionRule> 序列化/解码 | `anki/repository/templates.ts:61,120,171` stringify；`anki/src/templates.ts:219–224,256–263,288` 解码规则 map | 顶层 HashMap 无固定遍历顺序；本样本差异有生产来源，不只是 parse 后相等 |
| 卡片 extra_fields 业务写/读 | `database/mod.rs:4655–4676,4903–4907`，`models.rs:1409`：HashMap<String,String> | `anki/repository/anki-cards.ts:321–342` 写；`anki/src/anki-cards.ts:52–65,82` 读 string map | 只允许 map 的键序；map 的 string 值即使看起来像 JSON 也仍是字符串 |
| SQLite 原始快照比较 | 原 trace 保存原 cell | `host/e2e/data-compat/__fixtures__/database-state.ts:37–46,134–141,150–175` 明确不解析 text | 原始 text 依然不同，投影必须是 C2 明示批准的比较视图，不能修改原快照/原始比较器 |
| 同步传输/绑定 SQL | `dstu-sync/src/data_governance/sync/mod.rs:9388–9389` 把 SQL text 包为 Value::String | `sync/repository/sqlite-values.ts:227–228,265` 原样保留 string | 不能宣称所有消费者都只观察 JSON 值，更不能改持久文本或同步载荷 |
| 同步冲突“比较”专用边界 | 同文件 `:9040–9079`；`conflict_resolver.rs:525–563` 会解析对象/数组形 text 并排序、剥元字段 | `sync/repository/record-data.ts:46–82` 对应比较 canonicalizer | 这是另一专用语义，不能借其递归解析字符串/剥元字段来扩大本规则 |
| 模板导出 | `src-tauri/src/commands.rs:4481–4493` 重新序列化 typed template 为 `template_data:string` | `anki/src/plugin-handlers-templates.ts:84–93` decode 后 prettyTemplateJson | 导出字符串是独立可观察边界，不在 DB-cell 允许列表，不能顺手投影 |

上表 Rust 路径省略前缀 `src-tauri/crates/`，TS 插件路径省略 `host/plugins/`。
TS 使用普通 JSON.parse 的生产解码器不因此获得任意精度/重复键完整等价认证；本 probe 从 raw text
独立比较，已知 typed 规则也不使非法输入的 lenient fallback 成为“允许吞差异”的理由。

### 逐规则建议及精确允许列表

**建议 C2 仅窄批以下两条“观察位置”的顶层对象成员重排**，不是批准整列所有行/所有步骤：

1. N-009-T：T/t、step0、上述 mistakes.db、custom_anki_templates、id=`design-architect`、
   occurrence=0、column=`field_extraction_rules_json`、storageClass=`text`，仅解析文档根对象 `$` 的成员次序。
2. N-009-C：C/c、step0、同 db、anki_cards、id=`w233-ac-1`、occurrence=0、
   column=`extra_fields_json`、storageClass=`text`，仅文档根对象 `$` 的成员次序。

约束：三方原件及输入 hash 匹配；根必须是无重复键对象；只调整顶层成员排列，成员值与其内部顺序、
原数字 token、字符串内容及其编码差异不能被额外归一化。实际实现应保留原成员 token/slice，
或者另行证明只有排列变化；不因同一值落入同一浮点近似而相等。嵌套对象重排、空白/转义重编码均不
借本次申请自动放行。比较投影失败应保留 raw diff，不改变产品解析器的接受/拒绝行为。

必须区分：数组顺序/长度/重复值，string/number/bool，重复 key（不先 last-wins），1/1.0/1e0/-0
等数字 token，2^53 相邻整数，字段缺失/JSON null/SQL NULL，text/blob/其他 storageClass，行缺失/新增。
特别是 `_content_provenance` 等 string 内部 JSON **不递归解析**；其时间、code 或内容变化仍为差异。
字段名后缀 `_json`、A1/A2 也有差异、或 typed 读取会回退 `{}` 都不是全库放行条件。

**驳回/待证范围**：申请发现器 `g3-triage.mjs:30–34` 对任意 text 尝试 exact JSON 相等，只能用于
发现候选。模板 CSS/front/back/version、preview_data_json、document_tasks.anki_generation_options_json、
其他列/主键/步骤、字符串形式的导出结果、真实同步/备份字节均不在本次建议内。要扩大到整列，需
L16/X7 逐生产边界给出类型、允许嵌套范围、原件与新增位置 A1/A2/B；不从两个样本外推数千差异均可消除。
两条建议仍为 proposed，**本包没有启用任何规则**。

## 5. 收口与交付

- 独立窄审读完成：N-008 待证；N-009 两个精确样本建议窄批；通用 identity 剥除/所有 JSON text
  canonicalize 均拒绝。批准权限归 C2，当前运行差异仍保留。
- TESTMAP 未改变：L11 pending 0→0、L12 0→0、L13b 2→2；本包新增/改派 Rust ID 0。
- 自有业务测试 0 次；仅一次纯读取比较 probe exit0。提交 audit 后正常 merge main 并运行官方
  `node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`；最终 tip/base、
  门禁子 job 与 exit 随 `WP-C2-VERIFY-022.report.md` 的 wp-done 回执交付。
  官方列表对 docs-only 仍含 typecheck/boundaries，不选择业务 Vitest、Rust 或全仓 ledger。
- 阻塞的具体证据：N-008 三条物理目录原件已不可取得，缺独立 stat/realpath 与反例投影证明；
  不是 trace hash 不符。N-009 扩大范围未申请/未验；不影响上述两样本的限定建议。
- 供抽检：① R/r step8→9→20→21 的 path/identity 固定引用和 reset 行消失；② C/c 三方 step0
  原 extra_fields_json（A1 Back/Front、A2/B Front/Back），以及 TS/Rust string-map 解码与同步原串边界。

---

结论：完成，WP-C2-VERIFY-021 在固定源码029292123独立复核N1/N2/N3均通过；唯一双文件作业16 passed、0 failed、0 skipped、Errors/Unhandled 0。仅关闭这三个残差，L12/009全域不升级、不恢复旧资格。

# WP-C2-VERIFY-021：N1/N2/N3 窄独验（2026-11-06）

## 固定源码、范围与证据归属

- 固定受测 HEAD：`0292921234955ff14c6f105d2595acc958ccb5da`，独立 detached worktree：
  `/tmp/opencode/WP-C2-VERIFY-021-0292921`。运行前后 HEAD 相同，结束时 `git status --porcelain` 为空。
- 本 lane 开工正常 merge main 为 `e1b88e7dddb48b8bdd22a183f4835fe517b8d5a4`，当时 main
  `01dd0a0c8d871fdcedef6f7b4c4642643f04bcf6`；029是main祖先。两生产文件、两个目标测试、
  media公开错误面及本次Rust对照与029逐字无差异。测试仍在029独立树执行，未用新main替代固定树。
- 已读 WORKER、lane任务卡、L12 LANE/BLOCKERS/TESTMAP，以及 board/wp 的013/192/205/219报告。
  `git show main:host/plugins/media/api.ts:11` 已公开重导出同一个 `MediaError`，原接口等待解除。
- 本次只写本 audit；下面013及更早历史原文保留。013已签卸载/取消旧代/u64/raw-f32/i64不重新裁定；
  原两个文件整体执行时包含的旧例只如实计入运行总数。WP-219的embedding修正不借本包验收。
- 全测、提供方原件均不作为本次独验替代；未运行Rust、全目录测试、全测或ledger，未移动活全测树/锁。

## 逐项结论（源码行号固定于029）

`T/` = `host/plugins/vfs-index/`；`R` = `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs`。

| finding / owner | 独立结论 | Rust → 生产源码依据 |
|---|---|---|
| N1 / L12（公开错误类型L18） | **通过，无本项残差** | R:983–1030 → `T/src/pdf-runtime.ts:222–250` 保存最后同步消费的原stage，仅捕获公开MediaError，并携原实例返回；`T/src/pdf-service.ts:261–282` 使用原 `toPayloadString()`、WARN display、同代setError、二次失败ERROR、emit原stage/payload，随后INFO并return。取消分支对应R:1001–1007。 |
| N2 / L12 | **通过，无本项残差** | R:707–716 → `T/src/pdf-service.ts:226–230` 先消耗generation，再在Occupied分支逐字WARN `Pipeline already running for file: …` 后成功返回。 |
| N3 / L12 | **通过，无本项残差** | R:132–164的derived Debug及:2887–2892 → `T/src/pdf-service.ts:83–90,447–453` 完整15变体名映射，仅setError日志用Debug；成功写后才记录ERROR。 |

N1的display/payload来源还对照 `src-tauri/crates/dstu-media/src/media/transcriber_hook.rs:126–140`：
普通失败分别取Display和to_payload_string。公开 `host/plugins/media/api.ts:11` 导出类的
`src/errors.ts:9–21` 保留message/code与payload序列化；L12没有复制serializer或把未知异常包装成该类。
`pdf-runtime.ts:249` 对非MediaError重新抛出，外层 `pdf-service.ts:316–328` 保留原ERROR、初始阶段和PDF兼容事件。

**外层阶段纠偏**：brief中的“真正PDF外层仍原ERROR/queued”须按Rust原文理解为“ERROR/初始阶段”。
R:695–701明确AV初始queued，PDF默认OcrProcessing；:731、812–842保initial_stage。
因此真实PDF runtime外层应是 `ocr_processing`，AV未知异常才是 `queued`；不能把PDF改成queued。

## 逐断言真实性与实际覆盖

已逐条读两个既有文件；以下均在唯一作业中原断言通过，未改测试或预算。

1. **真实L18配置失败（media-failure:130–141，2例）**：真实L18/L11/L13/notes与L12安装
   （:58–79），owner创建文件/落库（:82–95）；音频/视频配置失败产生原settings-required payload。
   断言返回undefined、DB error/payload/null进度/completed_at、无progress；公共断言:108–128检查
   WARN display→ERROR→错误事件顺序、精确payload/queued、无completed/PDF事件、成功INFO。
2. **真实HTTP401（同文件:143–198，2例）**：回环server仅返回401/denied，实际POST
   `/v1/audio/transcriptions`且body非空；真实WAV/F7/L18运行至asr。断言queued/decode/asr进度、
   最后asr=35%、0/1段、原auth-failed payload。第二例用SQLite `BEFORE UPDATE OF processing_error`
   trigger真实拒写，断言DB仍asr/35%、error与completed_at均null，同时仍发原payload/asr事件。
   :115的全部ERROR精确数组及:120成功INFO排除误走Pipeline failed；:126–127检查日志/emit顺序。
   `startPipeline`的undefined本身只证明任务接收；内层Ok由生产return、任务settled、成功INFO与
   无completed/外层错误共同证明，没有把调度返回冒充后台结果。
3. **N1取消/旧代护栏（同文件:200–251，2例）**：真实L18等待槽位取消后await接受的task，
   断言稳定cancelled行、取消/完成INFO、无ERROR/error/completed事件；延迟配置读产生真实旧代失败，
   断言新代行/运行态不变且无错误事件，新代随后保原payload。只确认N1修复未越过已有护栏。
4. **未知异常与PDF外层分开（同文件:253–271；pdf-lifecycle:157–193，共3例）**：
   导入字幕真实L11 UPDATE trigger产生非MediaError，断言Pipeline failed ERROR、queued、原数据库错误，
   无内层转写WARN。PDF用真实L12 runtime/L11最终状态写trigger产生 `Database error: pdf completion rejected`；
   两例分别允许/拒绝set_error，断言Pipeline failed ERROR、OcrProcessing Debug、原error/status，
   二次失败 `Failed to set error status` ERROR，media/pdf两错误事件都保原 `ocr_processing`，无completed。
   PDF夹具不安装native文本提取器，走真实runtime的issues后最终写失败；不称有效PDF解析器全链通过。
5. **N2（pdf-lifecycle:195–224，1例）**：外部transcriber阻塞夹具只保持任务在途，真实调度器
   两次start；断言计数2n、仅一次转写请求、原signal未取消、running=1、状态原样、WARN逐字；
   释放后原任务正常completed。未替换被测startPipeline或spy生成WARN。
6. **N3证据分层**：真实配置/ASR/PDF失败分别验证Queued/Asr/OcrProcessing；其余Debug变体按
   R:132–164逐项静态对照。pdf-lifecycle:226–257的两例明确是公开MediaError注入的stage契约补充，
   只证明原字符串 `\u0085 AsR \u0085` / `future_asr` 分别规范化为日志Asr/Pending，同时事件和
   持久进度保原字符串/42%。不把手填payload与该替身当作生产错误来源，N1依据上面真实L18/HTTP用例。

**L02边界明确**：media-failure:162–167提供 `llm.getModelAssignments/getApiConfigs` 配置夹具，
:64提供settings夹具，未安装真实L02插件；lifecycle的OCR亦为依赖夹具。真实的是L18产生错误、
HTTP传输、L11/SQLite以及L12消费分支，不宣称真实L02配置持久化或完整L02/L18组合已独验。
video用例在解码前失败/取消，WAV字节以video元数据输入，不证明MP4解码。上述边界不妨碍三个指定残差签收。

## 唯一独立作业与原件

- job **`20261106000042-7b80ad`**，原件 `/home/dsdev/.oc-jobs/done/20261106000042-7b80ad.{json,log}`。
  队列父命令cwd是本lane；单次Node捕获命令的child cwd为上述固定worktree，队列分类实际为`other`，非伪称test。
- child命令：`/opt/node26/bin/node <固定树>/node_modules/vitest/vitest.mjs run -c vitest.host.config.ts
  host/plugins/vfs-index/tests/media-failure-integration.test.ts host/plugins/vfs-index/tests/pdf-lifecycle.test.ts
  --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=default --reporter=json
  --outputFile.json=/tmp/opencode/WP-C2-VERIFY-021-evidence/vitest.json`。
  Node v26.5.0 / ABI147；未跑Electron，原testTimeout=30000、beforeAll=180000未改。
- child起止UTC：`2026-11-06T00:00:43.129Z` → `00:01:14.433Z`；**raw code0 / signal null**，队列code0。
  **2文件通过：media-failure 7 passed；pdf-lifecycle 9 passed；合计16 passed / 0 failed / 0 skipped / 0 todo**。
  **Errors0、Unhandled0，无worker/RPC timeout**；stderr只有四次既有WASI ExperimentalWarning。
- `/tmp/opencode/WP-C2-VERIFY-021-evidence/` 保留 `run.json`（完整命令/前后HEAD/raw退出/dirty）、
  `stdout.log`、`stderr.log`、`vitest.json`。stdout含7条原 `WP-205 RAW` 和2条 `WP-205 STAGE RAW`，
  保存返回、完整files行、事件、logger和事件时DB快照；不是Rust差分实录。
- 重点原件：`asr-error-write-false` 的 `file_76-OZ8ryMh` 为error/asr35/原auth-failed payload；
  `asr-error-write-true` 的 `file_C9K6YFU8iX` 为asr35/error=null/completed_at=null，仍有同payload错误事件，
  WARN后精确ERROR `Failed to set media error status: Database error: status write rejected`，最后成功INFO。

## 收口与交付口径

- N1/N2/N3限定通过；没有新业务红或运行阻断。TESTMAP pending **0→0**、ported **77→77**、
  approved obsolete **2→2**、merged **0→0**，未修改任何去向，这三个源码分支没有新增Rust inventory ID。
- 009整域仍 `integrated pending independent acceptance`，B不成立；013中multimodal/page_index、preview等
  未验边界与原R12整组未决项保持，WP-222是另一个L12新包。
- 本审计提交后正常merge main，再直接执行绝对lane-gate；门禁仅检查审计交付，精确tip/base/子job/exit
  随本包 `board/wp/WP-C2-VERIFY-021.report.md` 回执交付，不以门禁替代上述固定源码独验。
- 供抽检：①media-failure:170–198的HTTP401+SQLite拒写及上述两个raw对象；②pdf-lifecycle:157–224
  的PDF初始阶段/二次ERROR与重复启动WARN。启动后检查点已通过coord仅发C2。

---

结论：完成，WP-C2-VERIFY-013 已给出L12已合28个生产文件的证据归属表；WP009卸载等待/取消旧代/u64 generation独立通过，R12-08 raw f32与出站最短值分离保持，WP028仅注释；新发现1项中等差异N1（音视频转写失败走错分支），全索引/SQL ownership/rerank等原未决项保留，L12不解锁B。

# WP-C2-VERIFY-013：L12 已合生产范围独立验收补齐（2026-11-06）

本节覆盖本工作包；下方历史节完整保留。只写本 audit，实现/测试/SPEC/TESTMAP/ACCEPTANCE 未改，未运行 Rust，未新起任何测试作业（e120 全测在跑，见“运行证据”）。

## 固定范围与口径

- 受审：main 合并 **`4723d8d46`** 相对 **`3f11b9c74`**。`git diff --numstat` 共56文件；去掉 `*.md` 与 `tests/` 后 **28 个生产文件 +784/-671**，与 brief 一致。触及这28文件的提交为39个（含WIP检查点），不是152项独立修复。
- 本工作树开工 `git merge --no-edit main` 至 main **`4f5c83b1c`**。`git diff 4723d8d46 4f5c83b1c -- host/plugins/vfs-index` 为空，所以结论同样适用于当前 main。下文 TS 行号均取 `git show 4723d8d46:<path>`。
- 归属方法：对每个文件取其 `4723d8d46` blob，按时间顺序找出**第一个 blob 完全相同的 R3 已审固定树**（21e8175c2、26b85c095、61a2e77c4、ee05933a9、c28e272d4、99da3ecec、d77bd5dbd、ccd402ae7、ab947994d、4efcf2fa9、7d7b25f90）。“相同”只说明该文件内容已在那棵树上；R3 当时只签了列出的**子项**，不等于整文件或整组签收。
- 区分：**测试覆盖**＝存在通过的用例；**独立行为签收**＝R3 亲自对照 Rust 源码分支并确认所测断言对应该分支。只有后者记“通过”。

## 28 文件证据归属表

`T/`＝`host/plugins/vfs-index/`，`R/`＝`src-tauri/crates/dstu-vfs/src/vfs/`。“已签”指向 vfs-index ACCEPTANCE 节号与原 job。

| 文件 | +/- | 首个同内容固定树 | 已签子项（原 job） | 本次新变动 | 仍未独验 |
|---|---|---|---|---|---|
| api.ts | +17/-8 | ccd402ae7 | R12-08 内部 percent:number / Snapshot nullable（§22，100324-4cb20e、103110-33ed17）；R12-09 generation number\|bigint（§12，014804-945753） | 无 | e936aa43a 的 `startedAt/completedAt: number\|bigint`（PDF 状态时间 safeIntegers）无 R3 独立断言 |
| index.ts | +10/-4 | 4efcf2fa9 | §21 lanceEnabled 回调（075942）；§16 settings 同连接（035112/040042）；§23 卸载先停任务（112148/112214） | **WP009**：inject 返回 async disposer，`await disposePdf()` 后 unbind；无 vfsRepo 时不再返回 disposer（本节 A，通过） | — |
| repository/chat-lance.ts | +11/-11 | c28e272d4 | R12-03 settings-owner 读失败默认值/写经 F4（§16 六例） | 无 | — |
| repository/index-content.ts | +19/-12 | 7d7b25f90 | 80cf53a42 owner 委托随 §12 链；OCR 条件缓存/recover 由 WP028 真实 owner 用例覆盖 | **WP028**：仅注释更正（4efcf2fa9→4723d8d46 diff 只有注释） | WP028 测试未经 R3 独立复跑或逐断言签收，本包不把它签到整文件 |
| repository/index-state.ts | +0/-147 | 99da3ecec | R12-03.config-copy 删除副本（§17，041644-ae0fe8） | 无 | — |
| repository/index-units.ts | +27/-36 | 21e8175c2 | R12-03.state-owner（§9，154913-89292e）；R12-09 nextUnitGenerationValue 无 Number（§12，014804-945753） | 无 | 带 embeddingDim 的本地写（X6-SW-0178）与其余 R12-03 表写所有权 |
| repository/owners.ts | +12/-9 | 7d7b25f90 | — | **WP009**：`IndexUnitProfileWrites` 改为 `Pick<VfsReposService['embeddingUnits'],'setIndexProfile'>`，纯类型；**WP028**：注释 | — |
| repository/pdf.ts | +14/-8 | 61a2e77c4 | §6 setter fallback 删除 | 无 | 状态时间 safeIntegers 读（同 api.ts 行） |
| src/chat-embeddings.ts | +10/-4 | c28e272d4 | §16 同连接时间戳/路径 | 无 | — |
| src/commands.ts | +3/-1 | c28e272d4 | §16 | 无 | — |
| src/embedding.ts | +10/-3 | 61a2e77c4 | R12-02.owner-error（§12，014804-945753）；generation 传递（§12） | 无 | 939686562/2965c6a27 之外的 transport 包装同类点（§11 原保留） |
| src/full-indexing.ts | +148/-51 | d77bd5dbd | §9 state-owner、§13 F7 primary/additional（020149-da37c7）、§14 additional-unit（024831）、§19 marker（050113）、§20 恢复顺序（052749）、§21 Lance-disabled（075942） | 无 | 整条索引流水线（R12-01）、原生 discard、并发 CAS |
| src/image-codec.ts | +0/-141 | 26b85c095（文件已删） | — | 无 | 3fd5fce46 删除；全 host 无引用。删除后替代路径未独立核对 |
| src/indexing-content.ts | +6/-1 | 21e8175c2 | §9 Scope 显式 owner | 无 | OCR 缓存 WARN 继续由 WP028 覆盖，R3 未独验 |
| src/lance-disabled.ts | +2/-2 | d77bd5dbd | §21 | 无 | — |
| src/lance-engine.ts | +6/-9 | 61a2e77c4 | §13 vectorSearchProfileFull 回读 page_index（020149） | 无 | `source_id` 改从 metadata 解析，仅 §13 两窗口间接覆盖 |
| src/lance-store.ts | +5/-19 | 61a2e77c4 | §12 nextUnitGeneration→bigint；§13 metadata_json→Arrow metadata | 无 | — |
| src/lance-types.ts | +40/-13 | 61a2e77c4 | §14 InvalidState code 识别；§13 parseLanceMetadataFields | 无 | 解析器对异常 metadata 的全部输入 |
| src/legacy-kb-store.ts | +5/-3 | c28e272d4 | §16 | 无 | — |
| src/multimodal-service.ts | +6/-4 | ee05933a9 | §12 rawJSON generation | 无 | bc3428852 `page_index` 经 `BigInt.asIntN(32, …)` 回绕，未独验 |
| src/ocr-recovery.ts | +16/-11 | ee05933a9 | §8 写回精度（142645-d02d0a） | 无 | ea5ccf9ee/bc3428852 的缓存失败 WARN 继续未独验 |
| src/pdf-preview.ts | +129/-0 | ccd402ae7 | §22 IgnoredAny 未知字段分支（100324-4cb20e） | 无 | 新文件其余 preview 解析逻辑未逐分支独验 |
| src/pdf-processing.ts | +144/-71 | ccd402ae7 | R12-08 JsonReader（§8）、raw f32（§22 补证，102806-4359c5） | 无（WP009 未改此文件） | 共享解析器整体认证不在 L12 |
| src/pdf-runtime.ts | +74/-86 | ee05933a9 | §13 OCR 临时文件/MIME（020149）；§10 slots/compress 生产调用（静态） | 无（WP009 未改此文件） | **N1**（runMedia，见 B）；共享 ocr_semaphore（§13 原保留） |
| src/pdf-service.ts | +38/-14 | 4efcf2fa9 | §8/§22 getStatus 省略与 snapshot；§23 卸载 abort | **WP009**：u64 generation、tasks 集合、async dispose、cancel 顺序、外层失败 ERROR（本节 A） | N2/N3 为基线前已有差异 |
| src/retrieval-service.ts | +4/-0 | 61a2e77c4 | — | 无 | 0f07c5d1a `attachMediaTimeRanges` 钩子，R3 未签 |
| src/runtime-adapter.ts | +27/-2 | d77bd5dbd | §21 lanceEnabled；§13 OCR 文件入口 | 无 | 0f07c5d1a media 时间窗接线；c0207e3bc pdfium 接线 |
| src/search-service.ts | +1/-1 | 61a2e77c4 | — | 无 | a2bf8cac1：metadata 标题判断用 trim、保存原值。本次静态对照 `R/indexing.rs:5014-5018`（`.filter(!t.trim().is_empty())` 后保留未 trim 原值）**一致**；无独立动态断言 |

汇总：28 文件中，新变动只有 4 个（index.ts、owners.ts、pdf-service.ts 属 WP009；index-content.ts、owners.ts 属 WP028，后者仅注释）；其余 24 个的内容在 WP009 之前就已存在于 R3 审过的固定树中，但只签了表中列出的子项。原 R12-01（整条流水线）、R12-03（其余表写所有权）、R12-04（rerank 正式 transport）、R12-05（整组）、R12-06（整组）仍未决，原 ACCEPTANCE 勾选不变。

## A. WP009 独立核对（逐 Rust 来源）

| 子项 | TS（4723d8d46） | Rust | 结论 |
|---|---|---|---|
| 计数先取后判 Occupied | `T/src/pdf-service.ts:208-211` 先取 generation 并递增，再 `running.has` 返回 | `R/pdf_processing_service.rs:707-722` `fetch_add` 在 `entry()` 前 | 通过：重复启动也消耗一个 generation |
| u64 回绕 | `:210` `BigInt.asUintN(64, generation + 1n)` | `:590,707` `AtomicU64::fetch_add`（溢出回绕） | 通过；`T/tests/pdf-lifecycle.test.ts:110-116` 从 2^64-1 起，两次启动后计数为 0n、1n |
| 取消顺序 | `:321-327` 先从 running 删除，再 abort | `:2947-2955` `running_tasks.remove` 后 `token.cancel()` | 通过 |
| 旧代不能删新代 | `:286-289` finally 只删同 generation | `:751-757` `remove_if(gen == task_generation)` | 通过；lifecycle 测试 `:97-131` 旧代释放后新代仍 running、stage 为 queued |
| 卸载等待所有已接受 future | `:215-220` 每个任务登记到 `tasks`，`:340-344` abort 后 `await Promise.all(this.tasks)`；`T/index.ts:48-53` `await disposePdf()` 后 unbind，`:99-100` 插件 effect 另调一次（第二次 running 为空，幂等） | Rust 的 spawned future 持有 `Arc<Self>`（`:729-735`），owner 不会在 future 结束前消失 | 通过。Cordis `node_modules/@deepseek-ai/cordis/lib/index.js:1372-1382` `_unload` 用 `Promise.all` await 每个 disposer，async disposer 生效 |
| 真实取消→drain→解绑 | lifecycle `:59-95`：真实 L11+L12 插件、真实 runtime 持临时文件；卸载未完成时 `unloaded=false`、owner 仍绑定；释放外部 OCR 后临时文件删除、owner 解绑，files 行与 ocr_text 未被旧代改写，无 completed/error 事件。`:133-155` 已取消任务也被等待 | — | 通过（真实生产路径，外部 OCR 为确定输入） |
| 外层失败日志 | `:276` ERROR `Pipeline failed for file … (type: Pdf/Image/Audio/Video): …`；`:277-282` set_error 失败记 `Failed to set error status` 后仍 emit | `:806-848` | 通过 PDF/图片/“transcriber 未注册”这些走外层 Err 的路径。见 N1：音视频转写失败在 Rust 不走这里 |
| generation 类型 | `IndexUnitProfileWrites` 改用 L11 公开类型 | — | 通过（纯类型，`setIndexProfile` 的 number\|bigint 已在 §7/§12 签） |

**pipeline generation 与 i64 精确写是两件事**：上面的 u64 计数只在内存里判断任务是否过期（Rust `update_processing_status`/`set_error`/`emit_error` 只读它做 `skip_stale_task_side_effects`，`:2725,2869,3257`），不落库、不过 IPC。落库的 i64 是 Lance/Unit/Segment generation，已在 §12（014804-945753，含 2^53+1 与 i64::MAX）和 §13（020149-da37c7，Linux 原生 Lance）签收；`index-units.ts`、`lance-store.ts`、`embedding.ts`、`tests/lance-store.test.ts`、`tests/support/real-owner.ts` 自 61a2e77c4 至 4723d8d46 **无差异**，multimodal-service.ts 仅上表 page_index 一行。

**R12-08 三条 f32 typed 断言与出站最短值分离保持**：`src/pdf-processing.ts`、`tests/pdf-status-boundary.test.ts`、`tests/pdf-status-wire.test.ts`、`host/platform/util/f32-json.ts` 自 ccd402ae7 至 4723d8d46 **无差异**；WP009 对 pdf-service.ts 的改动不触及 `getStatus`（`:158-174`）。真实 wire 边界：4723d8d46 的 `contracts/ipc/_shared.json` ProcessingProgress.percent 为 `anyOf [number x-float f32, null]`，`tests/pdf-status-wire.test.ts:78-85` 经 `host.invoke` 断言 1e40 返回成功 `percent:null`，`:55-61` 断言 33.333332，`:63-76` 断言内部 usize/i64 只在 kernel dispatch 时变为 JSON number。§8 的原 debug 拒 null 反例（143042-824c5b）在契约层已消除；三个文件均在 a42dae 与 7dc2b4 中通过。

## B. 新发现与既有差异

- **N1（中，交 C2→L12；基线前已存在，WP009 测试未覆盖）音视频转写失败走了外层分支。** Rust `run_media_pipeline_internal` 收到非取消的 `MediaTranscriptionFailure` 时（`R/pdf_processing_service.rs:1008-1029`）：`warn!("Media transcription failed for {} at {current_stage}: {display}")`，`set_error(payload, current_stage)`，失败时 `error!("Failed to set media error status")`，`emit_error(payload, current_stage)`，然后 `return Ok(())`，外层只记 info `Pipeline completed`。TS `T/src/pdf-runtime.ts` 的 `runMedia`（`git show 4723d8d46` 第 194-277 行，`:219` 直接 await；该方法自 3f11b9c74 起未改）直接 `await transcriber.transcribe(...)`，没有内层分支，异常进入 `pdf-service.ts:273-285` 外层：ERROR `Pipeline failed`、`Failed to set error status`、stage 固定为 `startStage`（音视频恒为 `queued`）、error 文本为 `Error.message`。差异：日志级别和文案不同；进度上报过 `asr` 等阶段后 stage 不同；Rust 的 payload 来自 `MediaError::to_payload_string()`（`dstu-media/src/media/transcriber_hook.rs:126-140`），TS 侧 `MediaError.toPayloadString()`（`host/plugins/media/src/errors.ts:19-21`）存在但未被消费，因此 `processing_error` 和事件 error 字段可能是 message 而不是 JSON payload。WP009 第4例 `pdf-lifecycle.test.ts:157-178` 用音频输入并引用 Rust :812-822，这对音频转写失败实际对应的 Rust 分支不成立；该用例只能证明外层分支。修复方向：runMedia 按 `failure.cancelled`/display/payload 分流，保留 current_stage。纯源码结论，未动态复现，未运行 Rust。
- **N2（低，基线前已存在）** `startPipeline` 已运行分支缺少 Rust `:712-716` 的 `warn!("Pipeline already running for file: {}")`（`T/src/pdf-service.ts:211` 直接 return）。
- **N3（低，基线前已存在）** `setError` 日志 stage 用 snake_case（`:404-411`），Rust `:2888-2891` 用 `{:?}` 输出 `OcrProcessing` 等变体名。
- **观察（不判缺陷）**：① Rust 外层 Err 分支的 `error!` 与 emit 不受 generation 门控（只有 `set_error` 受控），TS `:274` 对过期代整体 return；Rust 取消路径多以 `Ok(())` 返回，差异只在取消后仍返回 Err 的少数路径出现。② TS `:216-218` 额外 ERROR `Pipeline task failed` 对应 Tokio 隔离 panic，Rust 无此行。③ `dispose` 只 await 调用时的 `tasks` 快照；若 vfsRepo 单独卸载期间又有新 `startPipeline`，后加任务不在等待范围内。Rust 没有对应的“owner 卸载”。未构造动态反例。

## 运行证据（全部复用原件，本包未新起作业）

| job | cwd / 命令 | 原始结果 |
|---|---|---|
| 20261105144336-a42dae | L12 工作树；`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/ host/plugins/sync-providers/ host/plugins/vfs-index/` | code 0；`Test Files 148 passed \| 1 skipped (149)`，`Tests 1727 passed \| 20 skipped (1747)`。本人从日志逐文件统计 vfs-index：**31 文件、292 例全部 ✓**（含 pdf-lifecycle 5、pdf-status-wire 4、pdf-status-boundary 12、lance-store 16、index-service 40）；日志无 `Unhandled` / `⎯ Errors` 区块，`error:` 行只是 sync 用例的预期断言输出 |
| 20261105141817-7dc2b4 | 同上 cwd；`npm run test:host:electron -- pdf-lifecycle / pdf-status-wire / lance-store` | code 0；3 文件 25 例通过，含 WP009 五例与 R12-09 三例；无 Unhandled |
| 20261105144336-2c5a99 | `tsc -p tsconfig.host.json` | code 0 |

job JSON 不记录 git SHA。按提交时间推断：a42dae（14:43:36Z）在 4efcf2fa9（14:42:31Z）之后启动；7dc2b4（14:33Z）在夹具替换之前，0dbd1a0d7→4efcf2fa9 只把 `Promise.withResolvers` 换成本地 deferred，生产代码无差异。4efcf2fa9→4723d8d46 的生产差异只有 WP028 的注释；但其间 main 合并带入了其他 lane 的依赖，因此这两份原件证明的是 4efcf2fa9 时点的组合。1754 官方集成 1/1 绿不计为独验。WP028 的 index-service 48/294 例（173253-641b4a、173843-8fb7fd）是提供方证据，R3 未逐断言复核，不签到这28文件。

**不另跑测试的理由**：WP009 的目标行为都已有同目标原件（a42dae、7dc2b4）且生产代码未漂移；N1 是源码分支缺失，无需新用例即可确认。采样时作业队列 running/queue 各约10项，不满足“全测结束后”的前提。若 C2 要求 N1 的动态反例，最小用例为：真实 lifecycle 宿主，让 mediaTranscriber 先上报 `{stage:'asr'}` 再抛 `MediaError`，断言 WARN 文案、stage=`asr`、error 等于 `toPayloadString()`。

## 结论

- WP009 卸载等待、取消旧代、u64 generation：**通过**（A 表）。
- R12-08 raw f32/出站最短值分离及真实 wire null：**保持通过**，无漂移。
- R12-09 i64 精确写链：**保持** §12/§13 签收范围，无漂移。
- WP028：生产改动只有注释，**无行为变化**；其测试不作为本包签收依据。
- **不通过/待修**：N1（中）；N2、N3（低）。
- **未覆盖**：归属表“仍未独验”列各项，以及原 R12-01/03/04/05/06 整组。L12 仍为 integrated pending independent acceptance，B 级不成立；本包没有把未审部分判为失败。

# WP-C2-D1-003：L13/F1 独立验收初稿（2026-11-05）

本节覆盖本工作包；下方原报告完整保留为历史证据。**L13-vfs-api 与 F1-kernel 均不签全域通过，不解锁 B。**

## 基线、权限与取证口径

- 工作树 `/home/dsdev/dev/ds-mig/R3-review-vfs`，分支 `ds-mig/R3-review-vfs`；开工工作区干净，检测到其他 lane 的并行 Vitest。
- 已完整阅读 WORKER、R3 角色、ORCHESTRATION-v3、standard-v2，以及目标域 LANE/BLOCKERS/TESTMAP；reviewer 无独立实现目录，F1 TESTMAP 位于 `migration/testmap/F1-kernel.md`。
- `git merge --no-edit main` 从 `541479105` 快进，实际审读/测试起点 HEAD = **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**，与指定 phase0 tip 相同。
- phase0 base = **`87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494`**；所有下列源码行号指固定 tip，Rust 路径均从仓库根开始。
- 唯一编辑为本 audit。最终文件 **`host/plugins/vfs/ACCEPTANCE.md`**、**`migration/acceptance/F1-kernel.md`** 不在当前 allowlist，完整草案嵌入下文，待 C2/C1 授权后另包落盘。没有创建 `host/kernel/ACCEPTANCE.md`；账本 `scripts/electron-migration/ledger.mjs:72-77` 对 F 系列只读取 `migration/acceptance/<lane>.md`，且任何 `- [ ]` 都阻止 review.ok。
- 亲读的 `main:host/plugins/chat/api.ts:28-36` 已有附件错误与**双参数** scope 公共接口，`:46-49,199-201` 已有真实 registry 面；不沿用旧 BLOCKERS 的“L04未提供/单参数错接”。`memory/index.ts:109` 已提供 hpiasResearch；不将 genui 归为缺 L17 provider。
- 本包不运行 Rust，不改实现/测试/SPEC/TESTMAP/审批/超时。动态结果只能证明所选测试，不能替代逐分支审读或未完成的生产接线。

## phase0：73 个变更去向的分层抽检

实际执行 `git diff 87b1032a7 967f43c75 -- host/plugins/vfs/TESTMAP.md`，再按非 merge 提交分解；全部是 pending→ported，无新增 Rust id：

| 映射提交 | parent（该批 base） | 变更分布 | ceil(10%) | 本轮样本 |
|---|---|---|---:|---:|
| `e596e1b5eba15c4efaa9ee6e987399bc02e43f2e` | `0c2348a3f5a369dfc0b5335303ced807a512d5ef` | attachment 7 / retrieval 20 / dstu 8，共35 | 4 | 6 |
| `3ca2dcac002fadd65918465691b8639cb0582dce` | `e596e1b5eba15c4efaa9ee6e987399bc02e43f2e` | genui 37 / builtin_resource 1，共38 | 4 | 4 |

总样本 **10/73**，覆盖五组；不是按整体73只抽7条。逐行统计而非陈旧生成表头：phase0 base 381行 = **293 ported / 83 pending / 5 obsolete**；tip = **366 / 10 / 5**。本包自身 pending **10→10**，ported **366→366**，F1 **52 ported / 35 pending / 2 obsolete** 不变。

### 样本与逐断言结论

本表 Rust id 是 TESTMAP 中的精确 id（前置 `src-tauri/` 即源文件）；所有 TS 路径前置 `host/plugins/vfs/`。每行共同 base/tip 为上节 phase0 SHA，批次 parent 见上表。`toEqual`/循环断言按实际验证的事实逐项核对，不机械按 expect 词频判弱化。

| # / 批 | Rust id / 原文范围 | TS 用例/行 | 输入、原断言、边界与独立结论 |
|---|---|---|---|
| S01 / 1 | `src/chat_v2/tools/attachment_executor.rs::tests::test_can_handle`，609-619 | `tests/attachment-executor.test.ts:72-78` | attachment_list/read 两真、rag_search/resource_read 两假，四个原输入原方向全部保留，另验真实实例。经 `index.ts:226-229`、真实 L04/L18/L07 提供方获取 registry executor（test:27-66），**此样本可接受**。原例无IO/失败异常分支。 |
| S02 / 1 | `src/chat_v2/tools/attachment_executor.rs::tests::attachment_read_reports_missing_source_bytes_explicitly`，924-932；夹具790-858 | `tests/attachment-executor.test.ts:111-115`；夹具44-63 | 相同 res_ref_noblob→att_noblob、files无blob/resource_id、当前会话引用。Rust read必须失败，错误经localizer后code=ATTACHMENT_SOURCE_UNAVAILABLE；TS先精确reject，再真实execute失败/code和真实L04 localize spy。原失败及分类均保留，**此样本可接受**，未拿正常内容替代缺字节路径。 |
| S03 / 1 | `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_can_handle`，1767-1783 | `tests/retrieval-executor.test.ts:25-30` | 四builtin检索名+plain rag_search为真，memory_search/note_read/mcp_brave_search为假；8个原事实保留。可是 `retrieval-host.ts:58-74` 注入reranker/retrieval等替身才能触发 `index.ts:230-236`；真实provider缺口使**ported不接受**，不是断言数不足。 |
| S04 / 1 | `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::score_thresholds_filter_low_scores_with_absolute_min`，1802-1812 | `tests/retrieval-executor.test.ts:11,37-39` | Doc1=.9、Doc2=.5、Doc3=.2，绝对.3/相对.5；TS fround保f32，完整数组['Doc1','Doc2']同时验证原len=2及两个顺序title。**原断言等价**；生产调用在 `src/tools/retrieval-executor.ts:179`，但整工具注册受S03缺口阻塞，不能用纯函数绿测关闭生产接线。 |
| S05 / 1 | `src/chat_v2/tools/builtin_retrieval_executor.rs::session_scope_tests::scope_is_a_hard_filter_that_model_args_can_only_narrow`，2096-2113 | `tests/retrieval-executor.test.ts:106-111` | scope=[fld_course,fld_ch1]；无scope+['x']、无scope+null、有scope+null、缩到ch1、越界other回落整个scope，5组均相等。`scopeFolderIds` 由 `applySessionScope:74-85` 真调用，chat双参数接口当前正确；**纯策略通过、整链注册仍受S03阻塞**。未把返回全scope误称放开全库。 |
| S06 / 1 | `src/chat_v2/tools/dstu_executor.rs::tests::secx_08_upload_source_requires_managed_runtime_locator`，947-966 | `tests/dstu-executor.test.ts:47-53` | ['temp','attachments/a.pdf']成功；空、只root、只relative三拒绝；绝对路径/../两拒绝；旧local_path未知参数拒绝，原7事实全部保留。被测helper确在 `src/tools/dstu-executor.ts:193-202` 上传路径；但 `index.ts:222-225` 等dstuUpload，无生产provide，测试:26-30直接new实例不验registry。**不接受据此转ported**。 |
| S07 / 2 | `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_rejects_unsafe_or_oversized`，746-753 | `tests/generative-ui.test.ts:46-48` | x×129、../evil、javascript:alert(1)三个原拒绝向量，均null。生产 `GenerativeUiExecutor.execute:135` 调同一parser，`index.ts:219-221` + `memory/index.ts:109` 提供真实登记路径。**该纯函数样本可接受**；不外推为全部研究执行通过。 |
| S08 / 2 | `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_strips_unknown_fields`，882-902 | `tests/generative-ui.test.ts:63-65` | append/content/额外className/isRegex=false原输入；完整对象相等同时覆盖operation、content以及两未知键不存在，保留全部4断言。生产 `execute:126` 调用；**该样本可接受**。不是仅检查operation而漏删字段。 |
| S09 / 2 | `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_v1_1_grid_layout_returns_rendered`，1052-1089 | `tests/generative-ui.test.ts:70-80,107-111` | version1.1/grid/columns2/stat-card/span2；success、status=rendered、blockCount=1、input.layout.mode=grid四事实均保留，另验save结果。TS调用名为plain，Rust为builtin别名；生产execute不按名字分支（Rust375-485/TS111-155），canHandle同strip规则，因此此窗口为空向量等价。**限定样本可接受**；测试research callback刻意抛错且本分支不调用，不能证明有窗口HPIAS整链。 |
| S10 / 2 | `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_can_handle`，5683-5705 | `tests/mindmap-import.test.ts:61-67` | 十个builtin名真、四个非所属名假均出现，但Rust同一真实executor；TS对多个同名实例做some，且:23-41自建JSDOM XML树并provide mindmapXml/virtualFilePolicy。`resource-executor.ts:21-25` 无xml时mindmap_import=false；`index.ts:216-218` 的两服务无生产provider。**硬映射不接受**，测试注入绕过了原pending原因。 |

结论：所抽纯函数断言未发现以 `expect(true)` 等方式伪造；真正阻断是**生产必要提供方缺失，却用测试provide/直接构造支撑ported**。S03/S06、S10分别触及两批，故 **batch1、batch2均为整包拒收候选**；C2 已于 2026-11-05 签收两项生产接线反证，裁定两提交整包拒收（ported 资格不成立，不推断作者主观造假），回滚由 C2 在集成锁释放后执行，R3 不自行回滚、不改映射。首个确定证据形成后已通过共享 `coord.mjs queue C2-platform - --from R3-review-vfs` 即时投递，工具回执“已投递”。尚未审的63条不因抽样结果自动逐条判错或批准。

### 双标签裁定（按C2 2026-11-05 指令补充）

C2 已签收整包拒收，并要求每条样本分别标注“断言语义”和“生产资格”。生产资格按**被测具体符号**在正式启动中是否有真实调用方来判定；所在模块被 `index.ts` 导入或 wiring 显示可达都不算。证据来自固定 tree 源码，以及正式 profile 作业 `20261105140716-9cea35`：catalog 中有 AttachmentToolExecutor、GenerativeUiExecutor、BuiltinResourceExecutor，没有 BuiltinRetrievalExecutor、DstuToolExecutor。

| # / 批 | 断言语义 | 生产资格 | 具体符号与真实消费者 |
|---|---|---|---|
| S01 / 1 | 等价（4/4） | **成立** | `AttachmentToolExecutor.canHandle`；`index.ts:226-229` 依赖 chatAttachmentErrors/chatSession/docs，均由真实插件提供；测试从 registry 取实例（test:66），没有 provide 替身。 |
| S02 / 1 | 等价 | **成立** | 同一注册实例的 attachment_read 缺字节分支 + 真实 L04 `chatAttachmentErrors.localize`（test:37 只 spy，不替换实现）。 |
| S03 / 1 | 等价（8/8） | **不成立** | `BuiltinRetrievalExecutor.canHandle` 只在 `index.ts:230-236` 注册，该注册依赖 llmReranker/retrievalCancellable，正式启动均缺；测试在 `retrieval-host.ts:58-74` provide 了这两个及 llm/vfsIndex/webSearch 替身。 |
| S04 / 1 | 等价 | **不成立** | `applyScoreThresholds`（`retrieval-sources.ts:9`）全 host 唯一生产调用为 `retrieval-executor.ts:179`，位于未注册执行器内；无其他真实消费者。 |
| S05 / 1 | 等价（5组） | **不成立** | `scopeFolderIds`（`retrieval-sources.ts:107`）唯一生产调用为 `retrieval-executor.ts:85` 的 `applySessionScope`，同样位于未注册执行器内。L04 双参数 scope 接口正确，但它不消费此函数。 |
| S06 / 1 | 等价（7/7） | **不成立** | `requiredUploadLocator`（`dstu-executor.ts:80`）唯一调用为 `:195` uploadFile；`rejectUnknownArgs` 的全部调用也在 DstuToolExecutor 内；该执行器只在 `index.ts:222-225` 依赖 dstuUpload 时注册，正式启动缺失；测试 `:26` 直接 new。另核：原例中两条 `normalizeRuntimeRelativePath` 断言的被测函数由 agent-workspace 拥有，在 workspace-fs、runtime-roots、shell 等处有独立真实消费者，这2条事实本身生产可达；但该行测试的是 DSTU 上传定位链，整行资格不成立。 |
| S07 / 2 | 等价（3/3） | **成立** | `parseResearchSessionId` 在 `generative-ui.ts:135` 无条件执行；GenerativeUiExecutor 由 `index.ts:219-221` 注册，依赖的 hpiasResearch 由 `memory/index.ts:109` 真实提供（profile 中为 true，且 catalog 标为 executable）。 |
| S08 / 2 | 等价（4/4） | **成立** | `parseNoteEdit` 在同一注册执行器 `generative-ui.ts:126` 无条件执行。 |
| S09 / 2 | 等价（TS `toEqual` 比原 status/blockCount 更严格，另验 layout.mode） | **成立** | 被测的是同一注册执行器的 `execute`。该输入没有 researchSessionId，`:149-152` 的 research 分支不进入，测试抛错的 research 回调未被调用，因此不影响本样本。不外推到 HPIAS 整链。 |
| S10 / 2 | **不等价** | **不成立** | Rust 用**同一个** `BuiltinResourceExecutor::new()` 断言10个真+4个假；TS `mindmap-import.test.ts:62-66` 对多个同名实例取 `some`，掩盖了“单实例不能处理 mindmap_import”。生产中 `index.ts:215` 无条件注册无 xml 实例，`resource-executor.ts:22` 使 mindmap_import 为 false；`:216-218` 的 import 实例依赖 mindmapXml/virtualFilePolicy，正式启动缺失，测试 `:40` provide 了替身。另外9个真事实和4个假事实经无条件实例生产可达，但这一行映射不成立。 |

汇总：

| 映射提交 | 抽检 | 语义等价 | 生产资格成立 |
|---|---:|---:|---:|
| `e596e1b5e`（35） | 6 | 6/6 | 2/6（S01、S02） |
| `3ca2dcac0`（38） | 4 | 3/4 | 3/4（S07、S08、S09） |
| 合计 | 10 | 9/10 | 5/10 |

整包退回不表示73条都错。对未审的63条，本包只核到执行器注册层：attachment 组剩余5条所在执行器已注册；retrieval 剩余17条、dstu 剩余7条所在执行器未注册，除非被测纯函数另有真实消费者（需逐条按上表方法查证）；genui 剩余34条所在执行器已注册。builtin_resource 组只有 S10 这一条。以上只是返工时的分诊参考，每条仍需重新逐断言审读，不据此勾选或预判。

## 两域高风险入口逐分支审读

### L13：三条真实命令 + 检索owner边界

契约入口已逐条定位：`contracts/ipc/L13-vfs-api.json:91-132,179-216,8930-8967`；分别对上 Rust dstu/handlers.rs:2243、1663 与 vfs/handlers.rs:1327。SPEC只作定位，不采信其勾选。`api.ts:3-5,42-54,78-85,106-136` 与 `index.ts:152-247,406-408,495-497` 已核。

| 入口与完整审读范围 | 分支对照 / 结论 |
|---|---|
| `vfs_upload_attachment`：Rust `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1310-1639`；TS `src/upload-attachment.ts:118-278` | camelCase/name/mime必填、base64缺省空、Option缺省/null由契约处理；folder非空优先否则取配置；media判断；staged非空优先、非media bounded读取；media staged流/base64、非media bytes/base64三路；finally清staged；media hook；有resourceId才sync且失败warn继续；PDF/image status读错按无状态，completed/error不续、issues按retry、其他续；无状态PDF25/image10、text ready；缺compression覆盖但error不强制续；新建或需处理才后台启动、失败error；仅PDF有contentKind，undefined字段省略，percent null保留。对应TS129-193/195-249/251-277。**已确认流程落点；不通过运行时**：Rust1336 spawn_blocking，TS104-115 readSync及owner同步SQL仍在Host主循环，归既有R13v-04。SPEC4024的已勾选“差异”不是获批豁免。完整serde错误/媒体解码及owner内部全部事务未签收。 |
| `dstu_copy`：Rust `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:2243-3255` 全入口及三辅助；TS `src/dstu-copy.ts:1-600` | src解析→dst trim/root/解析错误/非folder；notes/textbooks/translations/exams/essays/files+images/mindmaps/folders/unknown十路均有落点。note/content空回退、translation非法JSON空字段、title Option、textbook重复.pdf后缀处理、essay只复制会话、file保itemType、mindmap用owner同事务；其余成员写失败warn继续，exam成员在owner内。folder同源/子树拒绝、上溯100、递归depth>=10拒绝、仅根加后缀、子列表/成员失败warn继续；unsupported项warn跳过；仅最终created事件。**不通过**：TS414在dst校验前取conn，Rust2265-2283先校验dst，改变维护/坏dst同时出现时首错；Rust2756 ERROR在TS583变WARN，Rust2869/2876/2900 ERROR降级或遗漏，入口/各成功及末尾业务INFO亦缺。仍经本lane `repository/folders.ts:152-177,638-647` 写L11 folders/folder_items，归R13v-01/03。 |
| `dstu_delete`：Rust `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1663-1755`、`handler_utils/delete_helpers.rs:15-113`、`crud.rs:213-269`；TS `src/dstu-delete.ts:1-190`、`repository/delete.ts:1-68` | 解析失败日志/字符串；UUID依textbook→note→exam→translation→essay探测；删除前resourceId查询失败忽略；note/textbook/translation/exam、essay session/round、folder、file/image/attachment、mindmap及unknown分派完整；成功后原path deleted事件；有rid才text→multimodal后台尽力清理。`index.ts:193-202` 两次Lance失败各自忽略，普通删除写入已委托真实L10/L11同conn，确认此所有权子项。**仍不签整命令**：TS64-71首个getConnSafe在probe外，Rust每repo调用在if let Ok内部，连接失败应逐项忽略；UUID原trying/found/not-found日志未保留。后台Promise也未由Rust BACKGROUND_TASKS对应的生命周期管理器纳管。全owner级联/退出排空留未审，不因普通事务测试绿而关闭。 |
| 检索scope补审：Rust `src-tauri/src/chat_v2/tools/builtin_retrieval_executor.rs:2044-2089`；TS `src/tools/retrieval-executor.ts:74-85` + `retrieval-sources.ts:107-114` | 无chat/vfs→原model；无scope→原model；各folder纳入自身、递归失败继续；排序去重；非空交集返回，否则回整个scope，边界相符。L04 `chat/index.ts:129`、`chat/api.ts:36` 当前双参数正确。必要reranker/cancellable provider缺口独立存在，不是scope纯函数错误。未审整段重排/取消所有失败分支，保持未签收。 |

### F1：raw JSON wire / coverage / 真实registry三入口

F1契约只有11个plugin命令（`contracts/ipc/F1-kernel.json`）；逐个定位 `src-tauri/src/plugins/commands.rs:11-90` 与 `host/kernel/plugins.ts:82-121`，此次完整审读的是以下三个高风险公共入口，**不把它们伪称15条IPC命令**。Value出口参照 `plugin_get_config` 契约72-101/Rust40-46；域规格 `migration/spec/F1-kernel.md:12-30,61-76`。

| 高风险入口 | 分支、生产路径及结论 |
|---|---|
| `CommandService._dispatch`/`BackendEventService._emit` raw出口 | 完整阅读 `host/kernel/commands.ts:186-287`：不存在/closed、kernel local ACL/普通ACL、args失败/ContractError记录、abandon信号、handler undefined→null、binary单独返回、raw品牌检测→debug结构→同源序列化→契约、CommandError对称错误出口、普通异常panic日志、finally移除listener/inflight；`json.ts:19-124` 逐类plain/cycle/array-hole/undefined/BigInt/raw/普通同形对象、raw单次stringify和投影、无raw递归转换；`events.ts:121-157` 发线上消息后内部监听仍取原对象；`connection.ts:195-214`仅ok/err透传json、panic不回响应。Rust JSON依据为锁定 `serde_json-1.0.149/src/ser.rs:155-179,698-704`（本机cargo缓存亲读：typed NaN/Inf→null，arbitrary number走NumberStrEmitter）。**限定边界静态正确，待本轮最小运行结果**；普通无raw规则未放宽。未审F2 renderer及全部serde形状，不能由Host成功外推跨进程最终UI。 |
| 命令coverage与启动roster coverage | `coverage.ts:30-69` 全分支：重复meta同owner去重、contract未声明/unknown/跨owner重复、registered省略不算运行时、提供时逐owner不一致及未声明、输出排序；`runtime.ts:338-343` 确实传真实非kernel注册及owner。`services.test.ts:355-376` 完整精确数组保留fixture_raw_json，没有缩成包含断言。此为迁移基础设施，无虚构Rust同名原测试。另核Rust `agent_wiring/roster.rs:158-181`缺descriptor保序/有缺失error/debug_assert；TS `agent-wiring.ts:56-88`只返回缺失供调用方断言，**全host仅api再导出和测试调用，生产未接自检**，而Rust `src-tauri/src/lib.rs:1559`实际调用。记 **F1-R3-01**，不能用命令coverage绿替代工具coverage。 |
| `composePipelineExecutorRoster`→真实L04 registry | 完整阅读 `agent-roster.ts:11-137`、Rust `src-tauri/src/agent_wiring/roster.rs:33-150`、`chat/src/executor-roster.ts:8-17`：63固定项顺序、workspace才追加5项、缺项一次性按顺序抛、app齐后才检查ToolPack/Ptc/General尾部；L04排除无execute metadata、从真实L07贡献构catalog，经F1排序再建registry。`chat/index.ts:119-124`消费L07，不再说“组合函数无消费者”。但实际领域贡献不齐；`agent-roster.test.ts:90-132`是明示RosterDouble排序测试，不能代替Rust真实AppExecutorRoster，相关TESTMAP仍35pending正确。记 **F1-R3-02** 真实组合未完成；本轮正式profile观察另附，不注入同名补位executor。 |

F1另亲对照1条真实PORTED：`src/agent_wiring/tests/custom_agent_tests.rs::chatanki_readonly_tools_are_allowed_and_low_sensitivity`（21-57）→ `host/kernel/tests/agent-wiring-custom-agent.test.ts:10-32`：原readonly全集每项safe包含/canHandle/low，及同一markdown文件解出六项allowedTools完整顺序，均保留；L24用真实 `createChatAnkiExecutors` 首匹配，非metadata替身。仅该条映射确认，不将fixture测试计入89条Rust TESTMAP。

## 独立验收草案一（可直接落盘）

最终路径：`host/plugins/vfs/ACCEPTANCE.md`（当前未授权创建）。

```markdown
# L13-vfs-api 独立验收（R3-review-vfs，2026-11-05）
结论：不通过。D1初稿，非全域通过；不得据此解锁B。

## 基线与覆盖
- 固定审读tip 967f43c7547d1ed29a7e3d736b8118fb95d3661e；phase0 base 87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494。
- 新审三命令：vfs_upload_attachment、dstu_copy、dstu_delete；补审检索scope边界。
- 映射抽检10/73，分别6/35、4/38，五组齐全；不足15命令/15测试，未覆盖部分保持未勾选。
- 原文/完整分支与逐断言矩阵保存在 docs/dev/electron-migration/audits/R3-review-vfs.md 的WP-C2-D1-003节。

## 必须修复
- [ ] R13-D1-MAP-01：e596e1b5e/3ca2dcac0两批映射已由C2裁定整包拒收，回滚待C2执行，返工由C1派发。抽检双标签：语义等价9/10（S10不等价），生产资格成立5/10（S01/S02/S07/S08/S09）。retrieval与DSTU生产注册所需llmReranker/retrievalCancellable/dstuUpload未提供（index.ts:222-236），applyScoreThresholds/scopeFolderIds/requiredUploadLocator唯一生产调用均在未注册执行器内；测试以provide或new补齐（tests/retrieval-host.ts:58-74、dstu-executor.test.ts:26）。builtin_resource test_can_handle对多实例取some，并靠JSDOM/virtualFilePolicy替身激活import（mindmap-import.test.ts:40,62-66），真实resource-executor.ts:22在无xml时拒绝。Rust原例：attachment609、retrieval1767、dstu947、builtin_resource5683。
- [ ] R13v-01.copy：dstu_copy仍通过本lane repository/folders.ts:172,641-645写L11 folders/folder_items；改接正式owner窄业务API且保原顺序/事务，不复制SQL（src/dstu-copy.ts:220-223,323,443-446）。
- [ ] R13v-03.copy：保Rust dstu/handlers.rs:2250-2283校验顺序和ERROR/业务INFO；src/dstu-copy.ts:414提前取conn，:583循环拒绝降WARN，:313/325递归失败降级，多个成功/失败日志缺失。
- [ ] R13v-03.delete：UUID fallback在src/dstu-delete.ts:65先取连接会传播；Rust handler_utils/crud.rs:213-269每次if let Ok忽略失败，且有trying/found/not-found日志。补相同失败/日志语义后独立复验。
- [ ] R13v-04.upload：Rust vfs/handlers.rs:1336-1340整段spawn_blocking；src/upload-attachment.ts:104-115及owner同步文件/SQL占Host事件循环。SPEC4024记载差异不构成豁免。
- [ ] 删除后台向量任务的退出排空/生命周期证据：Rust handlers.rs:1737由BACKGROUND_TASKS登记，TS dstu-delete.ts:183裸Promise；不能由delete返回成功推导任务完成。
- [ ] 完成其余命令、serde拒绝语义、owner内部级联、日志及取消/平台分支审读；既有R13v未决组未在本初稿自动清零。
- [ ] 补足至少15条命令与15条ported的独立证据，按C2后续范围验证未审项；本次只运行选定小集。

## 已核实通过（限定范围）
- [x] attachment S01/S02四项路由和缺原始字节错误分类，走真实L07 registry、L04错误owner和L11仓储，Rust原断言保留。
- [x] retrieval阈值三事实、scope五向量及DSTU上传locator七事实与Rust原断言语义等价；生产资格均不成立（被测函数仅由未注册执行器调用），不能据此转ported。
- [x] genui安全session id、noteEdit未知字段剔除、窗口为空的1.1 grid输出原断言保留，真实index/hpiasResearch提供路径存在。
- [x] dstu_delete消费者写入包装全部委托L10/L11同conn；成功后事件/向量清理顺序有源码落点，未据此签收全部owner/退出语义。
- [x] upload staged优先与finally.dispose、同步units失败warn继续、PDF/image状态/retry分支及结果可选字段均有对应；完整serde与线程保证待修。

## 建议
- [ ] owner更新LANE/BLOCKERS中已过时的L04/L17未发布描述，以及TESTMAP陈旧生成表头；本次未越界编辑。

## 验证记录
均经共享jobs，cwd为R3工作树、固定tree 967f43c75；全部exit0，测试日志无Errors/Unhandled，skipped均为-t名称过滤。
- 20261105140222-e2895a：npm run typecheck:host，exit0。
- 20261105140331-9b1ac1：attachment-executor/retrieval-executor/dstu-executor/generative-ui/mindmap-import，5文件 passed10 / failed0 / skipped72。绿测只证明所选断言，S03/S06/S10因测试provide/直接构造仍不接受。
- 20261105140747-407f49：upload-attachment/dstu-copy/dstu-delete，3文件 passed5 / failed0 / skipped11（staged优先、非法base64、folder循环、导图事务、owner savepoint）。
- 20261105140646-f38a97：importable.mjs host/plugins/vfs/index.ts host/kernel/plugins.ts，importable: ok。
- 20261105140646-f4dfbe：wiring.mjs --lane vfs，ported366、未接入0；机械可达不证明provider齐全。
- 20261105140716-9cea35：正式desktop profile、无provide替身，exit0仅表示观察完成；PORTS mindmapXml/virtualFilePolicy/dstuUpload/llmReranker/retrievalCancellable均false。
TESTMAP自身10pending→10pending，未修改。
```

## 独立验收草案二（可直接落盘）

最终路径：`migration/acceptance/F1-kernel.md`（当前未授权创建；不是host/kernel/ACCEPTANCE.md）。

```markdown
# F1-kernel 独立验收（R3-review-vfs，2026-11-05）
结论：不通过。D1初稿，非全域通过；不得据此解锁B。

## 基线与覆盖
- 固定审读tip 967f43c7547d1ed29a7e3d736b8118fb95d3661e。
- 三高风险公共入口完整分支审读：raw JSON命令/事件出口、命令及工具coverage、真实工具registry组装。
- 契约F1-kernel.json的11个命令入口已定位Rust src/plugins/commands.rs:11-90与host/kernel/plugins.ts:82-121；本包不把公共辅助入口计作15条完整IPC命令。
- 亲对照1条Rust ported（custom_agent readonly），其他运行的Host边界fixture不冒充Rust TESTMAP。未达到15测试；其余未审保持未勾选。

## 必须修复 / 待完成
- [ ] F1-R3-01：工具descriptor覆盖自检没有生产调用。Rust src/agent_wiring/roster.rs:158-181和src/lib.rs:1559在真实启动检查、日志并debug_assert；TS host/kernel/agent-wiring.ts:56-88目前只从api.ts导出及测试调用，既无实际日志触发，也无调用方debug拒绝。由F1与L04/L03组合根按所有权接入真实registry，不用假工具补齐；命令checkCoverage不是替代品。
- [ ] F1-R3-02：完成真实AppExecutorRoster及固定尾部组合。host/plugins/chat/src/executor-roster.ts:8-17确已消费F1排序，但L13等领域必要贡献缺失，metadata无execute被正确过滤；35条pending应继续保留。host/kernel/tests/agent-roster.test.ts:90-132的RosterDouble仅证明排序，不能代测Rust真实执行器。
- [ ] F1-V2-04整链仍未签收：plugins.ts:71-77创建IlinkBot未注入任务bridge；plugin_start/set_enabled/begin_login的远程任务分支需按原Rust闭合。此项沿已有未决，不将注册11命令当整链完成。
- [ ] raw JSON的F2 renderer、binary/ACL全部边界及实际业务链尚未在本包独立全审；Host出口小集不能代签外壳或跨平台。
- [ ] 补足剩余F1命令分支/至少15条ported独立核对；必需finalizer注册失败政策与完整清理仍待专包，不因本草案存在关闭。

## 已核实通过（限定范围）
- [x] raw仅识别原生品牌：json.ts:69-85的单次序列化同时产生原文和投影，typed非有限值null、raw1e400保token、BigInt保持原对象；普通rawJSON同形对象不冒充品牌。
- [x] commands.ts:186-287的成功/CommandError对称处理、binary分支、debug结构/契约及finally清理有真实入口；events.ts:121-136线上先发、内部监听后收原值；connection.ts:206-210只转发ok/err可选json。
- [x] coverage.ts:30-69五类集合与owner匹配、可选registered、排序均审读；runtime.ts:338-343取真实未关闭的非kernel注册。services.test.ts:355-376精确数组已包含新增fixture_raw_json，原断言没有削弱。
- [x] agent-roster.ts:116-136固定顺序、workspace条件组、缺失汇总/尾部拒绝正确；L04已实际消费，不再把API未发布作为阻塞。
- [x] custom_agent_tests.rs:21-57→agent-wiring-custom-agent.test.ts:10-32逐项safe/canHandle/low及完整六项allowedTools顺序一致，消费真实L05/L24公共实现。

## 建议
- [ ] 后续回派区分命令coverage、工具descriptor coverage及真实执行链三个不同保证，使用当前公开API与固定树证据。

## 验证记录
均经共享jobs，cwd为R3工作树、固定tree 967f43c75；全部exit0，测试日志无Errors/Unhandled，skipped均为-t名称过滤。
- 20261105140222-e2895a：npm run typecheck:host，exit0。
- 20261105140646-087b73：raw-json-wire/services/e2e/agent-wiring-custom-agent，4文件 passed7 / failed0 / skipped19（F1-RAWJSON 4+真实fork raw 1、coverage 1、custom_agent 1）。
- 20261105140646-f38a97：importable.mjs host/plugins/vfs/index.ts host/kernel/plugins.ts，importable: ok。
- 20261105140716-9cea35：正式desktop profile观察，DEGRADED=[]；L07 catalog 24项、21项有execute（Memory/AcademicSearch/LearningOverview仅metadata）。真实chatSession.assembleExecutorRegistry在workspace=false/true分别抛MissingExecutorError，app阶段缺50/55项（含BuiltinRetrievalExecutor、DstuToolExecutor）；尾部ToolPack/General检查尚未到达，不代表完整pipeline最终缺失数。exit0只表示观察完成，不计测试通过。
F1 TESTMAP 52ported/35pending/2obsolete前后不变；没有新增obsolete审批。
```

## 独立验证

所有命令经共享 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs`，cwd 为本工作树、固定 tree `967f43c75`；完整输出与 argv 在 `/home/dsdev/.oc-jobs/done/<job>.{log,json}`。七个作业全部 **exit 0**；测试日志无 Errors/Unhandled 汇总，skipped 全部来自 `-t` 名称过滤，没有改测试或 skip。

| job | 范围 | 结果 |
|---|---|---|
| `20261105140222-e2895a` | `npm run typecheck:host` | exit0，无类型错误 |
| `20261105140331-9b1ac1` | 五个 phase0 目标文件，`-t` 选择 S01–S10 | 5文件，**10 passed / 0 failed / 72 skipped**，60.95s |
| `20261105140646-087b73` | raw-json-wire 4例、真实fork raw 1例、services coverage 1例、custom_agent 1例 | 4文件，**7 passed / 0 failed / 19 skipped**，10.08s |
| `20261105140747-407f49` | upload staged/非法base64、copy循环/导图事务、delete owner savepoint | 3文件，**5 passed / 0 failed / 11 skipped**，40.40s；upload 两例实际执行 |
| `20261105140646-f38a97` | `importable.mjs host/plugins/vfs/index.ts host/kernel/plugins.ts` | `importable: ok` |
| `20261105140646-f4dfbe` | `wiring.mjs --lane vfs` | `合计 ported 366，其中所测模块未从 index.ts 接入 0（0.0%）`；机械可达不证明 provider 齐全 |
| `20261105140716-9cea35` | 正式 desktop profile，无 provide 替身；真实 L07 catalog→L04 组装 | 观察完成 exit0，不计测试通过；结果见下 |

正式 profile 观察（独立 `/tmp/opencode/R3-WP-C2-D1-003-*` dataDir/XDG，真实 L05 公共策略，finally dispose）：

- `DEGRADED=[]`；`PORTS={"mindmapXml":false,"virtualFilePolicy":false,"dstuUpload":false,"llmReranker":false,"retrievalCancellable":false,"chatRetrievalScope":true,"hpiasResearch":true}`。这直接证实 S03/S06/S10 依赖的五个 provider 在生产启动中缺失。
- L07 catalog 24 项，21 项有 execute；MemoryToolExecutor、AcademicSearchExecutor、LearningOverviewExecutor 只有 metadata，被 L04 正确过滤。
- `chatSession.assembleExecutorRegistry([], policy, false/true)` 分别抛 MissingExecutorError，app 阶段缺 **50/55** 项，包括 BuiltinRetrievalExecutor 与 DstuToolExecutor；完整名单见作业日志。因为缺项在 app 阶段即抛出，ToolPack/General 尾部检查未执行，50/55 不是完整 pipeline 的最终缺失数。

本节动态结果只证明所选测试与观察，不改变上文 S03/S06/S10 不接受、两批拒收候选和两域不通过的结论。

## 交付

- 审读与验证的固定 tree 为 `967f43c75`；审计首提交 `7ac7cdf39`，回执补录为其后一个仅 audit 的提交。交付前合并的 main 自 `967f43c75` 起未改动 `host/plugins/vfs`、`host/kernel`、`migration/testmap/F1-kernel.md`、`host/plugins/chat/src/executor-roster.ts` 及本 audit，phase0 证据适用于交付基线。
- lane-gate 作业号、最终 tip/base 由 `coord.mjs wp-done` 报告记录，不回写本文件以免改变已门禁的 tip。
- 本包 TESTMAP 无改动：L13 366/10/5、F1 52/35/2 前后相同。

供C2二次抽检：**S02**（缺字节错误分类，原失败断言保留）与 **S10**（多executor+测试XML提供方伪闭合生产注册）。授权阻塞与未审范围如上，不要求本lane越界实现或重写测试。

---

# R3-review-vfs 独立复核汇总（2026-11-04）

**最新卸载错误候选复核（2026-11-05）**：7847ae733＋ab947994d先abort/clear当前媒体任务再解绑L11 owner，原generation/取消检查阻止晚到setError；未改guard或测试。原112148上传5例及112214联合181文件1609通过/2跳过均已亲取exit0、无Unhandled；限定集成错误候选闭合，详见L12 §23。查验时尚非main，不计入19:30固定23c679e40全测，16组主线语义未决保持。

**最新R12-08合入意见（2026-11-05）**：bebb5ea64已补齐R3要求的raw f32生产parser不变量，三snapshot/wire预期保留；原102806一例、103110四文件41例及typecheck已亲取均exit0。R3对这条L12语义/测试边界的最小修订条件解除，**可合限定改动**；全F4/L18 Value最终闭包仍待对应owner联合签收，主线16组不自动关闭。详见L12 ACCEPTANCE §22补证，本轮复用原回执未新增业务测试。

**最新C2限时R12-08意见（2026-11-05）**：0442f61e6/40e4b150b中三处getStatus期望改为serde最短值正确，内部percent:number与snapshot nullable分离正确；原Node30文件286测试及typecheck已亲取均exit0。现有测试缺raw parser f32不变量，已要求仅补三原输入raw值及1e40→Infinity、保现有wire最短/null预期。建议该最小补测后可合限定闭包，不扩大到全F4/L18 Value或整R12，详见L12 §22；本轮未新增测试任务。

## 当前复核阶段交付：已完成（2026-11-05）

R3原始独立审读及截至本节的C2定向复验均已交付，四份授权报告已进入main；收尾基线3f794390c（较915b4b993仅更新C2协调日志），工作树无独立实现改动、无尚未处理的复核请求。最后实质审计提交ed18f6d7c已获四项正式selfgate通过（base50269f70d）。本次仅在授权汇总记录阶段收尾，不修改权限外LANE.md。

**此完成状态仅指R3当前审读交付，不是被审插件B通过，也不关闭实现方待办。** 当前未决仍为：

| 范围 | 验收结论 | 未决组 | 后续复验触发条件 |
|---|---|---:|---|
| L11-vfs-repos | 不通过 | 1 | R11-07同源B12-16由授权owner修复，保真实命令正号/普通数对照 |
| L12-vfs-index | 不通过 | 8 | 已验候选正常main集成或新的固定修复闭包；reader/wire、单写者、OCR共享许可等保持各自边界 |
| L13b-vfs-handlers | 不通过 | 2 | 附件配置真实消费及worker线程/事件/维护语义补齐 |
| vfs补审归档 | 不通过 | 5 | 原对应所有权、完整性、日志、运行时、测试问题提供修复证据 |

标准v2的生产接线、单写者、数据边界、日志/错误、测试真实性、完整性、运行时及修复闭环均在各ACCEPTANCE逐项留有结论；未决项不因阶段收尾或机械门禁通过改勾。两个旧KB审批已由C2正式批准并由L12精确应用，不扩张到活跃维护路径。

全部已验小集及原失败保留各自SHA/job/退出码；当前无新的目标实现变化，不为自动续派重复运行旧业务集合。后续由协调者提供上述修复的正式main或指定固定组合再启动相应复验。收尾文档提交的门禁结果以共享`.oc-runs/selfgate/R3-review-vfs.json`绑定的tip/base为准；只有该自检通过后才结束本阶段。

**最新C2 Lance-disabled限定签收（2026-11-05）**：固定d77bd5dbd，独立审读生产生命周期/batch/单资源OCR后二次同步，复用原075942 Electron43通过及Node对应新例实际通过的完整回执；本轮没有新测试任务。只确认R12-01该候选子项，Node原283/3/exit1与L13 nullable typecheck exit2均保留，16组主线未决不变，详见L12 §21。

**新增主线R11-07（2026-11-05，同L12 B12-16）**：真实kernel配置命令独立复现合法chunk_size="+16"后错误接受overlap="16"，普通"16"为正确拒绝对照，作业`20261105060922-2be279`含严格断言。归L11跨字段i32读取缺陷单计一次；当前未决 **1/8/2/5=16组**。旧15组记录均为此前基线，不重开已签R11-01–06，详见L11 §12及本页新增节。

**最新R12-06 primary恢复候选（2026-11-05）**：ca2ac9d5d的retryable×discard-failure四分支独立通过，`20261105052749-1f0863`为4passed/33过滤、exit0、无Errors，确认恢复marker失败、日志及错误合并优先级；仅候选子项，15组主线未决保持。另两旧KB审批e4680aa8a已main，已通知L12应用精确批准，R3未代改去向或重跑旧测试。

**最新R12-06 marker候选（2026-11-05）**：固定9888d2148的primary/additional indexing标记失败两例经本人`20261105050113-cc676f`通过，2passed/31过滤、exit0、无Errors；确认Rust两类错误策略没有被统一吞错。仅子项候选通过，main15组未决保持，见L12 §19。

**最新R12-05账本候选（2026-11-05）**：a7cf18fbf撤回两条旧KB ported声明，候选77ported/2pending，测试/断言保留、未自行obsolete。独立Rust引用核查支持限定退役申请，仍交C2批准；活跃维度helper改接一例本人`20261105043638-b9fe1a`通过，exit0。主线15组未决不变，见L12 §18。

**最新R12-03.config-copy候选（2026-11-05）**：固定99da3ecec移除L12本地配置写入/validator副本，测试改走真实L11且原十条错误文案/成功读回断言保留；本人`20261105041644-ae0fe8`为1通过/30过滤、exit0、无Errors。只确认该候选所有权子项，主线15组不变，详见L12 §17。

**最新C2 settings-owner小集补齐（2026-11-05）**：同c28e272d4固定闭包，复用原精确WARN/read-failure两例，新增`20261105040042-379c36`四例独立通过（4passed/15过滤、exit0、无Errors）。C2指定六条现均有固定候选证据；R12-03仅该子项候选通过，main15组及两wire不连带关闭，详见L12 §16末。

**最新settings-owner红项闭环（2026-11-05，候选c28e272d4）**：原WARN观察失败与新增settings读失败默认值两例独立通过，`20261105035112-044faf`为2passed/17过滤、exit0、无Errors。已确认默认buffer阈值过滤WARN，修正使用显式exporter并加强精确文案断言；旧exit1保留。候选未main，主线15组不变，详见L12 §16。

**最新settings-owner探索（2026-11-05）**：新R12-03五用例`20261105032744-2c0383`为4通过/1失败、13过滤、exit1。失败为时间戳写回失败后的WARN观察，不是RPC；执行时五实现尚为WIP，后保存ddae869ff，暂不作候选签收。原15组不变，详情见L12 §15；已回派owner，未将四通过写成门禁通过。

**最新R12-06候选子项（2026-11-05）**：本人`20261105024831-a11588`对additional-unit的InvalidState/普通Other两分支独立复验，**2通过/29过滤、exit0、无Errors**。真实SQLite触发器造成状态写失败，原错误/警告/后续Unit语义保留；候选尚非main，原15组不变，见L12 §14。新main依赖合并bad0ecb3b的官方gate仅自动选择typecheck/boundaries两项通过，不称本轮目录全量已跑。

**最新C2限定5+1签收（2026-11-05）**：同61a2e77c4实现闭包，本人`20261105020149-da37c7`为OCR临时文件5例＋真实F7媒体写链1例，**2文件6通过、exit0、无Errors**。MIME helper接线/清理/持久化与Linux真实Lance primary/additional metadata及i64写链候选子项通过；未main、共享ocr_semaphore/完整LLM/三平台均不连带签收。主线15组未决保持，详见L12 §13及下方增量。

**当前官方门禁恢复通过（2026-11-05，8b64579f7 / main f2d5b6c46）**：按自动续派要求运行的四项自检全部通过，底层`20261105014711-29788f`为48文件/425测试通过、242.68s、exit0，无Errors/unhandled errors。上轮onTaskUpdate超时保留为历史，本轮未复现；未改测试/runner，也不声称已查明超时根因。

**最新候选联合复核（2026-11-05）**：固定L12代码树61a2e77c4（含363f3f72d/939686562，以及9006bc168+5aaf3bc8a），本人`20261105014804-945753` **6通过/13过滤、exit0、无Errors**。R12-02.owner-error三例、R12-09公开text/mm精确写链三例候选通过；main f2d5b6c46尚未集成消费者，主线15组未决不变。两wire及F7原生组合不连带关；原RPC失败门禁保留，当前提交的正式自检另行执行。

**上轮门禁未通过（2026-11-05，历史add6760a1 / main f2d5b6c46）**：自动续派合并main后，官方门禁仅tests失败。底层作业`20261105013210-770d56`为 **48文件/425测试通过，但Errors 1、exit1**，错误是Vitest worker `onTaskUpdate` RPC超时。当时不能沿用旧711全绿宣布新tip门禁通过；该运行验证阻塞单列，不推断业务断言失败、不重开已签R11-04。后续恢复通过见页首，原失败记录保留。

**本轮R12-02增量（2026-11-05）**：同id/model的五个transport字段变化在真实索引入口均能被发现；真实L02默认优先级/回退写回所测场景通过。新确认原组剩余 **R12-02.owner-error**：无配置时L12拼接AppError JSON而非Rust Display message。作业`20261105011329-b19913`为校验通过；`20261105011609-a4c169`为反例观察成功（均exit0，含义不同）。未决总数仍15，详见L12 ACCEPTANCE §11及本页文末增量。

**最新官方门禁闭环（2026-11-05）**：84c0847a7 / main a9683a43b自检四项全通过，底层测试`20261105004018-600c88`为 **81文件/711测试通过、exit0、无Errors/unhandled errors**。原embedding双Host集成阻塞解除；按C2最新指令直接复用，不重跑已覆盖用例。语义未决仍 **0/8/2/5=15组**，R12-09及wire缺口不连带签收。另按指令仅验证同提交受影响的L13 attachment/retrieval两个文件。

**自动续派增量（2026-11-05，main a9683a43b）**：已合并双Host夹具修复，原两组readiness断言未改变，正式自检在执行。另亲跑真实L12公开服务/kernel最小故障断言`20261105004229-9531a3` exit0，**R12-07原open/scan失败策略及null样本差异关闭**；当前原编号未决 **0/8/2/5=15组**。下方710通过/1失败为修复前历史结果，不能抹除；修复后全绿须以新作业为准。

**Linux续作（2026-11-05）**：从71e6e8a2b恢复，读取既有结论及三个目录的LANE/SPEC/TESTMAP/BLOCKERS后，`git merge --no-edit main`快进到 **e9df01a3ce3bcb35c5e7ce3e642f807690e63a66**。R11-05在旧会话已正式签收，继续有效；此次确认513aac879已main。generation仅9006bc168 owner修复已main，5aaf3bc8a消费者尚未main，不能关闭R12-09。当前原编号未决仍 **0/9/2/5=16组**，不重新审计已完成的抽查。详见下方“Linux续作”节。

**Linux修复前门禁（历史）**：类型/边界/导入/wiring通过；三个目录测试 **710通过、1失败，exit1**。当时L13b embedding readiness双Host装配触发F3/L10全局journal Slot冲突，已附调用链并回C2；现由上述711全绿证据解除，不把历史710通过写成当时门禁通过。此集成验证阻塞未混入原语义组计数。

**最新R11-05主线闭环（2026-11-05）**：固定main fd925aa05（含F3 80dcc5291），本人20261104163651-79f860真实维护/写入/搜索/WARN断言脚本exit0。main条件注册已实际接入，虽513去探测提交仍未main，原R11-05语义缺口已独立闭合。原R11编号未决0；总未决 **0/9/2/5=16组**。L11全域v2仍受跨lane R12-09等影响，不把原R11清零称为整个插件等价完成。

**最新L13主线闭环（2026-11-05，main677f6727c）**：正常main最小作业20261104161153-83f634为23通过/110过滤、exit0、无Errors。**R13v-05正式关闭**；创建/lease/folder级联/删除委托、校验WARN及路径测试等明确子项主线通过，其余整组保持未决。当前L11/L12/L13b/vfs未决为 **1/9/2/5，共17组**。下方原vfs ACCEPTANCE全文为历史归档，当前状态以本轮主线表为准，不再按旧main缺删除注册重复派修。

**最新R12-08候选复核**：26b85c095的共享精确解码子链本人9例通过，但真实IPC暴露 **R12-08.wire-percent**：percent=1e40的Rust f32序列化形状为null，服务已保留，debug成功响应契约却拒绝。服务通过不等于wire通过，已回L12/C2协调F5；未决仍18组（1/9/2/6），见L12 ACCEPTANCE §8。

**最新标准自检与R11-04闭环**：7e4c9848f / main bec9c35ba自检四项通过；原始tests作业20261104140723-05a526为77文件/656测试通过、exit0、无Errors，其中L11全目录32文件/257测试通过。R11-04完整独立证据缺口正式关闭；当前主线未决L11 **1** / L12 **9** / L13b **2** / vfs **6**，共18组。R11-05仍候选通过待main；测试全绿不等于全部语义验收通过。

**最新正常main闭环（bec9c35ba）**：L13b旧11失败的修复已集成，18例最小独立复验通过（20261104140133-86dbcd，exit0，无Errors）。R13-03/06正式main签收；R13-01.path-file与cache-vector文件阶段子项闭合，附件配置/R13-02线程消费仍未决，组级数量不变。此前失败和候选未入main叙述保留为历史。

**提交范围修正**：依最新集成门禁限制，撤销本分支新增的`host/plugins/vfs/ACCEPTANCE.md`路径，全文迁入本报告[补审归档](#vfs-audit-archive)。原文件仅有本审计提交，main不存在该文件；finding、20条命令抽查、16条TESTMAP对照及全部候选/失败证据均保留。历史“新增文件获授权”是当时指令记录，当前提交范围以最新门禁为准。此迁移不改变任何验收结论。

**最新v2主线闭环与vfs补审**：固定main **eeaf5bdc7**（合并到审计树57b8270c6）。R11-01真实F4身份组合、R11-06两对照正式主线签收；L12 owner fallback局部移除确认但R12-03未闭，大generation写链新增 **R12-09**；新增vfs六组 **R13v-01–06**。当前未决L11 **2** / L12 **9** / L13b **2** / vfs **6**，合计19组。L13b门禁8失败已准确定位并保留exit1；没有为门禁改实现或反转测试。最新结果及边界见文末，旧各轮统计均为历史基线。

**最新 R11-06 定向轮**：b169acd4c的pragma探测容错与UPDATE错误传播对照回归通过，待集成；执行树2942073d0，本人作业 `20261104074611-07ada5` 2通过/4过滤、exit0、无Errors。当前修复分支验收未决 **L11 3 / L12 8 / L13b 2**（共13组）。身份/F3真实组合/vector消费及其余已过项不随此推进，详见文末与L11 §7。

**最新 R13-01 子项轮**：固定dea54622f，确认移除共享维护替身后的真实L11接线、路径回滚、普通cache和AI子任务事务；本人作业 `20261104072739-1c8f16` 16通过/10过滤、exit0、无Errors。R13-01仍保留附件根配置、vector文件阶段及新发现的file_路径标题差异；R13-02未闭合，03–06未重测。组级未决仍 **L11 4 / L12 8 / L13b 2**，详见文末及L13b §8。

**最新 R13-05 定向轮**：`10ffe5ba8` 剩余EOF分类/位置复核通过，待main集成；本人最小作业 `20261104064143-3b9fe2` 1通过/11过滤、exit0、无Errors。当前修复分支验收未决 **L11 4 / L12 8 / L13b 2**（共14组）；L13b仍“不通过”，未重跑原52例，L11/Q8未决事项不变。详情见文末与L13b ACCEPTANCE §7。

**最新 L11 定向轮**：修复分支 `f470e5c89`，main集成对照 `15b23540a`。作业 `20261104061643-368b45` 6文件44测试/exit0，无Errors；R11-02真实竞争分支通过待集成，R11-01身份入口及R11-04全套独立证据保留。新增候选R11-05（worker维护/日志）、R11-06（S04形状查询失败策略），当前已审修复分支未决为L11 **4** / L12 **8** / L13b **3**。详见文末；所有历史计数与结果保留各自基线。

**最新定向复核（C2 05:14）**：main政策树 `e30395712`，L13b修复分支树 `062b316fc`。R11-03按D1/D4撤销；R13-03/04/06经最小52测试复核通过，**待main集成**；R13-05仍有EOF错误分类差异。详见文末05:14更新。三个lane仍“不通过”：固定main口径3/8/6组未决；修复分支验收口径3/8/3组未决，另3组待集成。下列全量测试与原18组统计为首次审计历史。

基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`；工作树/分支：`/home/dsdev/dev/ds-mig/R3-review-vfs` / `ds-mig/R3-review-vfs`。依据 README §5.1/5.3/5.4、quality、ARCHITECTURE、IPC 契约、Rust 源码和 TS 测试正文。未编译或运行 Rust，未修改实现、测试、SPEC、TESTMAP、审批或 ledger。三个目录原无 ACCEPTANCE；本次新建独立结论。

## 首次验收汇总（历史基线）

“问题数”按每份 ACCEPTANCE 的未勾选必须修复编号计数；同一编号内相同根因的多个分支合并计数。跨 lane 的影响只在实际修复主责处计数。

| Lane | 结论 | 问题数 | 最严重的3个问题 | 亲跑测试 |
|---|---|---:|---|---|
| L11-vfs-repos | **不通过** | **4** | R11-01 翻译丢持久设备身份；R11-02 并发测试串行化；R11-03 公开API暴露SQL连接 | 188断言通过，但5个RPC超时、exit 1；单worker复跑7个RPC超时、exit 1 |
| L12-vfs-index | **不通过** | **8** | R12-01 PDF/多模态/索引阶段未实现；R12-02 丢endpoint等模型fingerprint输入；R12-03 与L11重复写表 | 14文件、146测试通过，exit 0 |
| L13b-vfs-handlers | **不通过** | **6** | R13-01 注册未接线能力且测试注入provider；R13-03 删除接到另一算法/顺序；R13-02 线程隔离测试被弱化 | 17文件、157测试通过，exit 0 |

共 **18项 B 级阻塞**：17项实现/架构/证据问题 + 1项尚未解决的运行环境验证阻塞（R11-04，不能据此认定业务实现错误）。三者都不能记为B通过。

完整逐项证据：

- [L11 ACCEPTANCE](../../../../host/plugins/vfs-repos/ACCEPTANCE.md)
- [L12 ACCEPTANCE](../../../../host/plugins/vfs-index/ACCEPTANCE.md)
- [L13b ACCEPTANCE](../../../../host/plugins/vfs-handlers/ACCEPTANCE.md)

## 抽查覆盖与边界

| Lane | 命令审读 | ported测试正文对照 | TESTMAP实际状态 | wiring |
|---|---|---:|---|---|
| L11 | 自有0条；审读15条消费方命令→仓储链 | 21条 | 158 ported | 158 / 未接入0 |
| L12 | 自有3条全部；另12条消费方命令→索引服务链 | 20条 | 79 ported | 79 / 未接入0 |
| L13b | 18条自有命令 | 23条 | 56 ported、8 pending | 56 / 未接入0 |

没有把仓储方法冒称为 `#[tauri::command]`，也没有虚报 L11/L12 有15条自有命令。L13b 目录本地映射不等于整个 `L13-vfs-api` 权威 TESTMAP 闭合。抽查通过只覆盖记录的分支，不作全仓100%严格等价声明。

三个本地 TESTMAP 都无实际 obsolete/merged 行。`migration/approvals.json:37-39` 的批准仅针对已退役 question_sync_service 的3个测试，不批准此处并发/线程测试弱化或功能省略。

## 原始运行摘要

每次运行都在指定工作树。完整输出由本会话 shell 结果保留；下列摘录不是实现者遗留的 vitest-results.json。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos
Test Files  23 passed (23)
     Tests  188 passed (188)
    Errors  5 errors
  Duration  151.35s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
REVIEW EXIT: vfs-repos 1

$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos --maxWorkers=1
Test Files  23 passed (23)
     Tests  188 passed (188)
    Errors  7 errors
  Duration  206.81s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
Exited with code 1

$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-index
Test Files  14 passed (14)
     Tests  146 passed (146)
  Duration  17.46s
REVIEW EXIT: vfs-index 0

$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers
Test Files  17 passed (17)
     Tests  157 passed (157)
  Duration  59.32s
REVIEW EXIT: vfs-handlers 0
```

首轮L11另有一次120秒工具时限中断，之后才进行以上完整运行。只为定位已发生的RPC错误追加了一次单worker复跑，未反复刷测。开工时检测到其他lane并行Vitest，当前worktree本身干净；RPC错误原因未定，不把188个assertion通过写成门禁通过。

```text
$ node scripts/electron-migration/importable.mjs host/plugins/vfs-repos/index.ts
importable: ok
$ node scripts/electron-migration/importable.mjs host/plugins/vfs-index/index.ts
importable: ok
$ node scripts/electron-migration/importable.mjs host/plugins/vfs-handlers/index.ts
importable: ok

$ node scripts/electron-migration/wiring.mjs --lane vfs-repos
合计 ported 158，其中所测模块未从 index.ts 接入 0（0.0%）
$ node scripts/electron-migration/wiring.mjs --lane vfs-index
合计 ported 79，其中所测模块未从 index.ts 接入 0（0.0%）
$ node scripts/electron-migration/wiring.mjs --lane vfs-handlers
合计 ported 56，其中所测模块未从 index.ts 接入 0（0.0%）

$ npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
Exited with code 1
```

ledger 是恢复后按用户要求追加的只读全仓检查；250个问题不能归责为本三个lane的新增错误。恢复时 `git log --oneline -20` 顶为 f23c98702，`git status` 确认当前分支且干净，未重做任何已提交实现。

## 共性问题（供协调者规范回灌）

1. **测试同名、断言通过不等于保留不变量。** L11把多线程/Barrier竞争改为顺序调用；L13b把非运行线程执行改为普通CRUD；L12测试孤立helper而非实际生产判断。回灌要求：对锁、线程、取消、事务测试明确记录原保证，不能只保留标题/返回值。证据 R11-02、R12-05、R13-02。
2. **模块可达不等于能力可用。** wiring.mjs:75-79 只要测试导入的某个模块可达就放行，无法证明具体函数被调用、可选依赖有provider或整个流程完成。L12的压缩/slot helper只被测试用；L13b harness 默认安装测试维护provider。回灌要求：ported须有实际调用点，缺依赖明确pending，不以API再导出或测试provide闭合。
3. **跨插件API只是import边界，还需要语义和写表所有权。** 初审曾将L11公开连接列为问题，**该参数型判据现按D1/D4撤销**；允许所有者业务API的连接事务接缝，不要求批量重构。L12重复写L11表仍是缺陷；L13b相似名字却不同顺序的删除服务和本地LLM副本已在修复分支定向核对（见05:14更新）。回灌要求：消费者仅传递句柄，SQL留所有者，事务顺序沿用Rust；不能在消费者复制SQL/配置算法。
4. **声明“已记录差异”不等于获批。** 缺PDF/OCR/多模态阶段、设备身份改环境变量、并发测试串行化均在某些SPEC里出现，但不是自动允许的平台差异。需要区分“已决平台差异”与“待完成缺口”；本次未采信自述完成率。
5. **错误/日志必须沿分支核对。** L12漏warn/error，L13b丢Blob/PDF步骤前缀；best-effort开表失败又被改为传播。对照应包含失败后的动作、日志级别及返回形状，不能以“一样会失败”当等价。

## 修复回派与复核条件

- L11处理 R11-01/02/03；协调者协助取得 R11-04 的干净运行结果。
- L12处理 R12-01–08；与 L11/LLM/native 提供方协作补实际api与依赖。不得把Lance未编入分支当作完整桌面功能替代。
- L13b处理 R13-01–06；与L11/L12接真实方法，补回原线程/顺序/校验/错误语义。
- 未决项全部保留 `- [ ]`。修复后需要独立复核对应源码/断言/最小相关测试才可勾选；本报告不预先批准修复，也不替实现者改代码。

## C2 定向复核更新（04:25 指令，2026-11-04）

### 基线与操作范围

- 工作树仍在本审计分支；读取新main固定SHA：`29bc10a470c9d50ed80671cfb232c0bdee972b1b`。只用 `git show/diff/grep` 对提交对象定向审阅，没有合并或覆盖实现/测试文件，没有切分支。
- 关联提供方提交：L12的 `56f3e9f1d`（该提交自身仅API一行）、其前置检查点中的实际service与test、`d0df9e65f`（空pages顺序）、`4355749d9`（unitSync日志）；L13b的 `169a4256b` 及接线测试检查点、`fdaf6ca5a`（仅报告更新）。各提交标题/报告不作为证据，按新树逐行追真入口。
- 相关Rust index_service/indexing/multimodal_service/handlers/mindmap_repo/attachment_repo在两基线间无diff。
- **本轮新增证据等级：静态源码/断言核对，不是新SHA的动态通过证明。** 没有用本工作树旧测试代替新树测试，也没有再跑R11-04全套RPC测试。原全量运行结果继续保留原基线标识。

### 子项复核结果

| 原问题组 | 新证据确认 | 仍待修复/复核 | 组级状态 |
|---|---|---|---|
| R12-01 | unitIndex真实provide，后台full-indexer已注入unitSync；多模态空pages先清理；mm batch取样/claim/失败恢复已实现 | 非空页/source/PDF/OCR等阶段仍缺；新unit输入缺旧PDF分页重提和exam canonical分支；新分支动态回归未取得 | 保留未勾选 |
| R12-03 | 新unit sync/reset/delete编排经L11 api写表；reset用IMMEDIATE；删除SQLite子阶段保持收集→purge/outbox→计数顺序 | 原index-state/embedding-dim/pdf SQL副本无diff，仍有重复写；新服务描述缺version | 保留未勾选 |
| R12-06 | unitSync成功debug、普通失败warn继续已恢复且生产callback返回数量 | clear-message error、embedding重试warn、PDF拒绝retry warn等原项仍未改；本轮无日志动态断言 | 保留未勾选 |
| R13-01 | 11条导图+3条附件命令改接真实repos；vfsUnitBuilder已有生产provider/consumer | vfsMaintenance仍无main提供方，消费者未接vfsIndexMaintenance；维护测试仍默认测试provider | 保留未勾选 |
| R13-03 | 新维护服务的SQLite阶段可供接入，且其顺序静态对齐 | 文件删除仍接旧full-indexing方法；管理删除仍查找vfsMaintenance；没有证明文件删除完整text/mm顺序的新断言 | 未修复，保留未勾选 |

真入口/断言和行号详见两份 ACCEPTANCE 的 §5。关键消费缺口：

- `29bc10a47:host/plugins/vfs-index/index.ts:188-190` 发布 **vfsIndexMaintenance**。
- `29bc10a47:host/plugins/vfs-handlers/index.ts:202-205` 仍注入 **vfsMaintenance**；`:342` 的文件删除仍调用 **indexService.indexing.deleteResourceIndex**。
- `29bc10a47:host/plugins/vfs-index/src/full-indexing.ts:669-682` 仍是 **multimodal→text→SQLite→markPending**。发布新接口并不会自动替换旧调用点。
- `29bc10a47:host/plugins/vfs-index/tests/unit-maintenance.test.ts:185-206` 只验证SQLite维护，不是文件删除端到端顺序；`host/plugins/vfs-handlers/tests/repository-wiring.test.ts:11-87` 则确实经host.invoke测真实导图/附件仓储。

### 结论与回派

| Lane | 当前结论 | 组级未决数 | 本轮动作 |
|---|---|---:|---|
| L11-vfs-repos | 不通过 | 4 | main中实现无新diff；未重跑RPC测试、未替分支接口签收 |
| L12-vfs-index | 不通过 | 8 | 确认R12-01/03/06部分子项；继续补剩余执行阶段/所有权/日志 |
| L13b-vfs-handlers | 不通过 | 6 | 确认14条命令及unitBuilder接线；需接新维护接口并恢复文件删除顺序 |

其余未修组不重新抽查/刷测、不改勾选。新增观察归入原对应问题组，未改变18组统计口径。共性规范补充：**“提供者已发布”与“消费者已切换”必须分别给入口证据；SQLite子阶段测试不能代替跨存储完整删除顺序测试。**

## C2 05:14 更新：D1/D4裁定与L13b修复分支实测

### 固定基线

- 政策及集成对照：main `e303957124ac220f55bee1b04cca5d3937983b92`，含 `d1b03dff9` 的decisions D1/D4及quality §10。
- 修复树：`ds-mig/L13b-vfs-handlers` 的 `062b316fc5060276092e7f46496cdda9f6b739a8`，包含a19f8348e及其前序实现、fa5e0ea44等检查点的增强删除断言。两条具名提交本身主要是文档，证据来自完整树实现/测试。
- `git merge-base --is-ancestor 062b316fc e30395712` exit **1**：不能把这批分支修复称为main已可用。两树llm/vfs-index/vfs-repos目录无diff，提供方能力已在该main；待集成的是L13b消费方修复。

### 结论变更

| 编号 | 独立复核结论 | 范围/剩余 |
|---|---|---|
| R11-03 | **按D1/D4撤销原参数型违规判定** | 所有者API接受/传递SqlExecutor合规；读过main vfsRepo接口/提供者，原证据未显示任意SQL通道或原始连接返回；不要求批量重构。R12直接写表不因此获豁免 |
| R13-01 | **进一步部分修复** | unitBuilder/indexMaintenance已必需注入并经真实入口测试，14导图/附件真实接线重测通过；其他vfsMaintenance业务仍待集成，测试provider不能替代生产 |
| R13-03 | **分支修复复核通过，待集成** | invoke三场景验证SQLite/outbox/计数先于Lance，text→mm，失败warn后软删，不调用旧full-indexing、不markPending；断言在invoke返回后检查，避免被best-effort catch吞掉 |
| R13-04 | **分支修复复核通过，待集成** | Unicode→前缀校验顺序恢复，四命令不触下游、批量warn并跳过 |
| R13-05 | **部分修复，保持未决** | Blob/PDF步骤前缀、结构校验、None/Some、exam默认等已恢复；截断JSON的EOF上下文仍不等价，见下 |
| R13-06 | **分支修复复核通过，待集成** | 本地配置fallback删除，真实llmEmbeddingModels委托；assignments读取/setting回写故障下仍ready的回归已过 |
| R13-02 | **保持未决** | 两个线程/runner原保证退pending是纠正账本，不是修复线程隔离 |

对应文件:行和所有者/命令链见 [L11 §5](../../../../host/plugins/vfs-repos/ACCEPTANCE.md)、[L13b §6](../../../../host/plugins/vfs-handlers/ACCEPTANCE.md)。L12仅补D1/D4解释，未扩大重审其余问题。

### 最小测试与剩余反例

命令从审计工作目录发起，以提供方工作树为只读输入，`--no-cache`；测试前status干净，测试后与固定SHA的 `host contracts vitest.host.config.ts package.json` diff为空，status干净。

```text
$ npx vitest run --root /home/dsdev/dev/ds-mig/L13b-vfs-handlers -c /home/dsdev/dev/ds-mig/L13b-vfs-handlers/vitest.host.config.ts host/plugins/vfs-handlers/tests/files.test.ts host/plugins/vfs-handlers/tests/pdf.test.ts host/plugins/vfs-handlers/tests/embedding.test.ts host/plugins/vfs-handlers/tests/index-admin.test.ts host/plugins/vfs-handlers/tests/repository-wiring.test.ts --maxWorkers=1 --no-cache
Test Files  5 passed (5)
     Tests  52 passed (52)
  Start at  13:28:46
  Duration  25.22s
```

**退出码0；原始输出无Errors汇总行、无unhandled errors**，有WASI ExperimentalWarning。分文件：files 9、pdf 11、embedding 17、index-admin 12、repository-wiring 3。不引用owner Node/Electron171的自述作为本验收结果，本轮没有亲跑Electron或L11全套。

追加只读代码/临时库探针，装真实生产插件（不装pendingMaintenanceProvider）并经 `host.invoke('vfs_get_pdf_page_image', ...)`：

```text
preview_json = {"pages":
TS error = 解析 preview_json 失败: EOF while parsing an object at line 1 column 9
Rust expected = 解析 preview_json 失败: EOF while parsing a value at line 1 column 9
```

同类 `{"pages":[],"renderDpi":` 在列24也把value误判object；`{"pages":[]` 则应为object。`062b316fc:host/plugins/vfs-handlers/src/pdf-preview.ts:99-102` 用根首字符推断EOF类别，不能保留字段解析位置。Rust证据：handlers.rs:3030-3031、Cargo.lock:11347-11349锁定serde_json1.0.149及该版本de.rs:2027-2033、1737-1745、323-327。未运行Rust。Node探针exit0只是观察脚本成功，**不是等价测试通过**；R13-05继续回派精确错误分类。

### 当前统计口径

| Lane | 结论 | main固定树未决组 | 修复分支验收后未决组 | 已复核待集成 |
|---|---|---:|---:|---|
| L11-vfs-repos | 不通过 | 3 | 3 | 无；R11-03是裁定撤销 |
| L12-vfs-index | 不通过 | 8 | 8 | 本轮未扩大复核 |
| L13b-vfs-handlers | 不通过 | 6 | 3 | R13-03/04/06 |

首次18组中1组按裁定撤销，3组仅在修复分支确认；固定main仍17组未决，分支验收剩14组。未为未修改的R11-04重复刷测试；只修改四个授权审计文件，未修改或合并实现文件。

## L11 3d003c3cc / Q8 / worker 候选定向复核（2026-11-04）

### 固定提交与范围

读取 `f470e5c89d0a144964afd11f302899226b27ab36` 完整树（含3d003c3cc、36a41507d和前序检查点），main对照 `15b23540a97ee19e1391859c3bc140e5c0daa182`。ancestor检查exit1，候选不算main可用。3d003c3cc到f470e5c89间，本轮翻译/竞争/S04实现与测试文件无diff。后续若提供方再改worker屏障不自动纳入本轮。

只改审计文档。提供方测试输入目录有既存migration/LEDGER.md、ledger.json生成改动，未触碰；被测host/contracts/config/package与固定SHA无diff。遵守全局队列规则，未直接跑vitest/tsc/build，未编译或执行Rust，未重跑L13b52例或L11全套。

| 项目 | 结论 | 关键证据 |
|---|---|---|
| R11-01 | 部分修复，保留未决 | index必需paths、await后注入TranslationRepo；新测试验证注入ID写入translation/folder_items。但实际paths.deviceId仍旧root优先，Rust translation底层get_device_id是env→primary→legacy；等F4正确入口，不要求L11复制 |
| R11-02 | 修复分支复核通过，待集成 | 10个ResourceRepo/2个QuestionRepo独立worker+独立连接；全部ready后Atomics起跑；原唯一isNew/一胜一QBANK_CONFLICT断言保留且亲跑成功 |
| R11-03 | 裁定撤销维持 | D1/D4允许业务事务连接传递；新增S04/Q8是业务方法，不因SqlExecutor本身判违规 |
| R11-04 | 保留全套独立证据待补 | 模板一次迁移且dispose、每测试独立副本；本人最小44例无RPC。25文件207/exit0是owner 3d003c3cc报告，不冒称本人全套结果或新增Q8后全套通过 |
| S04计数/echo | 正常路径、精确边界通过，应用集成未签收 | safeIntegers bigint preLogMax；2^53+1既有log保持未同步，新todo echo才标记；计数/NULL/软删todo/幂等4例通过；未见固定树sync apply生产调用 |
| **R11-05（新增）** | worker维护/日志缺陷 | 主storage进入维护后worker仍返回[]；entry直接new SqliteDatabase，不受handles管控；未setRepositoryLogger/无日志消息，主线程sink不会跨线程 |
| **R11-06（新增）** | S04库形状探测错误策略不等价 | tableHasColumn的pragma查询失败直接抛；Rust table_has_column失败返回false并跳过。只恢复该容错，不能吞业务UPDATE失败 |
| Q8 | 仅确认发布/表所有权方向，不代签业务链 | 新metadata/group/reparse/verdict/reset SQL在L11，有限业务参数、无任意SQL通道；mastery/FSRS与提交后日志仍归消费编排；本轮读了rollback测试，未新增Q8动态通过声明 |
| R13-02 | 保持未决 | 真worker线程4例过，不等于维护/日志保证过，也未证明L13b命令已接该worker |

详细文件:行及Rust对照见 [L11 §6](../../../../host/plugins/vfs-repos/ACCEPTANCE.md)。worker维护参照 `src-tauri/crates/dstu-vfs/src/vfs/database.rs:159-215,283-358`；S04参照 `src-tauri/crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs:58-145` 与 `sync/mod.rs:8147-8159`。未改D8 partialObsolete或不在本轮范围的映射。

### 队列原始摘要与退出码

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L11-vfs-repos -c /home/dsdev/dev/ds-mig/L11-vfs-repos/vitest.host.config.ts host/plugins/vfs-repos/tests/resources.test.ts host/plugins/vfs-repos/tests/questions.test.ts host/plugins/vfs-repos/tests/translations.test.ts host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts host/plugins/vfs-repos/tests/pomodoros.test.ts host/plugins/vfs-repos/tests/worker-service.test.ts --maxWorkers=1 --no-cache
job.mjs result 20261104061643-368b45 --tail 400
 Test Files  6 passed (6)
      Tests  44 passed (44)
   Start at  14:16:45
   Duration  20.20s
[作业 20261104061643-368b45] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061643-368b45.log
```

原输出无Errors汇总行、无unhandled errors/RPC超时。没有把owner报告里的207条当成本人复验。

生产service反例探针同样走队列。首个作业 `20261104062218-6ac31c` **exit1**：审计脚本 `--input-type=module` 被Worker继承导致 `ERR_INPUT_TYPE_NOT_ALLOWED`，是探针启动参数问题，未得到产品行为结论。只改探针启动参数再提交（没有重跑44例）：

```text
job.mjs result 20261104062453-7c158d --tail 160
main_handle=Database vfs is in maintenance mode
worker_during_maintenance=[]
schema_probe_error=schema probe failure
[作业 20261104062453-7c158d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062453-7c158d.log
```

探针临时库安装真实L11插件。第一项是正常维护拒绝，第二项证明worker绕过同一维护屏障；第三项是在真实公开S04方法的SqlExecutor查询接口注入schema故障后观察错误传播。exit0只表示观察脚本成功，**不表示等价通过**。

### 回派与统计

- L11/F4：保留R11-01，改消费正确底层身份入口；无需复制平台算法。
- L11/F3：R11-05补共享维护准入/排空/连接释放恢复及worker日志回传；L13b R13-02不能据线程测试单独关闭。
- L11：R11-06保留原pragma失败→false；S04应用边界等L20实际接入后复核事务/错误映射。
- R11-02分支已通过；R11-04本人仅小集通过、全套独立证据待补，不再反复刷RPC全套。
- 沿用18个原组：撤销R11-03、分支确认R11-02及R13-03/04/06，剩13个原组；另新增候选R11-05/06，共 **15个分支验收未决组**（L11 4、L12 8、L13b 3）。新增项不反向描述成首次main缺陷，也不据分支通过推进main B。三个lane仍不通过。

## R13-05 EOF 剩余项闭合（2026-11-04）

- 修复来源固定 `10ffe5ba89024da238ec941b384d281f797776da`；实现/测试位于前置检查点 `0e6614b14`，具名提交只补报告。
- 本人运行基线固定 `00a2c54f6113e8705c6f7c60e0a3b0b9e770285b`。平台settings等上游曾更新，但所审PDF实现、测试、harness、index及Rust/Cargo.lock/kernel command路径与修复树无diff；没有把后续完整树运行伪称为旧树运行。
- main对照 `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`；10ffe5ba8与00a2c54f6均非其祖先（exit1）。结论为**修复分支通过、待集成**，不是main已可用。
- `host/plugins/vfs-handlers/src/pdf-preview.ts:97-151` 改按当前token/嵌套容器判断EOF；`:72-74` 按末行UTF-8字节输出列号。已对照锁定serde_json1.0.149的de.rs:323-327,1741-1745,1941-1957,1991-2013,2027-2033，以及read.rs:421-429，未编译/执行Rust。
- `tests/pdf.test.ts:169-196` 经真实注册命令invoke、真实临时file/exam和持久preview_json，固定断言12个PDF样本与1个exam前缀。三条原反例现在分别value列9、value列24、object列11；还验证中文/换行/尾换行0列、嵌套、部分scalar和string，未stub被测算法或反转原断言。

本人新提交作业只选新增EOF用例：

```text
job.mjs result 20261104064143-3b9fe2 --tail 180
 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
   Start at  14:41:44
   Duration  14.34s
[作业 20261104064143-3b9fe2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064143-3b9fe2.log
```

原输出无Errors汇总行、无unhandled errors；有WASI警告。11个未执行是`-t`过滤，未改任何测试文件。完整submit命令见L13b §7。

亦直接读取他方发起的job result：Node **20261104061303-8b0f39**：1文件12通过、21.65s、**退出码0**；Electron **20261104061303-a752e9**：1文件12通过、20.85s、**退出码0**。两份原输出均无Errors汇总行/无unhandled errors，有WASI警告；作为补充结果，不冒称本人另跑Node/Electron全文件，也不从未记录SHA的日志推断快照身份。

R13-05勾选为分支通过。当前L13b未决R13-01/02，其余已签收项不重复测试；L11 R11-01/04/05/06及Q8消费边界、L12八组保持既有状态。原18组撤销1组、修复分支确认5组，剩12原组，加2新增候选，共14分支未决组。三个lane仍不通过；本轮只更新L13b ACCEPTANCE及本汇总。

## dea54622f：R13-01维护接线定向复核（2026-11-04）

### 固定证据与结论

修复树 `dea54622fc9ff749c80acc65007460ccc6b763ee`，执行树 `1bb65a4bc0aa824dc02fed298df9d629dd03d354`；两树vfs-handlers/vfs-repos/vfs-index、paths/storage、contracts及配置无diff。运行期间仅提供方报告文档变化，未把未提交实现混入复验。main固定 `679fd3e4d3bdaff9d38188aab851704e952b9ac0`：L11提供方index/api/maintenance实现与修复树相同，**provider已在main**；dea54622f仍非main祖先（exit1），消费者新接线按分支验收。

| 子项 | 独立确认 | 保留边界 |
|---|---|---|
| 真实维护provider | L13b index:198-201必需注入vfsMaintenance，合同直接引用L11 api；harness:58-65仅真实paths/生产插件，pending-maintenance-provider及交接写SQL删除 | 八方法可调用不等于全部分支严格等价 |
| 路径缓存/事务 | 真invoke验证缓存、UTF-8长度、子树移动；第二条UPDATE触发器失败后整个子树回滚，故障移除后写入成功 | 新发现file_标题分支不同于Rust，见下 |
| cache普通分支 | preview/压缩/OCR经真实owner，ref/大小计数、相同compressed/original不减ref、readyModes按类型剔除、OCR来源回退与pending | vector文件删除/计数阶段仍缺；不按末尾相同缺列错误签收 |
| AI子任务事务 | LLM仅为外部输入替身；持久化是真L11 SAVEPOINT；第二条INSERT失败返回VFS_STORAGE、全部回滚、无事件；成功后两子任务及create事件 | 未凭该测试签收在线LLM或线程保证 |
| TESTMAP | 本地63ported/2pending/3obsolete；三路径现经生产命令 | 前缀用例现有错误期望需修；两blocking测试仍pending，不因此推进B |

### R13-01剩余子项

1. **附件根配置**：独立vfsAttachmentConfig三方法仍无生产提供方，仅附件测试显式安装测试配置provider；共享harness不再掩盖缺口。
2. **cache vector**：Rust handlers.rs:7161-7178先统计/删除lance/vfs目录、失败warn后继续、成功累加结果；L11 maintenance.ts:399-413直接从SQLite删除开始，消费clear也只委托。保留未决，原vector_indexed_at缺列不能抹掉中间磁盘副作用。
3. **R13-01.path-file（本轮新发现，L11所有者修复）**：maintenance.ts:215-218额外把file_视同tb_读取file_name；Rust handlers.rs:1259-1303对file_应回退source_id。paths.test.ts:68-69用生成file_ ID的真实textbook断言`/教材.pdf`，该绿测固定了非等价行为。恢复Rust `/file_<id>`；这不是要求修Rust的旧限制。作为既有R13-01路径子项回派，不另在L11重复计组。

### 队列结果

本人仅提交路径/cache/AI相关最小集，未重跑已闭03–06：

```text
job.mjs result 20261104072739-1c8f16 --tail 160
 ✓ host/plugins/vfs-handlers/tests/todo.test.ts (12 tests | 10 skipped)
 ✓ host/plugins/vfs-handlers/tests/media-cache.test.ts (6 tests)
 ✓ host/plugins/vfs-handlers/tests/paths.test.ts (8 tests)
 Test Files  3 passed (3)
      Tests  16 passed | 10 skipped (26)
   Start at  15:27:41
   Duration  30.16s
[作业 20261104072739-1c8f16] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104072739-1c8f16.log
```

原输出无Errors汇总行/无unhandled errors，10未执行为`-t`过滤。完整submit命令、生产入口/断言/Rust行号见L13b ACCEPTANCE §8。

还直接读取他方已完成作业：Node `20261104065517-40f060` **48passed/exit0**、Node新增回滚 `20261104065904-a00652` **12passed/exit0**、Electron `20261104065904-ba478c` **49passed/exit0**，原结果均无Errors汇总行/无unhandled errors。只作为补充运行证据，不冒称本人全套/重复执行，也不靠无SHA日志推定执行快照。

### 其他范围

L12 `675eb70ff` 新summary/PDF重提/MediaTranscriber仅登记候选提供状态（提交自身是segment counts增补），owner重复写表/exam近似及其余原项未签收，不加L12新测试。R13-02的真实worker维护/logger组合仍待闭合；L11既有R11-01/04/05/06及Q8边界不在本轮重测。组级计数不变，R13-01只确认部分子项，三个lane仍不通过。

## R11-06 定向闭合（2026-11-04）

修复来源固定 `b169acd4c82e25481f77296af60396ec6151c65d`，报告dcb5bd406/918b252fd只作定位；本人执行树 `2942073d0c7a1556756aeef5b50b1b0763e85f6d`。目标pomodoros仓储/回归测试/schema模板/storage/contracts/config与修复树无diff；启动身份接线等后续变化明确不纳入该编号签收。main对照 `679fd3e4d3bdaff9d38188aab851704e952b9ac0`，两树均非main祖先（exit1），只确认分支修复待集成。

确认的行为：

- `repository/pomodoros.ts:83-90,387-394`：仅pragma形状查询失败→false→跳过，和Rust `sync/mod.rs:8147-8159`、`pomodoro_counts.rs:91-97`一致。
- `:403-412` 重算/清零UPDATE各自catch后仍抛 `VFS_STORAGE` 及独立步骤文案，和Rust `pomodoro_counts.rs:115-117,130-132`相符；没有扩大吞错范围。
- `tests/sync-pomodoro-counts.test.ts:190-216` 从真实插件ctx.vfsRepo.pomodoros驱动Proxy执行器故障，探测失败后计数7保持；两种业务UPDATE失败分别断言code/步骤message。测试没有替换被测业务算法。

```text
job.mjs result 20261104074611-07ada5 --tail 180
 ✓ host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts (6 tests | 4 skipped)
 Test Files  1 passed (1)
      Tests  2 passed | 4 skipped (6)
   Start at  15:46:14
   Duration  19.98s
[作业 20261104074611-07ada5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074611-07ada5.log
```

原输出无Errors汇总行/无unhandled errors；4条为`-t`过滤，非修改测试skip。完整submit命令见L11 §7。未重跑R11-02竞争集、全套RPC或未改的其他用例。

R11-06标分支复核通过待集成。R11-01保留：虽然执行树2942073d0已删除旧deviceId fallback，本轮不测试/签收真实F4组合；R11-05需真实F3纳管而非registry替身；pre-vector callback需消费者invoke；Q8/S04应用链的事务/错误边界仍按前述限定。未扩大任何其他编号验收范围。

统计：12个原组未决，加新增R11-05未决；新增R11-06现分支通过，故共13个分支未决（3/8/2）。三个lane仍“不通过”，main等级不因候选分支通过自动推进。

## v2：正常main复验与vfs新增覆盖（2026-11-04）

### 同步与审计范围

中断恢复按要求执行git log/status及ledger；恢复前b5935c18e干净，旧基线ledger全仓250测试问题exit1，不能归责新候选。按用户指令合并固定main **eeaf5bdc7ae95a336c34b3a75b19f844726fe064**，得到57b8270c6，无冲突；导入的实现是上游提交，本人未编辑实现/测试。合并后ledger只读检查exit0：

```text
ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

standard-v2 §1/2优先，D1/D3/D4仍适用。新增vfs验收文件由架构师补审分工/C2授权；其余编辑仍限本lane原四份审计文档。C2确认指定L12提交已main，故最终证据改用该主线代码，不停留候选分支。

### 结果汇总

| Lane/编号 | 本轮结论 | 最重要证据/剩余 |
|---|---|---|
| L11 R11-01 | **main正式签收** | 真实F4 createPaths＋真实L11 plugin/translation SQL；env优先、primary优先、legacy规范化迁移、初始化后env改变不换仓储身份，作业492b05 exit0 |
| L11 R11-06 | **main正式签收** | 正常main公开service两条探测容错/UPDATE错误对照，49fed5 2通过exit0；无全套重刷 |
| L12 R12-03 | 部分修复，保持未决 | PDF/multimodal不再本地fallback，但unit/segment/resource直接写仍在；WeakMap绑定db无法自然传至transaction Scope |
| L12 D3 → R12-09 | **新增必须修复** | next generation safeIntegers后Number回转；segment普通查询回写丢精度。main实际观察2^53+1被舍入，见L12§6 |
| L12 OCR子项 | 保持未决 | 原条件UPDATE不改updated_at且原子，现缺精确owner就静默跳过；recording-owner绿测不能证明真实SQL/并发/日志 |
| L13b R13-01/06组合 | 门禁失败准确回派 | paths错误期望1例；LLM新依赖缺失7例；没有恢复错误实现或stub模型逻辑使其通过 |
| 新vfs | **不通过，6组** | ≥15命令（20条）、16ported正文及额外1条字面量核对；单写者/缺删除入口/日志/阻塞/版本省略/测试账本问题，见独立ACCEPTANCE |

L11 R11-04/05、L12其他既有组未随新接口顺带关闭；F3图片策略/F7 vector真实组合和R12-08解码修复仍独立待验。上游L11 getLiveResource/resetRebuildableIndex存在不代签L16/L21消费链。

### 本人队列作业：精确退出状态

| job ID | 检查/最小范围 | 原结果摘要 | exit / Errors |
|---|---|---|---|
| `20261104105931-ea5d18` | npm run typecheck:host | tsc无错误 | 0 |
| `20261104105931-12f575` | npm run migration:boundaries | 2382文件、0 violations、178 suppressed | 0 |
| `20261104105931-49fed5` | R11-06两测试 | 1文件、2passed/4过滤，16.05s | 0，无Errors |
| `20261104110620-492b05` | 真实F4/L11身份三场景node断言 | env/primary/legacy write/cache PASS，legacy迁移日志 | 0，无未处理异常；非Vitest |
| `20261104105931-0aa514` | 原门禁点unit-maintenance | 1文件11passed，21.97s | 0，无Errors；未复现旧9失败 |
| `20261104111143-638e4a` | L12 owner/generation/i32最小集 | 3文件11passed/18过滤，6.48s | 0，无Errors |
| `20261104111425-0a593d` | generation生产store/segment探针 | next expected=9007199254740993 actual=9007199254740992 type=number；segment=9007199254740992 | 0代表观察脚本完成，**不等价** |
| `20261104110705-6def19` | 新补审vfs本目录一次 | 12文件187passed，33.85s | 0，无Errors |
| `20261104111754-3096fa` | 新门禁paths/embedding | 2文件失败、8failed/17passed，28.14s | **1**，无单独Errors行但真实失败 |

以上均已读取job.mjs result原退出码；完整log在`/home/dsdev/.oc-jobs/done/<job ID>.log`。过滤未执行不是改skip。恢复后未重复提交已有job；提供方早期20261104085738-0f3ce3处于变动树仅作参考，不用它证明冻结快照。各ACCEPTANCE保留完整命令/摘要。

门禁8失败关键原文：

```text
PluginLifecycleError: plugin "dstu.llm" did not start: required services not available: "injectionBudget", "llmCodexAuth"
（embedding.test.ts共7条）
paths.test.ts:69 Expected: "/教材.pdf" Received: "/file_YADRs0Vl_m"
Test Files  2 failed (2)
     Tests  8 failed | 17 passed (25)
[作业 20261104111754-3096fa] 退出码 1
```

实际file_返回ID已是Rust正确语义，修测试时须写Rust对应证据，不改回错误标题。嵌入测试装配真实新提供方，不替换本lane业务主体。此轮没有权限代修测试，回派L13b维护。

### vfs补审finding ID与主线/分支区分

新报告原路径为`host/plugins/vfs/ACCEPTANCE.md`，现完整收录于本页[补审归档](#vfs-audit-archive)。六组：R13v-01单写者，02缺命令/完整性，03日志/错误，04阻塞/流式媒体分支，05导图版本，06测试真实性/账本。下文历史“vfs ACCEPTANCE”均指该归档。

确认L13请求的微单元ID为 **R13v-01.notes** / **R13v-01.mindmap**：X6 `create.ts:171 notes/:175 resources`与本审计同源，按一个组去重。L13通知f4a22b3a6/8755b9a3a/341201bf6已候选委托notes及build_path修复，本固定main仍旧实现；仅记录候选存在，不据“7例通过”自述签收。等待带ID提交/main和真实kernel事务故障断言。L13大量注册/WIP或“retrieval26过”不代替该单元精确SHA/job证据。

当前未决表：L11 2，L12 9（新增generation），L13b 2，vfs 6，共19组；四个插件均不通过。首次A/B ledger数字仅机械结果，不覆盖这些未决问题。

### 追加两个L13候选微单元（不改变组级数量）

固定修复树e9f0fc2a1（含e43715ca8/341201bf6/90d40c0ac），执行树abcf9501a；本轮main对照4c6cd1ba8未含该候选。相关实现和测试相同，无未提交实现混入。

- **R13v-01.notes/mindmap**：确认create两个notes方法早已在候选委托L10，不按旧main INSERT样例再次派；mindmap两方法现在委托L11同conn，真实kernel成员trigger失败后resource/mindmap/成员整体回滚、无created，重试成功后写入及事件恢复。
- **L13-BUILD-PATH-01**：根分支不获取DB、Some才调用owner，resourceId原样拼接、入口/结果info静态对应；真实invoke连接故障与非法参数分支通过。
- **不关闭整组**：其他写表/日志/删除路径未随这两小单元获批，owner导图创建info/debug仍待L11；41a804a2c delete新候选和其6通过报告仅登记待审。

```text
job.mjs result 20261104113555-f55ba4 --tail 140
Test Files  2 passed (2)
     Tests  4 passed | 10 skipped (14)
  Duration  34.31s
[作业 20261104113555-f55ba4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104113555-f55ba4.log
```

原输出无Errors/unhandled errors；10个为-t过滤。详细入口/Rust行号与submit命令见vfs ACCEPTANCE末节。没有运行整目录或把候选修复宣布成main可用；19组未决数量不变。

### 追加390e23572：删除owner/WARN确认与batch反例

固定候选 **390e23572c9cd09bac23537ce585701cd925e4f0**，main对照4c6cd1ba8未包含；实现链41a804a2c/abcf9501a/390e23572。相关删除/媒体代码与测试无未提交diff；提供方随后新增的update/paths/SPEC改动不纳入此结论。

- **候选局部通过**：delete.ts已无foreign SQL并同conn委托L10/L11；真实单删除及translation/mindmap批量保存点回滚通过。候选已有dstu_delete入口，旧main缺入口结论不直接套用到此分支。
- **WARN候选通过**：真实mediaTranscriber imported入口遇真实SQLite索引刷新失败仍成功并持久化转写；真实Cordis exporter捕获media.commands/warn/level2、Rust前缀、file及错误字段。只确认该分支，不签完整ASR或全部日志；L11 b03e1753f创建日志本轮未复验。
- **R13v-01.delete-batch未决**：dstu-trash.ts:155,159选择基础deleteNote/deleteTextbook，Rust delete_helpers.rs:118-172要求WithFolderItem。真实batch note返回删除1条，但membership_deleted=null、text/mm仍indexed。回派两处分派接既有owner WithFolderItem、保留同conn/事务，并补生产batch行为断言；不新增重复finding组。

| 本人job | 实际结果 | exit / Errors |
|---|---|---|
| `20261104115743-728705` | 删除6例＋真实WARN1例，7passed/9过滤，19.45s | 0，无Errors/unhandled errors，仅WASI提示 |
| `20261104115847-4672f4` | 真实dstu_delete_many反例：deleted_count=1；note_deleted有值，membership_deleted=null，text_state/mm_state=indexed | 0仅表示观察完成，**不是等价通过**；无未处理异常 |

已获取两作业result，完整输出`/home/dsdev/.oc-jobs/done/<job ID>.log`；submit命令及Rust对应见vfs ACCEPTANCE末节。保留owner旧b99275夹具失败及a49361日志阈值失败，不把它们改写成通过。只修改两份审计文档，未代修实现/测试；当前L11/L12/L13b/vfs未决仍2/9/2/6，四个插件均不通过。

### standard-v2 §5 首次标准自检：未通过

已提交32829daf8后合并main **d84e29565**，得到 **675d7e838**；相对main仅五份授权审计文档。指定lane-gate经队列跑四项，总exit1、仅tests失败。完整result均已读取：

| job | 检查 | 原结果 |
|---|---|---|
| 20261104120753-ee7eff | typecheck | exit0 |
| 20261104120753-e84b54 | boundaries（普通） | exit0，2430文件0violation/167suppressed |
| 20261104120753-b67fad | 四插件importable | exit0，ok |
| 20261104120753-d134c8 | 四插件全目录测试（门禁自动选取） | **exit1，3failed/83passed文件，11failed/813passed测试，504.13s，无Errors/unhandled errors** |

失败全在L13b：embedding 7条缺injectionBudget/llmCodexAuth；paths 1条现代file_夹具误走tb标题预期；files 3条在`files.test.ts:109` spy Proxy属性时`deleteByResource does not exist`，尚未invoke，不能称outbox业务断言失败。L12 lifecycle Lance Proxy仅get trap转发，正常方法访问存在；应修测试故障注入接缝而非增加生产兼容层。详细源码与回派见vfs-handlers ACCEPTANCE §10。

标准门禁自动包含已签R11用例，本人没有额外专项重跑；L11目录各文件通过且本次无RPC/unhandled错误，但联合命令exit1，仍如实保留R11-04原“完整exit0独立证据”状态，不把联合失败报告改写成全绿。R11-05真实F3维护组合等待owner交付，R13-02线程消费者尚未签；PDF字段/范围子项不覆盖duplicate/parser顺序。L13通知legacy tb夹具＋现代file_回退的候选修法方向正确，待固定提交；未在审计分支代改测试。

日志`/home/dsdev/.oc-jobs/done/<job>.log`；标准自检记录由lane-gate自动写入主仓库`.oc-runs/selfgate/R3-review-vfs.json`，按tip/base绑定。本文记录本次675d7e838的失败，后续文档提交须按§5合并main并重新运行标准自检，不能沿用本次记录声称新tip已通过。

### c90fcd6c6候选：正文快照与生产路径测试复核

自动续派后同步main无新增；固定L13 **c90fcd6c6fb8892c90d95641c5989dc262b4994d**，对照main45c3250b0仍未集成，运行前后相关代码/测试无diff。本人最小队列 **20261104123217-d787b8**：3文件、**5通过/67过滤、exit0、无Errors/unhandled errors**，33.44s，已取result。

- **R13v-05正文快照候选通过待main**：真实kernel正文更新委托L11同conn、versionSource=manual；验证旧版本/COW/合并窗口、快照INSERT失败warn/warn/error后正文提交、最终UPDATE失败版本与正文回滚且无updated事件。Rust对应content_helpers.rs:697-746及mindmap_repo.rs:615-665。
- **R13v-06字面量子项候选通过**：test_simple_path_format改调真实buildSimpleResourcePath，原输入和相等期望保留；TESTMAP未闭部分仍待验，不整组签收。
- **service-wiring路径夹具候选通过**：真实legacy tb_def456保持标题断言，现代工厂file_额外验证ID回退。未将L13用例通过扩大成L13b门禁修复已集成。
- 元数据/重命名仍调用本地updateMindmapWithConn；delete-batch基础方法误选未改，R13v-01继续未决。L11真实worker组合仍未交付，本轮未新增R11测试。

完整命令及来源见vfs ACCEPTANCE末节；日志`/home/dsdev/.oc-jobs/done/20261104123217-d787b8.log`。仅审计文档变更；主线未决仍2/9/2/6，候选通过不等于四插件或完整ASR验收。

### 自动续派：L13b门禁修复与R12-09 owner子链

main先同步无新增，当前已审自检tip74b0a6dd2失败；不以无代码变化重复手动全套。改对新候选最小独立复核：

- **L13b 6aac21c84**（files/paths目标同88184728c）：补真实LLM提供方和F3预算实现、legacy tb标题＋现代file回退夹具、Lance外部故障注入适配，原outbox/状态/日志断言保留。files/paths作业 **20261104125015-4270f0：4通过/13过滤、exit0**；embedding作业 **20261104125236-85de51：10通过/8过滤、exit0**，均无Errors/unhandled errors。新增真实LLM AppError→Rust Display和错误先于维度写入也通过。11条旧门禁失败候选已解除，等待main；R13-01/02整组不关闭。详情见vfs-handlers ACCEPTANCE §11。
- **L11 9006bc168 / R12-09**：unit/segment safeIntegers读取、generation缓存/绑定/返回精确；本人 **20261104125122-2d4f6f：1通过/4过滤、exit0、无Errors**，覆盖2^53+1与i64::MAX真实owner读写。目标仓储/类型/测试未漂移；执行树另有worker注册WIP，不能称整个不可变快照或R11-05通过。L12 e665f4ae2还未包含该owner修复，公开text/mm三条既有失败保持原记录，待组合最小复验；见vfs-index ACCEPTANCE §7。

main随后前进至 **44b66353c**，仅调度脚本变化，以上插件候选仍未集成。R3不越权修改实现/测试去修绿；当前主线未决仍L11/L12/L13b/vfs=2/9/2/6。三项作业完整命令与result均可由`/home/dsdev/.oc-jobs/done/<job>.log`取证；后续提交照§5运行标准自检，不将候选最小集替代审计分支门禁。

## 新候选：R11-05真实维护与R13v-01.folder-cascade

本轮仅编辑原授权的vfs-repos ACCEPTANCE与本汇总，vfs独立文件已按范围门禁移入下方归档，不再重新创建。main对照 **ad11a8394**。

范围修正提交 **1f5316d01** 的标准自检已取完整result：typecheck `20261104132021-27efb6` exit0；boundaries `20261104132021-b5d799` exit0（2497文件、0violation/166suppressed）；importable `20261104132021-aa8971` exit0；tests **20261104132021-01a0a4：3文件失败/73通过，11失败/639通过、exit1，无Errors/unhandled errors**。门禁按修正后的三个插件目录自动选取，没有人为删测试；失败仍为main中L13b原7条LLM依赖/3条Proxy spy/1条paths夹具，其候选通过不替代main门禁。原vfs补审218行全文逐字迁移校验通过，相对main仅四份授权审计文档；未再占用被拒绝路径。

### R11-05（候选通过待main）

固定修复 **513aac879**，执行后继 **e8d704d99**；两树F3维护实现/直接注册及三条被测断言一致，后继增加folder worker方法不影响本次todo/search维护链。本人作业 **20261104132231-57006f：3通过/6过滤、exit0、无Errors/unhandled errors**。真实parent StorageService（非registry替身）先封锁新借用，生产worker在途完成、拒绝新请求，排空并结束旧线程，release后新线程/主句柄可用；短生命周期search排空及真实exporter日志回传通过。详细静态时序、测试替身边界与命令见vfs-repos ACCEPTANCE §9。候选尚非main祖先，主线R11-05仍待复验，R13-02消费者不连带关闭。

### R13v-01.folder-cascade（原组子项，候选局部通过）

固定 **20c8a997f543889b6a736a6fb583234349ba40f5**，实现 **0fe8c89d2 + 4faf0d998**（20c8是报告）。运行前提供方干净、运行后host/contracts/配置相对固定SHA无diff；该候选非main ad11a8394祖先（exit1）。

- `host/plugins/vfs/repository/folders.ts`的`deleteFolderWithConn`只调用`callNoteRepository(()=>vfsRepositories().folders.deleteFolder(conn,folderId))`。原私有entity软删、递归级联、额外query与保存点副本已删除；不是仅增加owner存在分支而保留本地fallback。这里只确认删除级联小单元，其他folder写操作不随之获批。
- 真实L11 `repository/folders.ts:475-503`在同conn的vfs_folder_delete_tx保存点中依次软删root/descendants/memberships，再遍历树内实体；`:672-683`保留去重和树外活跃成员检测。`vfs-repos/index.ts`将note/file实体分派到真实L10/L11仓储。对照Rust folder_repo.rs:1230-1320，失败回滚整个保存点；消费者没有引入另一层独立事务。
- 原`tests/folders.test.ts:421-451`保留幂等、missing-folder错误和树外共享成员断言。新增`:454-481`真实kernel invoke，child file UPDATE trigger失败后root/child/note/file/全部成员仍未删除，file仍active；移除trigger后成功删除。无事件增加断言存在，但`dstu_folder_delete`本来不主动发dstu:change，故回滚结论以真实DB断言为主，不把该断言单独称作“提交后事件顺序已验证”。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/folders.test.ts -t "soft deletes the folder tree|does not soft delete an entity|R13v-01 rolls back the whole owner folder cascade" --maxWorkers=1 --no-cache
job.mjs result 20261104132232-316bcc --tail 100
Test Files  1 passed (1)
     Tests  3 passed | 26 skipped (29)
  Duration  30.36s
[作业 20261104132232-316bcc] 退出码 0
```

无Errors/unhandled errors；26条为-t过滤。完整日志`/home/dsdev/.oc-jobs/done/20261104132232-316bcc.log`。不将owner Node/Electron各6例计作本人执行。X6-SW0117..0125消费者级联SQL删除可确认；qbank_practice_attempts的L14裁定及L11→L14真实级联不是本次note/file用例覆盖，独立保留。R13v-03完整日志、R13v-04线程、R13v-01.delete-batch等未据此关闭；主线组级数量仍2/9/2/6。

## R13v-01.note-lease：授权写入与ack失败回滚候选

固定 **526858115ae1c02f7b13db050e88cd3a113abcf6**，实际实现 **f8b509c321011a6390a29dc8824a77a7e8e29a62**，526858115为报告提交。提供方执行前干净，运行后host/contracts/配置相对固定SHA无diff。main对照最初ad11a8394、结果返回后16a254adf均未包含此候选（祖先检查exit1）；L10 leases实现与候选同源且已main。20c8a997f folder cascade沿用上节本人三例，不重复跑。

### 静态调用与Rust对应

- `host/plugins/vfs/index.ts:138-143`把真实`ctx.notes.leases`交给内部registry；`repository/services.ts`仅获取正式NoteLeaseRepository，缺失即报配置错误，没有本地SQL回退。对optional内部字段不据此误称生产依赖可省略。
- `repository/update.ts:91-105`的authorizedNoteLeaseWrite只经callNoteRepository调用`leases.authorized(conn,auth,webview,now,commit,work)`；原grant/ack/owned/冻结稿读取与解析副本已删除，目标文件已无note_editor_表引用。`src/dstu-update.ts:254-264`读取owner.now()，同一conn同时传给授权owner及work中的note更新。
- main L10 `repository/leases.ts:262-302`经noteTransaction先INSERT grant取写锁，再owned/phase/已冻结draft检查，执行work，刷新ack draft，删除grant并release；`transaction.ts:5-19`在任何后续失败时ROLLBACK TO + RELEASE note_history_write。正文仓储自己的update_note保存点嵌套于该授权保存点，内层release不会提交外层事务。对照Rust `note_lease_repo.rs:307-361`，顺序与同连接边界一致。
- 未带lease时仍走L10 updateNote的checkLeaseWrite拒绝；owner NoteDocumentError经callNoteRepository保留notes.lease_conflict/lease_not_ready/lease_flush_required/participant_expired错误key。解析错误与完整L10 lease协议未在本单元全域签收。

### 真实入口最小复验

`tests/dstu-update.test.ts`真实安装paths/notes/repos/index/vfs，经kernel invoke执行原两条授权/拒绝断言，加一条ack触发器反例。新增trigger在正文work返回后拒绝UPDATE draft_json：原正文及resourceId保留、resources总数不变、draft原文不变、grant无残留、dstu:change数量不增；移除trigger后相同请求成功、正文变新且grant仍为0。既有相等断言保留，没有mock授权owner或transaction。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/dstu-update.test.ts -t "honours the note lease barrier|rejects leases that are not ready|R13v-01 rolls back note writes and grants" --maxWorkers=1 --no-cache
job.mjs result 20261104133511-09b896 --tail 100
Test Files  1 passed (1)
     Tests  3 passed | 10 skipped (13)
  Duration  51.58s
[作业 20261104133511-09b896] 退出码 0
```

无Errors/unhandled errors；10条仅-t过滤。完整日志`/home/dsdev/.oc-jobs/done/20261104133511-09b896.log`。**R13v-01.note-lease（X6-SW0127/0128/0129同源）小单元候选通过待main**；不关闭整个R13v-01，不把owner Electron三例计作本人运行。路径tb/file争议仍引用已审Rust分派证据，本轮未改任何测试。主线组级未决数量不变。

并行中的旧规则标准自检（tip d4b67ad39、base ad11a8394）已取结果：`20261104132929-ec6b32`仍11failed/639passed、3failed/73passed文件、exit1、无Errors；typecheck `20261104132929-5a3fa1`、boundaries `20261104132929-4b2300`、importable `20261104132929-ca60f0`均exit0。main随后发布16a254adf基线差分门禁；后续按新规则执行，不抹去原测试失败或将门禁认可等同业务验收。

## 正常main bec9c35ba：L13b旧门禁与cache文件阶段

合并提交32db28051包含main **bec9c35ba26d42a31c0b2f035a2f9c8e4ad5be96**，仅授权审计文档相对main有差异。6aac21c84候选已集成；原7条LLM宿主缺依赖、3条Lance Proxy spy准备失败、1条tb/file夹具错误，在正常main真实入口最小复验中全部解除。本人 **20261104140133-86dbcd：4文件18通过/21过滤、exit0、无Errors/unhandled errors**。

- **R13-03/06正式main签收**：原outbox/模态顺序/软删与owner模型解析回退断言保留；X1真实AppError Display新增断言也通过。
- **R13-01.path-file主线子项闭合**：legacy tb保持标题，现代file_回退ID；没有为显示标题改生产策略。
- **R13-01.cache-vector主线子项闭合**：真实vfs_clear_media_cache→L11 pre-vector callback，在OCR之后、vector SQL之前删实际临时目录。四例覆盖原缺列报错前已完成磁盘副作用、真实9字节成功计数、删除失败warn/继续/不计释放量、无目录继续SQL；对应Rust handlers.rs:7150-7205。
- **整组仍保留**：附件根配置只有测试provider，L13b还未消费worker；R13-01/02不整组勾选。R11-05及L13候选不随其他lane集成自动升级。

完整命令/静态路径见vfs-handlers ACCEPTANCE §12，日志`/home/dsdev/.oc-jobs/done/20261104140133-86dbcd.log`。22:00一轮门禁工具故障已按架构师后发指令忽略，未修改工具或用其错误判断业务代码；新提交仍按§5执行正式自检。主线未决数量维持2/9/2/6。

## 标准自检原始全绿与R11-04签收

tip **7e4c9848fa2952504005ad060f59c234996e0bf2**，base **bec9c35ba26d42a31c0b2f035a2f9c8e4ad5be96** 的selfgate记录ok=true，且四项底层job均真正exit0：typecheck `20261104140723-0e02d6`，boundaries `20261104140723-b2d872`（2540文件0violation/167suppressed），importable `20261104140723-841594`，tests **20261104140723-05a526：77文件/656passed、309.82s、exit0、无Errors/unhandled errors**。均已读取result；日志`/home/dsdev/.oc-jobs/done/<job>.log`。

联合测试自动覆盖L11全目录32文件/257测试，原R11-04完整exit0证据已满足，正式关闭；没有为签收另跑旧全套或删改断言。此前基线差分门禁“允许既有11失败”与这次**原始零失败**明确区分。R11-05真实维护候选尚待main，不因本轮普通worker测试绿而自动签收；L12、L13b、vfs其余未决同前。当前组级未决18（1/9/2/6），四插件总 verdict 仍不通过，详见vfs-repos ACCEPTANCE §10。

## R12-08：服务精确解码通过，IPC响应契约仍阻塞

续派同步main **8d7b05d14**无新增；已通过自检tip eba9f6e8a未无故重复测试。读取新L12候选 **26b85c095**，共享F4 JsonReader已实际接入进度字段/alias/重复键/usize词法/struct sequence/f32。本人最小作业 **20261104142645-d02d0a：9通过/6过滤、exit0、无Errors**。OCR写回用例含owner/provider fixture，只确认生产parse/serialize路径，不签完整OCR/所有权。

额外真实kernel探针 **20261104143042-824c5b** 使用实际插件/存储/文件，经vfs_get_pdf_processing_status观察：正常percent25的大页码内部9007199254740993n到wire number按D3舍入；percent1e40服务返回null，但debug输出schema仅number导致`must be number at /progress/percent`拒绝。**探针exit0是观察完成，非等价通过**；脚本服务值有真实断言、invoke拒绝被显式记录，详见L12 ACCEPTANCE §8与原job result。

该跨边界缺口归 **R12-08.wire-percent** 子项，已通过coord向L12/C2发送准确job/路径，要求协调F5只对齐Rust成功响应null形状，保留输入约束与debug结果校验。候选随后类型/i64时间字段WIP与本次progress断言分开记录，不宣称整棵不可变快照或新增timestamp断言已通过。R12-08整组保持未决，R12-09因L12树尚不含9006bc168不重复跑已知失败组合。原已签项目不重测，不改实现或测试。

**C2限定的F4输出候选补证据**：0fb54cdde（实现c0e797350/159eb035f）的正式api `f32ToJsonNumber`仅用于出站snapshot f32→最短十进制number/null；对照main4525e11ac尚未集成。F4/C2报告151601-6fcbaf Node4pass/exit0及151448-fff7fe Electron4pass/exit0，非本人复验；没有Rust差分，roundtrip不能单独证明最短选择。待F4/L12正常main后，仅验证既有33.333332、1.1及null的真实invoke输出，不重跑未变服务9例，不增34-ID oracle编译入口。F5 nullable合同仍独立pending，debug拒null反例保持；详见L12 ACCEPTANCE §8末。

## R13v-03.folder-validation：校验WARN候选复核

固定修复 **a65049136e4887c1e10b79381e82a2a335e8cc86**（实现e046b5ca3，SPEC34b0d3a8e；a650为报告），执行后继 **2de295cc3390af0dc2868448e6f6e1ede58521b5**。两树相关vfs实现/测试一致，仅notes sync及其测试不同。候选不是本轮main **879e0a56b597ed6a03921e56b260b913adadbdd9** 祖先（exit1）。运行前提供方干净；结束后出现upload/resource hooks及index/trash相关WIP，校验实现、该测试和create/rename调用未变，因此仅为固定目标子链证据，不声称整个执行树冻结或将新增upload纳入签收。

- `host/plugins/vfs/src/folders.ts:63-90`按控制字符→Unicode bypass→路径分隔符→UTF-8字节长度顺序，先warn再返回原错误；format中的field/max_len对应Rust folder_handlers.rs:59-88。`Buffer.byteLength(...,'utf8')`与原s.len()字节规则保持，未改成JS字符长度。
- create仍先空标题→标题validator→icon→color，color失败新增原warn；空标题在validator前直接返回，不新增validator warn。rename复用同一validator且在读folder前拒绝。Rust对应folder_handlers.rs:159-186、284-290；本次没有改变返回错误文本或先后次序。
- 新增`tests/folders.test.ts:482-515`通过真实kernel invoke和Cordis exporter（levels.default=3），逐次断言warn/type、level2、原format和field/max_len/color参数；坏标题同时带坏颜色时只有标题warn，rename坏标题先于missing-folder读，空标题不记warn，最后folders总数0。原校验/颜色/危险输入三例及全部既有断言保留；测试没有mock logger或被测validator。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/folders.test.ts -t "R13v-03 records|test_title_validation|rejects dangerous titles|creates roots for root" --maxWorkers=1 --no-cache
job.mjs result 20261104150632-ca968d --tail 90
Test Files  1 passed (1)
     Tests  4 passed | 26 skipped (30)
  Duration  34.43s
[作业 20261104150632-ca968d] 退出码 0
```

已取result，无Errors/unhandled errors，26条为名称过滤；完整日志`/home/dsdev/.oc-jobs/done/20261104150632-ca968d.log`。**R13v-03.folder-validation候选通过待main**，不新增组。该用例未断言logger target名称，UTF-8计数方法静态核对；不扩大动态覆盖。breadcrumb prepare/query/collect阶段错误上下文、其他warn/error及线程/owner仍未决，整组R13v-03不关闭；F3 phase到位不自动等于L11窄接口和消费者已接通。没有重跑已签folder cascade、lease或R11子项。

## R12-03.state-owner候选及R12-06.additional-unit保留项

自动续派同步main1e893eb61后，标准自检tip5d6708d33通过：tests **20261104154440-641559：24文件213通过、exit0**，typecheck **20261104154440-5fa2c7**、boundaries **20261104154440-de2359**（2561文件0violation/170suppressed）、importable **20261104154440-734500**均exit0，已取result。

新候选X6-SW-0179（实现21e8175c2，审读3f57ac79d、执行后继4e4b713c9，目标文件无diff）无embeddingDim分支已委托L11 setTextState。本人 **20261104154913-89292e：1通过/28过滤、exit0、无Errors**，真实full-indexing入口＋真实L11仓储，外部Lance失败后同conn写failed并保留indexed_at/维度/资源业务时间。只确认R12-03.state-owner小单元候选；带embeddingDim写及其他owner缺口不关闭。

同时静态指出R12-06.additional-unit：full-indexing.ts:623-629仍缺Rust indexing.rs:3082-3085 warn，状态setter失败也未保留Rust let_忽略/原错误策略，已回派L12，不把它伪报成动态失败或另增finding组。main显式transaction Scope owner传递与原index-state/embedding-dim fallback删除已核，旧eeaf5bdc7描述改为历史，详见L12 ACCEPTANCE §9。

本轮未重跑R12-08服务9例、R12-09已知缺owner组合或已签R11子链；F4/L12正常main后的有限33.333332/1.1/null三类invoke范围保持。主线未决仍18组。

## L13已验候选进入正常main的闭环（2026-11-05）

固定main **677f6727c691ac3a2b33ca4c0a9b637476d0feb9**，审计合并提交 **7b78b1165354ba2b7b187280c1a051afe19aded2**。此前a65049136及其祖先创建/删除/folder/lease/快照修复现为main祖先；相关repository/create/delete/folders/update、folder validator及对应测试与已审2de295cc3无diff。运行期间本工作树实现/测试未修改，host/contracts/src-tauri相对固定main仅审计文档不同。本轮重新验证的是正常main组合，不复用owner自报替代主线运行。

### 当前vfs组级与子项状态

- [ ] **R13v-01：组级仍未决。** notes/mindmap创建、delete.ts owner委托与混合translation/mindmap保存点回滚、folder cascade同conn整体回滚/幂等/树外成员、note-lease授权与ack后写失败回滚等已验子项正式main确认。元数据/重命名本地update副本及其他foreign writes仍需owner收敛。**R13v-01.delete-batch仍开**：main `src/dstu-trash.ts:157,161`仍选基础deleteNote/deleteTextbook，未改成Rust WithFolderItem；原真实反例有效，未无故重复相同探针。
- [ ] **R13v-02：注册缺口子项已解除，完整性未整组签收。** main已注册并执行dstu_delete/delete_many，不能再引用最早“未注册dstu_delete”要求重造。单删除六例通过，但批量note/textbook语义与其余未闭业务完整性仍需分别完成，不把入口存在扩大成完整删除等价；批量问题与R13v-01共享同一反例，不另增重复finding。
- [ ] **R13v-03：组级仍未决。** folder title/icon/color校验WARN和优先级、rename复用/空标题不额外warn，以及真实media消费者索引刷新失败WARN/继续子项main通过。breadcrumb分阶段错误及其他日志未因此关闭。
- [ ] **R13v-04：运行时/流式媒体完整性仍未决。** 本轮未将这些同步入口通过算成线程或完整ASR验证。
- [x] **R13v-05：main正式通过。** 正文更新通过L11 updateMindmapWithConn(versionSource=manual)保留旧内容快照、共享资源COW、合并窗口；快照失败warn/warn/error仍提交、最终owner写失败版本/正文整体回滚且无updated事件。三条原候选用例在正常main重新通过，关闭的是该原finding，非所有mindmap更新路径单写者。
- [ ] **R13v-06：字面量子项main通过，TESTMAP闭合仍未决。** test_simple_path_format现在调用可达生产buildSimpleResourcePath；service-wiring保留legacy tb标题断言并验证现代file_回退。main实际381行=293ported/83pending/5obsolete，头部仍写290/86/5；本轮没有修改TESTMAP或将83pending视为全部完成。

L13-BUILD-PATH-01根分支不取DB、Some才走owner及原拼接规则也在main两条用例通过；日志动态覆盖范围沿原候选记录，不额外声称sink全测。

### 本人main最小复验与标准自检

```text
job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/vfs/tests/dstu-create.test.ts host/plugins/vfs/tests/dstu-update.test.ts host/plugins/vfs/tests/dstu-delete.test.ts host/plugins/vfs/tests/folders.test.ts host/plugins/vfs/tests/media-index.test.ts host/plugins/vfs/tests/locations.test.ts host/plugins/vfs/tests/paths.test.ts host/plugins/vfs/tests/service-wiring.test.ts -t "creates notes with tags|rolls back owner mindmap|R13v-05|honours the note lease barrier|rejects leases that are not ready|R13v-01 rolls back|R13v-03 records|soft deletes the folder tree|does not soft delete an entity|dstu_delete|mediaTranscriber preserves transcript success|dstu_build_path|test_simple_path_format|test_source_id_prefix_parsing" --maxWorkers=1 --no-cache
job.mjs result 20261104161153-83f634 --tail 160
Test Files  8 passed (8)
     Tests  23 passed | 110 skipped (133)
  Duration  64.64s
[作业 20261104161153-83f634] 退出码 0
```

无Errors/unhandled errors；110条为-t过滤，断言/skip均未修改。完整日志`/home/dsdev/.oc-jobs/done/20261104161153-83f634.log`。23例构成为create2、update6、delete6、folders4、media1、locations2、paths1、service-wiring1。此证据是所列微单元的main闭环，不是vfs全目录通过。

同一tip的§5标准自检也已通过：typecheck **20261104161020-0dc380**、boundaries **20261104161020-abe852**（2690文件0violation/184suppressed）、importable **20261104161020-d91c5b**均exit0；自动选取的L12 tests **20261104161020-db8b1c：24文件213通过、exit0、无Errors**，均已取result。未把该L12门禁数当vfs新测试数。R11-05与R12-09等未集成候选不随L13入main自动签收；当前总未决17组，四插件整体仍不通过。

## R11-05：正常main条件注册的真实维护闭环

按C2 F3正式main解锁指令，固定 **fd925aa052873b52137e8405f60071fb36910c3c**（80dcc5291为祖先），审计执行树 **b0ae7f9dcaa4c3c0608622d1fed66621ec8cc353**。513aac879仍不是main祖先，但main index.ts:175-193已有条件注册回调，真实F3使其生效；worker-service/entry与513相同。不能因513清理提交未合就忽略现有生产接线，也不能只因F3发布就关闭finding，本轮以实际主线组合断言判定。

本人 **20261104163651-79f860：exit0，无未处理异常**，真实parent storage＋paths＋notes/repos插件：先提交todo写及短worker搜索，再进入维护；新主句柄借用/worker请求被拒绝，在途完成；await排空成功后release恢复，原已提交数据可读，新旧threadId **1→3**。真实仓储表改名故障经exporter确认WARN **dstu_vfs::repos/warn/level2**及原错误字段。脚本含node:assert/strict，完整命令在job result，非Vitest通过数；日志`/home/dsdev/.oc-jobs/done/20261104163651-79f860.log`。详细源码/时序见vfs-repos ACCEPTANCE §11。

**R11-05正式main签收**，原R11编号未决归零；R11-04/身份/pragma不重复验证。L13b R13-02实际线程消费、generation9006+5aaf联合和其他v2单写者/精度项保持未决。当前总组数16（0/9/2/5），原R11清单全闭不代表L11全域已无跨lane缺陷；R12-09共享问题不在L11另增重复组。已回报C2，未向parked L13追加执行消息。

## Linux续作：集成状态与剩余工作（2026-11-05）

固定执行基线为main **e9df01a3c**，工作树干净、分支仍为`ds-mig/R3-review-vfs`；存在其他lane并行Vitest，重任务按队列执行。所有命令从本工作目录发起，本人未改实现、测试、SPEC、TESTMAP或Rust。

### 本轮独立核对

| 项 | 当前证据 | 结论 / 下一步 |
|---|---|---|
| R11-05 | 513aac879祖先检查exit0；vfs-repos/index.ts:170-189直接注册真实F3，排空失败解除暂停并传播错误 | 保留已有主线签收；不再把去探测清理提交描述为未合入 |
| R12-09 owner | 9006bc168祖先检查exit0；L11 sql-integers.ts:5-13、index-segments.ts:64-86,175-182,201-215保持精确查询/缓存/绑定 | owner已main；当前公开写链仍未等价 |
| R12-09 consumer | 5aaf3bc8a祖先检查exit1；L12 repository/index-units.ts:501-513仍Number(next)，src/lance-store.ts:163-169→embedding.ts:121-127实际消费；Rust lance_store.rs:289-311返回i64饱和加一 | **保持未决**；先集成消费者修复，再验公开text/mm联合链，不把owner绿测当联合通过 |
| R12-08 / R12-03.state-owner候选 | 26b85c095、0fb54cdde、21e8175c2祖先检查均exit1 | 保留§8–9候选范围；不得用旧候选运行结果宣称正常main已修 |
| R13-01 | L13b index.ts:204-205可选注入旧配置服务；全host提供点只有tests/pending-attachment-config-provider.ts:7,16 | 附件根配置真实消费仍未闭合 |
| R13-02 | todo.ts:113-127、pomodoro.ts:44-63仍同步仓储；TESTMAP.md:76-77两项pending | 提供方已main，待L13b消费worker并验证线程/事件/维护，不再归因F3接口未发布 |

此次不新建finding编号。原三份命令/测试逐条抽查及共性问题继续保留；L11原R11编号清零与全域v2通过分开表述。

### Linux运行原始摘要

```text
job 20261105000156-201194: npm run typecheck:host
> tsc -p tsconfig.host.json
退出码 0（无类型错误）

job 20261105000239-6f7ae2: npm run migration:boundaries
boundaries: scanned 2949 files, 0 violation(s), 215 suppressed via boundary-allow
退出码 0

node scripts/electron-migration/importable.mjs host/plugins/vfs-repos/index.ts host/plugins/vfs-index/index.ts host/plugins/vfs-handlers/index.ts
importable: ok
退出码 0

node scripts/electron-migration/wiring.mjs --lane vfs-repos
合计 ported 158，其中所测模块未从 index.ts 接入 0（0.0%）
node scripts/electron-migration/wiring.mjs --lane vfs-index
合计 ported 79，其中所测模块未从 index.ts 接入 0（0.0%）
node scripts/electron-migration/wiring.mjs --lane vfs-handlers
合计 ported 63，其中所测模块未从 index.ts 接入 0（0.0%）
三项退出码均0
```

本轮未发现Linux import路径大小写错误。三个插件目录测试原始摘要：

```text
job 20261105000156-58ee8e:
npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos host/plugins/vfs-index host/plugins/vfs-handlers
FAIL host/plugins/vfs-handlers/tests/embedding.test.ts > vfs/handlers.rs embedding dimension commands > infers embedding readiness from settings and fallbacks
SlotOccupied: service slot already occupied
  Slot.provide host/kernel/primitives.ts:32:34
  registerDeletionJournal host/platform/storage/deletion-journal-owner.ts:34:23
  Fiber.<anonymous> host/plugins/notes/index.ts:213:28
  createVfsHost host/plugins/vfs-handlers/tests/harness.ts:62:16
  open host/plugins/vfs-handlers/tests/embedding.test.ts:26:15
  host/plugins/vfs-handlers/tests/embedding.test.ts:240:17
Test Files  1 failed | 80 passed (81)
     Tests  1 failed | 710 passed (711)
  Duration  757.48s
退出码 1；无Errors汇总行
```

完整日志`/home/dsdev/.oc-jobs/done/20261105000156-58ee8e.log`。逐文件汇总：L11 33文件286测试通过，L12 24文件213测试通过，L13b 24文件212测试中211通过/1失败。没有过滤或改skip。L11的R12-09 owner精确generation用例亦通过，但不能代签L12仍经Number(next)的生成链。

**失败归因与回派**：`embedding.test.ts:234`创建withoutLlm，`:240`在其仍存活时创建第二Host；两者均经真实notes插件注册同一个模块级`journalOwner`（F3 `deletion-journal-owner.ts:32-34`），而Slot要求单一占用（kernel `primitives.ts:31-33`）。测试仅在afterEach统一dispose（`:9-13`），故第二次启动确定性冲突；不是业务readiness失败、RPC超时或Linux大小写错误。已用coord投递C2，请L13b/F3/L10明确宿主隔离/生命周期并保留原两组断言。R3仅可写审计文件，不能代改测试或把全局Slot替身注入成绿灯。作为独立集成验证阻塞记录，不凭此重开已签R13-06算法问题；本轮门禁尚不成立。

首个续作提交`5c51aa476`之前同步main到`c6309183c`，相对测试启动基线仅两个调度脚本变化；host/contracts/src-tauri/测试配置/package均未变化，测试运行中未混入实现改动。

### 当前汇总

| Lane | 结论 | 原编号未决组数 | 主要剩余 |
|---|---|---:|---|
| L11-vfs-repos | 不通过 | 1 | 原R11-01–06已闭；新增R11-07配置跨字段i32读取不等价 |
| L12-vfs-index | 不通过 | 8 | R12-07已关闭；仍有R12-01流水线、R12-03单写者、R12-09精确generation消费链 |
| L13b-vfs-handlers | 不通过 | 2 | R13-01附件配置；R13-02线程隔离 |
| vfs历史补审 | 不通过 | 5 | 单写者/批量删除、错误日志、运行时与测试完整性；保留既有证据，不扩大本轮执行范围 |

## 自动续派：修复主线门禁并推进R12剩余项（2026-11-05）

按中断恢复要求读取log/status/TESTMAP，原审计提交7cfd307fa已在分支且工作树干净；合并main **a9683a43b**为 **84c0847a7**。权威行状态重新核对：L11 158ported/0pending，L12 79ported/0pending；L13b 63ported/2pending/3obsolete，三个obsolete仍在approvals.json:37-39获批。不能用测试名里的pending子串充当pending行。

恢复时按要求亲跑只读ledger（作业`20261105003953-29fa51`，exit0），原始最后一行：

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3633, not vetoed)
```

此为全仓机械结果，不是三个被审lane已达到B；全仓可达性仍有16条unreachable，扫描明确未作veto。未写生成ledger文件。

### 双Host门禁修复的真实性

main修复a9683a43b只在`host/plugins/vfs-handlers/tests/embedding.test.ts:239-241`将第一个Host从清理列表移除并await dispose，再创建第二Host；原无LLM返回值、配置回退、默认写回及missing配置回退断言逐字保留。此用例本就分别验证两个环境，并无并发宿主不变量；顺序关闭避免全局journal Slot双占用，未替换notes/LLM算法、未改生产Slot规则。原Rust handlers.rs:4199-4221/LLM配置优先级对照不变。正式lane-gate在合并提交84c0847a7执行，结果另记；不因静态修改看似正确就宣称测试已通过。

### R12-07正式main微单元签收

`vfs-index/src/lance-store.ts:714-773`、`chat-embeddings.ts:208-225`已恢复原open失败跳过/scan失败容忍/null补样本，schema失败仍传播。对照Rust `vfs/lance_store.rs:2466-2487,2507-2564`、`lance_vector_store.rs:903-919`。本人队列 **20261105004229-9531a3，exit0**，真实插件公开store与`host.invoke('optimize_chat_embeddings_table')`覆盖上述不同失败阶段，断言均通过；脚本化外部vector供应商未替换被测业务。完整脚本/原始结果见job日志及L12 ACCEPTANCE §10。

```text
R12-07 production plugin: open failure skipped; null samples retained; scan failure tolerated; schema failure propagated; chat optimization continued PASS
[作业 20261105004229-9531a3] 退出码 0
```

关闭原R12-07；不冒称F7原生流/C级差分通过。其余八组保持未决，但修正过期描述：R12-02当前已保留完整模型配置并委托LLM；R12-04已注入rerank包装，未提供transport时会warn；R12-05 slots/compress/backend/missing-note已真实消费，MIME扩展名helper仍仅测试；R12-06附加Unit失败分支仍缺warn及best-effort状态写。详细当前行号见L12 §10，避免协调者按初审旧代码重复派修。

generation消费者5aaf3bc8a、精确PDF进度26b85c095、F4 f32 0fb54cdde及state-owner 21e8175c2仍非该main祖先，不重复已知缺组合的旧候选测试。R3仍仅编辑四份授权审计文件，不能将自动续派中的通用“写LANE/修实现”用作越权授权。

### 官方自检结果：原双Host失败解除

selfgate记录固定tip **84c0847a71c0585bdb7296aee8eaae5435d56f19**、base **a9683a43b8b9001e5c73fea04cc1263fb35401b6**、ok=true。四项底层job退出码均0：typecheck `20261105004018-d562ce`，boundaries `20261105004018-8ec160`，importable `20261105004018-6b0d43`，tests `20261105004018-600c88`。

```text
Test Files  81 passed (81)
     Tests  711 passed (711)
  Duration  668.57s
[作业 20261105004018-600c88] 退出码 0
```

原输出无Errors/unhandled errors；L11 286、L12 213、L13b 212测试全部通过。此前710/1准确保留为修复前历史。审计补充自动保存为4a1e6c384，相对被测tip仅三份审计文档变化；不把selfgate的绑定tip伪写为后续文档提交。遵守C2“最终官方gate已覆盖直接复用，不再加专项重复”指令，不再次运行这711例。

### 同提交L13受影响测试的变化点审读

- `attachment-executor.test.ts:33-37,111-115`删除测试自建chatAttachmentErrors，改用真实chat提供方并以`vi.spyOn(...,'localize')`默认call-through观察；未设置mockImplementation。原缺内容字节错误及`ATTACHMENT_SOURCE_UNAVAILABLE`断言保留，对照Rust `src-tauri/src/chat_v2/tools/attachment_executor.rs:924-931`。真实提供点`chat/index.ts:128`。
- `retrieval-host.ts:68-73`删除旧chatRetrievalScope替身；`retrieval-integration.test.ts:15-17`先建真实session再invoke `chat_v2_set_rag_scope`，`:24-32`继续验证课程/子目录范围、排除memory和事件。正式command `chat/src/register.ts:398-409`写owner仓储，提供点`chat/index.ts:129`；Rust `dstu-agent/src/chat_v2/session_scope.rs:9-24`与`src/chat_v2/tools/builtin_retrieval_executor.rs:2065-2088`从会话持久范围读入并展开。
- 这两个文件不在R3三目录官方门禁中，按C2指令仅提交作业`20261105005211-518624`运行两文件；不重复embedding专项，不将外部检索/重排fixture计作L12传输等价证据。

该作业已完成并亲取结果：

```text
✓ host/plugins/vfs/tests/attachment-executor.test.ts (9 tests)
✓ host/plugins/vfs/tests/retrieval-integration.test.ts (6 tests)
Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  90.60s
[作业 20261105005211-518624] 退出码 0
```

无Errors/unhandled errors，完整日志`/home/dsdev/.oc-jobs/done/20261105005211-518624.log`。同提交L13真实owner接线修复复验通过，C2此次要求的embedding及受影响L13测试均闭环；不扩大为L13整个插件B通过，原五组未决保持。最终沿用官方711全绿＋本次限定15全绿，不追加重复全套。

## 自动续派：R12-02配置身份通过，错误显示仍未等价

main同步仍a9683a43b，执行树61e9c7b4b只含审计文档增量。本轮按自动续派要求对该tip启动正式自检，未重复已签L13十五例。

该tip正式自检四项已全部通过：typecheck `20261105011203-6e4623`、boundaries `20261105011203-eb93fa`、importable `20261105011203-f491fd`、tests `20261105011203-1dd0fa`均exit0；tests原始摘要81文件/711测试通过、318.35s，无Errors/unhandled errors。此为机械门禁结果，不覆盖下述新发现的语义残差。

1. **指纹子项主线通过**：`20261105011329-b19913`真实L11/L12公开indexResource，分别仅改baseUrl/providerType/providerScope/apiProtocol/modelAdapter，id/model相同；五次均INVALID_STATE，资源pending、segments为0，模型读取10次、embedding返回5次。L12生产runtime→fingerprint→pipeline未被替换，外部模型/transport为脚本输入。Rust `embedding_service.rs:125-165,551-585`与`embedding_dim_repo.rs:196-241`对照通过。
2. **真实选择子项通过**：`20261105011609-a4c169`安装真实L01/L02及vfs依赖，真实settings；仅控制外部配置列表。default优先、missing/disabled/vision回退assigned并写回、悬空分配时唯一模型探测/写回均通过，符合Rust `rag_extension.rs:169-247`。
3. **R12-02.owner-error未决**：同一真实组合将配置列表清空，经公开索引入口得到`获取嵌入模型配置失败: {"error_type":"Configuration","message":"未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。","details":null}`。Rust应为同前缀直接接message。L12 `embedding.ts:7,26-29`直接取kernel CommandError.message（JSON），L02 `embedding_service.ts:15-18`真实抛envelope；Rust AppError Display见`dstu-core/models.rs:1038-1041`。需L12恢复消费边界，不要求L02改契约或重开已签R13-06。

两作业exit0、无未处理异常；第二份脚本明确断言差异存在，不能称等价通过。首次真实组合尝试`20261105011533-0b8144` exit1，是审计宿主漏装vfsDatabase导致LLM启动失败；仅补真实notes/vfs插件后取得有效反例，原失败如实保留。完整命令/原文见`/home/dsdev/.oc-jobs/done/<job>.log`及L12 §11。组级数量保持0/8/2/5，部分子项修复不掩盖剩余可达错误。

共性补充：消费方从“自行选模型”改为正式owner后，还需按Rust恢复错误Display；服务Error.message可能是IPC envelope的JSON，不等于Rust `{error}`。应在真实provider+consumer组合验证，不能仅用`throw new Error('...')`的外部替身覆盖错误路径。

## 新main后的官方门禁RPC阻塞（2026-11-05）

按自动续派先合并main **f2d5b6c4653200c4c9edfcb4ba9d948d303cc492**，得到 **add6760a1900dd0684db957db47f967abc6b68d5**。本次上游包含kernel/notes等依赖更新，但三个被审VFS目录的src/tests相对前轮无diff；四个既有L12候选仍非main祖先，R12-02.owner-error源码未变，没有重复专项反例或L13十五例。

正式selfgate在该tip/base记录ok=false，failed仅tests；typecheck、boundaries、importable通过。门禁按相对main的文档差异自动选择vfs-handlers/vfs-index两目录，未选vfs-repos，因此本轮425条不能写成三目录711条。

```text
[作业 20261105013210-770d56]
npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers host/plugins/vfs-index
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
  Object.onTimeoutError .../vitest/dist/chunks/rpc.-pEldfrD.js:53:10
Test Files  48 passed (48)
     Tests  425 passed (425)
    Errors  1 error
  Duration  485.75s
退出码 1
```

完整日志`/home/dsdev/.oc-jobs/done/20261105013210-770d56.log`，已读取完整错误与原始摘要。全部测试任务显示通过不抵消未处理RPC错误；根因尚未确认，不能据此认定新notes/kernel业务回归，也不能删除Errors行改报绿灯。该阻塞已回C2处理作业环境/调度；R3无权修改runner、测试或实现，未对同一无变化树反复重跑全套。旧1b088a186的四项全绿及旧L13十五例保留原tip，不冒充当前门禁结果。原15组语义问题继续按owner修复推进。

## R12新候选：owner错误与精确generation联合通过（2026-11-05）

本轮自动续派同步main无新增，按要求启动当前tip官方自检；同时发现L12新修复363f3f72d（代码/测试在939686562），独立只读核对固定树61a2e77c4。该树已同时包含L11 9006bc168和L12 5aaf3bc8a，原“尚无联合树”仅适用早期候选。main f2d5b6c46仍不包含L12消费修复，未合并提供方分支到R3。

- **R12-02.owner-error**：恢复CommandError.value.message消费；真实L02 selector产生空配置错误，L12公开indexResource/query embedding/嵌入完成后重读三例分别验证首读及重读前缀、无JSON envelope，写入口segments仍0。沿Rust AppError Display与embedding_service原步骤，未替换被测异常逻辑。
- **R12-09联合精确链**：公开text indexResource验证2^53→2^53+1及i64::MAX饱和，mm indexResourcePages验证2^53+1。真实L11 owner同conn读写Unit/Segment，Lance外部供应商记录实际append行，mm metadata整数token也精确。仅vector/embedding外部传输为夹具，生产index/pipeline/store/SQL未替换；不视为F7原生写入验收。
- **快照边界**：从R3目录执行，测试以L12现有工作树为只读输入，`--no-cache`；运行前后相对固定树的host/contracts/package/config差异只有BLOCKERS/LANE文档，目标代码无漂移。提供方既存migration生成改动未触碰。

```text
job 20261105014804-945753:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/embedding-owner-errors.test.ts host/plugins/vfs-index/tests/lance-store.test.ts -t 'R12-02|R12-09 public' --maxWorkers=1 --no-cache
Test Files  2 passed (2)
     Tests  6 passed | 13 skipped (19)
  Duration  32.33s
退出码 0；无Errors/unhandled errors
```

13为名称过滤，非改skip。完整log`/home/dsdev/.oc-jobs/done/20261105014804-945753.log`，对应源码/断言/Rust行号见L12 ACCEPTANCE §12。两项候选通过待main，未以提供方报告替代本人复验；主线总组数保持15。两wire缺口、F7原生vector以及L13b线程/配置消费均不随之签收。

本轮R3当前tip **8b64579f7** 的正式自检已经返回全部通过（base **f2d5b6c46**）：typecheck `20261105014711-ef5fc2`、boundaries `20261105014711-7b2435`、importable `20261105014711-bd9f89`、tests `20261105014711-29788f`均exit0。测试48文件425通过、242.68s、无Errors/unhandled errors；这是主线两插件门禁，与上述候选六例区分计数。旧RPC错误未复现，未修改runner/配置或断言，不将恢复成功当成根因已确定。

## C2限定5+1：OCR临时文件与Linux真实F7媒体链

按最新指令仅提交新增两个文件，未重复前组六例、adapter二十例、425或711门禁。固定实现闭包61a2e77c4，执行HEAD a5d37cc39；运行前后与固定树的host/contracts/package/config差异只有BLOCKERS/LANE文档，目标源/测试未变化。候选非main f2d5b6c46祖先。

| 子项 | 独立证据 | 保留边界 |
|---|---|---|
| R12-05 MIME helper | 真实pdf.startPipeline→ocrImageFile临时suffix/原bytes/成功及失败清理；原空白OCR文本真实SQL持久化，失败不持久化 | OCR外部provider替身，不签完整LLM；Rust共享ocr_semaphore仍缺，不签并发完整性 |
| R12-01/09媒体写入 | 真实L11/L13两转写窗口→公开indexResource→真实F7 Lance/Arrow；Unit/Segment及原生表generation均2^53+1，Segment各窗口范围准确，检索page_index=[0,1]证明metadata列写回 | 仅当前Linux/Node；不签三平台、在线嵌入/ASR、mm全部原生分支或整组流水线 |

```text
job 20261105020149-da37c7:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/image-ocr-temp.test.ts host/plugins/vfs-index/tests/media-index-write.test.ts --maxWorkers=1 --no-cache
Test Files  2 passed (2)
     Tests  6 passed (6)
  Duration  21.52s
退出码 0；无Errors/unhandled errors
```

有原生Lance `_distance`自动投影deprecation WARN，保留完整输出`/home/dsdev/.oc-jobs/done/20261105020149-da37c7.log`；不据此宣称引擎未来版本或其他平台通过。源码/断言/Rust逐点对应见L12 ACCEPTANCE §13。原“所有F7组合均未独立验证”不能再用于这个已测文本媒体子链，但未测范围、两wire及正常main集成仍须分别完成。主线总未决15组；本次按C2仅执行5+1，不为文档证据提交触发重复整套。

收尾同步main **628b4192e**到705d9f7a1，61a2e77c4仍非main祖先；上述测试证据仍绑定提供方固定闭包，不冒称新的R3合并tip已另跑全目录。协调者自动检查点eeac6eade已保存L12 §13及部分汇总，剩余汇总单独提交；未覆盖任何实现者工作。

## R12-06.additional-unit：真实状态写失败的候选复核

本轮按自动续派合并main dd564e12f为bad0ecb3b，官方gate自动选择typecheck/boundaries两项并通过；没有额外重复425/711、前组六例或OCR/F7的5+1。对尚未独立验收的R12-06错误分支，只运行新增两例。

候选目标固定ee05933a9（相关生产/测试闭包与61a2e77c4一致），`full-indexing.ts:629-636,668-675`的状态写best-effort与`lance-types.ts:67-69`的类型分派对照Rust `indexing.rs:3071-3086`；调用方`:407-425`与Rust`:2926-2945`保resource pending/完成顺序。真实L11仓储＋SQLite trigger拒绝secondary UPDATE，两例分别证明：InvalidState保原对象、later不处理；普通Other即使正文含INVALID_STATE仍warn后继续later，primary成功状态保留。被测生产full-indexing/pipeline未被替换，但Lance store/embedding runtime和logger是故障/记录接缝，不签原生F7错误、kernel入口或完整日志sink。

```text
job 20261105024831-a11588:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/index-service.test.ts -t 'R12-06.additional-unit' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  2 passed | 29 skipped (31)
  Duration  18.43s
退出码 0；无Errors/unhandled errors
```

运行前后目标实现/测试/config未漂移；提供方期间仅新增文档和未执行的pdf-preview测试，不宣称整工作树冻结。日志`/home/dsdev/.oc-jobs/done/20261105024831-a11588.log`；29为名称过滤，未改skip。**R12-06.additional-unit候选子项通过**，该候选非main、组级未决保持15。完整源码/测试范围见L12 ACCEPTANCE §14。

## 新settings-owner探索红证据（2026-11-05）

本轮同步后R3与main **10f987035**一致，既有审计交付已集成。L12新9433c0563只提交四条settings-owner测试及原throttle装配；实际五个消费实现当时仍为WIP，开始探索后由自动检查点ddae869ff保存，另增一条未参与本作业的read-failure测试。R3只读目标文件，未在他方工作树编辑/提交。

最小作业 **20261105032744-2c0383**：`commands.test.ts -t 'R12-03|throttles non-forced' --maxWorkers=1 --no-cache`，**4passed/1failed/13过滤，17.11s、exit1，无Errors/unhandled errors汇总**。唯一失败是`R12-03 timestamp owner failure warns after optimization and remains successful`的WARN buffer谓词；先前命令null、优化一次、真实owner save一次、setting无值断言均通过，不能描述成优化阶段失败，也尚不能区分无日志与观察/字段问题。其它四例及生产API/SQL所有权方向见L12 ACCEPTANCE §15。

已把原始失败和执行WIP边界回派L12，要求固定实现提交与实际WARN证据后只复核变化点；不降低Rust `lance_vector_store.rs:788-793`的WARN后继续要求、不新增全量重复任务。日志`/home/dsdev/.oc-jobs/done/20261105032744-2c0383.log`保留。R12-03仍未决，主线15组不变；这不是main集成红灯或此前RPC同根因的结论。

## settings-owner红项的固定候选复核（c28e272d4）

自动续派同步main f2c6d46c4为f3efe574a后，发现owner已提交固定修复；本轮不重复原四绿、前组6例/5+1。仅作业 **20261105035112-044faf** 执行原timestamp WARN失败及新增settings read-failure两例，**1文件2通过/17名称过滤、24.20s、exit0、无Errors/unhandled errors**。运行前后目标实现/测试/config与c28e272d4一致，仅BLOCKERS文档变化；候选非main祖先。

实际Cordis源码确认warn=level2，而无level配置的默认buffer exporter以level1过滤；新测试显式exporter levels.default=4，保留原WARN谓词并新增精确`[Lance优化] 记录 chat 上次优化时间失败: timestamp rejected`。这是观察接缝修复，不是生产WARN删除/改文案，也不解释历史RPC根因。新增读取默认值分支按Rust`.ok().flatten()`容忍真实settings表缺失，正常优化后时间戳保存失败仍WARN并返回成功；写操作仍交F4同conn。详见L12 ACCEPTANCE §16及日志`/home/dsdev/.oc-jobs/done/20261105035112-044faf.log`。

§15探索exit1保留，候选这两个子分支可签收；R12-03整组及正常main仍开，主线语义总数保持15。不把先前四绿重新计作本次两例或把外部Lance fixture当原生引擎测试。

## C2 settings-owner固定小集补齐（2026-11-05）

按C2最新指令复用本人035112-044faf的精确WARN/read-failure两条，避免重复；只补四个旧WIP探索用例，固定HEAD c28e272d4，执行前后host/contracts/package/config对固定树仍仅BLOCKERS文档差异。新作业 **20261105040042-379c36**，1文件**4通过/15名称过滤、13.07s、exit0、无Errors/unhandled errors**。

四例确认：空scope时间戳也写真实F4原连接；KB/chat路径回退经同连接、chat按path→timestamp写；路径INSERT trigger失败在向量优化前传播Database错误；原非force节流依赖真实持久时间戳且不重复优化。Rust依据lance_vector_store.rs:717-745,757-793,922-927，详细命令/源码/断言见L12 ACCEPTANCE §16末。原WARN谓词及exact断言在先前两例已经覆盖，本轮没有重新跑它们或前组6/5+1/additional-unit/425/711。

本次4＋同固定候选原2，共六条要求独立完成；原032744探索4/1/exit1保留历史，不用于冻结候选签收。Lance为外部fixture，不扩大到原生引擎或全F4；候选未main、R12-03其余所有权与两wire仍未决，总15组保持。完整日志`/home/dsdev/.oc-jobs/done/20261105040042-379c36.log`。

## R12-03.config-copy候选：删除副本而保留原断言

自动续派同步main cf92ce1eb为f14f07023；新L12候选99da3ecec含3e087ab85/185b88eb9，删除147行本地配置写SQL、validator及无生产引用的helper。真实生产配置命令此前已经走L11，未将此删除称为新增生产接线。

独立核对新测试经真实L11 indexingConfig、同conn写入，原十个错误文案和合法batch_size=25读取均保留，额外检查错误类/code/param；Rust embedding_repo.rs:911-1021,1044-1054对应。只验证实际样本，不由标题推导所有输入都覆盖。

本人 **20261105041644-ae0fe8**，只选`index-service.test.ts -t 'validates every published configuration key' --maxWorkers=1 --no-cache`：**1文件1通过/30名称过滤、10.25s、exit0、无Errors/unhandled errors**。运行前后目标实现/测试/契约/config无漂移，只有owner文档变化。完整log`/home/dsdev/.oc-jobs/done/20261105041644-ae0fe8.log`，细节见L12 ACCEPTANCE §17。

配置写入副本移除子项候选通过；未重复settings六例、前6/5+1/additional-unit，不修改或弱化测试。R12-03其它写表及主线集成仍未决，总组数保持15。

## R12-05：旧KB账本纠正与活跃维度解析复核

候选a7cf18fbf将rows_to_retrieved_input_dedup_semantics、clear_all_success_means_sqlite_and_every_lance_table_are_empty两行退回pending，原测试体/断言全部保留，无新skip/obsolete。实际候选77ported/2pending，不能沿用生成标头79/0当验收。独立检索Rust确认两被测旧分支仅旧VectorStore impl/退役迁移/测试引用；全仓未见VectorStore外部多态调用或auto_migrate_if_needed调用。详细ID/行号见L12 §18；approvals.json尚无这两项，支持提交C2裁定而不由R3代批。

活跃维度解析不在退役范围：Rust existing_dim_tables→parse_dim_from_table_name与TS ChatLanceStore聊天维护调用均存在，六个原输入/期望保留。本人 **20261105043638-b9fe1a** 只跑改接目标这一例：**1通过/2名称过滤，7.61s、exit0、无Errors/unhandled errors**；运行前后目标闭包无漂移。另两例未执行不报动态绿，未跑未变目录全套。日志`/home/dsdev/.oc-jobs/done/20261105043638-b9fe1a.log`。

这是测试真实性记账纠正及限定helper证据，不是R12-05整组/旧KB原生兼容或B级通过。主线候选集成与协调者审批仍待，15语义组保持。

## R12-06 marker策略的新候选复核

自动续派合并main eaa17bc7e为a36d9d1c8，官方gate仅自动选择typecheck/boundaries两项并通过；不是本轮目录测试结果。另对新候选9888d2148（实现caa36b7ce/917812ea6）仅执行两个新增marker触发器场景，未重复前组additional向量错误或其它已签集合。

Rust primary indexing.rs:2745-2764在profile后标记indexing失败只WARN，additional:3124-3140同一步则传播并进入3190后的回滚/discard。新角色参数限定这个差异，没有扩大吞掉profile/segment/final-state错误。真实SQLite触发器与L11仓储验证primary仍成功提交、additional回滚profile/generation且无Segment，向量discard请求和后续Unit继续均正确。logger与Lance依赖为记录/故障接缝，不签原生物理discard或全部日志；细节见L12 ACCEPTANCE §19。

本人 **20261105050113-cc676f**：`index-service.test.ts -t 'R12-06 indexing-state marker failure' --maxWorkers=1 --no-cache`，**1文件2通过/31名称过滤、14.01s、exit0、无Errors/unhandled errors**。执行前后目标源/tests/config无漂移，仅BLOCKERS文档不同。日志`/home/dsdev/.oc-jobs/done/20261105050113-cc676f.log`。候选仍非main，R12-06整组及15组主线未决保持。

## R12-06 primary恢复四分支与审批主线可见性

自动续派合并main6d759e81c为e33505964，官方gate四项全部通过。e4680aa8a祖先检查exit0、审批分片两精确ID内容已亲读，ledger会合并读取；已通知L12更新两旧KB去向，不扩批准范围、不重复旧测试。此为审批生效，不等R12语义整组完成。

本轮新候选ca2ac9d5d仅定向验证primary metadata失败恢复四分支，目标代码前后无漂移，差异仅BLOCKERS文档。Rust indexing.rs:2846-2901要求marker失败WARN后继续，metadata失败ERROR→尝试discard，discard失败再ERROR；非retryable才合并错误，retryable仍保原错误。四例覆盖该矩阵，真实SQLite拒绝Segment写及恢复标记写，验证原metadata回滚/无Segment/resource状态/日志顺序；retryable由owner接口故障注入，非真实并发CAS。Lance及logger为记录/故障接缝，不签物理向量回收或完整sink。

本人 **20261105052749-1f0863**：`index-service.test.ts -t 'R12-06 primary metadata recovery preserves error ordering' --maxWorkers=1 --no-cache`，**1文件4通过/33名称过滤、12.11s、exit0、无Errors/unhandled errors**。完整日志`/home/dsdev/.oc-jobs/done/20261105052749-1f0863.log`；源码/测试边界见L12 ACCEPTANCE §20。未重复此前marker两例或旧向量错误集合；候选非main、R12-06整组及15组未决保持。

## 新主线缺陷R11-07：正号配置跨字段读取（同B12-16）

本轮main/执行树仍3c9ec09a9/35c2e6758，已有该tip/base的selfgate通过记录，未无变化重复门禁。L12新报告只有既有恢复修复的正式提交，目标代码与已审ca2无diff；另对其B12-16静态报告作独立真实命令验证。

本人 **20261105060922-2be279，exit0**（反例观察完成，不是等价通过），真实F3/F4/L11/L12/L13/L13b临时宿主：先min=1、overlap=0；size="16"时overlap="16"按Rust拒绝；size="+16"也经正式命令合法保存后，同样overlap="16"却返回null成功，get命令读回"+16"/"16"。无直接SQL非法夹具，无业务替身，无未处理异常。

```text
plain size=16 overlap=16 rejected: Invalid argument 'chunking.chunk_overlap': Must be non-negative and less than chunking.chunk_size (16)
signed size=+16 overlap=16 accepted: {"ok":true,"value":null}
persisted through real command: +16 16
```

根因L11 embedding-repo.ts:150-170读取已存字段用`/^-?\d+$/`，而直接输入:85-91接受+号；Rust embedding_repo.rs:959-964,980-994用`parse::<i32>().ok()`，两者不等价。错误发生在唯一owner，L13b正确委托，删除L12副本仍是正确整改。完整证据/命令在L11 ACCEPTANCE §12及`/home/dsdev/.oc-jobs/done/20261105060922-2be279.log`。

此为新正式R11-07、与B12-16同源不重复计数，不把它混入R12-03整组或重新要求L12复制validator。请C2交L11授权写者修相同i32语法/default并保原跨字段顺序；未批准拒绝合法正号。当前未决L11/L12/L13b/vfs=**1/8/2/5，共16组**，其余候选/两wire/共享OCR许可边界不变。

## C2指定d77bd5dbd：Lance-disabled限定源码/回执复核

固定运行时0bba255b8、新PDF OCR测试c007d461a、规格d77bd5dbd；审读开始HEAD为d77，之后相对固定树仅BLOCKERS/LANE文档变化，目标source/tests/config无漂移。未合并提供方到R3，候选仍非main。本轮只复用指定原作业，未重复旧primary/owner-generation等集合或整个VFS。

独立确认：真实lanceLifecycle.enabled由index→runtime-adapter传入生产服务；batch在drain orphan/claim前disabled返回(0,0)，保原队列意图；已claim工作显式沿该轮true快照，下一轮可见late provider。单资源即使disabled仍同步文本及调用实际OCR recovery，OCR成功后第二次syncUnits，然后在chunk/embed/空内容indexed步骤之前停并保持pending。Rust依据indexing.rs:2439-2500,4452-4478。批内provider移除仅静态调用参数保证，没有冒称已动态模拟。

真实测试核对涵盖pending/orphan整行不变、晚到真实vector下一轮被识别、disabled文本可经retrieval搜索；新增c007 PDF OCR例断言syncUnits两次、ocr_pages_json及Unit文字持久化、pending/retry0/无Segment。OCR外部provider仍为确定输入，不签完整LLM或共享ocr_semaphore。L02 owner-error测试安装真实vectorPlugin并保留三错误/无Segment断言，disabled不能掩盖错误分支。

直接读取提供方原result（非本人新增运行）：

| 原job | 原始结果 | 证据边界 |
|---|---|---|
| 20261105075942-9653ee | Electron：index-service40＋owner-errors3，43passed、exit0、无Errors | 新PDF OCR例明确592ms；不是旧42条回执 |
| 20261105075942-a9b47d | Node目录：28文件通过/2失败、283passed/3failed、exit1 | log128/131明确新OCR例618ms通过，145为三owner错误例通过；三个reader/wire失败完整保留 |
| 20261105075942-9b5805 | typecheck exit2 | 仅L13 upload-attachment.ts:209 number\|null不能赋number\|undefined；未改权限外实现 |

三日志完整路径`/home/dsdev/.oc-jobs/done/<job>.log`，已亲取。Node三失败为IgnoredAny未知溢出数、f32最短十进制和percent:null成功响应契约，不能用Electron43绿关R12-08或整组。详细入口/行号及断言见L12 ACCEPTANCE §21。结论仅Lance-disabled子项候选通过，R12-01整组、真实桌面向量能力及16组主线未决保持。

<a id="vfs-audit-archive"></a>

## vfs补审归档（原ACCEPTANCE全文）

原文来源：`74b0a6dd2:host/plugins/vfs/ACCEPTANCE.md`。以下按原文保留，内部基线、候选与“本轮”均指各节当时审计，不自动升级为最新main结论。

<details open>
<summary>L13-vfs-api / vfs 独立验收完整记录</summary>

# L13-vfs-api / vfs 独立验收（R3-review-vfs，2026-11-04，v2补审）

结论：不通过

**最新正文快照/测试候选复核（c90fcd6c6）**：本人作业20261104123217-d787b8为5通过/67过滤、exit0、无Errors。R13v-05正文更新接L11 manual版本、旧快照/合并窗口、失败日志升级及回滚候选通过；R13v-06字面量测试子项修复、legacy tb与现代file路径夹具通过。尚未main签收；元数据/重命名本地写入、delete-batch与TESTMAP闭合等仍保留，见末节。

**最新删除/WARN候选复核（390e23572）**：`delete.ts` 同conn委托L10/L11及混合translation/mindmap回滚确认；真实media消费者WARN exporter断言确认。本人作业20261104115743-728705为7通过/9过滤、exit0、无Errors。但真实`dstu_delete_many`探针发现note已删而成员仍存活、text/mm仍indexed，登记 **R13v-01.delete-batch**（原组子项），详见末节。候选通过项不等于main签收，六组仍未决。

**后续小单元候选复核**：固定e9f0fc2a1（含e43715ca8报告、341201bf6 build_path实现、90d40c0ac mindmap创建实现），运行树abcf9501a。本人队列20261104113555-f55ba4为4通过/10过滤、exit0、无Errors。确认R13v-01.notes/mindmap创建委托与失败回滚、L13-BUILD-PATH-01根分支不取连接/原结果规则；仅候选子项通过，未进入本轮main对照4c6cd1ba8，组级R13v-01/03等不整组勾选。未把owner日志缺口或新delete候选当完成，详见文末。

授权：架构师v2补审分工及C2确认；仅新增本验收文档，不改实现/测试/SPEC/TESTMAP。固定正常main **eeaf5bdc7ae95a336c34b3a75b19f844726fe064**，已合到本工作树57b8270c6。下文 `T/`=host/plugins/vfs/，`R/`=src-tauri/crates/dstu-vfs/src/。依据standard-v2 §1八类硬规则与§2完成清单、contracts/ipc/L13-vfs-api.json、Rust源码/原断言、本人队列实测。未运行Rust。

## 必须修复

- [ ] **R13v-01（高，单写者，含X6同源发现）**：create/update/folders/locations另实现L10/L11仓储并直接写其表。X6具体点 `T/repository/create.ts:171` INSERT notes、`:175` UPDATE resources已独立确认；`src/dstu-create.ts:23-33,300` 真调用本地实现，index只inject storage。另 `repository/update.ts:79-84,450-465` 写resources/mindmaps；`repository/folders.ts:681-729,884-905` 写folder_items/resources/notes。必须通过notes/vfsRepo api 的业务WithConn方法保留原事务，不能仅将SQL搬到本插件repository称为所有权合格。Rust对应 `R/dstu/handlers.rs:1488-1554`、`R/dstu/folder_handlers.rs:207-221,348-364`，原owner `R/vfs/repos/note_repo.rs:480-592`、mindmap_repo.rs:540-790；D1/D4、standard-v2 §1.2。
  - **R13v-01.notes**：C2/X6派回的create note/resources小单元；L13已通知f4a22b3a6及8755b9a3a候选委托修复，但不在本固定main，本轮不按分支自述关闭。
  - **R13v-01.mindmap**：导图create/in-folder及事务回滚接L11，同编号子项；owner提议kernel invoke注入folder_items失败、验证resource/mindmap整体回滚且不发created，是必要对应证据，尚待提交/main复验。
- [ ] **R13v-02（高，完整性）DSTU删除等入口缺失，不能把注册子集当完成。** `T/index.ts:75-84` CRUD只注册dstu_create/update，无dstu_delete；Rust `R/dstu/handlers.rs:1664` 有真实删除命令（以及:5265 delete_many）。补齐业务委托/提交后清理或如实pending，不能让合法既有命令走not-found。`T/TESTMAP.md` 本地381行实际128ported/253pending，标头仍103/278。缺失命令本身不是Rust原死代码；没有相应deadProven批准证据。
- [ ] **R13v-03（高，日志/错误）文件夹/创建更新大量warn/error漏失；breadcrumb错误上下文合并。** `T/src/folders.ts:67-101` 校验只throw而无logger，对应Rust folder_handlers.rs:59-88、182-218；get/rename/delete等错误日志亦见Rust:255-260,301-322,358-364而TS:106-128无对应。`T/repository/folders.ts:777-794` 将prepare/query都映射Query failed，Rust folder_handlers.rs:946-961区别“数据库查询失败”/Query failed/Collect failed。`dstu-update.ts:275-280` OCC拒绝缺Rust handlers.rs:1503-1510 warn。恢复级别/关键字段和原错误上下文，不改变失败顺序。
- [ ] **R13v-04（高，运行时/省略分支）同步DB与媒体读取阻塞Host，streamed media提前路径缺失。** Rust folder_handlers.rs:149-153,245-265,506-543等spawn_blocking，TS folders.ts同步仓储。Rust dstu_create的流式媒体处理/提前返回与staged读取worker见handlers.rs:1235-1250（调用链始于try_create_streamed_media）；TS dstu-create.ts:154-219同步readBounded/base64/hash/store，无转写/流式专门分支。应通过正式worker/媒体owner保持取消/清理/边界，不用“有文件可读”替代。已确认TS staged的finally dispose存在，但不抵消分支缺失。
- [ ] **R13v-05（高，导图版本语义）dstu_update省略手动版本快照。** `T/repository/update.ts:394-397` 自述版本仅属Chat并不写快照，实际:399-469无mindmap_versions操作。Rust `R/dstu/handler_utils/content_helpers.rs:727-740` 明确传version_source=manual到VfsMindMapRepo.update_mindmap；`R/vfs/repos/mindmap_repo.rs:615-663` 内容变化前创建版本并按失败次数warn/error。这不是可省略分支，应复用L11真实更新方法，保证快照和OCC/事务一致。
- [ ] **R13v-06（中，测试真实性/账本）同名PORTED仍有测试自身字面量，且未闭TESTMAP不能算B。** `T/tests/paths.test.ts:36-39` 的test_simple_path_format仅断言模板字符串，不调用生产路径；`T/TESTMAP.md:62` 标ported。Rust原测试虽也是格式断言，v2要求迁到可达生产行为，已有buildSimpleResourcePath可用，不需新抽象。其他helper符号是否真实使用须分别核对，wiring模块绿不能整体签收；`TESTMAP.md:12` 标头和正文统计已漂移，253pending须按实际归属继续闭合（包含L13b权威映射同步，不全归本插件新增缺陷）。

## 建议

- [ ] 分小单元先接所有者，不顺手改变Rust默认/失败策略。L13报告“retrieval26过”需提供精确SHA/job；本审计只采用下列本人187测试结果，不采注册数或WIP报告。
- [ ] 使用共享rustTrim/时间函数，避免本地副本；这不是要求修掉Rust已有特殊路径行为。

## 已核实通过

- [x] 文件夹创建校验顺序、UTF-8长度、icon/color校验、root/空parent归一与Rust所查分支一致（T/src/folders.ts:58-103；R/dstu/folder_handlers.rs:159-194），但日志/线程另有问题。
- [x] 返回缺失folder为null，folder与item生成ID前缀长度、camelCase/Option省略的抽查断言真实调用生产构造/命令（tests/folders.test.ts:79-167）。
- [x] folder rename保留版本条件、move保留自父/后代/深度校验；路径缓存失效与基本移动行为测试使用真实临时SQLite，不是只断言对象（tests/folders.test.ts:218-264）。单写者仍须整改。
- [x] 新审插件index运行时导入通过，全部12文件187测试通过，wiring报告128条ported未接入0；不据此批准其余语义。

## 命令抽查：20条真实入口

表中“局部通过”只指明确列出的校验/返回分支；共同R13v-01/03/04已计问题，不虚称命令整体完成。所有命令对照契约L13-vfs-api；folder非Option bool不擅自按注释添加默认值。

| 命令 | TS入口/实现 | Rust入口 | 结论及重点 |
|---|---|---|---|
| dstu_folder_create | index:110-113; src/folders.ts:86-104 | folder_handlers.rs:136-224 | 类型/标题→icon→color→parent顺序局部通过；owner/线程/log问题 |
| dstu_folder_get | index:114-117; folders.ts:106-108 | :234-266 | 缺行null局部通过；error日志/线程缺失 |
| dstu_folder_rename | index:118-121; folders.ts:110-119 | :274-328 | title校验、读版本→条件更新；缺notfound warn/错误error |
| dstu_folder_delete | index:122-125; folders.ts:121-129 | :337-369 | 级联软删本地副本，直接写notes/其他owner；不是dstu_delete已实现 |
| dstu_folder_move | index:126-129; folders.ts:131-139 | :383-416 | 自父拒绝、NULL根、深度/后代局部通过；同步执行/日志缺 |
| dstu_folder_set_expanded | index:130-133; folders.ts:141-146 | :425-451 | bool透传、unit结果null；本地写表/线程问题 |
| dstu_folder_add_item | index:134-137; folders.ts:148-164 | :472-544 | 8种类型→folder存在→新item，默认folderId NULL；warn/error未保留 |
| dstu_folder_remove_item | index:138-141; folders.ts:166-171 | :554-580 | canonical类型删除规则有测试；本地SQL/错误logger问题 |
| dstu_folder_move_item | index:142-145; folders.ts:173-183 | :589-627 | 目标NULL可根、索引pending保留；本地写resource/同步 |
| dstu_folder_list | index:146; folders.ts:185-187 | :638-663 | 只列存活、排序局部通过；错误传播缺日志 |
| dstu_folder_get_tree | index:147; folders.ts:189-191 | :670-695 | 树/成员真实SQLite测试；同步遍历/错误日志缺 |
| dstu_folder_get_items | index:148-151; folders.ts:193-195 | :705-730 | Optional folder根分支透传；owner/线程缺 |
| dstu_folder_get_all_resources | index:152-155; folders.ts:197-220 | :763-805 | include flags透传，>50 warn保留；其他错误日志/线程缺 |
| dstu_folder_reorder | index:156-159; folders.ts:222-227 | :818-849 | sort_order数组顺序；直接写表/错误log缺 |
| dstu_folder_reorder_items | index:160-163; folders.ts:229-234 | :859-885 | IPC接folderId但TS实现忽略，需owner按原reorder API接入；不批准本地副本 |
| dstu_folder_get_breadcrumbs | index:164-167; folders.ts:236-241; repository/folders.ts:777-794 | :911-975 | CTE depth<11/根向下顺序保留；prepare/collect错误扁平化 |
| dstu_create | index:213-219; src/dstu-create.ts:221-374 | dstu/handlers.rs:727-1425 | 名称/content/metadata上限存在；写notes/resources越权、stream媒体分支省略 |
| dstu_update | index:221-228; src/dstu-update.ts:260-355 | dstu/handlers.rs:1439-1653 | note毫秒OCC与lease分支存在；另写owner算法，导图版本快照缺失 |
| dstu_delete | index:75-84无注册 | dstu/handlers.rs:1664 | 问题R13v-02：既有命令缺入口 |
| dstu_move_to_folder | index:177-180; src/locations.ts:148-162 | dstu/handlers.rs:6138-6247 | 返回location/移动事件在写后；本地SQL且Rust spawn_blocking丢失 |

## TESTMAP真实性：16条逐断言抽查

下列10条folder测试来自TESTMAP:25-34；6条path测试来自:71-76。表中Rust文件均在R/dstu下。test_*指完整用例，不按“含该名字”证明迁移。

| 原测试 | Rust文件:行 | TS tests文件:行 | 对照结论 |
|---|---|---|---|
| test_valid_item_types | folder_handlers.rs:988 | folders.test.ts:79 | 通过核心断言；经invoke覆盖原5类型，扩展3个生产合法类型及非法拒绝 |
| test_folder_id_format | :996 | :92 | 通过：真generateFolderId，fld_和14长度 |
| test_folder_item_id_format | :1003 | :98 | 通过：fi_和13长度 |
| test_title_validation | :1010 | :104 | 通过：原空/空白/过长三判断迁为真实拒绝，未弱化 |
| test_folder_constraints | :1025 | :111 | 通过：生产使用常量10/500/100，原值未改 |
| test_folder_error_codes | :1032 | :117 | 通过：四个原错误常量逐一对应 |
| test_vfs_folder_new | :1040 | :124 | 通过：所有原字段，TS额外favorite=false；created>0且updated=created覆盖updated>0 |
| test_vfs_folder_item_new | :1060 | :138 | 通过：原6条语义均有对应 |
| test_vfs_folder_serialization | :1076 | :148 | 通过：真实构造结果序列化，4个camel字段+3个省略逐一对应 |
| test_vfs_folder_item_serialization | :1094 | :160 | 通过：4个camel字段、folderId省略 |
| test_parse_real_path_root | path_parser.rs:416 | paths.test.ts:44 | 通过：5个Rust字段保证均有断言 |
| test_parse_real_path_empty | :427 | :49 | 通过：空串root |
| test_parse_real_path_single_folder | :434 | :50 | 通过：非root/非virtual、full/folder、无resource |
| test_parse_real_path_multi_folder | :445 | :55 | 通过：4个原保证 |
| test_parse_real_path_resource_at_root | :455 | :60 | 通过：root=false、无folder、有ID/type |
| test_parse_real_path_resource_in_folder | :465 | :64 | 通过：full/folder/ID/type/非root |

生产可达：folder constructor/ID由src/folders.ts:100,160调用；parseRealPath由src/path-utils.ts:55调用，进入get/content等命令。以上原行为断言真实性通过，不能抵消所测本地仓储跨owner问题。额外抽到test_simple_path_format仅测字面量（R13v-06）。本地实际128ported/253pending（标头103/278过期），无实际obsolete/merged行；全L13统计含其他目录映射，不能给vfs子插件假造100%。

## 亲自运行 / 门禁

```text
job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/vfs/tests --maxWorkers=1 --no-cache
job.mjs result 20261104110705-6def19 --tail 200
Test Files  12 passed (12)
     Tests  187 passed (187)
  Duration  33.85s
[作业 20261104110705-6def19] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110705-6def19.log

node scripts/electron-migration/importable.mjs host/plugins/vfs/index.ts
importable: ok
node scripts/electron-migration/wiring.mjs --lane vfs
合计 ported 128，其中所测模块未从 index.ts 接入 0（0.0%）
```

Vitest原输出无Errors/unhandled errors。首次补审按要求跑本插件目录一次，不运行全仓测试。类型检查作业20261104105931-ea5d18 exit0；boundaries 20261104105931-12f575 exit0、2382文件0violation/178suppressed。旧扫描器未拦截单写者不代表v2通过；本轮没有改实现或测试去迎合门禁。

## v2八类结论与已登记差异

1. 接线：注册子集可达，dstu_delete未接（R13v-02）。
2. 所有权：不通过（R13v-01），X6 notes/resources小单元确认；消费者WithConn允许，消费者SQL不允许。
3. 数据边界：样本folder Option/camel通过；create/update内本地JSON/数值转换与typed decoder未全闭合，不能凭类型断言通过。
4. 日志/错误：不通过（R13v-03）。
5. 测试：16条抽查核心断言同义，另1条字面量及pending闭合问题（R13v-06）。
6. 完整性：不通过（R13v-02/04/05）。
7. 运行时：不通过（R13v-04）；staged finally清理正确，但阻塞/流水线省略不是已批准差异。
8. 闭环：本轮为main独立审读+生产入口测试，未批准任何owner分支候选；待finding ID修复进入main后定向复验。

平台已裁定的毫秒时钟/原生引擎差异不能解释省略快照、日志、删除命令或单写者违规。本轮不发明平台豁免；六组未决，B不成立。

## 候选增量：build_path与创建owner（2026-11-04）

修复树固定 **e9f0fc2a1d1bb4859e97d27dc8b5c7df23300c38**，包括e43715ca8报告、341201bf6代码、90d40c0ac代码；实际运行树 **abcf9501a222300af57deaf5e3b3db9c3dce4715**。相关index/services/create/locations及这两测试文件、L10/L11实现无diff；运行树额外delete等变化不纳入本小单元。main对照4c6cd1ba8，候选非祖先（exit1），按v2只记录候选验证，等待main复验。提供方未提交变化仅BLOCKERS/LANE/SPEC，未读入未提交实现。

### R13v-01.notes / R13v-01.mindmap

- 候选 `repository/create.ts:153-174` 的notes creation已是 `notesRepository().createNote/createNoteInFolder(...,conn)`，旧main:171/175的直接notes/resources写入在该候选小方法中已删除。不会再按旧主线样例重复派修这两个方法。
- `repository/create.ts:405-418` 两个mindmap创建方法直接调用L11同名WithConn；`index.ts:137-143` 必需inject notes/vfsRepo/vfsIndex并配置真实服务，不是可选存在才用owner、否则本地SQL。
- owner `vfs-repos/repository/mindmaps.ts:269-287,333-363` 保存点/BEGIN IMMEDIATE、检查folder、创建resource/mindmap/成员、COMMIT，失败整体回滚；对照Rust `R/vfs/repos/mindmap_repo.rs:439-488`。消费者仍在create返回后emit created。
- `tests/dstu-create.test.ts:10-16,38` 安装真实paths/notes/repos/index/vfs；新增`:239-261` 经kernel invoke设置folder_items trigger失败，断言mindmaps=0、resources计数不变、成员0、created事件不增加；移除trigger后断言资源和folder指针、事件+1。真实生产owner/事务，未把业务主体stub掉。本人执行该用例及原notes创建用例均通过。
- **边界**：仅签收小单元所有者委托/正常结果/回滚事件候选；其他create分支/更新/级联仍按R13v-01分组待修；owner创建info/debug等日志缺口已由L13请求L11，未因此批准日志全等价。

### L13-BUILD-PATH-01（关联R13v-01/03子项，不重复计组）

候选 `src/locations.ts:79-96`：先info入口，folderId=None直接空folder路径、不取连接；Some时通过L11 folders.buildFolderPath；拼接保留原resourceId及无前导slash的folder路径，再info结果。对照Rust `R/dstu/handlers.rs:5930-5955`。`tests/locations.test.ts:59-65,92-107` 经invoke验证null/缺省、层级/不存在folder，以及getConnSafe故障时None仍成功、Some才拒绝；两错误入参被kernel拒绝且连接调用次数不增。日志两点已静态对应，测试未额外断言sink，不虚报日志动态覆盖。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/locations.test.ts host/plugins/vfs/tests/dstu-create.test.ts -t "dstu_build_path|rolls back owner mindmap|creates notes with tags" --maxWorkers=1 --no-cache
job.mjs result 20261104113555-f55ba4 --tail 140
Test Files  2 passed (2)
     Tests  4 passed | 10 skipped (14)
  Duration  34.31s
[作业 20261104113555-f55ba4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104113555-f55ba4.log
```

无Errors/unhandled errors；10条仅-t过滤，未改测试skip。未等全目录CPU争用、不重跑整插件，不引用owner Node/Electron“13/7通过”作本验收结果。

L13随后通知41a804a2c的delete.ts所有者委托及修正夹具后作业20261104112652-93c64b，本轮仅登记待审候选；未将删SQL数量、6通过自述或新增注册命令扩大为R13v-02/删除全链通过。六个组级问题保持未勾选，待main单元复验。

## 候选增量：删除owner与真实WARN exporter（2026-11-04）

固定 **390e23572c9cd09bac23537ce585701cd925e4f0**，实现链41a804a2c（删除委托）、abcf9501a（新增合法导图夹具）、390e23572（exporter断言）；不是把报告提交当实现。与本轮main对照 **4c6cd1ba8f377e7200310ae1930fe7def9c61ee3** 的祖先检查exit1，仍为候选。运行前提供方干净；运行后相关删除/媒体实现及两测试相对固定SHA无diff，随后出现的SPEC、paths.test.ts、update.ts、dstu-update.test.ts改动不作为本轮修复证据。Rust仅静态阅读。

### 已确认的局部修复

- `T/repository/delete.ts` 全文件无INSERT/UPDATE/DELETE/REPLACE语句，软删除方法直接委托L10/L11并传原conn，未留本地写fallback。`src/dstu-delete.ts` 的单删除入口真实调用这些方法，六条删除测试经kernel和真实仓储通过；因此旧“该候选没有dstu_delete入口”的描述不再适用。主线基线与R13v-02整组结论仍独立保留。
- `tests/dstu-delete.test.ts` 混合translation/mindmap用例在真实`dstu_delete_many`外层事务中注入失败，验证owner保存点不提前提交、失败回滚；此用例覆盖的是这两种资源，不能代表note/textbook分派。
- `tests/media-index.test.ts:125-143` 安装真实media插件，经`ctx.mediaTranscriber.transcribe({ imported:true, ... })`执行，SQLite trigger令索引刷新失败，仍断言成功、转写持久化、无索引单元；通过真实`ctx.logger.exporter({levels:{default:3},export:...})`断言`name=media.commands/type=warn/level=2`、`[media::pipeline] refresh transcript index failed for %s: %s`、file_media及SQL错误字段。没有mock logger或只断言测试自身消息。
- 生产`host/plugins/media/index.ts:757-766` catch后warn并继续，对照`src-tauri/crates/dstu-media/src/media/pipeline.rs:343-351`的best-effort语义。**确认此失败分支日志与继续行为的候选证据**；imported路径不证明完整ASR，也不证明日志文件落盘或全部日志等价。L11创建日志b03e1753f本轮未复验。

### R13v-01.delete-batch：owner选择仍不等价（保持未决）

`T/src/dstu-trash.ts:140-159` 的`deleteResourceByTypeWithConn`绕过上述delete.ts，对note调用`notesRepository().deleteNote(id,conn)`，对textbook调用`textbooks.deleteTextbook(conn,id)`。Rust `R/dstu/handler_utils/delete_helpers.rs:118-172` 对应调用的是两个 **WithFolderItem** 方法；`R/dstu/handlers.rs:5339-5353`在真实批量事务中使用该helper。

L10 `host/plugins/notes/repository/notes.ts:696-704`基础方法只软删note；`:729`起WithFolderItem才处理成员及索引。Rust `R/vfs/repos/note_repo.rs:2367-2425`明确同保存点软删成员并禁用text/mm单元。本轮真实note反例：

```text
job.mjs result 20261104115847-4672f4 --tail 160
deleted_count=1
{"note_deleted":"2026-11-04T11:58:54.112Z","membership_deleted":null,"text_state":"indexed","mm_state":"indexed"}
[作业 20261104115847-4672f4] 退出码 0
```

脚本使用真实createPaths/notes/vfs-repos/vfs-index/vfs插件及临时迁移库，invoke创建folder/note，种入indexed单元，再invoke `dstu_delete_many`并联查实际状态。完整脚本在job result命令字段，日志`/home/dsdev/.oc-jobs/done/20261104115847-4672f4.log`；无Errors/未处理异常。**exit0仅表示反例观察完成，不是等价通过**。textbook为静态映射确认，未宣称另有动态探针。

回派最小修复：将两处分派接现有owner的WithFolderItem方法并保留同conn/外层事务；经真实batch入口验证成员软删和索引禁用。此为原R13v-01所有者交接的语义子项，关联R13v-02完整性，不新增重复组。

### 本人最小队列结果与历史失败

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/dstu-delete.test.ts host/plugins/vfs/tests/media-index.test.ts -t "dstu_delete|mediaTranscriber preserves transcript success" --maxWorkers=1 --no-cache
job.mjs result 20261104115743-728705 --tail 160
Test Files  2 passed (2)
     Tests  7 passed | 9 skipped (16)
  Duration  19.45s
[作业 20261104115743-728705] 退出码 0
```

无Errors/unhandled errors，仅WASI experimental提示；9条为-t过滤。完整日志`/home/dsdev/.oc-jobs/done/20261104115743-728705.log`。这是本人Node最小复验，不把owner报告的Electron16例、tsc/strict/importable/ledger算作本人执行。

保留owner LANE历史失败：20261104112230-b99275为1失败/44通过、exit1（新增导图夹具为空，尚未进入删除路径）；20261104114338-a49361为1失败/9过滤、exit1（默认buffer阈值不收WARN）。合法夹具修正及显式真实exporter配置未改业务断言；前述独立结果确认当前相应路径，不抹去旧失败。六组问题仍未整组签收。

## 候选增量：R13v-05正文版本与R13v-06生产路径测试（2026-11-04）

固定提供方 **c90fcd6c6fb8892c90d95641c5989dc262b4994d**（实现4c3a7205c/acb015f93及前序路径夹具修复，70c6b1412是报告提交）。执行前工作树干净，完成后host/contracts/配置相对固定SHA无diff。该候选不是本轮main **45c3250b0d4bd67ade44c04fcab27e650db86c13** 祖先（exit1）；仅候选复验，不把owner Node/Electron报告代作本人结果。

### R13v-05正文manual快照：候选通过待main

- `repository/update.ts:542-567` 的`updateMindmapContentWithConn`直接委托L11 `mindmaps.updateMindmapWithConn(conn,id,{content,expectedUpdatedAt,versionSource:'manual'})`。`src/dstu-update.ts:288-295`真实OCC正文入口使用此方法，成功返回后才发updated事件；对应Rust `R/dstu/handler_utils/content_helpers.rs:697-746`。
- L11 `repository/mindmaps.ts:371-463`经BEGIN IMMEDIATE→读当前/OCC→保存旧内容版本→写正文→COMMIT；失败ROLLBACK。manual快照失败继续，前两次warn、连续第三次error，成功快照重置计数；对应Rust mindmap_repo.rs:615-665。内容共享时COW仍由owner处理。
- 新增三用例`tests/dstu-update.test.ts:411-465`安装真实paths/notes/repos/index/vfs，经kernel invoke驱动。分别断言旧内容快照、共享资源COW及合并窗口保留同一version；真实trigger拒绝版本INSERT后正文仍提交、真实exporter捕获warn/warn/error及mindmap/error/consecutive字段；最后mindmaps UPDATE失败则版本与正文整体回滚且事件数不增加。没有mock被测仓储，也未删除既有断言。
- 仅在owner拒绝content的InvalidArgument后翻译JSON语法错误文案，保留owner NotFound/OCC优先；本次最小集没有重跑完整JSON/OCC错误矩阵，不宣称全部解码等价。
- **剩余所有权明确保留**：`repository/update.ts:440-539`本地更新副本仍被`src/dstu-metadata.ts:458`和`src/dstu-move.ts:148`使用。正文快照修复不等于R13v-01 update.ts全部单写者合格；R13v-01.delete-batch两处基础删除分派也未改变。R13v-05本项候选证据已满足，主线勾选仍待集成复验。

### R13v-06字面量子项与路径夹具：候选通过

`tests/paths.test.ts:36-39`将模板字符串断言改为生产`buildSimpleResourcePath(id)`，原输入`note_abc123`及期望`/note_abc123`不变；生产可达见src/node-converters.ts:234,284与src/dstu-list.ts:385等调用。字面量子项确认修复；TESTMAP pending/统计闭合仍独立未决，不能因此整组勾选。

`tests/service-wiring.test.ts:95-108`用真实legacy `tb_def456` files行保留原`/教材.pdf`标题断言，另由现代textbook工厂创建file_并断言IDfallback；其余前缀断言保留。Rust handlers.rs:1259-1303仅tb查标题，textbook_repo.rs:136-137生成file_，此夹具区分正确。原owner作业20261104120752-5b6d74的1失败/6过滤、exit1仍保留为修复前证据；本用例的通过不能替L13b同构paths.test.ts未集成修复签收。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13-vfs-api -c /home/dsdev/dev/ds-mig/L13-vfs-api/vitest.host.config.ts host/plugins/vfs/tests/dstu-update.test.ts host/plugins/vfs/tests/paths.test.ts host/plugins/vfs/tests/service-wiring.test.ts -t "R13v-05|test_simple_path_format|test_source_id_prefix_parsing" --maxWorkers=1 --no-cache
job.mjs result 20261104123217-d787b8 --tail 120
Test Files  3 passed (3)
     Tests  5 passed | 67 skipped (72)
  Duration  33.44s
[作业 20261104123217-d787b8] 退出码 0
```

已读取result；原日志`/home/dsdev/.oc-jobs/done/20261104123217-d787b8.log`，无Errors/unhandled errors。67条为-t过滤，未改skip。六组主线未决数量不变；R13v-05为候选通过待main，R13v-06仅字面量子项通过。

</details>
