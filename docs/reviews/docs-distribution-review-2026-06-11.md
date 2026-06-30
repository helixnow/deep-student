# 应用文档分布审阅记录

- **日期**: 2026-06-11
- **审阅人**: AI Agent（Fable 5）+ 用户实时反馈
- **范围**: 全仓库文档分布（排除 `node_modules/`、`dist/`、`target/`、`src-tauri/vendor/`、`.git/`、`.pr-review/` worktree 副本）
- **方法**: `rg --files --no-ignore` 全量扫描 + git 跟踪状态比对 + 逐文件抽查
- **状态**: 🟢 八轮审阅 + 五轮修复完成，剩 1 项待用户决策（.roundtable 公开性），详见第五节总结

---

## 一、文档全景分布统计

| 位置 | 数量 | git 状态 | 内容类型 |
|---|---|---|---|
| 根目录 `/` | 10 | 6 跟踪 + 4 忽略 | README×2、CHANGELOG、审计/评审报告×4、PLAN |
| `docs/`（根层） | 19 | 12 跟踪 + 7 忽略 | 构建、风格、审计、调试、计划、发布说明混杂 |
| `docs/design/` | 23 | 全部忽略 | 设计文档、code-review-prompts×18、notes |
| `docs/plans/` | 8 | 全部忽略 | 2026-02 的功能计划（chatanki 等） |
| `docs/review/`（单数） | 48 | 全部忽略 | 2026-02 大规模代码评审产物（results/×45） |
| `docs/reviews/`（复数） | 4 | 2 跟踪 + 2 未跟踪 | 2026-06 新评审记录 |
| `dstu-test/docs/` | 8 | 跟踪 | 2026-05 测试运行记录（run logs） |
| `dstu-test/skills/` | 4 | 跟踪 | E2E 测试技能（SKILL.md） |
| `src/` 内嵌 | 6 | 跟踪 | 组件级 README/指南（含 1178 行的 BLOCK_RENDERING_GUIDE） |
| `src-tauri/migrations/` | 1 | 跟踪 | 迁移规范 README ✅ 与实际目录一致 |
| `.github/` | 7 | 跟踪 | CLA、CoC、CONTRIBUTING、SECURITY、模板 ✅ 齐全 |
| `.cursor/` | 2 | 跟踪 | rules/drag-drop、skills/critical-review-workflow |
| `.roundtable/` | 1 | 跟踪 | 多代理圆桌协议 GUIDE.md |
| 其他（scripts/dev、public/icons、tests/visual） | 3 | 跟踪 | 局部 README |

**总计约 144 个 Markdown 文件**（不含 vendor 第三方自带文档与 `.pr-review/` 重复副本）。

**关键背景**: 用户指南已于 2026-02-21（提交 `a211374a0`）从 `docs/user-guide/` 删除，迁移至在线文档 https://deepstudent.cn/docs/ ，README 第 476 行有链接。

---

## 二、发现的问题

### P1-1 `docs/review/`（单数）与 `docs/reviews/`（复数）并存，语义重叠、策略相反

- `docs/review/`：48 个文件，被 `.gitignore:221` 整目录忽略（内部文档）
- `docs/reviews/`：被跟踪进 OSS 仓库（`vfs-learning-hub-chatv2-*` 2 个已提交）
- 后果：新评审文档放哪、是否公开，完全取决于写文档的人/Agent 当时选了哪个目录。今日刚生成的 `fable-sota-review-2026-06-11.md`、`github-issues-review-2026-06-11.md` 落在 `reviews/`（未跟踪状态），一旦 `git add -A` 就会被公开，而内容性质与被忽略的 `review/` 完全相同。
- 建议：二选一合并；若需"内部/公开"分流，应该用目录语义区分（如 `docs/internal/`），而非靠单复数。

### P1-2 根目录审计/评审报告的公开策略自相矛盾

| 文件 | git 状态 | 矛盾点 |
|---|---|---|
| `CRITICAL_CODE_REVIEW_REPORT.md` | 忽略（gitignore 注释"Internal docs (not for OSS repo)"） | — |
| `AUDIT_REPORT_v0.9.35.md` | **跟踪、公开** | 同为审计报告，一个忽略一个公开 |
| `ACCESSIBILITY-REVIEW.md` | **跟踪、公开** | 同上 |
| `PR-REVIEW-2026-06-11.md` | **跟踪、公开** | PR 评审记录提交进主分支根目录 |

- 后果：OSS 仓库根目录暴露内部评审过程文件，且根目录文件数膨胀（对开源项目第一印象不利）。
- 建议：统一归入 `docs/reviews/`（公开）或忽略目录（内部），根目录只留 README×2、CHANGELOG、LICENSE。

### P1-3 `.gitignore` 靠 30+ 行逐文件枚举 + 文件名通配符管理内部文档，跨平台行为不一致

- `.gitignore:210-232` 用 `/docs/*report*.md`、`/docs/*audit*.md`、`/docs/*review*.md`、`/docs/*debug*.md` 等小写通配符。
- `docs/DATA-MAPPING-REPORT.md`（大写 REPORT）在 macOS（大小写不敏感）下被 `*report*` 匹配而忽略；在 Linux（大小写敏感，如 CI）下**不会被忽略**——同一仓库在不同系统上公开边界不同。
- 每新增一篇内部文档就要改 `.gitignore`，遗漏即泄漏（fable-sota-review 就是现行漏网案例）。
- 建议：收敛为 1-2 条目录级规则（如 `/docs/internal/`），停止文件名模式匹配。

### P1-4 `docs/` 根层 19 个文件无分类、命名风格混乱

- 同层混杂：构建（BUILD-CONFIG、README-BUILD）、规范（CODE_STYLE）、审计（SECURITY_AUDIT_REPORT_202602、DATA-MAPPING-REPORT）、调试日志（chatanki-debug）、评审（chat-v2-critical-review、chatanki-multi-template-audit、llm-adapter-audit-fixes）、发布说明（DEEPSEEK-V4-V32-RELEASE-NOTES）、目标计划（FABLE_SOTA_GOAL、cloud-sync-remediation-plan）、设计规范（design-tokens-and-color-semantics）。
- 命名风格四种并存：SCREAMING_SNAKE、SCREAMING-KEBAB、kebab-case、中文文件名（`翻译键缺失详细报告.md`）。
- `docs/` 没有索引 README；全仓库只有 `docs/BUILD-CONFIG.md` 一个文件被 README 引用，其余文档无发现入口。

### P2-1 历史一次性产物未归档，"活文档"与"尸体文档"混在一起

