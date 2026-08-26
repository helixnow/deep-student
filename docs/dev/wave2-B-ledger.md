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

## 第 2 轮(缝一/缝二/P4 落地 + 生命周期审阅 + 快照契约书面化)

### 2.1 执行口径

- 10 个子代理全部 `claude-fable-5-thinking-high`;无 sol/GPT/xhigh 模型,无 computerUse。
- **未跑编译/测试**:禁止 npm/cargo/vitest 全程遵守;3 个新测试文件(`deactivationTransaction.test.ts`、`scheduler.canSuspend.test.ts`、`closeTabGate.test.ts`)均为用例文本,未执行;第 8 轮前不实测。
- 未 commit/push(父代理统一处置)。第 1 轮的 PDF 改动已随 `73be180a` 入库,当前工作区未提交 diff **全部为第 2 轮产出**:16 个文件 modified(+409/-68,`git diff --stat`),9 个 untracked(4 份 r2 文档 + 3 个测试文本 + 2 个新源文件 `core/deactivationTransaction.ts`、`learning-hub/closeTabGate.ts`);本节为台账第 2 轮追加。

### 2.2 编号勘正(以用户 P1–P10 为准)

本轮起编号统一为用户口径:**P1 卸壳事务、P2 冻结(canSuspend)、P3 handoff(第 5 轮)、P4 Hub close、P5 书签、P6 保存落点(saveTextAsNote)、P7 划词收敛、P8 标签恢复、P9 Exposé、P10 SOTA**。第 1 轮「P3–P10 状态」表的编号与此有错位(该表 P3=saveTextAsNote→现 P6;P6=划词→现 P7;P7=测试对齐、P10=Composer overlay 不在用户 P 编号内,降为附属任务),第 1 轮正文不重写,后续轮次引用一律以本节勘正为准。

### 2.3 产品落地清单(全部静态 grep 证据,行号为撰写时工作区实况)

| # | 落地项 | 证据(现码行号) |
|---|---|---|
| P1a | **deactivationTransaction 两阶段**:phase 1 顺序逐窗 `confirmWindowClose` 全预检,任一取消 → `{ok:false}` 零副作用;phase 2(persist/bus/event)全在调用方且仅在 ok 后;模块级 single-flight | `core/deactivationTransaction.ts:42,74-77,110-112`(inFlight/入口);审阅确认取消路径不碰 flushSnapshot(契约 §2.2) |
| P1b | **三入口接线**:设置页 `handleModeChange` + `persistWorkbenchModeEnabled(false)` 统一前置事务,收口旁路三入口(ModernSidebar:516 / WorkbenchModeSwitchRow:48 / StatusBarBrandMenu:85) | `WorkbenchSettingsSection.tsx:302`、`workbenchMode.ts:150`(事务调用);三旁路入口均经 `persistWorkbenchModeEnabled` 单一写通道 |
| P1c | **App.tsx 桌面窄窗不再卸壳**:删除 `shellStableSmallScreen` 250ms 迟滞硬切,`workbenchActive = workbenchMode && !isMobilePlatform()`,移动平台护栏保留 | `App.tsx:852`(删除说明注释)、`App.tsx:860`;全库无 `shellStableSmallScreen` 残留引用 |
| P1d | **beforeunload**:App 侧工作台任一窗脏 → preventDefault + returnValue + 异步补跑 `'app-exit'` 事务;Hub 侧任一标签脏 → preventDefault(补齐笔记之外类型);与 main.tsx:636 等既有监听器不互抢 | `App.tsx:870-890,875,879`;`LearningHubPage.tsx:535-544,538` |
| P2a | **canSuspend 脏窗不冻不扣预算**:`AppDefinition.canSuspend?/prepareSuspend?` 新字段;调度器 skip 位于 `selected.add` 与 `used -= memoryWeightOf` 之前,脏窗不进 selected/freezeCandidateSince/不扣预算;`canSuspendNow` 不 await,回调抛错按不可冻(fail-closed) | `core/types.ts:476,482`;`scheduler.ts:585`(`if (isWindowDirty(win.id) \|\| !canSuspendNow(win)) continue;`)、`:140`(canSuspendNow) |
| P2b | **应用侧实现**:内容应用 `canSuspend` 复用 canClose 的 dirty 目标解析;notes `canSuspend: () => !hasUnsavedNotesWorkspaceChanges()` | `createContentApp.tsx:55,89,105`;`apps/notes/register.ts:43` |
| P2c | **registry 查询扩展**:`isContentDirty / listDirtyContentKeys / hasContentSaveHandler / saveContentNow` | `contentDirtyRegistry.ts:60,82,113,121` |
| P2d | **essay save handler**(第 1 轮 SOTA 子集 E1 提前消化):essay 注册 dirty checker + save handler,与 checker 同键无漂移 | `EssayGradingWorkbench.tsx:239,614` |
| P4 | **Learning Hub close gate 十四入口**:新 `closeTabGate.ts`(isTabDirty/confirmTabClose/requestCloseTabs 批量取消不连环弹框);入口 1-8 全走 gate(裸 closeTab 仅剩 gate 后提交步),入口 9 LRU 过滤脏标签、入口 10 keepAlive 豁免脏标签、入口 11 dstu 直删豁免(实体已删)、入口 13 unmount 尽力 flush、入口 14 beforeunload;入口 12(恢复校验)第 3 轮 | `closeTabGate.ts:25,33,63`;`LearningHubPage.tsx:100,274,309-310,329-348,388-405,476,538,552`;十四入口对照表写入 Page 文件头(`:23-33`)与 `wave2-B-r2-hub-close-gate.md` |
| i18n | **新键 5 个**(workbench ns,双语齐):`deactivation.cancelled/.dirtyBlocked/.exitBlocked`、`suspend.keptBackground`、`hub.closeCancelled`;前两个已被代码引用(`App.tsx:875`、`deactivationTransaction.ts:93`、`WorkbenchSettingsSection.tsx:304`),其余为约定占位;另记录本域疑似死键约 40 个(只记录不删除) | `zh-CN/workbench.json:544-555`、`en-US/workbench.json:544` 起;清单见 `wave2-B-r2-i18n.md` |

生命周期审阅员另打 **2 个补丁**(计入上表 P1b 与设置页):① `workbenchMode.ts` 旁路修复(三入口原先直接 persist→卸壳,逐窗 canClose 一次不问,确定性数据丢失,已前置共享事务);② `WorkbenchSettingsSection.tsx` 移除取消路径双 toast 与 `outcome.reason` 死代码。详见 `wave2-B-r2-lifecycle-review.md` §1.2/§1.3/§8。

