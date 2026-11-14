# U4-ui-content：F1 改造前 golden 取证

## 状态与阻塞

- **仅完成源码 golden 清单与现有测试基线；未开始生产代码改造，不声明 F1 完成。**
- 工作树：`/home/dsdev/dev/ds-mig/U4-ui-content`；分支：`ds-mig/U4-ui-content`。
- 取证基线：`e303957124ac220f55bee1b04cca5d3937983b92`（取证时 HEAD 与 main 相同）。
- `docs/plugins/FRONTEND.md` 已完整阅读；`src/ui-kernel/` 的全部实现及三个现有测试文件已阅读。
- **阻塞：必读规格 `docs/plugins/FRONTEND-F1.md` 不存在于当前工作树和 main。** 无法读取 §3 的 U4 范围及 §5 完成协议，不能用总体设计代替具体规格猜测迁移。
- 现有内核尚无 `src/ui-kernel/contracts/`，也无 `src/ui-plugins/`。这本身不代表阻塞；须先取得 F1 规格才能确定新增类型及装配约定。
- 请 C1 协调者/架构师提供规格所在提交或补齐文件。在此之前保留两处原实现，不修改内核、装配入口或其他 lane 文件。
- 本文件首次提交仅做取证。以下 golden 是**改造前**事实，后续不得为通过测试改写；后续实施结果另行追加。

## 取证证据

所有命令均在本 lane 工作树执行。初始 `git status --short` 无输出；进程检查发现其他 lane 的并行 vitest，故仅运行下面的定向测试（最多两个 worker）。

```text
$ git rev-parse HEAD main
e303957124ac220f55bee1b04cca5d3937983b92
e303957124ac220f55bee1b04cca5d3937983b92

$ git ls-tree HEAD docs/plugins/FRONTEND-F1.md src/ui-kernel/contracts src/ui-plugins
（无输出）
```

本地 `**/*FRONTEND*` 搜索仅发现 `docs/plugins/FRONTEND.md`；读取 `docs/plugins/FRONTEND-F1.md` 返回 `File not found`。未切换分支、未修改主仓库、未引入依赖。

## Golden：Markdown

来源：上述基线的 `src/features/chat/components/renderers/MarkdownRenderer.tsx`。可用 `git show e303957124ac220f55bee1b04cca5d3937983b92:src/features/chat/components/renderers/MarkdownRenderer.tsx` 取得完整原实现。

### 插件管线、时机与组件身份

| 原实现 | 原条件/顺序 | 新元数据 |
|---|---|---|
| remark 基础数组（771–784 行） | `disableIndentedCodePlugin` → `normalizeFullWidthPunctPlugin` → `convertMathCodeBlocksPlugin` → `remarkMath` → `inlineSmilesRemarkPlugin` → `remarkGfm` | 未迁移，等待规格 |
| 引用 remark | `enableCitations ?? !!(onCitationClick || resolveCitationImage)` 为真时，将 `makeCitationRemarkPlugin()` 追加到基础数组 | 同上 |
| 外部 remark | 最后展开 `extraRemarkPlugins || []`；默认值为模块级空数组 | 同上 |
| rehype（786–792 行） | `rehypeRaw` → `[rehypeSanitize, markdownSanitizeSchema]`；`searchQuery.trim()` 非空时再追加 `[rehypeSearchHighlights, { query: searchQuery }]` | 同上 |
| KaTeX | 挂载时 `ensureKatexStyles()`、`scheduleKatexIdlePrefetch()`；节点缓存未命中且库未加载时才 `ensureKatexLoaded()`，原文降级后补渲；缓存上限 200，满时丢最旧一半 | 同上 |
| 引用样式 | 挂载时 `ensureCitationPlaceholderStyles()` | 同上 |
| ReactMarkdown components | `useMemo` 依赖仅为 `renderMath`、`resolveImageSrc`；流式状态/能力/回调经 `MarkdownRendererContext` 传递，不替换组件类型 | 同上 |

Sanitize schema 保留受控 span 引用属性、`dataSmiles`、code/pre class、两类 mark class 与 `dataChatSearchMatch`，并在默认 tagNames 后追加 `mark`。转换插件位于 remark-math 前，`math`/`latex` 不区分大小写，原 warning 不变。

### 代码、数学与 inline 分发

| 原条件 | 原结果 | 新元数据 |
|---|---|---|
| `pre` 的子 code class 含独立 math/math-display/math-inline 或 `language-(math\|latex)(?![\w-])`（不区分大小写） | 调 `renderMath`；math-inline 决定行内，否则块级 | 未迁移，等待规格 |
| 其他 `pre` | 原 `CodeBlock`，原样传 className、children、isStreaming、rendererCapabilities；不再包一层 pre | 同上 |
| `code` 明确标记 math/latex | `renderMath(codeContent, inline === false)` | 同上 |
| `code` 无 className 且命中原 LaTeX signature | 原 warning 后数学兜底，不改变判定正则 | 同上 |
| 其他 `code`：`inline !== false && !isMultiline && !className` | `code.inline-code`；否则保留原 className | 同上 |
| span 的 `data-smiles` 或 `dataSmiles` 是字符串 | decodeURIComponent 后，chemicalStructures 开启则 InlineSmiles，否则 `code.inline-code` 显示 `\smiles{…}`；解码失败保留 span | 同上 |

`CodeBlock.tsx` 不在允许改动范围。其 mermaid/svg/html/htm/xml 与可选富渲染能力仍归原组件处理；Mermaid 仅手动运行时动态 import，流式期间禁用运行，深浅主题现场判断。不得在注册元数据时提前执行动态加载或替换其交互外壳。

其他必须保留：预处理代码占位保护、公式表格竖线转义、流式闭合、原图像路径转换/失败占位、PDF 页面缓存（上限 12）、表格 TableBlockShell、所有引用徽章/卡片与事件、链接打开回调、根 `markdown-content` class。未声称截图、移动端或 demo 壳已经验证。

## Golden：LearningHub 右键菜单

来源：上述基线的 `src/features/learning-hub/components/LearningHubContextMenu.tsx`；原行号 357–921。以下按**实际渲染顺序**记录，`|` 表示原分隔线（包括可能出现的首尾/连续分隔线，不能顺手整理）。所有图标均为 `size={15} weight="duotone"`，另有说明除外。文案均为 `learningHub` namespace key。

时序简写：`A→C` = 同步动作后关闭；`C→50→A` = 先关闭再 setTimeout 50ms 执行动作。未提供可选回调时，未受回调存在性约束的菜单仍然显示，点击仍关闭。

### 回收站

| 位置/原条件 | 文案 key | 图标/状态 | 动作/时序 | 新元数据 |
|---|---|---|---|---|
| 空白，onEmptyTrash | finder.trash.emptyAction | Warning，danger | onEmptyTrash；C→50→A | 未迁移，等待规格 |
| 空白，无条件 | 分隔线 | — | — | 同上 |
| 空白，无条件 | common.refresh | ArrowClockwise | onRefresh?.()；A→C | 同上 |
| 项目，onRestoreItem | finder.contextMenu.restore | ArrowCounterClockwise | onRestoreItem(id, itemType)；C→50→A | 同上 |
| 项目，onPermanentDeleteItem | 分隔线 → finder.contextMenu.permanentDelete | Trash，danger | onPermanentDeleteItem(id, itemType)；C→50→A | 同上 |

回收站优先于普通视图：folder 使用 folder.folder.id 和 `'folder'`；resource 使用自身 id/type；folderItem 使用 itemId，itemType 仅 note/textbook/exam/translation/essay/image/file/mindmap 原值透传，其余回落 `'note'`。

### 普通空白区域

`!canCreate` 时只显示刷新（ArrowClockwise，onRefresh?.() 后关闭），其余项全部不显示。canCreate 时顺序如下：

| 原条件 | 文案 key | 图标 | 动作/时序 | 新元数据 |
|---|---|---|---|---|
| onPaste && pasteCount > 0 | pasteCount > 1 时 contextMenu.pasteCount（count），否则 contextMenu.paste；后接分隔线 | Clipboard | onPaste()；C→50→A | 未迁移，等待规格 |
| dataView === 'folder' | folder.newFolder；后接分隔线 | FolderPlus | onCreateFolder?.(currentFolderId ?? null)；A→C | 同上 |
| 无条件 | contextMenu.newNote | FileText | onCreateItem?.('note', currentFolderId ?? null)；A→C | 同上 |
| 无条件 | contextMenu.importMarkdown | 无 | onImportMarkdownNote?.(currentFolderId ?? null)；A→C | 同上 |
| 无条件，按此顺序 | contextMenu.newExam / newTextbook / newTranslation / newEssay / newMindMap | 无 | onCreateItem?.(exam/textbook/translation/essay/mindmap, currentFolderId ?? null)；A→C | 同上 |
| 无条件 | 分隔线 → common.refresh | ArrowClockwise | onRefresh?.()；A→C | 同上 |

### 普通文件夹

下表的 folderId 均为 `folder.folder.id`。

| 原条件 | 文案 key | 图标/状态 | 动作/时序 | 新元数据 |
|---|---|---|---|---|
| 无条件 | contextMenu.open；后接分隔线 | FolderOpen | onOpenFolder?.(folderId)；A→C | 未迁移，等待规格 |
| canCreate | contextMenu.newSubfolder | FolderPlus | onCreateFolder?.(folderId)；A→C | 同上 |
| canCreate | contextMenu.newNoteHere | FileText | onCreateItem?.('note', folderId)；A→C | 同上 |
| canCreate | contextMenu.importMarkdownHere；后接分隔线 | 无 | onImportMarkdownNote?.(folderId)；A→C | 同上 |
| onCopy | contextMenu.copy | Copy | onCopy(target)；A→C | 同上 |
| canCreate && onDuplicate | contextMenu.duplicate | 无 | onDuplicate(target)；C→50→A | 同上 |
| canMove && onMoveTo | contextMenu.moveTo | 无 | onMoveTo(target)；C→50→A | 同上 |
| 无条件 | contextMenu.rename | Pencil | onRenameFolder?.(folderId)；A→C | 同上 |
| onExportFolder | contextMenu.exportFolderZip | 无 | onExportFolder(folderId)；C→50→A | 同上 |
| canDelete && onDeleteFolder | contextMenu.delete | Trash，danger | onDeleteFolder(folderId)；A→C（不是延时删除） | 同上 |

### 普通资源 / folderItem

`resourceItem` 判定严格为 `'type' in resource && typeof resource.type === 'string'`，不是 target.type。`isFolder` 仅看 resourceItem.type 是否为 `'folder'`。桌面存在性查询分别使用 hasFolderShortcut / hasResourceShortcut，查询 id 为 `resourceItem?.id || ''`。

| 原条件 | 文案 key | 图标/状态 | 动作/时序 | 新元数据 |
|---|---|---|---|---|
| 无条件 | contextMenu.open；后接分隔线 | ArrowSquareOut | onOpenResource?.(resource)；A→C | 未迁移，等待规格 |
| canAddToChat && onReferenceToChat | contextMenu.referenceToChat | Chat | onReferenceToChat(target)；A→C | 同上 |
| canAddToChat && onMakeCards && !isFolder | contextMenu.makeCards | Cards | onMakeCards(target)；A→C | 同上 |
| onCopy | contextMenu.copy | Copy | onCopy(target)；A→C | 同上 |
| canCreate && onDuplicate | contextMenu.duplicate | 无 | onDuplicate(target)；C→50→A | 同上 |
| canMove && onMoveTo | contextMenu.moveTo | 无 | onMoveTo(target)；C→50→A | 同上 |
| resourceItem && onRenameResource | 分隔线 → contextMenu.rename | Pencil | onRenameResource(resourceItem)；A→C | 同上 |
| resourceItem && onToggleFavorite | 分隔线 → isFavorite 时 contextMenu.unfavorite，否则 contextMenu.favorite | isFavorite 时 StarHalf，否则 Star | onToggleFavorite(resourceItem)；A→C | 同上 |
| resourceItem | 已添加时 contextMenu.addedToDesktop，否则 contextMenu.addToDesktop | 已添加时 CheckCircle（text-success）且 disabled，否则无图标 | 未添加时按 isFolder 分支调用 addFolderShortcut(id,title,path) 或 addResourceShortcut(id,title,type,path)，然后关闭 | 同上 |
| resourceItem && onExportResource | 分隔线 → contextMenu.export | 无 | onExportResource(resourceItem)；C→50→A | 同上 |
| canDelete && resourceItem && onDeleteResource | 分隔线 → contextMenu.delete | Trash，danger | onDeleteResource(resourceItem)；C→50→A | 同上 |

### 原外壳与默认值（不迁移/不优化）

