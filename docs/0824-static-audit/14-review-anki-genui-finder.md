# 14 — 互审：04-anki-flashcards / 05-genui-hpias / 06-finder-hub

- 评审人模型：claude-fable-5-thinking-xhigh。
- 评审对象：`docs/0824-static-audit/04-anki-flashcards.md`、`05-genui-hpias.md`、
  `06-finder-hub.md`（均不改动原文）。
- 方法：只读静态互审。对三份报告的关键断言逐条回到当前树源码复核
  （Read/Grep/Glob），未运行测试、未编译、未执行任何 git/gh 命令。
- 本轮约束：仅新增本文件；因禁用 git，05 号报告中的 git 谱系断言无法独立重放，
  只能核对其文档交叉引用的一致性（见 §2.3）。

## 结论

**三份报告全部通过互审：04 的 WARN、05 的 PASS、06 的 PASS 判定方向均正确，
关键断言经源码逐条复核成立，无需推翻或降级任何一份。**

- 04（Anki/Flashcards，WARN）：三项确定性问题全部坐实——`enableQaPass=false`
  的实现与公开契约不一致、卡住任务恢复的 UI 文案（1 小时/待处理）与后端实际
  （10 分钟/`Paused`）双重错位、删除会话确认态只显示"确认?"而完整风险文案是
  死词条；"保存到卡库"确为无消费者的死 i18n key。PASS 面（QA 主链、opt-in
  critic、图像遮挡、GenUI 闪卡只读、`ChatV2AnkiAdapter` 退役、可空 JSON 兼容）
  逐项与源码相符。仅一处措辞可精确化（不影响结论，见 §1.2）。
- 05（GenUI/HPIAS，PASS）：18 块白名单"恰 18"在 Rust 常量、Rust 单测
  `Some(18)`、前端 18 次注册三处逐一数实；executor 注册位置在 catch-all 前、
  HPIAS 定向桥 fail-closed、`guardedListen` 精确匹配白名单、researchStore
  多会话切片、技能定义与双语词条全部在位。两处 dev-only/下界断言的观察项
  报告已如实自曝，不构成隐瞒。git 谱系断言本轮受限未重放，但其引用的
  `docs/0824-MERGE-PLAN.md:98/598` 与 `docs/dev/0824-leftover-audit.md:18`
  （INCLUDE 24 / ALREADY 6 / DROP 9）实测与报告一致。
- 06（Finder/Learning Hub/笔记，PASS）：六宿主分桶、仅 `files` 映射 default
  桶、四字段持久化白名单 + `merge` 二次清洗、旧单例键继承、registry 同宿主
  复用/异宿主隔离、活跃宿主订阅、真实宿主接线（Files/page/page-mobile/
  canvas/canvas-mobile/group-picker）、Workbench 壁纸与平铺边距限幅
  （0–40/0–0.6/0–32）、笔记资源树分页（1000/20000）与截断语义、undo 栈上限
  20——全部与源码一致；两侧契约测试文件实际存在。

三份报告均已包含 `## 结论` 与"本轮不改代码"声明，且 05/06 的"仅新增文档"
自述与其内容相符。评审发现的全部问题都是措辞精度或行号 ±1~2 行的漂移，
不改变任何判定。

**本轮不改代码。** 本互审仅新增本 markdown 文件，未触碰三份原文、产品代码、
测试或配置。

## 1. 对 04-anki-flashcards.md 的复核

### 1.1 逐条核实结果

