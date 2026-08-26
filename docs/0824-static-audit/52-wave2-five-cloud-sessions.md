# 0824 Wave2 五路云会话 Prompt（可整段复制）

进度仓落地。产品代码零改动。5 份 prompt 各自独立，可整段贴进新云会话。

**两条调度硬约束（已写进每一份 prompt）：**

1. **第 1–7 轮禁止跑编译 / 门禁 / CI/CD / 测试**（含 npm、cargo、vite、typecheck、vitest、check-migrations、tauri）。只许静态审 + 改代码 + 写测试源码（不执行）+ 每轮 commit/push/更新 draft PR。第 8 轮起才允许实测；环境杀了就停。
2. **第 1–7 轮子代理全部只用 `claude-fable-5-thinking-high`**。第 8 轮及之后改为 `claude-fable-5-thinking-xhigh` ∶ `gpt-5.6-sol-xhigh-fast` = 1:1。

旧长流程模板第 7 节「立刻 tauri 编译」与「全程 fable:sol 1:1」均已作废，以本文件为准。五路 PR 均 base `cursor/0824-cde6`，不整支合回官方，除非用户后下令。

---

model=claude-fable-5-thinking-xhigh

# 0824 Wave2：五大方向云会话总体方案（每会话 ≥10 轮 × 每轮 10 子代理）

- 取证时间：2026-08-26（UTC）。本文件为唯一产出；本轮零代码改动、零 git 写操作（仅 fetch）。
- 基线复核：`git fetch origin cursor/0824-cde6` 后 tip = **`061b4815`**（`docs: record Step 23 gates, 18 invariants, and Tauri main-path`），与预期一致。
- 注意：本报告撰写环境的工作树是 `cursor/0824-static-audit-cde6`（Step 21 产品树 + 审计文档），比基线少 Step 22 的 27 个 cherry-pick（81 个产品文件差异，如 `src-tauri/src/crypto_publication.rs` 只在基线枝上）。**下文所有 prompt 均以 `origin/cursor/0824-cde6 @ 061b4815` 为唯一代码事实源**；文中引用的行号来自评审文档（基于 Step 21 树 `2d41ea8b`），Step 22 触碰过的文件行号可能漂移，子代理须以当前 tip 实测为准。
- 输入吸收：`docs/0824-MERGE-PLAN.md` Step 22/23 全文、`docs/0824-quality-review/` 27 份中的 prompt-cache / pipeline-streaming / workbench-fg / mobile-i18n / cloud-sync / backup-restore / vfs-governance / upgrade-path / anki / anki-tasks / chat-composer / cross-cutting / provider-adapters / question-bank / learning-notes / finder-hub / pdf-documents / README、`docs/dev/mobile-uiux-unify/README.md`（五条统一规范）、上一轮 `/tmp/0824-fable-next-directions.md` 缺口清单（仅作审查输入）。
- 全部为静态取证；未跑编译/测试/实机。
- **第 1–7 轮硬禁**：跑编译 / 四项硬门禁 / CI/CD / 任何测试执行（含 npm、cargo、vite、typecheck、vitest、check-migrations、tauri）。只许静态审 + 改代码 + 写测试源码（不执行）+ 每轮 commit/push/更新 draft PR。
- **第 8–10 轮才允许**实测；环境杀了就停。
- **模型**：第 1–7 轮全部子代理只用 `claude-fable-5-thinking-high`；第 8 轮起 `claude-fable-5-thinking-xhigh` ∶ `gpt-5.6-sol-xhigh-fast` = 1:1。
- 通用模板已整段写入下方 5 份可复制 prompt（旧模板第 7 节「立刻 tauri 编译」作废）。

---

## 一、为何是这 5 向（覆盖矩阵 + E 向论证）

### 1.1 五向确定

| 向 | 标题 | 分支 | 主口径 |
|---|---|---|---|
| A | Agent 架构 + pipeline + LLM 缓存命中 | `cursor/0824-wave2-agent-cache-a875` | 派 Agent 后的架构契合度调研 + prefix freeze 统一代际 + provider 协议 + 流式过滤 |
| B | 学习桌面（Workbench）+ 全部学习子应用 SOTA 化 | `cursor/0824-wave2-desktop-subapps-a875` | 桌面壳数据安全事务 + 笔记/PDF/导图/翻译/作文/待办/Finder 逐应用对标 SOTA + Agent 原生结合 |
| C | 移动端 UI/UX 与使用体验 | `cursor/0824-wave2-mobile-uiux-a875` | 按 mobile-uiux-unify 五条规范全面重扫 + 触控目标体系化下沉 + 浮层/键盘/i18n 收敛 |
| D | 云存储/同步/备份 + 数据库迁移 + 历史库兼容 | `cursor/0824-wave2-cloud-data-a875` | 配置事务/调度生命周期/E2EE 并发/恢复编排/稀疏库/非理想输入闭环 |
| E | Anki 制卡 / 闪卡复习(FSRS) / 题库判分 | `cursor/0824-wave2-anki-qbank-a875` | 遮挡导出闭环 + gold 溯源 + CriticSummary 可观测 + 判分/mastery 统一原语 + daily 口径统一 |

### 1.2 覆盖矩阵（大领域 × 五向，痛点最大化覆盖）

| 代码/评审大面 | A | B | C | D | E |
|---|---|---|---|---|---|
| chat_v2 pipeline / hooks / tool_loop / multi_variant（3 万行级） | ● | | | | |
| H cache prefix freeze / providers / adapters / model2_pipeline | ● | | | | |
| special-token 过滤 / SSE 字节层 / 双适配器 | ● | | | | |
| Workbench 壳 / 调度器 / 快照 / handoff（F 面 1.3 万行） | | ● | | | |
| Learning Hub / 笔记 / PDF / 导图 / 翻译 / 作文 / 待办 / Finder | | ● | ○(移动 chrome) | | |
| Composer（F 拆分四组件） | ○(缓存相关) | ●(桌面行为) | ●(移动热区) | | |
| 移动壳 / 顶栏 / 抽屉 / 返回键 / 键盘 / safe-area / 44px 体系（G 面 3056 处规则） | | | ● | | |
| i18n 移动键 / 守卫机制 | | | ● | | |
| cloud_storage 三 provider / sync_manager / E2EE / tombstone（9.5 千行） | | | | ● | |
| data_governance 备份/ZIP/恢复/crypto journal（1.1 万行） | | | | ● | |
| migration coordinator / 111 迁移 / 历史库兼容 / 升级路径 | | | | ● | |
| 设置×云同步接缝（cross-cutting 唯一 FAIL 面） | | | | ● | |
| streaming_anki / critic / gold / occlusion / QA lint / APKG / FSRS（≈1.3 万行） | | | | | ● |
| question_bank_service / qbank_grading / mastery / 练习会话 | | | | | ● |
| chatanki_executor / qbank_executor（Agent 原生工具面） | ○(架构契合) | | | | ● |

●=主责所有权，○=交叉但按第三节所有权规则避让。五向合计覆盖上一轮缺口清单（`/tmp/0824-fable-next-directions.md` §3.4）12 条开放缺口中的 12 条、cross-cutting 五条「仍未统一」中的 5 条、四份 FAIL/两份合入阻断评审（workbench-fg FAIL、设置×云同步 FAIL、anki FAIL、provider-adapters FAIL、anki-tasks 两条阻断）的全部处置项。

### 1.3 E 向为何选「Anki/制卡/题库」而非「笔记/Finder/PDF」（论证）

1. **覆盖互补性**：B 向的定义就是「桌面模式及所有学习子应用」，笔记/Finder/PDF 天然是 B 的子应用清单成员——若 E 再选它们，B/E 大面积重叠而 Anki/题库的领域后端（`streaming_anki_service.rs`、`anki_critic.rs`、`question_bank_service.rs`、`mastery/`、`qbank_grading/`，合计约 1.8 万行 Rust）将无人承接。反之把 Anki/题库剥出 B，B 的体量也从「不可能做深」回到「可做深」。
2. **痛点密度最高**：27 份质量评审中该域占 6 份（anki / anki-tasks / anki-connect-apkg / flashcards-fsrs / question-bank + cross-cutting 的 Chat×Anki 面），其中 `anki.md` 判 **FAIL**（遮挡导出断链、critic gold 自举污染两条 P0）、`anki-tasks.md` 有两条合入阻断；仍开放项（内部字段泄漏 APKG、CriticSummary 不可见、nullable 读侧、GenerationStats 不落盘、daily 三套口径、mastery 不接受改判）数量超过笔记/Finder/PDF 三份 WARN 评审的开放项总和。
3. **Step 22 二检需求最重**：Step 22 在该域落了 10 个 cherry-pick（QA #328/#336、CardAgent #338/#341、APKG/金标 #329/#335、qbank #332），含 1 处 `streaming_anki_service.rs` 手工解冲突，且按 MERGE-PLAN 自述「未跑任何测试」——这正是「第 6–10 轮多轮检查」铁律最该花的地方。
4. **学习产品的差异化核心 + Agent 原生结合最深**：制卡→复习→题库→掌握度是学习类产品对标 SOTA（Anki/SuperMemo/Quizlet/RemNote）的主战场；`chatanki_executor.rs`（1.1 万行）+ `qbank_executor.rs` 是全仓「Agent 原生子应用」的样板，与用户重点 2「与 Agent 原生结合」直接对齐。

---

## 二、五个父代理 Prompt（每份可整段复制、从零开跑）

### 2.1 会话 A：Agent 架构 + pipeline + LLM 缓存命中

```text
你是 0824 Wave2 会话 A 的父代理，负责「派 Agent 后的 Agent 架构优化 + chat pipeline + LLM 缓存命中」方向。

【Wave2 通用铁律——本会话必须整段遵守，不得删改。旧模板第 7 节「立刻 tauri 编译」作废。】

0. 原目标仍生效
把近 2–3 天大量改造 / PR / 枝逐一审阅并加法收口。CI 不当门禁。官方产品统一枝只有 `cursor/0824-cde6`（PR #269 → main）。合主线只用 #269，禁止反向合 main，禁止整支 merge 隔离 / 预演 / leftover / 带重复 G merge 的枝。本会话是 Wave2 五路之一，产物停在本会话独立枝 + draft PR；不整支合回官方 0824，除非用户后下令。

1. 子代理模型（本波覆盖旧「全程 fable:sol 1:1」）
- 第 1–7 轮：全部子代理只用 `claude-fable-5-thinking-high`。禁止 sol / GPT / 任何 GPT 系列，禁止 `claude-fable-5-thinking-xhigh`，禁止 `computerUse`（平台会绑到 Claude 4.5 Sonnet，不是 fable）。每轮约 10 个，全是 fable high。
- 第 8–10 轮：`claude-fable-5-thinking-xhigh` 与 `gpt-5.6-sol-xhigh-fast` 按 1:1（每轮约 5+5）。无 xhigh-fast 时 GPT 半边显式降到 `gpt-5.6-sol-high-fast`，并在轮末记录。fable 半边不要静默降到无关模型。
- 第 1–7 轮若 `claude-fable-5-thinking-high` 调不通：停、报、重试；不要偷偷换成 sol 或 xhigh 凑数。
- 父代理直改白名单：文档 / 注释 / 配置措辞，或不超过 10 行且不涉及业务逻辑 / 权限 / 数据面。产品代码必须派子代理。
- 每轮约 10 个子代理，任务不要切碎，每轮要有巨大且可靠进展。子代理要吃饱：文件清单 + 验收标准 + 禁改区写进任务卡。
- 任何情况下都不允许停止，除非用户明确说停。

2. 仓库 / 枝 / 写手
- 第一件事：`git fetch origin cursor/0824-cde6`，确认 tip。预期 `061b4815`（Step 23 文档）。若远端已前进，以新 tip 为基线并先派一名子代理读增量；禁止 reset，禁止 force-push 官方枝。
- 从 `origin/cursor/0824-cde6` 拉出本会话独立枝（枝名见下方专属节），立即空提交 + `push -u` + 开 draft PR，base = `cursor/0824-cde6`。
- 每轮结束立刻 `git add` / `commit` / `push` 并更新自己的 draft PR。半成品用 `wip:` 前缀。云会话被杀等于永久丢未推送工作。
- 子代理 `gh pr create` 常 403；父代理用平台 PR 工具。不要回帖 Slack / GitHub。不要改人类可能改过的 PR 正文（尤其 #269、#326）。
- 新枝名必须 `cursor/<descriptive>-a875` 或用户指定的 `cursor/<descriptive>-cde6`，全小写。
- 产品修复用独立 worktree（如 `/tmp/0824-wave2-*`），不要占脏工作区乱切官方枝。

3. 【最高优先级】第 8 轮之前禁止跑编译 / 门禁 / CI/CD / 测试
第 1–7 轮只做静态审阅 + 代码优化落地 + 写测试源码（不执行）+ 每轮 commit / push / 更新 draft PR。时间紧，编译和实测是浪费。

第 1–7 轮绝对禁止（出现即失败，立刻停掉该命令，不要补救式重跑）：
- 任何 `npm` / `npm ci` / `npm install` / `npm run` / `npx`（含 typecheck、vitest、vite、version:generate）
- 任何 `cargo` / `rustc` / `rustfmt` 执行态（check、test、build、fmt --check）
- `tsc` / `vite` / `node scripts/check-migrations.mjs` 执行
- 任何 CI/CD：`gh workflow`、推送后盯 checks、为变绿而改 workflow
- `tauri dev` / `tauri build` / 实机 / 浏览器实测 / `computerUse`
- 为跑通环境去装 `node_modules`、Rust 1.98、GTK、WebKit、pdfium、protoc

第 1–7 轮允许：读代码、改产品代码、新增/改测试文件（只写不跑）、grep / 静态推演、web search、commit + push。
「写一条会红的测试」= 把测试源码落盘并在台账写预期；不要执行它来看红绿。

第 8–10 轮才允许跑编译 / 四项硬门禁 / 定向测试。环境装不动、跑不完、被杀掉：立即停，如实记录，绝不空转。四项硬门禁只在第 8 轮及之后才可碰：
1. `npm run version:generate && npm run typecheck`
2. `npx vite build`
3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`（Rust 1.98.0）
4. `node scripts/check-migrations.mjs`
缺 `src/version.ts` 时用 `scripts/generate-version.mjs`，也只许第 8 轮及之后。Tauri 实机是后期打磨，不是本波主战场。

4. 18 项不变量（禁止破坏；第 1–7 轮用 grep / 读文件自证，不要跑测试套件）
1. pipeline hooks：ApprovalGateHook 必须保持 default 链首位 + TaskAuditHook
2. GenerativeUiExecutor 注册在 catch-all 前
3. H cache：prefix freeze + cache_write_tokens 全链在树
4. utf8_stream 有生产调用方
5. model_special_tokens（#200 未回流）
6. 闪卡只读，无 save_to_library 写回流
7. 无生产 ChatV2AnkiAdapter
8. cardAgent.startGeneration 两入口仍在
9. 附件 file 200MB / image 50MB
10. finder host buckets 分桶隔离
11. qbank-tools：daily_target 1..=50 等压缩契约
12. tombstone 复读 fail-closed
13. WebDAV decode_path
14. S3 normalize_endpoint
15. FTP 550/501 白名单
16. HPIAS 18-block + 会话隔离
17. 无 mythos-5 / haiku-5 真目录条目
18. NOTICES 在 legal/ + Composer* 拆分仍在 + G 44px / safe-area / Android back

5. 已完成主题仓，不要从零重来
E/C/H/A/T/B/D/F/G/leftovers-safe 已归并；#177 cherry 映射已落；Step 18–23 已在官方 0824。VFS `coordinator.rs` 必须加法式：保留 `apply_vfs_init_missing_tables`，再叠加 `pre_repair_vfs_v20260824_note_props`。禁止 merge rel-vfs 的 `2bfe7c31`。`origin/main` tip `b2a85a69` 已被 `5f324e1f` 语义超集吸收，禁止整支 merge main。

6. 明确忽略 / 不要整支合
dependabot / release-please / cla-signatures；#113/#123/#134/#155；#170/#198/#200；#203；#101–#103；#214 整支；#213 除已收 parser `e83d4081` + rustfmt `6a903224` 外 DROP；对照/隔离 PR #269 #293 #303–#325 #327 #344；全部 `0824-rehearse-*` / `0824-theme-*` / `0824-verify-*` / `0824-regress-*`。不要回放 Step 18 finder 源 SHA `9176740b` / `0a6344e1`。不要回放 Step 19 源 SHA `3d3516c3` / `c4a3382c` / `ef991061` / `e97b89ff` / `92c487f8` / `2ba5522d`。leftover 结论 A：开放 PR 无未吸收产品增量。MCP 存储分叉 + 空策略全放行是 v0.9.44 既有，不修。issue #122 聊天乱码仍 OPEN，不要记账为已修复。MERGE-PLAN 只追加新 Step，不改写更早 Step。