- isTrashView 默认 false；canCreate/canDelete/canMove/canAddToChat 默认 true；pasteCount 默认 0；创建父文件夹使用 `?? null`。
- 原 MenuItem button/role/menuitem/class/图标空占位、danger class、separator DOM 必须保留；Portal 到 document.body，原 zIndex。
- 退出保留 180ms；桌面边界 8px，向上溢出使用 position.y - rect.height；不因插件化另行整理布局。
- pointer:coarse 走原贴底面板、44px 触控目标、安全区、完整名称（folder/resource 才有）；原玻璃透镜和 WallpaperReplica 保留。
- 外部 mousedown/touchstart、外部 scroll、Escape、Android back 关闭处理与监听延迟/清理不变。
- 深浅色与 demo 壳不新增分支或静态引入业务重模块；此轮未运行视觉验证。

## 验证结果（改造前，原始输出）

目的：区分已有 Markdown 行为/组件身份/内核生命周期基线与未来重构引入的回归；不把这些测试当作尚缺失的 §5 完成门禁。

```sh
npx vitest run -c vitest.config.ts src/ui-kernel/__tests__/kernel.test.ts src/ui-kernel/__tests__/loader.test.ts src/features/chat/components/renderers/__tests__/MarkdownRenderer.codeblock.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.identity.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.bold.test.tsx src/features/chat/components/renderers/__tests__/escapePipesInTableMath.test.ts --maxWorkers=2 --minWorkers=1
```

原始摘要与退出码：

```text
 Test Files  6 passed (6)
      Tests  39 passed (39)
   Start at  13:37:58
   Duration  33.73s (transform 23.60s, setup 3.08s, collect 38.70s, tests 3.08s, environment 6.91s, prepare 1.23s)

EXIT_CODE=0
```

- **Errors 行：原始输出未出现 Errors 行**，没有用 Tests passed 忽略错误。完整本地日志：`/tmp/opencode/U4-ui-content-baseline-vitest.log`。
- 原输出另有 Browserslist 数据过期提示；未修改依赖。
- 未找到 LearningHubContextMenu 的既有专用测试；上述结果不覆盖它的运行态行为。
- 未运行类型检查（本次只新增取证报告）；未来类型检查必须先 `npm run version:generate`。
- 未新增/修改 golden 测试或生产代码；无改造提交。§5 验证、截图、移动端、深浅色和 demo 壳验证均尚未执行。

## 续作：可执行取证（规格发布后，仍未改造）

- 已按协调者指令 `git merge --no-edit main`，完整阅读工作树内 `docs/plugins/FRONTEND-F1.md`；原规格缺失阻塞已解除。以上章节是首次取证时的历史状态，不改写其 golden 事实。
- `25f9c1714` 是文档取证，未冒充可执行 golden。此次补充两个真实入口的生产分派/渲染取证测试与 `official/content/__golden__/*.json`，不涉及 `src/dstu/contextMenu.ts`，不修改 `CodeBlock.tsx`。
- 菜单从原组件 DOM 取得原始顺序、文案键、图标/size/weight/class、disabled/danger、分隔线、触屏面板/标题；逐行真实点击，采集同步、49ms、50ms 的回调参数和关闭顺序。条件包括四类 target、普通/回收站、四个 capability、无回调/逐个缺少回调、pasteCount 0/1/2、父目录缺省、收藏/桌面状态、回收站 folderItem 类型映射。
- Markdown 测试仅替换 ReactMarkdown 为调用生产 pre/code 的探针、替换 CodeBlock/KaTeX 为可辨识终端，不替换被测分派；覆盖 1584 个组合（pre/code、语言与前缀边界、inline 状态、普通/裸 LaTeX/多行、流式、demo、深浅色）。MathScrollShell 仍走原组件。
- 捕获命令仅可在 `U4_CAPTURE_GOLDEN=1` 下首次创建文件（`wx`）；文件已存在会失败，不会覆盖 golden。后续默认只读比对。
- 队列作业 `20261104064501-f62354` 退出码 1：提交进程的环境变量不会传入作业，故未捕获文件（ENOENT）；随后改为命令内 `env U4_CAPTURE_GOLDEN=1`。
- 捕获作业 `20261104064538-542e7f` 退出码 1：JSON 已成功首次写出，菜单通过；Markdown 同步遍历全矩阵超过默认 5s。测试本身时限明确设为 30s，未改变任何输入/断言/golden；下一作业仅只读对照。
- 范围澄清：`MarkdownRenderer.tsx` 的语言分派只有 math/latex，其他 pre 交给原 `CodeBlock`。Mermaid/SVG/HTML/XML 与能力开关分派在 `CodeBlock.tsx:383–411`，不在授权范围；保留该实现，不为声称覆盖全部语言而擅改它。

只读 golden 基线作业结果（`job.mjs result 20261104064648-059ada`）：

```text
 Test Files  2 passed (2)
      Tests  2 passed (2)
   Start at  14:46:51
   Duration  34.98s (transform 28.54s, setup 1.54s, collect 14.05s, tests 22.82s, environment 2.66s, prepare 753ms)

[作业 20261104064648-059ada] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ --maxWorkers=2 --minWorkers=1
[作业 20261104064648-059ada] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064648-059ada.log
```

Errors 行：原始输出未出现。此提交仍只含取证测试/JSON/报告，没有 slot 改造。

## Slot 改造（实施记录）

### 提交与范围

- 文档取证：`25f9c1714`。
- 可执行 golden：协调者自动检查点 `c3d573c5b`（只含两个测试和两个 JSON，无生产改造）；补充报告 `a58ab79c2`。
- 自动保存的改造检查点：`58e255320`、`f94996c05`；这些是协调者保存，不代表完成验证。最终验证提交另记。
- JSON 数量：菜单 **99** 条条件输入，Markdown **1584** 条分派组合。改造后只调整测试宿主为真实 `UiKernel` + 安装 `dstu.ui.content` + `UiKernelProvider`；JSON 未变。

### 原条件 → 新元数据

| 原位置/条件 | 新归属 | 保持不动的部分 |
|---|---|---|
| Markdown pre 的 math class 或 language-math 边界 | `markdown.codeBlocks/math`，order 10，`matches` + `MathCodeBlock` | 原 renderMath/LazyMath、缓存、KaTeX JS/CSS 加载时机、MathScrollShell |
| Markdown pre/code 的 language-latex 边界 | `markdown.codeBlocks/latex`，order 20，同一稳定组件引用 | inline/display 原判断、完整正则边界与大小写行为 |
| 非上述语言 | slot 未命中即走原分支 | 原 CodeBlock 与裸 LaTeX/inline-code 兜底、remark/rehype 插件序列、所有引用/图片/表格/链接组件 |
| LearningHub 普通/回收站 + empty/folder/folderItem/resource | `menuTargetContext` 生成原 scope、资源判定、trash id/type；`resource.contextMenu` 共 47 条元数据 | 原目标数据与回调参数，未知 trash itemType 回落 note |
| 各行可见性（上文 golden 表） | 各条目的 `visible(context)`，逐条保留原条件 | 无回调仍显示的原条目不增加回调存在性检查 |
| 顺序/分隔线 | 每 scope 的显式 order 10、20…；原分隔线也独立贡献，visible 与原条件一致 | 不裁剪首尾或连续分隔线；不排序已过滤行 |
| 文案、图标、危险态/禁用态 | `labelKey/labelParams`、icon 标识与动态 icon/disabled/danger 元数据 | 原 learningHub namespace；原 MenuItem/Separator DOM、15px duotone 图标与 text-success |
| 同步动作后关闭 | `thenClose` | 参数求值/异常时是否继续关闭与原闭包一致 |
| 先关闭再延迟动作 | `afterClose` | 原 50ms；文件夹删除仍同步，资源删除仍延时 |
| 渲染期社区异常隔离 | `CommunityContentBoundary`；用官方值对象身份 WeakSet 区分官方/社区 | 不凭 owner id 判断：同 id 替换的社区贡献也隔离；官方不新增错误边界 |

官方入口 `src/ui-plugins/official/content/index.ts` 默认导出插件，id=`dstu.ui.content`，order=40。注册阶段只加载 React 与轻量元数据，无页面/CodeBlock/渲染引擎的新增静态导入。U1 可用既定 glob 自动发现，无须越界修改 install.ts。

### 文件说明

- `src/ui-kernel/contracts/content.ts`：Markdown 分派派生 props、菜单条目与原回调上下文类型（业务类型仅 type-only import）。
- 两个获授权的消费入口：`useSlot` 订阅 slot；Markdown components 仍稳定，贡献快照经原 runtime context 更新。
- `official/content/{index.ts,markdown.tsx,menu.ts}`：官方注册与等价条件/回调；`CommunityContentBoundary.tsx`、`officialValues.ts` 仅承担规格要求的社区渲染错误隔离。
- `official/content/__tests__/`：原 JSON 对照、贡献注册/卸载/重装、流式状态更新不重挂载、同 id 覆盖错误隔离、菜单退出 180ms 验证。

### 已发现的测试宿主依赖

- 旧 Markdown 单测直接 render 叶子组件，没有 UI provider（F1 前不需要）。作业 `20261104065518-c64400` 原样跑这些目录，退出 1，摘要 `Test Files 10 failed | 13 passed (23)` / `Tests 54 failed | 102 passed (156)`，共同错误为 `useUiKernel: missing <UiKernelProvider>`。未为迁就旧测试添加生产 fallback kernel/硬编码官方列表，也未修改旧测试。
- 在本 lane 允许目录内增加 `vitest.regression.config.ts`（extends 原 vitest.config.ts），唯一增加项为 `regression.setup.tsx`，仅给 testing-library 的 render 包裹真实 provider+官方插件，不 mock slot/被测逻辑、不改断言。原 repo setup 仍保留。
- 尝试 CLI `--setupFiles` 的作业 `20261104065902-9f8bf4` 退出 1（当前 Vitest 不支持该 CLI 选项），因此改为上述扩展配置；不是测试通过。
- 默认配置下的本 lane golden 测试自己显式创建 provider，不依赖该测试辅助配置。

### 不能宣称已迁移的范围

Mermaid/思维导图等 `CodeBlock.tsx` 下的语言/能力分派不在本 lane 授权范围，保留原实现，未声称它们已成为独立 slot 贡献。若架构师要求连同这些内部工具栏/状态机一起迁入 slot，需另行授权 `CodeBlock.tsx`（以及明确对应的 renderer API）；本轮只完成 `MarkdownRenderer.tsx` 现有的 pre/code 分派边界。也未迁移 span 的思维导图引用卡片（它是引用渲染，不是 code 语言分派）。

### 已取得的改造验证输出

首轮 golden 对照：

```text
 Test Files  2 passed (2)
      Tests  2 passed (2)
   Start at  14:52:57
   Duration  27.03s (transform 25.88s, setup 1.09s, collect 11.43s, tests 17.34s, environment 2.53s, prepare 610ms)

[作业 20261104065254-c918e9] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ --maxWorkers=2 --minWorkers=1
[作业 20261104065254-c918e9] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104065254-c918e9.log
```

类型检查前 `npm run version:generate` 原始退出码：`VERSION_GENERATE_EXIT=0`（生成 `src/version.ts` 为规定命令的产物，不提交该生成文件）。

```text
[作业 20261104065341-313721] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104065341-313721] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104065341-313721.log
```

以上两项原始输出均无 Errors 行。作业队列自动为 tsc 添加增量参数，原请求命令为 `npx tsc --noEmit -p tsconfig.json`。后续新增隔离/生命周期测试和轻量辅助配置后还须再检查。

### Golden 文案字段补充（不改原 JSON）

原菜单 DOM 取证字段 `id/labelKey` 实际存的是**翻译后文案**（如“刷新”），而不是 t 的键；这是取证命名不精确，并非生产文案变化。保留原文件逐字不动，另外在独立取证提交中增加 `menu-label-keys.json`。其来源为 `git show c3d573c5bcfd273953790a9587943aecc05d9c44:src/features/learning-hub/components/LearningHubContextMenu.tsx` 的原 `t('…')` 完整去重清单；对应测试从真实 slot 的静态/动态 labelKey 逐字段对照。捕获使用 `wx`，不会覆盖原 golden。

新的隔离测试最初把刷新文案误写成键 `common.refresh`，作业 `20261104070032-1eebbf` 因实际输出“刷新”而退出 1（原 golden 对照、Markdown 三项与 registry 均通过）。已将该**新增非-golden测试**的期望改为原 locale 的 `learningHubZh.common.refresh`，未修改 JSON 或生产逻辑；只重跑菜单文件的 `20261104070330-03a705` 退出 0，`Test Files 1 passed (1)` / `Tests 2 passed (2)`，无 Errors 行。

补充 key 清单首次作业 `20261104070529-17f0ca` 因提交环境不传递（ENOENT）退出 1，改为在命令本身显式 `env U4_CAPTURE_LABEL_KEYS=1`，后续不得覆盖既有文件。

## 最终轮验证（持续追加原始作业结果）

### 类型检查

本轮再次先执行 `npm run version:generate`，原始输出 `VERSION_GENERATE_EXIT=0`；队列结果：

```text
[作业 20261104070331-81d22b] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104070331-81d22b] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070331-81d22b.log
```

无诊断输出，无 Errors 行。`.lane.tsbuildinfo` 为队列生成的缓存，不提交。