- `docs/review/results/` 45 个文件全部是 2026-02 一轮大评审的产物，已完结。
- `docs/plans/` 8 个文件全部是 2026-02 的计划，多数已落地（如 chatanki、desktop-auto-updater）。
- 旧文档审计报告 `docs/review/documentation-audit-report-2026-02-10.md` 审的对象 `docs/user-guide/` 在 11 天后（02-21）即被整目录删除——该报告结论已失效，但文件仍在原位无任何标注。
- 根目录 4 个报告（2026-02 ~ 2026-05）同属已完结产物。
- 建议：建立 `docs/archive/`（或按年月归档），完结即移动；活动文档（FABLE_SOTA_GOAL、cloud-sync-remediation-plan 等）才留在显眼位置。

### P2-2 `dstu-test/docs/` 的测试运行记录被提交进仓库

- 8 个文件全是 2026-05-29 ~ 05-31 的 agent 运行报告（run log），属于运行产物而非可维护文档，且已被 git 跟踪公开。
- `dstu-test/skills/` 与 `~/.codex/skills/` 全局技能存在内容重复（deep-student-cloud-sync-e2e、deep-student-tauri-lab 同名），需确认单一来源。

### P2-3 CHANGELOG 落后于实际开发

- `package.json` / `tauri.conf.json` 版本 0.9.38，CHANGELOG 顶部条目 0.9.38（2026-05-24）——版本号一致 ✅。
- 但 05-24 之后约 3 周的改动（云同步整治、VFS 评审修复等大量提交）无任何 Unreleased 段记录。release-please 配置存在（`release-please-config.json`），属流程正常但人工感知滞后，暂记观察项。

### P2-4 待抽查项（下一轮）

- [ ] `src/features/chat/BLOCK_RENDERING_GUIDE.md`（1178 行，05-17 更新）与当前 Block 实现的一致性
- [ ] `docs/CODE_STYLE.md`（03-07 更新）与 eslint.config.js / 实际代码风格的一致性
- [ ] `docs/BUILD-CONFIG.md` 与 tauri.conf.json / vite.config.ts 的一致性
- [ ] `src/components/ui/unified-sidebar/USAGE_EXAMPLES.md`、`CommonTooltip.README.md` 是否随组件演进过期
- [ ] `docs/design/` 内部设计文档与现行架构的偏差
- [ ] README.md 与 README_CN.md 内容是否同步（行数同为 557，待内容比对）
- [ ] 全仓库文档死链扫描

---

## 二点五、第二轮：内容一致性与死链抽查（17:20）

### P1-5 `.github/CONTRIBUTING.md` 要求贡献者阅读一个被 gitignore 的文件

```
.github/CONTRIBUTING.md:39  "请务必阅读 `AGENTS.md`（原文为指向 ../AGENTS.md 的链接），其中包含重要的开发规范"
.gitignore:280              AGENTS.md   ← 该文件被忽略，公开仓库中不存在
```

- 对外部贡献者这是必读文档的死链；克隆仓库后按 CONTRIBUTING 指引会直接撞墙。
- 处理方向：要么把 AGENTS.md 提交（脱敏后），要么把其中"开发规范"部分提炼进 CONTRIBUTING/docs。

### P1-6 公开跟踪的文档暴露开发者本机绝对路径（且全为死链）

- `docs/design-tokens-and-color-semantics.md`（已跟踪、公开）：14 处引用 `/Users/ba7mlv/Documents/Coding/deep-student/.worktrees/study-ui-migration/...`——暴露另一位开发者用户名及本机目录结构，仓库内无法解析。
- `docs/cloud-sync-compatibility-analysis-2026-05-23.md`（已跟踪、公开）：6 处引用 `/Volumes/cipan/deep-student/cipan/example/cherry-studio|siyuan|obsidian-livesync/...` 本机参考项目路径。
- 建议：公开文档一律使用仓库相对路径；引用外部项目源码时改用 GitHub 永久链接。

### P1-7 `src/features/chat/README.md` 的文档索引 100% 死链

- 该 README 列出的 9 个链接（`./docs/01-可复用清单.md` ~ `05-多会话管理.md`、`./docs/architecture/` 4 张架构图）指向的 `src/features/chat/docs/` 目录**不存在**。
- 该 README 本身已跟踪公开，对读者而言整个"文档导航"区块是摆设。

### P2-5 `docs/README-BUILD.md` 引用 3 个从未存在过的构建指南

- `./docs/BUILD-ALL-PLATFORMS.md`、`./docs/ios-build-guide.md`、`./docs/android-build-guide.md`：git 全历史无记录（从未提交），属"先写链接后补文档"未兑现。
- 另外该文件位于 `docs/` 内部却用 `./docs/...` 前缀（按仓库根书写），即使文件存在也解析不到——双重失效。

### P2-6 `src-tauri/migrations/README.md` 引用被忽略/不存在的中文文档

- `../../docs/数据治理系统重构方案.md` 不存在于工作区与 git 历史。

### P2-7 `BLOCK_RENDERING_GUIDE.md`（1178 行）的 BlockType 清单落后实际代码 9 个类型

| 对比项 | 文档（标注"适用版本 2026-02-09"） | 实际 `src/features/chat/core/types/common.ts` |
|---|---|---|
| 块类型数 | 13 个 | 22 个 |
| 文档缺失 | — | `academic_search`、`todo_list`、`ask_user`、`template_preview`、`subagent_embed`、`sleep`、`graph`、`paper_save`、`generic` |

- 指南整体结构（三注册表、相对路径引用）仍有效，但类型清单、目录编号≥4 个月未随代码更新；新人按文档枚举块类型会漏掉近一半。

### 第二轮验证通过项 ✅

- `docs/CODE_STYLE.md`：引用的 `src/utils/cn.ts`、`src/lib/utils.ts`、`src/config/mobileLayout.ts`、`MobileSlidingLayout.tsx`、`getErrorMessage` 全部存在且路径正确。
- `docs/BUILD-CONFIG.md` 与 `docs/README-BUILD.md` 引用的 4 个构建脚本（build_ios/android/mac/windows.sh）全部存在。
- README.md 与 README_CN.md：标题数（31）、特性编号（13）完全对齐，双语同步良好。
- `src-tauri/migrations/README.md` 描述的 4 个迁移目录（vfs/chat_v2/mistakes/llm_usage）与实际一致。
- CHANGELOG 顶部版本 0.9.38 与 `package.json`/`tauri.conf.json` 一致。

---

## 二点六、第三轮：架构重构后的文档跟随性（17:25）

### P1-8（系统性根因）2026-05-13 的 `src/features/` 目录重构未同步任何文档，≥14 个文档引用失效旧路径

重构提交：

- `53a40c13c` refactor(chat): migrate `src/features/chat/` → `src/features/chat/`
- `419aa6af8` refactor(learning-hub): migrate → `src/features/learning-hub/`（2026-05-13）

受影响文档（仍引用旧路径，一处未改）：

