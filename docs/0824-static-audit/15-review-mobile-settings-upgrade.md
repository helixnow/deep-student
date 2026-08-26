model=claude-fable-5-thinking-xhigh

# 15 — 互审：07-mobile-i18n / 08-settings-legal / 09-invariants-leftover / 10-upgrade-path

- 审计树：`cursor/0824-static-audit-cde6` @ `9752bfbc`（10 份报告已落盘，
  产品文件与基座 `2d41ea8b` 一致）。
- 方式：只读复核。对四份报告引用的路径+行号逐点回源核对，并独立复现
  计数红线；按本轮约束未使用 gh、未做 git 写操作，因此 09 第二节的
  leftover PR 快照（gh 取证）**本轮无法独立复核**，只做内部自洽性检查。
- 重点任务：复核 08 的 FAIL 是否证据充分、09 的 18/18 是否过满。
  不改四份原文。

---

## 1. 08-settings-legal：FAIL 证据充分性复核（重点一）

### 1.1 证据链逐环回源——全部成立

08 的 FAIL 建立在「敏感 MCP 键的写入面与运行时读取面分叉」这一条主链上，
共 7 环，我逐环核对：

| 环 | 08 的引用 | 复核结果 |
| --- | --- | --- |
| 敏感键定义 | `secure_store.rs:109-127` | ✅ 实际清单在 `:111-127`（`mcp.transport.` / `mcp.tools.` / `mcp.servers.` 三前缀在位；08 的区间含 2 行注释，可接受） |
| 通用命令走安全存储 | `web_search.rs:538-566` | ✅ `save_setting`/`get_setting` 命令实调 `save_secret`/`get_secret`（`:549/:565`） |
| 安全写入删明文行 | `database/mod.rs:4241-4276` | ✅ `save_sensitive_secret_locked`（`:4241-4278`）写安全副本后删除明文行，删失败则回滚安全副本 |
| Settings UI 走通用命令 | `useSettingsConfig.ts:78-91` / `:350-365` | ✅ 读在 `:79-91`、写在 `:351-363`，transport/策略/tools.list 全走 `save_setting`（→ 安全存储） |
| Chat v2 明文读 | `helpers.rs:220-248` / `:251-266` | ✅ `load_mcp_tool_policy` 用 `db.get_setting`；`is_mcp_tool_allowed_by_policy` `:266` 空白名单即放行 |
| llm_manager / lib.rs 明文读 | `mod.rs:6955-7001`、`lib.rs:3341-3355` / `:3554-3646` | ✅ 逐字吻合（`get_setting("mcp.tools.whitelist/blacklist/advertise_all_tools")`、`mcp.tools.list` `:3349`、`mcp.transport.*` `:3556-3585`） |
| 明文写入口 | `cmd/mcp.rs:631-719` | ✅ `save_mcp_config` 对 `mcp.transport.*`/`mcp.tools.*` 直接 `db.save_setting`（实际到 `:720`） |

关键前提我另行补核：`Database::get_setting`（`database/mod.rs:4114-4120`）
**只查明文 `settings` 表、无安全存储回退**——08 没有显式引用这一行，但它是
「安全写入后运行时读到空值」推理的枢纽，复核成立。另外
`is_sensitive_key`（`secure_store.rs:535-545`）是 `starts_with` 前缀匹配，
08 第 38 行「`mcp.performance.*` 不在敏感前缀、不能泛化」的限定说法准确。

### 1.2 我方补强证据（使 FAIL 更扎实，08 未列）

- 坏读路径是**活的生产管线**：`load_mcp_tool_policy` 的调用点在
  `chat_v2/pipeline/tool_loop.rs:879` 与
  `chat_v2/pipeline/multi_variant.rs:940` / `:1268`——即单/多变体聊天
  流水线在每次工具广告时都会走明文读取。08 只引了函数定义，未引调用点；
  补上后「UI 保存的黑名单对运行时不可见」不是理论推演而是主链路事实。
- `get_secret` 的旧明文迁移路径（`database/mod.rs:4292-4301`）会在
  Settings UI **首次读取**时就把旧明文行搬进安全存储并删除明文行——
  即使用户升级后从不重新保存，只要打开过设置页，运行时明文读取也会
  开始拿空值。这使触发面比 08 描述的「保存后」更宽。

### 1.3 两点保留（不推翻 FAIL，但影响定级严谨性）

1. **未做既有性分诊。** 本系列惯例是区分「0824 回归」与「v0.9.44 既有
   欠账」（04 对既有问题给 WARN，07 §5 对既有缺键只记录）。08 通篇未
   论证该分叉是 0824 引入还是既有。本轮受限不使用 git，无法替它定论；
   建议主代理对照 v0.9.44 的 `useSettingsConfig.ts` / `secure_store.rs`
   确认引入时点。**但**即便属既有欠账，「UI 保存的黑名单运行时静默失效」
   是安全语义缺陷而非文案问题，按 FAIL 处理属保守方向，不构成误报。