### 2.4 四份 r2 文档索引

| 文档 | 角色 | 一句话内容 |
|---|---|---|
| `wave2-B-r2-snapshot-contract.md` | 审阅员-快照 | 快照契约三条书面化(只存壳白名单四层防线/停用事务时序分工/冻结不写快照);红线 R1–R5 判别口径;Exposé 后置第 8 轮再确认 |
| `wave2-B-r2-lifecycle-review.md` | 审阅员-生命周期 | 逐行审两阶段/预检安全/预算记账/LRU-keepalive/beforeunload/窄窗护栏/环依赖,全通过;打 2 补丁;遗留 3 项给后续轮 |
| `wave2-B-r2-hub-close-gate.md` | 实现员-hub | closeTabGate 设计 + Page 接线 + 十四入口对照 + 验收 grep |
| `wave2-B-r2-i18n.md` | i18n 员 | 5 新键双语、2 个复用声明(不造重复键)、疑似死键清单(不删) |

### 2.5 已验证 / 未验证(第 2 轮口径)

**已验证(静态证据 = grep 行号 + 逐行读码,见 2.3 表证据列):**

- 两阶段事务取消路径 persist/bus/event/flushSnapshot 均不可达;三旁路入口收口后全库无绕过事务的模式关闭写通道。
- 调度器 skip(`scheduler.ts:585`)位于预算扣减(`:595`)之前,预算记账正确;fail-closed 方向与 `isContentDirty` 一致。
- Hub 侧裸 `closeTab(` 仅剩 gate 后提交步与 dstu 直删豁免(验收 grep 见 hub-close-gate 文档 §验收)。
- 快照契约四层防线本轮 diff 零触及(`pickShellFields/sanitizeWindow/sanitizeSnapshot/WorkbenchSnapshotV1` 未改),红线 R1–R5 无违规;环依赖 DAG 成立。
- i18n 双语键齐、引用命中(grep);禁改区(coordinator.rs/tool_loop/44px/anki/qbank/finder 分桶)零触碰。

**未验证(如实声明):**

- **未跑测试/未编译**:3 个新测试文件是否通过、`tsc` 是否全绿、事务/gate/调度器改动的运行时行为,全部未经执行验证——第 8 轮前禁止。
- **beforeunload 未真机验证**:原生「确认离开」对话框行为、多监听器叠加、Tauri 壳内 beforeunload 语义,均为静态推演。
- **窄窗 compact 未真机验证**:桌面窄窗不卸壳后的实际布局表现(窗口在窄視口内的可用性)未在真机/真浏览器确认;评审员 G7 裁决的「紧凑形态」目标态本轮未实现,只移除了硬切。
- essay「保存并关闭」后正文仅草稿级持久化(localStorage),依赖重开时草稿优先恢复——第 3 轮恢复校验需覆盖(lifecycle-review §9.3)。

### 2.6 两条 FAIL 缝状态

**缝一(P1 卸壳事务)与缝二(P2 冻结)代码均已落地**:三条卸载路径(设置页/旁路入口/断点切壳——第三条已改为不卸壳)全部收口到停用事务或移除;调度器脏窗保护生效。但**验证全为静态读码 + 测试文本,第 8 轮才实测**(vitest/编译/真机),在此之前两缝状态记为「已落地、未实测」,不得对外宣称已修复闭环。

### 2.7 第 3 轮派遣预告(按用户原计划;P5/P8 属第 3 轮,不回塞第 2 轮)

> 共同禁令沿用:禁止编译/测试/npm/cargo;不碰 coordinator.rs、tool_loop、anki/qbank 服务层、移动 44px、finder 分桶;不 commit/push(父代理做);改码后行号重新对表。

1. **dstu 单次提交 folderId+tags**:后端 note 分支单事务收口(`handlers.rs:800-808` tags `vec![]` 丢弃 + folder 移动一次提交,复用 `note_repo.rs:2220-2241` 现成事务能力),插入点底稿 anchor-notes §6 #1–#6。
2. **saveTextAsNote 收口**:前端 `saveTextAsNote.ts:80,86-93` 两次 IPC 合一、移动失败不再假 `ok:true`;旧行为钉绿测试 `saveTextAsNote.test.ts:115-125` 同步改文本。
3. **入口收敛**:四直存入口(anchor-notes 差异表)统一走收口后的保存通道。
4. **书签协议(P5)**:前端最小切口——`previewPersistence.ts` 进度写不带 bookmarks(mergeBase/翻页写瘦身),`handlers.rs:3561-3775` 只读不改。
5. **标签恢复(P8)**:`LearningHubPage` persistedTabsCache 回滚修复 + 恢复校验改稳定 resourceId(path 变更重绑不误删),即 hub close gate 十四入口中预留的入口 12。
6. **审阅**:对 1–5 逐行审(原子性/错误路径/与第 2 轮 gate 的交互),行号对表更新。
7. **i18n**:新增文案键双语补齐 + 引用命中核对。
8. **提交**:第 3 轮收尾由父代理统一 commit/push;台账员追加「第 3 轮」节。

P3(handoff descriptor)维持第 5 轮、P7(划词收敛)维持第 4 轮、P9(Exposé)维持第 8 轮、P10(SOTA 子集)维持第 5 轮,均不提前。

## 第 3 轮(P6 保存落点收口 + P5 书签三态 + P8 标签恢复 + 数据流审阅)

> P 编号沿用 2.2 勘正后的用户口径:P5 书签、P6 保存落点、P8 标签恢复。

### 3.1 执行口径

- 禁止 npm/cargo/vitest 全程遵守;**未编译、未跑任何测试**,全部验证为静态读码 + grep + python json.load(locale 键集合比对)。
- 未 commit/push(父代理统一处置)。第 2 轮产出已随前序提交入库,当前工作区未提交 diff **全部为第 3 轮产出**:15 个文件 modified(+580/-224,`git diff --stat`),5 个 untracked(4 份 r3 文档 + 1 个新测试文件 `previewPersistence.bookmarkRace.test.ts`);本节为台账第 3 轮追加。

### 3.2 产品落地清单(全部静态 grep 证据,行号为撰写时工作区实况)