### 本 lane 默认配置测试

```text
 Test Files  4 passed (4)
      Tests  7 passed (7)
   Start at  15:08:44
   Duration  23.70s (transform 15.35s, setup 1.46s, collect 8.49s, tests 14.39s, environment 3.74s, prepare 720ms)

[作业 20261104070842-c6f8d0] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ --maxWorkers=2 --minWorkers=1
[作业 20261104070842-c6f8d0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070842-c6f8d0.log
```

Errors 行：未出现。包含未修改的菜单/Markdown golden、补充 labelKey golden、安装/卸载、流式组件身份、同 id 社区替换隔离、菜单隔离和退出时序。

### 原 Markdown 目录回归（补真实 provider 的配置）

```text
 Test Files  21 passed (21)
      Tests  154 passed (154)
   Start at  15:00:35
   Duration  72.92s (transform 32.29s, setup 12.69s, collect 118.90s, tests 16.45s, environment 29.08s, prepare 5.00s)

[作业 20261104070032-6baf70] npx vitest run --config src/ui-plugins/official/content/vitest.regression.config.ts src/features/chat/components/renderers/__tests__ src/features/chat/components/__tests__/messageSearchContext.test.tsx --maxWorkers=2 --minWorkers=1
[作业 20261104070032-6baf70] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070032-6baf70.log
```

Errors 行：未出现。**不能把这个结果写成规格所要求的原默认配置回归全部通过**：原配置缺 provider 的失败见上，需 C1/U1 在共享测试宿主加上 UI provider（不在 U4 允许写入范围）。

### 生产构建（首次，原命令）

```text
vite v6.4.3 building for production...
transforming...
✓ 20725 modules transformed.

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted

[作业 20261104065518-036c54] npx vite build
[作业 20261104065518-036c54] 退出码 134；完整输出 /home/dsdev/.oc-jobs/done/20261104065518-036c54.log
```

Errors 汇总行未出现，但存在上述原始 FATAL ERROR，明确为**失败**，不是通过。已排队 `env NODE_OPTIONS=--max-old-space-size=8192 npx vite build`（`20261104070842-ea94b7`），只调整进程堆上限，不改构建配置。`npm run build:demo` 作业为 `20261104065518-709f45`，最终退出码待取得后追加。

### 提交清单与集成注意

- 补充 key 取证（独立提交）：`66fabc39c`。
- 生产改造已由协调者自动检查点保存：`58e255320`、`f94996c05`、`deba9f9b1`；验证修正提交：`55fd7153b`。
- 最后一次合并 main 未触及 U4 前端文件；本分支相对 main 的已提交文件清单全部在授权路径内。
- 不提交 `src/version.ts` 或队列缓存；它们是规定命令生成的未跟踪文件，并非主动越界修改。
- 最终状态仍有范围裁定与默认测试宿主差异，未声明 §5 所有门禁已通过；U1 的生产启动/provider/glob 安装仍由 U1 负责。

### 构建补充

加大单进程 V8 堆后，生产构建原始结果：

```text
[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m

[作业 20261104070842-ea94b7] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104070842-ea94b7] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070842-ea94b7.log
```

Errors 汇总行未出现；有 chunk size 等 warning，没有把 warning 当错误忽略。未修改构建配置。

原 demo 构建结果：

```text
✓ 20572 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted

[作业 20261104065518-709f45] npm run build:demo
[作业 20261104065518-709f45] 退出码 134；完整输出 /home/dsdev/.oc-jobs/done/20261104065518-709f45.log
```

Errors 汇总行未出现，但 FATAL ERROR 说明原命令失败。同样已通过队列提交 8GiB 堆版本 `20261104071522-272fe8`。

审读发现并修正性能等价细节：ContributedMenuRow 不应逐行新增 useTranslation 订阅。现在仍由原 LearningHub 菜单根组件唯一一次 `useTranslation('learningHub')` 取得稳定 t，作为派生 props 传给各行；不会因 47 条元数据增加 47 个 i18n hook。此修正后定向菜单测试作业 `20261104071504-66ba85`，类型检查前再次 version:generate（退出 0），tsc 作业 `20261104071505-557f17`。

### 最新代码最终结果

单 i18n 订阅修正已提交 `df44e3266`；报告阶段提交 `7e56b0674`。最终类型检查和 demo 构建的队列原始结果：

```text
[作业 20261104071505-557f17] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104071505-557f17] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071505-557f17.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 4s
[demo-build] warmup preloads injected into hero.html: 10

[作业 20261104071522-272fe8] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104071522-272fe8] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071522-272fe8.log
```

两项均无 Errors 行。定向菜单最后结果：

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  15:15:07
   Duration  7.48s (transform 1.34s, setup 477ms, collect 1.69s, tests 2.53s, environment 1.31s, prepare 243ms)

[作业 20261104071504-66ba85] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/menu.golden.test.tsx --maxWorkers=1 --minWorkers=1
[作业 20261104071504-66ba85] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071504-66ba85.log
```

无 Errors 行。两个最初 golden JSON 相对 `c3d573c5b` 的 git diff 为空；补充 key JSON 单独提交，没有重录原输出。

**交接结论**：授权入口的 slot 改造、官方插件注册、golden 对照及本 lane 测试通过；类型检查通过，生产/demo 构建在 8GiB 单进程堆下通过。仍不宣称完整 §5 无条件通过：默认配置的旧叶子组件测试缺 provider，需 C1/U1 接入共享测试宿主；CodeBlock 内 Mermaid 等独立语言注册需要架构师确认额外授权，已保留原逻辑。未做截图级视觉验收，也未越界改启动、共享测试配置或 CodeBlock。

## §6 裁定续作：CodeBlock 授权与轻量窗回退

以上结论为 `057c26eed` 时的历史交接状态。C1/架构师正式 §6 裁定已替代当时的两项限制：

- 轻量窗及无 Provider 首帧必须同步使用与插件注册同源的官方静态表，不给轻量窗装内核、不创建私有 kernel；不再以测试 wrapper 作为默认回归通过的替代。
- 来源判断统一 `entry.origin === 'builtin'`，撤销 WeakSet/owner 判断；U1 发布内核来源与可选 Provider hook。
- 允许新增改动 `CodeBlock.tsx` 与所列十个既有测试；本轮优先保留既有测试原样，正式静态回退应使它们直接通过。
- 新获授权的 CodeBlock 在**改造前**另作 `codeblock-dispatch.json` 可执行取证；只 mock Mermaid/富渲染终端、语法高亮终端和 HTML 预览终端，不替换语言/能力条件或运行按钮状态机。旧所有 golden 不重录。
- 覆盖原 19 个语言标签（含大小写 Mermaid、mindmap 未识别路径）、每个能力单开/全关/全开、流式前后，以及 Mermaid mindmap 在触屏/桌面、深浅色、demo 的组合；采集运行前/后的按钮文案/title/aria/disabled、源码、HTML/SVG/富渲染器 kind。原 Mermaid 只有手动运行才动态加载，模块应只求值一次。

纯取证作业结果（尚未修改 CodeBlock 生产文件）：

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  15:48:29
   Duration  42.92s (transform 34.04s, setup 677ms, collect 15.16s, tests 23.59s, environment 1.38s, prepare 236ms)

[作业 20261104074825-46ae28] env U4_CAPTURE_CODEBLOCK=1 npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/codeblock.golden.test.tsx --maxWorkers=1 --minWorkers=1
[作业 20261104074825-46ae28] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074825-46ae28.log
```

原始输出无 Errors 行。写入使用 `wx`，既有 JSON 无修改。

### §6 改造接口与恢复进度

- 新 CodeBlock 纯取证提交：`f854917e2`。重启后已核对该提交和 JSON 仍在，没有重复取证或重写 JSON。
- 改造检查点 `35b1ac7b7` 保存了 §6 静态表与来源改造；CodeBlock 分派及新增验证随后继续，不将 WIP 自报为通过。
- U1 已发布 `6bd437e73`：`useOptionalSlot<T>(name)` 在没有 Provider 时返回 undefined，存在 Provider 但 slot 已卸载时返回空数组；`SlotEntry.origin` 来自内核安装选项，未指定 install origin 默认 community。U4 使用这一正式接口，不自行创建 kernel/复制内核/捕获 hook 异常。
- `entries.ts` 导出稳定的 `officialMarkdownEntries` 与 `officialMenuEntries`；`index.ts` 重导出并把同一对象注册到 slot。消费方 `useOptionalSlot(...) ?? official…Entries`，只在**无 Provider**时回退；已卸载插件不会被静态表“复活”。轻量窗不依赖 Cordis、页面组件或新引擎同步导入。
- CodeBlock 把原 15 个已识别语言/别名的 kind/capability/richRendererKind 判定改为读取同一个 `markdown.codeBlocks` 表；math/latex 仍是 Markdown 原入口的组件贡献。原 `mindmap` 标签不识别，思维导图仍由 Mermaid 的 mindmap 语法走原手动运行路径，不新增语言。
- CodeBlock 的工具栏、SVG/HTML 渐进预览、XML/Mermaid 操作函数、RichCodeRenderer 调用与重引擎动态 import、缓存/错误 UI/复制导出/缩放平移均保留。没有增加渲染包装器以免流式状态重挂载。
- Markdown 和菜单只以 `entry.origin === 'builtin'` 判断是否免加社区边界；删除 `officialValues.ts`，不再使用 WeakSet 或 owner 字符串判断来源。同 ID 社区覆盖测试断言 origin=community；菜单还验证无关插件的正常菜单项仍在。
- 已删除此前临时的 `regression.setup.tsx` / `vitest.regression.config.ts`。最终回归将直接运行原 `vitest.config.ts` 和十个既有测试的原断言，不用 wrapper 掩盖缺 Provider。
- 新 CodeBlock/Markdown/菜单 golden 测试分别使用有 Provider 与无 Provider 两种宿主，对照**同一个原 JSON**；registry 测试断言静态表和实际 slot 元数据相等且 value 对象同一。
- 当前 main 尚无 U1 `6bd437e73`，因此本工作树暂时缺少 `useOptionalSlot` 和 origin 类型/安装选项。等 C1 将 U1 接口发布到 main 后再 merge 验证，不复制别的 lane 文件到本分支，亦不通过 mock 内核让门禁假绿。

### 再次中断恢复与前端测试映射

已按恢复指令执行 `git log --oneline -20`、`git status`。U4 不在 Host 命令账本的 lane 清单内，也没有独立后端 TESTMAP 文件；本报告及五个测试文件是前端验证映射，不另外越界创建 migration/testmap 文件。

| 验证文件 | 原行为来源 / 断言目的 | §6 状态 |
|---|---|---|
| `markdown.golden.test.tsx` | 原 Markdown pre/code 的 1584 条 golden；流式身份；同 ID 社区异常 | 无/有 Provider 都用同一原 JSON；新增真实卸载不回退断言 |
| `menu.golden.test.tsx` | 原 99 条菜单条件/图标/分隔线/50ms 关闭与回调序列 | 无/有 Provider 同 JSON；新增同 ID 社区异常不影响无关菜单行 |
| `codeblock.golden.test.tsx` | `f854917e2` 的原 CodeBlock 388 条语言/能力/手动运行组合 | 无/有 Provider 同 JSON，原方法/按钮/结果摘要逐字段不变 |
| `labels.golden.test.ts` | 固定旧提交原 t 键 → slot labelKey | 改为显式 builtin 安装 |
| `registry.test.ts` | 插件登记/撤销/重装生命周期 | 17 个语言 key、47 菜单条目与静态表对象身份/元数据一致 |

CodeBlock 改造与依赖记录提交：`b347e88df`；测试补充已由协调者检查点 `96500e323` 保存。没有重新执行纯取证，也没有修改既有 golden。

恢复指令所要求的 ledger 原始输出：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）

[作业 20261104080251-4a44fc] npm run migration:ledger -- --check --no-write
[作业 20261104080251-4a44fc] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080251-4a44fc.log
```

无 Errors 行。这个 Host 总账输出不是本 lane 前端 A 级证明。`npm run version:generate` 再次退出 0，类型诊断作业为 `20261104080622-5a5054`；用于区分缺 U1 正式接口的依赖错误与本 lane 自身错误，不把此前 §6 前的通过记录冒充新代码验证结果。

### 当前真实阻塞与原始类型诊断

```text
src/features/chat/components/renderers/CodeBlock.tsx(39,10): error TS2305: Module '"@/ui-kernel/react"' has no exported member 'useOptionalSlot'.
src/features/chat/components/renderers/MarkdownRenderer.tsx(33,10): error TS2305: Module '"@/ui-kernel/react"' has no exported member 'useOptionalSlot'.
src/features/chat/components/renderers/MarkdownRenderer.tsx(853,29): error TS2339: Property 'origin' does not exist on type 'SlotEntry<MarkdownCodeBlockContribution>'.
src/features/chat/components/renderers/MarkdownRenderer.tsx(877,29): error TS2339: Property 'origin' does not exist on type 'SlotEntry<MarkdownCodeBlockContribution>'.
src/features/learning-hub/components/LearningHubContextMenu.tsx(20,10): error TS2305: Module '"@/ui-kernel/react"' has no exported member 'useOptionalSlot'.
src/ui-plugins/official/content/entries.ts(27,77): error TS2353: Object literal may only specify known properties, and 'origin' does not exist in type 'SlotEntry<ContentCodeBlockContribution>'.
src/ui-plugins/official/content/entries.ts(28,79): error TS2353: Object literal may only specify known properties, and 'origin' does not exist in type 'SlotEntry<ContentCodeBlockContribution>'.