| 文档 | 引用旧路径 | 公开性 |
|---|---|---|
| `docs/design/learning-hub-core-contracts.md` | `src/features/learning-hub/learningHubContracts.ts` 等（实际已在 `src/features/learning-hub/`），全文 0 处新路径 | 内部 |
| `ACCESSIBILITY-REVIEW.md` | src/features/chat + src/features/learning-hub | **公开** |
| `docs/chat-v2-critical-review.md`、`docs/chatanki-debug.md`、`docs/chatanki-multi-template-audit.md`、`docs/DATA-MAPPING-REPORT.md` | src/features/chat | 内部（忽略） |
| `PLAN.md`、`CRITICAL_CODE_REVIEW_REPORT.md`、`LEARNING_RESOURCE_CRITICAL_REVIEW_FIXES.md` | 两者 | 内部（忽略） |
| `docs/design/`（code-review-zones、skill-system-audit-report、移动端侧栏UI优化、FE-01/FE-02 prompts） | 两者 | 内部 |

- **最严重**：`learning-hub-core-contracts.md` 自我定位是"核心约束"（SSOT 活文档，03-06 还在更新），但其引用的契约文件路径全部失效——靠它防架构退化的人会先被它误导。
- P2-7 的 BlockType 落后同属此根因：重构/演进后文档无人回写。
- 建议：把"目录迁移必须 `rg` 全仓文档改路径"写进重构 checklist；为活文档（contracts/guide 类）建立"代码评审时文档同步检查"机制。

### 第三轮其他核实

- ✅ `CommonTooltip.README.md`：组件被 49 个文件使用，文档对应组件真实存在（`CommonTooltip.tsx`/`.css`/`.example.tsx` 齐全），属于高价值就地文档。
- ✅ `USAGE_EXAMPLES.md`（unified-sidebar）：组件存在，导入路径 `@/components/ui/unified-sidebar` 有效；但实际使用方仅 2 处（LearningHubSidebarV2、SkillsSidebar），302 行示例的维护成本与使用面不成比例，观察即可。
- ⚠️ `dstu-test/skills/` 与 `~/.codex/skills/` 的两份 SKILL.md（tauri-lab、cloud-sync-e2e）当前内容 **完全一致**（diff 通过）——是手工同步的双副本，无声明哪边是源头；一旦一边改动即分叉。建议在文件头标注 SSOT 方向（如"本文件以仓库内为准，全局目录是部署副本"）。

### 观察项（不一定是问题）

- `papers/` 目录为空（仅 .DS_Store），用途不明。
- `.roundtable/GUIDE.md`（多代理会议协议）被跟踪进 OSS 仓库，属内部协作工具文档，是否公开值得确认。
- `.pr-review/wtlocal/` 是完整 worktree 副本（已被忽略 ✅），但会让本地全文搜索结果翻倍，注意及时清理。
- `.cursor/rules/` 仅 1 条规则（drag-drop），对这个重度 AI 协作的仓库而言覆盖面偏小（无 AGENTS.md / CLAUDE.md）。

---

## 二点七、第四轮：清理执行记录（17:35，用户授权"开始优化文档，距离现在太远的历史文档可以清理"）

### 已执行动作

**1. 归档（mv 至 `docs/archive/`，本地保留，git 忽略，可随时彻底删除）**

| 来源 | 内容 | 数量 |
|---|---|---|
| 根目录 | PLAN.md、CHATANKI_REVIEW_FIX.md、CRITICAL_CODE_REVIEW_REPORT.md、LEARNING_RESOURCE_CRITICAL_REVIEW_FIXES.md | 4 |
| `docs/review/` → `archive/review/` | 2026-02 大评审全部产物 | 48 |
| `docs/plans/` → `archive/plans/` | 2026-02 计划（功能已全部落地：mindmap_edit_nodes、auto-updater、chatanki 均已验证存在于代码） | 8 |
| `docs/design/notes|review|code-review-prompts` → `archive/` | 2026-02 设计笔记/审计/评审提示词 | 23 |
| `docs/` 根层 | chatanki-debug、chatanki-multi-template-audit、chat-v2-critical-review、llm-adapter-audit-fixes、DATA-MAPPING-REPORT、SECURITY_AUDIT_REPORT_202602 | 6 |

**2. 从 git 移除（历史可恢复）**

- `git rm AUDIT_REPORT_v0.9.35.md`（审计对象 0.9.35 已过期 3 个版本）
- `git rm ACCESSIBILITY-REVIEW.md`（引用已不存在的 src/features/chat 路径，内容失效）
- `git rm docs/翻译键缺失详细报告.md`（确认为 `scripts/check-missing-translations.mjs` 自动产物，0 缺失的快照无保留价值，且已加入 gitignore 防再次提交）
- `git mv PR-REVIEW-2026-06-11.md docs/reviews/`（活文档，但根目录不是它的家）

**3. `.gitignore` 内部文档区段收敛（25 行 → 7 行）**

- 删除 16 条幽灵规则（todo.md 除外，其指向的文件全部已不存在或已归档：SECURITY_AUDIT_TYPESCRIPT_FIXES、docs/features/、docs/research/、tech-debt-*、backup-tiers、SCHEMA_CHANGELOG、api-config-provider-editing、mindmap-layout-*×2、ocr-adapters——逐一核实过均不存在）
- 删除 5 条大小写敏感隐患的文件名模式（`/docs/*report*.md` 等，P1-3 根除）
- 新增 `/docs/archive/`（目录级管理）与 `/docs/翻译键缺失详细报告.md`（脚本产物）

### 清理后形态

- 根目录 md：10 → **3**（README.md、README_CN.md、CHANGELOG.md，理想状态）
- `docs/` 根层：19 → **11** 个文件（全部为活文档/有效参考）+ archive/design/reviews 三个目录
- `docs/design/`：23 → **2**（chat-v2-model-protocol-and-skills-architecture-v1、learning-hub-core-contracts，均为现行架构文档）
- 验证：`git status` 无内部文档泄漏为未跟踪状态 ✓；`docs/archive/` 确认被忽略 ✓

### 保留决策记录

- `docs/DEEPSEEK-V4-V32-RELEASE-NOTES.md`（04-26）：描述现行 DeepSeek 适配器设计，仍有效 → 保留
- `docs/cloud-sync-compatibility-analysis-2026-05-23.md`：是 06-10 还在更新的 remediation-plan 的依据 → 保留（待修绝对路径）
- `docs/RELEASE-WORKFLOW.md`：活流程文档（保持原 gitignore 状态不变）
- `dstu-test/`（05-29~31）：距今 12 天，不算"太远" → 本轮不动

---

## 二点八、第五轮：修复执行记录（17:45，用户反馈"继续修复"）

