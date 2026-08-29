# Wave2-C R5 · 卡 7：i18n 清理（actions.more alias 正式声明）

- 工作目录：`/tmp/0824-wave2-c-r5-i18n-alias`（基线 cf8eb9e8，未 commit，工作树含 1 处改动）
- 模型：claude-fable-5-thinking-high；按令未执行任何测试

## 裁决落地（官方 Step 21）

`common:actions.more` 正式声明为 **alias 词条**：

- 组件层保持 `common:more`，**不回退** `actions.more`。`AttachmentPanelBody.tsx` 未改动（已用 `common:more`，且经静态验证源码中不存在任何 `actions.more` 引用）。
- locale 层 rel-mobile(#324) 增补的 `actions.more` 词条**保留不删**（zh-CN `更多` / en-US `More`，`common.json` 嵌套 `actions` 下；顶层 `more` 同样双语在位）。

## 改动清单（仅 1 个文件，+11 行）

`tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` 第三用例
（`keeps the mobile attachment panel more/close aria-labels on resolvable keys`）：

1. 用例上方新增 docblock，正式声明 Step 21 alias 裁决（组件不回退 / 词条不删）。
2. 新增锁定断言 `expect(panelSource).not.toMatch(/actions\.more/)` —— 组件不得以任何形式引用 `actions.more`。
3. 原有 `resolveKey(common, 'actions.more')` 双语断言旁加注释，声明该词条为 alias、不得随清理删除。

## 冲突分支判定：未触发

任务预案「若与卡 6 冲突则改走 `releaseUpgradeI18n.test.ts` 注释 + 新建 `actionsMoreAlias.contract.test.ts`」——
检查了全部 R5 兄弟工作目录（含 `r5-i18n-ast`、`r5-check-i18n`、`r5-ledger` 等），均停在基线 cf8eb9e8 且未改动本测试文件
（仅 `r5-pdf-chrome` 改了 `androidBackCoordinator.ts`，无关）。故走主路径，未新建 `actionsMoreAlias.contract.test.ts`、
未改 `releaseUpgradeI18n.test.ts`。
**合并注意**：若卡 6（i18n-ast）后续重写本契约测试文件，需保留本轮新增的 alias docblock 与两处断言。

现有分工保持：`releaseUpgradeI18n.test.ts`（REUSE_CASES 第 6 项）继续锁定组件不得含字面量
`common:actions.more`；本契约测试补齐「任何形式的 actions.more 引用」+「alias 词条双语可解析」两侧。

## 缺键扫描（本会话触碰文件）

- sidebar `section_study` / `section_manage`：R1（98bbf3f1）已补，本轮确认在位。
- 扫描范围：`29ca02d9^..cf8eb9e8` 全部触碰的 17 个 src 文件（input-bar 六件套、AppMenu、
  OverlayCoordinator、TouchTarget、androidBackCoordinator、sessionActions、platform 等）。
- 方法：字面量显式命名空间 `t('ns:key')` 正则提取 + 双 locale JSON 逐段解析；另核查各文件
  `useTranslation(...)` 默认命名空间下的无前缀 `t()` 调用（仅 AppMenu 的
  `app_menu.search.placeholder` 一例，双语在位）。
- 结论：**零缺键**，本轮无需增补 locale 词条；未删除任何 locale 词条。

## 验证方式（静态，未跑测试）

- `rg "actions\.more" AttachmentPanelBody.tsx` → 无匹配（新断言必过）。
- zh-CN / en-US `common.json` 中 `actions.more`、`more`、`actions.close` 三键逐一确认为非空字符串。
- 缺键扫描脚本输出 `all literal namespaced keys resolve in both locales`。
