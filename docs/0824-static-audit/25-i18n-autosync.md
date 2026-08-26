model=claude-fable-5-thinking-xhigh

# 25 — Step 20/21 深挖：rel-i18n × auto-sync 水合恢复 × `common:more` vs `actions.more` 收敛裁决

- 审计方式：只读检查当前工作树与 `docs/0824-MERGE-PLAN.md` 记录；未执行任何
  Git/GitHub 操作；未运行 vitest（避免写缓存），改用只读 node 单行脚本
  **静态复算**相关契约测试的核心断言（脚本不写任何文件）。
- 审计问题：
  1. Step 20 A 组（rel-i18n #318）的 5 个 cherry-pick（`01ed64bf` /
     `a4057892` / `5f80e9a0` / `65a53f3d` / `705a05f4`，见
     `docs/0824-MERGE-PLAN.md:910-915`）在当前树是否逐项在位、无回退；
  2. 其中 auto-sync 旧存储水合安全恢复（`a4057892`）的实现与测试是否闭环，
     且未破坏 R07/R11 的 fail-close 安全底线；
  3. Step 21（rel-mobile #324，`docs/0824-MERGE-PLAN.md:965-1005`）落地后，
     `be53b8ba` 对 `common:more` vs `common:actions.more` 竞争性修复的收敛
     裁决是否仍是树上真相，双锁契约是否互斥。

## 一、Step 20 A 组五提交逐项核对

### 1.1 `01ed64bf`：release 升级提示复用已翻译 key（13 个 REUSE_CASES）

`src/__tests__/releaseUpgradeI18n.test.ts:11-112` 定义 13 组
「source 文件 × 必用 keys × 禁用 removedKeys」用例；`:132-147` 断言组件
引用新 key 且双语可解析，`:149-156` 断言组件源码不再出现死 key，
`:158-179` 单独锁定 mindmap 两个 count 键的 locale 差异复数形态
（en 用 `_one`/`_other`，zh 用单键）。

本轮用只读 node 脚本逐条重放三个用例，结果全绿：

- 13 组用例全部成立：每个 source 都包含新 key、zh-CN/en-US 均解析为非空
  字符串、removedKeys 在对应 source 中零出现；
- mindmap 复数形态：`en-US/mindmap.json` 的
  `shellV2.versions.nodeCount_one/_other`、
  `import.imagePlaceholderNote_one/_other` 均为 string，zh-CN 两个单键在位；
  `VersionHistoryPanel.tsx` 与 `importers.ts` 的 defaultValue 正则均命中。

关键消费点抽查（与测试声明一致）：

- `src/components/ModernSidebar.tsx:1778-1779` 用
  `sidebar:navigation.hide/show_workbench_mode`；旧
  `sidebar:actions.hide/show_workbench_mode` 在两份 locale 中均为
  undefined（死键词条已移除，与「组件+词条一起清」的方向一致）；
- `src/features/notes/components/NotesEditorHeader.tsx:406` 用
  `notes:notifications.tagStateSaveFailed`（zh「标签状态保存失败」/
  en "Failed to save tag state"），对应 `65a53f3d`；
- `src/features/notes/components/FindReplacePanel.tsx:129` 用
  `notes:findReplace.replaceMany`，对应 `705a05f4`；
- `src/dstu/hooks/useDstuResource.ts:111-116` 与
  `src/features/learning-hub/apps/UnifiedAppPanel.tsx:221` 用
  `dstu:resource.getResource`，且各自带独立 i18n 微测试
  （`useDstuResource.i18n.test.ts:32,42`、
  `UnifiedAppPanel.load.i18n.test.ts:24`）。

**全树反查**（比测试更强的一步）：13 组 removedKeys 拼成正则在 `src/`
全树搜索（排除 `src/locales/**` 与测试文件），产品代码引用为 **0 处**。
releaseUpgradeI18n 只守卫表内列出的 source 文件，本反查确认没有其他文件
偷用这些死 key，测试守卫面没有盲区。

### 1.2 `a4057892`：auto-sync 旧存储水合安全恢复（本节主深挖点之一）

问题背景（`src/stores/syncStatusStore.ts:384-389` 注释自述）：zustand
默认 JSON storage 会让 `JSON.parse` 异常直接打断水合——损坏的
`dstu-auto-sync` localStorage 负载会导致 `hasHydrated()` 永远为 false，
且每次启动重复同一失败。修复是三层防线：

1. **存储边界丢弃不可读 envelope**：
   `syncStatusStore.ts:390-438` 的 `createAutoSyncPersistStorage`，
   `getItem`（`:408-428`）对 `JSON.parse` 失败、非对象、缺 `state` 字段的
   负载执行 `removeItem` 并返回 null，让默认值正常完成水合；`setItem` /
   `removeItem`（`:429-437`）对存储后端不可用均 best-effort 吞错；
   `window` 缺失或 `localStorage` 访问抛错时返回 undefined（`:392-397`）。