[作业 20261104080622-5a5054] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104080622-5a5054] 退出码 2；完整输出 /home/dsdev/.oc-jobs/done/20261104080622-5a5054.log
```

Errors 汇总行未出现；以上七条 `error TS…` 全部是 U1 正式接口尚未进入 main 的直接诊断，明确为失败，不算通过。`git branch --contains 6bd437e73` 仅返回 `ds-mig/U1-ui-boot`，main 仍为 `0409f4c8f`。这是其他 lane 接口未发布到集成基线的依赖阻塞，不是无法等价迁移，也不是自有代码未做。

**请 C1 先把 U1 `6bd437e73`（或包含相同 API 的后继提交）合入 main。** U4 随后只需 `git merge --no-edit main`，对新代码执行原默认配置目录测试、版本生成+tsc、生产/demo 构建并补原始作业结果。现阶段不重复运行必定缺 export 的测试/构建，不越权修改共享内核、不复活已删除的测试 wrapper。§6 新版本尚未取得通过的测试/构建结果，不能沿用前文旧版本结果宣称完成。

## 集成拒绝回执复核（2026-11-04，09:11Z 作业）

收到新的集成门禁拒绝后，已执行 `git status --short` 与 `git merge --no-edit main`，合并提交 `d4f4944a5`，正式 main 基线为 `081b3426d`。新的 main **依然没有** `useOptionalSlot` 或 origin；`git branch --contains 6bd437e73` 仍只返回 `ds-mig/U1-ui-boot`。拒绝回执的 app 类型错误正是上文保留的依赖错误，不能在 U4 通过越界复制内核或临时混合树修复。按本次指令执行的三项 Host 检查如下（全部经队列）：

```text
> deep-student@0.11.0 typecheck:host
> tsc -p tsconfig.host.json

[作业 20261104091119-027616] npm run typecheck:host
[作业 20261104091119-027616] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091119-027616.log

boundaries: scanned 2337 files, 0 violation(s), 166 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log

[作业 20261104091119-d34ab3] npm run migration:boundaries
[作业 20261104091119-d34ab3] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091119-d34ab3.log

No test files found, exiting with code 1

filter: src/ui-plugins/official/content
include: host/**/*.test.ts, electron/**/*.test.ts, scripts/electron-migration/**/*.test.ts

[作业 20261104091120-deaa70] npx vitest run -c vitest.host.config.ts src/ui-plugins/official/content --maxWorkers=1
[作业 20261104091120-deaa70] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104091120-deaa70.log
```

以上三项无 Errors 汇总行。Host 测试退出 1 是配置不包含 `src/`，**不是通过**；没有增加 passWithNoTests 或改配置掩盖此事实。Host 类型/边界通过也不能替代 app 类型/测试门禁。

回执另提及 `InputBarV2.staleContextRef.test.tsx` 的“20% 手动总结”失败。该文件和生产 `InputBarV2.tsx` 相对 main 无差异，且不在本 lane 授权修改范围。仅定向复现同名两个参数用例（不修改实现/测试/断言）：

```text
 ✓ src/features/chat/components/input-bar/__tests__/InputBarV2.staleContextRef.test.tsx (31 tests | 29 skipped) 174ms

 Test Files  1 passed (1)
      Tests  2 passed | 29 skipped (31)
   Start at  17:11:39
   Duration  18.19s (transform 23.62s, setup 597ms, collect 14.86s, tests 174ms, environment 1.03s, prepare 240ms)

[作业 20261104091120-0c5692] npx vitest run --config vitest.config.ts src/features/chat/components/input-bar/__tests__/InputBarV2.staleContextRef.test.tsx -t manually summarizes at 20 --maxWorkers=1 --minWorkers=1
[作业 20261104091120-0c5692] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091120-0c5692.log
```

原始输出无 Errors 行；29 skipped 来自 `-t` 只选择回执点名的两个参数用例，没有新增 `.skip`。这只能说明**定向未复现**，不能说整个文件/整批 app 测试已通过，也不能无证据定性为偶发故障。回执没有给完整失败断言/堆栈，若再次出现应由 C1 提供对应完整日志后定位，而非扩大 U4 范围盲修输入栏。

本轮未修改生产代码、未重录 golden。继续保留 §6 官方同源同步回退、真实空 slot 不复活与 origin 判定；正式 U1 依赖合入 main 后才恢复本 lane 默认配置前端回归。当前提交仍**未达到可集成通过状态**。

## U1 依赖到达 main 后的最终验证（2026-11-04 10:51–11:08Z）

`git merge --no-edit main` 后，`git merge-base --is-ancestor 6bd437e73 HEAD` 退出 0，即 U1 的 `useOptionalSlot`/`origin` 已在本分支基线中；当前 main `eeaf5bdc7` 已合并，没有带入新的 U4 相关前端改动。上文所有“缺 API / 4GiB OOM / Host 无 UI 测试”的失败记录保留为历史，不作为本轮结果。InputBar 两个定向用例（`20261104091120-0c5692`，退出 0）没有新变化，因此没有重跑。

### 原默认前端配置：本 lane + 十个授权原测试

没有 wrapper、没有修改全局 setup、没有 mock 全局 kernel。十个原测试的断言未改动；它们在无 Provider 下直接走同一份官方静态表。

```text
 ✓ src/ui-plugins/official/content/__tests__/menu.golden.test.tsx (4 tests) 6127ms
   ✓ matches original menu lists, conditions, icons and timing (provider=false)  3552ms
   ✓ matches original menu lists, conditions, icons and timing (provider=true)  2394ms
 ✓ src/ui-plugins/official/content/__tests__/markdown.golden.test.tsx (5 tests) 28774ms
   ✓ matches original pre/code dispatch for every golden input (provider=false)  15845ms
   ✓ matches original pre/code dispatch for every golden input (provider=true)  12651ms
 ✓ src/ui-plugins/official/content/__tests__/codeblock.golden.test.tsx (2 tests) 31423ms
   ✓ retains original CodeBlock dispatch and run timing (provider=false)  17519ms
   ✓ retains original CodeBlock dispatch and run timing (provider=true)  13901ms
 ✓ src/ui-plugins/official/content/__tests__/labels.golden.test.ts (1 test) 119ms
 ✓ src/ui-plugins/official/content/__tests__/registry.test.ts (1 test) 77ms
 （十个原测试文件全部 ✓，见完整日志）

 Test Files  15 passed (15)
      Tests  81 passed (81)
   Start at  18:51:50
   Duration  84.80s

[作业 20261104105148-51b9bf] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ src/features/chat/components/__tests__/messageSearchContext.test.tsx src/features/chat/components/renderers/__tests__/{FlowToken.lazyCode,MarkdownRenderer.bold,MarkdownRenderer.codeblock,MarkdownRenderer.flowtoken,MarkdownRenderer.identity,StreamingBlockRenderer.visibility,blockRenderSkip,streamingCompletion,streamingDefaults}.test.tsx --maxWorkers=2 --minWorkers=1
[作业 20261104105148-51b9bf] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105148-51b9bf.log
```

原始输出无 Errors 行。覆盖内容：
- **无 Provider 同源静态表**：菜单 99 条、Markdown 1584 条、CodeBlock 388 条组合，在 provider=false/true 下分别与同一份未修改的原 JSON 逐字段相等（CodeBlock 是 1 个测试遍历 388 组，不是 388 个测试）。
- **live 空 slot 不回填**：`uses static official entries only without a provider, not after plugin unload` 通过（有 Provider 且插件卸载后，math 不再渲染，回到原代码输出）。
- **origin 隔离**：Markdown 与菜单的“社区以官方同 ID 覆盖并抛错”用例均断言 `origin === 'community'`；错误被隔离，原始内容/无关菜单行仍在。
- 十个原入口：messageSearchContext、FlowToken.lazyCode、MarkdownRenderer.{bold,codeblock,flowtoken,identity}、StreamingBlockRenderer.visibility、blockRenderSkip、streamingCompletion、streamingDefaults 全部通过。

### 生产安装器接入

新增 `official-install.test.tsx`，只导入 U1 共享 helper `renderWithOfficialUi`（经生产 `installOfficialUiPlugins`，`origin: 'builtin'`），断言 slot 内容与 `officialMarkdownEntries`/`officialMenuEntries` 完全相等，且全部为 builtin。第一版额外做了 KaTeX 渲染断言，作业 `20261104105304-2358d7` 退出 1（与安装器无关的 mock 渲染路径），已删除这一无关断言；最终：

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
[作业 20261104105702-3e96c3] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/official-install.test.tsx --maxWorkers=1 --minWorkers=1
[作业 20261104105702-3e96c3] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105702-3e96c3.log
```

提交：`ea2863c28`（之前已由检查点 `303a17d46` 保存初版）。

### app 类型检查与构建（新版本）

先 `npm run version:generate`，`VERSION_GENERATE_EXIT=0`。

```text
[作业 20261104105148-6a6353] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104105148-6a6353] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105148-6a6353.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 13s
[作业 20261104105702-ed3e6f] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104105702-ed3e6f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105702-ed3e6f.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 17s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104105702-c50cda] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104105702-c50cda] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105702-c50cda.log
```

tsc 无诊断；两个构建只有 chunk size warning，没有 Errors 行或 FATAL ERROR。

### ledger（恢复指令要求）

```text
ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104105128-d4adbf] npm run migration:ledger -- --check --no-write
[作业 20261104105128-d4adbf] 退出码 0
```

这是 Host 命令账本；U4 是前端 lane，没有独立 TESTMAP，前端验证映射见本报告上文表格。

### 最终提交与交付状态

- 取证（纯取证，无改造）：`c3d573c5b`（菜单/Markdown）、`66fabc39c`（labelKey 补充）、`f854917e2`（CodeBlock）。
- 改造：`58e255320`、`f94996c05`、`deba9f9b1`、`55fd7153b`、`df44e3266`（菜单/Markdown slot 化）；`35b1ac7b7`、`96500e323`、`b347e88df`（§6 同源静态表、origin、CodeBlock 分派）；`ea2863c28`（安装器验证）。
- 原 golden JSON 相对其取证提交无任何修改。
- 规格 §1.3 的四项（版本生成+tsc、默认配置受影响目录测试、vite build、build:demo）在新版本上全部退出 0。

仍需如实说明：
- 未做截图级视觉验收；外观等价由 DOM/class/icon/文案逐字段 golden 与原测试证明。
- 构建按集成门禁 8GiB 堆预算运行；默认 4GiB 下此前 OOM 与本 lane 无关，未改构建配置。
- 只有上述受影响测试文件，没有跑全仓前端测试。

## 完成状态（standard-v2 §5 自检）

**已完成。** U4 全部提交（至 `27b38ef79`）已由 `2801af457 merge ds-mig/U4-ui-content` 进入 main；`git merge --no-edit main` 后分支头与 main 同为 `d84e29565`，无未合入提交。

- 自检：`lane-gate.mjs` 对 `d84e29565`（基线 main `d84e29565`）运行 typecheck、boundaries 两项，全部通过，退出 0。
- 前端验收证据见上节：默认配置 15 个文件 / 81 项通过（作业 `20261104105148-51b9bf`），安装器测试通过（`20261104105702-3e96c3`），app tsc（`20261104105148-6a6353`）、vite build（`20261104105702-ed3e6f`）、build:demo（`20261104105702-c50cda`）均退出 0。
- v2 §1 自查：适用于本 lane 的是“导出须有生产调用点”。`officialMarkdownEntries` / `officialCodeBlockLanguageEntries` / `officialMenuEntries` 的生产消费者为 `MarkdownRenderer.tsx`、`CodeBlock.tsx`、`LearningHubContextMenu.tsx`，插件由 `src/ui-plugins/official/install.ts` 的 glob 以 `origin: 'builtin'` 安装（`official-install.test.tsx` 验证）。其余条目（表归属、Rust struct/日志/断言/分支表）针对 Host 命令迁移，本 lane 无 Rust 对应物，不适用。
- U4 没有独立 `LANE.md`，且不在本 lane 授权路径内，因此完成证据记录于本报告。
- 剩余限制不变：无截图级视觉验收；未跑全仓前端测试。

## X6-SW-0009：教材重链接 owner 单元只读定位（C1 指令，未改 Host）