| 问题 | 修复动作 | 状态 |
|---|---|---|
| P1-5 CONTRIBUTING→AGENTS.md 死链 | 拖拽规范并入 `docs/CODE_STYLE.md` 新 5.2 节（已验证组件路径存在），CONTRIBUTING 改链 CODE_STYLE；`.cursor/rules/drag-drop.md` 内的 AGENTS 引用一并修正 | ✅ |
| P1-6 design-tokens 14 处本机绝对路径 | 全部改为仓库相对路径（`../src/...`），13 个目标文件逐一验证存在；行号后缀移除 | ✅ |
| P1-6 cloud-sync-compat 6 处本机路径 | 改为 GitHub 官方仓库链接（CherryHQ/cherry-studio、siyuan-note/siyuan、vrtmrz/obsidian-livesync），注明行号随版本漂移 | ✅ |
| P1-7 chat README 9 个死链 | 文档索引区重写：指向真实存在的 BLOCK_RENDERING_GUIDE、core/types、plugins/（均已验证），注明历史设计文档已移除 | ✅ |
| P1-8 learning-hub-core-contracts 旧路径 | `src/features/learning-hub/` → `src/features/learning-hub/`；其余引用（openResource.ts、vfs/mod.rs、chatApi.ts）验证全部有效 | ✅ |
| P2-5 README-BUILD 3 个幽灵链接 | 改为指向真实的 BUILD-CONFIG.md | ✅ |
| P2-6 migrations README 死链 | 移除不存在的"数据治理系统重构方案"引用 | ✅ |
| P2-7 BLOCK_RENDERING_GUIDE BlockType 落后 | 清单从 13 → 22 类型与 `core/types/common.ts` 完全同步（含分组注释），头部版本标注更新为 2026-06-11，加"两处同步更新"提醒 | ✅ |
| P1-4 docs/ 无索引 | 新建 `docs/README.md`：分类索引（开发必读/架构/专项/评审/法务/内部）+ 5 条文档放置约定 | ✅ |

**验证**：全量死链复扫（git 跟踪文档）→ 0 死链（唯一报告项是本审阅记录引用 CONTRIBUTING 历史原文的代码块，非真实链接）。

---

## 二点九、第六轮：剩余文档内容级核查（18:00，用户要求"继续深入工作"）

### 核查与修复

| 对象 | 结果 |
|---|---|
| README/README_CN 引用的图片资源 | 55 个（example/×54 + logo svg）**全部存在** ✅ |
| `docs/FABLE_SOTA_GOAL.md` 代码引用 | 2 处笔误已修：`NotionDialogEnhanced.tsx`（不存在）删除；`src/api/cloudStorageApi.ts` → 实际位置 `src/utils/cloudStorageApi.ts` ✅ |
| `docs/cloud-sync-remediation-plan.md` | 反引号代码路径核查通过 ✅ |
| `docs/DEEPSEEK-V4-V32-RELEASE-NOTES.md` | 描述的 `reasoning_effort`/`enable_thinking` 双方言机制与 `src-tauri/src/llm_manager/adapters/deepseek.rs` 头注释一致 ✅ |
| `docs/design/chat-v2-model-protocol-…-v1.md` | 代码路径核查通过 ✅ |
| `scripts/dev/README.md` | 引用的 `test-deepseek-ocr.sh` 已不存在 → 移除；补录目录中实际存在但未列出的 `docker-compose.sync-test.yml` ✅ |
| `tests/visual/README.md` | `pnpm dev` → `npm run dev`（项目用 npm，存在 package-lock.json，无 packageManager 字段）✅ |
| `public/icons/providers/README.md` | 目录有 44 个 svg ≥ README 列出的 33 个，核心图标抽查全在 ✅ |
| `dstu-test/README.md` | 引用的 tauri-lab.mjs、docker-compose、npm scripts（`tauri-lab`、`dstu-test:install-skills`）全部有效 ✅ |
| `src/components/dev/chat-save-tests/README.md` | 5 个场景文件与实际目录一致（仅未列 config.ts，可忽略）✅ |
| `CommonTooltip.README.md` | Props 接口 10 字段与组件代码逐字段一致 ✅ |

### skills 双副本问题闭环（P2 观察项 → 解除）

`package.json` 中 `dstu-test:install-skills` 脚本（`install-codex-skills.mjs`）即为同步机制：**`dstu-test/skills/` 是 SSOT，`~/.codex/skills/` 是安装产物**。dstu-test/README 的 Quick Start 也以 `npm run dstu-test:install-skills` 开头。结论：机制健全，无需改文件；约定是"改仓库内，跑 install 同步"。

### 第六轮补充核查

| 对象 | 结果 |
|---|---|
| `BLOCK_RENDERING_GUIDE.md` 全文相对路径（core/plugins/components/…） | 反引号引用 0 缺失 ✅（主体内容路径健康，此前仅 BlockType 清单过期） |
| `.github/CONTRIBUTING.md` 提及的全部命令 | `npm run dev/dev:tauri/build/lint`、`cargo fmt/clippy/check/audit`、`tsc --noEmit` 全部真实存在 ✅ |
| `USAGE_EXAMPLES.md`（unified-sidebar）使用的 26 个 props | 与 `types.ts` 接口定义逐一匹配 ✅ |

### 杂项清理与补建

- `papers/` 空目录（仅 .DS_Store，2 月创建后从未使用）已删除 ✅
- 新建 `dstu-test/docs/README.md`：区分"设计文档（长期参考）"与"运行报告（历史快照，不维护）"，定义命名与归档约定 ✅

---

## 二点十、第七轮：补扫与生态一致性（18:10，继续深入）

### 新发现与修复

**P2-8 旧仓库名 `000haoji` 残留 3 处（已全部修复 ✅）**

- 官方 remote 为 `helixnow/deep-student`，但以下文件仍指旧库：
  - `.github/PULL_REQUEST_TEMPLATE.md:21`（公开，CLA 链接——贡献者点击会跳旧仓库）
  - `CHANGELOG.md:399`（0.9.10 compare 链接，223 处中唯一漏网）
  - `docs/RELEASE-WORKFLOW.md:95`（Secrets 设置链接）
- 修复后全仓库（docs/dstu-test/src）扫描确认 0 残留。

**版本号"落后"疑云查明（P2-3 修订）**

- git tag 已有 v0.9.39（05-25）、v0.9.40（05-27），而工作区 package.json/CHANGELOG 是 0.9.38——并非文档失更：当前在 `nightly` 分支，分叉点早于 main 上两次 release-please 发版。结论：**main 分支的文档/版本由 release-please 正常维护，nightly 落后属分支策略正常现象**，无需处理。

**`mcp-servers/tauri-plugin-mcp/` 无任何说明文档（已补 ✅）**

- 目录仅含 `src/tools/index.ts`（被跟踪），与 `src-tauri` 可选 feature `mcp-debug`（`tauri-plugin-mcp-bridge`）配套，但无 README 说明用途与启用方式 → 已补轻量 README。

### 核查通过项

