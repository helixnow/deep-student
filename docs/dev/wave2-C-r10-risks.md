# 0824 Wave2 会话 C · 第 10 轮风险清单（r9 续册，只追加）

- 取证时点：2026-08-26（UTC），分支 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `fe8ff43c`（r9 已随该提交落盘）
- 口径：静态 grep 复核 + `rustc --version` + `gh issue view` + 已归档 r9 文档；本轮未跑任何测试/构建、未真机、未 computerUse
- **与 r9 的关系**：本文件是 `docs/dev/wave2-C-r9-risks.md` 的追加续册。旧条的「现状 / 触发条件 / 用户可见后果 / 缓解与不修理由」四段正文**以 r9 原文为准，本文不改写、不复述**；本文只登记两类内容：①仍开条目在 R10 时点的复核证据与去向，②R9 已收条目的收口证据。r9 未列入编号清单、但由 r9 专项文档承载的三项（cargo 环境、RuleTester ESLint 9、真机六项）本轮提升为正式清单条目。
- 取证时观察到工作树有同轮他席位在途未提交改动：`docs/dev/wave2-C-ledger.md`（追加）；本文收尾时点又观察到 `tests/vitest/coarseTouchTargetRule.test.ts`（在修，关联 R10-4）与 4 份 r10 文档（five-norms / pr-final / review-i18n / review-system）落入工作树。本清单对在途改动只记「在修」，一律不当已验证。
- 本文档只登记，不改产品代码，不 commit。

---

## 仍开（9 条）

### R10-1 `closest('[data-app-menu-id]')` 过宽 fail-open（承 r9 高-1，原文不改写）

- **R10 复核**：双轨原样——`COMPOSER_OWNED_OVERLAY_SELECTOR = '[data-app-menu-id]'`（InputBarUI.tsx:116），谓词内 `isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)`（:1095）与不限 owner 的 `node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)`（:1096）并存；面板开时按 selector 登记（:1078）。AppMenu 默认仍不带 `overlayOwnerId` 登记，精确轨照旧吃不到流量。
- **状态**：仍开，风险接受不变。收窄前置条件未推进（约 60 处 AppMenu 消费点带 owner 登记、28 处外点监听迁移），登记待 owned-overlay 全量接线轮收口。r9 高-1 里提到的钉内联字面量的 source 契约红已随 R9 过期探针修绿销案（见「R9 已收-2」），本条的测试面代价段落就此终结，机制面风险照旧。

### R10-2 全库 `coarse-touch-target` 仍 warn（承 r9 高-2，原文不改写）

- **R10 复核**：eslint.config.js 严重级矩阵零变化——全局 `warn`（:123），`src/components/ui/**` 体系本体 `off`（:166），`src/features/chat/components/input-bar/**` 单目录 `error`（:177），测试文件 `off`（:227）；`npm run lint` 仍无 `--max-warnings`。
- **状态**：仍开。按目录放量路线（:121-122 注释）未走出第二个目录；批 4 codemod 清存量、40 行白名单复审均未启动。input-bar 外散点回流仍无门禁信号。注意与 R10-4 的耦合：规则单测在 ESLint 9 下红着（见下），全局升 error 前该单测必须先能跑绿，否则规则本身的行为无回归保障。

### R10-3 cargo 环境红：rustc 1.83.0 ≠ 1.98.0（自 r9-hard-gates 提升为清单条目）

- **现状（登记口径）**：本轮实测 `rustc --version` = `rustc 1.83.0 (90b35a623 2024-11-26)`，与硬门禁要求的 1.98.0 不符，`cargo check --manifest-path src-tauri/Cargo.toml --lib` 连续两轮（R9 席位 + 父代理补跑）按「版本不对则停」约束未执行。vite build（退出码 0，约 67s）与 migrations（退出码 0，111 个迁移文件）已由父代理补跑转绿，四项门禁仅剩 cargo 一项环境红。
- **后果与边界**：`src-tauri/` 在本波虽零 diff（r9 低-1 守界证据），但「Rust 侧编译从未在本波环境验证」这一事实必须随 PR 汇报，不得把 cargo 缺席写成通过。
- **去向**：不在席位权限内自装 toolchain（既有约束：不为变绿改环境/workflow）。待环境侧提供 rustc 1.98.0 后补跑一次即可销案；在此之前每轮只复核版本号、不空转重试。

