# 0824 第三轮复查：主题仓推送核验与 leftover 审计

日期：2026-08-24
复查范围：开放 PR #158–#268（共 111 个，区间内无已关闭编号）对照 `docs/0824-MERGE-PLAN.md` 与 9 个主题仓 + 统一仓。
方法：对每个 PR tip 做 `merge-base --is-ancestor` 祖先检查；非祖先的对每个提交算 stable patch-id 与全部主题仓比对；patch-id 不中的再做逐文件 blob 级（字节级）与行为标记级核对。全量核对，无抽样。

## 1. 主题仓推送核验

第二轮的 10 个分支全部真实存在于 origin（本轮 fetch 实测）：

| 分支 | tip |
|---|---|
| `cursor/0824-cde6`（统一仓） | `8361e6b764` |
| `cursor/0824-theme-wrapup-cde6`（A） | `1f8d9850d1` |
| `cursor/0824-theme-cloud-cde6`（B） | `493c4c7423` |
| `cursor/0824-theme-genui-cde6`（C） | `bc26f121a8` |
| `cursor/0824-theme-anki-cde6`（D） | `07146ea9fd` |
| `cursor/0824-theme-opt-cde6`（E） | `ae3207fff6` |
| `cursor/0824-theme-subapp-cde6`（F） | `115b202a19` |
| `cursor/0824-theme-mobile-cde6`（G） | `4ab24435bb` |
| `cursor/0824-theme-cache-cde6`（H） | `9101aa0bef` |
| `cursor/0824-theme-tests-cde6`（T） | `02a1d03a56` |

统一仓 `0824` 已含 E（#213 @ `65bad3ed`）与 C（#214 @ `c16a4fbd`），与 MERGE-PLAN §8 记录一致。

## 2. 全量 PR 处置表（#158–#268）

统计：96 个 PR tip 是某主题仓祖先；4 个（#205/#208/#210/#212）以 patch-id 等价全量进入 T；11 个做了内容级核对，其中 9 个「实质吸收 / 计划内忽略」，2 个（#160/#161）有真实未吸收提交（已收集，见 §4），另有 #177 的 tip 漂移（见 §5）。