7. 工作习惯
- 五路文件所有权：A=agent/cache/tool_loop；B=desktop 子应用；C=mobile UI；D=cloud/data/`coordinator.rs`；E=Anki/qbank。越权文件只读，改动记台账给对应路。
- 五枝同 base 平行，不互相 merge，不 cherry-pick 对方枝。
- 归因诚实：v0.9.44 既有债可修但提交信息标 `legacy:`。PR 描述必须带「已验证 / 未验证」两栏；第 1–7 轮「已验证」只能写静态证据，不能写「测试已跑绿」。
- 文档只追加。不要标 Goal complete。
- 禁用 computerUse。行业调研用 web search。

【本会话专属身份】
方向：派 Agent 后的架构契合度 + chat pipeline + LLM 缓存命中（行业调研 + prefix freeze + provider 协议）。
独立枝：`cursor/0824-wave2-agent-cache-a875`
draft PR 标题：0824 Wave2-A: Agent 架构与 LLM 缓存命中深化（pipeline/prefix-freeze/provider 协议/流式过滤）
文件所有权：tool_loop / hooks / helpers / multi_variant / prompt-cache 全链 / providers / adapters / model_special_tokens。Composer 只碰缓存/技能快照段。coordinator.rs 归 D；移动热区归 C；桌面 Composer 行为归 B；Anki 算法归 E。

【基线与分支（第一件事做完再做别的）】
1. git fetch origin cursor/0824-cde6，确认 tip（预期 061b4815；若远端已前进，以新 tip 为基线并让一名子代理先读增量提交）。
2. git checkout -b cursor/0824-wave2-agent-cache-a875 origin/cursor/0824-cde6
3. 立即做一个空提交（chore: open wave2-A branch）并 push -u origin，随即开 draft PR，base = cursor/0824-cde6，标题：
   「0824 Wave2-A: Agent 架构与 LLM 缓存命中深化（pipeline/prefix-freeze/provider 协议/流式过滤）」

【本会话组织（叠在通用铁律之上）】
- 共 10 轮 × 每轮 10 子代理。第 1–7 轮模型全是 `claude-fable-5-thinking-high`；第 8–10 轮 `claude-fable-5-thinking-xhigh` ∶ `gpt-5.6-sol-xhigh-fast` = 1:1。同文件同轮单人。
- 第 1–5 轮完成本方向 95% 的审查 + 代码落地；第 6–7 轮静态二检 + 把反例测试源码写进树（禁止执行）；第 8–10 轮才允许跑编译/门禁/定向测试，并改用 xhigh+GPT。
- 每轮开轮前写任务卡；收轮父代理抽查 diff 再提交。

【必读输入（开工第 1 轮先读）】
- docs/0824-quality-review/prompt-cache.md（WARN：七条收口顺序）
- docs/0824-quality-review/pipeline-streaming.md（hooks 深评 + #122 定性 + 过滤器缺口）
- docs/0824-quality-review/chat-composer.md（PASS 但 P2/P3 清单）
- docs/0824-quality-review/provider-adapters.md（FAIL：P0 breakpoint 形状 / P1 include_usage / P1 stream_options / P2 Anthropic 槽位）
- docs/0824-MERGE-PLAN.md 的 Step 22 段（provider 修复 55846040 已落但零测试验证——本会话要独立复核它）
- docs/0824-quality-review/llm-usage.md（用量记账口径）

【红线】
- 禁止整支 merge main / 任何隔离枝 / 官方枝以外的 fix 枝；只许在本枝上原创提交。
- 不把 issue #122（聊天乱码）当 0824 回归去「修」——它病灶未定位，只允许做定位探针（如 Utf8StreamDecoder invalid 分支补 warn 日志）与 issue 定性记录。
- src-tauri/src/data_governance/migration/coordinator.rs 归 D 会话，本会话不碰；Composer 移动热区类名归 C、桌面行为归 B，本会话只碰 Composer 中与缓存/技能快照直接相关的段（TauriAdapter.ts 的 availableSkillsSnapshot 段 :5288-5340 附近归 A）。
- 过滤器改动必须保持「保守三形态」哲学：负例测试（preserves_literal_tokens_in_prose 等）一条不许删。
- hooks/tool_loop 的十五段准入序列语义与三段式 TOCTOU 检查不许动语义；ApprovalGateHook 必须保持 default 链首位。

【已知痛点路径（子代理任务卡直接引用）】
P1 多变体并发前缀分叉：src-tauri/src/chat_v2/pipeline/helpers.rs:928-1081 的 append-only 合并救不了分叉（[A,X] vs [A,Y]）；multi_variant.rs:498-544,1270-1325,1600-1689。
P2 技能正文不冻结：src-tauri/src/chat_v2/types.rs:1057-1101（without_skill_contents）、pipeline/history.rs:806-823——旧锚点会被当前正文重写。
P3 schema 字节只冻单轮：pipeline/tool_loop.rs:89-131,304-337；多变体只冻名字序。
P4 availableSkillsSnapshot 首发非原子 + 永久陈旧：src/features/chat/adapters/TauriAdapter.ts:5288-5340、src/features/chat/skills/progressiveDisclosure.ts:630-667；compaction 是零成本刷新点。
P5 llm_content 崩溃窗口：pipeline/persistence.rs:252-288（首个网络请求前补写）。
P6 24h retention 死实现：src-tauri/src/llm_manager/model2_pipeline.rs:3189-3213 全仓零生产调用——接线或删除，二选一。
P7 遥测身份错误：model2_pipeline.rs:5709-5738 把随机 stream_event 当 session_id；scripts/cache-hit-report.py 按它分组；CHAT_V2_CACHE_DEBUG 指纹不含 tools、非 post-adapter body（model2_pipeline.rs:4388-4409）。
P8 hooks 卫生：hooks.rs（1694 行）approval_arguments 只写字段（:57,:937）删除；TaskAuditHook 对 approval_gate 产出的隐式依赖（:984-1035）文档化+断言；trait 各切点失败语义写明（before_turn 可 Err 而其余不可）；两个同构 tokio::select! 等待器收敛为泛型等待函数。
P9 过滤器与出口：reasoning 通道不过滤（llm_adapter.rs:1142-1176、variant_adapter.rs:451-473，挂独立过滤器实例）；双 token 常量表共享（utils/model_special_tokens.rs:8 与 streaming_anki_service.rs:45，后者的算法归 E、常量表引用归 A，只做 pub(crate) 引用不动 E 的算法）；翻译/作文评分/非流式 call_unified_model_2 出口过滤盘点；consume_prefix O(n²)（model_special_tokens.rs:206-208）改游标制；process_newline 重置 inline-code 状态复核（Step 22 daf5b78e 已修三条窄规则，先核实现状再决定是否补）。
P10 provider 协议回归（Step 22 55846040 改了 308 行且零测试）：src-tauri/src/providers/mod.rs 上逐条复核评审四项——GPT-5.6+ prompt_cache_breakpoint 官方对象形状 {"mode":"explicit"} 与端点门控；include_usage 与 finish_reason 提前 Done 的终止状态机；stream_options 无条件下发的兼容网关 400 面；Anthropic 四断点槽位预算与工具 marker 死分支（:3178-3212 一带）。已修的补快照测试钉死，未修的落地修复。
P11 行业调研必做（用户点名）：新 Agent 体系与原体系契合度要有结论。调研对象至少含：Anthropic prompt caching（cache_control/TTL/断点策略）、OpenAI Responses + prompt caching + Agents SDK 的工具循环与状态回放、DeepSeek context caching、Claude Code / 开源 agent 框架的子代理派发与上下文压缩实践；结合本仓 tool_loop/hooks/multi_variant/skills/executors（chatanki_executor、qbank_executor、GenerativeUiExecutor 只读不改，改动归 E/B）给出「契合/不契合/改造建议」矩阵，并把可静态落地的部分在第 2–5 轮落进代码。

【10 轮 × 10 子代理】
第 1 轮（锚定 + 调研 + 低风险落地）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 调研员-Anthropic缓存 — Anthropic prompt caching 官方契约与 4 槽/TTL/自动+显式组合，产出对照本仓 providers/mod.rs 的差距清单
 2. 调研员-OpenAI — Responses API、prompt caching（breakpoint 对象形状、retention）、Agents SDK 工具循环形态
 3. 调研员-DeepSeek/Gemini — context caching、usage 字段、兼容网关行为
 4. 调研员-Agent框架 — Claude Code/开源框架的子代理派发、prompt 前缀治理、compaction 实践；对照本仓 hooks/tool_loop/multi_variant/skills
 5. 锚定员-tool_loop — tool_loop.rs 当前 tip 全量读，冻结原语调用点与测试清单
 6. 锚定员-hooks — hooks.rs 全量读 + 顺手落地 P8 四小件（删只写字段、依赖断言、trait 文档、泛型等待器）
 7. 锚定员-multi_variant — multi_variant.rs + helpers.rs 并发合并现状，写 P1 修复设计稿（fan-out 统一代际 vs variant 级基线，二选一并论证）
 8. 锚定员-prompt链 — prompt_builder.rs / context.rs / repo.rs 的 metadata 单键更新链现状
 9. 锚定员-provider — providers/mod.rs 当前 tip（Step 22 后）与评审四项逐条比对，产出「已修/未修」台账
 10. 台账员 — 汇总 1–9，产出本会话缺口总台账（docs/dev/wave2-A-ledger.md）+ 轮末提交
第 2 轮（缓存代际统一——本会话最重的落地）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 代际设计实现-1 — 按第 1 轮定稿实现多变体 fan-out 统一代际或 variant 级基线（helpers.rs + multi_variant.rs）
 2. 代际设计实现-2 — schema digest 纳入 prefix generation：冻结副本带 digest，变化时记录代际切换与预期 miss（tool_loop.rs）
 3. 统一冻结原语 — 单变体 freeze_tool_schemas 与多变体 freeze_order 收敛为同一字节冻结原语
 4. 元数据层 — repo.rs 增加 prefix generation 的持久化键（单键更新、不推 updated_at，沿用现有纪律）
 5. 反例测试源码-分叉（只写不跑） — 「变体 A/B 分别追加 X/Y，后轮同现 X、Y」的先写会红的测试源码并落盘（本轮禁止执行）
 6. 反例测试源码-恢复（只写不跑） — metadata 清内存后代际恢复、并发首建收敛测试
 7. 审阅员-并发 — 逐行审 1–4 的锁序与 IMMEDIATE 事务边界，防止新死锁
 8. 审阅员-语义 — 确认改动不影响 hooks 准入序列与 TOCTOU 三段检查
 9. 文档员 — 在 tool_loop.rs/helpers.rs 文件头写清「冻结什么/不冻什么/代际何时切」矩阵注释
 10. 提交员 — 组装本轮 diff、跑 grep 级自检（禁改区未动）、commit+push
第 3 轮（重放正确性与崩溃窗口）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. llm_content 前移 — persistence.rs：当前 user 编译完成后、网络请求前轻量事务补写
 2. 技能正文版本化-1 — types.rs/history.rs：锚点持久化内容摘要 digest + 版本 ID
 3. 技能正文版本化-2 — 重放侧只接受同 digest 正文；不可得则显式开新 prefix generation（禁止新正文伪装旧历史）
 4. 崩溃窗口测试源码（只写不跑） — 「已发 provider、sidecar 未保存时崩溃」的模拟测试
 5. 技能重放测试源码（只写不跑） — 「技能正文修改/删除后重放旧锚点」反例测试
 6. Utf8 探针 — sse_buffer.rs/utf8_stream.rs：invalid 分支补 warn 日志（#122 定位探针，不声称修复）
 7. 双适配器审阅 — llm_adapter.rs vs variant_adapter.rs 平行逻辑清单，抽公共流处理核心的第一刀设计（只设计+小步落地，不大迁移）
 8. 审阅员-重放 — 逐行审 1–3 与 history.rs 重建路径的一致性
 9. 审阅员-分支深拷贝 — repo.rs:1948-2049 三列复制与新 digest 字段的配合
 10. 提交员 — 同第 2 轮职责
第 4 轮（过滤器统一挂接 + 技能目录生命周期）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. reasoning 过滤 — 两适配器 on_reasoning_chunk 挂独立过滤器实例（不与 content 共享行状态）
 2. 常量表共享 — MODEL_SPECIAL_TOKENS 单源化（E 域算法不动，仅常量引用）
 3. 出口盘点落地 — 翻译/作文评分/非流式 call_unified_model_2 的过滤覆盖，统一挂接或书面豁免论证
 4. O(n²) 修复 — consume_prefix 游标化 + 大 chunk 回归测试
 5. 目录原子首发 — TauriAdapter.ts：首次 skills catalog 持久化成功后再发请求
 6. 目录 compaction 刷新 — compaction 落盘同一事务里按 live registry 重生成快照（零缓存成本时机）
 7. 目录 delta 设计 — 当前 user 尾部 available_skills_delta 或显式刷新代际（设计定稿 + 最小落地）
 8. 审阅员-过滤哲学 — 确认 1–4 未放宽保守三形态、负例测试全绿逻辑仍成立
 9. 审阅员-前端 — 5–7 的多窗口竞争路径复核（first-write-wins 语义不回退）
 10. 提交员
第 5 轮（遥测 + provider 协议 + 架构结论落地）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 遥测身份 — session_id/variant_id/run_id 分列持久化（model2_pipeline.rs 记账路径 + llm_usage 写入）
 2. prefix 指纹 — post-adapter 最终 body 按 system/tools/history/current-user 四段取指纹，记录首个分叉段
 3. 报告脚本 — scripts/cache-hit-report.py 按新列分组、修正多变体 steady 统计
 4. retention 裁决 — P6 二选一落地（接线 + 官方端点门控快照测试，或删除死实现）
 5. provider-P0 — breakpoint 对象形状 + 端点能力门控（若第 1 轮台账判「未修」）+ 三类快照测试（官方 GPT-5.6 / 第三方同名 / 偶含 gpt-6 字样）
 6. provider-P1 — include_usage 终止状态机（choice 完成 ≠ 流完成）+ 完整事件序列测试；stream_options 能力门控
 7. provider-P2 — Anthropic 四槽预算治理 + 工具 marker 保留 + 边界测试
 8. 架构结论 — 第 1 轮调研矩阵定稿为 docs/dev/wave2-A-agent-architecture.md：新 Agent 体系与原体系契合度、缓存命中设计原则（会话内工具面 append-only、system 稳定前缀、子代理 prompt 复用母前缀）、后续改造路线
 9. 审阅员 — 1–7 逐 diff 审
 10. 提交员 — 至此本方向 95% 审+改应完成；如有欠账列入第 6 轮首位
第 6 轮（全面二检）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。10 名复核员按第 2–5 轮的十个落地面一人一面逐 diff 复核（代际/冻结原语/llm_content/技能版本化/过滤器/目录生命周期/遥测/provider×3），每人产出「确认/翻案/补丁」三选一结论，补丁当轮落地；轮末提交。
第 7 轮（反例测试源码补强，只写不跑）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。按评审点名的四类关键反例逐一补齐并静态推演——1-2 变体分叉终局、3-4 技能正文变更重放、5-6 崩溃窗口、7-8 三家 provider 连续请求 post-adapter 前缀对比（快照级）、9 测试台账更新、10 提交员。
第 8 轮（本会话首次允许实测窗口）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。本轮起才允许跑编译/门禁/定向测试；环境不行立即停。1-6 尝试 cargo test 定向（tool_loop/hooks/helpers/providers/model_special_tokens/prefix_snapshot 六族）与 vitest 定向（TauriAdapter/progressiveDisclosure），环境不行立即停；7-9 静态复核测试代码本身的断言质量；10 提交员。红灯逐个归因：本会话引入的当轮修，既有的记台账不扩散。
第 9 轮（扫尾）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-3 遗漏项清理（台账未闭合项）、4-5 注释与文档矩阵终稿（清什么/不清什么、冻什么/不冻什么）、6-7 死代码与只写字段最后一扫、8 i18n/日志文案一致性、9 PR 描述初稿（含「已验证/未验证」诚实清单）、10 提交员。
第 10 轮（终检交付）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-4 对全 PR diff 做四人交叉终审（并发/重放/协议/前端各一）、5 红线自证（grep 证明 hooks 序列/负例测试/coordinator 未触碰）、6 缓存命中率静态推演报告（改造前后前缀断裂点对比）、7 遗留风险清单、8 PR 描述定稿、9 台账归档 docs/dev/wave2-A-ledger.md 终版、10 最终 commit+push + PR ready 标记（保持 draft 由人工决定转正）。
```

### 2.2 会话 B：学习桌面（Workbench）+ 全部学习子应用 SOTA 化

```text
你是 0824 Wave2 会话 B 的父代理，负责「桌面模式（Workbench 学习桌面）+ 所有学习子应用」方向。每个子应用体量都够独立产品，对标市面 SOTA：功能完整度、交互质量、与 Agent 的原生结合。