| # | 落地项 | 证据(现码行号) |
|---|---|---|
| P6a | **dstu tags 持久化 + folderId 单事务**:`dstu_create` note 分支不再硬编码 `tags: vec![]`;`metadata.tags` fail-closed 解析(存在则必须字符串数组,否则整单 `INVALID_ARGUMENT` 拒绝,限额由 `note_repo::validate_tags` 在事务内兜底);`metadata.folderId`(要求 `fld_` 前缀)与 path 推导合流后经 `create_note_in_folder` BEGIN IMMEDIATE 单事务落盘 | `handlers.rs:728-752`(folderId 双源合流)、`:800-826`(tags 解析 + 单事务调用) |
| P6b | **saveTextAsNote 一次提交 + landed 三态**:前端两次 IPC(create + move)合一,`notesDstuAdapter.createNote(title, content, tags, folderId)` 单次提交;新增 `resolveLandedFolder` 用 `folderApi.getFolderItems` 回查实际落点,`landed: 'folder' \| 'root'` 为**实际落点非意图落点**(回查失败保守降报 root,不谎报目录);目录确认落位才补发 `item-added` 事件,toast 按落点分文案;移动失败假 `ok:true` 问题随两步模型消亡 | `saveTextAsNote.ts:40-44,82,102,113-126,146-150`;`notesDstuAdapter.ts` 四参签名 → `metadata.folderId` |
| P6c | **三入口收敛**:TextbookContentView / FileContentView 划词做笔记、EssayGradingWorkbench 存笔记,全部迁至共享 `useSaveAsNoteFlow` + `SaveAsNoteFolderPicker`(openSource 分别 'pdf-selection'×2 / 'essay-grading');标题摘录首 30 字兜底 node.name,正文保留页码 locator;Essay 动态 import 只剩 exportFormatter | 三文件 grep `useSaveAsNoteFlow` 命中;数据流审阅 §三逐项通过(无悬空 import、deps 数组齐) |
| P6d | **quick-assistant 书面豁免**:裁决为独立产品语义**不迁入**共享流程——轻量窗无 FolderPickerDialog / showGlobalNotification / DSTU_OPEN_NOTE 宿主(三支柱皆缺),四键捕获族(笔记/错题/卡片/待办)一击直存不应分裂,且 `metadata.source: 'quick-assistant'` 为 `dstu.create` 直调独有能力,迁移反丢信息;`service.ts` 仅加 8 行豁免头注,**函数体零改动** | `wave2-B-r3-quick-assistant-exemption.md` 全文;`service.ts` 头注 |
| P5a | **后端 bookmarks 三态契约**(textbook 与 files/file/image 两分支同构):① 带 `expected_updated_at` → `replace_bookmarks_if_version` OCC 原子替换(对齐 highlights);② 无版本 + 同请求带 readingProgress → 视为进度捎带的陈旧快照,**跳过书签写入**(防跨实例交错清空);③ 无版本 + 仅 bookmarks = 显式书签通道 → `update_bookmarks` 整数组覆盖写仍允许(log 标注 versionless explicit channel)。highlights OCC(`:3594-3595` 无版本仍拒)与 `textbooks_update_bookmarks` 独立命令不动 | `handlers.rs:3633-3670`(textbook)、`:3821-3850`(files);`coordinator.rs` 零触碰 |
| P5b | **previewPersistence 通道隔离**:`persistProgress` payload 只含 readingProgress(翻页绝不携带 bookmarks,消灭「翻页清另一窗书签」最高频形态);`persistBookmarks` payload 只含 bookmarks(命中显式通道,textbook 仍先走 updateBookmarks 双写);`flush()` 两者同时 pending 时**按通道分写不合并 payload**(bookmarks 先、progress 后,onBookmarksError/onProgressError 各自触发不互串);文件头契约注释同步改写 | `previewPersistence.ts:20-29`(头注)、`:183-198`(progress 单字段)、`:198-218`(bookmarks 单字段);flush 分写见数据流审阅 §1.2 |
| P8a | **savePersistedTabs 写透缓存**:先更新模块级 `persistedTabsCache` 再写 localStorage(storage 抛异常不影响缓存),消除 Page 卸载重挂时惰性初始化读到过期快照、首次持久化 effect 用旧数据覆盖回滚的时序 | `LearningHubPage.tsx:187,224-237` |
| P8b | **恢复校验改稳定 resourceId**:后台校验从 `dstu.get(tab.dstuPath)` 改为 `dstu.get('/' + tab.resourceId)`(与 UnifiedAppPanel 实际加载键对齐);三分支:成功 → 保留并**重绑** `dstuPath = node.path`、`title = node.name`(移动/重命名不再误删);`NOT_FOUND` → 删标签;其他错误码 → 保留(不凭瞬态错误断死实体)。即第 2 轮 close gate 十四入口预留的入口 12 | `LearningHubPage.tsx:31,291,314-317`;`VfsErrorCode` 自 `@/shared/result` 导入(`:47`) |
| P8c | **OpenTab 版本化白名单解析**:存储 key 沿用 `learning-hub-tabs-v1`(不丢历史),payload 写 `version: 2`,v1/v2 共用 `parsePersistedTab` 逐字段白名单(tabId/resourceId/type 损坏整条丢弃;dstuPath/title/openedAt/isPinned 可修复回退);追加 tabId 与 resourceId 双重去重;JSON 整体损坏回空态 | `LearningHubPage.tsx:170,212` |
| i18n | **新键 5 个双语齐**:i18n 员预置 4 个(`chatV2:messageItem.actions.saveAsNoteSuccessInFolder/.saveAsNoteSavedAtRoot`、`learningHub:errors.bookmarksSaveConflict/.restoreDroppedCorrupted`),数据流审阅补 1 个实际被引用的 `saveAsNoteSuccessAtRoot`(`saveTextAsNote.ts:155` 引用,中性措辞不谎称失败);`saveAsNoteSavedAtRoot`(旧两步语义)成死键,后续轮次按死键流程处理;`bookmarksSaveConflict/restoreDroppedCorrupted` 本轮代码零引用,属预置占位 | `zh/en chatV2.json`、`zh/en learningHub.json`;清单见 `wave2-B-r3-i18n.md` |

### 3.3 数据流审阅补丁(本轮内部红转绿,3 处)

审阅员-数据流逐条比对本轮前后端契约,发现并修复 **2 处高危不一致**(细节见 `wave2-B-r3-dataflow-review.md` §一):

