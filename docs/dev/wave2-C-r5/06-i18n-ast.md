# 0824 Wave2-C R5 · 第 6 项「i18n 守卫-AST」

- 基线：cf8eb9e8 ｜ 工作目录：/tmp/0824-wave2-c-r5-i18n-ast ｜ 未 commit（按约定）
- 改动文件：
  - `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts`（重写，独占）
  - `tests/vitest/mobile-uiux/i18nKeyExtract.ts`（新建辅助）
- 产品代码 0 改动（git status 仅上述两文件）。

## 任务落地

### 1. 提取升级：模板字符串 + 动态枚举逐值展开

新辅助 `i18nKeyExtract.ts` 的 `extractI18nKeys(specs, expansions)`：

- 字面量 `t('ns:key')` 照旧；对声明 `defaultNamespace` 的文件额外提取无前缀
  字面量（ComposerPanel 两处 useTranslation 均为单命名空间 `'chatV2'`，
  `t('common.close')` / `t('common.clearSearch')` 展开为 `chatV2:common.*`）。
- 模板 `t(\`ns:…${…}\`)`：占位符规格化为骨架（`chatV2:inputBar.uploadStage.*`），
  查 `INPUT_BAR_TEMPLATE_EXPANSIONS` 注册表逐值展开；**注册表不认识的带命名空间
  模板记入 `unexpandedTemplates`，契约断言必须为空**——新增动态键必须同步登记枚举。

已登记 7 个骨架（枚举值与产品声明来源）：

| 骨架 | 枚举 | 来源 |
| --- | --- | --- |
| `chatV2:inputBar.uploadStage.*` | reading/uploading/creating | `AttachmentMeta.uploadStage`（core/types/common.ts） |
| `chatV2:authority.permissionPreset.{modes,hints,shortHints}.*` ×3 | cautious/relaxed/full_access/danger_full_access | `PERMISSION_PRESETS`（ComposerPlusMenu） |
| `chatV2:injectMode.*.*` | pdf×{text,ocr,image} ∪ image×{image,ocr} | `PdfInjectMode`/`ImageInjectMode`（core/types/common.ts） |
| `chatV2:inputBar.thinkingDepth.*` | minimal/low/medium/high/xhigh/max | `THINKING_DEPTH_LABEL_KEYS` 值域（InputBarV2） |
| `chatV2:*`（compaction reason 调用点） | 8 个 reason 码 + unknown | `KNOWN_COMPACTION_REASONS`（compactionFeedback.ts） |

宽骨架 `chatV2:*` 有专门断言锁定调用点形状
（`t(\`chatV2:${compactionReasonI18nKey(result.reason)}\`)`），防止被别的动态键复用。

另加 **drift 守卫**：注册表枚举与产品源码声明做集合相等（正则切片取声明块内的
引号字符串），任一侧增删值即红。

### 2. resolveKey 严格化

`resolveKeyToText` 叶子必须是**非空字符串**；打到中间对象（键漏最后一段）、
数组、空串一律判失败。旧实现 `typeof cursor === 'object'` 会放行「键指向子树」。

### 3. 扫描清单补齐

在原 6 个文件基础上新增：AttachmentPreviewChips / ContextUsagePopover /
ComposerInlinePanel / ComposerPanel（defaultNamespace='chatV2'），以及模板键宿主
InputBarV2.tsx（thinkingDepth、compaction reason）与 useInputBarV2.ts（injectMode）
——不纳入宿主则 injectMode/thinkingDepth 的展开永远不会被触发。共 12 个文件。

### 4. 与 releaseUpgradeI18n 对齐

AttachmentPanelBody 断言组件使用 `common:more`，并新增
`not.toContain('common:actions.more')`（与 releaseUpgradeI18n.test.ts 的
removedKeys 一致）；rel-mobile(#324) 增补的 `common:actions.more` 词条本身
保留且双语按严格规则可解析。

## 发现的真实缺口（本轮禁改产品代码，登记不修）

- **`chatV2:inputBar.thinkingDepth.minimal` 两份 locale 均缺失。**
  `THINKING_DEPTH_LABEL_KEYS` 里 openai-effort / gemini-flash-effort / glm-effort
  的 minimal 档可达；运行时靠 `THINKING_DEPTH_LABEL_FALLBACKS['minimal']='最低'`
  兜底，**en-US 用户会看到中文**——正是本守卫要抓的一类缺陷。
  已登记进测试内 `KNOWN_UNRESOLVED_KEYS`（自清洁：补词条后
  「registered gaps stay missing」断言会红，强制清表）。
  建议后续轮次给 zh-CN/en-US `chatV2.json` 的 `inputBar.thinkingDepth`
  增补 `minimal`（zh「最低」/ en「Minimal」）。

## 验证方式（未执行 vitest，按约定）

- 用 `node --experimental-strip-types` 跑独立提取驱动 + 最小 expect stub 影子执行：
  - 提取 187 个键（12 文件，字面量 + 展开），`unexpandedTemplates` 为空；
  - 严格解析仅上述 minimal 一个键在两份 locale 失败（已登记）；
  - drift 守卫 6 组集合相等全部通过；
  - 7 条契约断言全部 PASS。
- 影子驱动/stub 均为 /tmp 临时文件，已清理，不入库。

## 契约测试断言清单

1. `unexpandedTemplates` 为空（新动态键必须登记枚举展开）
2. 反腐蚀：提取键数 > 120（当前 187）
3. 展开键归属正确宿主文件（uploadStage→AttachmentPanelBody、injectMode→useInputBarV2、
   thinkingDepth/compaction→InputBarV2、defaultNamespace→ComposerPanel 等 6 探针）
4. 全部键在 zh-CN/en-US 严格解析为非空字符串（已知缺口豁免）
5. 已知缺口自清洁（键仍被提取 + 仍缺失，修复即红）
6. 枚举 drift 守卫（6 组集合相等 + 宽骨架调用点锁定）
7. AttachmentPanelBody more/close aria-label 键位（含 not actions.more）