【Wave2 通用铁律——本会话必须整段遵守，不得删改。旧模板第 7 节「立刻 tauri 编译」作废。】

0. 原目标仍生效
把近 2–3 天大量改造 / PR / 枝逐一审阅并加法收口。CI 不当门禁。官方产品统一枝只有 `cursor/0824-cde6`（PR #269 → main）。合主线只用 #269，禁止反向合 main，禁止整支 merge 隔离 / 预演 / leftover / 带重复 G merge 的枝。本会话是 Wave2 五路之一，产物停在本会话独立枝 + draft PR；不整支合回官方 0824，除非用户后下令。

1. 子代理模型（本波覆盖旧「全程 fable:sol 1:1」）
- 第 1–7 轮：全部子代理只用 `claude-fable-5-thinking-high`。禁止 sol / GPT / 任何 GPT 系列，禁止 `claude-fable-5-thinking-xhigh`，禁止 `computerUse`（平台会绑到 Claude 4.5 Sonnet，不是 fable）。每轮约 10 个，全是 fable high。
- 第 8–10 轮：`claude-fable-5-thinking-xhigh` 与 `gpt-5.6-sol-xhigh-fast` 按 1:1（每轮约 5+5）。无 xhigh-fast 时 GPT 半边显式降到 `gpt-5.6-sol-high-fast`，并在轮末记录。fable 半边不要静默降到无关模型。
- 第 1–7 轮若 `claude-fable-5-thinking-high` 调不通：停、报、重试；不要偷偷换成 sol 或 xhigh 凑数。
- 父代理直改白名单：文档 / 注释 / 配置措辞，或不超过 10 行且不涉及业务逻辑 / 权限 / 数据面。产品代码必须派子代理。
- 每轮约 10 个子代理，任务不要切碎，每轮要有巨大且可靠进展。子代理要吃饱：文件清单 + 验收标准 + 禁改区写进任务卡。
- 任何情况下都不允许停止，除非用户明确说停。

2. 仓库 / 枝 / 写手
- 第一件事：`git fetch origin cursor/0824-cde6`，确认 tip。预期 `061b4815`（Step 23 文档）。若远端已前进，以新 tip 为基线并先派一名子代理读增量；禁止 reset，禁止 force-push 官方枝。
- 从 `origin/cursor/0824-cde6` 拉出本会话独立枝（枝名见下方专属节），立即空提交 + `push -u` + 开 draft PR，base = `cursor/0824-cde6`。
- 每轮结束立刻 `git add` / `commit` / `push` 并更新自己的 draft PR。半成品用 `wip:` 前缀。云会话被杀等于永久丢未推送工作。
- 子代理 `gh pr create` 常 403；父代理用平台 PR 工具。不要回帖 Slack / GitHub。不要改人类可能改过的 PR 正文（尤其 #269、#326）。
- 新枝名必须 `cursor/<descriptive>-a875` 或用户指定的 `cursor/<descriptive>-cde6`，全小写。
- 产品修复用独立 worktree（如 `/tmp/0824-wave2-*`），不要占脏工作区乱切官方枝。

3. 【最高优先级】第 8 轮之前禁止跑编译 / 门禁 / CI/CD / 测试
第 1–7 轮只做静态审阅 + 代码优化落地 + 写测试源码（不执行）+ 每轮 commit / push / 更新 draft PR。时间紧，编译和实测是浪费。

第 1–7 轮绝对禁止（出现即失败，立刻停掉该命令，不要补救式重跑）：
- 任何 `npm` / `npm ci` / `npm install` / `npm run` / `npx`（含 typecheck、vitest、vite、version:generate）
- 任何 `cargo` / `rustc` / `rustfmt` 执行态（check、test、build、fmt --check）
- `tsc` / `vite` / `node scripts/check-migrations.mjs` 执行
- 任何 CI/CD：`gh workflow`、推送后盯 checks、为变绿而改 workflow
- `tauri dev` / `tauri build` / 实机 / 浏览器实测 / `computerUse`
- 为跑通环境去装 `node_modules`、Rust 1.98、GTK、WebKit、pdfium、protoc

第 1–7 轮允许：读代码、改产品代码、新增/改测试文件（只写不跑）、grep / 静态推演、web search、commit + push。
「写一条会红的测试」= 把测试源码落盘并在台账写预期；不要执行它来看红绿。

第 8–10 轮才允许跑编译 / 四项硬门禁 / 定向测试。环境装不动、跑不完、被杀掉：立即停，如实记录，绝不空转。四项硬门禁只在第 8 轮及之后才可碰：
1. `npm run version:generate && npm run typecheck`
2. `npx vite build`
3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`（Rust 1.98.0）
4. `node scripts/check-migrations.mjs`
缺 `src/version.ts` 时用 `scripts/generate-version.mjs`，也只许第 8 轮及之后。Tauri 实机是后期打磨，不是本波主战场。

4. 18 项不变量（禁止破坏；第 1–7 轮用 grep / 读文件自证，不要跑测试套件）
1. pipeline hooks：ApprovalGateHook 必须保持 default 链首位 + TaskAuditHook
2. GenerativeUiExecutor 注册在 catch-all 前
3. H cache：prefix freeze + cache_write_tokens 全链在树
4. utf8_stream 有生产调用方
5. model_special_tokens（#200 未回流）
6. 闪卡只读，无 save_to_library 写回流
7. 无生产 ChatV2AnkiAdapter
8. cardAgent.startGeneration 两入口仍在
9. 附件 file 200MB / image 50MB
10. finder host buckets 分桶隔离
11. qbank-tools：daily_target 1..=50 等压缩契约
12. tombstone 复读 fail-closed
13. WebDAV decode_path
14. S3 normalize_endpoint
15. FTP 550/501 白名单
16. HPIAS 18-block + 会话隔离
17. 无 mythos-5 / haiku-5 真目录条目
18. NOTICES 在 legal/ + Composer* 拆分仍在 + G 44px / safe-area / Android back

5. 已完成主题仓，不要从零重来
E/C/H/A/T/B/D/F/G/leftovers-safe 已归并；#177 cherry 映射已落；Step 18–23 已在官方 0824。VFS `coordinator.rs` 必须加法式：保留 `apply_vfs_init_missing_tables`，再叠加 `pre_repair_vfs_v20260824_note_props`。禁止 merge rel-vfs 的 `2bfe7c31`。`origin/main` tip `b2a85a69` 已被 `5f324e1f` 语义超集吸收，禁止整支 merge main。

6. 明确忽略 / 不要整支合
dependabot / release-please / cla-signatures；#113/#123/#134/#155；#170/#198/#200；#203；#101–#103；#214 整支；#213 除已收 parser `e83d4081` + rustfmt `6a903224` 外 DROP；对照/隔离 PR #269 #293 #303–#325 #327 #344；全部 `0824-rehearse-*` / `0824-theme-*` / `0824-verify-*` / `0824-regress-*`。不要回放 Step 18 finder 源 SHA `9176740b` / `0a6344e1`。不要回放 Step 19 源 SHA `3d3516c3` / `c4a3382c` / `ef991061` / `e97b89ff` / `92c487f8` / `2ba5522d`。leftover 结论 A：开放 PR 无未吸收产品增量。MCP 存储分叉 + 空策略全放行是 v0.9.44 既有，不修。issue #122 聊天乱码仍 OPEN，不要记账为已修复。MERGE-PLAN 只追加新 Step，不改写更早 Step。

7. 工作习惯
- 五路文件所有权：A=agent/cache/tool_loop；B=desktop 子应用；C=mobile UI；D=cloud/data/`coordinator.rs`；E=Anki/qbank。越权文件只读，改动记台账给对应路。
- 五枝同 base 平行，不互相 merge，不 cherry-pick 对方枝。
- 归因诚实：v0.9.44 既有债可修但提交信息标 `legacy:`。PR 描述必须带「已验证 / 未验证」两栏；第 1–7 轮「已验证」只能写静态证据，不能写「测试已跑绿」。
- 文档只追加。不要标 Goal complete。
- 禁用 computerUse。行业调研用 web search。

【本会话专属身份】
方向：Workbench 学习桌面 + 笔记 / PDF / 导图 / 翻译 / 作文 / 待办 / Finder。
独立枝：`cursor/0824-wave2-desktop-subapps-a875`
draft PR 标题：0824 Wave2-B: 学习桌面与全子应用 SOTA 深化（Workbench 数据安全事务/笔记/PDF/导图/翻译/作文/待办/Finder）
文件所有权：workbench/**、learning-hub（除 E 的判分点）、notes/pdf/翻译/作文/待办/Finder、Composer 桌面行为。coordinator.rs 归 D；tool_loop/缓存归 A；移动 44px/chrome 归 C；anki/qbank 服务层归 E。

【基线与分支（第一件事）】
1. git fetch origin cursor/0824-cde6，确认 tip（预期 061b4815；若前进以新 tip 为准并先读增量）。
2. git checkout -b cursor/0824-wave2-desktop-subapps-a875 origin/cursor/0824-cde6
3. 空提交 + push -u origin + 开 draft PR，base = cursor/0824-cde6，标题：
   「0824 Wave2-B: 学习桌面与全子应用 SOTA 深化（Workbench 数据安全事务/笔记/PDF/导图/翻译/作文/待办/Finder）」

【本会话组织（叠在通用铁律之上）】
- 10 轮 × 每轮 10 子代理。第 1–7 轮全 `claude-fable-5-thinking-high`；第 8–10 轮 fable xhigh ∶ GPT = 1:1。同文件同轮单人。
- 第 1–5 轮完成 95% 审+改；第 6–7 轮静态二检 + 写测试源码（不跑）；第 8–10 轮才允许 vitest/编译。SOTA 调研用 web search。

【必读输入】
- docs/0824-quality-review/workbench-fg.md（FAIL：两条状态安全缝是本会话第一优先）
- docs/0824-quality-review/learning-notes.md（四条 P1）
- docs/0824-quality-review/finder-hub.md、pdf-documents.md、mindmap.md、todo-templates.md、file-manager.md、translation.md、flashcards-fsrs.md（只取其 UI/宿主部分，复习算法归 E）
- docs/0824-quality-review/cross-cutting.md 第三节（Composer×移动 PASS 边界）与 workbench 相关段
- docs/0824-MERGE-PLAN.md Step 22（mindmap/pdf 修复 5ffd4900/1a0a7442/a25d56e4 已落，先复核不重做）

【红线】
- Workbench 卸载/冻结绕过脏数据的两条 FAIL 缝必须修（下方 P1/P2），这是本会话不可谈判的交付底线。
- 不碰：coordinator.rs（归 D）、tool_loop/hooks/prompt-cache（归 A）、Composer 移动热区与 44px 类名（归 C）、streaming_anki/critic/qbank 服务层与 questionBankStore（归 E）。Composer 桌面行为（ComposerPanelOverlay、桌面 overlay 语义、sendAvailability 桌面分支）归本会话。
- ExamContentView.tsx 的视图壳/宿主接线归 B，其判分与 store 调用点改动须与 E 的 verdict 原语对齐：只消费 E 定义的接口，不自造第二套判分语义。
- 禁整支 merge main/隔离枝；不复活 legacy InputBar/legacy notes；Finder 分桶隔离语义不许私自合桶（连续性走 handoff descriptor）。
- 移动端 chrome（顶栏/抽屉/返回/热区）归 C；本会话对子应用的改动若涉及移动分支，只动桌面分支或提交接口给 C。

【已知痛点路径】
P1 壳切换绕过脏数据（FAIL 缝一）：src/App.tsx:842-857（250ms 迟滞后直接卸载）、src/features/settings/components/WorkbenchSettingsSection.tsx:292-308（关模式不问 canClose）、src/features/workbench/components/WorkbenchDesktop.tsx:417-475、core/snapshot.ts（快照只存壳）。需要统一 deactivation transaction：枚举窗口 → canClose/保存检查点 → 任一取消则保持激活并回滚模式 UI。
P2 冻结绕过脏数据（FAIL 缝二）：core/scheduler.ts:44-53,117-123,542-575（LRU 冻结不查 dirty）、components/WindowBody.tsx:184-193、apps/content/contentDirtyRegistry.ts:24-81；消费者 src/components/TranslateWorkbench.tsx:386-429、EssayGradingWorkbench.tsx:233-239。需要 prepareSuspend/canSuspend 契约：dirty 窗保持 background 或验证保存成功后才 frozen。
P3 双向 handoff：core/legacyNavigationMap.ts:30-143 只管「下次打开去哪」；补 {appType, resourceId, innerRoute} handoff descriptor（Workbench→经典壳传焦点上下文；经典壳→Workbench 走 workbenchBus 开同一资源）。桌面平台窄窗是否继续换壳按评审建议 2 重议（桌面紧凑形态 vs 走事务）。
P4 Learning Hub 关标签非 fail-closed：src/features/learning-hub/LearningHubPage.tsx:279-290、apps/TabPanelContainer.tsx:32-102、src/features/notes/NotesCrepeEditor.tsx:994-1013——所有关闭/关他项/LRU 淘汰/离开页面接入 contentDirtyRegistry 异步 close gate。
P5 书签覆盖：apps/views/previewPersistence.ts:114-350（进度 payload 不带书签；书签走版本条件或 add/update/delete 协议）、src-tauri/src/dstu/handlers.rs:3561-3775（bookmarks 整数组覆盖无 OCC）；补两个阅读实例交错测试。
P6 保存落点：src/shared/notes/saveTextAsNote.ts:68-127（两步非原子、移动失败报成功）→ folderId+tags 纳入 dstu_create 一次提交（handlers.rs:721-808 已支持 folderId；tags 固定 vec![] 要修）；部分成功必须在 Result 与 toast 可见；入口收敛：TextbookContentView.tsx:526-544、FileContentView.tsx:277-297、EssayGradingWorkbench、quick-assistant/service.ts:227-236 统一到共享流程。
P7 PDF 划词双链路：src/features/pdf/components/EnhancedPdfViewer.tsx（链路 A ds-highlight-menu）与 PdfSelectionActions.tsx（链路 B SelectionToolbar）同屏——收敛为一条（保留高亮色板/页码 locator/来源标注 + 吸收「解释」与目录选择笔记），聊天通道三条归一；懒加载被静态导入抵消（EnhancedPdfViewer.tsx:83,89、PdfSelectionActions.tsx:28-30、selectionStudyActions.ts）修复；styles/enhanced-pdf.css 的 .ds-highlight-menu__divider 双定义合并。documentTitle=fileName 已在 Step 22 修（a25d56e4），先复核不重做。
P8 标签恢复过度清理：LearningHubPage.tsx:122-229——按稳定 resourceId 重绑定 path/title，仅实体不存在才删；persistedTabsCache 写入同步；OpenTab 完整版本化白名单解析。
P9 Workbench 旧快照多窗折叠、Notes Workspace 资源上限截断提示、Exposé 活体 DOM（core/snapshot.ts、apps/…/NotesWorkspaceApp、components/ExposeOverlay.tsx）——Exposé 改快照缩略图后置到第 8 轮（先保证冻结不丢草稿）。
P10 SOTA 对标（用户点名，必做调研并落地可静态实现部分）：笔记对标 Notion/Obsidian（双链/快速切换/命令面板深度）、PDF 对标 MarginNote/Zotero（摘录组织/回链）、导图对标 XMind、待办对标 Things/Todoist（自然语言/重复任务）、翻译对标 DeepL 沉浸式、工作台对标 macOS Mission Control/Arc（Exposé/空间/会话恢复）；每应用产出「差距清单 + 本轮可落地子集 + Agent 原生结合点（workbenchBus/AgentBridge/GenUI 块的双向调用）」。

【10 轮 × 10 子代理】
第 1 轮（对标调研 + 锚定 + 一行级速修）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 调研员-笔记 — Notion/Obsidian/RemNote 功能与 Agent 结合形态，对照 notes/NotesWorkspace 差距清单
 2. 调研员-PDF阅读 — MarginNote/Zotero/PDF Expert 摘录与批注体系，对照 EnhancedPdfViewer
 3. 调研员-工作台 — Mission Control/Arc/Stage Manager 的窗口/会话管理，对照 Workbench 调度与快照
 4. 调研员-待办导图翻译作文 — Things/Todoist/XMind/DeepL 与四个小应用差距
 5. 锚定员-workbench核心 — scheduler/snapshot/WindowBody/WorkbenchDesktop/legacyNavigationMap 当前 tip 全量读
 6. 锚定员-learning-hub — LearningHubPage/TabPanelContainer/UnifiedAppPanel/previewPersistence
 7. 锚定员-pdf — EnhancedPdfViewer/PdfSelectionActions/selectionStudyActions + 顺手修 CSS divider 双定义与懒加载静态导入两处一行级问题
 8. 锚定员-notes与保存链 — NotesCrepeEditor/saveTextAsNote/useSaveAsNoteFlow/notesDstuAdapter/dstu handlers 相关段
 9. 锚定员-Composer桌面 — ComposerPanelOverlay 与桌面 overlay 行为、sendAvailability 桌面分支现状
 10. 台账员 — 汇总产出 docs/dev/wave2-B-ledger.md + 轮末提交
第 2 轮（数据安全事务——最高优先）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. deactivation-1 — Workbench 统一停用事务：枚举窗口 + canClose/保存检查点框架（WorkbenchDesktop/App.tsx）
 2. deactivation-2 — 三个触发点接入事务：模式开关（WorkbenchSettingsSection）、断点切壳、应用退出
 3. suspend 契约 — scheduler 增加 canSuspend/prepareSuspend；dirty 窗不冻结或保存成功后冻结
 4. dirty registry 扩展 — contentDirtyRegistry 支撑 suspend 场景（查询不卸载）；四消费者（翻译/作文/notes/exam 视图壳）对齐
 5. LearningHub close gate — P4 全入口接入异步 close gate
 6. 回滚 UI — 事务取消时模式开关/断点 UI 状态回滚与用户提示（i18n 双语键）
 7. 测试-先行红灯 — dirty essay 关模式必须取消、dirty background 窗超预算不冻结两条行为测试
 8. 审阅员-生命周期 — 逐行审 1–5 的 React 卸载顺序与竞态
 9. 审阅员-快照 — snapshot 契约与事务的边界（壳状态 vs 草稿）书面化
 10. 提交员 — diff 组装 + 禁改区 grep 自检 + commit+push
第 3 轮（保存与落点统一）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. dstu 单次提交 — handlers.rs：createNote 消费 folderId + 持久化 tags（修 vec![] 固定）
 2. saveTextAsNote 收口 — 删两步模型；Result 区分「落目标目录/落根目录」；toast 明示实际位置；对应测试改判
 3. 入口收敛-1 — TextbookContentView/FileContentView 摘录笔记接共享流程（保留页码 locator 进正文模板）
 4. 入口收敛-2 — EssayGradingWorkbench 与 quick-assistant 保存路径接共享流程（quick-assistant 若判定为独立产品语义则书面豁免）
 5. 书签协议 — previewPersistence 进度/书签分离 + dstu handlers 书签增量或版本条件
 6. 书签测试 — 两个阅读实例交错的测试源码（写清红→绿预期；本轮禁止执行）
 7. 标签恢复 — P8 resourceId 重绑定 + 缓存一致性 + 版本化解析
 8. 审阅员-数据流 — 1–7 的前后端契约一致性逐条比对
 9. i18n 员 — 本轮新增文案双语键 + 既有死键清理（本域内）
 10. 提交员
第 4 轮（PDF 划词收敛 + 阅读器与子应用打磨）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 划词收敛-设计 — 单工具条终态设计定稿（吸收两链路各自优点，事件通道归一为带 locator 回调）
 2. 划词收敛-实现1 — 主工具条实现与高亮色板/翻译/解释/制卡入口迁移
 3. 划词收敛-实现2 — 删除冗余链路与死 CSS/死事件通道；懒加载策略恢复有效
 4. 阅读器残项 — pdfViewState 切文档继承语义注明或修正、搜索进度节流、无清理 key 的轻量 GC
 5. 导图打磨 — mindmap.md 评审残项落地（解压预算已修不重做；对标差距子集）
 6. 翻译/作文打磨 — 两 Workbench 的对标差距子集 + isActive 收口复核
 7. 待办/模板打磨 — todo-templates.md 残项 + 对标子集
 8. EPUB/教材 — EpubPreview 返回键守卫复核 + 教材阅读进度残项
 9. 审阅员 — 1–8 逐 diff
 10. 提交员
第 5 轮（跨壳连续性 + Agent 原生结合 + SOTA 第一批）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. handoff-1 — descriptor 定义与 Workbench→经典壳传递
 2. handoff-2 — 经典壳→Workbench 复用 workbenchBus 打开同一资源；桌面窄窗策略裁决落地
 3. Agent 结合-1 — workbenchBus/AgentBridge 能力面盘点：Agent 打开/操作子应用的缺口补齐（如打开指定笔记锚点、按资源发起制卡走 E 接口）
 4. Agent 结合-2 — GenUI 块与子应用的双向入口（只读边界不破：GenUI 仍不可写）
 5. SOTA-笔记 — 第 1 轮清单中可静态落地子集（如快速切换器/命令面板深度项）
 6. SOTA-PDF — 摘录组织/回链子集
 7. SOTA-工作台 — 会话恢复/空间管理子集
 8. 审阅员-边界 — 3–7 不越权（不碰 C/E 域文件）复核
 9. 台账更新员 — 95% 完成度对账，欠账列第 6 轮首位
 10. 提交员
第 6 轮（全面二检）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。10 名复核员按第 2–5 轮十个落地面一人一面逐 diff 复核（事务/冻结/关标签/保存链/书签/划词/handoff/Agent 结合/SOTA×2），翻案与补丁当轮落地；轮末提交。
第 7 轮（交互级测试源码补强，只写不跑）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。1 dirty 取消矩阵、2 冻结保护矩阵、3 跨断点恢复焦点资源、4 两窗书签交错、5 标签移动后重启恢复、6 保存部分成功可见性、7 划词单链路行为、8 handoff 双向、9 测试台账、10 提交员。
第 8 轮（本会话首次允许实测 + 性能）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。本轮起才允许跑编译/门禁/定向测试；环境不行立即停。1-4 vitest 定向（workbench/learning-hub/notes/pdf 四族，环境不行即停）、5 Exposé 快照缩略图落地、6 大库分页与虚拟化复核、7-8 性能静态推演（渲染热点/重复渲染）、9 红灯归因、10 提交员。
第 9 轮（扫尾）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-3 台账未闭合项、4 i18n/a11y 终扫（本域）、5 死代码/死 CSS、6 注释与设计文档终稿（docs/dev/wave2-B-*.md）、7-8 PR 描述初稿与「已验证/未验证」清单、9 风险清单、10 提交员。
第 10 轮（终检交付）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-4 全 PR diff 四人交叉终审（生命周期/数据流/UI/Agent 各一）、5 红线自证 grep、6 SOTA 差距清单终版（已做/未做/建议后续）、7 遗留风险、8 PR 描述定稿、9 台账归档、10 最终 commit+push。
```

