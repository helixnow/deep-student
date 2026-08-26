# 0824 Wave2 会话 C · 第 9 轮风险清单

- 取证时点：2026-08-26（UTC），分支 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `7e3302a1`
- 口径：静态读码 + 已归档 vitest/lint 记录（r8 三份实测补记）+ `gh issue view`；本轮未跑新测试、未真机
- 取证时观察到同轮他席位并发在途未提交改动：`docs/dev/wave2-C-r9-hard-gates.md`（新增）、`docs/dev/mobile-uiux-unify/PROGRESS.md`/`README.md`（追加）、`src/shared/notes/useSaveAsNoteFlow.tsx` + 2 个测试文件（见「中-1」）。本清单对在途改动只记「在修」，一律不当已验证
- 本文档只登记，不改产品代码，不 commit

---

## 高风险

### 高-1 `closest('[data-app-menu-id]')` 过宽 fail-open（owned-overlay 已接线但仍双轨）

- **现状**：R6 已把 InputBarUI 外点谓词接上 owned-overlay 注册表——面板开时 `registerOwnedOverlay({ ownerId: COMPOSER_OVERLAY_OWNER_ID, selector })`（InputBarUI.tsx:1074-1080），谓词查 `isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)`（:1095）。但同一谓词里保留了第二轨：`node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)`（:1096，selector 即 `'[data-app-menu-id]'`，:116 常量），**不限定 menuId、不限定 owner**。AppMenu 侧按实例登记（`[data-app-menu-id="${menuId}"]`，AppMenu.tsx:367-371）的精确通道只在传了 `overlayOwnerId` 时生效，**默认不登记**（AppMenu.tsx:86-87），所以精确轨当前基本吃不到流量，实际防线仍是过宽的 closest。
- **触发条件**：Composer 任一面板打开时，用户 pointerdown 落在页面上**任意** `[data-app-menu-id]` portal 内——包括完全不属于 Composer 的其他 AppMenu 实例（sidebar、learning-hub 上下文菜单等恰与面板同屏时）。
- **用户可见后果**：该次点击被判为「面板内」，外点关闭不触发——用户点了别处的菜单，输入面板赖着不收。方向是误保护（面板滞留），不是误杀（动作丢失，那是 P1 原病，已被豁免方向覆盖），不丢数据，但违背「点外面就该关」的直觉。另有测试面代价：R8 实跑中旧 source 契约仍钉内联 closest 字面量（`InputBarUI.appMenuOutsideClick.pointer.test.tsx` 1 条红，r8-vitest-input-bar #6），锚点已漂移。
- **缓解 / 不修理由**：fail-open 是登记过的有意兜底——无 Provider 时 `registerOwnedOverlay` 为 noop、`isOwnedOverlayTarget` 恒 false（OverlayCoordinator.tsx fail-empty 语义），删掉 closest 会在无 Provider 树里直接退回 P1 误杀，比过宽豁免更糟。收窄前置条件：AppMenu 全消费点（约 60 处）带 `overlayOwnerId` 登记、28 处外点监听迁移完毕，才能把 closest 从谓词里摘除。双轨期风险接受，登记待 owned-overlay 全量接线轮收口；漂移的 source 契约归测试席位修锚点，不改产品。

### 高-2 全库 `coarse-touch-target` 仍 warn，input-bar 外散点可回流

- **现状**：`ds-components/coarse-touch-target` 全局 `warn`（eslint.config.js:123），仅 `src/features/chat/components/input-bar/**` 单目录升 `error`（:177）；`src/components/ui/**`（体系本体）与测试文件整目录 `off`（:166/:227）。`npm run lint` = `eslint src/`，**无 `--max-warnings`**（package.json:62），warn 不红不阻断。
- **触发条件**：任何人在 input-bar 之外的目录新增 `[@media(pointer:coarse)]:!min-h-11` 散点覆盖或裸 `after:-inset` 扩区——lint 只出警告，CI 照绿。存量基数 ~4000 处（r1-09 统计口径）本身也无人盯收敛。
- **用户可见后果**：触控目标 44px 保证再度碎片化：回流的散点绕开 `DsButton` coarse 下沉 / `TouchTarget` / `coarseHit` 机制出口，触屏用户重新遇到 <44px 难点按的控件，且回归无门禁信号，只能靠下一次人工扫描发现。
- **缓解 / 不修理由**：R8 已验证「单目录放量」样板可行（input-bar 升 error 后实测 0 error，r8-redlight）。不立即全局升 error 的理由：存量散点未清（批 4 codemod 未做），一次性升级会红一片、逼出大规模「为绿而改」；白名单 40 行也未复审。既定路线是按目录逐步放量（eslint.config.js:121-122 注释已写明），本轮维持 warn 是节奏选择而非遗忘。第 9 轮首位欠账已在台账登记。

### 高-3 issue #122「聊天出现乱码」仍 OPEN——不要记账已修