| PR | tip | 处置 | 说明 |
|---|---|---|---|
| #158 | `9c01e4ffbd` | 9/11 patch-id 覆盖（A/T） | 实质吸收：`c898aae4`（删 utf8_stream）被 A 有意否决——A 的 sse_buffer.rs 正在使用 Utf8StreamDecoder（#195 修复）；`104772c2` 6/7 文件字节级一致，残差仅 sync_provider_contract_tests.rs 顶部 3 行注释未更新 |
| #159 | `8f08b3c9c5` | 2/4 patch-id 覆盖（A） | 实质吸收：计划点名的 ErrorBoundary 真重试（`bc392d54`）+ ResourceIcons 暗色 token（`6fa9382a`）已入 A（字节级一致）；其余 2 提交为 #164 的并行实现，A 采纳了 #164 版本（`46f92801`/`11eec219`） |
| #160 | `7c1a509459` | 2/14 patch-id 覆盖（A） | 部分吸收：空卡库伪完成、任务加载失败态、错题/作文转卡片、答题进度入库均已由 F 内容级吸收；4 个未吸收提交已收集入 leftovers（§4）；2 个测试提交绑定 #160 实现细节，未收集（§5） |
| #161 | `d7fdb76d2d` | 0/1 patch-id 覆盖 | 部分吸收：关窗走 requestCloseAnimated、ImmersiveHint 已在 F；重看引导入口、桌面组件开关、ExposeOverlay inert、恢复上次桌面 CTA、专用测试未吸收——整提交已收集入 leftovers；「删 Slash code 兜底」被 F 有意反向决策（F 注释明确保留兜底） |
| #162 | `10685f44de` | 1/3 patch-id 覆盖（F） | 实质吸收：F 的 finderStore 同构分桶（LearningHubPage/NavigationContext/FilesAppWindow/finder-host-buckets.test.ts 字节级一致），tip 提交 patch-id 已覆盖；2 个未覆盖提交是中间步骤（先做再 revert），净效果在 F |
| #163 | `1ce06e5bb7` | 0/8 patch-id 覆盖 | 实质吸收：F 中全部新文件（shared/selection、shared/notes、PdfSelectionActions 及 5 个测试）字节级一致，EnhancedPdfViewer 已接线；useMessageActions.ts 按计划跟随 #176 删除；8 个提交含互相 revert 的中间态，patch-id 不可比属预期 |
| #164 | `d15d9ff6e1` | 2/3 patch-id 覆盖（A/T） | 实质吸收：A 以 `60700b86` 重放 d15d9ff6（finderStore.ts 与 finderStoreHostBuckets.test.ts 字节级一致）；34 个涉及文件中 27 个 identical，7 个 differs 仅为 A 采纳 #166 版本的注释措辞差异或超集 |
| #165 | `0589b9491b` | 祖先已入 A / T | |
| #166 | `c67fcce6f2` | 祖先已入 A / T | |
| #167 | `94239510da` | 0/2 patch-id 覆盖 | 实质吸收：F 将 generateCardsFromText 重构为 cardAgent 直连的超集（去掉 ChatV2AnkiAdapter 依赖），其余 10 文件字节级一致 |
| #168 | `c67a30cd20` | 祖先已入 A / T | |
| #169 | `08238dfc4c` | 祖先已入 A / T | 行为亦已移植进 B：`download_assets_manifest_before_tombstones` + asset_objects 前缀防护在 B 的 sync/mod.rs（11132 行起），FTP 550/501 白名单语义在 B 的 cloud_storage/ftp.rs |
| #170 | `3f9620cda2` | 0/2 覆盖 | 计划明确忽略（mythos-5 为虚构模型） |
| #171 | `5a213b1eac` | 祖先已入 A / T | |
| #172 | `e963b6df94` | 祖先已入 G | G tip 即 #172 tip 的合并结果 |
| #173 | `6918134171` | 祖先已入 A / T | |
| #174 | `fb0a08f53b` | 祖先已入 A / T | 行为亦在 B：webdav.rs `decode_path` 编码归一化、s3.rs `normalize_endpoint`（[#57] 注释） |
| #175 | `5e5d7fea00` | 祖先已入 A / H | 计划「先 #175 再 #183」已按序执行 |
| #176 | `97ee408c8b` | 祖先已入 F | |
| #177 | `b2716f2114` | 162/165 patch-id 覆盖（B） | ⚠️ tip 漂移：B 收编停在 `5440d582`（08-24 12:00），之后 #177 又推了 `8fc45758`（P2-3 resolve 快路径事务内复查）、`6eb5f1ab`（v1 加密标记升级前试解密）、`b2716f21`（docs 收口）。三者依赖 #177 重写后的 sync 引擎与文档树，无法摘到 main 基座 → 未收集，最终合成时以 #177 tip 补合 B（见 §5） |
| #178 | `e10a94292b` | 祖先已入 A / T | |
| #179 | `6b519562ce` | 祖先已入 A / T | |
| #180 | `0b5e20393f` | 祖先已入 A / T | |
| #181 | `786014062b` | 祖先已入 A / T | |
| #182 | `21d60585e5` | 祖先已入 A / T | |
| #183 | `59c7f0aa0a` | 祖先已入 H | |
| #184 | `2a75d0a694` | 祖先已入 A / T | |
| #185 | `ec807e03df` | 祖先已入 A / T | |
| #186 | `2f4fe78b2f` | 祖先已入 A / T | |
| #187 | `909386dec1` | 祖先已入 A / T | |
| #188 | `e47515b6e6` | 祖先已入 A / T | |
| #189 | `c49629c5e6` | 祖先已入 A / T | |
| #190 | `ec21c436b2` | 祖先已入 A / T | |
| #191 | `b5b06ca0af` | 祖先已入 A / T | |
| #192 | `aebb5b2057` | 祖先已入 A / T | |
| #193 | `bcba9a4dd8` | 祖先已入 A / T | |
| #194 | `ef43401e4a` | 祖先已入 A / T | |
| #195 | `b6864dbe00` | 祖先已入 A / T | |
| #196 | `6425589b7d` | 祖先已入 A / T | |
| #197 | `f46d56f044` | 祖先已入 A / T | |
| #198 | `9f0c03cc9f` | 0/1 覆盖 | 计划明确忽略（与「文件 200MB / 图片 50MB」冲突） |
| #199 | `7ec24ebb29` | 祖先已入 A / T | |
| #200 | `a1fc845169` | 0/1 覆盖 | 计划明确忽略（被 #268 的 model_special_tokens.rs 取代） |
| #201 | `88d40382ef` | 祖先已入 A / T | |
| #202 | `1b0a362402` | 祖先已入 A / T | |
| #203 | `e76b1d5491` | 0/1 覆盖 | 计划明确弃（与 #209 冲突，T 采纳 #209） |
| #204 | `9e4c6224cd` | 祖先已入 A / T | |
| #205 | `62877e961d` | patch-id 全覆盖 T | |
| #206 | `7370c20510` | 祖先已入 A / T | |
| #207 | `48d0cd29a5` | 祖先已入 A / T | |
| #208 | `01c4597ed0` | patch-id 全覆盖 T | |
| #209 | `98e312436f` | 0/1 patch-id 覆盖 | 实质吸收：T 中 15/17 文件字节级一致，2 文件为 T 刻意升级的超集（InputBar 断言补 `max` 推理档、transitionsDev 注释口径更新） |
| #210 | `8e071fd253` | patch-id 全覆盖 T | |
| #211 | `3238941299` | 祖先已入 A / T | |
| #212 | `61e17f3498` | patch-id 全覆盖 T | |
| #213 | `65bad3ed9f` | 祖先已入 E / 0824 | |
| #214 | `c16a4fbd4e` | 祖先已入 C / 0824 | |
| #215 | `f4f1300e85` | 祖先已入 D | |
| #216 | `8660061784` | 祖先已入 A / T | |
| #217 | `3221291867` | 祖先已入 A / T | |
| #218 | `850bdccb6f` | 0/1 patch-id 覆盖 | 有意否决 + 部分吸收：治理页图标契约测试已入 T（字节级一致）；hunyuan-2.0「保持可解析」的语义翻转与 A/T 注册表已退役 hunyuan-2.0 的决策冲突，T 保留「retired 不可解析」断言 |
| #219 | `5d5d2ce72b` | 祖先已入 A / T | |
| #220 | `f9499d870f` | 祖先已入 A / T | |
| #221 | `78774130f0` | 祖先已入 A / T | |
| #222 | `b95a49fb06` | 祖先已入 A / T | |
| #223 | `fae6707d9f` | 祖先已入 A / T | |
| #224 | `5cc4e9635c` | 祖先已入 A / T | |
| #225 | `b55392f7c9` | 祖先已入 A / T | |
| #226 | `1330f0a32f` | 祖先已入 A / T | |
| #227 | `98115066fa` | 祖先已入 A / T | |
| #228 | `8238a2a7df` | 祖先已入 A / T | |
| #229 | `1a87eb5a35` | 祖先已入 A / T | |
| #230 | `219f475862` | 祖先已入 A / T | |
| #231 | `f8fc6138d0` | 祖先已入 A / T | |
| #232 | `64ae87916e` | 祖先已入 A / T | |
| #233 | `2b897491f4` | 祖先已入 A / T | |
| #234 | `b53b9fd1e3` | 祖先已入 A / T | |
| #235 | `0c27e1f09e` | 祖先已入 A / T | |
| #236 | `9b533b59db` | 祖先已入 A / T | |
| #237 | `12a62e36e7` | 祖先已入 A / T | |
| #238 | `379a1e178f` | 祖先已入 A / T | |
| #239 | `5f156a9f42` | 祖先已入 A / T | |
| #240 | `c0f0e12ac0` | 祖先已入 A / T | |
| #241 | `846fff4939` | 祖先已入 A / T | |
| #242 | `bfcaa002a6` | 祖先已入 A / T | |
| #243 | `1956bef108` | 祖先已入 A / T | |
| #244 | `21fa35579b` | 祖先已入 A / T | |
| #245 | `e23bd1bb77` | 祖先已入 A / T | |
| #246 | `8353bd4c41` | 祖先已入 A / T | |
| #247 | `e764d99bf3` | 祖先已入 A / T | |
| #248 | `8147c23b51` | 祖先已入 A / T | |
| #249 | `9d7727a3fe` | 祖先已入 A / T | |
| #250 | `704c80f6a2` | 祖先已入 A / T | |
| #251 | `3fcc19b40b` | 祖先已入 A / T | |
| #252 | `b4b1f9d4e9` | 祖先已入 A / T | |
| #253 | `e9a73a6cb6` | 祖先已入 A / T | |
| #254 | `ba9a3b4bb1` | 祖先已入 A / T | |
| #255 | `7839c1671d` | 祖先已入 A / T | |
| #256 | `ac96c93384` | 祖先已入 A / T | |
| #257 | `11687811b3` | 祖先已入 A / T | |
| #258 | `73a8fb36a0` | 祖先已入 A / T | |
| #259 | `db848fd63b` | 祖先已入 A / T | |
| #260 | `149fd313b6` | 祖先已入 A / T | |
| #261 | `fb11e8f8aa` | 祖先已入 A / T | |
| #262 | `fe8fc1f4b0` | 祖先已入 A / T | |
| #263 | `a46f477f5f` | 祖先已入 A / T | |
| #264 | `22403a45f0` | 祖先已入 A / T | |
| #265 | `3020a71478` | 祖先已入 A / T | |
| #266 | `f0b270d835` | 祖先已入 A / T | |
| #267 | `6c71e4a5ab` | 祖先已入 A / T | |
| #268 | `1306b85acb` | 祖先已入 A / T | A tip = #268 tip + finder 分桶重放 + 主题 docs |

