# 0824 leftover 全量扫描（对照官方 `188500e0`）

扫描快照：2026-08-25 06:30 UTC。
判定基线：官方 `origin/cursor/0824-cde6` @ `188500e0`
（`docs: record latest step 13 cloud increment`）。

## 结论（TL;DR）

**没有新的 leftover。** 除已在处理中的 #160（由开放 PR #303 承载）、
#177（cherry-pick 等价已落）、#213（parser+rustfmt 已吸收、测试重放 SKIP）、
#214（GenUI/HPIAS 经 leftovers-safe 已落、8 分片 CI DROP）之外，
开放 PR #158–#268 与主题仓 B–H、leftovers-safe 相对 `188500e0`
**不存在任何未吸收的产品或测试增量**。本轮无 INCLUDE 新增，无需再开隔离枝。

## 方法

1. 对同一次 `git fetch` 固定的 `refs/pull/158..268/head` 逐一执行
   `git merge-base --is-ancestor <tip> 188500e0`；
2. 非祖先者用 `git rev-list --cherry-pick --right-only --no-merges`
   统计**非 patch 等价**的独特提交数（内容等价 cherry-pick 计为已吸收）；
3. 独特提交数 > 0 者逐提交列文件，再对每个文件核对 `188500e0`
   是否已含等价实现/测试（存在性 + 关键符号 + 必要时逐行 diff）。

指令级 IGNORE：dependabot（本轮无）、#113/#123/#134/#155（<158 不在扫描窗）、
#170（mythos-5）、#198（200MB 图片）、#200（旧 token 剥离）、#203、
已关闭 #101–#103。

## PR #158–#268 全量表

“独特提交”= 相对 `188500e0` 非 patch 等价的提交数；祖先恒为 0。