- **现状**：`gh issue view 122` 本轮取证：`state: OPEN`，标题「聊天出现乱码」，最后更新 2026-07-17。Wave2-C 全部 9 轮 diff 集中在移动 chrome / 触控 / 浮层 / i18n 键，未触及流式解码、消息渲染纠错等可能的乱码归因面。
- **触发条件**：按 issue 原报口径（聊天内容出现乱码）；具体复现条件本波未复核、未归因。
- **用户可见后果**：聊天正文显示乱码，核心阅读功能受损——从用户视角这是本清单里最直接的可见伤害，且当前无 owner、无修复在途。
- **缓解 / 不修理由**：不在 Wave2-C（移动 UI/UX 统一）范围，强行顺手修会越界进入禁改的消息流式/后端面。真正的风险是**记账污染**：本波 input-bar 有大量 diff，收尾汇总时极易被误写成「顺手修了乱码」——明确禁止：该 issue 状态以 GitHub 为准（OPEN），任何台账/汇报不得标已修。待独立会话归因（疑向后端流式或编码层，非 chrome 层）。

---

## 中风险

### 中-1 Hub「保存为笔记」子屏 chrome 丢失——他席位本轮**在修**，不当已验证

- **现状**：R6 08-chrome §A 定级中危 UX 回归：小屏 learning-hub 右屏 PDF/教材划词「保存为笔记」→ `SaveAsNoteFolderPicker` inline fixed 全屏承载落在移动分支 Provider 树内，`hosted=true` 隐藏了自绘「返回 + 标题」行，但注册的 `screen:'center'` 与右屏不匹配、统一顶栏不接管且被 fixed 层盖住——净效果是该子屏顶部无标题无返回行。R7/R8 挂账未修。**本轮取证时观察到他席位在途未提交 diff**：`useSaveAsNoteFlow.tsx` inline 分支包 `MobileSubviewChromeProvider value={null}` 切断顶栏通道、恢复自绘返回行（即 R6 建议的隔离方向），附测试更新。
- **触发条件**：小屏 learning-hub 内打开 PDF/教材 → 划词 → 保存为笔记。
- **用户可见后果**：文件夹选择子屏无顶部标题、无返回行；非死路（Android 返回键的本地 registerBackHandler 保留、底部取消/确认条仍在），但触屏用户找不到显式退出入口。
- **缓解 / 不修理由**：修复**在修**——在途 diff 方向与 R6 裁决一致，但截至本文档时点未 commit、未跑测试、未真机，**状态按「在修」登记，本清单不将其记为已修/已验证**。若该席位本轮未落盘，此项原样滚入第 10 轮首位欠账。

### 中-2 `useDeferredOpen` 220ms 退场与 back 序列测试探针失配（假红噪声）

- **现状**：`useDeferredOpen(open, delay = 220)`（InputBarUI.tsx:145）在面板关闭后保留 DOM 节点 220ms 做退场动画（`data-panel-motion="closing"`）。R8 首次实跑 R7「只写不跑」的 `InputBarUI.androidBack.sequence.test.tsx`，2 条用例红：探针用 DOM 存在性（`querySelector('[data-composer-panel-inline="attachment"]') !== null`）判面板开合，`act()` 返回瞬间节点必然还在（r8-vitest-input-bar #4-5）。产品链路本身正常：back 被消费、`closeAllPanels()` 状态翻转、层级断言全绿。
- **触发条件**：跑 input-bar 测试族即稳定复现；泛化条件是任何用 DOM 存在性探测「带退场动画的面板」开合状态的测试。
- **用户可见后果**：对用户无直接后果。风险在工程面：7 条假红与未来真回归混在同一片红里，红灯失去信息量；更坏的方向是有人为了绿去改产品——砍 deferred unmount 会让面板收起从动画退场变成硬闪断。
- **缓解 / 不修理由**：修法已明确且廉价——探针改看 `data-panel-motion`（open/opening）或 fake timers 推进 220ms，只改测试不碰产品。R8 未修是因该文件不在当轮允许改动范围（非「锁旧 !min-h-11 字面量」情形）。登记给测试席位；**220ms 本体不动**，它是面板动画契约的一部分（ComposerInlinePanel.tsx:83 注释与 fallback 兜底对其有依赖）。

### 中-3 BlockingApprovalBar 仍用 `pointer: coarse` 判折叠密度（R6 登记未迁）

- **现状**：BlockingApprovalBar.tsx:68 `useMediaQuery('(pointer: coarse)')` 决定 runtime scope 徽章墙是否默认折叠为一行摘要。R3 首次登记、R6 05-capability 复核确认：按 P4 收敛后的契约，触摸语义应迁 `TOUCH_CAPABILITY_MEDIA_QUERY`（any-pointer: coarse），至今未迁。
- **触发条件**：主指针 fine 但具备触摸的设备（触屏笔记本、带键鼠的平板）上，agent 审批场景携带 10+ 行 scope 徽章墙。`pointer: coarse` 为 false → 徽章墙不折叠。
- **用户可见后果**：徽章墙全展开把审批/拒绝按钮推出视口，触摸用户要长滚动才能到达审批操作——这是**阻塞型**审批条（agent 停等用户），比一般布局问题权重高；但只影响到达成本，不丢功能，且仅命中混合输入设备这一窄面。
- **缓解 / 不修理由**：R6 席位只有注释权限，改查询字符串是行为变更故当轮不修（有据偏离）；此后各轮该文件不在任何卡的独占范围。继续挂账：一行级替换（`(pointer: coarse)` → `TOUCH_CAPABILITY_MEDIA_QUERY`），待 input-bar/审批条席位领走，随手带 r8-redlight 登记的同文件 5 处 no-arbitrary-font-size warn 一并看。