## 3. 特别核对项结论（MERGE-PLAN §3 逐项）

| 计划项 | 结论 |
|---|---|
| #159 剩余（ResourceIcons 暗色 token / ErrorBoundary 真重试） | ✅ 已入 A，两文件与 #159 版本字节级一致 |
| #164 `d15d9ff6`（finderStore hostId 分桶）→ A | ✅ A 以 `60700b86` 重放，finderStore.ts 与测试字节级一致 |
| #169 FTP 550 tombstone → B | ✅ #169 是 A/T 祖先；B 另移植了行为（sync/mod.rs 的 before_tombstones 解析 + ftp.rs 550/501 白名单） |
| #174 WebDAV/S3 端点 → B | ✅ #174 是 A/T 祖先；B 有 decode_path 归一化与 normalize_endpoint |
| #175 → #183 → H | ✅ 两 PR tip 均为 H 祖先，顺序正确 |
| #160–#163/#167 → F 按文件移植 | ◐ #162/#163/#167 实质吸收；#160/#161 部分吸收，缺口已收集（§4） |
| `6c401455`（遮挡预览交互）→ D | ✅ D 以 rebase 后的 `6fbfeb48` 吸收，6 个文件全部字节级一致 |
| #205–#212 → T | ✅ #206/#207/#211 祖先；#205/#208/#210/#212 patch-id 全覆盖；#209 超集吸收；#203 按计划弃 |
| #218 | ✅ 图标契约入 T；hunyuan 翻转按注册表退役决策否决 |