2. **`save_mcp_config` 的可达性未交代。** 该命令已注册
   （`lib.rs:1963`、`permissions/application-commands.toml:634`），但全树
   前端**零调用点**（仅命令定义、注册表与 08 自身引用命中）。作为已暴露
   的命令面它仍是有效攻击/误用入口，列为分叉证据成立，但其严重度应
   标注「已注册、现行 UI 未使用」，08 的「另一个入口」表述略强于实况。

附带说明：「空白名单=全放行」是 `helpers.rs:216-219` 注释明示的三态设计
（advertise_all 通过清空白名单实现，「不能突然禁掉用户工具」）。08 说
「该缺失不是安全失败关闭」是准确的；真正的缺陷不在这条设计本身，而在
UI 保存的**非空**白名单/黑名单对运行时不可见后，行为退化到这条默认分支。
08 第 5 点的表述抓住了这一实质。

**小结：08 的 FAIL 证据充分，判定维持。** 所有行号引用回源吻合，无一处
断章或过度外推；两点保留（既有性分诊、命令可达性）是补强项而非翻案项。

## 2. 09-invariants-leftover：18/18 是否过满（重点二）

### 2.1 第一节 18 项——实体判定站得住

我对 18 项**全部**做了锚点回源（部分与 07/08/10 的重叠证据共用）：
hooks（`pipeline.rs:83/:243`、`hooks.rs:99/:141-142`）、GenUI 执行器、
H cache（`tool_loop.rs:78/:105/:985`、migration-lock `:268-274`）、
utf8_stream（`sse_buffer.rs:1/:128/:138/:148`）、model_special_tokens
（`llm_adapter.rs:192/:246`，`SpecialTokenStreamStripper` 零命中）、
闪卡只读（`save_to_library` 在 generative-ui 零命中）、无
ChatV2AnkiAdapter（15 处字符串命中全部为迁移注释与负向守卫测试，无
import/new）、cardAgent 两入口（`:121/:50`）、附件 200/50
（`constants.ts:180/:187`、`attachment_repo.rs:143-144`）、finder 分桶
（`finderStore.ts:415/:1286`）、qbank `daily_target: 1..=50`
（`qbank-tools.ts:746`）、tombstone（`:302/:597`）、WebDAV `decode_path`
（`:597`）、S3 `normalize_endpoint`（`:85`，回归测试 `:1188/:1202/:1218`）、
FTP `550|501` 白名单（`ftp.rs:278`）、HPIAS 18-block（allowlist 恰 18 项，
`generative_ui_executor.rs:23-42`）+ scoped bridge fail-closed
（`hpiasEventBridge.ts:106-117`）、无 mythos/haiku-5
（`builtin_vendors.rs:1681-1692`）、NOTICES/Composer/44px。
全部在树成立。**18/18 的 PASS 实体不算过满。**

### 2.2 但发现 3 处证据引用不精确（07/08 对照后 09 侧独有）

1. **token-budget 基线误引（最实质的一处）。** 09 第 11 项称
   `token-budget.test.ts:131`「现行基线：单组 7389 / 合计 54050 / 总计
   75689，护栏 9500/68000/95000」。回源核实：`:131` 是注释里的 **R1 历史
   基线**；同一注释块 `:132-136` 明说 R2-R4 精简后实测最大单组已降至
   6172（qbank-tools），**现行护栏**在 `:139-141`，为
   `6_800 / 51_500 / 75_500`。08 第 5 节引用的「6,172 / 上限 6,800」才是
   现行值。09 括号里「预算锁随实现演进但仍在位」说明作者意识到演进，
   但主句把历史值标成「现行基线」是误引。此瑕疵不改变第 11 项 PASS
   （护栏确实在位且更紧），但若按「每条证据可复现」的标准应更正。
2. **`pointer:coarse` 计数漂移。** 09 称 4105 次，我方与 07 复现均为
   **4101** 次（`rg -o` 全 src）。两值都远超 Step 8 基线 3056，结论不受
   影响，但同一树上两份报告数字不一致，09 侧未注明口径。
3. **v0.9.44 单体行数沿用旧口径。** 09 称「3921 行单体未复活」；实测
   `git show v0.9.44` 该文件为 **3919** 行（07 实测同为 3919 并注明与
   Step 8 记录的 3921 是统计口径差）。09 直接复述了 Step 8 数字。

### 2.3 leftover 章节：本轮不可独立复核，按快照时点采信

09 第二节（65 个开放 PR head、compare API、`merge-base --is-ancestor`）
全部依赖 gh 只读取证。本轮约束禁用 gh/git，我只能确认：其方法披露透明
（快照时点、逐类核对口径均写明）、与 `docs/0824-MERGE-PLAN.md` 的记录
体系自洽、点名四 PR（#160/#177/#213/#214）的处置结论与 Step 记录互相
印证。「不存在未吸收的产品增量」应理解为 **gh 快照时点有效**的结论，
head 可继续移动；09 自身也如此限定，无夸大。

