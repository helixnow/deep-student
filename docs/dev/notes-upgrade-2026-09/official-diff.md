# TASK009 — 官方 Diff 最小集成原型

日期：2026-09-21。结论：**官方 API 与 Crepe 集成原型已可运行，尚不具备直接替换生产 aiReview 的条件。** 普通文本替换和指定复杂块的决策已验证；纯删除拒绝、审阅与上传并行、图片 Markdown 重解析、自定义块标题预览仍有缺口。

实现：[officialDiff.prototype.test.ts](../../../src/components/crepe/__tests__/officialDiff.prototype.test.ts)。本次只新增测试与本文；没有修改生产 editor、aiReview、Upload、依赖或配置，也没有添加第二套生产 Diff、feature flag。没有执行 commit / stash / reset / clean。

## 运行与验证范围

实际安装依赖经 `npm ls` 确认：`@milkdown/crepe`、`@milkdown/kit`、`@milkdown/plugin-diff`、`@milkdown/components` 均为 **7.22.1**。

```sh
npx vitest run src/components/crepe/__tests__/officialDiff.prototype.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose
npx tsc --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --esModuleInterop src/components/crepe/__tests__/officialDiff.prototype.test.ts
```

最终定向结果：**1 个文件，26 个测试断言用例通过，Vitest 运行 2.44s；定向 TypeScript 检查通过。** 其中 **21 个验证可用路径或明确的 API 语义，5 个 `LIMITATION` 用例复现 4 类现存缺陷**（纯删除分别走 chunk API 和官方组件按钮）。缺陷复现测试的绿色表示观察到了缺陷，**不表示对应产品场景通过验收**。没有 skip、todo、mock diff 或用宽松断言代替完整结构比较。

集成使用真正的 `new Crepe()`、`create()` / `destroy()`、Milkdown parser/serializer、ProseMirror EditorView 与 schema：

- 注册实际 `@milkdown/kit/plugin/diff` 和 `@milkdown/kit/component/diff`，通过 `commandsCtx.call` 或点击官方 DOM 按钮驱动。
- 使用项目的 `calloutPlugin()` / `togglePlugin()`；保留 Crepe 的 Table、CodeMirror、Latex、ImageBlock、Upload。为缩小原型关闭 Toolbar、BlockEdit、LinkTooltip；AI feature 为 false，避免重复安装 diff 与引入 streaming/provider。
- 使用生产 `createUploadLifecycle` 和 Crepe 唯一的 registered upload plugin；仅上传 IO 用可控 Promise，不调用真实文件后端。
- 成功的结构测试检查 `doc.check()`、`doc.eq(parser(expected))` 和序列化后再解析的结构一致；拒绝检查原 doc 引用及序列化基线完全不变。没有 `trim()` 掩盖丢失。
- jsdom 复用仓库全局 DOM shims。覆盖 DOM 结构与按钮行为，**未做桌面视觉、布局、焦点/IME、真实上传后端、自动保存/OCC、重启恢复、全生产插件栈验收**。没有打开 demo / hero。

## 已验证的能力与未通过项

| 场景 | 实际结果 | 验收边界 |
|---|---|---|
| 两个普通段落分别修改 | 接受第一组后拒绝剩余组；先拒绝再 accept-all；官方按钮两种操作顺序均得到预期混合正文 | 通过这些替换 fixture；每次动作后重新读取 pending |
| 同一段落相距较远的两个词替换 | 两个独立 change，可只接受第一个 | 具有段内细粒度，不固定为“一段一组” |
| 段落插入与纯删除的接受 | 可逐组接受，得到完整目标 doc | 通过 |
| **纯删除的拒绝** | API 返回 true，但仍 pending、仍锁定；后续 accept-all 会执行已经“拒绝”的删除 | **未通过**，chunk 与官方 range 按钮均复现 |
| toggle 标题/展开 attrs + 内嵌 callout/table/math | 一个可接受/拒绝的顶层块组，结构、attrs 和 Markdown 往返均符合预期 | 配置了 `customBlockTypes`；确实断言内嵌节点类型，非 marker 普通文本 |
| callout 类型/标题/正文 | 整块接受与拒绝均有效 | 同上；可操作不代表标题预览完整 |
| 表格两个单元格修改 | 底层两个 change，可单独接受一个 cell；组件合成一个整表组 | 引擎粒度与 UI 粒度不同 |
| 块公式 | 以 Crepe 的 `code_block`（latex）整块接受/拒绝 | 没有独立 `math_block` schema；未验收公式预览的视觉效果 |
| 行内公式 | `math_inline.attrs.value` 的一个 atom 范围可接受，周围正文不变 | 已验证替换；不是公式内按字符决策 |
| 四种复杂块同文档混合决策 | 接受 toggle、拒绝 callout/table、接受块公式，边界段落保留 | 通过；位置变化后的官方按钮继续有效 |
| **toggle/callout 标题候选预览** | 候选 DOM 含新的标题 attrs，但没有标题文本 | **未通过完整预览要求**，不能只凭接受结果正确宣布 UI 可用 |
| 普通 transaction 审阅锁 | 文本插入、整文替换、节点属性/类型修改均被 filterTransaction 拒绝；selection/meta-only 允许 | 通过；`view.editable` 仍为 true |
| clear / 重开 | clear 解锁但保留已经接受的正文；重新 start 不恢复拒绝记录 | 已验证 API 语义；不是回滚/挂起接口 |
| **Upload pending 在审阅中完成** | 正文插入和 remove meta 被一起拦截，任务却完成并移除；占位残留，图片未进入正文 | **未通过**；clear 后也不会补插，cancelAll 无法清除已经遗忘的任务 |
| 审阅前显式 cancelAll | 清除占位，晚到结果不插入，Diff 仍能完成 | 原型编排通过；取消会丢弃该上传任务，不是等待/保留上传 |
| **等待上传完成后以 Markdown 开始审阅** | URL 仍在，但无标题图片重解析得到 `caption: null`；接受后 doc.check 失败 | **未通过结构有效性** |
| 等待上传完成后使用预解析 doc API | 从有效 live doc 构造目标，保留图片 attrs，接受后 doc.check 通过 | 只证明 FromDoc 路径；未解决 Markdown 保存/重载的问题 |

