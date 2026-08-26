# Wave2-B 台账

> 追加式台账。每轮只在对应小节下追加,不重写既有轮次记录。台账员为本文件唯一写手;其余九份 r1 文档为只读输入,本文件不复制其全文,只做索引与摘要。

## 身份与基线

- 独立分支:`cursor/0824-wave2-desktop-subapps-a875`,draft PR #346。
- 官方产品 tip(基线):`061b4815`(Step 23:门禁、18 不变量、Tauri 主路径记录)。分支上另有 `82e016b7` 为会话起始空提交(仅 docs,不含产品代码变更),行号口径统一以 `061b4815` 工作树为准。
- 质量评审稿来源:`docs/0824-quality-review/`(27 份)为**只读复制自 `origin/cursor/0824-static-audit-cde6`(文档隔离枝)**,**未整支 merge**;其 README 自述对照 `v0.9.44` 与当时的 `origin/cursor/0824-cde6 @ 2d41ea8b`,行号需对现 tip 复核后引用(第 1 轮各文档均已逐条复核并给出现码行号)。
- 官方产品枝仍是 `cursor/0824-cde6`(PR #269);本会话不改 MERGE-PLAN、不回帖 GitHub、不 merge 任何隔离枝。

## 第 1 轮(调研+锚定+一行级)

### 1.1 执行口径

- 10 个子代理全部 `claude-fable-5-thinking-high`;无 sol/GPT/xhigh 模型,无 computerUse。
- **未跑编译/门禁/CI/vitest**(第 8 轮前禁止);所有「测试对齐」均为源码文本级修改 + grep 干跑核对,未执行。
- 未 git commit / push(父代理统一处置)。当前工作区 git 状态:4 个产品/测试文件 modified(`EnhancedPdfViewer.tsx` +20/-?、`PdfSelectionActions.tsx`、`pdfSelectionToolbar.source.test.ts`、`enhanced-pdf.css`,合计 +79/-47 行级),10 个 untracked(9 份 r1 文档 + `docs/0824-quality-review/` 目录);本台账为第 11 个新增文件。

### 1.2 本轮产品改动(全部落在锚定员-pdf 授权清单内)

| 改动 | 文件 | 性质 |
|---|---|---|
| PDF 懒加载恢复 | `EnhancedPdfViewer.tsx`(PdfSelectionActions 静态 import → React.lazy + Suspense)、`PdfSelectionActions.tsx`(ExplainPopover/TranslationPopover → 模块级 lazy,named→default 映射;制卡 → 点击时动态 import) | 把被静态导入抵消的懒加载真正生效,shared/selection、聊天弹层、cardforge 移出 PDF 主 chunk 同步路径 |
| CSS divider 合并 | `enhanced-pdf.css`(`.ds-highlight-menu__divider` 双定义合并为一处,计算样式取两者并集,视觉零变化) | 纯整理 |
| documentTitle=fileName | **已核实不重做**:Step 22 `a25d56e4` 已是 HEAD 祖先,现码约 3283 行传 `fileName` 且带解释注释 | 零改动 |
| `selectionStudyActions.ts` | 零改动(其动态 import 包装本来正确) | 复核确认 |

### 1.3 测试源码状态

- `pdfSelectionToolbar.source.test.ts`:字符串断言**已对齐懒加载改动**(正向断言 lazy/动态 import,反向断言钉住静态导入不得回归;原有守护——共享层 SelectionToolbar、hideUnavailableActions、无 ChatV2AnkiAdapter/saveAnkiCards、useSaveAsNoteFlow、Android 返回键——全部保留)。grep 干跑核对通过,**未执行 vitest**。
- `PdfSelectionActions.test.tsx`:行为断言为同步写法(`act` + 立即 `getByTestId`/`toHaveBeenCalled`),lazy 引入微任务延迟后预计跑红;**留给第 7 轮改 `findBy*`/`waitFor`**,本轮未动。

### 1.4 九份调研/锚定文档索引

| 文档 | 角色 | 一句话内容 |
|---|---|---|
| `wave2-B-r1-notes-gap.md` | 调研员-笔记 | 对标 Notion/Obsidian/RemNote,双链/背链/图谱差距清单(L/S/C/G/P/A 编号),静态子集 7 项排序 |
| `wave2-B-r1-pdf-gap.md` | 调研员-PDF | 对标 MarginNote/Zotero/PDF Expert;四项已知问题复核(2 修 2 未修);差距 G1–G10;静态子集 S1–S6 |
| `wave2-B-r1-workbench-gap.md` | 调研员-工作台 | 两条 FAIL 缝复核成立;对标 macOS/Arc/Stage Manager/iOS/Chrome;差距 G1–G9;§四 A–D 方案 |
| `wave2-B-r1-smallapps-gap.md` | 调研员-小应用 | 待办(T1–T8)/导图(M1–M7)/翻译(F1–F4)/作文(E1–E4)差距与静态子集;Step 22 两项复核不重做 |
| `wave2-B-r1-anchor-workbench.md` | 锚定员-workbench | 五态生命周期状态机、两条缝现码证据、第 2 轮插入点地图(T1–T6 / S1–S6)、快照契约、fg 行号复核表 |
| `wave2-B-r1-anchor-hub.md` | 锚定员-hub | 标签关闭 14 入口穷尽(P4 地图)、persistedTabsCache 时序(P8 地图)、进度 payload×书签覆盖接缝(P5 地图)、插入点表 |
| `wave2-B-r1-anchor-pdf.md` | 锚定员-pdf | 本轮唯一产品改动写手;懒加载前后 import 图、3 条聊天通道地图、第 4 轮插入点表、测试对齐记录 |
| `wave2-B-r1-anchor-notes.md` | 锚定员-notes | saveTextAsNote 两步非原子 + tags 后端 `vec![]` 丢弃证据链、四直存入口差异表、第 3 轮插入点表 7 项 |
| `wave2-B-r1-anchor-composer.md` | 锚定员-Composer桌面 | 桌面 overlay 状态机、sendAvailability 分叉、双窗共享 panelStates 互杀(G-1–G-5)、打磨项 P-1–P-7、越权记账 |

## 两条 FAIL 缝(本会话不可谈判底线)

来源:`docs/0824-quality-review/workbench-fg.md`(总判定 FAIL)。调研员与锚定员在 `061b4815` 逐行复核,**两条缝全部仍成立**,以下即第 2 轮任务卡摘要(行号均为现码)。

### 缝一:Workbench 卸载/切壳绕过脏数据协议 → 第 2 轮「deactivation transaction」

三条触发路径全部绕过 `canClose`:

1. 设置页关闭学习桌面:`WorkbenchSettingsSection.tsx:292-309` `handleModeChange` 落盘 `desktop.workbenchMode=false` → `workbenchBus.setEnabled(false)` → 派发 `WORKBENCH_MODE_CHANGED`,全程无逐窗确认;
2. 断点持续切壳:`App.tsx:842-857` 迟滞注释自认「整壳硬切绕过未保存确认与 windowCloseGuard」,250ms 后 `workbenchActive`(`App.tsx:858`)直接翻 false,`App.tsx:2810-2816` 卸载整棵 `LazyWorkbenchDesktop`;
3. 卸载 cleanup 只 flush 快照:`WorkbenchDesktop.tsx:466-475`,无逐窗 canClose 枚举。

而快照契约刻意只存壳(`snapshot.ts:274-288` `pickShellFields` 白名单;`windowStore.ts:570-575` hydrate 清空 launchPayloads),未保存正文不在任何快照层;exam/essay/translation 为 `instanceKey=null` 单实例(`workbenchBus.ts:58`),选中资源在 `resourceWorkspaceRegistry.ts:60-62` 模块级注册表,壳一卸即失。关窗协议本身完整(`workbenchBus.ts:422-429` → `windowCloseGuard.ts:69-82` → `createContentApp.tsx:55-79` 三态确认)——**问题是三条卸载路径都不经过它**。

**第 2 轮任务卡要点**(插入点详表见 anchor-workbench §3.1 T1–T6):新增 `runWorkbenchDeactivationTransaction(): Promise<boolean>`(建议 `core/deactivationTransaction.ts`),枚举 `useWindowStore.getState().windows` 逐窗 `confirmWindowClose`(复用 single-flight),任一 false → 整体取消(不 persist、不派发事件、开关 UI 回弹);接入点 = `WorkbenchSettingsSection.tsx:294` 之前 + `App.tsx:854` 提交 `shellStableSmallScreen` 之前;`WorkbenchDesktop.tsx:466-475` cleanup 保持现状(unmount 不能异步阻塞);静态可验证 vitest:「存在 canClose=false 窗时 handleModeChange(false) 后 `desktop.workbenchMode` 未写入、事件未派发」。

### 缝二:内存冻结绕过同一协议 → 第 2 轮「canSuspend」

- 冻结候选筛选只看三件事:lifecycle=background(`scheduler.ts:548-550`)、预取豁免(`:554`)、`keepAliveWhenOccluded`(`:121-123,528`);**无任何 dirty/canClose/canSuspend 检查**(冻结块 `scheduler.ts:542-571`;预算常量 12/macOS 9 在 `:44-45`,宽限 2500ms 在 `:49`)。
- `WindowBody.tsx:186-194` 遇 frozen 直接 return `FrozenPlaceholder`,整棵应用子树卸载;dirty checker 是「视图挂载注册、卸载注销」(`contentDirtyRegistry.ts:28-44,66-82`),卸载即注销,唤醒只能从落库重建。
- 关键前置发现:`setWindowDirty/isWindowDirty`(`windowCloseGuard.ts:23-32`)同步可查,但目前只有 Notes 维护(`NotesWorkspaceApp.tsx:1093-1095`);exam/essay/translation 未打红点——**canSuspend 必须先把 contentDirtyRegistry 桥接到每窗标记**。

**第 2 轮任务卡要点**(插入点详表见 anchor-workbench §3.2 S1–S6):① `AppDefinition` 加可选 `canSuspend?: (instanceKey) => boolean`(`core/types.ts:438-466`);② 调度器冻结循环在 `:554` 旁加同型 skip(dirty 窗 `continue`,**注意不得执行 `:564` 的 `used -= memoryWeightOf`,否则预算记账错误**;也不得进 selected/freezeCandidateSince);③ 内容应用 `canSuspend = !isContentDirty(...)`,essay/translation 回落 `getResourceWorkspaceActive`(复用 `createContentApp.tsx:57-61`);④ skip 条件并上 `isWindowDirty(win.id)` 兜底;⑤ 测试位:`setFreezeGraceOverride(0)` + 注册恒 true checker 后 `recomputeLifecycles()` 断言仍 background。不变量:**dirty 窗永不 frozen,超限时多冻干净窗,绝不反向牺牲脏窗**。顺序建议:先 S 系(域内收敛)再 T 系(跨 settings/App 壳),共享 dirty 枚举函数。

## P3–P10 状态

> 编号说明:P1/P2 即上节两条 FAIL 缝。P4/P5/P8 编号直接见 anchor-hub 文档标题(「P4 地图」「P5 地图」「P8 地图」);其余编号按第 1 轮文档中的轮次分工回溯对应。若与父代理原始编号有出入,以任务内容与文件行号为准,编号错位不影响任务卡效力。

| # | 任务 | 现状证据(现码) | 第几轮接手 | 插入点文档 |
|---|---|---|---|---|
| P3 | saveTextAsNote 两步非原子 + tags 后端丢弃 | `saveTextAsNote.ts:80,86-93` 两次 IPC、移动失败仍 `ok:true`;`handlers.rs:800-808` note 分支硬编码 `tags: vec![]`;后端单事务能力现成(`note_repo.rs:2220-2241`);旧行为被 `saveTextAsNote.test.ts:115-125` 钉绿 | 第 3 轮(handlers.rs 属第 3 轮辖区) | ✅ anchor-notes §6 插入点表 #1–#6(含风险提示) |
| P4 | Learning Hub 标签关闭非 fail-closed | 14 个关闭/淘汰入口穷尽,无一查 dirty registry(`LearningHubPage.tsx:279-291` closeTab 同步 filter;Cmd+W `:419` 与 Finder 关钮 `:998-1003` 还绕过分屏清理;LRU 淘汰 `:239-249`;保活淘汰 `TabPanelContainer.tsx:26,139-144`) | 第 2/3 轮 | ✅ anchor-hub §6 P4-1–P4-7(P4-1 为前置) |
| P5 | 预览进度写携带旧 bookmarks × 后端整数组覆盖 | `previewPersistence.ts:145-152` mergeBase 带 bookmarks、`:186-201` 翻页写携带;`handlers.rs:3607-3622,3760-3775` bookmarks 无 OCC 整数组覆盖(**后端本 wave 只读不改**) | 第 2/3 轮(前端最小切口) | ✅ anchor-hub §6 P5-1/P5-2 |
| P6 | PDF 划词双链路收敛(同选区两条工具条、笔记落点分叉、翻译面板×2、制卡入口×2、聊天通道×3) | pdf-gap §1.3/1.4 全部未修;通道地图见 anchor-pdf §三(通道 1 带 locator,2/3 纯文本;通道 2 实为 3 的「切视图再转发」包装) | 第 4 轮(主刀);验收不变量 5 条见 pdf-gap §四 S3 | ✅ anchor-pdf §七 插入点表(含删 B/留 A 两方向的精确锚点) |
| P7 | 行为测试对齐懒加载(waitFor 化) | `PdfSelectionActions.test.tsx` 同步断言在 lazy 下预计跑红(anchor-pdf §八复核:该文件无源码字符串断言,仅行为断言) | 第 7 轮 | ✅ anchor-pdf §七「测试跟进」行 |
| P8 | persistedTabsCache 回滚 + 恢复校验过度清理 | `LearningHubPage.tsx:122,153-159` save 不更新模块级 cache(remount 覆盖回滚);`:211` 校验用易变 `dstuPath` 而面板加载用 `resourceId`(`UnifiedAppPanel.tsx:216-217`),移动/重命名即误删标签 | 第 2/3 轮 | ✅ anchor-hub §6 P8-1–P8-3 |
| P9 | Exposé 活体 DOM 内存压力 | `ExposeOverlay.tsx:1-33` 头注「不卸载不截图,transform 缩放」;评审顺序约束:**先修缝二再动性能**,否则减压手段扩大丢草稿面 | 第 8 轮(后置,本轮仅书面化) | ✅ workbench-gap §六 |
| P10 | Composer 桌面 overlay 缺口(共享 panelStates 跨窗互杀 G-1、附件事件无会话过滤 G-2、workbench 可见性不收面板 G-3、z 序脱离 G-4、Agent 无面板操作面 G-5) | anchor-composer §4;G-3/G-4 标注「待真机验证」(静态推演成立) | 第 4–5 轮(打磨项 P-1–P-7 优先级已排) | ✅ anchor-composer §5(每项含精确改动面) |

## SOTA 可落地子集(第 5 轮预排)

判定口径统一:纯 TS/TSX/CSS/文档,复用既有事件与数据链,不动禁改区,可写 vitest 用例文本但不执行。

### 来自 notes-gap(4 条)

1. **G3 边类型分色**(小):`backlinksBackend.ts` 的 linkType 已到手,`localGraph.ts` 边结构加 `kind`,CSS 分色;现成测试模式可仿写。
2. **A7 observe 增补出链**(小):`agentManifest.ts` observe 用 `parseNoteLinks` 把出链并入 state,只读零新 capability。
3. **C4 命令↔Agent 清单对齐**(小):映射表 + 纯 import 一致性 vitest,防两份清单漂移。
4. **L4 笔记级 aliases 解析层**(中):`createWikiLinkIndex` 加可选 aliases 入参,resolve 顺序 ID>标题>别名,纯函数。

### 来自 pdf-gap(4 条)

1. **S1 批注列表精确定位**(小):点击批注除跳页外复用 agent 跳页 flash 机制滚动定位。
2. **S6 制卡内容附带来源行**(小):`sourceName/page` 拼进正文,零 E 接口改动。
3. **S2 批注汇总导出为笔记**(中):highlights[] → Markdown 纯函数 + 既有 `useSaveAsNoteFlow`,对齐 PDF Expert Annotation Summary。
4. **S4 来源行升级可回链引用**(中):来源行携带 `resourcePath + page`,跳转复用现成 `requestPdfPageFocus`,对标 Zotero「Show on Page」。

### 来自 workbench-gap(3 条)

1. **G3 脏信号补全**:`contentDirtyRegistry` 桥接 `setWindowDirty`,exam/essay/translation 红点开始工作(canSuspend 的数据源,可能已在第 2 轮消化,第 5 轮只补漏)。
2. **C handoff descriptor**:`{version, appType, resourceId, innerRoute?, savedAt}` 独立 settings key,双向消费一次即清;sanitize + 纯函数测试。
3. **Agent×调度结合**:agentRuntime 落 act 前调用现成 `requestWakePrefetch`(`scheduler.ts:458-464`),零新 API。

### 来自 smallapps-gap(5 条)

1. **F3 翻译分段修复**(全量):CRLF 归一、段落正则、小数/缩写保护,全在 `segmentation.ts` + 测试,零组件改动。
2. **M1 导图剪贴板补 images 白名单**(小):`sanitizeImages` 复用既有体积预算口径,纯函数。
3. **M5 背诵导航 CSS.escape + 限域**(约十行)。
4. **E1 作文注册 save handler**(本域最高优先):照抄翻译侧 `saveCurrentSessionRef` 范式,`contentDirtyIntegration.test.tsx` 有现成集成测试可平移。
5. **T6 待办 NL 词表扩展**(小):`matchDate`/`matchTime` 纯函数,既有测试范式。

## 越权观察(只记账,不改)

| 对象 | 归属 | 本轮观察 |
|---|---|---|
| Composer 移动热区/44px 类名(`ComposerToolbar.tsx:54-57,67,876`、`InputBarUI.mobileSplitContract.source.test.ts` 计数闩、移动内联面板分支) | **C** | 锚定员-Composer 涉读未涉改;桌面打磨项 P-1/P-4 不碰这些字符串;panelStates 语义改动(P-5)会波及移动关闭路径,需通报 C |
| anki/qbank 服务层、mastery、qbank_grading、CriticSummary/verdict、制卡管线契约 | **E** | PDF 侧制卡只经 `cardAgent.startGeneration` 唯一合法入口;结构化 source 字段提需求给 E,B 只透传;ExamContentView 的注册/判分/store 调用点禁改,hub close gate 只消费 `isContentDirty('exam', id)` |
| `coordinator.rs`、`tool_loop.rs` 及 hooks | **D / A** | 本轮未读未改;anchor-notes 明确 handlers.rs 第 3 轮改动仅限 note 分支 tags 一处,不碰 coordinator |
| `useReferenceToChat.ts:355` 等 Learning Hub 侧事件发射点 | Learning Hub 域 | G-2/P-6(附件事件补 sessionId)需跨域协调 |
| 书签 CAS/增量协议(`handlers.rs:3561-3775`) | 后端,本 wave 外 | P5 只做前端 payload 瘦身,后端只读记录 |

## 已验证 / 未验证(第 1 轮口径)

**已验证(静态证据:grep/读文件/行号复核):**

- 两条 FAIL 缝在 `061b4815` 仍成立,评审引用行号经逐条复核(个别 1–4 行漂移已给现码精确行号,见 anchor-workbench 附表)。
- documentTitle=fileName 已修(`a25d56e4` 为 HEAD 祖先 + 现码注释),CSS divider 双定义已合并(grep 命中第二处仅为注释文本)。
- Step 22 两项(mindmap 解压预算 `5ffd4900`、recite 统计 `1a0a7442`)在现码生效,不重做。
- 懒加载改动的语法自查(React 已导入、lazy 目标模块导出形状、JSX 配对)与测试字符串断言 grep 干跑(正向 ≥1 命中、反向 0 命中)。
- saveTextAsNote 两步/tags 丢弃/四直存入口差异,逐层行号证据链完整。
- 双链路/三聊天通道均活着且同屏(逐监听方核对)。

**未验证(必须如实声明):**

- **未跑测试/未编译**:懒加载改动的运行时行为(Suspense fallback、chunk 切分效果)、CSS 合并的实际渲染、测试文件能否通过,全部未经 vitest/tsc/构建验证——第 8 轮前禁止。
- G-3(workbench 最小化 overlay 残留)、G-4(overlay z 序)为静态推演,待真机验证。
- `PdfSelectionActions.test.tsx` 「预计跑红」是推断,未执行确认。
- 全部 SOTA 对标结论基于 WebSearch 公开资料,未实测对标产品。

## 18 不变量本域相关(静态点名)

不变量口径:`docs/dev/0824-verify-step22.md`(18/18 PASS);G 侧逐条证据 `docs/dev/0824-g-invariants.md`。本域相关项的第 1 轮静态自证:

1. **闪卡只读**:workbench 宿主侧 `FlashcardsAppWindow.tsx:15-38` 纯薄包装无新写入口;legacy 降级把 flashcards 列为 no-op(`legacyNavigationMap.ts:59`);PDF 测试保留「不出现 saveAnkiCards」断言。不破坏。
2. **无 ChatV2AnkiAdapter**:`pdfSelectionToolbar.source.test.ts` 反向断言保留且本轮未删。
3. **Finder 每宿主分桶**:`finderStore.ts:388-425` 六宿主 + files 落 default 桶;Hub 双桶调用点(`LearningHubPage.tsx:498-499,1276,1316`)记录在案,**本会话所有轮次不合桶**,handoff descriptor 也不需要合桶。
4. **G 44px 不碰**:锚定员-Composer 全部打磨项声明不触碰 `coarseHitAreaClass` 系与 `[@media(pointer:coarse)]`/`!h-11` 类名;44px 计数闩测试归 C。
5. **documentTitle 已修**:见上,后续轮次不重做该行。
6. **快照纯净性(P0)**:`pickShellFields` 白名单 + hydrate 清 payload 四层保证在案;第 2 轮实现明令**不得往快照塞草稿**,保存走 `saveContentNow`/应用落库。
7. **windowStore 四条结构性不变量**(`windowStore.ts:8-16`):第 2 轮 S2/T1 的改法已确认不触碰(anchor-workbench §6.3)。
8. **GenUI 只读冻结**:notes 侧确认对标的「可写块」形态本阶段不可做,只做只读增量(A7、只读摘要卡)。

其余不变量(备份口令、FSRS 画像、provider 协议等)不在 B 域,本台账不点名。

## 第 2 轮派遣预告(任务卡要点,供父代理直接复制)

> 角色名沿用第 1 轮口径;若父代理原始角色表命名不同,按任务内容对号。共同禁令:禁止编译/测试/npm/cargo/npx(测试只写文本);不碰 coordinator.rs、tool_loop、anki/qbank 服务层、questionBankStore、移动 44px/chrome、finder 分桶调用点;不 commit/push(父代理做);行号改码后需重新对表。

1. **实现员-缝一(deactivation transaction)**
   文件清单:新建 `src/features/workbench/core/deactivationTransaction.ts`;改 `WorkbenchSettingsSection.tsx:292-309`、`App.tsx:849-858`;复用 `windowCloseGuard.ts`、`contentDirtyRegistry.ts`、`snapshot.ts:368-375`。
   禁改区:`WorkbenchDesktop.tsx:466-475` cleanup 保持现状;不动快照白名单;不动 AgentBridge 逻辑(只验证 setEnabled 时序不早翻)。
   验收:canClose=false 窗存在时模式关闭被整体取消(vitest 文本)。
2. **实现员-缝二(canSuspend)**
   文件清单:`core/types.ts:438-466`(AppDefinition 加字段)、`scheduler.ts:545-571`(skip 谓词,注意预算记账)、`createContentApp.tsx:55-93` + `apps/content/register.ts`(内容应用实现)、`windowCloseGuard.ts:30-32`(isWindowDirty 并入)。
   禁改区:`keepAliveWhenOccluded` 语义本轮不删(降级留后续);windowStore 四不变量。
   验收:dirty background 窗预算超限不冻结(vitest 文本,用 `setFreezeGraceOverride(0)`)。
3. **实现员-脏信号补全(G3,缝二前置)**
   文件清单:`WindowBody.tsx` 或 `createContentApp.tsx` 宿主层桥接 `contentDirtyRegistry` → `setWindowDirty`;essay/translation 的 resourceId 经 `getResourceWorkspaceActive` 解析。
   禁改区:各应用已有 checker 注册点不动;ExamContentView 归 E 只消费。
4. **实现员-hub 关闭门(P4-1/P4-5 先行)**
   文件清单:`LearningHubPage.tsx:279-291,419,998-1003`(closeTab → 异步 gate;Cmd+W/Finder 关钮改走 `closeTabWithSplit`);复用 `contentDirtyRegistry.ts:47,93`。
   禁改区:isPinned 豁免与分屏清理语义保留;ExamContentView 禁改;NoteContentView 注册 checker/save handler 属本卡(其 handleSave 可直接作 save handler)。
5. **实现员-P5 前端切口(进度写瘦身)**
   文件清单:`previewPersistence.ts:145-152,186-201,247-303`(persistProgress/flush 不带 bookmarks);测试文本补双控制器交错用例。
   禁改区:`handlers.rs:3561-3775` 只读;textbook 书签双写通道(`updateBookmarksWithRetry`)不动。
6. **实现员-P8(标签持久化)**
   文件清单:`LearningHubPage.tsx:122,153-159`(cache 同步)、`:199-229`(校验改稳定 ID,path 变更重绑而非删)、`:134-145`(白名单补校验)。
   禁改区:`UnifiedAppPanel` 加载逻辑不动(已正确)。
7. **测试书写员(静态)**
   为 1–6 号卡产出 vitest 用例文本(不执行);参照 `contentDirtyIntegration.test.tsx`、`scheduler` 测试钩子、`previewPersistence.test.ts` 既有范式;同时排查改动波及的既有源码字符串闩(如 mobileSplitContract)。
8. **评审员-窄窗策略合议(G7)**
   输入:workbench-gap §四 D 两案对比(推荐方案一「紧凑形态」为目标态、方案二为过渡护栏);产出裁决文档,不改码;若采方案一,1 号卡的 App.tsx 断点分支范围需同步调整。
9. **锚定员-复核(行号对表)**
   1–6 号卡改码后,对 anchor-workbench/anchor-hub 两份插入点表逐条重新对行号,更新漂移;复核 18 不变量相关点未被触碰。
10. **台账员(第 2 轮)**
    只写本文件:追加「第 2 轮」小节(改动清单、验证口径、行号漂移、遗留),更新 P3–P10 状态列,预排第 3 轮派遣(saveTextAsNote/handlers 一次提交为主轴,任务卡底稿见 anchor-notes §6)。

---

*(第 2 轮及以后在此线下追加)*
