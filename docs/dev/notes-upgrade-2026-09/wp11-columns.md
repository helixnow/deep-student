# WP11 — 有限双列与康奈尔格式

日期：2026-09-21。实现限定于 `src/components/crepe/plugins/columns/`、`NoteLayoutCommands.ts` 和新测试/文档；不修改共享注册入口、CrepeEditor、types 或后端。不执行 commit/还原。

依据：[ADR-01～03](architecture-decisions.md) 的 Markdown 单一权威、逐页 opt-in、顶层稳定身份；[设计审视](../../../deep-student-notes-design-review-20260916.md) 的明确命令作用域与移动阅读顺序。仓库基线文档说明原 WP00–WP11 方案完整原文不在仓库，本文按本次用户给出的 WP11 约束实施，不将旧 implementation-status 的“未新增多列格式”视为本次完成状态。

## 格式决策

采用自实现的、严格且有版本的 Markdown directive 子集，不使用 HTML details（原有 remark HTML 路径不会自动把其内部 Markdown 转成可编辑的块树）。不依赖 remark-directive，不增依赖。标记必须是根级独立段落，前后空行；仅接受以下固定拼写：

```markdown
:::ds-columns{version=1 layout=cornell}

:::column

## 线索（Cues）

问题

:::end-column

:::column

## 笔记（Notes）

记录

:::end-column

:::end-ds-columns

## 总结（Summary）

总结内容
```

`layout=equal` 为等宽，`layout=cornell` 为 1:2。`version=1` **仅是本 directive 的语法版本**，不能据此推断笔记 envelope 的 formatVersion。导出 `COLUMNS_REQUIRED_CAPABILITY = 'ds-columns-v1'` 给宿主/后端接线。每个容器恰好两列；康奈尔总结是容器之后的普通根级 heading + blocks，保持全宽且允许正常编辑。

自实现 parser 在现有 remark 的根级 AST 上识别标记，用 source offsets 比较原始拼写；不会把 `\:::column`、代码围栏内示例、列表/引用/HTML 内容当作结构。保留现有内联/表格/公式等 transformer 的结果；serializer 通过原 remark 的 `containerFlow` 序列化内部 AST。自定义 unsafe 规则会转义正文里像 delimiter 的字面段落，避免二次解析升级正文。空列补一个空段落，Markdown 可规范化但内容不丢失。

未知版本、缺失结束、第三列、嵌套列整组保持普通内容，不挑内部合法片段升级。它们不是受支持的结构化格式；按 ADR-02，未知版本页仍须由宿主保留原文并拒绝结构化重写，不能把“parser 不建列节点”当作旧客户端可以保存的许可。

## 结构、命令与键盘

- `doc → ds_columns → ds_column ds_column`，每个 column 是 `block+`。column 无 block group，不能独立成为根块；columns 为 isolating/defining，column 同样隔离。
- PM 的 `block+` 无法表达递归排除某个 block 成员，故用初始化检查和 transaction filter 禁止根级以外的 columns、后代嵌套与非法列数。校验缓存不可变子树，普通输入不序列化/哈希全文，不创建每块 NodeView。
- `insertColumns()` / `insertCornell()`：仅根级折叠光标可用；空段落替换，非空段落后插入，原文保留。一次 Undo 撤销整次插入。
- `convertSelectionToColumns()`：明确转换选中的完整根级块，折叠光标指当前块；下一块开头作为选区末端时不包含下一块。首列保留原内容，第二列为空。
- `convertSelectionToCornell()`：原内容完整放在“笔记”列，新增“线索”和容器后的“总结”。不会猜测语义切割任意文章。
- `convertCornellTemplate(labels)`：显式转换既有线性康奈尔模板。只接受唯一且依序出现的三个 h2 标题；保留序言、各节内容与总结，存在重复/乱序/已有 columns 时不可用。中英标题由宿主传入 labels。
- `unwrapColumns`：按左列全部内容→右列全部内容展开；已有总结保持之后。转换/展开各占一个 history 事件，选中目标容器便于再次操作。
- Enter 在当前列最后一个空段落上：左列→右列，右列→容器后；不移除列内唯一空段落。Mod-Enter 可直接跳出，包括末尾是表格/代码的场景。
- Backspace/Delete 在直接子段落的列边界不合并列。列表/表格内部继续走现有键盘链；Tab 与方向键不被此插件劫持。跨列 TextSelection 删除由 PM 执行，transaction filter 保持结构合法。
- IME composing、只读 editor 不执行自定义键盘写操作。

## 复制、粘贴、兼容导出

持久化调用现有 serializer/getMarkdown，保留 directive。`exportColumnsPlainMarkdown(doc, serialize)` 只移除列容器，内部所有块、marks、图片/链接/表格等保留，顺序为左→右→后续总结；丢失的是二维布局和容器身份，不能将兼容副本悄悄写回原格式页。