**小结：09 的 18/18 不构成「过满」，实体判定维持 PASS；但其证据精度
低于 07/08（上述 3 处引用瑕疵），其中第 11 项的基线误引建议主代理在
后续轮次以勘误形式记录（本互审不改原文）。**

## 3. 07-mobile-i18n：抽查全部吻合，质量最高的一份

- 三项计数红线独立复现：`safe-area` **68** 文件、`registerBackHandler`
  **172** 次、`pointer:coarse` **4101** 次——与 07 报告数字**逐位一致**
  （07 是四份中唯一计数全对的）。
- `InputBarUI.tsx` 现 2661 行、v0.9.44 为 3919 行（07 实测正确并主动
  注明与 Step 8 的 ±2 行口径差，处理规范）。
- 关键行号抽查：`AttachmentPanelBody.tsx:158`（`t('common:more')`）、
  `releaseUpgradeI18n.test.ts:58-62`（keys/removedKeys 双锁）、
  `inputBarSplitI18nKeys.contract.test.ts:100-112`（more/actions.more/
  actions.close 三键断言）、`DataGovernanceDashboard.tsx:1808-1812`
  （`tabs_nav_label` + 页签 aria-label + 44px 强制项）——全部逐字吻合。
- 缺键记录核实：`MobileSidebarNavigation.tsx:132-133` 引用
  `section_study`/`section_manage`，zh-CN 与 en-US `sidebar.json:13-17`
  的 `mobile_drawer` 均只有三键，双语确缺。其「v0.9.44 逐字相同、非
  0824 回归」的既有性声明依赖 git show，本轮未复跑，但与 09/10 的
  记录体系一致，无相反证据。
- **PASS（附既有缺键记录）维持，无异议。**

## 4. 10-upgrade-path：抽查全部吻合

核心证据回源 8 处，全中：VFS backfill（`coordinator.rs:2275-2289`，
含「先补表后 ensure_change_log_table，否则 no such table:
main.questions」注释逐字在位）；migration-lock 三条目行号精确
（`:268-274` llm_usage / `:459-465` mistakes / `:940-946` vfs note_props）；
`cache_write_tokens` SQL 的 NULL≠0 语义注释在位；`note_props` 迁移
可空不回填；旧加密仓库口令验证（`sync_manager.rs:640-672`，注释明确
针对 v0.9.44 无 marker 场景，先试解既有 DSBK 备份再固化 v2 verifier，
损坏 marker fail-closed `:674-679`）；HPIAS scoped bridge、
releaseUpgradeI18n、inputBarSplitI18nKeys 与 07/09 的引用互证一致。
格式上「## 结论」置于文首，符合 README 对完整稿的要求。
**PASS 维持，无异议。**

## 5. 交叉一致性

- **08 FAIL 与 09 PASS 不矛盾**：MCP 存储面不在 18 不变量清单内，09 的
  PASS 只为「18 不变量 + leftover 吸收」背书，不为全树背书；README
  汇总表分别记录，读者不应把 09 的 PASS 读成对 08 结论的对冲。
- 07 与 09 的重叠区（拆分保持 / 44px / 计数红线）结论一致，分歧仅为
  09 侧两处数字漂移（§2.2 第 2、3 条），方向不受影响。
- 08 与 09 的重叠区（mythos/haiku-5、NOTICES、qbank daily_target）结论
  一致；token-budget 基线数字上 **08 正确、09 误引**（§2.2 第 1 条）。
- 07/09/10 对 `common:more` / `actions.more` 双锁的三处独立描述互相
  一致且与源码吻合。

---

## 结论

**四份报告的判定全部维持：07 PASS、08 FAIL、09 PASS、10 PASS。**

1. **08 的 FAIL 证据充分**：7 环证据链逐环回源全部成立，且我方补核了
   其未显式引用的两个枢纽事实（`Database::get_setting` 无安全回退、
   `load_mcp_tool_policy` 在 tool_loop/multi_variant 的生产调用点），
   FAIL 更为扎实。两点保留——未做 v0.9.44 既有性分诊、
   `save_mcp_config` 已注册但现行 UI 无调用点——影响定级论证的完整性，
   不构成翻案理由；建议主代理后续用 git 补做既有性确认。
2. **09 的 18/18 不算过满**：18 项锚点证据全部回源成立。但存在 3 处
   引用瑕疵（token-budget 把 R1 历史基线误标为「现行基线」——现行护栏
   实为 6800/51500/75500；`pointer:coarse` 4105 应为 4101；v0.9.44 单体
   3921 应为 3919），且 leftover 章节依赖 gh 快照、本轮不可独立复核。
   实体判定维持，证据精度建议后续勘误记录。
3. 07 与 10 抽查全部吻合，无需任何动作；07 是四份中计数精度最高的一份。
4. 本互审未发现任何需要新增的产品修复项；08 指出的 MCP 存储面分叉仍是
   全目录唯一阻断项，处置权在主代理。

不改四份原文。**本轮不改代码**（本互审仅新增本 markdown，未触碰任何
产品代码 / locale / 测试文件 / 其他报告，未执行任何 git 写操作、未使用
gh）。