- 补扫 mcp-servers/playwright/eslint-rules/tests/dist/build-* 目录：除 dist 内构建副本外无遗漏文档 ✅
- CHANGELOG 0.9.27→0.9.38 条目连续无跳号 ✅
- `docs/reviews/` 全部 5 个评审文档（含今日其他会话新生成 3 个）的代码路径引用 0 失效 ✅
- `.github/SECURITY.md` 支持版本表（0.9.x ✓）与现状一致 ✅
- `docs/RELEASE-WORKFLOW.md` 描述的 release-please 流程与 `.github/workflows/`（release.yml 等 9 个）及 release-please-config.json 对应 ✅
- `docs/THIRD_PARTY_LICENSES.md`：摘要式清单（02-24 生成），附完整再生成命令，结构合规；建议发布前重跑生成命令刷新 📋

---

## 二点十一、第八轮：design 草案与 .github 模板群（18:20）

- `docs/design/chat-v2-model-protocol-and-skills-architecture-v1.md`（Draft v1，03-06）：查证其"协议画像 ProtocolProfile"方案**尚未实施**（代码中无 ProtocolProfile；RequestAdapter/ProviderAdapter 双适配层与 `model2_pipeline.rs` 均仍在）→ 文档作为活草案状态标注正确，引用路径有效，保留 ✅
- `.github/ISSUE_TEMPLATE/`（bug_report、feature_request）、`CODE_OF_CONDUCT.md`、`CLA.md`（v1.0 2026-02，参照 Apache ICLA）：结构完备、内容有效 ✅

---

## 二点十二、第九轮：归档回归自查 + 符号级验证 + i18n 实质缺陷（18:35）

### 归档操作的回归修复（对第四轮清理的自查）⚠️→✅

全仓扫描"活文档引用已归档路径"，发现 **10 处由归档引发的失效引用**，全部修复：

- `docs/FABLE_SOTA_GOAL.md`（公开活文档，引用 4 个已归档报告共 8 处）：`docs/DATA-MAPPING-REPORT.md` 等 → `docs/archive/...`
- `docs/reviews/github-issues-review-2026-06-11.md`（2 处）：`CHATANKI_REVIEW_FIX.md` → `docs/archive/CHATANKI_REVIEW_FIX.md`

教训记录：移动文档必须附带全仓引用更新（与 P1-8 的代码重构同理）。

### learning-hub-core-contracts 符号级验证（超越路径检查）✅

文档 8 节提到的全部 API 符号在代码中逐一确认存在：`VIEW_CAPABILITY_MATRIX`、`getViewCapabilities`、`getCreatableFolderId`、`getQuickAccessTypeFromLauncherType`、`getLauncherTypeFromQuickAccessType`、`getQuickAccessTypeFromPath`、`LearningHubNavigationContext`、`ResourceLocator`、`textbooksAdd` 兼容壳（含 deprecation warning，与文档"仅作兼容壳"描述吻合）。该契约文档实质内容准确。

### i18n 实质缺陷发现并修复 ✅

- 运行 `npm run check:i18n:missing`（验证 CODE_STYLE 第 2 节所述流程可用）→ 发现 **en-US/settings.json 缺 7 个 `voice_input.*` 键**（中文 1784 键 vs 英文 1777），违反"en-US 与 zh-CN 结构完全一致"规范。
- 已按中文原文补齐英文翻译（description_short / not_configured / trigger_mode_title / trigger_mode_description / diagnostics_title / hold_mode_short / toggle_mode_short），复检 **缺失清零**。
- 顺带修正：检查脚本实际把报告写入 `note/`（已忽略）而非 docs/，gitignore 注释已更新说明。

### 其他核查

- `docs/cloud-sync-remediation-plan.md`：设计决策（D1-D10）+ 缺陷追溯矩阵（C/M/T/F/O 组）结构完整，与今日工作区大量 sync 代码/测试改动呼应，确认为执行中的活文档 ✅

---

## 二点十三、第十轮：README 双语深度更新（18:50，用户指示"看看 readme 是否需要更新"）

逐项核对 README 全部事实声明与代码现状，发现 5 处过期并全部修复（中英双份同步改）：

| 过期项 | 实际情况（已核实） | 修复 |
|---|---|---|
| 技术栈表"Lucide Icons" + 致谢"Lucide" | package.json 已无 lucide-react 直接依赖，全面迁移 @phosphor-icons/react（残留 3 个文件是防回归测试守卫）；5 月有"migrate all 93 chat files to Phosphor"提交 | → Phosphor Icons（2 处 ×2 语言）|
| 代码结构图 `src/features/chat/` | 实际为 `src/features/` 14 模块架构；`src/features/chat` 是 17:53 刚出现的兼容 symlink → `features/chat` | 结构图重写为 features/ 布局 |
| "内置 12 项技能" | 实测 `builtinSkills` 6 个场景技能 + `builtinToolSkills` 20 个工具组 = 26 项；新增画布笔记/图片生成/网页抓取/子代理工作区等未反映 | → "26 项技能（6+20）"并补列新技能 |
| 模型适配列表无 DeepSeek V4 | `docs/DEEPSEEK-V4-V32-RELEASE-NOTES.md`（04-26）+ `deepseek.rs` 已实现 V4 reasoning_effort 双方言 | 列表加入 DeepSeek V4 |
| 项目历程止于 2026.03 / v0.9.33 | 实际 0.9.34-35（3月，番茄钟+待办）、0.9.36-38（5月）、0.9.39-40（main 已发） | 03 行修正至 v0.9.35 并补番茄钟；新增 2026.04–06 行（DeepSeek 适配/features 重构/Phosphor 迁移/E2E 测试体系/云同步整治/v0.9.36–v0.9.40）|

**README 核对通过项**：7 种搜索引擎（google_cse/serpapi/tavily/brave/searxng/zhipu/bocha 与 web_search.rs 枚举一致）、9 家供应商、徽章/链接、安装表（Linux deb/AppImage 有 hotfix-linux-release.yml 支撑）、开发命令、对比表。
**修改后验证**：双语标题数（31=31）、历程行（4=4）、图片引用 diff 零差异、Lucide 残留清零 ✅。

---

## 二点十四、第十一轮：.github 政策文档 + 构建文档 + 组件级漏网文档（19:10，用户未回复期间持续深入）

### SECURITY.md 两处"自黑式过期"（已修复）

文档声称的弱点实际早已修复，会误导安全审查者低估现状：

| 文档声称 | 实际（tauri.conf.json 实测） |
|---|---|
| CSP 宽松：`unsafe-eval`、`unsafe-inline`、通配符 `*` | `script-src 'self'`（无 unsafe-eval）、`connect-src` 显式域名白名单；仅 `style-src 'unsafe-inline'` 与 `img-src https:` 放宽 |
| `withGlobalTauri` Enabled | `"withGlobalTauri": false` |