### 2.3 会话 C：移动端 UI/UX 与使用体验

```text
你是 0824 Wave2 会话 C 的父代理，负责「移动端 UI/UX 与使用体验」方向：按仓内已有移动规范再扫一遍，并把散点补丁升级为体系化机制。

【Wave2 通用铁律——本会话必须整段遵守，不得删改。旧模板第 7 节「立刻 tauri 编译」作废。】

0. 原目标仍生效
把近 2–3 天大量改造 / PR / 枝逐一审阅并加法收口。CI 不当门禁。官方产品统一枝只有 `cursor/0824-cde6`（PR #269 → main）。合主线只用 #269，禁止反向合 main，禁止整支 merge 隔离 / 预演 / leftover / 带重复 G merge 的枝。本会话是 Wave2 五路之一，产物停在本会话独立枝 + draft PR；不整支合回官方 0824，除非用户后下令。

1. 子代理模型（本波覆盖旧「全程 fable:sol 1:1」）
- 第 1–7 轮：全部子代理只用 `claude-fable-5-thinking-high`。禁止 sol / GPT / 任何 GPT 系列，禁止 `claude-fable-5-thinking-xhigh`，禁止 `computerUse`（平台会绑到 Claude 4.5 Sonnet，不是 fable）。每轮约 10 个，全是 fable high。
- 第 8–10 轮：`claude-fable-5-thinking-xhigh` 与 `gpt-5.6-sol-xhigh-fast` 按 1:1（每轮约 5+5）。无 xhigh-fast 时 GPT 半边显式降到 `gpt-5.6-sol-high-fast`，并在轮末记录。fable 半边不要静默降到无关模型。
- 第 1–7 轮若 `claude-fable-5-thinking-high` 调不通：停、报、重试；不要偷偷换成 sol 或 xhigh 凑数。
- 父代理直改白名单：文档 / 注释 / 配置措辞，或不超过 10 行且不涉及业务逻辑 / 权限 / 数据面。产品代码必须派子代理。
- 每轮约 10 个子代理，任务不要切碎，每轮要有巨大且可靠进展。子代理要吃饱：文件清单 + 验收标准 + 禁改区写进任务卡。
- 任何情况下都不允许停止，除非用户明确说停。

2. 仓库 / 枝 / 写手
- 第一件事：`git fetch origin cursor/0824-cde6`，确认 tip。预期 `061b4815`（Step 23 文档）。若远端已前进，以新 tip 为基线并先派一名子代理读增量；禁止 reset，禁止 force-push 官方枝。
- 从 `origin/cursor/0824-cde6` 拉出本会话独立枝（枝名见下方专属节），立即空提交 + `push -u` + 开 draft PR，base = `cursor/0824-cde6`。
- 每轮结束立刻 `git add` / `commit` / `push` 并更新自己的 draft PR。半成品用 `wip:` 前缀。云会话被杀等于永久丢未推送工作。
- 子代理 `gh pr create` 常 403；父代理用平台 PR 工具。不要回帖 Slack / GitHub。不要改人类可能改过的 PR 正文（尤其 #269、#326）。
- 新枝名必须 `cursor/<descriptive>-a875` 或用户指定的 `cursor/<descriptive>-cde6`，全小写。
- 产品修复用独立 worktree（如 `/tmp/0824-wave2-*`），不要占脏工作区乱切官方枝。

3. 【最高优先级】第 8 轮之前禁止跑编译 / 门禁 / CI/CD / 测试
第 1–7 轮只做静态审阅 + 代码优化落地 + 写测试源码（不执行）+ 每轮 commit / push / 更新 draft PR。时间紧，编译和实测是浪费。

第 1–7 轮绝对禁止（出现即失败，立刻停掉该命令，不要补救式重跑）：
- 任何 `npm` / `npm ci` / `npm install` / `npm run` / `npx`（含 typecheck、vitest、vite、version:generate）
- 任何 `cargo` / `rustc` / `rustfmt` 执行态（check、test、build、fmt --check）
- `tsc` / `vite` / `node scripts/check-migrations.mjs` 执行
- 任何 CI/CD：`gh workflow`、推送后盯 checks、为变绿而改 workflow
- `tauri dev` / `tauri build` / 实机 / 浏览器实测 / `computerUse`
- 为跑通环境去装 `node_modules`、Rust 1.98、GTK、WebKit、pdfium、protoc

第 1–7 轮允许：读代码、改产品代码、新增/改测试文件（只写不跑）、grep / 静态推演、web search、commit + push。
「写一条会红的测试」= 把测试源码落盘并在台账写预期；不要执行它来看红绿。

第 8–10 轮才允许跑编译 / 四项硬门禁 / 定向测试。环境装不动、跑不完、被杀掉：立即停，如实记录，绝不空转。四项硬门禁只在第 8 轮及之后才可碰：
1. `npm run version:generate && npm run typecheck`
2. `npx vite build`
3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`（Rust 1.98.0）
4. `node scripts/check-migrations.mjs`
缺 `src/version.ts` 时用 `scripts/generate-version.mjs`，也只许第 8 轮及之后。Tauri 实机是后期打磨，不是本波主战场。

4. 18 项不变量（禁止破坏；第 1–7 轮用 grep / 读文件自证，不要跑测试套件）
1. pipeline hooks：ApprovalGateHook 必须保持 default 链首位 + TaskAuditHook
2. GenerativeUiExecutor 注册在 catch-all 前
3. H cache：prefix freeze + cache_write_tokens 全链在树
4. utf8_stream 有生产调用方
5. model_special_tokens（#200 未回流）
6. 闪卡只读，无 save_to_library 写回流
7. 无生产 ChatV2AnkiAdapter
8. cardAgent.startGeneration 两入口仍在
9. 附件 file 200MB / image 50MB
10. finder host buckets 分桶隔离
11. qbank-tools：daily_target 1..=50 等压缩契约
12. tombstone 复读 fail-closed
13. WebDAV decode_path
14. S3 normalize_endpoint
15. FTP 550/501 白名单
16. HPIAS 18-block + 会话隔离
17. 无 mythos-5 / haiku-5 真目录条目
18. NOTICES 在 legal/ + Composer* 拆分仍在 + G 44px / safe-area / Android back

5. 已完成主题仓，不要从零重来
E/C/H/A/T/B/D/F/G/leftovers-safe 已归并；#177 cherry 映射已落；Step 18–23 已在官方 0824。VFS `coordinator.rs` 必须加法式：保留 `apply_vfs_init_missing_tables`，再叠加 `pre_repair_vfs_v20260824_note_props`。禁止 merge rel-vfs 的 `2bfe7c31`。`origin/main` tip `b2a85a69` 已被 `5f324e1f` 语义超集吸收，禁止整支 merge main。

6. 明确忽略 / 不要整支合
dependabot / release-please / cla-signatures；#113/#123/#134/#155；#170/#198/#200；#203；#101–#103；#214 整支；#213 除已收 parser `e83d4081` + rustfmt `6a903224` 外 DROP；对照/隔离 PR #269 #293 #303–#325 #327 #344；全部 `0824-rehearse-*` / `0824-theme-*` / `0824-verify-*` / `0824-regress-*`。不要回放 Step 18 finder 源 SHA `9176740b` / `0a6344e1`。不要回放 Step 19 源 SHA `3d3516c3` / `c4a3382c` / `ef991061` / `e97b89ff` / `92c487f8` / `2ba5522d`。leftover 结论 A：开放 PR 无未吸收产品增量。MCP 存储分叉 + 空策略全放行是 v0.9.44 既有，不修。issue #122 聊天乱码仍 OPEN，不要记账为已修复。MERGE-PLAN 只追加新 Step，不改写更早 Step。

7. 工作习惯
- 五路文件所有权：A=agent/cache/tool_loop；B=desktop 子应用；C=mobile UI；D=cloud/data/`coordinator.rs`；E=Anki/qbank。越权文件只读，改动记台账给对应路。
- 五枝同 base 平行，不互相 merge，不 cherry-pick 对方枝。
- 归因诚实：v0.9.44 既有债可修但提交信息标 `legacy:`。PR 描述必须带「已验证 / 未验证」两栏；第 1–7 轮「已验证」只能写静态证据，不能写「测试已跑绿」。
- 文档只追加。不要标 Goal complete。
- 禁用 computerUse。行业调研用 web search。

【本会话专属身份】
方向：mobile-uiux-unify 五条规范 + 触控目标下沉 + 浮层所有权 + i18n 守卫。
独立枝：`cursor/0824-wave2-mobile-uiux-a875`
draft PR 标题：0824 Wave2-C: 移动端 UI/UX 全面扫描与体系化收敛（规范五条/触控目标下沉/浮层所有权/i18n 守卫）
文件所有权：Composer 移动热区、mobileShell、44px/coarse、AppMenu、eslint-rules、check-i18n。不要再开十路同构 44px 散点小修。coordinator.rs 归 D；tool_loop/缓存归 A；桌面 Composer 归 B；anki/qbank 域逻辑归 E。

【基线与分支（第一件事）】
1. git fetch origin cursor/0824-cde6，确认 tip（预期 061b4815；若前进以新 tip 为准并先读增量）。
2. git checkout -b cursor/0824-wave2-mobile-uiux-a875 origin/cursor/0824-cde6
3. 空提交 + push -u origin + 开 draft PR，base = cursor/0824-cde6，标题：
   「0824 Wave2-C: 移动端 UI/UX 全面扫描与体系化收敛（规范五条/触控目标下沉/浮层所有权/i18n 守卫）」

【本会话组织（叠在通用铁律之上）】
- 10 轮 × 每轮 10 子代理。第 1–7 轮全 `claude-fable-5-thinking-high`；第 8–10 轮 fable xhigh ∶ GPT = 1:1。同文件同轮单人。
- 第 1–5 轮完成 95% 审+改；第 6–7 轮静态二检 + 写交互序列测试源码（不跑）；第 8–10 轮才允许 vitest。真机本会话做不了——终报告如实留白。

【必读输入】
- docs/dev/mobile-uiux-unify/README.md（五条统一规范=验收口径：全局顶栏唯一/左侧按钮语义/右侧≤2 个 44px 动作/禁桌面组件滥用/可达且可回退）+ INVENTORY.md + PROGRESS.md
- docs/0824-quality-review/mobile-i18n.md（WARN：六条缺陷与收口顺序——本会话核心任务书）
- docs/0824-quality-review/cross-cutting.md 第三节（Composer×移动静态 PASS 的保留边界）
- docs/0824-quality-review/workbench-fg.md「G 侧仍需保留的边界」段
- docs/0824-MERGE-PLAN.md Step 21（rel-mobile 附件面板 i18n 已落）