| PR | tip | 独特提交 | 处置 | 备注 |
|---:|---|---:|---|---|
| #158 | `9c01e4ff` | 2 | IGNORE | compose 复用测试已在 0824；utf8_stream 删除有害（0824 在用） |
| #159 | `8f08b3c9` | 2 | ALREADY（适配） | token 全部已定义；text-ui 已落；守卫被 failurePath/darkShadow 契约取代 |
| #160 | `7c1a5094` | 10 | INCLUDE（已由 #303 承载） | loadError / 空卡库 / 统计页调度位次 / 品牌 token |
| #161 | `d7fdb76d` | 1 | ALREADY（适配） | ImmersiveHint 与 workbench-shell-ux.test.tsx 均在 0824 |
| #162 | `10685f44` | 2 | ALREADY（适配） | finder 按 hostId 分桶已落（getFinderStore/resolveFinderHostId） |
| #163 | `1ce06e5b` | 8 | ALREADY（适配） | 划词层/保存笔记产品文件与 5 个测试文件全部在 0824 |
| #164 | `d15d9ff6` | 1 | ALREADY（适配） | finder 按 hostId 分桶已落（getFinderStore/resolveFinderHostId） |
| #165 | `0589b949` | 0 | ALREADY（祖先） |  |
| #166 | `c67fcce6` | 0 | ALREADY（祖先） |  |
| #167 | `94239510` | 2 | ALREADY（适配） | generateCardsFromNote + in-flight 守卫 + 测试均在 0824 |
| #168 | `c67a30cd` | 0 | ALREADY（祖先） |  |
| #169 | `08238dfc` | 0 | ALREADY（祖先） |  |
| #170 | `3f9620cd` | 2 | IGNORE（指令） | mythos-5 虚构模型 |
| #171 | `5a213b1e` | 0 | ALREADY（祖先） |  |
| #172 | `e963b6df` | 0 | ALREADY（祖先） |  |
| #173 | `69181341` | 0 | ALREADY（祖先） |  |
| #174 | `fb0a08f5` | 0 | ALREADY（祖先） |  |
| #175 | `5e5d7fea` | 0 | ALREADY（祖先） |  |
| #176 | `97ee408c` | 0 | ALREADY（祖先） |  |
| #177 | `6d6769bc` | 0 | ALREADY（等价 cherry-pick） | tip 6d6769bc 全部 patch 等价，独特提交 0 |
| #178 | `e10a9429` | 0 | ALREADY（祖先） |  |
| #179 | `6b519562` | 0 | ALREADY（祖先） |  |
| #180 | `0b5e2039` | 0 | ALREADY（祖先） |  |
| #181 | `78601406` | 0 | ALREADY（祖先） |  |
| #182 | `21d60585` | 0 | ALREADY（祖先） |  |
| #183 | `59c7f0aa` | 0 | ALREADY（祖先） |  |
| #184 | `2a75d0a6` | 0 | ALREADY（祖先） |  |
| #185 | `ec807e03` | 0 | ALREADY（祖先） |  |
| #186 | `2f4fe78b` | 0 | ALREADY（祖先） |  |
| #187 | `909386de` | 0 | ALREADY（祖先） |  |
| #188 | `e47515b6` | 0 | ALREADY（祖先） |  |
| #189 | `c49629c5` | 0 | ALREADY（祖先） |  |
| #190 | `ec21c436` | 0 | ALREADY（祖先） |  |
| #191 | `b5b06ca0` | 0 | ALREADY（祖先） |  |
| #192 | `aebb5b20` | 0 | ALREADY（祖先） |  |
| #193 | `bcba9a4d` | 0 | ALREADY（祖先） |  |
| #194 | `ef43401e` | 0 | ALREADY（祖先） |  |
| #195 | `b6864dbe` | 0 | ALREADY（祖先） |  |
| #196 | `6425589b` | 0 | ALREADY（祖先） |  |
| #197 | `f46d56f0` | 0 | ALREADY（祖先） |  |
| #198 | `9f0c03cc` | 1 | IGNORE（指令） | 200MB 图片语义错误 |
| #199 | `7ec24ebb` | 0 | ALREADY（祖先） |  |
| #200 | `a1fc8451` | 1 | IGNORE（指令） | 被新 special-token 实现取代 |
| #201 | `88d40382` | 0 | ALREADY（祖先） |  |
| #202 | `1b0a3624` | 0 | ALREADY（祖先） |  |
| #203 | `e76b1d54` | 1 | IGNORE（指令） | 与 #209 契约冲突 |
| #204 | `9e4c6224` | 0 | ALREADY（祖先） |  |
| #205 | `62877e96` | 0 | ALREADY（等价 cherry-pick） | 独特提交 0，patch 等价 |
| #206 | `7370c205` | 0 | ALREADY（祖先） |  |
| #207 | `48d0cd29` | 0 | ALREADY（祖先） |  |
| #208 | `01c4597e` | 0 | ALREADY（等价 cherry-pick） | 独特提交 0，patch 等价 |
| #209 | `98e31243` | 1 | IGNORE（被取代） | 剩余对齐针对旧树（26→28 工具数等），0824 测试更新 |
| #210 | `8e071fd2` | 0 | ALREADY（等价 cherry-pick） | 独特提交 0，patch 等价 |
| #211 | `32389412` | 0 | ALREADY（祖先） |  |
| #212 | `61e17f34` | 0 | ALREADY（等价 cherry-pick） | 独特提交 0，patch 等价 |
| #213 | `746445fc` | 3 | ALREADY + SKIP | parser+rustfmt 已吸收（逐文件核实）；746445fc 测试重放按指令 SKIP |
| #214 | `c2786d4b` | 30 | IGNORE | GenUI/HPIAS 经 leftovers-safe 已落（24 项 patch 等价）；8 分片 CI DROP |
| #215 | `f4f1300e` | 0 | ALREADY（祖先） |  |
| #216 | `86600617` | 0 | ALREADY（祖先） |  |
| #217 | `32212918` | 0 | ALREADY（祖先） |  |
| #218 | `850bdccb` | 1 | IGNORE（被取代） | 0824 契约已按 hunyuan-2.0 退役重写；图标契约文件 SAME |
| #219 | `5d5d2ce7` | 0 | ALREADY（祖先） |  |
| #220 | `f9499d87` | 0 | ALREADY（祖先） |  |
| #221 | `78774130` | 0 | ALREADY（祖先） |  |
| #222 | `b95a49fb` | 0 | ALREADY（祖先） |  |
| #223 | `fae6707d` | 0 | ALREADY（祖先） |  |
| #224 | `5cc4e963` | 0 | ALREADY（祖先） |  |
| #225 | `b55392f7` | 0 | ALREADY（祖先） |  |
| #226 | `1330f0a3` | 0 | ALREADY（祖先） |  |
| #227 | `98115066` | 0 | ALREADY（祖先） |  |
| #228 | `8238a2a7` | 0 | ALREADY（祖先） |  |
| #229 | `1a87eb5a` | 0 | ALREADY（祖先） |  |
| #230 | `219f4758` | 0 | ALREADY（祖先） |  |
| #231 | `f8fc6138` | 0 | ALREADY（祖先） |  |
| #232 | `64ae8791` | 0 | ALREADY（祖先） |  |
| #233 | `2b897491` | 0 | ALREADY（祖先） |  |
| #234 | `b53b9fd1` | 0 | ALREADY（祖先） |  |
| #235 | `0c27e1f0` | 0 | ALREADY（祖先） |  |
| #236 | `9b533b59` | 0 | ALREADY（祖先） |  |
| #237 | `12a62e36` | 0 | ALREADY（祖先） |  |
| #238 | `379a1e17` | 0 | ALREADY（祖先） |  |
| #239 | `5f156a9f` | 0 | ALREADY（祖先） |  |
| #240 | `c0f0e12a` | 0 | ALREADY（祖先） |  |
| #241 | `846fff49` | 0 | ALREADY（祖先） |  |
| #242 | `bfcaa002` | 0 | ALREADY（祖先） |  |
| #243 | `1956bef1` | 0 | ALREADY（祖先） |  |
| #244 | `21fa3557` | 0 | ALREADY（祖先） |  |
| #245 | `e23bd1bb` | 0 | ALREADY（祖先） |  |
| #246 | `8353bd4c` | 0 | ALREADY（祖先） |  |
| #247 | `e764d99b` | 0 | ALREADY（祖先） |  |
| #248 | `8147c23b` | 0 | ALREADY（祖先） |  |
| #249 | `9d7727a3` | 0 | ALREADY（祖先） |  |
| #250 | `704c80f6` | 0 | ALREADY（祖先） |  |
| #251 | `3fcc19b4` | 0 | ALREADY（祖先） |  |
| #252 | `b4b1f9d4` | 0 | ALREADY（祖先） |  |
| #253 | `e9a73a6c` | 0 | ALREADY（祖先） |  |
| #254 | `ba9a3b4b` | 0 | ALREADY（祖先） |  |
| #255 | `7839c167` | 0 | ALREADY（祖先） |  |
| #256 | `ac96c933` | 0 | ALREADY（祖先） |  |
| #257 | `11687811` | 0 | ALREADY（祖先） |  |
| #258 | `73a8fb36` | 0 | ALREADY（祖先） |  |
| #259 | `db848fd6` | 0 | ALREADY（祖先） |  |
| #260 | `149fd313` | 0 | ALREADY（祖先） |  |
| #261 | `fb11e8f8` | 0 | ALREADY（祖先） |  |
| #262 | `fe8fc1f4` | 0 | ALREADY（祖先） |  |
| #263 | `a46f477f` | 0 | ALREADY（祖先） |  |
| #264 | `22403a45` | 0 | ALREADY（祖先） |  |
| #265 | `3020a714` | 0 | ALREADY（祖先） |  |
| #266 | `f0b270d8` | 0 | ALREADY（祖先） |  |
| #267 | `6c71e4a5` | 0 | ALREADY（祖先） |  |
| #268 | `1306b85a` | 0 | ALREADY（祖先） |  |