### 中-4 桌面通报 B：窄窗附件「更多」菜单语义、DockItem 外点监听

- **现状**：两项 R2 起移交 B 组（桌面波）的遗留，C 组按禁改区约束不动桌面专属语义。
  - **窄窗附件更多菜单**：附件面板「更多」AppMenu 只在移动分支渲染，宽屏桌面无此入口；窄桌面窗口命中 isMobile 断点后会走移动分支拿到该菜单。共享层修复（外点豁免、owned-overlay、清理单一所有者）自动覆盖窄桌面窗口，但**桌面语义（hover/键盘导航/窄窗菜单行为）B 组是否已验，C 组无证据**。
  - **DockItem**：外点关闭仍是裸 `wrapRef.contains` 的 document pointerdown（DockItem.tsx:270-277），不认 `data-app-menu-id` 也未接 owned-overlay——与 P1 同构的隐患模式。
- **触发条件**：前者——桌面用户把窗口拖窄至移动断点后使用附件更多菜单；后者——当前弹层内容不 portal，**尚无实际受害者**，触发条件是未来有人往 Dock 窗口列表弹层里嵌 portal 浮层。
- **用户可见后果**：前者若 B 未验，窄窗桌面用户可能残留与 P1 同构的菜单动作丢失/面板误关；后者当前零症状，纯结构债。
- **缓解 / 不修理由**：风险处置方式是**转移登记**而非本波修复——R2 已书面通报 B 组，C 组禁触桌面回归面。DockItem 维持低危观察：若 B 组接 owned-overlay 全量迁移，此处是 28 处外点监听清单内的一项，随大盘走。

---

## 低风险

### 低-1 不变量 13–15 未碰（WebDAV / S3 / FTP）——守界声明

- **现状**：本枝对基线 `origin/cursor/0824-cde6` 的全量 diff 中 `src-tauri/` 零改动（git diff --stat 核验，158 个变更文件全在前端与文档）；WebDAV decode_path、S3 normalize_endpoint、FTP 白名单三条不变量对应代码未被触及。R5 BackupTab 卡片化只动展示层，SyncTab「不改引擎」注释边界保持。
- **触发条件**：无——未触碰即无新增触发面。前瞻性风险仅一条：后续宽表批次（SyncTab/AuditTab/OverviewTab 卡片化顺延项）若越出展示层会破坏同步/备份路径。
- **用户可见后果**：本波无新增。若未来越界，后果是同步/备份数据通路损坏（远高于 UI 债），故此条留在清单里做闸门而非事后追责。
- **缓解 / 不修理由**：无需修，需守。每轮禁改区自检保持「src-tauri 零 diff + 三关键函数 rg 零命中」双证据；宽表后续批次任务卡必须原样携带禁区条款。

### 低-2 MCP 空策略全放行——v0.9.44 既有设计，不修

- **现状**：`load_mcp_tool_policy` 三态语义明写「advertise_all = false 且白名单为空 → 全放行（保持既有默认，不能突然禁掉用户工具）」（helpers.rs:216-219）；`is_mcp_tool_allowed_by_policy` 空白名单 = 全放行、黑名单 deny-first 始终生效（helpers.rs:253-262）。这是 v0.9.44 既有行为，非 0824 回归，也不在 Wave2-C 范围。
- **触发条件**：用户从未配置 `mcp.tools.whitelist`（绝大多数默认用户）→ 已连接 MCP 服务器的全部工具广告给模型。
- **用户可见后果**：模型可见/可请求任意已连 MCP 工具。实际执行仍有后续闸门：execution policy 白名单按源隔离（tool_policy.rs，空列表拦业务工具、builtin 条目不跨源放行 MCP 同名工具）、审批链（BlockingApprovalBar）在高危动作前停等。净暴露 = 「广告面全开」而非「执行面全开」。
- **缓解 / 不修理由**：**不修**。注释已言明设计意图——收紧默认会突然禁掉存量用户的工具，属破坏性行为变更，须走产品决策而非 UI 波顺手改。现有缓解（黑名单 deny-first、执行白名单源隔离、审批链）覆盖执行面。本清单登记以防后续轮次误当漏洞「顺手收紧」。

---

## 边界声明

- 本文档为登记性产出：未改产品代码、未跑测试、未真机、未 commit / push。
- 「在修」条目（中-1）以他席位落盘 commit 为准转移状态，本清单不预支。
- 不标注 Goal complete。