| 04 的断言 | 复核结果 |
| --- | --- |
| `enableQaPass=false` 先删字段规则 `_qa_flags`，随后确定性 lint 不受开关保护 | **成立**。`src-tauri/src/streaming_anki_service.rs:1904-1907` 仅在 `!qa_pass_enabled` 时 `remove(QA_FLAGS_FIELD)`；紧随其后的 `1944-1968` 构造 lint 输入、执行 `lint_card` + `observe_document_card` 并调用 `merge_flags`，整段没有任何 `qa_pass_enabled` 条件。源码注释自称"校验本身照跑，仅不落盘"，但违规卡仍会经 `merge_flags` 落盘，实现连自身注释都不完全符合 |
| 公开契约称 false = "不要 QA 留痕" | **成立**。`src/features/chat/skills/builtin/index.ts:283-287`（run 定义）明文"仅在用户明确不要 QA 留痕时传 false"；`src-tauri/src/anki_protocol.rs:103-117` `enable_qa_pass` 缺省 `true` |
| 恢复卡住任务：UI 说"超过 1 小时、重置为待处理"，后端 10 分钟、写 `Paused` | **成立**。`src/locales/zh-CN/anki.json:780` `recoverStuckHint` 原文如此；后端 `src-tauri/src/database/mod.rs:7307-7309` 默认调 `recover_stuck_document_tasks_older_than_minutes(10)`，`7323-7326` UPDATE 写 `status = 'Paused'`；前端 `src/features/anki-tasks/AnkiTasksApp.tsx:295-310` 单击直调、无确认。阈值与目标状态双重错位属实 |
| 删除会话：3 秒二次点击，确认态只显示"确认?"，完整风险文案是死词条 | **成立**。`src/features/anki-tasks/components/SessionRow.tsx:148-158` 二次点击 + 3s 超时复位；`:358/:368/:443` 确认态均消费 `taskDashboard.confirmDeleteHint`（`anki.json:776` = "确认?"）；`anki.json:763` 的 `confirmDelete`（"相关数据将被清除"）在 `src/features/anki-tasks` 无任何消费者。后端 `src-tauri/src/database/mod.rs:6013-6046` 确在单事务内物理删除 `fsrs_review_logs`、`fsrs_card_states`、`anki_cards`、`document_tasks` 四表 |
| critic 为 opt-in，默认关闭，失败降级不阻断 | **成立**。`src-tauri/src/chat_v2/tools/chatanki_executor.rs:11008-11009` 注释与透传明确"默认关闭；仅 run/start 显式 true 时开启"；`streaming_anki_service.rs:659-685` 仅当 `critic_enabled() && card_count > 0` 才跑，且注释锁定 `run_critic_pass` 永不返回 Err；技能 schema `builtin/index.ts:288-293` `default: false` |
| GenUI `FlashcardPreviewBlock` 只读、无保存按钮 | **成立**。`src/features/generative-ui/components/FlashcardPreviewBlock.tsx:7-13` props 仅 id/front/back/tags/deckName；`:17-55` 只渲染 `Card`/`Badge`/文本，全文无 `Button`、`onClick` 或任何 invoke；`blocks/index.ts:89-94` 仅注册预览组件；`tests/vitest/generative-ui/flashcardDisplayOnly.test.ts` 存在 |
| 无生产 `ChatV2AnkiAdapter` | **成立**。全 `src/` 检索仅命中退役注释与负向守卫测试（`cardGenerationSurfaces.source.test.ts`、`pdfSelectionToolbar.source.test.ts` 等），无模块文件、无 import |
| 三个可空 JSON 列读侧 + 迁移双重兼容 | **成立**。`database/mod.rs:242-273` 与 `:278-309` 均把 `tags_json`/`images_json`/`extra_fields_json` 读为 `Option<String>` 且坏值 `unwrap_or_default()`；`src-tauri/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql:11-21` 只归一化 NULL/空串、注释明确保留有效 `_qa_flags`/`_occlusion` 字节不变，`:25-31` 兼容来源字段 NULL |
| "保存到卡库"是死 key | **成立**。`chat_anki_panel` 分组仅存在于 `src/locales/zh-CN/common.json:3099-3161`（`action.save` 在 `:3151`）与英文对称文件；`src/**/*.{ts,tsx}` 无任何 `chat_anki_panel` 命中 |

### 1.2 评审意见（不降级）

1. **一处措辞建议精确化**：04 结论第 1 条与 §1 说 `enableQaPass=false` 后
   "仍无条件运行确定性 lint 并重新写入 `_qa_flags`"。复核确认 lint 确实无条件
   运行，但写回并非无条件：`src-tauri/src/anki_qa_lint.rs:389-392` 的
   `merge_flags` 在"零违规且无既有 key"时不写字段（单测
   `merge_flags_no_issues_no_key` 锁定"干净卡片不写 `_qa_flags`"）。精确语义
   是"违规卡仍会被写回留痕"。这不影响 WARN 判定——契约承诺"不要 QA 留痕"
   而违规卡仍留痕，偏差真实存在——但后续修复文案时应按精确语义描述。