## 4. leftovers 分支收集内容

分支：`cursor/0824-leftovers-cde6`（基于 `cursor/0824-cde6` @ `8361e6b7`），共 6 个提交：

| 提交 | 来源 | 内容 | 收集理由 |
|---|---|---|---|
| cherry-pick `514c9f14` | #160 | flashcards 卡库「手动新建 + .apkg 导入」入口（LibraryScreen/libraryStore/library.css） | F 的 libraryStore 无 importApkg，产品能力缺失 |
| cherry-pick `7f9e7c0f` | #160 | 有可见番茄钟宿主（pomodoro/todo 窗口）时隐藏悬浮药丸 | F 的 GlobalPomodoroWidget 无宿主仲裁，同屏多份计时的缺陷仍在 |
| cherry-pick `cf4f69ad` | #160 | streak/正确数/已答集合入 questionBankStore，切视图不丢会话 | F 的 QuestionBankEditor 仍用组件本地 state（`useState(0)`） |
| cherry-pick `eff6d54c` | #160 | 删除无渲染方的 PracticeModeSelector（-180 行） | F 中该组件同样只剩 @see 注释引用，死代码清理仍有效 |
| cherry-pick `d7fdb76d` | #161 | workbench 壳层交互整提交 | 未吸收：重看引导入口、桌面组件开关（含 340px 挤占修复）、ExposeOverlay inert/aria-hidden、「恢复上次桌面」CTA、专用测试。已吸收部分（关窗、ImmersiveHint）与 F 版本重叠，最终合 F 时以 F 为主重放本提交增量 |
| `d4380660`（新增） | 本轮 | 从 #160 摘取 LibraryScreen 依赖的 `library.create.*`/`library.import.*`/`library.emptyHint` i18n key（zh-CN/en-US） | 这些 key 在 #160 的未收集提交里，不补则 UI 显示原始 key |