1. **纯书签写 fail-closed vs 前端无版本书签写**:本轮 handlers 初版把无版本纯书签写直接 `CONFLICT` 拒绝,而前端唯一 setMetadata 书签写入方 `persistBookmarks` 天然不持有 `updated_at`——按初版代码 textbook/file **每一次书签保存都会被拒**。修复取更小切口改后端:即 3.2 表 P5a 三态第 ③ 条(fail-closed → 显式通道覆盖写)。
2. **flush 合并 payload 命中「防交错跳过」**:初版 flush 把 pending 的 progress+bookmarks 合并单写,恰命中三态第 ② 条,关窗前显式书签变更被静默丢弃(textbook 有双写兜底,**file 会真丢**)。修复:即 3.2 表 P5b 的 flush 分通道。随动改 `previewPersistence.test.ts` 一例断言(合并单写 → 两次分写;该测试文件不在审阅员字面可写清单内,属「修契约所必须」,已在文档 §1.2 备案)。
3. i18n key 错位:`saveTextAsNote.ts` 实际引用 `saveAsNoteSuccessAtRoot` 而预置的是旧语义 `saveAsNoteSavedAtRoot`,en-US 会露中文兜底,补键修复(见 3.2 表 i18n 行)。

其余逐条比对通过项(tags fail-closed 全仓调用方形状核对、createNote→metadata.folderId 契约、landed 回查、三入口迁移、豁免裁决、locale 占位键)见该文档 §三表。

### 3.4 四份 r3 文档索引

| 文档 | 角色 | 一句话内容 |
|---|---|---|
| `wave2-B-r3-dataflow-review.md` | 审阅员-数据流 | 前后端契约逐条比对;2 高危不一致修复(书签三态第③条、flush 分写)+ 1 i18n 补键;遗留移交 3 项 |
| `wave2-B-r3-tab-restore.md` | 实现员-标签恢复 | P8-1 写透缓存 / P8-2 稳定 ID 重绑三分支 / P8-3 版本化白名单解析 + 双重去重 |
| `wave2-B-r3-quick-assistant-exemption.md` | 入口收敛-2 | quick-assistant 存笔记豁免裁决,三支柱无宿主 + 四键族语义 + metadata.source 能力差证据链 |
| `wave2-B-r3-i18n.md` | i18n 员 | 4 新键双语 + 复用声明(5 组既有键不重造)+ 设计取舍(不带 folder 名插值、冲突键落 learningHub 避开 practice 钉死测试) |

### 3.5 测试源码状态(已写未跑)

- `saveTextAsNote.test.ts`(+131 行级改写):对齐单次提交契约——createNote 四参、目录失败整体 `ok:false`、兼容降级 landed:root、事件仅确认入目录才发、toast 按落点措辞;第 1 轮点名的旧行为钉绿用例(原 `:115-125` 两步模型)已随契约改写。
- `previewPersistence.test.ts`(+76 行级):新增跨窗口交错用例;「dispose flush combined payload」一例由审阅员改为分写断言(call1 仅 bookmarks、call2 仅 readingProgress)。
- `previewPersistence.bookmarkRace.test.ts`(新文件):P5 书签竞态红转绿测试。
- 以上全部为**用例文本,未执行 vitest**;`previewPersistence.i18n.test.ts` 的 `toEqual(ZH_LABELS)` 整组钉死未触碰(冲突键刻意落 learningHub 命名空间避开)。

### 3.6 已验证 / 未验证(第 3 轮口径)

**已验证(静态证据 = grep 行号 + 逐行读码 + json.load 键集合比对):**

- handlers.rs 改动均在既有 match 分支内换调用,`update_bookmarks` 签名与调用点一致(同函数内既有同签名调用可证);tags 解析 fail-closed 方向与全仓 6 处 `dstu.create` note 调用方(均传字符串数组字面量)无形状冲突。
- 三态契约与前端通道隔离互相咬合:进度写(payload 无 bookmarks)不触书签,显式书签写(payload 仅 bookmarks)命中第③条,flush 分写后无任何路径落入第②条误伤。
- `landed` 回查保守方向正确(降报 root 不谎报 folder);`item-added` 事件仅确认入目录才发,与 folderApi.addItem 契约一致。
- P8 恢复校验仅 `NOT_FOUND` 删标签,fail 方向与第 2 轮 close gate 一致(fail-closed 保标签);close gate 十四入口、finder 分桶调用点、UnifiedAppPanel 加载逻辑零触碰。
- locale 4 份 JSON 解析通过,zh/en 叶子键集合逐组相等;禁改区(coordinator.rs / tool_loop / highlights OCC / textbooks_update_bookmarks 独立命令 / anki/qbank / 44px)零触碰。

**未验证(如实声明):**

- **未编译未跑测试**:Rust 侧 `cargo check` 未跑(match 分支换调用的类型正确性为人工比对);TS 侧 tsc/vitest 未跑,3 个测试文件红绿未知;第 8 轮前禁止。
- 书签三态第③条为**无 OCC 覆盖写**:跨窗口同时编辑书签仍可能互相覆盖(本轮只消灭「翻页清书签」最高频形态);闭环需前端 controller 持有并透传 `expected_updated_at` + `bookmarksSaveConflict` 接 toast,属后续轮切口(数据流审阅 §四.3)。
- 「showGlobalNotification 在 quick 窗无宿主渲染」为挂载树静态推演,未真机确认。
- `resolveLandedFolder` 回查在目录树大时的额外一次 IPC 开销未实测。

### 3.7 遗留移交

1. 死键:`chatV2:messageItem.actions.saveAsNoteSavedAtRoot`;入口迁移后 `pdf:selection.note_saved/note_save_failed/note_default_title`、`essay_grading:result_section.saved_as_note` 全仓零引用——移交后续 i18n 员按死键流程复扫(第 2 轮死键清单本轮也未复扫)。
2. `saveTextAsNote.ts:4` 头注旧入口清单含「快捷助手」,与豁免裁决不一致,建议改为「聊天消息、聊天划词」并附豁免文档索引(头注非 key 字符串,本轮两角色均无权改)。
3. `learningHub:errors.bookmarksSaveConflict / restoreDroppedCorrupted` 为预置占位零引用,留后续轮接线或按死键处理。
4. essay「保存并关闭」草稿级持久化问题(2.5 遗留)本轮未消化,P8 恢复校验只管标签存活不管正文恢复,继续挂账。