本节只读核对，未修改任何 Host 文件或 golden。`media/repository/textbook-files.ts` 与新测试 `tests/textbook-relink-owner.test.ts` 的窄授权尚未批准，批准前不动。基线：main `45c3250b0`，L18 分支头 `5058e7779`，L11 分支头 `2c5de3554`。

### Rust 原语与顺序（`src-tauri/src/cmd/textbooks.rs:701-779`）

1. `vfs_db` 缺失 → `Configuration("VFS database not configured")`。
2. `VfsTextbookRepo::get_textbook` 出错 → `Database("VFS 查询教材失败: …")`；无行 → `NotFound("教材不存在: {id}")`。
3. `hash_file_sha256(new_path)` 失败 → 原样传出（FileSystem `读取文件失败: …`，或空路径 Validation）。
4. 哈希不一致 → `Validation("所选文件与原文件内容不一致，请选择同一个文件")`，记录不变、无事件。
5. 同一个 blocking 任务、同一个 `conn`：`get_conn_safe` 失败 → `Database("获取 VFS 连接失败: …")`。
6. `UPDATE files SET original_path = ?1, updated_at = ?2 WHERE id = ?3`，`updated_at` 为 `%Y-%m-%dT%H:%M:%S%.3fZ`；失败 → `Database("更新 original_path 失败: …")`。**影响行数不检查**（行已在第 2 步确认）。
7. `read_all_bytes_bounded(new_path, 200 MiB)` 失败 → 原样传出。
8. `attach_blob_if_missing_with_conn(&conn, …)`（`textbook_repo.rs:975-1014`）：无行 NotFound；已有 blob 返回 false；否则存 blob 并 `UPDATE files SET blob_hash, updated_at`。失败 → `Database("补存 blob 失败: …")`。
9. 重新 `get_textbook`，发 `dstu:change:/{id}` 与 `dstu:change` 两个 `updated` 事件，返回 `to_textbook()`。

**整个过程没有事务。** 第 6 步写入后，第 7/8 步失败不会回滚 `original_path`。owner 原语不能把 UPDATE 和补存 blob 包进同一个事务或 SAVEPOINT，否则会改变失败后的数据库状态。

### L11 files 公开面现状

- `host/plugins/vfs-repos/types/files.ts` 的 `FileRepository` 只有 `updateFileName`、`updatePdf*`、`updateCompressedBlobHash`、`applyProcessingStatus` 等按列写入的方法，**没有只改 `original_path/updated_at` 的原语**。最接近的几个都会多改其他列，不能代替。这与 `host/plugins/media/BLOCKERS.md` 的 L18-B01 一致。
- `TextbookRepo.attachBlobIfMissing`（`vfs-repos/repository/textbooks.ts`）已与 Rust 第 8 步等价，L18 已经通过公开面调用它。
- 时间格式：L11 `utcTimestamp()`（`timestamps.ts`，Millis + `Z`）与 L18 `utcMillisTimestamp()`（`toISOString()`）在 0–9999 年内输出相同。迁到 owner 后建议由调用方继续传入 `updatedAt`，签名对齐 BLOCKERS 里的 `relinkOriginalPathWithConn(conn, id, path, updatedAt)`，这样不用在两处各生成一次时间。
- 越权 SQL 的位置：`host/plugins/media/repository/textbook-files.ts:18-26` `updateTextbookOriginalPath`，由 `media/index.ts` 的 `textbooks_relink` 调用。同一文件里的 `fileBlobHash`/`blobRelativePath` 也读 L11 的 `files`/`blobs`，不在本单元范围，另行报告。

### 建议的单元边界（批准后由单一编辑者执行）

- L11 在 `FileRepository`（或 `TextbookRepository`）加一个方法，只执行 Rust 第 6 步那条 UPDATE，不检查影响行数、不开事务，SQL 只留在 L11 repository。
- L18 的 `textbook-files.ts` 删除 `updateTextbookOriginalPath`，改为通过 vfs-repos api 调用；**不把 SQL 复制到新位置**。
- `media/index.ts` 的注入改动交 L18 原 owner，或另行审批。注意 L18 分支 `3ad812d19` 已把本命令的 hash/read 改成 `await`（尚未进 main），改 index.ts 必须基于这个提交，避免冲突。
- WIP 核对：L18 工作树当前只有 `host/plugins/media/LANE.md` 未提交；L11 工作树未提交的是 `repository/textbooks.ts`（create_textbook 的 savepoint 日志）和 `src/worker-entry.ts`，都不涉及 relink 或 files 原语。

### 生产 invoke 验证清单（`host.invoke('textbooks_relink', { id, newPath })`，前端调用点 `TextbookContentView.tsx:580`）

| 场景 | 期望 | 现有覆盖（`media/tests/media-commands.test.ts`） |
|---|---|---|
| 正常：哈希一致、无 blob | 返回 Textbook DTO；`original_path=newPath`；`updated_at` 变化；补存 blob；两个事件发往来源窗口 | 已有（:572） |
| 正常：已有 blob、换路径 | 只更新 `original_path`，blob 不重复 | 已有（:609-615） |
| 哈希不一致 | Validation；记录与事件都不变 | 已有（:618） |
| 缺教材行 | `NotFound 教材不存在: id` | 已有（:635） |
| 缺文件（路径不存在） | FileSystem `读取文件失败: …`；`original_path` 仍为 null | 已有（:643） |
| DB 失败：UPDATE 被拒（如测试库建 `BEFORE UPDATE OF original_path ON files … RAISE(ABORT,'x')` 触发器） | `Database 更新 original_path 失败: x`；`blob_hash` 仍为 null；无事件 | **缺**，应放在新 owner 测试里 |
| UPDATE 后读文件失败 / 补存失败 | 错误原样传出或为 `补存 blob 失败: …`；`original_path` **已更新不回滚**；无事件 | **缺**，用来锁住“无事务”语义 |
| owner 原语单测 | 只改 `original_path/updated_at`；其他列不变；行不存在时不报错 | **缺**，归 L11 |

触发器只在测试库里建，用来经生产 invoke 制造 DB 失败，不 mock repository。完成后交 R1 复核。U4 已关闭的前端子项不受影响。

### C1 候选依赖更新：L11 已提供实现，待正式集成与 Host 授权

本节替代上文“缺 owner 原语”的当前状态判断，保留原始只读取证。只读核对提交对象，未合入其他 lane 分支、未复制实现、未修改 Host。

- **实现/契约**：`f55aedcee` 的 `repository/textbooks.ts:538` 与 `types/content.ts:45` 提供 `ctx.vfsRepo.textbooks.setOriginalPathWithConn(conn, id, path): number`。只执行 `UPDATE files SET original_path, updated_at WHERE id`，时间由 owner 的 `utcTimestamp()` 生成；返回 `changes`，零行返回 0；无事务、不捕获 SQL 错误。因此采用这个现有签名，不再要求上文建议的调用方传入 `updatedAt` 或新增 files 方法。
- **owner 测试**：`b3a999135` 的 `tests/textbooks.test.ts` 验证返回 1、路径、毫秒 Z 时间格式，并用整行前后比较确认其他列不变；缺行返回 0。上表“owner 原语单测缺失”现已由候选覆盖，但不等于生产命令接入已完成。
- **提交归属**：`87b5ab5be` 是接缝说明加 breadcrumbs 实现，不能当成此写入原语的唯一实现提交。
- **验证来源**：C1 已亲取作业 `20261104144515-dfd4f5`，两文件 15 passed、退出 0；这是 C1 提供的候选验证，不冒充 U4 独立运行。当前 main `879e0a56b` 上 `git merge-base --is-ancestor f55aedcee main` 退出 1，故依赖状态是“候选已有、尚未正式进入 main”，不再报“提供方未实现”。
- **编辑边界不变**：Host 窄授权尚未批准，不改 `textbook-files.ts` 或新测试；`index.ts` 继续由 L18 单一编辑者基于 `3ad812d19` 异步读取后继接入。`attachBlobIfMissing` 沿用已有公开面，不重写 L18 WIP。

批准后经真实 `host.invoke('textbooks_relink', …)` 分开验证，不能用同一个拒绝 UPDATE 用例替代：

1. **UPDATE 自身失败**：测试库 `BEFORE UPDATE OF original_path` trigger 拒绝更新。断言 `Database / 更新 original_path 失败: …`、路径/时间保持原值、没有新增 blob 或事件；并观察后段读取/补存没有执行（如测试侧对真实函数做 call-through 观察，不替换生产逻辑）。这只证明错误顺序与停止后续步骤。
2. **UPDATE 成功，后段失败**：另设正常 UPDATE 后的读取失败，或对后续 blob 写入设失败 trigger，实际走到 `补存 blob 失败: …`。断言路径已更新、更新时间已写入、无成功事件；重新查询数据库证明前段写入不回滚。此场景才证明 Rust 的无事务部分成功语义。读取失败与 blob 失败的错误前缀分别核对，不能混用。

本轮不重复前端 golden、构建或已签验收；前端关闭状态不变。当前仅完成候选依赖判断及验证清单澄清，未声明 Host 接入完成。

## Linux 续作恢复（2026-11-05）

已执行 `git log --oneline -30`、再次 `git log --oneline -20` 与 `git status`，完整阅读本报告及 FRONTEND-F1/FRONTEND 规格。U4 无独立 LANE/SPEC/TESTMAP/BLOCKERS，验证映射与阻塞记录均在本报告；不把 Host 总账作为前端完成证据。恢复时仅有未跟踪的 `src/version.ts`，保留且不提交。

`git merge --no-edit main` 成功，恢复基线为 `e9df01a3c`；U4 无未合入提交。集成记录对 U4 为“无新提交”，没有当前 U4 门禁拒绝；`coord.mjs errors U4-ui-content` 只显示旧 provider.content-filter 中断。未重做生产改造、未改任何 golden；菜单/Markdown JSON 对 `c3d573c5b`、CodeBlock JSON 对 `f854917e2` 的 diff 均为空。

### relink 依赖已正式发布，消费仍待 L18/授权

- `git merge-base --is-ancestor f55aedcee main` 原始退出码 **0**：上节“候选尚未进 main”已过时，L11 owner 原语现在已正式发布。
- 只读核对 `host/plugins/vfs-repos/repository/textbooks.ts:538–540`、`types/content.ts:45`：签名仍为 `setOriginalPathWithConn(conn, id, path): number`，只写 `original_path/updated_at`、返回 changes、不开事务、不捕获 SQL；`tests/textbooks.test.ts:147–155` 保留整行比较与缺行返回 0 的断言。未重复运行提供方测试。
- `host/plugins/media/index.ts:709` 仍调用 `updateTextbookOriginalPath`，`repository/textbook-files.ts:18–26` 仍直接写 `files`；所以只能关闭“提供方未发布”阻塞，不能宣称消费接线完成。当前 main 的 hash/read 已为 `await`，后继接入须保留。
- Host 窄授权仍未见，不编辑 Host 或 index；index 继续 L18 单编辑者。已通过 `coord.mjs queue C1-app - --from U4-ui-content` 投递上述证据。UPDATE 失败停止后段与 UPDATE 成功后读/blob 失败不回滚仍是两个独立验证场景，沿用上节清单。

按本次 Linux 恢复指令（不是重新签收旧验收）运行版本生成、app 类型检查、原默认配置本 lane/十个授权测试与只读 ledger，原始结果随后追加；不重复既有生产/demo 构建或截图验收。

### Linux 首轮回归：失败，不计通过

`npm run version:generate` 原始退出码 0。原默认配置、两个 worker 的本 lane 六个文件与十个既有文件回归：

```text
 Test Files  2 failed | 14 passed (16)
      Tests  2 failed | 80 passed (82)
     Errors  1 error
   Start at  08:07:50
   Duration  213.29s

[作业 20261105000403-138e50] 退出码 1
完整输出 /home/dsdev/.oc-jobs/done/20261105000403-138e50.log
```

- 菜单无 Provider 的 99 组矩阵耗时 6177ms，超过默认 5000ms；有 Provider 同矩阵 4428ms 通过。
- `FlowToken.lazyCode` 的首次 fenced-code 懒加载用例耗时 5260ms，超过默认 5000ms；后续主内容高亮/复制/流式节点身份与 list/blockquote 用例通过。
- 未处理错误为 `[vitest-worker]: Timeout calling "onTaskUpdate"`；即使其余测试通过也不能忽略 `Errors 1`。
- 首轮没有发现 golden 字段差异或 import 大小写错误。先以原配置、单 worker 定向重跑两个失败文件以定位，不直接改生产代码、golden 或断言。

Linux app 类型检查已完成（之前的 `version:generate` 退出 0）：

```text
[作业 20261105000417-f44c7c] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261105000417-f44c7c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105000417-f44c7c.log
```

无类型诊断，无 Errors 行。增量参数与缓存由队列添加，不提交缓存；该通过不替代上文失败的测试结果。

### 超时定位与测试侧修正

未改代码/断言的两个失败文件单 worker 复测：

```text
 Test Files  2 passed (2)
      Tests  10 passed (10)
   Duration  37.36s
[作业 20261105001138-f0a872] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105001138-f0a872.log
```

