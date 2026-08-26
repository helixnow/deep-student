# Wave2-E R5-07：FSRS 记忆参数只读可视化（SOTA-FSRS）

日期：2026-08-26
范围（独占）：新建 `src/features/flashcards/components/FsrsParamsPanel.tsx`；
`src/features/flashcards/screens/StatisticsScreen.tsx` 仅加 1 行 import + 1 行挂载。
不改调度逻辑、不改隐私 opt-in、不改 workbench 壳、不改 `flashcards.json`、无后端改动。

## 展示了什么

统计页新增「记忆参数（到期队列）」面板，纯只读聚合：

- **数据源**：既有命令 `fsrs_get_due`（limit=500，后端 `get_due_inner` 硬上限即 500）。
  其返回的 `FsrsDueCard` 已 `#[serde(flatten)]` 携带 `FsrsCardState` 的
  `stability: Option<f64>` / `difficulty: Option<f64>`（camelCase 序列化），
  因此**无需新增后端命令或字段**。
- **Stability 聚合**：中位 / 均值 / min~max 区间（`<1d` 展示小时，其余按天一位小数），
  外加 4 档直方图：`<1d`、`1–7d`、`7–30d`、`≥30d`。
- **Difficulty 聚合**：中位 / 均值（FSRS 定义域 [1,10]，一位小数），
  外加低（<4）/ 中（4–7）/ 高（≥7）三段计数。
- **有参数卡片计数**：`有参数 / 采样总数`，未复习过的新卡（两参数为 SQL NULL → null）
  单独脚注「另有 N 张新卡尚无参数，未计入聚合」，不编造默认值。
- **刷新**：跟随统计页既有的 `FSRS_STATS_REFRESH_EVENT` window 事件与
  `subscribeFlashcardsDueRefresh`（评分/撤销/暂停后触发），无需新增按钮。

## 诚实空态（全部不编数）

| 场景 | 展示 |
| --- | --- |
| invoke 失败 / 响应非数组（如无 Tauri 后端的 web 预览） | 「记忆参数暂不可用（需要支持 FSRS 调度的后端）」 |
| 到期队列为空 | 「当前没有到期卡片，暂无可聚合的记忆参数」 |
| 到期卡全是新卡（参数全 null） | 「共 N 张，均为未复习过的新卡，尚未产生 Stability / Difficulty」 |
| 队列打满 500 上限 | 脚注「仅统计队列前 500 张」（fsrs_get_due 的返回顺序即复习优先级） |

## 隐私

- 面板副标题固定标注「仅本地读取到期队列聚合，不上传任何数据」。
- 实现上只有一个本地 `invoke('fsrs_get_due')` 读取，无任何网络/遥测调用；
  **隐私 opt-in 相关代码与配置一概未动**。

## locale 约定

本轮 `flashcards.json` 非独占，所有文案通过 `t('stats.fsrsParams.*', { defaultValue })`
内联提供（与 `AnkiTasksApp.tsx` 的 statsLoadFailed 先例一致）。
后续若要正式落词条，把 `stats.fsrsParams.*` 迁入 zh-CN/en-US `flashcards.json`
并删掉 defaultValue 即可，key 已按最终命名设计。

## 挂载点

`StatisticsScreen.tsx` 的 `wb-fcx-stats-grid` 末尾（状态构成 donut 之后）：
`<FsrsParamsPanel />` 单行；面板自带 `wb-fcx-panel wb-fcx-span-2` 复用既有栅格与样式，
未新增 CSS。统计加载失败分支不渲染该面板（与其它数据面板一致，调度设置区不受影响）。

## 边界说明

- 聚合口径是「到期队列」而非全库：这是复习者当下要面对的卡的记忆状态，
  与统计页其余「到期/新卡」口径一致；全库参数分布需要新查询命令，超出本轮独占范围。
- `stability`/`difficulty` 单独缺一（理论上不会发生，写库时成对更新）时按缺失方各自过滤，
  计数脚注取较大缺失数，不会虚报「有参数」。
- 按本轮约束未运行测试、未提交 commit。