2. **migrate 净化**：`:361-382` 的 `migrateAutoSyncPersisted` 对任意输入
   逐字段白名单校验——`enabled` 必须严格 `=== true`，`intervalPreset`
   限定三档否则回退 `15m`，`lastOutcome` 限定五值枚举（`:349-355`）否则
   null，`lastRunAtMs` 必须为有限非负数。persist 配置 `version: 2`
   （`:464`），v1 只有 `enabled`（`:343` 注释），旧版负载走此 migrate。
3. **merge 兜底**：`:473-476` 的 `merge` 对 persisted 再过一遍同一净化
   函数——覆盖「version 已是 2 但字段被手工/异常写坏」的场景（zustand
   同版本不调 migrate，此兜底必要）。`partialize`（`:466-471`）白名单
   四字段，`consecutiveFailures` 运行时状态不落盘。

测试闭环（`src/stores/__tests__/autoSyncStore.test.ts`）：

- `:381-395`：写入残缺 JSON `'{"state":'` → `rehydrate()` 后
  `hasHydrated()===true`、状态回默认值、坏负载已被 `removeItem`；
- `:397-416`：version 2 envelope 携带
  `enabled:'true'（字符串）/intervalPreset:'daily'/lastOutcome:'unknown'/lastRunAtMs:-1`
  → 四字段全部净化回默认；
- `:356-379`：默认关闭 + 持久化白名单精确等于四字段。

**安全底线未被触碰**：`performAutoSyncOnce`（`syncStatusStore.ts:280-324`）
仍保持无配置/缺凭据/凭据查询失败 fail-close（`:283-297`）、与手动入口
全局锁互斥（`:300-302`）、断层预检 fail-close（`:306-307`）；
`classifyAutoSyncSkip`（`:140-151`）按 租约→互斥忙→半配置 顺序静默跳过；
开关默认关闭（`:443`）；退避封顶取 `max(maxBackoffMs, intervalMs)`
（`:207-216`），长档位失败重试不会比常规轮询更频繁。对应调度器/防线
测试在 `autoSyncStore.test.ts:63-343` 全套在位。

说明：此提交虽在「i18n 组」rel 枝（#318）内，实为 release 升级健壮性修复
（v0.9.44 → 0824 携带旧 localStorage 升级的水合路径），与该枝
「release 升级回归」主题一致，归组不构成问题。

auto-sync 的 i18n 消费面同步核对：`SyncSettingsSection.tsx:124` 与
`SyncTab.tsx:173` 挂载时调 `ensureAutoSyncSchedulerStarted`；两入口引用的
`sync:autoSync.*` 全部 14 键（label/description/intervalLabel/interval.15m·1h·6h/
outcome 五态/lastRun/neverRan/consecutiveFailures）经脚本核验在 zh-CN 与
en-US 均解析为非空字符串，五个 outcome 枚举值与 `AutoSyncOutcome` 类型
一一对应，无缺态。

### 1.3 小结

Step 20 A 组五提交在当前树逐项在位：`01ed64bf`（13 用例契约）、
`a4057892`（水合三层防线+测试）、`5f80e9a0`（ModernSidebar navigation.*）、
`65a53f3d` / `705a05f4`（notes 两键）。无回退迹象。

## 二、Step 21 与 `common:more` vs `common:actions.more` 收敛裁决

### 2.1 冲突由来与裁决内容（对照 MERGE-PLAN）

同一 bug 的两条竞争性修法（`docs/0824-MERGE-PLAN.md:979-990`）：

- rel-i18n（#318，Step 20 落地）：`AttachmentPanelBody` 的移动端「⋯更多」
  按钮从无词条的 `common:actions.more` **收敛为复用已翻译的顶层
  `common:more`**，并由 releaseUpgradeI18n 锁定该组件不得再引用
  `common:actions.more`（removedKeys 只禁组件源码引用，不禁词条存在）；
- rel-mobile（#324，Step 21 落地）：`1901780e` → `96a1ca42` 在两份
  `common.json` **增补 `actions.more` 词条**；`8c7f8415` → `2e788607`
  新增 `inputBarSplitI18nKeys.contract.test.ts`，其原第三用例断言组件用
  `common:actions.more`——cherry-pick 后在 0824 上 1 红。

裁决 `be53b8ba` 按 MERGE-PLAN 第 7 节「修了根因的以既有断言为准」：
组件保持 `common:more` 不回退；新契约第三用例改断言 `common:more`；
rel-mobile 增补的 `actions.more` 词条**保留**并锁定双语可解析。

### 2.2 当前树逐项验证

- 组件侧：`src/features/chat/components/input-bar/AttachmentPanelBody.tsx:158`
  为 `aria-label={t('common:more', { defaultValue: 'More' })}`（`:159`
  testid `attachment-panel-more`）；同头部关闭按钮 `:199` 用
  `common:actions.close`。组件中无任何 `common:actions.more` 引用。
- locale 侧四键双语齐备：
  - zh-CN `common.json`：顶层 `more`=「更多」（`:148`）、
    `actions.more`=「更多」（`:86`）、`actions.close`=「关闭」（`:97`）；
  - en-US `common.json`：顶层 `more`="More"（`:144`）、
    `actions.more`="More"（`:82`）、`actions.close`="Close"（`:93`）。