汇总：祖先 90；等价 cherry-pick 5（#177/#205/#208/#210/#212）；
适配吸收（逐文件核实）7（#159/#161/#162/#163/#164/#167 及 #158 的工具链部分）；
INCLUDE 承载中 1（#160 → #303）；ALREADY+SKIP 1（#213）；
IGNORE 7（#158 有害删除、#170/#198/#200/#203 指令、#209/#218 被取代、#214 旧整枝）。

## 非祖先 PR 的逐文件核实记录

- **#158**（2 独特）：`104772c2` 的 compose 复用断言已逐条存在于 0824 的
  `scripts/__tests__/provider-contract-config.test.mjs`（本地脚本与 CI 序列
  一致性、compose project name 钉死）；`c898aae4` 删除
  `src-tauri/src/llm_manager/utf8_stream.rs`，但 0824 中该模块被
  `sse_buffer.rs` 实际调用（#195 流式解码已落），删除会回退 0824 → IGNORE。
- **#159**（2 独特）：抽样 token（`--resource-icon-*`、`--mobile-sheet-shadow`、
  `--button-secondary-surface`、`--brand-accent`、`--accent-primary`）全部已在
  `src/styles/theme-colors.css` 定义；`text-ui` 字号迁移已在
  `buttonPrimitiveContract.ts`；其 `themeColorTokens.definitions.test.ts`
  的守卫意图被 0824 的 `failurePathSurfaceTokenContract.test.ts`
  （defines every custom property…）与 `darkShadowElevationContract.test.ts`
  适配版覆盖 → ALREADY。
