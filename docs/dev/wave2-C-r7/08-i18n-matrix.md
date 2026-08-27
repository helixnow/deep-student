# 0824 Wave2-C R7 · i18n 动态键矩阵测试

- 角色：第 7 轮测试员（i18n 动态键）
- 工作目录：`/tmp/0824-wave2-c-r7-i18n-matrix`
- 新增文件：`tests/vitest/mobile-uiux/i18nDynamicKey.matrix.test.ts`
- 约束遵守：未执行测试；未改产品代码（`git status` 仅显示新增测试文件，untracked）；未 commit。

## 测试设计

复用 R5 已有的 `tests/vitest/mobile-uiux/i18nKeyExtract.ts`：调用
`extractI18nKeys(SPLIT_INPUT_BAR_SCAN_FILES, INPUT_BAR_TEMPLATE_EXPANSIONS)`
得到展开集合，然后按「骨架前缀 × 枚举值」逐格断言键存在。

与现有 `inputBarSplitI18nKeys.contract.test.ts` 的分工：契约测试锁
unexpandedTemplates 为空、每个键双语可解析、枚举与产品声明不漂移；
但若有人改坏注册表里 `expandedKeys` 的拼接（骨架仍命中、展开值错了），
契约测试的模板断言不会失败。本矩阵从调用方视角逐格点名展开结果，
能精确指出缺失的那一格。

## 断言矩阵（任务指定三组）

| 组 | 骨架前缀 | 枚举值 | 断言 |
| --- | --- | --- | --- |
| uploadStage × 3 | `chatV2:inputBar.uploadStage` | reading / uploading / creating | 逐值存在 + 枚举恰好 3 值 + 该前缀下键集合**恰等于** 3 键（无多无少） |
| permissionPreset | `chatV2:authority.permissionPreset.{modes,hints,shortHints}` | cautious / relaxed / full_access / danger_full_access | 三个 facet 各逐值存在 + 每个 facet 的键集合恰等于 4 键 |
| thinkingDepth.minimal | `chatV2:inputBar.thinkingDepth` | minimal（另逐值覆盖全部 6 档） | `minimal` 在枚举中且展开集合含 `chatV2:inputBar.thinkingDepth.minimal`（R5 缺词条回归钉） |

矩阵行由 `describe.each` / `it.each` 驱动，逐格生成独立用例，失败时直接报出
具体键名。另有前置用例断言展开集合非空且 `unexpandedTemplates === []`，
防止扫描清单失效导致逐格断言集体假红。

## 结构核验（静态，未运行）

- `vitest.config.ts` 的 include 含 `tests/vitest/**/*.{test,spec}.{ts,tsx}`，新文件会被拾取。
- 导入的符号（`extractI18nKeys` / `SPLIT_INPUT_BAR_SCAN_FILES` / `INPUT_BAR_TEMPLATE_EXPANSIONS` / `UPLOAD_STAGES` / `PERMISSION_PRESETS` / `THINKING_DEPTH_SUFFIXES`）均在 `i18nKeyExtract.ts` 中导出，已逐一比对。
- 断言的键前缀与注册表 `INPUT_BAR_TEMPLATE_EXPANSIONS` 中的 skeleton 一一对应
  （uploadStage、permissionPreset modes/hints/shortHints、thinkingDepth）。

## 预期通过依据

注册表当前的 `expandedKeys` 正是按同一批枚举常量 map 拼接（`i18nKeyExtract.ts`
215–267 行），且宿主文件（AttachmentPanelBody / ComposerPlusMenu / InputBarV2）
在扫描清单内、模板骨架能命中，故矩阵各格均应存在；本轮禁止执行测试，
未实际运行验证。