验证通过项：AES-256-GCM（`secure_store.rs:283-288` 实测 `Aes256Gcm`）、MCP 工具控制（`enabledTools` 机制存在）、ISSUE_TEMPLATE 两件健康。

### 构建文档补缺（已修复）

- `docs/BUILD-CONFIG.md`（02-07 停更）：补 Linux 构建段（`build_linux_all.sh` 三月已存在；产物 deb/rpm/bin 与脚本 49-68 行核对）；更新日期戳
- `docs/README-BUILD.md`：补 Linux 一键命令、脚本表（linux/all 两行）、产物表 build-linux/ 行

### 全量补扫漏网的 4 个 tracked 组件级文档

| 文档 | 核查结果 | 处理 |
|---|---|---|
| `public/icons/providers/README.md` | 清单 33 个 vs 实际 44 个 SVG，差 11 个（perplexity/huggingface/together/nvidia/stepfun/internlm/baai/teleai/kwaipilot/mimo/youdao） | 补全清单，diff 复核完全一致 ✅ |
| `src/components/shared/CommonTooltip.README.md` | 内容准确（delay 500ms=DEFAULT_TOOLTIP_DELAY_MS、example.tsx 存在）；但尾部"MIT License"与项目 AGPL-3.0 冲突（AI 生成残留） | 删除许可声明 |
| `src/components/dev/chat-save-tests/README.md` | 5 场景文件/快捷键 Ctrl+Shift+T/主面板均真实；但"相关文档"4 链全死（chat-test-system-v3、test-coverage-checklist、testid-mapping 不存在，note/ 是忽略目录）；目录结构缺 config.ts | 死链改指真实代码；补 config.ts；删"SOTA级别/100%覆盖"话术 |
| `src/components/ui/unified-sidebar/USAGE_EXAMPLES.md` | 导出/props（autoResponsive、displayMode、mobileOpen）与 types.ts 逐项核对真实，示例已用 Phosphor | 无需修改 ✅ |

### 仓库卫生（已修复）

- `mcp-feedback-enhanced/`（本机反馈工具 clone，嵌套 git 仓库 + .venv）与根目录 `deep-student.db` 加入 .gitignore，`git status` 未跟踪条目清零
- `.roundtable/GUIDE.md` 内容自洽（纯协议规范、无外部引用），无过期问题；公开性决策仍挂起

### 新增待决策

- **邮箱域名不一致**：SECURITY.md 用 `security@deepstudent.app`，CODE_OF_CONDUCT.md 用 `support@deepstudent.cn`，官网为 deepstudent.cn。哪个域名的邮箱真实可收信需用户确认，未擅改。

---

## 二点十五、第十二轮：邮箱统一落地 + 活文档符号验证 + 双源 compose 发现（19:30，用户决策"support@deepstudent.cn，继续审查和修复"）

### 邮箱统一（用户决策执行）

- `.github/SECURITY.md`：`security@deepstudent.app` → `support@deepstudent.cn`（双语两处）
- **代码侧同步发现**：`academic_search_executor.rs` 的 OpenAlex polite-pool UA 和 mailto 参数也用 `support@deepstudent.app`（真实对外联系方式）→ 一并改为 `.cn`（2 处）
- **不改项**：`com.deepstudent.app` 是 Bundle Identifier（应用数据目录标识），非邮箱/网址，改动会造成用户数据目录漂移，保持原样

### 活文档符号级抽查（全部通过 ✅）

| 文档 | 验证项 | 结果 |
|---|---|---|
| `docs/cloud-sync-remediation-plan.md`（06-10，FABLE 核心依据） | INV-1~INV-7 全部有定义；范围文件与 git 在改文件吻合；行号锚定基准 commit 5ae97d875 已自声明 | ✅ 健康 |
| `docs/DEEPSEEK-V4-V32-RELEASE-NOTES.md`（04-26） | `scripts/deepseek-live-smoke.mjs` 存在；`reasoning_effort high\|max`、`thinking_budget` 128-32768、xhigh→32768 映射与 `deepseek.rs` 实测一致 | ✅ 健康 |
| `dstu-test/README.md` | tauri-lab.mjs/compose 文件/5 个 npm scripts/7 个 run reports 逐项存在 | ✅ 健康 |
| `.cursor/rules/drag-drop.md`、`.cursor/skills/critical-review-workflow` | 无失效路径 | ✅ |
| AGENTS.md 残留引用 | 全仓清零（文件已删，引用已在第五轮修净） | ✅ |
| `docs/reviews/` 8 个评审文件 | 全部 tracked、命名符合日期约定 | ✅ |

### 新发现：双源 compose 配置（已加防漂移注释）

`scripts/dev/docker-compose.sync-test.yml` 与 `dstu-test/docker/docker-compose.sync-test.yml` 内容完全相同（除注释路径）：
- 前者被 `src-tauri/tests/sync_provider_contract_tests.rs` 的 9 处 `#[ignore]` 文案引用
- 后者被 `package.json` 的 `dstu-test:cloud:up/down` 引用
- 两边都在用、不宜擅自合并（动测试基建超出文档审阅范围）→ 已在两份文件头部加"副本互指 + 修改需同步"注释；合并决策留给用户

---

## 二点十六、第十三轮：资产/元数据/i18n 文案/发布文档深扫（19:50，"继续深入不要停止"）

### README 图片资产核查

- 双语 README 引用的 55 张图片全部存在 ✅
- **发现 5 张孤儿截图**（example/ 共 59 个文件，全 tracked）：`mcp-4.png`、`主页面.png`、`作文批改-1.png`、`模板管理.png`、`移动端主页面.png`，合计 2.3MB，全仓库零引用 → 列入待决策（删除可减仓库体积，但属素材清理非文档修复，不擅动）

### 项目元数据修复

- `src-tauri/Cargo.toml`：`authors = ["you"]` 脚手架占位符 → `["helixnow"]`（与 GitHub org 一致；cargo metadata 解析验证通过）
- `tauri.conf.json` longDescription 与 Cargo description 一致 ✅；`copyright` 为空未擅填

### 旧项目名"AI错题管理系统"残留清理（4 处全清零）

| 位置 | 问题 | 修复 |
|---|---|---|
| `src/locales/zh-CN/common.json` `app.*` | name=深度学习助手 / title=AI错题管理系统（旧名，无代码消费方的死键但值错误） | 统一为 Deep Student / AI驱动的智能学习助手 |
| `src/locales/en-US/common.json` `app.*` | Deep Learning Assistant / AI Mistake Management System | Deep Student / AI-powered intelligent learning assistant |
| `scripts/check-i18n.mjs:353` 横幅 | "AI错题管理系统 - 国际化检查工具" | "Deep Student - 国际化检查工具" |
| `scripts/start-dev.bat` 标题+横幅 | 双语旧名 | 双语新名 |

复跑 `check:i18n:missing`：缺失仍为 0；JSON 解析正常；无 lint 错误 ✅