冲突记录：仅 `d7fdb76d` 在 WorkbenchDesktop.tsx 两处冲突（0824 已有 DesktopAiBriefingWidget）。解法：两组件共存，且 AI 简报组件一并受 `desktopWidgets` 开关门控（与 #161「桌面组件可关」语义一致）。

合入指引：本分支的 5 个 #160/#161 提交都触碰 F 大改过的文件（flashcards/practice/workbench），**应在 F 合入 0824 之后再合本分支**，冲突按「F 结构为主、重放本分支行为增量」处理；`d7fdb76d` 中「删 Slash code 兜底」一项 F 已有意反向决策，合并时弃该 hunk。

## 5. 未收集但需跟进项

1. **#177 tip 漂移（最重要）**：B 仓收编停在 `5440d582`，此后 #177 推了 3 个提交：
   - `8fc45758` fix(sync): resolve 快路径事务内复查 business row（P2-3）
   - `6eb5f1ab` fix(sync): v1 加密标记升级前对既有备份试解密
   - `b2716f21` docs(sync): FINDINGS-WRAP P2-1/P2-2 收口
   三者 patch 的是 #177 重写后的 sync 引擎（该形态不存在于 main/0824 基座），无法 cherry-pick 到本分支。**动作**：合成 B 时直接用 `origin/cursor/cloud-sync-sota-b343` tip（`b2716f21`）而非 B 仓当前 tip，或合 B 后 cherry-pick 这 3 个提交。
2. #160 的 2 个测试提交（`89191388` 空卡库回归测试、`7c1a5094` 任务面板失败态测试）：断言绑定 #160 的实现细节，F 的同行为实现不同，直接搬会红；建议合 F 后按 F 的实现补写等价断言。
3. `themeColorTokens.definitions.test.ts`（#159/#160 栈）：被 A 中 #164 的 4 个契约测试（failurePathSurfaceToken/darkShadowElevation/fontSizeScaleClosure/noArbitraryFontSize）实质覆盖，无需搬。
4. #158 `104772c2` 残差：sync_provider_contract_tests.rs 顶部 3 行注释仍写 `docker compose -f ...` 旧口径（应为 `npm run dstu-test:cloud:up`），纯注释，可在任意后续 PR 顺手改。
5. #161 `workbench-shell-ux.test.tsx` 已随 `d7fdb76d` 进入本分支，合 F 时同样需要按 F 实现校准断言。

## 6. 编译门禁（本分支）

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` | ✅（先 `npm run version:generate`，与 prebuild 一致） |
| `npx vite build` | ✅（仅既有 chunk 体积/循环 reexport 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅（本分支 6 个提交零 Rust 改动，结果与 0824 基座一致） |