2. 行号引用普遍可查，个别 ±1 行漂移（如 `delete_document_session` 实际起于
   `database/mod.rs:6013`，报告写 6012），不影响定位。
3. 04 对图像遮挡的"PASS（当前草稿/预览范围）"限定与 §3 的"非完整原生闭环"
   声明边界清晰，未见夸大；本轮未逐行重放 `imageOcclusion.ts` 全部校验分支，
   但其入口/组件文件与报告引用的路径、职责一致。

## 2. 对 05-genui-hpias.md 的复核

### 2.1 逐条核实结果

| 05 的断言 | 复核结果 |
| --- | --- |
| Rust 入口白名单恰 18 项 | **成立**。`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42` 逐项清点为 18 个 type，与报告列举完全一致；`:20-21` `MAX_GENERATIVE_UI_BLOCKS = 32`、`MAX_GENERATIVE_UI_INTENT_CHARS = 256_000` |
| Rust 单测断言 `Some(18)`，另有三个拒绝单测 | **成立**。`generative_ui_executor.rs:682-701` `parse_intent_accepts_all_registered_block_types` 在 `:694-700` 断言 `Some(18)`；`:645/:658/:670` 分别拒绝未知型、缺 type、非对象块 |
| 前端注册表恰 18 次 `register` | **成立**。`src/features/generative-ui/blocks/index.ts:37-172` 逐块清点 18 次，type 集合与 Rust 侧一一对应；`flashcard-preview` 在 `:89-94` 仅挂只读预览组件 |
| executor 在 catch-all 前注册，工具名映射正确 | **成立**。`src-tauri/src/chat_v2/pipeline.rs:347` 注册 `GenerativeUiExecutor`；`:404-411` `Arc::new_cyclic` 内最后注册 `ToolPackExecutor` 与 `GeneralToolExecutor`（`:408` 注释 "must be last (catch-all)"）；`:451` `"render_generative_ui" => block_types::GENERATIVE_UI` |
| 定向桥 fail-closed 三情况丢弃 | **成立**。`src/features/generative-ui/bridge/hpiasEventBridge.ts:106-117` 对缺失 `session_id`、非字符串、不匹配三种情况一律 return，注释明确这是对旧穿透行为的修复 |
| 单一共享 HPIAS listener | **成立**。`hpiasEventBridge.ts:134-159` 引用计数共享订阅，`:161-165` 测试重置钩子 |
| `hpias_event` 走精确匹配白名单 | **成立**。`src/utils/guardedListen.ts:27-32` `GUARDED_LISTEN_EXACT_NON_CHAT_EVENTS` 含 `hpias_event`，`:46` 以 Set 精确匹配（非前缀）；`tests/vitest/guardedListenAllowlist.test.ts` 存在于 `tests/vitest/` 根 |
| store 多会话切片 + reset 保留其它切片 + 外会话只写切片 | **成立**。`src/stores/researchStore.ts:100-101` `sessions` 切片声明；`:162-183` `reset` 以 `{ ...state.sessions, [sessionId]: slice }` 合并保留；`:241-269` 外会话事件（含 `session_started`）只写 `sessions[id]` 并提前 return，不触顶层字段 |
| 技能定义、18 型清单、闪卡禁保存规则、双语词条 | **成立**。`src/features/chat/skills/builtin-tools/generative-ui.ts:49` 逐字列出同一 18 型；`:68` Research 块必须带 researchSessionId、无合法 id 不订阅 `hpias_event`；`:69` "flashcard-preview 仅用于展示；禁止添加保存 action"；`src/locales/zh-CN/skills.json:395/450` "生成式界面" 名称与描述在位 |
| leftovers 对账 INCLUDE 24 / ALREADY 6 / DROP 9，且未恢复 save-to-library | **成立**。`docs/dev/0824-leftover-audit.md:18` 处置总计原文一致，`:16-17` 明文"没有恢复 save-to-library handler、文案或 locale key"，`:22-49` INCLUDE 24 行逐 SHA 齐全 |
| `docs/0824-MERGE-PLAN.md` 引用 | **成立**。`:98` 记录 `c16a4fbd` → merge `23090166`；`:598` 记录"#214 全部 30 提交 SKIP"及三分处置理由，与 05 §1 转述一致 |