【红线】
- 【最高红线】不要再开十路同构 44px 散点小修：任何新增触控目标必须走本会话第 3 轮建立的体系化机制（组件默认 + lint），发现散点问题记台账由机制批量吃掉，禁止逐处手贴 !min-h-11。
- 不碰：coordinator.rs（D）、tool_loop/hooks/缓存链（A）、Composer 桌面行为与 ComposerPanelOverlay 桌面语义（B）、anki/qbank 服务层（E）。Composer 移动热区（InputBarUI 移动分支、ComposerInlinePanel、AttachmentPanelBody、ComposerPlusMenu、移动 44px/coarse 类名）归本会话。
- 附件删除生命周期统一涉及 src/features/chat/core/store/sessionActions.ts——该文件本会话可改，但只许收敛 remove/clear 动作语义，不许动发送/流式相关段。
- 不把 sidebar 缺键类 v0.9.44 既有债当 0824 回归记账（修可以，归因要诚实）。
- 保守哲学：任何外点关闭/返回键/焦点改动必须配 pointer 序列级测试（pointerdown→pointerup→click 全链），不许只断言「按钮存在」。

【已知痛点路径】
P1（高，发布级）AppMenu portal 外点关闭冲突：src/features/chat/components/input-bar/InputBarUI.tsx:1387-1420 的 document pointerdown 只认三个 ref，不认 [data-app-menu-id]（焦点门控 :1064-1067 已认，两套逻辑没接齐）；src/components/ui/app-menu/AppMenu.tsx:491-600 portal 到 body、动作在 click 才执行——移动附件面板「更多」菜单项可能在 click 前被卸载。短期排除本 Composer 拥有的 menu portal；长期 overlay coordinator 提供「本面板拥有的浮层」所有权关系。
P2 附件生命周期双所有者：AttachmentPanelBody.tsx:91-128（自带取消/revoke）vs AttachmentPreviewChips.tsx:352-357（裸 onRemove）vs src/features/chat/core/store/sessionActions.ts:204-306——收敛为单一 remove/clear 领域动作，UI 只传 id；补「从 chip 删除也取消处理」回归。
P3 触控目标体系化：ComposerToolbar.tsx:54-57,574-575 伪元素 after:-inset 相邻重叠、水位环双重扩区（ContextUsagePopover.tsx:87-95）——coarse 布局改实体 44×44 flex box；建立 TouchTarget 语义组件或 DsButton 默认下沉 + eslint-rules/ 全库静态 lint（这是「拒绝散点」的机制载体）。
P4 能力判定分离：InputBarUI.tsx:804-808 用 (pointer:coarse) 同时当「移动环境+触摸+相机」——layout 由宽度、touch 由 any-pointer:coarse、camera 由平台/捕获能力，三者分开。
P5 面板 a11y/键盘：ComposerInlinePanel.tsx:50-96 closing 无 inert/aria-hidden；:51-54 min 160px 短横屏强撑；InputBarUI.tsx:2167-2172 硬编码英文 Skills region；水位环 role="img"（ComposerToolbar.tsx:203-212）；AppMenu.tsx:319-395 不用 visualViewport（对照 ComposerPanelOverlay.tsx:75-79,150-175 的正确实现）。
P6 i18n 守卫盲区：inputBarSplitI18nKeys.contract.test.ts 不扫模板字符串（ComposerPlusMenu.tsx:385-388,548-554 permission preset 动态键、AttachmentPanelBody.tsx:333 upload stage 动态键）；resolveKey 叶子为 object 也判成功；common:actions.more 死别名两测试锁相反方向；src/components/layout/MobileSidebarNavigation.tsx:132-133 引用缺失的 sidebar:mobile_drawer.section_study/section_manage（既有债，修+诚实归因）；scripts/check-i18n.mjs 存在但未接 CI——把「全部 t() 引用键双语存在」升级为静态检查。
P7 全应用移动 chrome 重扫：以 README 五条为口径逐视图核验（useMobileHeader 注册、返回语义、右侧动作数、禁 ResizablePanel/宽表/hover-only、可达可回退），覆盖 learning-hub 移动、PDF/EPUB 移动（pdfMobilePanelTabs）、anki/qbank 页移动 chrome（仅 chrome，域逻辑归 E）、设置/数据治理移动、Chat 移动。
P8 移动壳底座：src/app/shell/mobileShell.ts、src/hooks/useKeyboardHeight.ts（Android adjustResize vs iOS overlay 分支）、Android back 链（面板→菜单→页面的消费顺序）——静态核验 + 契约测试补强，不重写底座。

【10 轮 × 10 子代理】
第 1 轮（全库移动面清单 + 速修）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 扫描员-Composer移动 — InputBarUI 移动分支/InlinePanel/PlusMenu/AttachmentPanelBody 现状台账
 2. 扫描员-learning-hub移动 — 移动 Learning Hub/阅读器移动 chrome 按五条规范逐页核验
 3. 扫描员-PDF/EPUB移动 — 移动 panel tabs/工具条/返回键
 4. 扫描员-anki+qbank移动chrome — 卡片块/任务台/练习页的移动 chrome（不碰域逻辑）
 5. 扫描员-设置与数据治理移动 — 设置页族移动形态
 6. 扫描员-壳与导航 — UnifiedMobileHeader 注册表/抽屉/reachability 契约现状 + 顺手补 MobileSidebarNavigation 两个缺键（双语）
 7. 扫描员-浮层体系 — AppMenu/portal/overlay 全消费点清单（P1 波及面）
 8. 扫描员-键盘与back链 — useKeyboardHeight/mobileShell/back 注册全链
 9. 扫描员-44px现状 — 全库 coarse 规则统计、伪元素 vs 实体分布、DsButton/DsDialog 现状与下沉可行性评估
 10. 台账员 — 汇总产出 docs/dev/wave2-C-ledger.md（按 P1–P8 归组 + 五条规范逐页核验表）+ 提交
第 2 轮（浮层所有权与事件序——P1 最高优先）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 外点判定修复 — InputBarUI pointerdown 判定补 menu portal 所有权（短期方案落地）
 2. overlay coordinator — 「面板拥有的浮层」注册关系设计 + 最小实现（供长期）
 3. AppMenu 定位 — visualViewport 定位复用 ComposerPanelOverlay 基础设施
 4. back 链协同 — Android back 先关菜单再关面板的顺序落地
 5. 测试-pointer 序列 — 资源库/拍照/全部清除三动作的 pointerdown→click 全链测试（源码层写清修复前应红、修复后应绿；本轮禁止执行）
 6. 测试-back 链 — 菜单开→back→面板仍开→back→面板关 序列测试
 7. 桌面波及复核 — 桌面附件面板内 AppMenu 同类风险核验（改动限移动共享层，桌面专属行为通报 B）
 8. 审阅员-事件序 — 1–4 的 capture/bubble/passive 细节逐行审
 9. 审阅员-回归面 — 全库其他 document-level pointerdown 消费点有无同构问题
 10. 提交员 — diff 组装 + 禁改区自检 + commit+push
第 3 轮（触控目标体系化——「拒绝散点」的机制轮）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. TouchTarget 设计 — 语义组件/DsButton 默认下沉方案定稿（coarse 下实体 ≥44px、视觉尺寸与命中分离）
 2. DsButton 下沉实现 — 基础组件默认行为落地
 3. lint 规则 — eslint-rules/ 新增「coarse 目标必须走体系组件」静态检查（先 warn 白名单制）
 4. 替换-Composer — ComposerToolbar/水位环等第一批高频散点替换为实体目标（消除伪元素重叠）
 5. 替换-附件面板 — AttachmentPanelBody/PlusMenu 行目标体系化
 6. 能力分离 — P4：any-pointer/触摸/相机三分离落地
 7. 测试-命中 — elementFromPoint 级相邻控件命中测试（jsdom 能测的部分）+ 源码契约测试迁移策略（保所有权断言、弃尺寸计数断言）
 8. 审阅员-视觉 — 替换后视觉尺寸不变（图标 24/28/36 保持）逐处核
 9. 审阅员-lint — 规则误报率与白名单边界
 10. 提交员
第 4 轮（附件动作统一 + 面板 a11y）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. remove/clear 单一动作 — sessionActions.ts 收敛取消处理/ContextRef/状态/Blob 回收；UI 只传 id
 2. chip 路径对齐 — AttachmentPreviewChips 走同一动作 + 回归测试
 3. inert 落地 — ComposerInlinePanel closing 即 inert/aria-hidden
 4. clamp 修正 — 160px min 与短横屏键盘的 max 约束
 5. Skills region — 硬编码改 skills:title；水位环 role/焦点语义修正
 6. 读屏顺序 — 内联面板展开的焦点顺序静态断言
 7. 测试-附件生命周期 — 面板删/chip 删/清空三路径语义一致测试
 8. 审阅员-store — 1–2 不动发送/流式段的边界自证
 9. 审阅员-a11y — 3–6 aria 语义复核
 10. 提交员
第 5 轮（全应用移动 chrome 补齐 + i18n 守卫升级）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. chrome 修复-learning-hub — 第 1 轮核验表中 learning-hub 违规项批量修（走体系组件）
 2. chrome 修复-PDF/EPUB — 同上
 3. chrome 修复-anki/qbank页 — 同上（仅 chrome）
 4. chrome 修复-设置/数据治理 — 同上
 5. chrome 修复-Chat 移动 — 同上
 6. i18n 守卫-AST — 契约测试改 AST/类型化 key 提取；动态枚举逐值展开；叶子必须非空字符串
 7. i18n 清理 — actions.more 死别名裁决（删或正式声明 alias）+ 本域缺键补齐
 8. check-i18n 接线 — scripts/check-i18n.mjs 修缮为可 CI 化的全量键校验（本会话先接 vitest/独立 npm script，不动 CI 工作流文件）
 9. 台账对账员 — 95% 完成度对账，欠账列第 6 轮首位
 10. 提交员
第 6 轮（全面二检）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。10 名复核员按第 2–5 轮落地面一人一面逐 diff 复核（浮层/coordinator/触控体系/lint/能力分离/附件动作/a11y/chrome×2/i18n），翻案与补丁当轮落地；提交。
第 7 轮（交互序列测试源码补强，只写不跑）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。1 全浮层 pointer 序列矩阵、2 back 链全场景、3 键盘 inset 场景（Android/iOS 分支）、4 safe-area 断言、5 读屏顺序、6 附件三路径、7 命中测试补遗、8 i18n 动态键矩阵、9 测试台账、10 提交员。
第 8 轮（散点收敛放量 + 本会话首次允许实测）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。本轮起才允许跑编译/门禁/定向测试；环境不行立即停。1-4 lint 白名单收敛（warn→error 分批放量，批量替换剩余散点——这是机制吃散点，不是散点小修）、5-6 vitest 定向（input-bar 族/mobile 契约族，环境不行即停）、7-8 红灯归因、9 台账更新、10 提交员。
第 9 轮（扫尾）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-3 台账未闭合项、4 暗色/字号缩放/溢出页残项、5 死键死类清理、6 注释与规范文档更新（mobile-uiux-unify 增补 Wave2 条目）、7-8 PR 描述初稿 + 真机留白清单（键盘 inset 实机/厂商 WebView/VoiceOver-TalkBack/44px 实际命中——如实标注未验证）、9 风险清单、10 提交员。
第 10 轮（终检交付）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-4 全 PR diff 四人交叉终审（事件序/组件体系/a11y/i18n）、5 红线自证（无新散点 44px 类名 grep 证明、禁改区未动）、6 五条规范逐页终验表、7 遗留风险、8 PR 描述定稿、9 台账归档、10 最终 commit+push。
```

### 2.4 会话 D：云存储/同步/备份 + 数据库迁移 + 历史库兼容

```text
你是 0824 Wave2 会话 D 的父代理，负责「云存储/同步/备份 + 数据库迁移 + 历史库兼容」方向。这是全产品唯一能造成用户数据不可逆损失的领域。

【Wave2 通用铁律——本会话必须整段遵守，不得删改。旧模板第 7 节「立刻 tauri 编译」作废。】

0. 原目标仍生效
把近 2–3 天大量改造 / PR / 枝逐一审阅并加法收口。CI 不当门禁。官方产品统一枝只有 `cursor/0824-cde6`（PR #269 → main）。合主线只用 #269，禁止反向合 main，禁止整支 merge 隔离 / 预演 / leftover / 带重复 G merge 的枝。本会话是 Wave2 五路之一，产物停在本会话独立枝 + draft PR；不整支合回官方 0824，除非用户后下令。

1. 子代理模型（本波覆盖旧「全程 fable:sol 1:1」）
- 第 1–7 轮：全部子代理只用 `claude-fable-5-thinking-high`。禁止 sol / GPT / 任何 GPT 系列，禁止 `claude-fable-5-thinking-xhigh`，禁止 `computerUse`（平台会绑到 Claude 4.5 Sonnet，不是 fable）。每轮约 10 个，全是 fable high。
- 第 8–10 轮：`claude-fable-5-thinking-xhigh` 与 `gpt-5.6-sol-xhigh-fast` 按 1:1（每轮约 5+5）。无 xhigh-fast 时 GPT 半边显式降到 `gpt-5.6-sol-high-fast`，并在轮末记录。fable 半边不要静默降到无关模型。
- 第 1–7 轮若 `claude-fable-5-thinking-high` 调不通：停、报、重试；不要偷偷换成 sol 或 xhigh 凑数。
- 父代理直改白名单：文档 / 注释 / 配置措辞，或不超过 10 行且不涉及业务逻辑 / 权限 / 数据面。产品代码必须派子代理。
- 每轮约 10 个子代理，任务不要切碎，每轮要有巨大且可靠进展。子代理要吃饱：文件清单 + 验收标准 + 禁改区写进任务卡。
- 任何情况下都不允许停止，除非用户明确说停。

2. 仓库 / 枝 / 写手
- 第一件事：`git fetch origin cursor/0824-cde6`，确认 tip。预期 `061b4815`（Step 23 文档）。若远端已前进，以新 tip 为基线并先派一名子代理读增量；禁止 reset，禁止 force-push 官方枝。
- 从 `origin/cursor/0824-cde6` 拉出本会话独立枝（枝名见下方专属节），立即空提交 + `push -u` + 开 draft PR，base = `cursor/0824-cde6`。
- 每轮结束立刻 `git add` / `commit` / `push` 并更新自己的 draft PR。半成品用 `wip:` 前缀。云会话被杀等于永久丢未推送工作。
- 子代理 `gh pr create` 常 403；父代理用平台 PR 工具。不要回帖 Slack / GitHub。不要改人类可能改过的 PR 正文（尤其 #269、#326）。
- 新枝名必须 `cursor/<descriptive>-a875` 或用户指定的 `cursor/<descriptive>-cde6`，全小写。
- 产品修复用独立 worktree（如 `/tmp/0824-wave2-*`），不要占脏工作区乱切官方枝。

3. 【最高优先级】第 8 轮之前禁止跑编译 / 门禁 / CI/CD / 测试
第 1–7 轮只做静态审阅 + 代码优化落地 + 写测试源码（不执行）+ 每轮 commit / push / 更新 draft PR。时间紧，编译和实测是浪费。

第 1–7 轮绝对禁止（出现即失败，立刻停掉该命令，不要补救式重跑）：
- 任何 `npm` / `npm ci` / `npm install` / `npm run` / `npx`（含 typecheck、vitest、vite、version:generate）
- 任何 `cargo` / `rustc` / `rustfmt` 执行态（check、test、build、fmt --check）
- `tsc` / `vite` / `node scripts/check-migrations.mjs` 执行
- 任何 CI/CD：`gh workflow`、推送后盯 checks、为变绿而改 workflow
- `tauri dev` / `tauri build` / 实机 / 浏览器实测 / `computerUse`
- 为跑通环境去装 `node_modules`、Rust 1.98、GTK、WebKit、pdfium、protoc

第 1–7 轮允许：读代码、改产品代码、新增/改测试文件（只写不跑）、grep / 静态推演、web search、commit + push。
「写一条会红的测试」= 把测试源码落盘并在台账写预期；不要执行它来看红绿。