### 3.8 第 4 轮派遣预告(按用户原计划)

> 共同禁令沿用:禁止编译/测试/npm/cargo/vitest;不碰 coordinator.rs、tool_loop、anki/qbank 服务层、移动 44px、finder 分桶;不 commit/push(父代理做);改码后行号重新对表。

1. **划词收敛(P7)设计 + 实现**:PDF 划词双链路收敛主刀(同选区两条工具条、笔记落点分叉、翻译面板×2、制卡入口×2、聊天通道×3);插入点底稿 anchor-pdf §七(删 B/留 A 两方向精确锚点),验收不变量 5 条见 pdf-gap §四 S3;笔记落点分叉在本轮 P6c 收敛后需重新对表。
2. **阅读器残项**:PDF 侧第 1 轮遗留(批注定位 S1 等静态子集中与划词收敛同文件的项顺带消化,避免二次开文件)。
3. **导图 / 翻译作文 / 待办**:小应用域改动(smallapps-gap 静态子集:M1 导图剪贴板 images 白名单、M5 背诵导航 CSS.escape、F3 翻译分段修复、T6 待办 NL 词表;E1 essay save handler 已在第 2 轮消化,只补漏)。
4. **EPUB**:阅读器 EPUB 支持面调研/落地(以现有 preview 持久化三态契约为基线,书签/进度通道直接复用 P5 成果)。
5. **审阅**:对 1–4 逐行审(与 P5/P6 本轮契约的交互、行号对表更新)。
6. **提交**:第 4 轮收尾由父代理统一 commit/push;台账员追加「第 4 轮」节。

P3(handoff descriptor)与 P10(SOTA 子集)维持第 5 轮、P9(Exposé)维持第 8 轮,不提前。

## 第 4 轮(P7 划词收敛 + 阅读器残项 + 导图/翻译/待办小应用 + EPUB 复核)

> P 编号沿用 2.2 勘正后的用户口径:本轮主轴为 **P7 划词收敛**;其余为 smallapps 静态子集与阅读器残项,不占 P 编号。

### 4.1 执行口径

- 禁止 npm/vitest/编译全程遵守;**未跑任何测试**,全部验证为静态 grep 干跑 + 逐行读码 + 正则手推(待办 NL 解析)。
- 未 commit/push(父代理统一处置)。第 3 轮产出已随 `6fe01f2a` 入库,当前工作区未提交 diff **全部为第 4 轮产出**:26 个文件 modified(+937/-357,`git diff --stat`),untracked 为 6 份 r4 文档 + 3 个新源/测试文件(`mindmap/utils/imageSanitize.ts` 及其测试、`todo/utils/domVisibility.ts`);本节为台账第 4 轮追加。

### 4.2 产品落地清单(全部静态证据,行号为撰写时工作区实况;划词域验收以符号/字符串锚点为准)