## 实际官方 API 与下一步接线

最小安装顺序是 `crepe.create()` 前注册一次 `diff`，再注册 `diffComponent`：

```ts
import { diff } from '@milkdown/kit/plugin/diff';
import { diffComponent, diffComponentConfig } from '@milkdown/kit/component/diff';

crepe.editor.use(diff).use(diffComponent);
crepe.editor.config(ctx => {
  ctx.update(diffComponentConfig.key, prev => ({
    ...prev,
    acceptLabel: '接受',
    rejectLabel: '拒绝',
    customBlockTypes: ['table', 'image-block', 'code_block', 'toggle', 'callout'],
  }));
});
```

以上接线已在测试使用，**不是生产修改**。Crepe 的 `CrepeFeature.AI` 也会安装 diff + component + streaming；下一步如果选择 AI feature，就不要再手动重复注册。它默认的 custom blocks 只有 `table/image-block/code_block`，项目需要补充 toggle/callout。手动 `startDiffReviewCmd` 不归 AI session 所有，不能假设 AI 的全局操作浮层会出现；原型验证的是 diffComponent 的逐组按钮。

| 实际导出（均来自 `@milkdown/kit/plugin/diff`） | 参数/返回状态 | 需要对接的宿主语义 |
|---|---|---|
| `startDiffReviewCmd` | `modifiedMarkdown: string`，通过当前 parser 生成目标 | 基线是此刻 `view.state.doc`，必须确认是完整文档及当前笔记；命令不做 OCC/持久化 |
| `startDiffReviewFromDocCmd` | 当前 schema 的 `Node`，至少校验 doc type 相同 | 可避免 serialize→parse；不能据此跳过目标 schema 有效性验证 |
| `diffPluginKey.getState(view.state)` | `DiffState \| null`：`newDoc/changes/rejectedRanges/active` | 为 UI 提供审阅状态；没有恢复会话、owner、版本号或保存结果 |
| `getPendingChanges(state)` | 非拒绝 change 列表 | index 是当前 pending 下标，接受后会重新计算；不能保存为稳定分组 ID |
| `acceptDiffChunkCmd` / `rejectDiffChunkCmd` | 当前 `changeIndex: number` | 接受立即改当前正文；拒绝记录目标文档范围 |
| `acceptDiffRangeCmd` / `rejectDiffRangeCmd` | `{fromA,toA,fromB,toB}` | 官方组件按钮已用它们处理合并块；范围必须来自当前审阅文档 |
| `acceptAllDiffsCmd` | 无参数 | 没有拒绝时整文替换；有拒绝时只应用 pending，最终退出审阅 |
| `clearDiffReviewCmd` | 无参数 | 清空状态、解锁，已经接受的内容不回滚 |
| `computeDocDiff` / `diffConfig` | PM doc 对比；`ignoreAttrs`，默认忽略 heading.id | 无持久化身份；不要忽略 toggle.open/title 或 callout.type/title 等正文属性 |

### 差异粒度

引擎使用文档节点及字符/mark/attrs token 对比，容器会递归匹配，产生 PM 坐标 `fromA..toA` 与 `fromB..toB`。它不是原始 Markdown 行差异，也没有语义化稳定 group ID。普通段落可以产生多组，表格内部可产生 cell 级变化；同类型容器自身 attrs 变化也会成为差异。

