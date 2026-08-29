# 0824 Wave2-C R10 · i18n 交叉终审

- 取证时点：2026-08-26 UTC
- 分支 / HEAD：`cursor/0824-wave2-mobile-uiux-a875` / `fe8ff43c`
- 范围：抽键与动态枚举、非空字符串叶子、`actions.more` alias、sidebar legacy 缺键、`check-i18n` 退出语义、R9 的 31 个死键删除
- 方式：静态读码、提交差异反查、GitHub issue 状态现查、定向 vitest 与 i18n 脚本实跑；未使用 computerUse

## 结论：有条件 PASS

当前产品结果与本波要求范围内未发现新的 i18n 阻断缺陷；R9 删除的 31 个
`chatV2:inputBar.*` 叶子没有找到活引用或误删证据，动态键矩阵、双语非空叶子、
alias 与 sidebar legacy 补键均通过实测。

条件只有一项，但必须写清：仓库称为“i18n 守卫-AST”的实现
`tests/vitest/mobile-uiux/i18nKeyExtract.ts` **不是 AST 提取器，而是正则扫描器**。
因此可以记“当前 12 文件 / 当前语法形态的守卫通过”，不能记“已具备 AST 级完备
抽键”。若验收项的字面要求是真 AST，这一项仍未满足；若目标是封住 Wave2-C
已知模板键盲区，则当前实现已满足。

## 1. 终审矩阵

| 项目 | 证据 | 裁决 |
| --- | --- | --- |
| 抽键 | 12 个显式扫描文件；当前提取 187 键；字面量、指定 default namespace、模板骨架均有覆盖 | 当前样本 PASS；“AST”名实不符，保留覆盖债 |
| 动态枚举展开 | 7 个骨架：uploadStage 3、permissionPreset 4×3、injectMode 5、thinkingDepth 6、compaction reason 9；`unexpandedTemplates=[]` | PASS |
| 叶子非空字符串 | `resolveKeyToText` 终点要求 `typeof === 'string' && trim().length > 0`；187 键在 zh-CN/en-US 全部解析 | PASS |
| `actions.more` alias | locale 双语同时保留顶层 `more` 与 `actions.more`；AttachmentPanelBody 只用 `common:more`；契约锁 alias 不得删除 | PASS |
| sidebar legacy 缺键 | `mobile_drawer.section_study/section_manage` 中英均存在，MobileSidebarNavigation 正在引用 | PASS；归因 v0.9.44 legacy，不是 0824 回归 |
| `check-i18n` 可失败 | 默认与 strict 均实跑 exit 1；`computeExitCode` 和 npm scripts 接线有效 | PASS；当前不是绿门禁，也未接入 workflow |
| R9 删除 31 死键 | 两份 chatV2 locale 对称删除；全仓精确词根、模板调用与当前 locale 反查未见活消费者 | PASS，未见误伤 |

## 2. 抽键与动态枚举：功能有效，但不是 AST

`i18nKeyExtract.ts` 的核心是三条正则：

- `LITERAL_NAMESPACED_KEY`：只取单引号的显式命名空间调用；
- `LITERAL_BARE_KEY`：只在手工声明 `defaultNamespace` 的文件取单引号裸键；
- `TEMPLATE_KEY` + `TEMPLATE_PLACEHOLDER`：把模板占位符替换成 `*` 后查手工注册表。

这套机制对当前受控源码有效，实测结果为：

```text
scanFiles: 12
keys: 187
unexpandedTemplates: []
expansions:
  chatV2:inputBar.uploadStage.*                  3
  chatV2:authority.permissionPreset.modes.*      4
  chatV2:authority.permissionPreset.hints.*      4
  chatV2:authority.permissionPreset.shortHints.* 4
  chatV2:injectMode.*.*                          5
  chatV2:inputBar.thinkingDepth.*                6
  chatV2:*                                       9
```

枚举 drift 守卫会把 uploadStage、injectMode、permissionPreset、
thinkingDepth、compaction reason 与产品声明做集合相等校验；R7 的矩阵又从调用方
视角逐格锁住 uploadStage、permissionPreset 和 thinkingDepth，当前 25 项全绿。

但正则边界是真实存在的：

1. 双引号键、别名调用、更复杂的模板表达式或跨文件数据流并不具备 AST 语义；
2. 已纳入扫描清单的 `ComposerToolbar.tsx` 中
   `t(option.labelKey, option.defaultLabel)` 不会被提取。其真实 labelKey 来自
   `src/utils/deepseekReasoningControls.ts`，当前双语词条齐全且有 defaultLabel，
   所以不是现存用户缺陷，但确实不受这份“187 键全部可解析”断言保护；
3. input-bar 目录中的 `ContextRefChips.tsx` 使用 `t(labelKey)`，且不在 12 文件
   清单内；当前 `contextRef.type.*` 双语齐全，仍属于守卫覆盖边界；
4. 宽骨架 `chatV2:*` 的测试只确认预期 compaction 调用点存在，没有断言同骨架
   在扫描文件中只能出现一次。当前读码仍只有预期调用点，风险未触发。

所以本轮不要求改产品，但后续文档应把它称为“正则提取 + 显式枚举注册表”，或另开
任务迁移到 TypeScript AST 后再宣称 AST 抽键。

## 3. 非空字符串叶子

目标契约口径正确：

```ts
return typeof cursor === 'string' && cursor.trim().length > 0;
```

它会拒绝缺段、中间对象、数组、空串和纯空白串。定向契约已对 187 个提取键逐一在
zh-CN/en-US 解析，`KNOWN_UNRESOLVED_KEYS` 为空，全部通过。独立全量扁平化
`chatV2.json` 也得到中英各 1826 叶、键集合相等、零空/非字符串叶。