| # | 落地项 | 证据 |
|---|---|---|
| P7a | **划词单工具条终态**:高亮菜单(桌面 `ds-highlight-menu` / 移动 `ds-pdf__highlight-bar`)只剩 **4 色色板(`canPersistAnnotations && rotation === 0` 门禁)+ 复制**(移动条另有标签/关闭结构件);链路 A 学习动作五钮 ×2、六个 handler(`openSelectionTranslation/openSelectionQuestionGeneration/openSelectionCardGeneration/handleQuoteSelection/handleNoteSelection` 等)、viewer 内翻译面板(`ds-pdf__translation-panel` 三规则块 + `SelectionTranslationPopover` lazy 声明 + state)全删;**学习动作单条化**收敛到 `PdfSelectionActions` 挂共享层 `SelectionToolbar`:解释/翻译/保存为笔记(目录选择 + 页码 locator + 真实 fileName)/制卡/添加到聊天,「生成题目」不进终态工具条 | 审阅 V4/V7 通过:viewer 全文 `Translate/Exam/Cards/ChatCircleText/NotePencil` icon 零命中;`ds-pdf__translation-panel` 全仓仅剩 CSS 指路注释(enhanced-pdf.css:1958);共享层 `git diff --stat -- src/shared/selection` 为空(V9) |
| P7b | **`onQuoteToChat` 已接线**(通道 1,审阅员必修补丁):补丁前该 prop 被标 @deprecated 且挂载点不传,通道 1 在唯一挂载点断线;审阅员三步接线(props 注释改写 + 解构加回 + 挂载点 `onQuoteToChat={onQuoteToChat}`)后全链在线:`FileContentView/TextbookContentView.handleQuoteToChat` → `TextbookPdfViewer` 透传 → `EnhancedPdfViewer` 转发(3168)→ `PdfSelectionActions.handleAddToChat`(页码可得走回调 → `referenceToChat` 资源引用 + `page:N` locator;否则 PREFILL 兜底) | 审阅 V2 通过;`onQuoteToChat` 上不再有 @deprecated 字样;两侧 payload 同源 `PdfSelectionPayload` |
| P7c | **PDF 域不再裸派发 `CHAT_V2_SET_INPUT`**:通道 3 清零,产品代码命中仅剩解释性注释 ×4 与旧测试用例(测试文本更新属待办 C,按设计文档缓期第 7 轮);兜底统一走 `selectionStudyActions.sendSelectionToChatInput`(typed `dispatchAppEvent(PREFILL_CHAT_INPUT)`,detail 交叉类型并入 `page/sourceName`,全局 `PrefillChatInputDetail` 契约不动,空文本返回 false 不派发);`CHAT_V2_SET_INPUT` 常量与两监听方(useChatPageEvents/WorkbenchEventBridge)、App 壳层转发、聊天域内部 MessageItem 均不动(非 PDF 辖区) | 审阅 V1 通过(产品代码);V10 通过:PREFILL 监听方仍只有 `App.tsx:1817`,PDF 域发起方仅 `selectionStudyActions.ts` |
| P7d | **懒加载四闩与 documentTitle 不回归**:viewer `React.lazy(PdfSelectionActions)`(82)、组件内两弹层模块级 lazy(43-48)、制卡点击时动态 import(175)俱在;`documentTitle={fileName}` 1 命中(3167)注释保留 | 审阅 V5/V6 通过 |
| 残项 | **阅读器残项三 helper**(`pdfViewState.ts`/`pdfSearch.ts`,全部为新增导出、**不接线不生效**,viewer 接线点已逐条标注留后续轮):① 切文档 zoom/viewMode 继承语义头注声明为**有意行为**(非 bug 不改行为)+ 导出 `resolvePdfViewStateOnSwitch(defaults, persisted)` 纯函数;② `createSearchProgressThrottle(publish, everyNChunks=5)` 搜索进度节流(首块即发/终块必发/flush 补发,只节流进度数字不碰命中结果);③ `pdf-viewstate:` 轻量 GC:`savePdfViewState` 载荷追加 `savedAt` 元数据(读取丢弃不泄漏)+ `sweepPdfViewStates({maxEntries=200, keepResourcePath})` 近似 LRU 淘汰,不在 import 时自动扫全库 | `wave2-B-r4-reader-residuals.md`;运行时行为唯一变化 = 写入 JSON 多 `savedAt` 字段;两测试文件新增断言组(未执行) |
| 导图 | **images 清洗与限域**(smallapps M1+M5):① 新增 `utils/imageSanitize.ts` 纯函数模块——`MindMapImage.src` 类型承诺的运行时实现:data URL 限白名单 MIME(与 importers `IMAGE_MIME_BY_EXT` 同口径)+ 单图 256 KiB/数量 128/累计 8 MiB 预算,远程仅放行 https;`clipboardCodec.sanitizeForest`(结构化载荷补 images 字段,复制含图节点不再丢图,整片森林共享一份预算)与 `importFromJson.ensureIds`(JSON 导入逐节点白名单重建)两入口接入,常量刻意不 import importers(避免 jszip/i18n 重依赖入剪贴板路径成环);② `ReciteStatusBar` 复习导航滚动**限域到本实例 `.mindmap-container`**(barRef.closest 反查,分屏/保活多实例不再滚动另一棵树)+ nodeId 经 `CSS.escape`(含引号/反斜杠的导入 id 不再拼出非法 selector) | diff:6 文件 +66/-23 + 新模块 107 行 + 测试 140 行;**无对应 r4 任务文档**,归属据审阅 §四 diff 核查补记(疑似并行写手交码未交文);审阅判定未越权(纯 mindmap 域,不碰 PDF/聊天/共享层) |
| 翻译 | **isActive + 分段 + 流桥**(smallapps F1/F3):① `TranslateWorkbench` 自动翻译 effect 头部显式 `isActive === false` 守卫 + deps 补 isActive(堵住恢复历史会话时 prompt 异步补签名致非活跃保活页发起流式翻译的时序窗口;切回活跃 effect 重跑不丢自动翻译);② `segmentation.ts` CRLF 归一(`\r\n?`→`\n`)+ 段落分隔正则改 `/\n(?:[ \t]*\n)+/`(纯空白行也算边界;纯 LF 干净空行输入切分结果与旧实现一致);③ 流桥所有权/阶段:快照新增可选 `phase`(判活跃看 phase 而非「有快照」),`publish/clear` 增可选 `ownerToken`(clear 带 token 仅当前所有者生效,修复同 key 双实例先卸载方清掉后发布者快照;无 token 保持原语义,旧调用方零改动) | `wave2-B-r4-translate-essay.md`;第 2 轮 dirty checker/save handler 原样;F2(prompt 来源显式字段)书面裁决**本轮不改**(持久化契约是字符串、内存标记制造第二真相源、legal/medical 展示模板 key 在禁改区),下一轮整体做 |
| 待办 | **helper + NL 解析先行**(smallapps T2/T3 半步):① 新增 `todo/utils/domVisibility.ts`(`isEffectivelyVisible` = 旧两套判定严格并集、`isHostWindowFocused` 原样上提),收敛刻意只做 3 处(todoShellNav 删本地实现改 import、TodoMainPanel 两处返回键守卫),其余同款守卫留待 util 上提共享层后统一收编;② `TodoRepeatRule` 新增可选 `byMonthDay/until` + parse/serialize 白名单(旧前后端自然降级)+ `repeatRuleLabel` 展示(zh/en 补 5 键);parser 支持「每月1号和15号」「every 1st and 15th」「直到/until + 日期」(until 先于日期匹配剥离,防被抢成到期日);**明确不宣称后端生效**:`compute_next_due_date` 不识别新字段,前端 `stepRepeatDate/nextRepeatOccurrence` 刻意不动,两边一致降级,推进语义对齐列为跨波项;③ `TemplateManagementApp` 补 ⌘F(workbenchWindowId 存在时让位 + 保活可见性守卫) | `wave2-B-r4-todo.md`;测试追加 9 解析 + 3 往返用例(含负例,未执行);44px/todo-tools schema/coordinator.rs 零触碰 |
| EPUB | **复核通过,零代码改动**:① `EpubPreview` 返回键守卫已正确——`isActive && isNarrow && sidebarOpen` 三重门控,隐藏保活 tab 不注册;isActive 供给链闭合(TabPanelContainer→UnifiedAppPanel→两宿主显式透传),失活仅注销 handler 不改 sidebarOpen;② `TextbookPdfViewer` 跨文档串页已修(`lastReportedPageRef` 按 `[resourcePath, filePath]` 重置),注释准确,无双重防抖 | `wave2-B-r4-epub-textbook.md`;两独占文件零 diff |

### 4.3 六份 r4 文档索引

| 文档 | 角色 | 一句话内容 |
|---|---|---|
| `wave2-B-r4-selection-toolbar-design.md` | 划词收敛-设计 | 终态裁决细化:事件通道表、逐文件删/留清单(§3.1-3.7)、待办 A/B/C、验收 V1-V10、i18n 死键候选 |
| `wave2-B-r4-review.md` | 审阅员 | 必修补丁(onQuoteToChat 接线)+ V1-V10 逐条核对 + onCreateNote 死链记账 + 并行任务越权核查(零禁改区实改) |
| `wave2-B-r4-reader-residuals.md` | 阅读器残项 | 三 helper(切档继承语义/搜索节流/viewstate GC),全部不接线不生效,接线点逐条标注 |
| `wave2-B-r4-todo.md` | 待办/模板 | domVisibility util 收敛 3 处、byMonthDay/until 解析先行、⌘F 覆盖独立模板页;「故意没做」清单 |
| `wave2-B-r4-translate-essay.md` | 翻译/作文 | isActive 守卫、分段 CRLF/空白行、流桥 phase+ownerToken;作文 isActive 收口复核通过;F2 书面缓期裁决 |
| `wave2-B-r4-epub-textbook.md` | EPUB/教材 | 纯复核零改动:EpubPreview back 守卫正确、TextbookPdfViewer 串页已修 |