### check-i18n.mjs 虚假输出 bug（已修复）

脚本第 343 行打印"详细报告已生成至: docs/国际化检查报告.md"，但**全脚本无任何 writeFileSync**——报告从未生成，docs/ 下也无此文件。已改为指引运行 `check:i18n:missing`（真实写 note/ 的那个）。
另验证：`check-missing-translations.mjs` 实际输出 `note/翻译键缺失详细报告.md` 与 .gitignore 注释声明一致 ✅

### docs/RELEASE-WORKFLOW.md 与实际 workflow 脱节（3 处已修复）

对照 `.github/workflows/release.yml` 实测：
1. 构建矩阵缺 Linux（release.yml:490 有 build-linux job，deb/rpm/appimage）→ 流程图补 Linux
2. Secrets 清单只列 6 项，实际 workflow 引用 13 项 → 补 CLOUDFLARE_ACCOUNT_ID/API_TOKEN（R2 bucket: deepstudent）、SILICONFLOW_BUILTIN_TEXT/VISION/EMBED_KEY（内置模型 key 构建期注入）、VERCEL_DEPLOY_HOOK（官网部署钩子）
3. 产物表缺 Linux 行 → 补 deb/rpm/AppImage

### docs/design/ 草案状态核实

`chat-v2-model-protocol-and-skills-architecture-v1.md`（03-06 Draft v1，1100 行）：核心症结符号 `RequestAdapter`/`loadedSkillsMap` 等仍存在于代码——草案描述的现状仍成立、方案未完全实施，Draft 状态准确，保留 ✅

---

## 二点十七、第十四轮：技能命令面验证 + 外链实测 + 全仓死链终扫（20:10）

### dstu-test/skills 命令面与 CLI 实测对照

- `deep-student-tauri-lab/SKILL.md` 引用的全部子命令（agent checkout/release/targets/verify、assert credential/slot/sqlite/webdav-tree、evidence snapshot、fixture webdav、image、instance、lease 系列）与 `node dstu-test/scripts/tauri-lab.mjs help` 输出逐项对得上 ✅
- `deep-student-cloud-sync-e2e/SKILL.md` 引用的 references/checklist.md、agents/openai.yaml、npm script 全部存在 ✅

### 关键外链实测

- `https://deepstudent.cn/docs/` 可访问，内容与仓库描述一致 ✅
  - **附带发现**：官网"平台支持"只写 macOS、Windows + iOS/Android 构建链路，未提 Linux（仓库已有 Linux 构建与发布）→ 网站仓库待更新，本仓库无对应可修项，记录提示
- `github.com/helixnow/deep-student/releases/latest` 返回 302（有效）；`git remote -v` 确认 origin 即 helixnow/deep-student ✅

### 全仓 tracked markdown 死链终扫（回归验证）

- 相对 `.md` 链接：唯一残留死链在本审阅记录自身（历史描述引用 `../AGENTS.md` 用了链接语法）→ 改为纯文本描述 → 复扫 **0 死链** ✅
- 全部 `./`、`../` 相对路径链接（含指向代码文件/目录）：**0 失效** ✅
- 公开文档反引号代码路径抽验（README×2/CODE_STYLE/docs 索引/CONTRIBUTING/SECURITY）：全部存在（先前 2 个"缺失"为扫描正则把 `.tsx` 截断成 `.ts` 的误报，已人工复核）✅

### CHANGELOG compare 链接核验

抽查头尾 5 个 `compare/vX...vY` 链接引用的 git tag 全部真实存在；`000haoji` 旧 owner 残留确认清零 ✅

### 自查纠错：第五轮替换的外链中有 2 个 404（已修复并全量实测）

第五轮把云同步分析文档的本机绝对路径换成 GitHub 链接时未逐一实测，本轮 curl 全测发现：

| 链接 | 状态 | 根因与修复 |
|---|---|---|
| cherry-studio `blob/main/.../BackupManager.ts` | 404（稳定复现） | main 分支该文件已移走；改为锚定 commit `101904d0`（实测 200） |
| obsidian-livesync `blob/main/src/lib/...` ×3 | db.definition 404 | `src/lib/` 是 git 子模块，GitHub 无法跨子模块 blob；3 个链接全部改链到子库 `vrtmrz/livesync-commonlib`（逐一实测 200） |
| SiYuan sync.go / repository.go | 200 / 200 | 无需修改 |

修复后 6 个外部样本链接全部 200 ✅

---

## 五、最终总结（十三轮审阅 + 十轮修复后）

### 问题清单最终状态

| 编号 | 问题 | 状态 |
|---|---|---|
| P1-1 | review/reviews 目录并存语义混乱 | ✅ 已解决：review/ 整体归档，唯一保留 reviews/（公开评审记录） |
| P1-2 | 根目录审计报告公开策略矛盾 | ✅ 已解决：根目录只剩 README×2+CHANGELOG |
| P1-3 | gitignore 文件名模式跨平台隐患 | ✅ 已解决：25→7 行，目录级管理 |
| P1-4 | docs/ 无分类无索引 | ✅ 已解决：新建 docs/README.md 索引+放置约定 |
| P1-5 | CONTRIBUTING 必读文件是死链 | ✅ 已解决：拖拽规范并入 CODE_STYLE 5.2 |
| P1-6 | 公开文档暴露本机绝对路径 20 处 | ✅ 已解决：相对路径/GitHub 链接 |
| P1-7 | chat README 导航 100% 死链 | ✅ 已解决：重写指向真实文档 |
| P1-8 | 5-13 重构未同步文档（系统性） | ✅ 活文档已修（contracts、GUIDE）；历史文档随归档自然解决 |
| P2-1 | 历史产物未归档 | ✅ 89 文件归档至 docs/archive/ |
| P2-2 | dstu-test 运行记录混杂 | ✅ 补 README 索引区分设计文档/运行报告 |
| P2-3 | CHANGELOG 疑似落后 | ✅ 查明为 nightly 分支正常现象，非问题 |
| P2-5/6 | README-BUILD/migrations 死链 | ✅ 已修复 |
| P2-7 | BLOCK_RENDERING_GUIDE 类型落后 | ✅ 13→22 与代码同步 |
| P2-8 | 旧仓库名 000haoji 残留 | ✅ 3 处全修复 |
| 观察 | skills 双副本 | ✅ 闭环：install 脚本即同步机制，仓库内为 SSOT |
| 观察 | papers/ 空目录 | ✅ 已删除 |
| 观察 | THIRD_PARTY_LICENSES 时效 | 📋 建议发布前重跑生成命令（文档自带命令） |
| 观察 | .roundtable/GUIDE.md 被跟踪公开 | ⏳ 待用户决策：保持公开 or git rm 转内部 |

### 修复产出统计