需区分另一个口径：`scripts/check-i18n.mjs` 的 `collectNonStringLeaves` 只拒绝
number/boolean/null，空字符串仍属于 string，不会由该脚本报错。当前“非空”保证
来自 Wave2-C 契约，不应误写成 `check-i18n` 已全库检查空字符串。

## 4. `common:actions.more` alias 与 sidebar legacy

### `actions.more`

- en-US：`common:more = "More"`、`common:actions.more = "More"`；
- zh-CN：`common:more = "更多"`、`common:actions.more = "更多"`；
- `AttachmentPanelBody.tsx` 使用 `t('common:more', …)`，不使用
  `common:actions.more`；
- `inputBarSplitI18nKeys.contract.test.ts` 同时锁组件侧不得回退 alias、locale 侧
  alias 必须双语非空；
- `releaseUpgradeI18n.test.ts` 的 `removedKeys` 只表示该组件不得再引用旧路径，
  不表示 locale 词条应删除。两份契约语义互补，不冲突。

裁决：alias 正确保留，R9 清死键没有碰它。

### sidebar legacy

`src/locales/{zh-CN,en-US}/sidebar.json` 当前均含：

- `mobile_drawer.section_study`：学习 / Study；
- `mobile_drawer.section_manage`：管理 / Manage。

`MobileSidebarNavigation.tsx` 仍在引用这两键。提交 `98bbf3f1` 的归因保持为
v0.9.44 既有债补齐，不得改写成 0824 新回归或本轮新修。

## 5. `check-i18n`：退出语义已生效，当前允许红

实跑结果：

| 命令 | 退出码 | 当前原因 |
| --- | ---: | --- |
| `npm run check:i18n` | 1 | mindmap 跨语言键形态差异 21：en-US 缺 7、zh-CN 缺 14 |
| `npm run check:i18n:strict` | 1 | 同上；另报告静态引用缺失 39×2=78 |

默认模式能因 hard errors 返回非零，strict 会把引用缺失与 namespace 文件缺失也
纳入失败；这证明“可失败”不是只写在源码测试里的声明。当前 21 个 mindmap 差异和
78 个引用缺失均在 Wave2-C 热区之外，R9 前后没有扩大。

`.github/workflows` 当前没有调用 `check:i18n` / `check-i18n`，所以它是可供 CI
消费的独立失败命令，尚不是现行 CI gate。终审口径应写“脚本可失败且当前预期
exit 1”，不能写“check-i18n 全绿”或“CI 已接线”。

## 6. R9 删除 31 个死键：未见误伤

提交 `fe8ff43c` 对两份 `chatV2.json` 各为 `+0/-37`；37 是包含对象括号的行数，
实际叶子各删 31：

| 键族 | 叶数 |
| --- | ---: |
| `inputBar.imageGen.*`（含 purposes 4 叶） | 18 |
| `inputBar.menuGroup.{context,aiSettings,modes,tools}` | 4 |
| `inputBar.thinkingEnabled/thinkingDisabled/toggleThinking` | 3 |
| `inputBar.nonMultimodalImageFallback*` | 2 |
| `inputBar.thinkingDepthExpensive` | 1 |
| `inputBar.ankiTools` | 1 |
| `inputBar.toggleModelPanel` | 1 |
| `inputBar.pasteNotReady` | 1 |
| 合计 | 31 |

反查结果：

- 当前 `src` 无上述完整键或对应 `inputBar.*` 前缀消费者；
- 全仓只剩 R9 文档中的说明，以及
  `InputBarUI.thinkingRuntimeState.source.test.ts` 对
  `thinkingDepthExpensive` 的负断言；
- 当前 input-bar 模板调用只有已登记的 uploadStage、permissionPreset、
  thinkingDepth/injectMode/compaction 与人工核过的
  `approval.sensitivity.{low,medium,high}`、
  `skillInstall.approval.risk.{low,medium,high}`，没有可展开到被删键族的骨架；
- 活跃消息块继续使用 `blocks.imageGen.*`，该子树仍在，未与旧
  `inputBar.imageGen.*` 混删；
- `inputBar.uploadStage.*`、`inputBar.thinkingDepth.*` 等活动态键全部保留；
- 删除后 chatV2 中英仍各 1826 叶，键集合完全一致。

在当前源码与显式动态键集合内，31 键可判为死键，R9 未误伤。鉴于抽键器不是 AST，
这里的强结论来自“提交差异 + 全仓精确反查 + 模板调用审计 + 运行契约”组合证据，
不把单个正则扫描器当作完备证明。

## 7. 运行证据

```text
npx vitest run \
  tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts \
  tests/vitest/mobile-uiux/i18nDynamicKey.matrix.test.ts \
  tests/vitest/check-i18n.script.source.test.ts \
  src/__tests__/releaseUpgradeI18n.test.ts

4 files passed
45 tests passed
```

分项：动态矩阵 25、输入栏 i18n 契约 7、check-i18n 接线 10、release alias
契约 3，全部通过。

另做双语扁平化校验：

```text
chatV2 leaves: zh-CN 1826 / en-US 1826
missing zh-CN: 0
missing en-US: 0
non-empty failures: 0
```

## 8. issue #122 状态

GitHub 现查：[issue #122「聊天出现乱码」](https://github.com/helixnow/deep-student/issues/122)
状态仍为 **OPEN**，且无评论。Wave2-C 的 i18n 键守卫与死键删除不能证明聊天正文
乱码根因已修；本终审不把它记为已修、已关闭或已归因。

## 9. 边界

本轮只新增本终审文档，不改产品代码、locale、测试、CI 或台账；不 commit。