### R10-4 RuleTester/ESLint 9 配置匹配失败：`coarseTouchTargetRule.test.ts` 2/34（自 r9-lint-loader 提升为清单条目）

- **现状（登记口径）**：R9 已修掉收集期死锁——allowlist 加载在非 `file:` URL 下走 `import.meta.dirname` 回退 + 失败降级空白名单（eslint-rules/coarse-touch-target.js:68-73，已随 `fe8ff43c` 落盘），`TypeError: The URL must be of scheme file` 不再出现，34 条用例可收集执行。但执行结果 `2 passed / 32 failed`：`Linter.verify` 对每个 `.tsx` filename 返回 `No matching configuration found for ...`，消息无 `ruleId/messageId`，规则断言全体落空。环境为 ESLint `9.39.4`（`package.json` 范围 `^9.18.0`）。
- **后果**：`coarse-touch-target` 规则本体（匹配语义、白名单命中）当前零可运行回归——lint 门禁在产线跑（R8 input-bar 实测 0 error 证明 flat config 下规则本身工作），但对规则的改动没有单测护栏。这也是 R10-2 全局升 error 的前置欠账。
- **去向**：测试侧修复——ESLint 9 的 `Linter.verify` 需要给出能匹配 `.tsx` 的 flat config（languageOptions/files 显式传入）或改用 `RuleTester` 9 式配置。只改测试不碰规则与产线 config。R9 按当轮指令停在取证处；本文收尾时点观察到同轮他席位对该测试文件有在途未提交 diff，状态按「在修」登记，未落盘未跑绿前本条不销案。

### R10-5 真机六项全体留白（自 r9-device-blank 提升为清单条目）

- **现状（登记口径）**：六项——①键盘 inset 双端（useKeyboardHeight 公式仅 18 条源码文本契约）；②厂商 WebView（仓内零厂商特判，小米/华为/Samsung 手势条与 `env(safe-area-inset-bottom)` 常返 0 无兜底）；③VoiceOver/TalkBack（inert/水位环 button 语义/region t() 标签全是 DOM 属性断言）；④44px 实机命中（类名文本断言 + lint 0 error，边界点按/overflow 裁剪/相邻抢点未测）；⑤AppMenu portal 外点 + 附件更多菜单动作真达（P1，jsdom 合成 pointerdown ≠ 真机 tap 完整事件链）；⑥Android back 原生桥（MainActivity→evaluateJavascript→moveTaskToBack 全在 jsdom 之外）。逐项静态证据与真机步骤清单见 `wave2-C-r9-device-blank.md`，本文不复述。
- **本轮增量**：R9 收口的 Hub「保存为笔记」隔离（见「R9 已收-1」）其真机目视验证并入本条口径——静态与 jsdom 证据已闭环，真机置信仍为 0。
- **去向**：Cloud 环境无真机，本波所有轮次均无法自消。持续登记，PR「未验证」栏必须原样携带 r9-device-blank 附录的可粘贴段。任何一轮不得因 jsdom 绿把六项中任一项写成已验证。

### R10-6 BlockingApprovalBar 仍用 `pointer: coarse` 判折叠密度（承 r9 中-3，原文不改写）

- **R10 复核**：`src/features/chat/components/input-bar/BlockingApprovalBar.tsx:68` 仍为 `useMediaQuery('(pointer: coarse)')`，未迁 `TOUCH_CAPABILITY_MEDIA_QUERY`。R3 首登、R6 复核确认，至今第 4 次滚动挂账。
- **状态**：仍开。一行级替换，混合输入设备（触屏笔记本/带键鼠平板）上阻塞型审批条的徽章墙不折叠问题照旧。该文件在 input-bar 目录内（coarse-touch-target 已 error 且 0 error），但本条是 JS 媒体查询语义问题，lint 管不到；同文件 r8-redlight 登记的 5 处 no-arbitrary-font-size warn 一并待同一席位领走。

### R10-7 桌面通报 B：窄窗附件「更多」菜单语义、DockItem 外点监听（承 r9 中-4，原文不改写）