- **#161**（1 独特）：`ImmersiveHint.tsx`、`immersiveMode.ts`、
  `tests/vitest/workbench/workbench-shell-ux.test.tsx` 均在 0824 → ALREADY。
- **#162/#164**：finder 按 hostId 分桶在 0824 以
  `getFinderStore(hostId)` / `resolveFinderHostId` / `useFinderStoreFor`
  适配形态存在 → ALREADY。
- **#163**（8 独特）：产品文件（`SelectionToolbar.tsx`、`useTextSelection.ts`、
  `saveTextAsNote.ts`、`useSaveAsNoteFlow.tsx`、`PdfSelectionActions.tsx`）
  与全部 5 个测试文件（PdfSelectionActions / saveTextAsNote /
  useSaveAsNoteFlow / selectionToolbarShared / pdfSelectionToolbar.source）
  在 0824 均存在 → ALREADY。
- **#167**（2 独特）：`generateCardsFromNote.ts`、`mobileEditorCommands.ts`
  （含 in-flight 守卫）、`generateCardsFromText.test.ts`、
  `generateCardsFromNote.test.ts` 均在 0824 → ALREADY。
- **#209**（1 独特）：剩余对齐（chatAnki 工具数 26→28、smokeRender 改本地化
  文案断言）针对旧树；0824 的同名测试已随实现演进，17 个触及文件中 10 个
  SAME、7 个 0824 更新 → IGNORE（被取代）。
- **#213**（3 独特）：`c986c8d1` rustfmt 4 文件与 0824 逐字节 SAME；
  `a40c16a0` 的健壮 YAML 解析器（`escapedKey` 正则版）已在 0824 的
  provider-contract-config.test.mjs；`746445fc` 测试重放按指令 SKIP。
- **#214**（30 独特）：24 个 INCLUDE 增量经 leftovers-safe 重放后在
  `188500e0` 全部 patch 等价（leftovers-safe 仅剩 1 个 docs 提交非等价）；
  8 分片 CI 与旧整枝历史 DROP → IGNORE。
- **#218**（1 独特）：`OverviewTab.icons.source.test.ts` SAME；
  `apiCapabilityEngine.test.ts` 的 hunyuan-2.0 「保持可解析」断言与 0824
  已退役 hunyuan-2.0 的现行契约（`no longer resolves retired…`）相悖，
  属旧注册表状态的过时对齐 → IGNORE（被取代）。

## 主题仓 B–H 与 leftovers 分支