第 8–10 轮才允许跑编译 / 四项硬门禁 / 定向测试。环境装不动、跑不完、被杀掉：立即停，如实记录，绝不空转。四项硬门禁只在第 8 轮及之后才可碰：
1. `npm run version:generate && npm run typecheck`
2. `npx vite build`
3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`（Rust 1.98.0）
4. `node scripts/check-migrations.mjs`
缺 `src/version.ts` 时用 `scripts/generate-version.mjs`，也只许第 8 轮及之后。Tauri 实机是后期打磨，不是本波主战场。

4. 18 项不变量（禁止破坏；第 1–7 轮用 grep / 读文件自证，不要跑测试套件）
1. pipeline hooks：ApprovalGateHook 必须保持 default 链首位 + TaskAuditHook
2. GenerativeUiExecutor 注册在 catch-all 前
3. H cache：prefix freeze + cache_write_tokens 全链在树
4. utf8_stream 有生产调用方
5. model_special_tokens（#200 未回流）
6. 闪卡只读，无 save_to_library 写回流
7. 无生产 ChatV2AnkiAdapter
8. cardAgent.startGeneration 两入口仍在
9. 附件 file 200MB / image 50MB
10. finder host buckets 分桶隔离
11. qbank-tools：daily_target 1..=50 等压缩契约
12. tombstone 复读 fail-closed
13. WebDAV decode_path
14. S3 normalize_endpoint
15. FTP 550/501 白名单
16. HPIAS 18-block + 会话隔离
17. 无 mythos-5 / haiku-5 真目录条目
18. NOTICES 在 legal/ + Composer* 拆分仍在 + G 44px / safe-area / Android back

5. 已完成主题仓，不要从零重来
E/C/H/A/T/B/D/F/G/leftovers-safe 已归并；#177 cherry 映射已落；Step 18–23 已在官方 0824。VFS `coordinator.rs` 必须加法式：保留 `apply_vfs_init_missing_tables`，再叠加 `pre_repair_vfs_v20260824_note_props`。禁止 merge rel-vfs 的 `2bfe7c31`。`origin/main` tip `b2a85a69` 已被 `5f324e1f` 语义超集吸收，禁止整支 merge main。

6. 明确忽略 / 不要整支合
dependabot / release-please / cla-signatures；#113/#123/#134/#155；#170/#198/#200；#203；#101–#103；#214 整支；#213 除已收 parser `e83d4081` + rustfmt `6a903224` 外 DROP；对照/隔离 PR #269 #293 #303–#325 #327 #344；全部 `0824-rehearse-*` / `0824-theme-*` / `0824-verify-*` / `0824-regress-*`。不要回放 Step 18 finder 源 SHA `9176740b` / `0a6344e1`。不要回放 Step 19 源 SHA `3d3516c3` / `c4a3382c` / `ef991061` / `e97b89ff` / `92c487f8` / `2ba5522d`。leftover 结论 A：开放 PR 无未吸收产品增量。MCP 存储分叉 + 空策略全放行是 v0.9.44 既有，不修。issue #122 聊天乱码仍 OPEN，不要记账为已修复。MERGE-PLAN 只追加新 Step，不改写更早 Step。

7. 工作习惯
- 五路文件所有权：A=agent/cache/tool_loop；B=desktop 子应用；C=mobile UI；D=cloud/data/`coordinator.rs`；E=Anki/qbank。越权文件只读，改动记台账给对应路。
- 五枝同 base 平行，不互相 merge，不 cherry-pick 对方枝。
- 归因诚实：v0.9.44 既有债可修但提交信息标 `legacy:`。PR 描述必须带「已验证 / 未验证」两栏；第 1–7 轮「已验证」只能写静态证据，不能写「测试已跑绿」。
- 文档只追加。不要标 Goal complete。
- 禁用 computerUse。行业调研用 web search。

【本会话专属身份】
方向：配置事务 / auto-sync 生命周期 / E2EE / 恢复编排 / 稀疏库 / 升级兼容。
独立枝：`cursor/0824-wave2-cloud-data-a875`
draft PR 标题：0824 Wave2-D: 云同步/备份恢复/迁移与历史库兼容深化（配置事务/E2EE 并发/恢复编排/非理想输入闭环）
文件所有权：coordinator.rs（及 migration/ 全目录）、cloud_storage/**、data_governance/**、crypto*、secure_store、CloudStorageSection。其余四路一律不碰 coordinator.rs。禁真实商业云凭据，绝不执行会清空真实数据槽的操作。

【基线与分支（第一件事）】
1. git fetch origin cursor/0824-cde6，确认 tip（预期 061b4815；若前进以新 tip 为准并先读增量）。
2. git checkout -b cursor/0824-wave2-cloud-data-a875 origin/cursor/0824-cde6
3. 空提交 + push -u origin + 开 draft PR，base = cursor/0824-cde6，标题：
   「0824 Wave2-D: 云同步/备份恢复/迁移与历史库兼容深化（配置事务/E2EE 并发/恢复编排/非理想输入闭环）」

【本会话组织（叠在通用铁律之上）】
- 10 轮 × 每轮 10 子代理。第 1–7 轮全 `claude-fable-5-thinking-high`；第 8–10 轮 fable xhigh ∶ GPT = 1:1。同文件同轮单人。
- 第 1–5 轮完成 95% 审+改；第 6–7 轮静态二检 + 写故障注入测试源码（不跑）；第 8–10 轮才允许 cargo test/vitest。装不动 pdfium 就停，测试源码留给以后跑。禁真实商业云凭据，绝不清空真实数据槽。

【必读输入】
- docs/0824-quality-review/cloud-sync.md（三条 P1：内存 GET 无上限/复读无恢复协议/E2EE 认领竞态）
- docs/0824-quality-review/backup-restore.md（P1 宣称已修于 Step 22，其 P3×6 与优化×4 大多仍开放）
- docs/0824-quality-review/vfs-governance.md（三条阻断中 #1/#3 已修于 Step 22，#2 持久域未消费仍开放）
- docs/0824-quality-review/upgrade-path.md（坑一短口令/NULL-source 去重已修于 Step 22；prove 成本/明文窗口/i18n 混杂仍开放）
- docs/0824-quality-review/cross-cutting.md 第二节（设置×云同步 FAIL：三条接缝全开放）
- docs/0824-MERGE-PLAN.md Step 22（backup #334/#339、restore #330/#340、upgrade #342/#343 共 11 个 pick 的内容——先复核已修项不重做，但注意这批修复零测试验证，二检权在本会话）

【红线】
- 【最高红线，不可回退】src-tauri/src/data_governance/migration/coordinator.rs 的两个加法函数必须原样保留并只许加法式扩展：apply_vfs_init_missing_tables（定义约 :2383、生产调用 :2280、测试 :5873）与 pre_repair_vfs_v20260824_note_props（定义 :2345、调用 :2331、测试 :5388）。任何 coordinator 改动收轮时必须 grep 自证两函数与其调用点仍在。
- 修复必须 fail-closed 优先：宁可拒绝不可静默降级/静默成功；但也不许把 fail-closed 做成无出口死路（backup-restore 评审 P2 的教训）。
- 已存量口令/旧备份的兼容承诺不许收紧：DSBK v1/v2 可解、默认 Argon2 参数不变、KDF 上限只许放宽方向（migration-lock 与既有单测锁定）。
- MCP 存储分叉/空策略全放行是 v0.9.44 存量（11 号审计已裁决），不当 0824 回归修，不混入本 PR。
- 迁移新增必须幂等/可空/可降级，且同步更新 migration-lock.json 与 fixture；禁止表重建与长事务回填。
- 禁整支 merge main/隔离枝（main 的 b2a85a69 已被语义超集吸收，重复摘取零收益纯风险）。

【已知痛点路径】
P1 测试连接先发布后测试：src/features/settings/components/CloudStorageSection.tsx（doTestConnection：saveCredentials→saveCloudConfigSsot→checkConnection，失败不回滚）→ 草稿/测试/发布状态机：后端一次性草稿配置+凭据完成验证，成功后单命令原子提交（src-tauri/src/cloud_config_commands.rs、secure_store.rs:2055-2076 的非版本化全局记录要引入 staged generation + active pointer）。
P2 auto-sync 生命周期：src/stores/syncStatusStore.ts:504-512（ensureAutoSyncSchedulerStarted 只在 SyncSettingsSection.tsx:124 / SyncTab.tsx:173 挂载）→ 调度器所有权上移 App/服务层，hydration 完成后幂等启动；补「重启不进设置仍排程」测试。
P3 E2EE marker 并发认领：src-tauri/src/cloud_storage/sync_manager.rs:566-847——首次认领/v1 升级无远端 CAS；两设备不同口令可各自认领成功。设计远端租约或 provider 条件写抽象；发布备份对象前复验 verifier 未变。
P4 内存 GET 无字节预算：webdav.rs:1219-1254、s3.rs:797-832——控制对象（manifest/tombstone/marker/租约）加调用方传入的硬预算；声明超限先拒、累计超限中断、无声明长度 bounded buffer；补「持续小块/超大 Content-Length/无长度」三类回归。
P5 复读发现坏写无恢复协议：tombstone 短哈希坏对象永久 fail-closed、per-device manifest 坏正式对象令整体读取失败而 .tmp 只是残留——抽象 verified publish primitive（对象类型预算+版本条件+恢复策略），坏写后下一轮可自动收敛或可审计隔离；tombstone 直接命令（commands_sync.rs:3875-3934）纳入同设备串行化。
P6 手动下载防降级不对称：cloud_storage/mod.rs:503-557——下载前读 marker，marker 在而对象非 DSBK 直接稳定防降级错误。
P7 持久域未消费（vfs-governance 阻断 #2，Step 22 未修）：src-tauri/src/data_governance/commands_restore.rs 主命令不调 restore_audit_db_from_manifest、跳过 persistent/（webview_settings/custom_grading_modes）——恢复编排改为直接消费 DomainRestorePlan，每个 Complete 域必须有明确终态（已恢复/合并/隔离待信任/失败），成功前断言无未消费 complete domain。
P8 稀疏 VFS init 契约：apply_vfs_init_missing_tables 只提取 CREATE TABLE IF NOT EXISTS，不补 idx_folders_parent/questions_fts/trash_view（migration/vfs.rs:56-223 的 verifier 契约）——先写「V20260130 已记账、物理库仅 resources/notes」的完整 coordinator 级测试立证 fail-closed 形态，再做产品决策：安全重建 init 缺失对象（加法式、不绕 verifier）或明确文案化拒绝；两个方向工作量差一个数量级，测试立证后再选。
P9 crypto journal 故障矩阵：src-tauri/src/crypto_publication.rs（Step 22 新增，仅正常路径测试）——journal 写后/rename 中/pending-slot 注册前分别注入 crash 的测试矩阵，断言「活跃槽/全局密钥/审计库」要么全旧要么可恢复。
P10 notes.props 语义：src-tauri/src/vfs/repos/note_repo.rs:2164-2194 畸形 props 静默 None 无告警——至少告警+计数；键语法与搜索语法统一（共享测试向量）；number/bool 编辑类型退化裁决；props 过滤 N+1 的投影表方向记设计稿（大实现可后置）。
P11 口令与导出打磨：prove 全量下载改首块验证（v2 每块独立 AEAD tag）+ 失败回退次新版本；错密码前置首块试解（秒级失败）；便携包+误输口令条目名前置检查；导出双实现合并为 export_backup_to_zip 单实现 + 进度回调 + 取消（src-tauri/src/data_governance/commands_zip.rs:874-909、backup/zip_export.rs）；续传 skip 把 manifest.json 列为不可跳过；KDF 上限按平台收紧（移动 256MiB）；弱口令熵检查/黑名单；EncryptedRootMemory 持久化失败状态暴露到设置页。
P12 迁移与兼容：V20260824 NULL-source 去重已修（5c3cb512）——复核其在 tip 的实现与 fixture 是否真含碰撞对，缺则补；「迁移触发同步传播」（规范化行进 change_log 后多设备混版本）补契约测试或同步侧标记；升级窗口明文混布时间点文档化；后端用户可见错误收敛 code-only（前端 localizeCloudError.ts 已有稳定码机制）；持久化状态集中版本迁移框架立设计稿；backup-v2/delta 族产品决策（experimental 隔离或排期接线，禁继续加孤立原语）；coordinator 声明式 repair step 设计稿（中期，不本轮重构）。

【10 轮 × 10 子代理】
第 1 轮（锚定 + 台账 + 低风险速修）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 锚定员-sync主链 — sync_manager.rs 全量读（manifest/复读/E2EE 状态机现状）
 2. 锚定员-provider — webdav.rs/s3.rs/ftp.rs 读取路径与 GET 缓冲现状
 3. 锚定员-crypto — crypto/backup_crypto.rs + crypto_publication.rs（tip 上的 Step 22 新文件）+ secure_store.rs 口令链
 4. 锚定员-zip/backup — backup/zip_export.rs、commands_zip.rs、commands_backup.rs 导出/导入/续传链
 5. 锚定员-restore — commands_restore.rs 当前编排（Step 22 后 restore_crypto_keys_from_manifest_transactional 已接，复核）+ DomainRestorePlan 消费缺口清单
 6. 锚定员-coordinator — coordinator.rs 两加法函数行号级证据 + repair 特例链地图（红线基础）
 7. 锚定员-前端配置 — CloudStorageSection/syncStatusStore/cloudStorageApi/cloud_config_commands 事务边界现状
 8. 速修员 — EncryptedRootMemory 状态暴露 + manifest.json 不可跳过 + FTP ensure_directory 日志分级三件低风险小修
 9. 复核员-Step22 — backup/restore/upgrade 11 个 pick 在 tip 的语义逐条复核（评审宣称已修项到代码实证）
 10. 台账员 — docs/dev/wave2-D-ledger.md（P1–P12 归组 + Step22 复核结论）+ 提交
第 2 轮（配置事务与调度生命周期——FAIL 面处置）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 状态机设计 — 草稿/测试/发布三态 + staged generation 定稿
 2. 后端测试命令 — 一次性草稿配置+凭据的 test_connection 后端命令（不改 active SSOT）
 3. 原子发布命令 — 配置版本+凭据单命令提交；失败保持旧 generation；clear 的 partial 语义收敛
 4. 前端接线 — CloudStorageSection 三态 UI 改造（测试按钮只测试）
 5. auto-sync 上移 — App/服务层 hydration 后幂等启动；设置页只编辑展示
 6. 红灯测试 — 「测试失败 SSOT 未变」「重启不进设置 timer 存在」两条行为测试源码（写清修复前应红；本轮禁止执行）
 7. 并发窗口 — 配置 mutation 与同步读取的 generation/锁协同（含 BACKUP_GLOBAL_LIMITER 关系书面化）
 8. 审阅员-secure_store — staged generation 与既有「非空覆盖」语义的兼容审查
 9. 审阅员-迁移面 — localStorage→SSOT 一次性迁移与新状态机的组合（老用户短口令组合效应复核）
 10. 提交员 — diff 组装 + coordinator 红线 grep 自证 + commit+push
第 3 轮（恢复编排收口）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. DomainRestorePlan 消费-1 — 恢复编排按 plan 分发（替代后缀/目录名第二套规则）
 2. DomainRestorePlan 消费-2 — audit/webview_settings/custom_grading_modes 三域明确终态 + user-skills 隔离待信任可见态
 3. 未消费断言 — 成功前断言无未消费 complete domain + 稳定错误码
 4. 稀疏库立证 — P8 完整 coordinator 级测试（构造稀疏库→跑完整初始化→断言 verifier 拒绝形态）
 5. 稀疏库决策落地 — 按立证结果实施（加法式重建 init 对象或文案化拒绝；重建方案必须过 verifier 不许绕）
 6. props 告警 — P10 告警+计数落地 + 键语法共享测试向量
 7. 测试-恢复矩阵 — 「完整快照恢复后逐域断言终态」测试
 8. 审阅员-编排 — 1–5 与 A/B 槽原子边界、maintenance 屏障的关系逐行审
 9. 审阅员-红线 — coordinator 改动加法式自证（两函数+调用点 grep）
 10. 提交员
第 4 轮（云端韧性）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. GET 预算 — P4 trait 层预算参数 + 三 provider 实现 + 三类回归
 2. verified publish primitive — P5 抽象（序列化-PUT-GET-比较 + 类型预算 + 版本条件 + 恢复策略）
 3. primitive 接线 — marker/manifest/tombstone 三消费点迁移
 4. tombstone 串行化 — 直接命令纳入同设备串行化 + 双调用交错测试
 5. 坏写收敛 — manifest .tmp 恢复点利用 / 坏对象隔离与可审计恢复入口
 6. E2EE CAS — P3 远端租约/条件写设计 + 实现（provider 能力探测，不支持条件写的后端用租约对象方案）
 7. 认领竞态测试 — 两「设备」并发认领/升级的状态机测试
 8. 下载防降级 — P6 落地
 9. 审阅员-协议 — 1–8 与既有 90s 停滞超时/尺寸核验的叠加关系审查
 10. 提交员
第 5 轮（口令/导出打磨 + 迁移兼容）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. prove 降本 — 首块验证 + 次新回退
 2. 错密码前置 — 首块试解 + 便携包口令条目名前置检查
 3. 导出合并 — 双实现合并 + 进度回调 + 取消
 4. KDF/熵 — 平台上限 + 弱口令熵检查（只影响新设口令，存量放行不动）
 5. 迁移复核 — V20260824 去重实现与 fixture 碰撞对补齐
 6. 同步传播契约 — 迁移触发 change_log 的多设备混版本契约测试或标记
 7. 文案收敛 — 后端用户可见错误 code-only 化第一批（云备份域）+ 升级窗口文档
 8. 设计稿双件 — 声明式 repair step + 持久化状态版本迁移框架（设计稿，不实施大重构）
 9. backup-v2 裁决 — delta 族 experimental 隔离或接线排期的书面决策 + 源码锁对齐
 10. 提交员 — 95% 对账，欠账列第 6 轮首位
第 6 轮（全面二检）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。10 名复核员按第 2–5 轮落地面一人一面逐 diff 复核（状态机/auto-sync/恢复编排/稀疏库/GET 预算/publish primitive/E2EE CAS/口令导出/迁移/文案），翻案与补丁当轮落地；提交。
第 7 轮（故障注入与非理想输入测试源码，只写不跑）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。1-2 crypto journal 三点注入矩阵（P9）、3 稀疏库矩阵扩展（FTS/索引/视图缺失组合）、4 坏写后下一轮收敛、5 两设备认领全排列、6 恢复中断续传、7 双写交错、8 「恢复卡住」阈值文案与后端对齐（P1-d 顺车，归因既有）、9 测试台账、10 提交员。测试以源码落地为准；本轮禁止执行，第 8 轮前也不许留给「现在就去跑 CI」。
第 8 轮（本会话首次允许实测窗口）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。本轮起才允许跑编译/门禁/定向测试；环境不行立即停。1-5 cargo test 定向尝试（coordinator 族/zip 往返族/sync_r07/r12 族/crypto_publication/restore 族——环境不行立即停并记录）、6-7 自建 dufs/WebDAV 容器半真联调尝试（可选，起不来就放弃）、8-9 红灯归因（本会话引入当轮修）、10 提交员。
第 9 轮（扫尾）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-3 台账未闭合项、4 错误码/文案终扫、5 注释与决策文档终稿、6 fixture 与 migration-lock 一致性终验、7-8 PR 描述初稿 + 「已验证/未验证」诚实清单（真云/真机/真实旧库全部如实留白）、9 风险清单、10 提交员。
第 10 轮（终检交付）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-4 全 PR diff 四人交叉终审（事务/恢复/协议/迁移）、5 红线自证（coordinator 两加法 grep 证据写进 PR 描述）、6 数据安全承诺矩阵终版（每承诺→代码→测试三列）、7 遗留风险、8 PR 描述定稿、9 台账归档、10 最终 commit+push。
```