### 4.4 测试源码状态(已写未跑)

- `pdfViewState.test.ts`(7 断言组)/ `pdfSearch.test.ts`(4 断言组):残项纯函数测试。
- `imageSanitize.test.ts`(新文件 140 行):导图清洗白名单/预算测试。
- `todoQuickAddParser.test.ts`(+103 行级):9 解析 + 3 往返用例,基准日 2026-06-12 与既有同范式。
- 划词域测试文本**未更新**(待办 C):`PdfSelectionActions.test.tsx` 旧「添加到聊天」用例监听 `CHAT_V2_SET_INPUT` 按新契约必红;`pdfSelectionToolbar.source.test.ts` 尚缺 onQuoteToChat 正负向闩;`selectionStudyActions.test.ts` 缺 `sendSelectionToChatInput` 两例——改写口径见设计文档 §四,与第 7 轮 lazy waitFor 化叠加。
- 以上全部为用例文本,**未执行 vitest**。

### 4.5 已验证 / 未验证(第 4 轮口径)

**已验证(静态证据 = grep 干跑 + 逐行读码 + 正则手推):**

- 审阅验收 V1/V2/V4-V7/V9/V10 通过(见 4.2 表);通道 1 全链五级转发逐点 grep 复核;共享层 `src/shared/selection` 零 diff。
- 禁改区全 diff 关键字扫描(`anki|qbank|coordinator|finder|44px`)零实改;`coordinator.rs`/src-tauri 无 diff;enhanced-pdf.css 44px 触控目标与 `pointer: coarse` 块未动;第 2 轮 TranslateWorkbench dirty checker/save handler 事务原样。
- 导图清洗两入口(剪贴板/JSON 导入)预算共享口径与 xmind 导入一致;流桥新字段/新参数全部可选,既有测试(不可写)调用签名静态核对不受影响;待办 NL 解析正则手推 5 条路径(含 2 负例)。
- EPUB 两复核项调用链逐级核对闭合。

**未验证(如实声明):**

- **未编译未跑测试**:全部新旧测试文件红绿未知;tsc 未跑;懒加载/接线/清洗/节流的运行时行为未经执行验证——第 8 轮前禁止。
- 划词行为级不变量(双工具面互不重叠、结果面板让位、Escape/Android 返回键、132px 底部避让、referenceToChat 自建会话)静态不可证,留第 8 轮实测。
- 待办 byMonthDay/until 仅解析/展示先行,滚动语义前后端均未生效(设计如此,非缺陷)。
- 流桥双实例场景、导图分屏限域滚动均为静态推演,未真机确认。

### 4.6 记账与遗留移交

1. **V3/V8 未达成(onCreateNote 死链,设计文档待办 B)**:EnhancedPdfViewer 已不解构不消费该 prop,上游 FileContentView/TextbookContentView 的 `handleCreateNote(Sync)` + `useSaveAsNoteFlow` 实例 + picker 渲染成为死重;安全拆除需同改三个视图层文件(均不在本轮可写清单),拆除清单已在审阅 §3.1 与设计文档 §3.4 备妥,拆完 V3/V8 转绿。**注意保留两视图 `handleQuoteToChat` 与 `buildSelectionLocator`(通道 1 唯一实现)**。
2. **孤儿库函数(归属第 5 轮 Agent 结合裁决)**:`sendSelectionToQuestionGeneration`、`buildQuestionGenerationPrompt`、`makeCardsFromSelection`、`MIN_SELECTION_LENGTH_FOR_QUESTIONS` 及其测试,现无 UI 调用方;第 5 轮若裁定不复用,连同 `pdf:selection.questionPrompt*/selectionEmpty/selectionTooShort` 键按死码流程处理。
3. **i18n 死键(移交 i18n 员,zh/en 同步)**:`pdf:selection.quote_to_chat/create_note/generateQuestions/makeCards`、`pdf:toolbar.translate_selection`(全仓零非 JSON 引用已复核);叠加第 3 轮遗留死键清单未复扫。
4. **导图改动补记归属**:mindmap 改动簇无对应 r4 任务文档,本节 4.2 表已据 diff 补记内容与判定;若后续交文,以其为准补索引。
5. F2(翻译 prompt 来源显式字段)按 4.2 表书面裁决整体后移;essay 草稿级持久化(2.5/3.7 遗留)继续挂账。
6. 待办守卫收敛剩余 5 处(TodoItemDetail/TodoItemRow/TagsEditor/TodoTrashDialog/TemplateManagementApp 内联守卫)待 util 上提共享层后统一收编。

### 4.7 第 5 轮派遣预告(按用户原计划)

> 共同禁令沿用:禁止编译/测试/npm/cargo/vitest;不碰 coordinator.rs、tool_loop、anki/qbank 服务层、移动 44px、finder 分桶;不 commit/push(父代理做);改码后行号重新对表。

1. **P3 handoff descriptor**:`{version, appType, resourceId, innerRoute?, savedAt}` 独立 settings key,双向消费一次即清,sanitize + 纯函数测试(第 1 轮 workbench-gap SOTA 子集 C 项);不需要合桶(finder 分桶不变量)。
2. **Agent 结合**:agentRuntime 落 act 前调用现成 `requestWakePrefetch`(零新 API);同时裁决第 4 轮孤儿库函数(出题/制卡 PREFILL 通道)复用或死码化——若复用,detail 须按 `sendSelectionToChatInput` 同款并入 page/sourceName。
3. **P10 SOTA 笔记侧**:G3 边类型分色、A7 observe 增补出链、C4 命令↔Agent 清单对齐、L4 aliases 解析层(notes-gap 4 条)。
4. **P10 SOTA PDF 侧**:S1 批注列表精确定位、S6 制卡附来源行、S2 批注汇总导出笔记、S4 来源行可回链引用(pdf-gap 4 条);与 onCreateNote 死链拆除(4.6 第 1 条)同文件项合并开刀,避免二次开文件。
5. **P10 SOTA 工作台侧**:G3 脏信号补漏(第 2 轮已消化主体,只查漏)。
6. **审阅**:对 1-5 逐行审 + 行号对表更新;i18n 死键复扫(4.6 第 3 条 + 第 2/3 轮清单)。
7. **提交**:第 5 轮收尾由父代理统一 commit/push;台账员追加「第 5 轮」节。