| 分支 | tip | 相对 0824 | 判定 |
|---|---|---|---|
| A tests | `02a1d03a` | 祖先 | ALREADY |
| B cloud | `ca796f3b` | 非祖先，独特 2 | ALREADY：`f41e5fc7` FTP 550 判定被 0824 更严的 fail-closed 版（显式 not-found 标记白名单）取代；`ca796f3b` 仅 docs |
| C genui | `bc26f121` | 非祖先，独特 0 | ALREADY（全部 patch 等价） |
| D anki | `07146ea9` | 祖先 | ALREADY |
| E opt | `ae3207ff` | 非祖先，独特 1 | IGNORE：仅 docs 整理（wrap 文档挪目录），无产品/测试增量 |
| F subapp | `575fee7f` | 祖先 | ALREADY |
| G mobile | `4ab24435` | 祖先 | ALREADY |
| H cache | `9101aa0b` | 祖先 | ALREADY |
| wrapup | `1f8d9850` | 祖先 | ALREADY |
| leftovers | `a121e9df` | 非祖先，独特 20 | IGNORE：含回退 A 的提交，被 leftovers-safe 取代（见 0824-leftover-audit.md DROP 表） |
| leftovers-clean | `5a0eab09` | 非祖先，独特 18 | IGNORE：同上，旧基线验证枝 |
| leftovers-safe | `0aab5fd7` | 非祖先，独特 1 | ALREADY：24 个 INCLUDE 代码提交全部 patch 等价已落，仅剩 1 个 docs 门禁记录提交 |

## 0824 家族 PR（#269–#305）

- 预演枝（#280–#300 各 rehearse-*、#302 g-landing）：合并预演产物，内容来源
  即上表主题仓，不构成独立增量 → 过程性，无需吸收。
- 纯 docs（#293 coverage、#301 g-diff-audit、#305 invariants、#275/#270/#271
  主题仓 PR 的 docs 增量）：无产品/测试增量。
- **#303 leftover-160**：唯一在途 INCLUDE 承载。基于 `2630dc95`，2 个提交。
- **#304 regress-cloud**：加法部分（`commands_zip.rs` 测试、
  `DataGovernanceDashboard.abg.source.test.ts`）已由官方 `08b81e29`
  逐字节吸收；其对 `threadWidthAlignmentContract.test.ts` 删除
  InputBarV2 断言的减法未取（0824 树保留 InputBarV2 契约是对的）→ ALREADY。

## INCLUDE 的文件级独特价值（仅 #160，经 #303 承载）

#303（`cursor/0824-leftover-160-cde6`，基于 `2630dc95`）相对其基线新增：

- `tests/vitest/flashcards/AnkiTasksApp.loadError.test.tsx`：
  负载失败态两用例（0824 树原本缺失）；
- `tests/vitest/flashcards/todayScreenEmptyLibrary.test.tsx`：
  空卡库补充用例（非空库全复习完不虚报、`有卡无到期显示 idle`）；
- `tests/vitest/flashcards/StatisticsScreen.test.tsx` +
  `src/features/flashcards/screens/StatisticsScreen.tsx`：
  调度设置位于统计下方的布局契约；
- `tests/vitest/brandColorTokenContract.test.ts` +
  `src/styles/theme-colors.css`：品牌 token 契约与定义。

## 建议的下一步官方动作

1. 合入 **#303**（leftover-160）：这是唯一在途 INCLUDE；其基线 `2630dc95`
   落后官方 2 个云同步提交（`d14a623b`/`bf8ab827`），合并时按官方侧保留
   S3/WebDAV 续传实现即可（#303 未触碰这些文件的新增语义）。
2. 其余开放 PR #158–#268、主题仓 B–H、leftovers/leftovers-clean/
   leftovers-safe **无需再吸收任何内容**；可按各自 IGNORE/ALREADY 处置
   逐步关闭。
3. 预演与 docs 家族枝（#280–#302、#304/#305）在官方快进确认后关闭即可；
   #304 的加法已被 `08b81e29` 吸收，无遗留。
