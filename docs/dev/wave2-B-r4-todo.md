# Wave2-B 第 4 轮：待办 / 模板打磨

来源清单：`docs/0824-quality-review/todo-templates.md`（评审）+ `docs/dev/wave2-B-r1-smallapps-gap.md`（差距 T2/T3 等）。本轮按约束选了 3 项最高性价比可静态落地项，未铺开。禁 npm/vitest，改动全部为静态编写 + 人工复读，未实跑测试（见文末）。

## 做了什么

### 1. 抽 `isEffectivelyVisible` / `isHostWindowFocused` 共享 util，合并复制守卫

评审指出「三行保活守卫样板复制 9+ 处」且与 `todoShellNav.isElementVisible` 存在两套可见性判定标准（getClientRects+visibility vs offset/display/visibility 全查）。

- 新增 `src/features/todo/utils/domVisibility.ts`：
  - `isEffectivelyVisible(el)` = isConnected + getClientRects + computed visibility/display,是旧两套判定的严格并集，语义对两边均不回退;
  - `isHostWindowFocused(el)` = `closest('[data-wb-window]')` + `data-focused` 门禁（原 todoShellNav 私有实现原样上提）。
- 收敛点（本轮刻意只做 3 处）:
  - `todoShellNav.ts`:删除本地 `isElementVisible` / `isHostWindowFocused`，改 import 共享 util（热键资格判定行为不变，`todoShellNav.test.tsx` 门禁矩阵语义未动）;
  - `TodoMainPanel.tsx` 两处返回键守卫（MobileDetailOverlay 关闭 + 多选模式退出）改用 `isEffectivelyVisible`。

### 2. NL 重复解析层扩展:`byMonthDay` / `until`（smallapps-gap T2/T3 的解析先行半步）

**契约层**（`src/features/todo/types.ts`）:

- `TodoRepeatRule` 新增可选 `byMonthDay?: number[]`（monthly 专用，1-31）与 `until?: string`（YYYY-MM-DD）;
- `parseRepeatRule` 白名单放行（byMonthDay 仅 monthly、过滤非法日、去重排序;until 仅接受合法 `\d{4}-\d{2}-\d{2}`）;`serializeRepeatRule` 仅在有值时写入——旧后端 serde 忽略未知字段自然降级，旧前端白名单同样自然降级;
- `repeatRuleLabel` 新增 monthly 多日展示（`todo:repeat.monthlyOn` / `everyNMonthsOn`）与 until 后缀（`todo:repeat.withUntil`），zh/en locale 同步补 5 个键。

**解析层**（`src/features/todo/quickAddParser.ts`）:

- `每月1号和15号` / `每月1号、15号`（2 个及以上）→ `{freq:'monthly', byMonthDay:[1,15]}`，并新增 `nearestOfMonthDays` 把 dueDate 锚定到最近的选中日（与 byWeekday 锚定同范式，跳过 2 月 30 日类不存在日）;单日「每月5号」维持既有语义（普通 monthly + 日期锚定），不产生 byMonthDay;
- `every 1st and 15th`（要求序数后缀，与 `every 2 weeks` 的裸数字+单位天然互斥）→ 同上;
- `直到|截止到 + (ISO | N月N日/号)`、`until + (ISO | dec 31)` → `rule.until`。仅在已命中重复规则时匹配，且**先于日期匹配剥离**（否则「每天直到12月31日」的 12/31 会被抢成到期日）;until 片段作为第二个 `repeat` 类型 token 进入高亮/删除链路（`removeTokensOfTypes('repeat')` 一并移除，chip 文案经 `repeatRuleLabel` 已含 until 后缀），无需改 `TodoQuickAdd`。

**明确不宣称后端生效**:后端 `compute_next_due_date` 尚不识别这两个字段，前端 `stepRepeatDate` / `nextRepeatOccurrence` **刻意不动**——预览若单方面尊重 byMonthDay/until 会与实际滚动结果分叉，宁可两边一致地降级为普通 monthly/无边界。字段注释（types.ts）与 parser 头注释均已写明。推进语义对齐（前后端同改）列为跨波项。

**测试**:`tests/vitest/todoQuickAddParser.test.ts` 追加 9 个解析用例 + 3 个 serialize/parse 往返用例（含负例:单日不产生 byMonthDay、`every 2 weeks` 不误入、非法 until 丢弃、legacy payload 序列化字节不变）。

### 3. ⌘F 覆盖独立模板页

评审缺口 #3:⌘F handler 只挂在 `TemplatesAppWindow`，legacy/Anki 内嵌形态的同一工具栏没有快捷键。在 `TemplateManagementApp` 增加同款 capture 阶段 handler，门禁:

- `workbenchWindowId` 存在时整体让位（workbench 承载仍由 TemplatesAppWindow 负责，避免双重消费）;
- 保活可见性守卫（隐藏保活层不抢其他视图的 ⌘F），与本文件既有返回键守卫同款;
- 兜底:若经其他宿主间接落在 `data-wb-window` 壳内，仍要求窗口聚焦 + 事件在窗内（对齐 TemplatesAppWindow 语义）;
- 编辑视图不渲染搜索框时 `querySelector` 落空、完全放行。

## 故意没做什么

- **守卫收敛只做 3 处**:`TodoItemDetail` / `TodoItemRow` / `TagsEditor` / `TodoTrashDialog` / `TemplateManagementApp` 的同款守卫保持原样（本轮约束「合并 1–2 处、不铺开」;且 template-management 引 todo 的 util 方向不顺,该 util 未来宜上提到 workbench/共享层再统一收编——评审建议 #3 的完整形态）。TemplateManagementApp 新增的 ⌘F 守卫也因此按本文件既有内联风格写。
- **byMonthDay/until 的推进语义**（`stepRepeatDate` 与后端 `compute_next_due_date` 同步扩展）:跨波,需要动 Rust 侧,本轮禁区外但工作量与风险不匹配。
- **TodoItemDetail 的 byMonthDay/until 编辑 UI**:详情面板切频率时构造全新 rule（与 byWeekday 掉字段行为一致）,未加月内日多选器——在推进语义落地前,编辑器承诺不了它做不到的事。
- **T6 词表扩展（end of month/月底 等）、T4 改期菜单提示**:性价比排序落选,未动。
- **44px 类名、todo-tools schema、coordinator.rs**:禁区,未触碰。

## 验证情况

- 禁 npm/vitest 且环境无 node_modules,新增/修改代码未经编译与测试实跑,全部经静态逐行复读（正则手推了 每月1号和15号 / every 1st and 15th / 直到2026-09-30 / 每月15号(负例) / every 2 weeks(负例) 的匹配路径与掩码偏移）;
- 新增测试用例基于固定基准日 2026-06-12(周五),与文件既有用例同范式,待下一个可跑 vitest 的轮次统一实跑;
- `todoShellNav.test.tsx` / `TodoMainPanel.test.tsx` 未改动,共享 util 的语义为旧实现严格并集,预期不破坏既有门禁矩阵断言。
