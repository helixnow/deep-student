# Wave2-C R9 · Draft PR #347 中文描述初稿

## Summary

本 PR 是 0824 Wave2 会话 C（mobile-uiux-unify）的独立收敛枝：以 `origin/cursor/0824-cde6` 的 `061b4815` 为基线，围绕移动端五条规范完成静态全量扫描，并按 P1–P8 分轮落地浮层所有权、触控目标、附件生命周期、面板可访问性、动态 i18n、PDF 返回键与键盘/back 契约。

当前分支 `cursor/0824-wave2-mobile-uiux-a875`，本稿取证 HEAD 为 `7e3302a1`。R8 已把 input-bar 的 `coarse-touch-target` 单目录门禁升为 `error`，并将该目录余下触控散点收敛到 `--touch-target-size` / `coarseHit`。全库其他目录仍为 `warn`，不把单目录完成误写成全库完成。

## Changes（按 P1–P8 / 轮次）

| 项 | 落地轮次 | 主要变更与边界 |
|---|---|---|
| P1 AppMenu portal 外点误杀 | R1 定位；R2 短修与机制底座；R6 生产接线 | `InputBarUI` 的焦点/外点判断共用 Composer territory，识别 `[data-app-menu-id]`；新增 owned-overlay 登记/查询，R6 将 InputBar 接入并保留 selector fail-open；AppMenu 定位补 `visualViewport`。全库其余 document 外点监听未整体迁移。 |
| P2 附件清理多所有者 | R4；R6 补残债 | 后端 PDF 取消、processing store 清理与 blob revoke 收敛到 store action，面板/chip 只委托删除；R6 将 `pdfProcessingStore.remove` 从 `resourceId` 分支提升到 `sourceId` 顶层，补齐孤儿附件路径。 |
| P3 44px 触控目标与伪元素重叠 | R3 机制下沉；R6 补 QuickLook；R8 放量 | 新增 `TouchTarget`、`coarseHit`，把 coarse 最小高宽下沉到 button primitive，工具栏/水位环改为单一实体命中所有者，并加入 lint 规则；R8 将 input-bar 规则升为 `error`，清理该目录旧 `!min-h-11` / `!h-11` / 内联 `after:-inset` 散点。全局规则仍为 `warn`。 |
| P4 coarse 被混作移动/相机能力 | R3 | 保持布局走 `isMobile`，触摸能力走 `any-pointer: coarse`，拍照入口改走平台 `canCapturePhoto`；未用 `enumerateDevices` 触发权限探测。 |
| P5 InlinePanel closing、硬下限、aria 与水位环语义 | R3–R4 | 水位环去掉 `role="img"` 并统一触发器语义；closing/closed 内容使用 inert DOM property + `aria-hidden`；160px 硬下限改为可收缩的二段 clamp；Skills/MCP region 名称改走 `t()`；补焦点顺序与源码契约。 |
| P6 动态 i18n 盲区 | R1；R5 | R1 补 sidebar `section_study` / `section_manage` 中英词条（v0.9.44 既有债）；R5 将 input-bar 契约扩为模板键枚举展开、12 文件扫描、非空字符串叶子与枚举漂移守卫，补 `thinkingDepth.minimal` 双语，并为 `check-i18n` 接入非零退出语义和 strict 命令。 |
| P7 PDF/EPUB 移动 chrome | R1 定位；R5 修 V1 | 新增 `registerVisibilityGuardedBackHandler`，由 `PdfSelectionActions` 与 `EnhancedPdfViewer` 共用可见性守卫，避免 keep-alive 隐藏实例吞 Android back；排序、优先级与兜底算法未改。V2 coarse 存量、V3 断点样板、V4 132 魔数仍未收敛。 |
| P8 键盘 inset 与 Android back 链 | R2；R5；R7 | InputBar overlay handler 对裸 Radix 浮层让行；`ShadApiEditModal` 迁到全局 `useKeyboardHeight` 并删除设置域重复 hook；补 coordinator 顺序、菜单→面板、键盘 inset、safe-area、读屏与完整交互序列契约。底座不重写。 |

分轮补充：R1 产出 9 份全域扫描；R5 同时修复 Learning Hub 子屏 chrome/QuickLook back、题库吸底动作可访问名、设置折叠钮与 BackupTab 小屏卡片视图；R6 完成 owned-overlay、附件残债和 QuickLook 触控逃生舱二检；R7 只新增交互矩阵测试源码；R8 执行定向验证并记录红灯归因。

## 已验证

### 静态证据