P9(Exposé)维持第 8 轮、测试对齐(waitFor 化 + 划词契约改写)维持第 7 轮,不提前。

---

## 第 5 轮（跨壳连续性 + Agent 结合 + SOTA 第一批）

### 5.1 执行口径

- 子代理全部 `claude-fable-5-thinking-high`；无 sol/GPT/xhigh；无 computerUse。
- 未跑编译/门禁/CI/vitest。父代理统一 commit/push。

### 5.2 产品落地

| 项 | 现状（静态） |
|---|---|
| P3 handoff descriptor | `handoffDescriptor.ts`：`{appType, resourceId, innerRoute?}` + 独立 key `desktop.workbenchHandoff`；`legacyNavigationMap.handoffWorkbenchToLegacyShell`；边界审阅补丁：mode-off 成功后、卸壳前调用落盘 |
| 经典壳→Workbench | `App.tsx` 消费 `consumeHandoffDescriptor()`，`workbenchBus.launch` / `openPdfPage`；移动平台不启 Workbench |
| Agent 结合 | `integrationManifest.ts` + `workbenchBus.openNoteAnchor` / `openPdfPage`；制卡声明只走 `cardAgent.startGeneration` |
| GenUI 只读入口 | `openResourceActionHandlers` 只派发 `DSTU_OPEN_NOTE` / `pdf-ref:open`，无写 API |
| SOTA 笔记 | 图谱边 kind 分色；快速切换结果可拖到桌面 |
| SOTA PDF | 批注精确定位/筛选/导出为笔记；pdfref 回链；拆除 onCreateNote 死链 |
| SOTA 工作台 | 最小命名桌面（独立 settings key，不进快照） |

### 5.3 已验证 / 未验证

已验证：禁改区文件名未进本轮产品 diff；GenUI 新模块无 save/create；handoff 不混入 snapshot 白名单；finder 未合桶。

未验证：未编译、未跑测试、handoff 真机 round-trip、批注回链/Spaces 重命名未实测。

### 5.4 第 6 轮预告

十名复核员按第 2–5 轮落地面逐 diff 复核（事务/冻结/关标签/保存链/书签/划词/handoff/Agent/SOTA×2），翻案当轮落地。仍禁止编译/实测。

---

## 第 6 轮（全面二检）

### 6.1 执行口径

十名复核员全部 `claude-fable-5-thinking-high`。未跑编译/测试。结论见 `docs/dev/wave2-B-r6-review.md` 与 `docs/dev/wave2-B-r6-review-close-tabs.md`。

### 6.2 当轮落地补丁

- 事务：`persistWorkbenchModeEnabled` reject 补兜底 toast（与设置页对称）。
- 冻结：exam 纳入 `canSuspend` / `resolveDirtyResourceId`（脏 exam 窗不再被冻）。
- 关标签：close gate i18n 键改用已存在的 `notesWorkspace.confirmCloseUnsaved`；LRU 淘汰同步清 splitView。
- 书签：textbook 双写失败后仍继续 DSTU `setMetadata`（与 flush 对齐）。
- 划词：行为测试改为断言 PREFILL / onQuoteToChat，不再锁 CHAT_V2_SET_INPUT。
- 保存链：头注去掉快捷助手「漏迁」表述；清若干死键。
- SOTA 笔记：补图谱图例 i18n；desktopName 热更新时序守卫。
- SOTA-PDF：无 rects 的批注排序兑现「排到页尾」。
- handoff / Agent：无产品补丁，静态通过。

### 6.3 已验证 / 未验证

已验证：读码 + grep。未验证：未编译、未跑 vitest。

### 6.4 第 7 轮预告

交互级测试源码补强（只写不跑）：dirty 取消矩阵、冻结保护、跨断点焦点、书签交错、标签移动后恢复、保存部分成功、划词单链路、handoff 双向。

## 第 7 轮（测试台账 · 只写不跑）

### 7.1 执行口径

- 本轮只产出测试源码与台账，**零产品代码改动**；未跑 vitest/tsc/编译（第 8 轮统一执行）；未 commit/push（父代理统一处置）。
- 截稿时 git status：**9 个测试文件**（3 modified：`PdfSelectionActions.test.tsx` +44/-8、`scheduler.canSuspend.test.ts` +137、`saveTextAsNote.test.ts` +41；6 untracked：`deactivation.cancel-matrix.test.ts`、`handoffDescriptor.test.ts`、`handoff.legacyRoundtrip.test.ts`、`workbenchActiveSmallScreenContract.test.ts`、`tabRestoreRebind.source.test.ts`、`tabsPersistenceWriteThrough.test.ts`，合计 926 行）+ 本台账两份 docs。

### 7.2 与 §6.4 八主题对照

七主题落档：dirty 取消矩阵（cancel-matrix，reason×拒绝源全矩阵、零副作用）、冻结保护（canSuspend 追加多 dirty 穿插记账 + exam 单资源工作区四例）、跨断点焦点（workbenchActive 源码契约钉死 `workbenchMode && !isMobilePlatform()`）、标签移动后恢复（P8 源码契约 + 探测式行为测试双档）、保存部分成功（saveTextAsNoteAndNotify 端到端 landed/error 三例）、划词单链路（单 toolbar、locator 双通道静默、PREFILL detail 整形、反空转加固）、handoff 双向（纯函数层 264 行 + 往返/落盘 143 行）。**书签交错截稿无新档**（第 3 轮已入库的 bookmarkRace/交错用例兜底；后交档则追加记账）。

### 7.3 红→绿预期

除 `tabsPersistenceWriteThrough.test.ts` 当前形态**预期整组 skip**（探测式，待第 8 轮抽出 tabsPersistence 模块后自动激活）外，其余 8 文件全部为**预期直接绿的回归钉**（被测行为已在第 2–6 轮落地）；r1 遗留的「lazy 弹层致同步断言跑红」以 `vi.mock` 模块级拦截消化，未走 waitFor 化。逐文件预期、误红风险（字符串锚/mock 形状漂移）与第 8 轮排查次序见 `docs/dev/wave2-B-r7-tests.md`。

### 7.4 第 8 轮预告

统一执行本轮 9 文件 + 第 2–5 轮全部已写未跑测试文本；红灯按「先对锚点/mock 形状，再定性产品回归」排查；P9（Exposé）与真机项（beforeunload/窄窗 compact/handoff round-trip）同轮实测。