- 归档 89 个历史文档、git 移除 3 个过期文档、git mv 1 个、删除 1 个空目录
- 修复死链/失效引用 41 处（跨 12 个文件，含归档回归自查的 10 处）
- 内容同步 3 处（BlockType 22 类型、contracts 路径、en-US 补 7 个 i18n 键）
- 新建 3 个索引/说明（docs/README.md、dstu-test/docs/README.md、mcp-servers/tauri-plugin-mcp/README.md）
- gitignore 收敛 18 行；旧仓库名修正 3 处
- 核查通过项 40+（双语同步、图片资源 55、组件文档 Props 一致性、contracts 符号级验证、命令有效性、CHANGELOG 连续性等）

### 后续维护建议（供采纳）

1. **重构纪律**：目录迁移类重构的 checklist 加一条"`rg` 全仓 `.md` 引用并同步修改"（P1-8 根因）
2. **文档放置**：遵循 docs/README.md 末尾的 5 条约定；新内部文档进 `docs/design/`，完结即移 `docs/archive/`
3. **活文档标注**：契约/指南类文档头部标注"同步于 YYYY-MM-DD + 对应代码路径"（本次已为 BLOCK_RENDERING_GUIDE 建立示范）
4. **发布前检查**：重跑 THIRD_PARTY_LICENSES 生成命令；i18n 报告勿再提交（gitignore 已挡）

---

## 三、审阅日志

| 时间 | 动作 | 结论 |
|---|---|---|
| 17:08 | 全量扫描 md 文件（含 --no-ignore） | 发现 gitignore 隐藏了 86 个内部文档 |
| 17:10 | 比对 .gitignore 210-232 行内部文档区段 | 发现 P1-2、P1-3 |
| 17:12 | 读取 2026-02-10 旧文档审计报告 | 其审阅对象 user-guide 已于 02-21 删除，报告失效（P2-1） |
| 17:14 | 核实版本号/CHANGELOG/migrations README | migrations README 与目录一致 ✅；CHANGELOG 版本一致但无 Unreleased 段 |
| 17:15 | 第一轮记录完成 | 等待用户反馈 |
| 17:17 | 用户反馈"继续干" | 进入第二轮内容一致性抽查 |
| 17:18 | 验证 CODE_STYLE / BUILD-CONFIG 引用路径 | 全部有效 ✅ |
| 17:19 | 对比 BlockType 文档 vs 代码 | 文档落后 9 个类型（P2-7） |
| 17:20 | 全仓库死链扫描（git 跟踪文档） | 发现 P1-5/P1-6/P1-7、P2-5/P2-6 |
| 17:21 | README 双语同步比对 | 31 标题/13 特性全对齐 ✅ |
| 17:23 | 用户反馈"继续查" | 进入第三轮 |
| 17:25 | 追溯 5-13 features/ 目录重构 | 发现系统性根因 P1-8：重构未同步文档，≥14 文档路径失效 |
| 17:27 | 核实组件就地文档与 skills 双副本 | CommonTooltip ✅；dstu-test 与全局 skills 为无声明双副本 ⚠️ |
| 17:30 | 用户授权清理历史文档 | 核实 PLAN/plans 功能均已落地，制定归档方案 |
| 17:35 | 执行归档 89 文件 + git rm 3 + git mv 1 + gitignore 收敛 | 根目录 md 10→3，docs 根层 19→11，无泄漏 ✓ |
| 17:40 | 用户反馈"继续修复" | 进入第五轮死链/路径/内容同步修复 |
| 17:45 | 修复 9 项问题 + 新建 docs/README.md 索引 | 死链复扫清零 ✓ |
| 17:55 | 用户要求"继续深入工作，不要停止" | 进入第六轮内容级核查 |
| 18:00 | 11 项核查 + 4 处修复 + papers/ 清理 + skills 双副本闭环 | 全部记录在二点九节 |
| 18:05 | 用户再次要求继续深入 | 进入第七轮补扫与生态一致性 |
| 18:10 | 旧仓库名残留 3 处修复；版本疑云查明（nightly 分支正常）；mcp-servers 补 README | 记录在二点十节 |
| 18:20 | 第八轮：chat-v2 草案状态查证（未实施，标注正确）、.github 模板群核查 | 记录在二点十一节 |
| 18:25 | 撰写第五节最终总结（问题状态表、产出统计、维护建议） | 全部 P1 关闭，剩 1 项用户决策 |
| 18:30 | 第九轮：归档回归自查 | 发现并修复 10 处由归档引发的失效引用 ⚠️→✅ |
| 18:35 | contracts 符号级验证 + i18n 检查脚本实测 | 符号全存在；发现并补齐 en-US 7 个缺失键，复检清零 |
| 18:45 | 用户指示核查 README | 逐项核对全部事实声明 |
| 18:50 | 第十轮：README 双语更新 5 处过期项 | 图标库/结构图/技能数/模型列表/项目历程；双语同步验证通过 |
| 19:10 | 第十一轮：SECURITY/构建/组件级文档 | SECURITY 自黑式过期 2 处；构建文档补 Linux；4 个漏网组件文档核查；gitignore 卫生 |
| 19:25 | 用户决策邮箱 support@deepstudent.cn | SECURITY.md + 学术搜索 UA 代码两处统一 |
| 19:30 | 第十二轮：活文档符号验证 + 双源 compose | remediation-plan/DeepSeek notes/dstu-test 全过；compose 双拷贝加防漂移注释 |
| 19:50 | 第十三轮：资产/元数据/i18n 文案/发布文档 | 55 图片全在+5 孤儿；Cargo authors 占位符；旧项目名 4 处清零；check-i18n 虚假输出 bug；RELEASE-WORKFLOW 3 处脱节 |
| 20:10 | 第十四轮：技能命令面+外链实测+死链终扫 | tauri-lab 命令面全对；官网/Releases 可达；全仓相对链接 0 死链 |
| 20:30 | 第十四轮补：外链全量 curl 实测 | 抓到第五轮引入的 2 个 404（cherry main 路径漂移、livesync 子模块），修复后 6 链全 200 |

---

## 四、用户反馈记录

| 轮次 | 反馈 | 处理 |
|---|---|---|
| 1 | "继续干" | 继续第二轮内容一致性与死链抽查 |
| 2 | "继续查" | 继续第三轮架构重构跟随性核查 |
| 3 | "开始优化文档，距离现在太远的历史文档可以清理" | 执行第四轮清理：归档 2026-02/03 历史产物，git 移除过期跟踪文档，收敛 gitignore |
| 4 | "继续修复" | 执行第五轮：修复全部死链/本机路径/内容失同步，新建 docs 索引 |
| 5 | "请继续深入工作，不要停止"×2 | 第六~九轮：内容级核查、生态一致性、归档回归自查、i18n 实质缺陷修复 |
| 6 | "接下来看看 readme 是否需要更新" | 第十轮：README 双语 5 处过期项核实并更新 |