- `docs/dev/wave2-C-r1/01–09` 对 Composer、Learning Hub、PDF/EPUB、anki/qbank chrome、设置/数据治理、壳、overlay、键盘/back、44px 逐文件取证；P1–P8 汇总与后续翻案记录见 `docs/dev/wave2-C-ledger.md`。
- 静态链路已核对：P1 portal pointerdown→click、P2 三条附件删除路径、P7 keep-alive 可见性守卫、P8 back 优先级/同档后注册先执行、16/16 CurrentView 注册与三桶可达性。
- R8 静态结果：input-bar 旧 coarse 散点改走 token/共享 `coarseHit`；有意保留的无 coarse 前缀 44px 类与注释文本已单独登记，不混作产品残留。
- 对基线执行 `git diff --name-only origin/cursor/0824-cde6...HEAD`，禁改后端域与 workflow 未进入变更文件清单。

### R8 已跑

- `npm run version:generate && npm run typecheck`：退出码 0，typecheck 绿。
- input-bar ESLint：退出码 0，合计 **0 error / 84 warning**；其中 `ds-components/coarse-touch-target` 为 **0 error / 0 warning**。84 条是其他规则 warning，未通过放宽 workflow 消除。
- input-bar Vitest：**31 files = 26 passed / 5 failed；245 tests = 238 passed / 7 failed，0 skipped**。7 条均记录为测试探针/源码字面量未随机制更新或未等待 220ms deferred unmount；报告归因为产品回归 0，但这些用例的退出码仍是 1。
- mobile 定向 Vitest：
  - navigation：**3 files / 29 tests passed，0 failed**；
  - keyboard inset：**1 file / 18 tests passed，0 failed**；
  - shared：**5 files / 21 tests passed，0 failed**；
  - mobile-uiux：首跑 **139 passed / 1 failed**，修正过期 `after:-inset` 计数断言后复跑 **11 files / 140 tests passed**；
  - check-i18n source：**1 file / 10 tests passed，0 failed**；
  - `coarseTouchTargetRule.test.ts`：**0 tests**，测试套件在收集期因 `import.meta.url` 不是 `file:` scheme 失败。
- R8 首批附件契约单跑：`InputBarUI.mobileSplitContract.source.test.ts` **6/6 passed**。

以上是定向结果；仍有 7 条 input-bar 失败和 1 个 suite 收集期环境失败，不能据此宣称整仓验证完成。

## 未验证

- 真机四项仍留白：键盘 inset、厂商 WebView、VoiceOver/TalkBack、44px 实机命中。
- `vite build` 未跑。
- `cargo check --lib` 未跑。
- `check-migrations` 未跑。
- 未跑整仓 Vitest、完整 ESLint、Playwright 或 CI；input-bar 7 条过期探针和 coarse lint RuleTester 的收集环境问题也尚未在本枝修复。
- P1 全库外点监听迁移、P3 全局 lint 升 `error`、P7 V2/V3/V4 等后续机制债不在本 PR 已完成口径内。

## 禁改区自证

- Rust `coordinator.rs`、`tool_loop` 与后端 hooks/缓存协议未改；分支 diff 无 `.rs` 文件。前端键盘 hook 的迁移已在 P8 单列，不冒充后端禁区。
- anki/qbank 只改 chrome/可访问性：`QuestionBankManageView` 动作名与冗余 Checkbox 热区、Checkbox 基元说明；未碰 FSRS、出题、评分、store 服务层或 `save_to_library` 写回。
- WebDAV decode path、S3 endpoint normalize、FTP 白名单与备份/同步后端未改；`BackupTab` 只做展示层响应式卡片化并复用原回调。
- finder store / host buckets / `FINDER_HOST_IDS` 未改。
- Composer 桌面专属飞出层语义未改；共享 AppMenu/InputBar 影响面已在 R2 桌面通报中登记。
- `mobileShell` 未改；`androidBackCoordinator.ts` 仅加可见性守卫封装与测试，排序、优先级、Radix 兜底和 navigation fallback 未重写。
- `.github/workflows` 未改；没有为消红放宽 CI。
- 本轮只新增本描述草稿文件，未改任何既有 PR 正文。

## 与官方 0824 关系（独立枝，不合回除非用户下令）

- [Draft PR #347](https://github.com/helixnow/deep-student/pull/347) 从官方 0824 基线 `cursor/0824-cde6 @ 061b4815` 独立展开，用于 Wave2-C 扫描、机制实验、定向修复与证据归档。
- 它不是官方 0824 主枝的自然后续，也不代表官方验收结论；默认不整枝 merge、rebase 或回灌到官方 0824。
- 只有用户明确下令后，才按指定范围择取提交或合回；在此之前保持独立 review/draft 状态。
- sidebar 缺键等 v0.9.44 既有债继续按既有债归因，不改写为 0824 回归。