原始输出没有 Errors 行。菜单无 Provider 矩阵 4568ms，首次 FlowToken fenced-code 冷加载 4473ms：两者接近默认 5000ms，不改行为即可通过单 worker。首轮 Markdown/CodeBlock 两种 Provider 矩阵各文件累计 70–75 秒；连续同步渲染或只 flush microtasks 会阻塞 worker 处理 runner RPC 回复。因此仅修改测试执行预算/调度：

- 菜单 99 组矩阵用例设 15000ms；FlowToken 首次真实 Prism 懒加载的等待设 10000ms、外层用例设 15000ms。没有 mock 高亮器、预加载该重模块、删除输入或放宽结果断言。
- Markdown 每个完整 demo/dark/streaming 批次、CodeBlock 每个完整 capability 批次后 `await setImmediate()`，只给 runner 一个事件循环轮次；不在被测交互/假时钟 49/50ms、179/180ms 序列中插入等待。所有输入、顺序与 JSON 逐字段断言不变。
- 不改全局 Vitest 配置、RPC 超时或生产文件。修正后仍以原默认配置、两个 worker 重跑同一 16 文件集合；在结果返回之前不声明修复已通过。

修正后同一集合（六个本 lane 文件与十个授权原测试）、原配置双 worker 结果：

```text
 Test Files  16 passed (16)
      Tests  82 passed (82)
   Start at  08:16:43
   Duration  138.65s

[作业 20261105001629-d423d7] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ src/features/chat/components/__tests__/messageSearchContext.test.tsx src/features/chat/components/renderers/__tests__/{FlowToken.lazyCode,MarkdownRenderer.bold,MarkdownRenderer.codeblock,MarkdownRenderer.flowtoken,MarkdownRenderer.identity,StreamingBlockRenderer.visibility,blockRenderSkip,streamingCompletion,streamingDefaults}.test.tsx --maxWorkers=2 --minWorkers=1
[作业 20261105001629-d423d7] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105001629-d423d7.log
```

原始输出无 Errors 行，无未处理错误。Browserslist 过期提示保留，不修改依赖。不能由此声称重现了相同 CPU 压力或唯一证明 RPC 超时根因；已确认修正后同集合通过，且所有行为/golden 断言仍成立。首次失败和单 worker 定位结果均保留，不以重跑覆盖失败记录。

四个测试文件已被协调者自动检查点 `f6fb169d0` 保存（4 files changed, 10 insertions(+), 4 deletions(-)）。`git diff` 无这些文件不代表改动丢失，已用 `git log -1 --stat -- <四个文件>` 与关键行确认仍在 HEAD。再次比较三份原 golden 与取证提交，diff 均为空；未提交生成的版本文件。

### 恢复指令要求的只读 ledger 结果

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3633, not vetoed)

[作业 20261105000403-b1d9de] npm run migration:ledger -- --check --no-write
[作业 20261105000403-b1d9de] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105000403-b1d9de.log
```

无 Errors 行。保留原始 `unreachable 16` 与 `unknown 3633` 提示；这是全仓 Host 账本，不给 U4 虚报 A/B 比例，也不表示教材 relink 的 owner 消费已完成。

### 最终 tip 正式自检交接（C1 指令）

测试侧修正后再次先运行 `npm run version:generate`（退出 0），app 类型检查原始结果如下，无诊断、无 Errors 行：

```text
[作业 20261105001655-506d25] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261105001655-506d25] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261105001655-506d25.log
```

C1 已独立核对 `f6fb169d0` 四个测试 diff、首轮失败/单 worker 定位/修正后 82 项通过的原日志与 app tsc 原件。签收仅限测试执行预算与批次间 yield，不声称唯一证明 CPU/RPC 根因，不扩大到 GUI/实机平台验收。Host 仍未授权 U4，L18 单写者与两个失败顺序场景保持。

本节先提交，然后合并 main、对最终 tip 运行正式 `node scripts/electron-migration/lane-gate.mjs`，按它的实际检查列表执行，不另跑旧 82 项作为信心检查。此前旧 tip 的 selfgate receipt 不作为当前提交的门禁证据。门禁原始输出与退出码经最终回执/协调信箱交付，之后不为补确认另加提交，使分支 tip 与正式自检 receipt 一致。

生成物归属：`src/version.ts` 为本轮规定 `version:generate` 的未跟踪输出（最近内容 Git hash=`c92b60ec`），不是用户手写源码；未纳入提交。按 C1 清洁前置指令仅清理该确切生成文件，不改 `.gitignore`/git exclude/门禁配置、不提交占位版本、不操作其他未跟踪文件。官方 gate 会自行先 version:generate 再 app 类型检查；其生成物在所有使用它的作业完成后同样定点清理。若 gate 报前置或执行失败，保留原始退出码/确切路径并上报，不以定向通过代替正式 gate。

## WP-099：模板预览 25 条 CSP 错误的最窄定位（只读审计，未改生产代码）

结论：25 条全部能对到具体生成点。其中 9 条发生在父文档，原因是 DOMPurify 解析时遇到模板自带的 `onclick`，脚本从未执行，所以对功能没有影响。另外 16 条发生在 srcdoc，是内置模板正面自带的 9 个 `onclick` 和 7 段 `<script>` 被父页面 CSP（经 srcdoc 继承）拦下。这 16 条对应的模板交互确实不可用。按源码与提交史推断，Tauri 生产版也会这样拦截，因此 Electron 在这一点上与 Tauri 等价。要让这些交互恢复，必须改变 CSP 策略、改变预览隔离架构或迁移模板数据，三条路都需要架构裁定，本包不自行豁免。

### 原件与版本对齐

- 原件：`/tmp/opencode/x1-real-dist-LWCpSJ/routes/view_template-management.log.json`（`launch.json`：mode `real-dist`，tip `b7531562a`，分支 `ds-mig/X1-e2e-smoke`）。`trace` 共 204 条，`pageErrors` 0 条。其中 CSP 违规 25 条，seq 为 1981–2004 和 2013。全部 X1 路由日志里另有 2 条 CSP 违规，不属于本页，见文末“范围外”。
- `git diff --stat b7531562a HEAD` 覆盖 `src/components/previews`、`SharedPreview.tsx`、`ShadowDomPreview.tsx`、`cardMedia.ts`、`templateRenderService.ts`、`src/features/template-management`、`src-tauri/tauri.conf.json`、`electron/shell/{protocols,plugin-ui-protocol}.ts`，结果为空，所以以下源码行号对原件有效。本工作树 `dist/assets/vendor-micro-Bz9sacW8.js` 的文件名哈希与原件 `source` 一致。
- 数据来源：seq 1977 `get_all_custom_templates` 返回 16 个内置模板。`host/plugins/anki/data/builtin-templates.json`、`src-tauri/src/data/builtin-templates.json`、`src/data/anki/builtin-templates.json` 三份 sha256 相同（`8cc8d004…ca78b9`），Rust 端由 `src-tauri/src/commands.rs:4901` 的 `include_str!` 加载。因此模板输入与 Rust 既有数据逐字一致，不是迁移引入的。

### 生成链（只读源码）

1. `TemplateBrowser.tsx:144-145`（卡片默认 `previewSide='front'`，:141）调用 `renderPreview(front_template…)`，即 `TemplateManagementApp.tsx:580-601` 的 `TemplateRenderService.renderCardDetailed` 加 `preview_data_json`。
2. `TemplateBrowser.tsx:37-78` `ScaledTemplatePreview` → `IframePreview`（`SharedPreview.tsx:7` = `ShadowDomPreview`），`ShadowDomPreview.tsx:33-45` 固定 `mode:'template-safe'`。
3. `HtmlSandboxPreview.tsx:60-72` 在 `useMemo` 中执行 `sanitizeHtmlForPreview`。`htmlSandboxPolicy.ts:79-86` 的 template-safe 分支用 DOMPurify，且 `ADD_TAGS` 含 `script`、`ADD_ATTR:['onclick']`，即有意保留模板脚本（提交 `b1c9c6725`，2026-10-01，“7 个内置模板依赖脚本……与 Anki 一致”）。
4. `htmlSandboxPolicy.ts:134-156,218` 拼出 srcdoc：先是 meta CSP（:102-116，`script-src 'unsafe-inline'`），再是应用自有的 `TEMPLATE_RESIZE_SCRIPT`（:25-44），最后是模板 HTML。`HtmlSandboxPreview.tsx:117-124` 渲染 `<iframe sandbox="allow-scripts" srcDoc=…>`。
5. 父页面 CSP：`src-tauri/tauri.conf.json:38` 的 `script-src 'self' 'sha256-5DNq…' 'sha256-5evs…'`。Electron `electron/shell/protocols.ts:116-129` 原样读取该串，经 `plugin-ui-protocol.ts:218-242` `augmentRendererCsp` 仅追加 `ds-plugin: blob:`，作为 `tauri://` 页面响应头下发。原件中拦截信息引用的正是这个策略串。

### 25 条逐条分类

| seq | 文档 / source:line | 类型 | 生成点 | 功能影响 |
|---|---|---|---|---|
| 1981–1989（9） | 父文档 `vendor-micro-Bz9sacW8.js:2` | inline event handler | DOMPurify 在父 realm 中 `new DOMParser().parseFromString(...)` 解析带 `onclick` 的模板（`vendor-micro` 第 2 行即 DOMPurify，见 `vite.config.ts:466` 分组；该行含 `parseFromString`） | 无：解析文档中的 handler 不会执行，sanitize 输出仍保留 `onclick`（随后进入 srcdoc 的 9 条可证） |
| 1990–1993、1996–1998、2001、2004（9） | `about:srcdoc:0` | inline event handler | 模板 `front_template` 自带的 `onclick`：nomenclature、seminar、marginalia、footnote、monograph、botanical、architect、polaroid、swiss（每个模板 1 个） | 有：点击揭示/翻转等前端交互被拦 |
| 1994 | `about:srcdoc:123` | inline script | design-eink 正面脚本 `sha256-d9Q8…Bp4=` | 有 |
| 1995 | `about:srcdoc:112` | inline script | design-lexicon `sha256-0lQn…G4Q=` | 有 |
| 1999 | `about:srcdoc:119` | inline script | design-polaroid `sha256-ptd+…e/g=` | 有 |
| 2000 | `about:srcdoc:106` | inline script | design-glass `sha256-zEZz…RZE=` | 有 |
| 2002 | `about:srcdoc:112` | inline script | design-redaction `sha256-jRh5…thk=` | 有 |
| 2003 | `about:srcdoc:116` | inline script | design-lab（脚本含 Mustache，渲染后）`sha256-3foa…PsY=` | 有 |
| 2013 | `about:srcdoc:120` | inline script | design-manuscript（脚本含 Mustache，渲染后）`sha256-dPbY…sn4=` | 有 |

取证方法：对 seq 1977 的模板，用生产 `TemplateRenderService.renderCardDetailed`（以 esbuild 打包源码，作业 `20261105165827-797649` 退出 0）按 `TemplateManagementApp.tsx:580-601` 同参渲染正面，对每段 `<script>` 文本取 sha256（作业 `20261105170746-b1bdc9` 退出 0）。7 个哈希与原件逐一吻合；其中 5 个直接等于模板原文脚本哈希，lab/manuscript 只在 Mustache 渲染后才吻合。正面渲染结果含 inline handler 的模板正好 9 个，含脚本的正好 7 个（polaroid 两者都有），design-exam 两者都没有。handler 类报文不带哈希，所以 9 个 srcdoc seq 与 9 个模板只能按数量对应，单条 seq 对哪个模板未定。父文档 9 条同理。

“正式生成脚本”（应用自有）的结论：`TEMPLATE_RESIZE_SCRIPT` 的哈希经计算为 `5DNq…VwU=`，恰是父 CSP 白名单第一项；`CARD_FACE_HELPER_SCRIPT`（`cardMedia.ts:137-171`）为第二项 `5evs…TG0=`。模板管理页不注入后者。16 个 iframe 中 resize 脚本均未报错。25 条里没有一条来自应用自有脚本，全部是模板输入。

### 父 CSP 继承与 iframe sandbox 的相互作用

- srcdoc 文档继承父文档的策略容器，原件拦截信息引用的正是父策略串，可证明 Electron/Chromium 下确实继承了。srcdoc 自己的 meta CSP（`script-src 'unsafe-inline'`）与继承策略同时生效、取交集，只能收紧不能放宽。所以 srcdoc 内能执行的内联脚本只有父白名单里的两个哈希。
- `sandbox="allow-scripts"`（不含 `allow-same-origin`）只决定 opaque origin 和是否允许运行脚本，既不覆盖也不放宽 CSP。“沙箱 + 禁联网即可运行模板脚本”（`htmlSandboxPolicy.ts:76-78` 注释）这个前提，在父 CSP 不含 `unsafe-inline` 时不成立。
- 内联事件处理器不能用哈希放行，除非加 `'unsafe-hashes'`（原件报文原文已说明）。
- `src/components/previews/__tests__/htmlSandboxPreview.cspContract.test.ts` 锁定 `script-src` 的哈希集合必须恰好等于两个 helper 哈希，并禁止 `'unsafe-inline'`。这是现行策略的正式契约。

