# 0824 Wave2-C 第 5 轮 · 05 Chat 移动页 chrome（修复员报告）

- **角色**：R5「chrome 修复-Chat 移动」
- **模型**：claude-fable-5-thinking-high
- **worktree**：`/tmp/0824-wave2-c-r5-chat-chrome`（基线 `cf8eb9e8`）
- **约束遵守**：未执行 npm/npx/node/tsc/vitest/任何测试；未 git commit（父代理统一提交）；未触碰 InputBarUI.tsx / sessionActions / ComposerPanelOverlay 桌面语义。

---

## 一、结论：Chat 移动页 chrome 五条规范全 PASS，无独立 FAIL → 不改代码，仅补「右侧≤2」source 契约

按任务书判定分支执行：第 1 轮 Chat 面除 P1 外没有针对聊天页顶栏 chrome 的独立 FAIL。

**第 1 轮证据链**：
- `01-composer.md` 五条规范表：#1/#2/#4 符合；#3「顶栏侧不归本组件」（判给壳层，部分符合项指 ComposerToolbar 右簇，属输入栏、本轮禁区且 R3 已按机制处理）；#5 唯一例外即 P1（AppMenu portal 外点误杀）。
- P1 已在 R2 落地修复并入本基线：`e90fb360 fix: recognize AppMenu portal in composer outside-click`。
- `06-shell-nav.md` §5 对壳层五条全 ✅，唯一登记缺口正是本轮要补的：规范 #3「壳无溢出收纳机制——超限属页面责任，壳层无静态强制手段（**无契约测试计数 rightActions 子节点**），维持约定现状」。

**本轮在基线 cf8eb9e8 上对 `src/features/chat/pages/useChatPageLayout.tsx` 逐条复核**（chat-v2 顶栏唯一注册点，`useMobileHeader('chat-v2', …)` :168；全 chat 目录 grep 确认右侧动作无第二来源，`rightActions` 仅此文件 + dev playground）：

| # | 规范 | 结论 | 证据（useChatPageLayout.tsx） |
|---|---|---|---|
| 1 | 全局顶栏唯一 | **PASS** | 单一 `useMobileHeader('chat-v2', …)`（:168）；chat 目录无 `data-mobile-shell`、无自绘顶栏；资源库面包屑是 `titleNode`（:227-233）而非第二条顶栏 |
| 2 | 左侧按钮语义（主入口☰/次级后退，不双返回） | **PASS** | 四个子屏分支各 `showBackArrow: true` + 对应关闭句柄（沙箱 :170-171、资源预览 :209-210、资源库列表 :234-235、分组编辑器 :263-264）；browser 视图 back 回 sidebar（:282-287）；默认聊天 `showMenu`（:280），空态浮动 ☰（:281）；会话抽屉展开时顶栏 `hidden`（:278），避免双导航层 |
| 3 | 右侧 ≤2 个 44px 动作 | **PASS** | 逐分支计数：沙箱 2（刷新+检查器 :172-205）、资源预览 1（:213-225）、资源库列表 1（:237-257）、分组编辑器 1（保存 :266-274）、browser 1（新建 :110-126）、默认聊天 ≤2（会话设置⋯+新建 :128-156）。44px：动作全部为 DsButton，coarse 44 保底已由 R3 下沉至 `buttonPrimitiveContract` 尺寸类（`buttonPrimitiveContract.coarse.source.test.ts` 锁定） |
| 4 | 禁桌面组件滥用 | **PASS** | 文件内无 ResizablePanel/宽表/hover-only/tooltip 依赖；无桌面 portal 浮层 |
| 5 | 可达且可回退 | **PASS** | 每个子屏均有顶栏返回句柄（同 #2）；P1 外点误杀已随基线修复（e90fb360）；返回键分档归 androidBackCoordinator（06-shell-nav §3 已核） |

**刻意不做的「散点 44」**：文件内 8 处 DsButton 挂着局部 `[@media(pointer:coarse)]:!min-h-11/!h-11` 覆盖，在 R3 primitive 下沉后已属冗余（且 `!h-11` 与 `!min-h-11` 两种口径并存）。按任务书「不要散点 44」不动它们——它们无害（均 ≥44），清理属机制统一活，留给后续轮次连同全仓其余散点一起收。

## 二、产出：`tests/vitest/mobile-uiux/chatHeaderRightActionsContract.test.ts`（新增，唯一改动）

把 06-shell-nav 登记的「右侧≤2 无静态强制」缺口在 Chat 页补上 source 契约，设计与既有契约族同风格（静态读源、防空断言、机制无关）：

1. **来源入账**：`rightActions:` 出现总数 = 内联 JSX 块数（当前 4：沙箱/资源预览/资源库列表/分组编辑器，防空断言 ≥4）+ 1 次 `headerRightActions` 三元引用（正则锁定）；`headerRightActions` useMemo 内 `return (…)` 恰 2 个分支（browser/默认聊天）。新增未入账的第三来源直接红，逼迫显式纳入计数。
2. **逐分支 ≤2**：6 个动作块（4 内联 + 2 memo 分支）各静态计数 `<DsButton`，1..2 之间；超出必须收进页内「更多」菜单。
3. **44px 经载体继承**：动作区禁止非 DsButton 交互载体（裸 button/a、Button/IconButton/TouchTarget/AppMenuTrigger 全拦）；每块 `onClick=` 数 === `<DsButton` 数，拦截挂在包装节点上的隐形动作；锁定 DsButton import 路径。「≥44px」不数尺寸类名，由 buttonPrimitiveContract 的 coarse min-h/min-w 下沉契约继承——与 `touchTargetOwnership.contract.test.ts` 的「所有权而非尺寸计数」原则一致。

提取器为配平括号扫描（`extractBalancedParens`），已对当前源码逐块人工核对：`rightActions:` 总数 5=4+1、全文件 onClick 8 === DsButton 8、各块计数（2/1/1/1、1/2）全部满足断言，**该契约在基线 + 本轮零代码改动下即绿**（未执行，静态推演）。

## 三、改动清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `tests/vitest/mobile-uiux/chatHeaderRightActionsContract.test.ts` | 新增 | 「右侧≤2」source 契约（规范 #3） |

`src/features/chat/pages/useChatPageLayout.tsx` 及其余生产源零改动。与并行 R5 chrome 轮（anki/hub/pdf/settings）无文件交集（pdf-chrome 改 androidBackCoordinator/PdfSelectionActions，其余轮 worktree 无改动），无合并冲突面。