组件的 `customBlockTypes` 会将触及指定节点的变化扩展、合并为**所在顶层块**。因此 nested table/callout 在 toggle 内部可能随整个 toggle 决策，不应承诺任意嵌套块独立操作。原型直接采用官方合并与 range 命令，没有实现自己的 diff/grouping。

这是有限 fixture 的能力证明；没有为大文档耗时、移动检测、未知 Markdown 保真、所有结构插入/删除组合做承诺。尤其“复杂替换可拒绝”不意味着“纯删除可拒绝”。

## 四类缺陷的定位与下一步

1. **纯删除拒绝失效**：`plugin-diff/src/diff-plugin.ts` 的 `isChangeRejected` 用严格非空区间交集判断；纯删除的 `fromB === toB` 永远不相交。两条公开拒绝路径都受影响。下一步应先修复/升级上游插件并用本 fixture 验证，不在宿主伪造第二套 pending 过滤。
2. **审阅与上传完成冲突**：Diff 的锁只拦 `docChanged`，没有把 editor 设为不可编辑；`uploadLifecycle.ts` 的 `live()` 因而允许继续。`run()` 把插图与移除占位放在同一 transaction，dispatch 被过滤后仍 `finish()`。下一步在进入审阅前明确等待完成或显式取消，并禁止审阅期间新建上传。现有 lifecycle 暴露 `cancelAll()`，尚无公共 pending 计数/idle Promise；原型没有新增生产接口。不要给上传 transaction 塞 Diff meta 绕锁，这会改变基线。
3. **无标题图片重解析产生非法 attrs**：`components/src/image-block/schema.ts` 声明 caption 为 string，但 `parseMarkdown` 直接取 `node.title`（实际可为 null）。上传得到的 live image caption 是空字符串、doc 有效；序列化后重解析变成 null。下一步修复上游解析默认值并验证保存/重载；FromDoc 只绕过本次重解析，不解决持久化往返。
4. **自定义块标题预览缺失**：`diffComponent` 用 `DOMSerializer.fromSchema` 构造候选 widget，不执行项目 NodeView。toggle/callout 的 `toDOM` 把 title 放在属性里，实际标题由 NodeView 绘制，所以候选预览只有正文。现有 `diffComponentConfig` 只有 label/customBlockTypes，没有自定义候选 renderer 接口。下一步需让 schema 的只读 DOM 能表达标题，或上游提供渲染接口；这是待后续生产任务评审的改动，本原型没有修改 schema/NodeView。

## 与现有 aiReview / WP05 的接口差异

现有 `aiReviewModel.ts` 对简单 Markdown 用行 diff 分组，复杂内容作为整文原子组；决定暂存在 session。`useAIReview.handleAccept` 最后才经 `getFullDocument()` / `replaceFullDocument(candidate, baseline)`，校验完整草稿版本并等待保存。官方接受命令则立即改 doc，还会在全部解决时把 DiffState 变成 null。**不能把 `active === false` 或命令返回 true 当作笔记保存成功**。

下一步接入要保留以下现有契约：

- 入口读取同一笔记的完整草稿 `{noteId, revision, markdown}` 与 request owner；长文加载窗口不能直接作为官方 Diff 的全文基线。
- 若继续维持“暂存决定，最终一次应用”，官方审阅应工作在未绑定自动保存的审阅上下文，最终正文仍走现有 FullDocument/OCC/保存链路。直接挂到实时正文会让逐组接受触发文档变化，需要先明确与自动保存及撤销的关系。此处只报告接线需求，没有新建生产审阅编辑器。
- 逐组操作、候选正文和审阅状态可直接基于官方 API；迁移时由官方分组替代原行 diff 决策，避免两套生产分组各自成为权威。
- clear 只用于退出，关闭视图/切页不能映射成“拒绝全部”或“已安全保存”；外层继续负责候选保留、版本冲突、保存失败和请求结果回执。

**WP05 相关现有 aiReview 恢复仅在内存，不跨重启。** `aiReviewModel.ts` 的模块级 `Map<string, AIReviewSession>` 按 window + note 保留候选和决定，`aiReview.ts` 在视图重开时重新校验基线；没有磁盘/session 持久化。`fullDocumentRecoveryStore` 也只在应用进程生命周期内保留失败草稿。窗口/进程销毁、应用重启或崩溃后不能承诺恢复。WP05 本地数据库历史保存的是已落库笔记版本，不能替代未应用的 AI 候选与分组决定持久化。官方 DiffState 同样没有跨编辑器销毁/重启恢复接口；本原型没有把这项能力标为已实现。