### Rust/Tauri 既有行为（推断，待真实运行验证）

- Electron 与 Tauri 使用同一 `tauri.conf.json:38` 策略串，Electron 只多出 `ds-plugin: blob:`，不影响内联判断。在相同继承语义下，16 条 srcdoc 拦截与 Tauri 等价。
- 推断依据：提交 `3916e7a85`（2026-10-17，“修复 WebKit 复习长卡……生产 CSP 阻断”）只把两个 helper 脚本的哈希加入父 CSP，就解决了 srcdoc 内 helper 被拦截的问题。这只有在 Tauri 生产版（WebKitGTK/WKWebView）srcdoc 也继承父 CSP 时才成立。由此推断，同一生产版里模板自带的 `<script>`/`onclick` 自那以后同样被拦，即 `b1c9c6725` 与 `3916e7a85` 之间存在未被发现的既有冲突（dev 模式无此 CSP，所以开发时看不到）。
- **待 A/真实运行验证**：(a) Tauri 生产构建打开模板管理页，看 WebView 控制台是否出现同样的 16 条 srcdoc 拦截，以及 polaroid/lexicon 等卡片的点击交互是否失效；(b) WebKit 在 DOMParser 解析时是否也报出父文档那 9 条（属于报告行为差异，与功能无关）；(c) 父文档 9 条的产生机制（Chromium 对 DOMParser 文档沿用窗口 CSP，在设置内联 handler 属性时上报）只由“source 行 = DOMPurify 所在行，数量 = 含 onclick 的模板数，时间早于 iframe 加载”间接确认，没有引擎内部证据。本包没有真实运行 Tauri 或 Electron，不虚构运行证据。

### 最窄方案与冲突

1. **父文档 9 条**：不影响功能，不改 CSP。最窄做法是由 `htmlSandboxPolicy.ts` 的合法 owner 评估：改在不关联窗口 CSP 的惰性文档中解析（例如 `document.implementation.createHTMLDocument` 后用 DOMPurify `IN_PLACE`/节点输入），并用现有 `htmlSandboxPolicy.test.ts` 断言 sanitize 输出逐字不变。该做法能否消除 Chromium 上报属于待真实运行验证项。若 Tauri/WebKit 同样上报，或输出有任何差异，就维持原状，把这 9 条登记为与 Tauri 等价的已知报告噪声，由 X1/C1 归类，不计为迁移缺陷。
2. **srcdoc 16 条**：在“不放宽现策略、不删模板脚本”的约束下，**不存在**能让模板交互恢复的改法；若要求 Electron 与 Tauri 等价，正确做法就是不改。要恢复交互，三条路都与现策略冲突，需架构师/C1 裁定：
   - A. 父 CSP 增加 7 个模板脚本哈希，并为 9 个 handler 加 `'unsafe-hashes'` 与对应哈希：属于改变策略，违反 `cspContract.test.ts` 的“哈希集合恰为两个 helper”；对模板版本和 Mustache 字段数据很脆弱，也覆盖不了用户自定义模板。
   - B. 预览改为独立 origin 的文档（自定义协议响应，自带 CSP，不继承父策略）：属于改变隔离架构，要在 Electron（F2 协议）、Tauri（Rust 协议）和前端预览三处同时实现才能保持等价，等于新增包装层，本包禁止。
   - C. 迁移 16 个内置模板，去掉内联 `onclick`，脚本改为应用自有并加入白名单：属于修改模板数据（三份 JSON 须同步），且无法覆盖用户已有的自定义模板。

### 准确需修改路径与 owner（均不在本 lane allowlist，本包未改）

| 路径 | 涉及 | owner |
|---|---|---|
| `src/components/previews/htmlSandboxPolicy.ts`、`__tests__/htmlSandboxPolicy.test.ts` | 方案 1；方案 A/B 的前端侧 | 前端预览没有现成 lane，需 C1 指定合法前端 owner |
| `src-tauri/tauri.conf.json:38`、`config/dev-phone-window.json`、`src/components/previews/__tests__/htmlSandboxPreview.cspContract.test.ts` | 方案 A（策略变更） | 架构师/C1 裁定后再指定；现无 lane 允许写入 |
| `electron/shell/protocols.ts`、`electron/shell/plugin-ui-protocol.ts` | 方案 B 的 Electron 侧；方案 A 无需改（直接读 conf） | F2 |
| `host/plugins/anki/data/builtin-templates.json` 与 `src-tauri/src/data/`、`src/data/anki/` 两份副本 | 方案 C | L16（host 份）；另两份需 C1 指定 |
| `src/features/template-management/components/TemplateBrowser.tsx` | 无需修改（只传递 HTML） | — |

### 最窄后继工作包建议

1. **WP-A（真实运行验证，无代码改动）**：Tauri 生产构建与 Electron real-dist 各打开一次模板管理页，记录 srcdoc 的 16 条拦截与 polaroid/lexicon 交互结果，并核对父文档 9 条在 WebKit 下是否出现。结果决定 16 条能否登记为“与 Tauri 等价”。
2. **WP-B（裁定）**：C1/架构师在“维持等价（推荐，不改）”与 A/B/C 之间选择，明确 `b1c9c6725` 与 `3916e7a85` 的意图冲突以哪个为准。
3. **WP-C（可选，仅在 WP-A 证实 9 条为 Electron 独有且需要清零时）**：由指定前端 owner 按方案 1 改 `htmlSandboxPolicy.ts` 的解析文档，并保证输出逐字不变。

### 范围外记录

X1 其他路由另有 2 条 CSP 违规：`window_pomodoro-mini`、`window_quick-assistant` 的 `index.html` 内联脚本 `sha256-nXhB…iII=`（经计算为 `index.html:16-35` 的内联脚本，`dist/index.html` 相同，且不在 `tauri.conf.json` 白名单中）。Tauri 构建时可能会自动把 HTML 内联脚本的哈希注入 CSP，而 Electron `serveDist` 没有这一步，这可能是 F2 侧的行为差异，但未经验证，交 F2/X1 另行定位，本包不展开。`workbench_templates` 路由导航超时（原件 `navigationError`），没有可用证据。

## WP-249：模板 CSP 修复（D-154 方案 a）——模板部分已交，剥脚本部分停下待裁定

授权依据：D-154（C1 裁定方案 a）、S0 `89fd8e592` 给 U4 临时加 4 个文件。截至 03:07Z，`git merge-base --is-ancestor 89fd8e592 main` 退出 1，授权还没进 main，所以按 S0 02:06Z 约定先提交，lane-gate 等它进 main 后再跑。本轮协调者注入的允许路径仍是旧列表，不含这 4 个文件；这里以 D-154 + WP-249 派发为准，如需撤回由 C1 指示。

### 已交：模板改造（提交 `d656b5274`，起草稿被检查点 `6ad5a90fb` 保存）

三份 `builtin-templates.json` 用同一脚本生成，sha256 都是 `9932e2dc…8e03cc6`（原 `8cc8d004…ca78b9`）。改了 11 个模板，每个 patch 版本号加 1，`import_builtin_templates` 会覆盖没被用户改过的已导入内置模板；用户改过的和自定义模板不覆盖（`decideBuiltinImportAction`）。

| 模板 | 原交互 | 新实现 | 版本 |
|---|---|---|---|
| architect / botanical | `onclick` 切换 `.flipped` | 外层 `<label>` + 隐藏 checkbox；`.X.flipped .Y` → `.T:checked ~ .Y, .T:checked ~ * .Y` | 2.2.0→2.2.1 |
| monograph / footnote / marginalia / seminar / nomenclature | `onclick` 切换 `.open` | 同上；无 display 的卡片补 `label.X { display: block; }` | 1.0.1→1.0.2 |
| swiss | `onclick` 切换内层 `.swiss-shell.revealed` | `.swiss-shell.revealed` → `:checked ~ .swiss-shell` | 2.1.7→2.1.8 |
| eink | 脚本：闪烁后显示释义、隐藏副标题，只能揭示一次 | radio（不能取消，保持一次性）；`:has()` 触发原 `eink-flash` 动画 | 2.1.3→2.1.4 |
| lexicon | 脚本：正反面来回切换 | checkbox；去掉背面内联 `display:none`，改由 `.lex-toggle ~ .lex-back-content` 隐藏 | 2.1.3→2.1.4 |
| polaroid | `onclick` + 脚本：正反面来回切换 | 同 lexicon | 2.2.0→2.2.1 |

- 选择器替换保持原特异性：原 `.CARD.CLS .Y` 是 2+n 个类，新 `.T:checked ~ .Y` 也是 2+n（`:checked` 算一个伪类），层叠顺序不变。
- 背面模板一个字没改（背面用写死的 `open`/`flipped` 类或内联 `display:block`）。
- 点击行为：label 内点击会切换 checkbox。复习页的卡面辅助脚本本来就跳过 `label,input,[onclick]` 上的点击，不翻面，所以和原来点 `onclick` 区域的效果一样。`isInteractiveCardHtml` 能匹配 `<input`，卡面仍按可交互处理。
- 和原脚本的差别（如实列出）：eink 原来在 300ms（动画中点）才换内容，现在点击时立即换，闪烁动画照常；`:has()` 不支持的旧内核里只是没有闪烁，揭示仍然正常。swiss 和 8 个 class 切换模板与原来逐条等价。
- Anki 导出：`apkg-export-model.ts` 的 qfmt/afmt 和 `anki-sync.ts:226-227` 读的都是同一份 `front_template`/`back_template`/`css_style`，所以 Anki 里得到的是同样的纯 CSS 交互，不需要脚本，效果和应用内一致。glass/redaction/manuscript/lab 四个模板的脚本原样保留，Anki 导出行为不变。

预期效果（推断，必须由 X1 实测）：原 25 条里，父文档 9 条（DOMPurify 解析 `onclick`）、srcdoc 9 条 handler、srcdoc 3 条脚本（eink/lexicon/polaroid）应当消失，剩下 4 条 srcdoc 内联脚本（glass/redaction/lab/manuscript）。U4 不自签 0。

### 停下：预览剥脚本（`htmlSandboxPolicy.ts`）——与现有测试契约冲突

D-154 要求 `htmlSandboxPolicy.ts` 在预览时剥掉那 4 个模板的脚本。改之前核对测试发现，有两个**不在 U4 允许路径**的现有测试明确锁定了相反的行为：

- `src/components/previews/__tests__/htmlSandboxPolicy.test.ts:8-15`：`sanitizeHtmlForPreview(LAB_BACK, 'template-safe')` 必须 `toContain('<script>')`。
- `tests/vitest/previews/htmlSandboxPreview.test.tsx:39-53`（`safeHtml` 必须含 `<script>`）和 `:79-93`（`template-safe` 的 srcdoc 必须含模板脚本文本）。

还有一个必须守住的约束：`AnkiTemplateCardFace.tsx:163` 会把应用自有的 `CARD_FACE_HELPER_SCRIPT` 拼进模板 HTML 再送去净化，`htmlSandboxPreview.cspContract.test.ts:20-28` 要求它在净化后保留，并且哈希等于 CSP 白名单。所以剥脚本只能剥“非应用自有”的脚本，不能一刀切。

只改实现会让上面三个用例变红；改这些测试属于“为通过测试改断言”，超出授权。这一项停在原实现，请 C1 二选一：

1. **授权改这两个测试文件**（推荐）：U4 让 template-safe 只保留和 `CARD_FACE_HELPER_SCRIPT` 文本完全一致的 `<script>`，其余脚本剥掉；`onclick` 等属性照旧保留（复习页辅助脚本靠 `[onclick]` 判断不翻面）。三个用例的断言改成“模板脚本被剥、helper 被保留”，cspContract 不改。用户可见变化：dev 模式（无父 CSP）下这 4 个模板的预览交互也会消失；生产版本来就被 CSP 拦截，没有变化。
2. **不剥**：接受剩下 4 条 srcdoc 报错，登记为与 Tauri 等价的已知项（WP-099 已取证 Tauri 生产版同样会拦）。

### 验证（本轮原始结果）

```text
 Test Files  1 failed | 12 passed (13)
      Tests  11 failed | 237 passed (248)
[作业 20261106025941-325b97] 退出码 1
```
第一版新测试 11 条失败，原因是 jsdom 的 `getComputedStyle` 缓存在 checkbox 状态变化后不失效（最小复现：label 点击后 `matches()` 为 true、`checked` 为 true，但先读过的计算样式仍是 `none`；不先读则是 `block`）。修法是测试里每次读取前改写样式表文本强制重算，断言没放宽。同一作业里另外 12 个文件（`tests/vitest/templates`、`src/components/previews/__tests__`、`cardFaceLatex`）全部通过，包括 `builtinTemplatesIntegrity`（前后端副本相等、净化后核心内容可见）和 cspContract。