真正的 DOM copy/cut 对包含布局结构的选区同时写两种表示：HTML 保留 `data-ds-columns` / `data-ds-column` 及 PM slice 元数据；text/plain 是上述兼容 Markdown。使用 DOM 事件而不是仅追加 clipboardTextSerializer，是因为 Crepe 的内置 clipboard serializer 更早注册，会优先命中。普通选区沿用现有 clipboard 行为。cut 一次 Undo 可恢复。

粘贴到根级可保留合法两列，粘贴进列/列表/引用或未获格式写入授权的页，展开为正常块内容。纯文本 directive 的 paste 单独接现有 parser，避免内置 clipboard 在解析后跳过 transformPasted 导致过滤器拒绝整次粘贴。非法 HTML 嵌套也展开，不制造无限列树。

## 宿主接线契约（主 agent 所有）

```ts
import { columnsPlugin, exportColumnsPlainMarkdown } from './plugins/columns';
crepe.editor.use(columnsPlugin({
  canWrite: () => pageHasConfirmedUpgrade && backendAllowsColumnsVersion,
})); // create 前注册
```

默认 `canWrite` 为 false。回调在执行时读取当前页，不能捕获上一个页的授权；gate 关闭时不能插入/转换，含列文档的正文修改被拒绝。这只是前端调用边界；后台写入口的 envelope 校验、CAS、迁移前快照与旧客户端拒写仍由后端/主 agent 接，不能将 true 常量作为产品注册值。

`NoteLayoutCommands.ts` 提供 `availableNoteLayoutActions`、`runNoteLayoutAction` 和 `noteLayoutCommand`，可接现有块菜单/命令面板；仅展示可执行动作，不创建空按钮或伪 CSS 分列开关。禁用状态由同一个命令 dry-run 决定。普通 Markdown 导出需由主 agent 将现有导出入口连接至 `exportColumnsPlainMarkdown`；结构化保存继续走原 serializer。

列容器为一个顶层可寻址块；稳定 ID 注释绑定整个容器，而不绑定内部列。identity agent 需在 schema 注册完成后扩展 columns 的 attrs，并在格式迁移/转换时落实“首块继承身份、合并后的其他块不转发”契约。新增布局不在本插件内生成第二套 ID。文档分段窗口不得在容器内截断；主 agent 须将完整容器视作同一顶层块。

## 验证与限制

执行 `npx vitest run src/components/crepe/plugins/columns/__tests__/columns.test.ts --reporter=verbose --silent=false`：23 项通过，含真实 Milkdown schema/remark 与实际 Crepe DOM clipboard 事件（jsdom）：

- 有效/空列二次结构往返、嵌套/三列/未知版本/缺结束/转义/代码/引用的保留；粗体、斜体、链接、图片、GFM 表格、代码、callout、toggle，Crepe 公式复制。
- 插入、转换、线性康奈尔转换、展开、跨列选择删除、Undo/Redo、dry-run、默认关闭/动态撤销格式授权。
- 命令/transaction 的嵌套禁止，粘贴降级内容保留，HTML copy、plain Markdown 复制与导出实际阅读顺序。
- 4000 个段落中 50 次编辑本机 jsdom 约 85–132ms（最后一次 132.4ms，存在并行构建）；仅是当前测试测量，不是手机/WebKit 性能承诺。

最后执行的 `npm run typecheck:native` 没有本插件/NoteLayoutCommands 的错误；全仓仍因并行会话的 `src/features/notes/aiReview.ts:434` 使用 ES2022 lib 不包含的 `findLastIndex` 失败，未跨域修改该文件。`git diff --check` 通过。

CSS 用真实 schema 容器的 grid：桌面 1:1 / 1:2，小于 768px 的视口或小于 601px 的编辑器容器单列，保持 DOM 顺序。宽表/pre 局部横向滚动，列最小宽度为 0，避免撑宽页面。

`tests/manual/wp11-columns-desktop.ts` 提供真实 `npm run tauri dev` 应用内的可执行几何验收：1100/390px、实际 column rect/阅读顺序、总结位置、editor scrollWidth、宽表的 scrollLeft。它挂载真实 Crepe + 本插件的临时测试面板，不写笔记、不改页面入口，执行后销毁；必须在真实桌面 WebView 的 dev UI bridge 调用，禁止打开 demo 页。

当前实机几何验收尚未运行：共享 `tauri dev` 正因其他会话 Rust 修改持续编译，UI bridge `connected=false`。因此上述单列/局部滚动 CSS **尚不是实机通过声明**。最终宿主注册、格式门禁、稳定身份/分段与真实页面验收也不能用插件单测替代。