- 全树消费者反查：产品代码引用 `common:actions.more` 为 **0 处**；
  `actions.more` 仅存于两份 locale 与两份测试（含注释）。反向印证收敛
  方向与全树一致——其余 10 处「更多」按钮全部走顶层 `common:more`
  （FinderFileItem `:299/:346`、TabBar `:273`、LearningHubPage `:683`、
  MessageActions `:237`、ParallelVariantView `:747`、
  SkillsManagementPage `:1450`、SkillsList `:307`、
  QuestionBankManageView `:739/:890`、BatchOperationToolbar `:399`）。

### 2.3 双锁契约不互斥的机制确认

两份测试对同一按钮形成方向相反但**不冲突**的双锁：

- `releaseUpgradeI18n.test.ts:58-62,149-156`：removedKeys 检查只对
  **组件源码**做 `not.toContain('common:actions.more')`，完全不读 locale
  ——词条存在合法；
- `inputBarSplitI18nKeys.contract.test.ts:100-112`：第三用例要求组件源码
  含 `aria-label={t('common:more'` 与 `common:actions.close`，同时要求
  `more` / `actions.more` / `actions.close` 三键在 zh-CN 与 en-US 均可
  解析——锁词条存在，不锁组件引用 `actions.more`。

两锁交集为「组件用 `common:more` + locale 同时保留 `more` 与
`actions.more`」，恰是当前树状态，可同时全绿；任一方向回退（组件改回
`actions.more`，或删除 locale 词条）都会红一份，防回退面完整。

### 2.4 契约测试静态复算

用与 `inputBarSplitI18nKeys.contract.test.ts:34` 完全相同的正则
`\bt\(\s*'([A-Za-z0-9]+):([A-Za-z0-9_.-]+)'` 扫描其 6 个拆分文件
（`:22-29`），当前树提取 **123 个**去重字面量命名空间键：

- 反腐锁 `>100`（`:82-85`）成立；
- 123 键在 zh-CN 与 en-US **全部可解析**，unresolvable 为空数组
  （`:87-98` 用例的静态等价复算）；
- 第三用例（`:100-112`）逐断言核对为真（见 2.2）。

Step 21 改动面自述（MERGE-PLAN `:995-997`：2 行 locale + 1 个测试 +
测试适配）与树上观察一致，未夹带组件/引擎改动。

## 三、低风险观察（均无需本轮修复）

1. 【低】en-US 两个带 `count` 的键只有基键、无 `_one/_other` 复数形态：
   `notes:findReplace.replaceMany`（"Replaced {{count}} occurrences"）与
   `sync:autoSync.consecutiveFailures`（"{{count}} consecutive failures"）。
   i18next 在缺复数后缀键时回退基键，**可解析、不缺词**（契约绿是对的），
   仅 count=1 时英文语法瑕疵（"1 occurrences"）。releaseUpgradeI18n 第三
   用例对 mindmap 已显式处理同类形态，这两处属后续文案打磨项，非
   Step 20/21 回退。
2. 【低】`LITERAL_NAMESPACED_KEY` 只覆盖单引号字面量键，模板字符串键不在
   锁定范围——测试头注释（`:15-17`）已自我声明该边界，属已知设计取舍。
3. 【低】`createAutoSyncPersistStorage` 在 `window` 缺失或 localStorage
   访问抛错时返回 undefined，zustand 落回默认 storage 的理论路径在 Tauri
   webview 目标环境不会触发；jsdom 测试环境有 localStorage，不影响覆盖。
4. 【说明】本轮未执行 vitest（避免写缓存/产物），以上「全绿」均为对测试
   断言逻辑的只读静态重放；MERGE-PLAN `:990,:1000-1005` 记录落地当时
   inputBarSplitI18nKeys 3/3 + releaseUpgradeI18n 3/3 实跑全绿及四项门禁
   exit 0，与本轮静态结论互证。

## 结论

**总判定：PASS。** Step 20 rel-i18n 五提交（含 13 用例 release 升级 i18n
契约与 auto-sync 旧存储水合三层安全恢复）在当前树逐项在位且测试闭环；
auto-sync 的 fail-close 安全底线、默认关闭与退避封顶未被触碰，UI 侧
`sync:autoSync.*` 14 键双语齐备。Step 21 的 `be53b8ba` 收敛裁决仍是树上
真相：`AttachmentPanelBody.tsx:158` 用顶层 `common:more`，locale 保留
`actions.more` 词条，releaseUpgradeI18n（禁组件引用）与
inputBarSplitI18nKeys（锁词条双语可解析）双锁方向相反但交集自洽、可同时
全绿；removedKeys 与 `common:actions.more` 在产品代码全树零残留，123 个
拆分组件字面量键双语全解析。三条低风险观察（en-US 复数形态、正则边界、
存储降级路径）均为既有设计取舍或文案打磨项，不构成回归，无需产品修复。
**本轮不改代码**。