```text
 ✓ src/ui-plugins/official/content/__tests__/builtinTemplateCsp.test.ts (25 tests) 1912ms
 Test Files  1 passed (1)
      Tests  25 passed (25)
[作业 20261106030605-8bb04f] 退出码 0

 Test Files  50 passed (50)
      Tests  974 passed | 1 skipped (975)
[作业 20261106025941-a1a751] npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki/tests/executor-helpers.test.ts --maxWorkers=2
[作业 20261106025941-a1a751] 退出码 0
```

两次都没有 Errors 行。1 skipped 是原有的。Rust 侧 `include_str!` 读同一份 JSON（`commands.rs:4901`、`chatanki_executor.rs:11745/17586`），没跑 cargo。

已提交 tip 上的复跑（`version:generate` 退出 0 后）：

```text
[作业 20261106030740-cf027c] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261106030740-cf027c] 退出码 0

 FAIL  src/components/anki/utils/__tests__/katexSandboxCssData.test.ts
Error: Denied ID /home/dsdev/dev/deep-student/node_modules/katex/dist/katex.min.css?raw
 Test Files  1 failed | 23 passed (24)
      Tests  301 passed (301)
[作业 20261106030954-786134] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/builtinTemplateCsp.test.ts tests/vitest/templates src/components/anki src/components/previews/__tests__ tests/vitest/previews --maxWorkers=2 --minWorkers=1
[作业 20261106030954-786134] 退出码 1
```

退出 1，不算通过。唯一失败的文件在收集阶段就挂了：Vite 拒绝加载工作树外（主仓库 node_modules）的 `katex.min.css?raw`。这是 worktree 共享 node_modules 带来的环境问题，该文件不读模板 JSON，与本改动无关；没改测试或配置。其余 23 个文件、301 条全部通过，无 Errors 行。lane-gate 要等 `89fd8e592` 进 main 后再跑。

## WP-249 续：预览剥脚本（D-166 裁定方案 1）

C1 在 D-166 选了方案 1，并授权 U4 在本包内修改 `src/components/previews/__tests__/htmlSandboxPolicy.test.ts` 与 `tests/vitest/previews/htmlSandboxPreview.test.tsx` 中与剥脚本相关的用例。实现提交 `0298d99ef`；lane 测试的补充断言被协调者检查点 `9461b4faf` 保存。

### 实现

`htmlSandboxPolicy.ts` 的 template-safe 分支在 DOMPurify 净化期间临时挂一个 `uponSanitizeElement` 钩子：`<script>` 的文本不等于 `CARD_FACE_HELPER_SCRIPT` 去掉首尾标签后的正文时，移除该节点。钩子在 `finally` 里卸掉，不影响 chat-safe 和其他 DOMPurify 调用方。`ADD_TAGS: ['script']`、`ADD_ATTR: ['onclick']`、`FORBID_*`、`ALLOW_DATA_ATTR` 都没改，`onclick`/`data-*` 照旧保留。`TEMPLATE_RESIZE_SCRIPT` 是 `buildHtmlSandboxDocument` 在净化之后才加进去的，不受影响。CSP 字符串、`tauri.conf.json` 与 `htmlSandboxPreview.cspContract.test.ts` 都没改。比较对象直接 import `cardMedia.ts` 的常量，没有另抄一份，因此 helper 改动后不会出现两份不一致。

### 断言对照（旧 → 新，依据 D-154/D-166）

| 文件:用例 | 旧断言 | 新断言 |
|---|---|---|
| `htmlSandboxPolicy.test.ts` "keeps template scripts, onclick and data attributes…" → 改名 "strips template scripts but keeps onclick and data attributes…" | `toContain('<script>')`；`data-opt`、`onclick` 保留；`allow-scripts` | `not.toContain('<script')`、`not.toContain('classList.add')`；`data-opt`、`onclick` 保留与 `allow-scripts` 不变 |
| `htmlSandboxPolicy.test.ts` 新增 "keeps only the exact app-owned card face helper script" | — | helper + 模板脚本混合输入，输出恰好 1 个 `<script>`，且原样包含 `CARD_FACE_HELPER_SCRIPT`，模板脚本被移除 |
| `htmlSandboxPolicy.test.ts` 新增反例 "strips a script that differs from the helper by one character" | — | `stopAll`→`stopAlx`（长度相同，只差一个字符）后，输出不含 `<script`，正文保留 |
| `htmlSandboxPreview.test.tsx:39` "keeps template scripts in template-safe mode…" → 改名 "strips template scripts in template-safe mode but keeps the network-blocked script sandbox" | `safeHtml` `toContain('<script>')` | `safeHtml` `not.toContain('<script')` 且 `toContain('before')`；`script-src 'unsafe-inline'`、`connect-src 'none'`、`sdp-resize`、`allow-scripts` 四条不变 |
| `htmlSandboxPreview.test.tsx:79` "renders template-safe previews with script-enabled sandbox" → 加 "…but without template scripts" | srcdoc `toContain("document.body.dataset.ready='yes'")` | srcdoc `toContain('before')` 且 `not.toContain("document.body.dataset.ready='yes'")`；`sandbox=allow-scripts`、`sdp-resize` 不变 |
| `builtinTemplateCsp.test.ts`（本 lane）新增 "leaves no script or inline handler in any rendered preview (D-166)" | — | 16 个内置模板的正面与背面，按生产路径渲染并净化后，都不含 `<script` 或 `on*=` |

其余用例（chat-safe、embed/load 处理器、iframe 隔离）一个字没动。第一版新断言写了 `toContain('<div id="target">before</div>')`，结果失败：DOMPurify 默认的防 DOM clobbering 会去掉 `id="target"`，同文件另一个旧用例本来也只断言 `<div>before</div>`。这是我新写断言的错误，已改成 `toContain('before')`。

### 未授权的第三个旧契约测试——仍为红

`tests/vitest/templates/templateRenderSanitization.test.tsx:29-48`（"keeps template scripts (sandboxed, network-blocked) alongside the internal resize helper"）同样要求 template-safe 的 srcdoc 保留模板脚本 `document.getElementById('target').textContent = 'after'`。它不在 D-166 的两个文件里，U4 没改。实现改动后它失败：

```text
 FAIL  tests/vitest/templates/templateRenderSanitization.test.tsx > ShadowDomPreview (iframe) sanitization > keeps template scripts (sandboxed, network-blocked) alongside the internal resize helper
AssertionError: expected '<!DOCTYPE html>\n<html>\n<head>\n<met…' to contain 'document.getElementById(\'target\').t…'
 Test Files  1 failed | 12 passed (13)
      Tests  1 failed | 231 passed (232)
[作业 20261106034526-1bac5a] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/builtinTemplateCsp.test.ts tests/vitest/previews src/components/previews/__tests__ tests/vitest/templates --maxWorkers=2 --minWorkers=1
[作业 20261106034526-1bac5a] 退出码 1
```

退出 1，不算通过。需要 C1 把这个文件加进 D-166 授权，U4 再按上表同样的方式改（断言模板脚本被移除，`<div>before</div>`、`connect-src 'none'`、`sdp-resize` 保留）。

### 其他验证

```text
[作业 20261106033730-9eb3a0] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261106033730-9eb3a0] 退出码 0

 Test Files  3 failed | 47 passed (50)
      Tests  2 failed | 592 passed (594)
[作业 20261106033730-b74f06] （同上加 src/components/anki、tests/vitest/chat-v2/plugins、src/features/chat/plugins/blocks）退出码 1

boundaries: scanned 3184 files, 0 violation(s), 236 suppressed via boundary-allow
[作业 20261106034952-63a56d] npm run migration:boundaries
[作业 20261106034952-63a56d] 退出码 0
```

`version:generate` 两次都退出 0，tsc 无诊断。`b74f06` 是在修正 `id` 断言之前跑的，3 个失败文件是：上面那个未授权文件、已修正的 `id` 断言、`katexSandboxCssData`（收集阶段 `Denied ID …/deep-student/node_modules/katex/dist/katex.min.css?raw`，worktree 环境问题，同前）。chat-v2 插件和 chat blocks 里的 ShadowDomPreview 消费者都通过。所有输出无 Errors 行。

路径边界：`lane-paths.mjs` 的 `allowedPaths('U4-ui-content')` 现在仍不含这 6 个文件（3 份 JSON、`htmlSandboxPolicy.ts`、两个测试文件），等 S0 的 `89fd8e592` 和 D-166 授权进 main。`migration:boundaries` 不检查 lane 路径，所以 0 违规不代表路径已获授权；lane-gate 的路径检查进 main 前会报越界，没有绕过。console error 计数由 X1 在交付 tip 上实测。

### 集成门禁拒绝回执（04:0xZ）：三份 JSON 越界——授权未进 main，不回退

拒绝原因：`host/plugins/anki/data/builtin-templates.json`、`src-tauri/src/data/builtin-templates.json`、`src/data/anki/builtin-templates.json` 超出 U4 范围。`git merge --no-edit main` 后得到 `5524c6ab1`，`git merge-base --is-ancestor 89fd8e592 HEAD` 退出 1。`allowedPaths('U4-ui-content')` 仍不含 WP-249 改的 6 个文件（三份 JSON、`htmlSandboxPolicy.ts`、两个测试）。这是 D-154/D-166 的授权（S0 `89fd8e592`、`3b63d68a2`，在 S0 分支 `3161f63ac`）还没进 main 造成的，C1 03:52Z 已向 C2 说明这是预期情况。改动是授权内的已交付工作，所以不回退、不绕过，等授权进 main 后合 main 再重试。

在合并后的树上跑的三项检查：

```text
[作业 20261106040157-d69b09] npm run typecheck:host
[作业 20261106040157-d69b09] 退出码 0

boundaries: scanned 3186 files, 0 violation(s), 236 suppressed via boundary-allow
[作业 20261106040158-debdc8] npm run migration:boundaries
[作业 20261106040158-debdc8] 退出码 0

 FAIL  host/plugins/chatanki/tests/transform-script-real-sandbox.test.ts
Error: Hook timed out in 10000ms.
 Test Files  1 failed | 103 passed (104)
      Tests  1395 passed | 8 skipped (1403)
[作业 20261106040158-1a513b] npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki --maxWorkers=2
[作业 20261106040158-1a513b] 退出码 1

 Test Files  1 passed (1)
      Tests  7 passed (7)
[作业 20261106040827-e9683f] npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/transform-script-real-sandbox.test.ts --maxWorkers=1
[作业 20261106040827-e9683f] 退出码 0
```

host 测试退出 1，不算通过。唯一失败的是 `transform-script-real-sandbox` 的 `beforeAll`（建存储 + 真实 Python 沙箱）在两个 worker 并发下超过 10s。单 worker 重跑 7/7 通过，退出 0。这个文件不读模板 JSON，没改它。U4 自己没有 host 目录，这里选 anki/chatanki 是因为三份 JSON 由它们读取。无 Errors 汇总行。

### D-166 追加：`templateRenderSanitization.test.tsx:29-48`

C1 追加授权改这一个用例，另外两个用例不动。提交 `04c14e132`。

| 用例 | 旧断言 | 新断言 |
|---|---|---|
| "keeps template scripts (sandboxed, network-blocked) alongside the internal resize helper" → 改名 "strips template scripts but keeps the network-blocked sandbox and internal resize helper" | srcdoc `toContain("document.getElementById('target').textContent = 'after'")` | srcdoc `not.toContain(...)` 同一字符串；`<div>before</div>`、`connect-src 'none'`、`sdp-resize` 三条不变 |

```text
 ✓ tests/vitest/templates/templateRenderSanitization.test.tsx (3 tests) 621ms
 FAIL  src/components/anki/utils/__tests__/katexSandboxCssData.test.ts
Error: Denied ID /home/dsdev/dev/deep-student/node_modules/katex/dist/katex.min.css?raw
 Test Files  1 failed | 55 passed (56)
      Tests  608 passed (608)
[作业 20261106041551-f17ebd] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__ tests/vitest/templates tests/vitest/previews src/components/previews/__tests__ src/components/anki tests/vitest/chat-v2/plugins src/features/chat/plugins/blocks --maxWorkers=2 --minWorkers=1
[作业 20261106041551-f17ebd] 退出码 1

[作业 20261106041551-176681] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261106041551-176681] 退出码 0
```

`version:generate` 退出 0。前端测试退出 1，不算通过。608 条全部通过，WP-249 改到的旧契约用例已经全绿；唯一失败的文件是 `katexSandboxCssData`，在收集阶段被 Vite 拒绝加载工作树外的 `node_modules/katex/dist/katex.min.css?raw`。这是共享 node_modules 的环境问题，前几次运行同样出现，不读模板也不经过 `htmlSandboxPolicy`。无 Errors 汇总行。

`git merge --no-edit main` 显示 Already up to date，`89fd8e592` 仍不是 HEAD 的祖先。D-154/D-166 的授权进 main 之前，lane-gate 会报越界，属于预期，没有绕过。console error 计数由 X1 在交付 tip 上实测。