### 2.5 会话 E：Anki 制卡 / 闪卡复习(FSRS) / 题库判分

```text
你是 0824 Wave2 会话 E 的父代理，负责「Anki 制卡 / 图像遮挡 / QA-critic / APKG-AnkiConnect / 闪卡复习(FSRS) / 题库判分与掌握度」方向。学习产品差异化核心，Agent 原生结合最深（chatanki_executor/qbank_executor）。

【Wave2 通用铁律——本会话必须整段遵守，不得删改。旧模板第 7 节「立刻 tauri 编译」作废。】

0. 原目标仍生效
把近 2–3 天大量改造 / PR / 枝逐一审阅并加法收口。CI 不当门禁。官方产品统一枝只有 `cursor/0824-cde6`（PR #269 → main）。合主线只用 #269，禁止反向合 main，禁止整支 merge 隔离 / 预演 / leftover / 带重复 G merge 的枝。本会话是 Wave2 五路之一，产物停在本会话独立枝 + draft PR；不整支合回官方 0824，除非用户后下令。

1. 子代理模型（本波覆盖旧「全程 fable:sol 1:1」）
- 第 1–7 轮：全部子代理只用 `claude-fable-5-thinking-high`。禁止 sol / GPT / 任何 GPT 系列，禁止 `claude-fable-5-thinking-xhigh`，禁止 `computerUse`（平台会绑到 Claude 4.5 Sonnet，不是 fable）。每轮约 10 个，全是 fable high。
- 第 8–10 轮：`claude-fable-5-thinking-xhigh` 与 `gpt-5.6-sol-xhigh-fast` 按 1:1（每轮约 5+5）。无 xhigh-fast 时 GPT 半边显式降到 `gpt-5.6-sol-high-fast`，并在轮末记录。fable 半边不要静默降到无关模型。
- 第 1–7 轮若 `claude-fable-5-thinking-high` 调不通：停、报、重试；不要偷偷换成 sol 或 xhigh 凑数。
- 父代理直改白名单：文档 / 注释 / 配置措辞，或不超过 10 行且不涉及业务逻辑 / 权限 / 数据面。产品代码必须派子代理。
- 每轮约 10 个子代理，任务不要切碎，每轮要有巨大且可靠进展。子代理要吃饱：文件清单 + 验收标准 + 禁改区写进任务卡。
- 任何情况下都不允许停止，除非用户明确说停。

2. 仓库 / 枝 / 写手
- 第一件事：`git fetch origin cursor/0824-cde6`，确认 tip。预期 `061b4815`（Step 23 文档）。若远端已前进，以新 tip 为基线并先派一名子代理读增量；禁止 reset，禁止 force-push 官方枝。
- 从 `origin/cursor/0824-cde6` 拉出本会话独立枝（枝名见下方专属节），立即空提交 + `push -u` + 开 draft PR，base = `cursor/0824-cde6`。
- 每轮结束立刻 `git add` / `commit` / `push` 并更新自己的 draft PR。半成品用 `wip:` 前缀。云会话被杀等于永久丢未推送工作。
- 子代理 `gh pr create` 常 403；父代理用平台 PR 工具。不要回帖 Slack / GitHub。不要改人类可能改过的 PR 正文（尤其 #269、#326）。
- 新枝名必须 `cursor/<descriptive>-a875` 或用户指定的 `cursor/<descriptive>-cde6`，全小写。
- 产品修复用独立 worktree（如 `/tmp/0824-wave2-*`），不要占脏工作区乱切官方枝。

3. 【最高优先级】第 8 轮之前禁止跑编译 / 门禁 / CI/CD / 测试
第 1–7 轮只做静态审阅 + 代码优化落地 + 写测试源码（不执行）+ 每轮 commit / push / 更新 draft PR。时间紧，编译和实测是浪费。

第 1–7 轮绝对禁止（出现即失败，立刻停掉该命令，不要补救式重跑）：
- 任何 `npm` / `npm ci` / `npm install` / `npm run` / `npx`（含 typecheck、vitest、vite、version:generate）
- 任何 `cargo` / `rustc` / `rustfmt` 执行态（check、test、build、fmt --check）
- `tsc` / `vite` / `node scripts/check-migrations.mjs` 执行
- 任何 CI/CD：`gh workflow`、推送后盯 checks、为变绿而改 workflow
- `tauri dev` / `tauri build` / 实机 / 浏览器实测 / `computerUse`
- 为跑通环境去装 `node_modules`、Rust 1.98、GTK、WebKit、pdfium、protoc

第 1–7 轮允许：读代码、改产品代码、新增/改测试文件（只写不跑）、grep / 静态推演、web search、commit + push。
「写一条会红的测试」= 把测试源码落盘并在台账写预期；不要执行它来看红绿。

第 8–10 轮才允许跑编译 / 四项硬门禁 / 定向测试。环境装不动、跑不完、被杀掉：立即停，如实记录，绝不空转。四项硬门禁只在第 8 轮及之后才可碰：
1. `npm run version:generate && npm run typecheck`
2. `npx vite build`
3. `cargo check --manifest-path src-tauri/Cargo.toml --lib`（Rust 1.98.0）
4. `node scripts/check-migrations.mjs`
缺 `src/version.ts` 时用 `scripts/generate-version.mjs`，也只许第 8 轮及之后。Tauri 实机是后期打磨，不是本波主战场。

4. 18 项不变量（禁止破坏；第 1–7 轮用 grep / 读文件自证，不要跑测试套件）
1. pipeline hooks：ApprovalGateHook 必须保持 default 链首位 + TaskAuditHook
2. GenerativeUiExecutor 注册在 catch-all 前
3. H cache：prefix freeze + cache_write_tokens 全链在树
4. utf8_stream 有生产调用方
5. model_special_tokens（#200 未回流）
6. 闪卡只读，无 save_to_library 写回流
7. 无生产 ChatV2AnkiAdapter
8. cardAgent.startGeneration 两入口仍在
9. 附件 file 200MB / image 50MB
10. finder host buckets 分桶隔离
11. qbank-tools：daily_target 1..=50 等压缩契约
12. tombstone 复读 fail-closed
13. WebDAV decode_path
14. S3 normalize_endpoint
15. FTP 550/501 白名单
16. HPIAS 18-block + 会话隔离
17. 无 mythos-5 / haiku-5 真目录条目
18. NOTICES 在 legal/ + Composer* 拆分仍在 + G 44px / safe-area / Android back

5. 已完成主题仓，不要从零重来
E/C/H/A/T/B/D/F/G/leftovers-safe 已归并；#177 cherry 映射已落；Step 18–23 已在官方 0824。VFS `coordinator.rs` 必须加法式：保留 `apply_vfs_init_missing_tables`，再叠加 `pre_repair_vfs_v20260824_note_props`。禁止 merge rel-vfs 的 `2bfe7c31`。`origin/main` tip `b2a85a69` 已被 `5f324e1f` 语义超集吸收，禁止整支 merge main。

6. 明确忽略 / 不要整支合
dependabot / release-please / cla-signatures；#113/#123/#134/#155；#170/#198/#200；#203；#101–#103；#214 整支；#213 除已收 parser `e83d4081` + rustfmt `6a903224` 外 DROP；对照/隔离 PR #269 #293 #303–#325 #327 #344；全部 `0824-rehearse-*` / `0824-theme-*` / `0824-verify-*` / `0824-regress-*`。不要回放 Step 18 finder 源 SHA `9176740b` / `0a6344e1`。不要回放 Step 19 源 SHA `3d3516c3` / `c4a3382c` / `ef991061` / `e97b89ff` / `92c487f8` / `2ba5522d`。leftover 结论 A：开放 PR 无未吸收产品增量。MCP 存储分叉 + 空策略全放行是 v0.9.44 既有，不修。issue #122 聊天乱码仍 OPEN，不要记账为已修复。MERGE-PLAN 只追加新 Step，不改写更早 Step。

7. 工作习惯
- 五路文件所有权：A=agent/cache/tool_loop；B=desktop 子应用；C=mobile UI；D=cloud/data/`coordinator.rs`；E=Anki/qbank。越权文件只读，改动记台账给对应路。
- 五枝同 base 平行，不互相 merge，不 cherry-pick 对方枝。
- 归因诚实：v0.9.44 既有债可修但提交信息标 `legacy:`。PR 描述必须带「已验证 / 未验证」两栏；第 1–7 轮「已验证」只能写静态证据，不能写「测试已跑绿」。
- 文档只追加。不要标 Goal complete。
- 禁用 computerUse。行业调研用 web search。

【本会话专属身份】
方向：遮挡导出闭环 + gold 溯源 + CriticSummary 可观测 + 判分/mastery 统一原语 + daily 口径统一。
独立枝：`cursor/0824-wave2-anki-qbank-a875`
draft PR 标题：0824 Wave2-E: Anki 制卡/闪卡复习/题库判分深化（遮挡导出闭环/gold 溯源/CriticSummary 可观测/verdict 统一原语）
文件所有权：streaming_anki / critic / gold / occlusion / APKG / FSRS / question_bank / mastery / qbank_grading / anki-tasks / chatanki_executor / qbank_executor。coordinator.rs 归 D；tool_loop/缓存归 A；移动 chrome 归 C；workbench 壳归 B。

【基线与分支（第一件事）】
1. git fetch origin cursor/0824-cde6，确认 tip（预期 061b4815；若前进以新 tip 为准并先读增量）。
2. git checkout -b cursor/0824-wave2-anki-qbank-a875 origin/cursor/0824-cde6
3. 空提交 + push -u origin + 开 draft PR，base = cursor/0824-cde6，标题：
   「0824 Wave2-E: Anki 制卡/闪卡复习/题库判分深化（遮挡导出闭环/gold 溯源/CriticSummary 可观测/verdict 统一原语）」

【本会话组织（叠在通用铁律之上）】
- 10 轮 × 每轮 10 子代理。第 1–7 轮全 `claude-fable-5-thinking-high`；第 8–10 轮 fable xhigh ∶ GPT = 1:1。同文件同轮单人。
- 第 1–5 轮完成 95% 审+改；第 6–7 轮静态二检 + 写组合测试源码（不跑）；第 8–10 轮才允许 cargo test/vitest。SOTA 调研用 web search。

【必读输入】
- docs/0824-quality-review/anki.md（FAIL：遮挡导出断链 P0、gold 污染 P0、字段泄漏 P1、CriticSummary P1、i18n/nullable P2、options P3）
- docs/0824-quality-review/anki-tasks.md（两条合入阻断已修于 Step 22，GenerationStats/混合态/Promise.all 三条仍开放）
- docs/0824-quality-review/anki-connect-apkg.md、flashcards-fsrs.md
- docs/0824-quality-review/question-bank.md（WARN：全局槽已修于 Step 22 #332，daily 口径/target 历史/mastery/verdict 原语仍开放）
- docs/0824-quality-review/cross-cutting.md 第一节（Chat×Anki）
- docs/0824-MERGE-PLAN.md Step 22（本域 10 个 pick：1a5b6f6a/d9a314cb/7077075a/307449e2/4756e93c/d8a606c2/08beff7e/3fcebbb1 等，含 streaming_anki_service.rs 一处手工解冲突——全部零测试验证，二检权在本会话）

【红线】
- GenUI flashcard-preview 只读边界不许破（不加保存/编辑回流）；持久制卡唯一走 anki_cards 管线。
- enableQaPass/FSRS opt-in/协议中立/maxCards 全局配额是 Step 22 刚修的语义，只许加固不许回退；本会话第 1 轮必须先对这 10 个 pick 逐一实证复核（含手工冲突点 streaming_anki_service.rs 测试区两侧测试是否都在且语义完好）。
- streaming_anki_service.rs:45 的 token 常量表：若 A 会话已做单源化引用，rebase 后沿用；算法语义（丢残片/剥包装）归本会话，A 不会动。
- 「恢复卡住 1h vs 10min」「保存到卡库死 key」是 v0.9.44 既有债：可修但归因诚实，不算 0824 回归。
- 不碰：coordinator.rs（D）、tool_loop/hooks/缓存链（A）、移动 chrome 类名（C）、workbench/learning-hub 壳（B）。ExamContentView.tsx 的判分调用点归本会话（壳层布局归 B）；TauriAdapter.ts 只许动 handleAnkiGenerationEvent 段（:1441-1858 一带），缓存段归 A。
- lossless-only JSON 修复语义（Step 22）不许放宽：字符串中途截断必须错误卡或可见标记。

【已知痛点路径】
P0-1 图像遮挡导出闭环：src-tauri/src/anki_image_occlusion.rs:416-716（build_card_fields 产出 Cloze text/_occlusion/tag）但 streaming_anki_service.rs:1929-2002 入库不写 fields.text 不放 images；apkg_exporter_service.rs 与 AnkiConnect 路径不认识 _occlusion；Step 22 #335 只改了导出文案。产品契约二选一并落地：真闭环（消费 OcclusionCardFields.text + 解析打包 imageRef 媒体 + 导出可复习 Cloze/IO note + APKG/AnkiConnect 端到端测试）或明确降级命名「遮挡草稿预览」全链文案对齐。优先真闭环（对标 SOTA 的核心能力）。
P0-2 critic gold 溯源：anki_critic.rs:731-783（收集器）、anki_gold_set.rs:357-458（EditedMinor/Major 无编辑者概念）——先复核 Step 22 d8a606c2「gold 溯源加固」是否已排除 llm_critic_revised；不足则落地 actor/provenance：内容修改记录保存来源，只有可证明用户编辑进 gold mining。
P1-1 内部字段泄漏 APKG：apkg_exporter_service.rs:39-62,1292-1322,1609-1624 的过滤名单只有 13 个 Anki* 字段——统一导出规范化层过滤 `_` 前缀内部字段（_qa_flags/_occlusion/_original_generation）；确需导出的由专用转换器消费后移除。
P1-2 CriticSummary 可观测：streaming_anki_service.rs:2949-2974 事件漏 gold_references/routed 字段；前端 AnkiCardsBlockData（ankiCardsBlock.tsx:125-188）无 summary 字段、TauriAdapter.handleAnkiGenerationEvent 不消费、locale 词条无消费者——补齐事件序列化 + block 数据模型 + UI 呈现（降级/预算跳过/写回失败可见）。
P1-3 任务台质量终态：GenerationStats（failed_cards/dropped_fragments/duplicate_cards）落盘进任务汇总 + 「带警告完成」态；failed+running 混合态修 classify 互斥分类（src/features/anki-tasks/types.ts:40-43、AnkiTasksApp.tsx:215-234）；list 与 stats 拆开 Promise.all 独立降级 + stats-only failure 测试。
P1-4 qbank verdict 统一原语：抽 apply_submission_verdict_in_tx（question_bank_service.rs:661-809 已有主链），qbank_grading/pipeline.rs:220-268 的旧计数逻辑与人工改判复用同一原语；mastery correction（mastery/service.rs:121-337 的 ON CONFLICT DO NOTHING 证据停旧 verdict）——append-only 则写纠正事件/tombstone 重算；answer_submissions 改判推进 RowSync updated_at/local_version + 跨设备回放测试。
P1-5 daily 口径统一：后端「当天任一次答对+按题去重」vs 前端「首答锁定」（questionBankStore.ts:1822-1863）vs「再练一组」回补重计——提交/改判后由后端返回权威 daily 聚合（或按题 verdict map）回写；handleMarkCorrect 补 recordPracticeAnswer 对应调用（ExamContentView.tsx:963-1004）；重答 streak/totalCorrect 语义定名（正确尝试数 vs 答对题数）。
P2-1 daily_target 历史语义：DailyPracticeMode.tsx:64-90 localStorage 单值重算整月——产品裁决：历史事实（按 exam_id+date 持久化同步，calendar 逐日返回所用 target）或明确命名「按当前目标查看」。
P2-2 QA/遮挡 i18n+a11y：anki_qa_lint.rs 中文 message → 前端按稳定 code 本地化（数字作参数）；ImageOcclusionOverlay.tsx:118-130 硬编码中文 aria-label；ankiCardsBlock.tsx:519-558 alt=""；agent.occlusion.* 词条接到组件；测试改按语义查询。
P2-3 nullable JSON 读侧：database/mod.rs:4865-5074,7463-7505 与 fsrs_review_service.rs:1903-1920 直取 String——统一 Option 防御（anki_cards 是 RowSync 表，迁移后仍可能进 NULL）。
P3 options 双解析：anki_protocol.rs:88-116 过期注释 + StructuredOutputOptions 局部 serde 与 models.rs:1328-1352 已迁回的字段重复——统一从 AnkiGenerationOptions 读取，wire 解析单点化，删过期理由。
P4 SOTA 对标：Anki 桌面（note type 体系/模板/FSRS 参数暴露）、AnkiHub/SuperMemo（增量阅读）、Quizlet/RemNote（AI 制卡交互）——差距清单 + 可静态落地子集（如复习界面按键流、FSRS 参数可视化、卡片模板能力）+ Agent 原生结合深化（chatanki/qbank 工具面的 bounded output 契约回补：qbank-tools.ts:569-612 的 old/new_value 形状与截断标记精确化）。

【10 轮 × 10 子代理】
第 1 轮（Step22 二检 + 锚定 + 调研）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 二检员-QA/CardAgent — 1a5b6f6a/d9a314cb/7077075a/307449e2/4756e93c 五 pick 在 tip 逐一实证（含手工冲突点两侧测试完好性）
 2. 二检员-APKG/金标/qbank — d8a606c2/08beff7e/3fcebbb1 三 pick 实证 + gold 溯源加固是否覆盖 llm_critic_revised 的裁决（P0-2 前置）
 3. 锚定员-streaming — streaming_anki_service.rs 全量读（入库/QA/critic/stats 事件链现状）
 4. 锚定员-critic/gold — anki_critic.rs + anki_gold_set.rs + _original_generation 链
 5. 锚定员-导出 — apkg_exporter_service.rs + AnkiConnect 路径 + src/features/chat/anki/index.tsx 透传层
 6. 锚定员-qbank后端 — question_bank_service.rs + qbank_grading/pipeline.rs + mastery/service.rs 判分三路现状
 7. 锚定员-qbank前端 — questionBankStore.ts + useQuestionBankSession.ts + ExamContentView 判分调用点 + DailyPracticeMode
 8. 调研员-SOTA — Anki/SuperMemo/Quizlet/RemNote 对标（P4），产出差距清单
 9. 锚定员-任务台与块 — AnkiTasksApp/types + ankiCardsBlock + TauriAdapter anki 段 + AnkiQaFlagBadge
 10. 台账员 — docs/dev/wave2-E-ledger.md（P0–P4 归组 + Step22 二检结论）+ 提交
第 2 轮（两条 P0——本会话最重落地）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 遮挡契约裁决 — P0-1 二选一定稿（默认真闭环；若判降级须书面论证并全链文案对齐）
 2. 遮挡入库 — streaming_anki_service 消费 OcclusionCardFields.text + images 放入 AnkiCard
 3. 遮挡 APKG — apkg_exporter 解析 _occlusion、打包 imageRef 媒体、产出可复习 Cloze/IO note
 4. 遮挡 AnkiConnect — AnkiConnect 路径的遮挡 note 转换
 5. 遮挡测试 — 生成→入库→APKG/AnkiConnect 端到端测试（fixture 级）
 6. gold 溯源 — P0-2 落地：actor/provenance 字段 + 收集器排除非用户编辑 + 回归测试
 7. gold 测试 — critic 修订卡不得进 grounded reference 的反例测试
 8. 审阅员-协议 — 2–4 与 anki_protocol/lossless-only 语义不冲突复核
 9. 审阅员-兼容 — 旧卡（无 _occlusion/无 provenance）读写兼容复核
 10. 提交员 — diff 组装 + 红线自检 + commit+push
第 3 轮（可观测与任务台）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. 字段泄漏 — P1-1 统一导出规范化层 `_` 前缀过滤 + 测试
 2. CriticSummary 后端 — 事件补全 gold_references/routed 序列化
 3. CriticSummary 前端-1 — block 数据模型 + TauriAdapter 消费
 4. CriticSummary 前端-2 — UI 呈现（降级/预算跳过/写回失败）+ locale 词条接线
 5. Stats 落盘 — GenerationStats 持久化进任务汇总 + 「带警告完成」态
 6. 混合态 — failed+running 分类修正 + 行内操作入口保留
 7. 独立降级 — list/stats 拆分 + stats-only failure 测试
 8. 审阅员-事件链 — 2–7 事件序列与既有 NewCard/进度/终态分支的兼容
 9. 审阅员-UI — 呈现层与 QA badge 既有语义一致性
 10. 提交员
第 4 轮（qbank 判分统一）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. verdict 原语 — apply_submission_verdict_in_tx 抽取（自动判分/AI 判分/人工改判三路复用）
 2. grading pipeline 迁移 — qbank_grading/pipeline.rs 接原语（false→true/true→false 计数正确）
 3. mastery correction — 纠正事件/tombstone 重算方案落地
 4. RowSync 推进 — 改判推进 updated_at/local_version + 跨设备回放测试
 5. daily 权威回写 — 后端返回 daily 聚合/verdict map，前端提交与改判后回写
 6. handleMarkCorrect — ExamContentView 改判回写调用补齐（与 B 的壳层改动通报避让）
 7. streak 语义 — 重答语义定名 + 完成卡文案对齐
 8. target 裁决 — P2-1 二选一落地（历史持久化或改名「按当前目标查看」）
 9. 审阅员-事务 — 1–4 的事务边界与统计一致性逐行审
 10. 提交员
第 5 轮（i18n/读侧/契约 + SOTA 第一批）：
 【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。
 1. QA i18n — code 本地化 + Rust message 降为诊断
 2. 遮挡 a11y — ImageOcclusionOverlay aria + alt + 词条接线 + 测试改语义查询
 3. nullable 读侧 — P2-3 统一 Option 防御（高频读取路径逐个）
 4. options 单点化 — P3 双解析清理
 5. 工具契约回补 — qbank-tools bounded output 形状精确化（不恢复大段重复说明）
 6. SOTA-复习 — flashcards-fsrs 评审残项 + 复习交互子集（按键流/undo/用时）
 7. SOTA-FSRS — FSRS 参数可视化/画像展示子集（隐私 opt-in 语义不动）
 8. SOTA-制卡 — 制卡交互子集（对标 Quizlet/RemNote 的可静态落地项）
 9. 台账对账员 — 95% 完成度对账，欠账列第 6 轮首位
 10. 提交员
第 6 轮（全面二检）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。10 名复核员按第 2–5 轮落地面一人一面逐 diff 复核（遮挡闭环×2/gold/字段泄漏/CriticSummary/任务台/verdict 原语/daily/i18n-读侧/SOTA），翻案与补丁当轮落地；提交。
第 7 轮（组合测试源码补强，只写不跑）：【模型】本轮全部子代理：`claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止跑编译/门禁/CI/测试。1 遮挡端到端矩阵（生成/入库/导出/导入回读）、2 gold 排除反例、3 「字段规则+确定性 lint+critic relint」×enableQaPass 组合、4 verdict 三路等价、5 daily 重答/改判/再练一组三场景、6 mastery 纠正重算、7 混合态与降级、8 nullable 注入、9 测试台账、10 提交员。
第 8 轮（本会话首次允许实测窗口）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。本轮起才允许跑编译/门禁/定向测试；环境不行立即停。1-5 cargo test 定向（streaming_anki/critic/gold/apkg/question_bank 五族，环境不行即停）+ vitest 定向（anki-tasks/ankiCardsBlock/question-bank 族）、6-8 红灯归因（本会话引入当轮修；Step 22 引入的记台账并修复）、9 台账更新、10 提交员。
第 9 轮（扫尾）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-3 台账未闭合项、4 既有债顺车修（恢复卡住文案/save 死 key，归因标注「既有」）、5 注释与协议文档终稿（_字段清单/导出契约矩阵）、6 locale 双语终验、7-8 PR 描述初稿 + 「已验证/未验证」清单（真实 Anki 导入/私人卡库如实留白）、9 风险清单、10 提交员。
第 10 轮（终检交付）：【模型】本轮 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。允许实测；环境不行立即停。1-4 全 PR diff 四人交叉终审（协议/判分/前端/导出）、5 红线自证（只读预览无写回流 grep、lossless-only 未放宽、Step22 语义未回退）、6 SOTA 差距终版、7 遗留风险、8 PR 描述定稿、9 台账归档、10 最终 commit+push。
```

---

## 三、跨会话文件所有权（防五枝互踩；PR 均 base `cursor/0824-cde6`，各枝独立，合入顺序与冲突处理由后续人工/收口会话统一裁决）

### 3.1 用户钦定的四条硬所有权

| 文件/域 | 所有者 | 说明 |
|---|---|---|
| `src-tauri/src/data_governance/migration/coordinator.rs`（及 `migration/` 全目录、111 迁移、migration-lock） | **D** | 其余四会话一律不碰；D 每轮收轮 grep 自证两加法函数（`apply_vfs_init_missing_tables`、`pre_repair_vfs_v20260824_note_props`）未回退 |
| `src-tauri/src/chat_v2/pipeline/tool_loop.rs` + hooks.rs + helpers.rs + multi_variant.rs + prompt-cache 全链（prompt_builder/context/repo 的缓存段、model2_pipeline、providers/**、adapters/**、utils/model_special_tokens.rs） | **A** | E 只保留 `streaming_anki_service.rs` 内部 token 处理算法；常量表单源化由 A 做引用改造 |
| Composer 移动热区（InputBarUI 移动分支、ComposerInlinePanel、AttachmentPanelBody、ComposerPlusMenu、AttachmentPreviewChips、44px/coarse 类名、AppMenu、mobileShell/useKeyboardHeight） | **C** | 含 `src/features/chat/core/store/sessionActions.ts` 的附件 remove/clear 段 |
| Composer 桌面行为（ComposerPanelOverlay、桌面 overlay 语义、sendAvailability 桌面分支） | **B** | B 改桌面分支时不触碰 C 拥有的移动类名与内联面板 |

### 3.2 其余高频交叉文件的裁决

| 文件 | 归属与切分 |
|---|---|
| `src/features/chat/adapters/TauriAdapter.ts` | 按段：availableSkillsSnapshot/缓存/流式段（≈:5288-5340 及 completeStream 一带）归 **A**；`handleAnkiGenerationEvent` 段（≈:1441-1858）归 **E**；两会话改前先 fetch 对方枝确认无同段在途改动，冲突以先 push 者为准、后者 rebase |
| `src/App.tsx` | Workbench 激活/断点切壳段归 **B**；auto-sync 启动挂载点归 **D**；移动壳挂载（键盘追踪等）归 **C**——三者改的是不同 effect 块，各自提交注明段落 |
| `src-tauri/src/streaming_anki_service.rs` | 归 **E**（含 Step 22 手工冲突测试区二检）；A 只做常量表 `pub(crate)` 引用一行级改动并在提交信息注明 |
| `src-tauri/src/dstu/handlers.rs` | 笔记创建/书签/进度段归 **B**；其余段本轮无人认领不动 |
| `src/features/learning-hub/apps/views/ExamContentView.tsx` | 壳层/宿主/阅读接线归 **B**；判分调用点（recordPracticeAnswer/handleMarkCorrect）归 **E**；同文件改动 B/E 在各自 PR 描述互相点名 |
| `src/features/settings/components/**` | CloudStorageSection/SyncSettingsSection/SyncTab 归 **D**；WorkbenchSettingsSection 归 **B**；设置页移动 chrome 归 **C** |
| `src/stores/questionBankStore.ts`、`src/hooks/useQuestionBankSession.ts`、qbank/anki 全部 Rust 服务与 `src/components/anki/**`、`src/features/anki-tasks/**`、chatanki_executor/qbank_executor | **E** |
| `src/features/workbench/**`、`src/features/learning-hub/**`（除 E 的判分点）、`src/features/notes/**`、`src/features/pdf/**`、`src/shared/notes|selection/**`、翻译/作文/待办/Finder | **B**（其移动 chrome 违规项由 C 修，C 只动 chrome 不动业务逻辑） |
| `src/stores/syncStatusStore.ts`、`src/utils/cloudStorageApi.ts`、`src-tauri/src/cloud_storage/**`、`src-tauri/src/data_governance/**`、`src-tauri/src/crypto*/**`、`secure_store.rs`、`cloud_config_commands.rs` | **D** |
| `src/locales/**` | 各会话只增改本域 namespace 键，不删他域键；`common:` 命名空间新增键须在提交信息注明 |
| `eslint-rules/**` | **C**（44px lint）；其他会话新增 lint 需求提给 C |
| `scripts/cache-hit-report.py` 归 **A**；`scripts/check-i18n.mjs` 归 **C**；`docs/dev/wave2-<X>-*.md` 各归各会话 |

### 3.3 通用协作纪律（写进五份 prompt 的执行语境）

1. 五枝同 base 平行，不互相 merge；发现依赖对方改动时，在台账记「待收口会话统一 rebase」而不是自行 cherry-pick 对方枝。
2. 每会话每轮收轮 push 前跑一次禁改区 grep 自检（各 prompt 红线节已列）。
3. 归因诚实：v0.9.44 既有债可修但必须在提交信息标 `legacy:` 前缀；MCP 存储分叉与 issue #122 不修（A 只做 #122 定位探针）。
4. 全部五会话禁 computer-use、禁真机宣称、禁把「测试文件存在」写成「行为已验证」——PR 描述必须带「已验证/未验证」两栏。第 1–7 轮「已验证」只能是静态证据。
5. 第 1–7 轮子代理模型锁定 `claude-fable-5-thinking-high`；第 8 轮起才切 fable xhigh ∶ GPT 1:1，也才允许跑编译/门禁/CI/测试。

---

## 四、速查（供调度）

| 向 | 标题 | 分支 |
|---|---|---|
| A | Agent 架构 + pipeline + LLM 缓存命中 | `cursor/0824-wave2-agent-cache-a875` |
| B | 学习桌面 + 全部学习子应用 SOTA 化 | `cursor/0824-wave2-desktop-subapps-a875` |
| C | 移动端 UI/UX 与使用体验 | `cursor/0824-wave2-mobile-uiux-a875` |
| D | 云存储/同步/备份 + 迁移 + 历史库兼容 | `cursor/0824-wave2-cloud-data-a875` |
| E | Anki 制卡 / 闪卡复习(FSRS) / 题库判分 | `cursor/0824-wave2-anki-qbank-a875` |

基线：`origin/cursor/0824-cde6 @ 061b4815`（本轮 fetch 复核一致）。PR base 均为 `cursor/0824-cde6`，全部 draft、每轮必 commit+push。

**调度口令**：第 1–7 轮 = 全 fable high + 零编译/零门禁/零 CI/零测试执行。第 8–10 轮 = fable xhigh∶GPT 1:1 + 允许实测（环境杀了就停）。