### 2.2 评审意见（不降级）

1. 05 的两条观察项（`guardedListen` 断言仅 dev 生效、Rust 映射契约是下界
   断言）经复核均属实且报告已主动披露（`guardedListen.ts:59-64` 确为
   `import.meta.env.DEV` 门；下界断言确由 Rust `Some(18)` 计数与前端
   `toEqual` 精确集合分别封死），披露口径与源码一致，属诚实的边界声明。
2. `normalizeHpiasEventPayload`（`hpiasEventBridge.ts:76-87`）仅校验 `type`
   为字符串的观察项也属实；session 维度确由桥过滤与 store 切片承担。
3. 行号微偏：Rust `Some(18)` 单测函数体起于 `:682`（报告写 693-700 指断言
   段），拒绝单测起于 `:644`（报告写 640-679），均在可查范围内。

### 2.3 本轮无法独立复核的部分（如实声明）

05 §1 的 git 谱系断言——`origin/Generative-UI-0824` tip `c2786d4b` 非 HEAD
祖先、`HEAD..origin/Generative-UI-0824` 恰 30 个独有提交、产品面 9 文件
diff 逐项比对——依赖 `git merge-base`/`git diff` 实测。本轮互审被明确禁止
执行 git 命令，无法重放这些实测；能做的替代校验（MERGE-PLAN `:98/:598`、
leftover-audit `:18` 的记录与 05 转述一致；树上 fail-closed 桥、i18n 护栏、
无 save-to-library handler 等"0824 更强版本"的落点全部实见）均通过。
因此对该节维持"文档交叉一致、树上落点属实、谱系数字未独立重放"的评审
口径，不构成对 05 判定的削弱。

## 3. 对 06-finder-hub.md 的复核

### 3.1 逐条核实结果

| 06 的断言 | 复核结果 |
| --- | --- |
| 六宿主 ID，仅 Files 映射 default 桶，其余独立桶 + 命名空间键 | **成立**。`src/features/learning-hub/stores/finderStore.ts:388-401` 定义 files/page/page-mobile/canvas/canvas-mobile/group-picker；`:412` `HOSTS_SHARING_DEFAULT_BUCKET` 仅含 files；`:415-425` 解析与 `finderPersistKey`（default 沿用旧键 `learning-hub-finder`，其余带 `:bucketId` 后缀） |
| 每桶只持久化四项偏好，恢复入口逐字段白名单 | **成立**。`finderStore.ts:1237-1242` `partialize` 恰四字段；`:459-475` `sanitizeFinderViewPreferences` 逐字段枚举校验；`:477-496` 坏 JSON/非对象安全返回 null；`:1246-1249` `merge` 阶段再次过同一白名单（注释明确防止默认浅合并复活被拒值） |
| 新桶无自有值时继承旧单例偏好 | **成立**。`finderStore.ts:504-515` own 优先，无则读旧键 `FINDER_PERSIST_KEY_PREFIX` 回落 |
| registry 同宿主复用、异宿主隔离；活跃宿主订阅 | **成立**。`finderStore.ts:1255-1271` Map registry；`:1294-1333` 模块级活跃宿主 + `useSyncExternalStore` 订阅（`useActiveFinderStore`），无人注册时回落 default |
| 真实宿主接线 | **成立**。`src/features/workbench/apps/files/FilesAppWindow.tsx:165` `FINDER_HOST_IDS.files`；`src/features/learning-hub/LearningHubPage.tsx:499/1276/1316` page 与 page-mobile；`src/features/chat/pages/ChatV2Page.tsx:217/890/1289` canvas 与 canvas-mobile；`src/features/chat/components/groups/GroupEditorDialog.tsx:767` group-picker。均在 06 引用的行区间内 |
| Workbench 壁纸/边距解析与限幅 | **成立**。`src/features/workbench/core/persistedSettings.ts:12-21` 同时接受 JSON 字符串与对象；`:40-47` 非法形状回落默认；`:56` blur clamp 0–40、`:57` dim clamp 0–0.6、`:74` 边距 clamp 0–32 且逐字段回落 |
| 笔记资源树分页 1000/上限 20000，首页失败与后续页截断分治 | **成立**。`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:191-192` 两常量；`:207-228` 首页失败返回错误、后续页失败保留已取数据并 `truncated: true`，注释点名旧实现的静默截断缺陷 |
| Finder 撤销栈有界 20，软删除不进栈 | **成立**。`src/features/learning-hub/utils/finderUndoStack.ts:42` `FINDER_UNDO_STACK_LIMIT = 20`；`:1-7` 头注释明确软删除走通知内 Undo、无 redo/持久化 |
| 契约测试存在 | **成立**。`tests/vitest/learning-hub/finder-host-buckets.test.ts` 与 `tests/vitest/workbench/workbench-persisted-settings.test.ts` 均在树上 |