- **R10 复核**：DockItem.tsx:273-276 仍是裸 `wrapRef.current?.contains` 的 document pointerdown，不认 `data-app-menu-id` 也未接 owned-overlay；B 组对窄桌面窗口附件菜单语义（hover/键盘导航）的验证结果 C 组至今无证据。
- **状态**：仍开，处置方式仍是转移登记——C 组禁触桌面回归面，不在本波修。DockItem 维持「零实际受害者」的结构债观察级，随 owned-overlay 28 处大盘走。

### R10-8 issue #122「聊天出现乱码」仍 OPEN（承 r9 高-3，原文不改写）

- **R10 复核**：本轮 `gh issue view 122` 重新取证——`state: OPEN`，标题「聊天出现乱码」，最后更新 2026-07-17T03:46:26Z（与 R9 时点一致，无新动态）。R10 时点全部 diff 仍未触及流式解码/消息渲染面。
- **状态**：仍开，且记账红线不变：该 issue 状态以 GitHub 为准，Wave2-C 任何台账/PR/汇报**不得**写成已修或顺手修。待独立会话归因。

### R10-9 MCP 空策略全放行——既有设计，继续不修（承 r9 低-2，原文不改写）

- **R10 复核**：helpers.rs:214-219 三态语义注释与实现原样（`advertise_all = false 且白名单为空 → 全放行`），黑名单 deny-first、执行白名单源隔离、审批链三道执行面缓解不变。
- **状态**：不修，登记目的仍是防误改——收紧默认属破坏性行为变更须走产品决策，禁止后续轮次当漏洞顺手收紧。本条与 R10-3 同理由留在清单：src-tauri 侧任何「顺手改」都越界。

---

## R9 已收（2 条）

### R9 已收-1 Hub「保存为笔记」子屏 chrome 隔离（r9 中-1 → 静态收口，真机未验）

- **收口证据**：`fe8ff43c` 落盘——`SaveAsNoteFolderPicker` inline 分支外包 `MobileSubviewChromeProvider value={null}` 切断顶栏通道、恢复自绘返回行；桌面 Dialog 分支不包；`FolderPickerDialog` 的 `screen:'center'` 与 F2 中屏真接管链路零改动。行为测试 8/8 绿、回归 5 文件 31/31 绿、`typecheck:native` 绿、两改动文件 eslint 0 error（明细 `wave2-C-r9-hub-save-as-note.md`）。
- **状态迁移**：r9 中-1 的「在修」预警解除，静态与 jsdom 口径**已收**。真机目视（小屏 learning-hub 右屏划词链路）仍留白，已并入 R10-5 真机六项口径，不在本条重复挂账。

### R9 已收-2 7 条过期探针修绿（r9 中-2 → 已收）

- **收口证据**：R8 判定的 7 条「测试未随机制更新」假红（`cancelAttachmentProcessing` 包装、注释 `after:-inset` 计数、`useDeferredOpen` 220ms DOM 存在性探针、owned-overlay 常量锚点漂移、`enumerateDevices` 注释误伤）已全部改测试跟上机制：探针改看 `data-panel-motion`、字面量提取剥离注释、锚点放宽 deps。定向 5 文件 `35 passed (35)`、退出码 0（明细 `wave2-C-r9-stale-tests.md`）。只改 5 个测试文件，零产品改动。
- **状态迁移**：r9 中-2 整条销案；`useDeferredOpen` 220ms 本体一如既往不动（面板动画契约）。r9 高-1 内引用的同族契约红一并终结（见 R10-1）。

---

## 未列入条目的存量声明

- r9 低-1（WebDAV / S3 / FTP 不变量 13–15 守界声明）性质为「无需修，需守」的常设闸门，不随轮次开合，本文不重复展开：R10 时点 `src-tauri/` 仍零 diff，声明原文与双证据口径（src-tauri 零 diff + 三关键函数 rg 零命中）以 r9 原文为准继续有效。

## 边界声明

- 本文档为登记性产出：未改产品代码、未改测试、未跑测试/构建（仅 grep、`rustc --version`、`gh issue view` 取证）、未真机、未 commit / push。
- 「仍开」条目的旧正文以 r9 文档为准；本文只追加 R10 时点状态，若与 r9 冲突以本文的复核证据为准、以 r9 的四段正文为背景。
- 不标注 Goal complete。