### 3.2 评审意见（不降级）

1. 06 的"边界说明"值得肯定：明确 Finder persist 契约只覆盖四项视图偏好、
   不把未承诺的 `currentPath`/搜索/选择跨重启恢复误报为缺陷——复核确认
   `partialize` 范围与该声明完全一致。
2. 本轮抽查深度说明：分桶/持久化/继承/registry/宿主接线/限幅/分页/undo 栈等
   主干断言全部逐行坐实；`LearningHubSidebar` 内部导航注册细节、
   `NoteContentView` 冲突恢复、`NotesGraphTab` 降级、wikilink 回写
   （`NotesWorkspaceApp.tsx:2100-2155`）与 Quick Look 交互属报告的辅证层，
   本轮核对了文件与职责存在性、未逐行重放其分支逻辑；未发现任何与报告
   矛盾的迹象。
3. 06 引用的合入/门禁数字（如 40/40、286/286）均标注为"既有合入证据，
   不冒充本轮执行"，口径诚实；本轮同样未运行测试，不重复背书数字本身。

## 4. 三份报告的交叉一致性

- **只读闪卡是三方共识且互相印证**：04 §4（组件无按钮 + display-only 契约
  测试）、05 §1/§6（Step 5 裁决"有意不吸收" save-to-library、技能规则 `:69`
  禁保存 action）、以及 `docs/dev/0824-leftover-audit.md:16-17`（未恢复
  handler/文案/locale key）指向同一事实，复核未发现任何一方与源码或彼此
  矛盾。04 把 `debug.chat_anki_panel.action.save` 判为死 key 而非隐藏能力，
  与 05 的裁决叙事互补而非冲突。
- **入库管线归属一致**：05 称"入库统一走 `anki_cards` QA/critic 管线"，04
  正是对该管线的审计（QA 主链 + opt-in critic），两侧对 QA 默认开、critic
  默认关的表述一致。
- **06 与 04/05 无重叠冲突**：Finder/Workbench 持久化白名单的防注入思路
  （storage 边界 + merge 二次清洗）与 05 记录的 GenUI 持久化/清洗加固方向
  一致，无相互矛盾的边界声明。
- **三份均满足互审格式要求**：各自含 `## 结论` 章节与"本轮不改代码"声明
  （04 在 `:26` 与 `:177`，05 在 `:134`，06 在 `:25`）。

## 5. 遗留动作（全部归属后续产品分支，非本轮）

1. 04 列出的四项修复优先级（QA 开关语义对齐、恢复动作阈值/状态/文案对齐、
   删除确认完整风险文案 + 行为测试、死 key 成对清理）经复核全部有效，维持
   原优先级；修复 QA 开关时按 §1.2 的精确语义（"违规卡仍写回"）改文案或改
   实现。
2. 05 §2.3 所列 git 谱系数字如需闭环，可由后续允许运行 git 的审计轮次重放
   `merge-base --is-ancestor` 与 `rev-list --count`；本轮不阻塞。
3. 06 无待修项；其"边界说明"中建议的"在唯一产品写入流程中运行现行定向
   测试"留给测试执行轮次。

**本轮不改代码。**
