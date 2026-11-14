# 编辑器扩展点：选中浮条、块菜单、diff 视图（设计）

W18 交接 33 / 39 的契约侧设计。现状（e73e0d98）只有 `editor.extensions` 与 `editor.slashMenu`（`contracts/editor.ts`）；
本文的形状已由 W17 一次性追加为类型（第 1 步完成，见“落地顺序”），宿主与官方条目的接线（第 2 步）仍归 W18。

约束：

- 契约只追加。现有 `EditorInstanceContext`、`EditorExtensionContribution`、`SlashMenuBuilder` 的字段不改、不变必填。
- 官方条目逐表面复现今天的列表：`editorExtensions.golden`、`editorSlots.test.ts`、`blockMenus.golden.test.tsx`
  （W18 `922f646f`）都必须逐键相等，不重录。
- 社区条目出错只丢自己，沿用 `buildEditorSlashMenu` 的做法：官方条目直接调用，社区条目 try/catch 后经
  `reportContributionError('<槽位>')` 计入错误预算，编辑器照常打开。

## 1. `editor.selectionToolbar`（选中浮条）

Crepe 的浮条只在编辑器初始化时构建一次（`CrepeEditor.tsx` 约 1946 行 `buildToolbar`），之后不再重建。
所以它和 `editor.extensions` 一样按实例生效：槽位变化只影响之后创建的编辑器；条目要读宿主最新状态，得在 `onRun` 里取
（今天的 `host-actions` 分组就是这么做的，见 `commandMenus.ts` 的 `getHostActions`）。

```ts
/** 浮条按钮。`active` 省略时宿主按 `() => false` 补上（Crepe 的浮条项必须有它）。 */
export interface SelectionToolbarItem {
  label: string;
  icon: string;
  active?: (ctx: Ctx) => boolean;
  onRun?: (ctx: Ctx) => void;
}

/** Crepe 浮条 GroupBuilder 中允许条目使用的部分。 */
export interface SelectionToolbarBuilder {
  addGroup(key: string, label: string): { addItem(key: string, item: SelectionToolbarItem): unknown };
  getGroup(key: string): { addItem(key: string, item: SelectionToolbarItem): unknown };
  build(): { key: string; items: { key: string; onRun?: (ctx: Ctx) => void }[] }[];
}

export interface EditorSelectionToolbarContribution {
  build(toolbar: SelectionToolbarBuilder, editor: EditorInstanceContext): void;
}
```

不复用 `SlashMenuBuilder`：浮条项多一个 `active`，构建时机也不同（斜杠菜单在用户过滤时反复重建）。
共用一个类型会让文档里的“何时调用”只对其中一个成立。

官方条目两条，拆自今天的 `wireCrepeCommandMenu(builder, 'bubble', getHostActions)`：

| id | order | 内容 |
|---|---|---|
| `toolbar:editor-commands` | 10 | 把 Crepe 内置按钮（bold、italic、strikethrough、code、link、latex）的 `onRun` 接到编辑器命令表 |
| `toolbar:host-actions` | 20 | `selectionActionsRef` 非空时追加 `host-actions` 分组（“更多”） |

社区条目的 order 落在 10 和 20 之间时，它的分组排在“更多”之前。这只在有社区条目时出现，官方顺序不变。

## 2. `editor.blockMenu`（块菜单）

两个宿主、三种列表，今天各自硬编码：

- 桌面块手柄菜单：`CrepeEditor.tsx` 123 行 `BLOCK_MENU_ACTIONS`（转换为… + duplicate、delete、copy-block-link、
  move-to-note + 布局命令），React portal 渲染（2885 行），键盘导航在 542–563 行，图标取 `BLOCK_MENU_ICONS`。
- 移动端插入菜单：`blockCommandMenu.ts` 的 `openCrepeBlockCommandMenu(view)`（`actions = false`，兼作斜杠菜单）：
  hr、math、table、insert-callout、insert-toggle + 转换命令（不含 duplicate、delete）+ 布局命令。
- 移动端块菜单：同一函数 `actions = true`：转换命令 + duplicate、delete + 布局命令。

```ts
export type EditorBlockMenuSurface = 'desktop-handle' | 'mobile-insert' | 'mobile-block';

/** 菜单打开时的目标块（每次打开时取，菜单开着时不变）。 */
export interface EditorBlockMenuTarget {
  surface: EditorBlockMenuSurface;
  /** 从目标块往外的节点类型，如 ['paragraph', 'list_item', 'bullet_list', 'callout']。 */
  nodeTypes: readonly string[];
  depth: number;
  editable: boolean;
}

export interface EditorBlockMenuRow {
  /** 菜单内唯一；渲染为 `data-command`。 */
  id: string;
  /** 已翻译的文字。 */
  label: string;
  /** 只在桌面块手柄菜单显示。 */
  icon?: ComponentType<{ size?: number }>;
  destructive?: boolean;
  disabled?: boolean;
  /** 菜单先关闭、焦点回到编辑器，再调用；返回的 Promise 被拒绝时计入错误预算（社区）或弹通知（官方，同今天）。 */
  run(view: EditorView): void | Promise<void>;
}

export interface EditorBlockMenuContribution {
  rows(target: EditorBlockMenuTarget, editor: EditorInstanceContext): readonly EditorBlockMenuRow[];
}
```

- `rows` 在每次打开时调用，`disabled` 由条目按当前目标算（官方用 `canExecuteCrepeCommand(view, id, { target })`）。
- 官方条目用 `surface` 分别给出三种列表，不合并。按 order 分三段，社区行可以插在段之间：
  `block:insert`（10，只在 `mobile-insert`）、`block:turn-into`（20）、`block:actions`（30，按表面给出不同子集）、`block:layout`（40）。
- 渲染、键盘导航、关闭方式、焦点规则（含 W09 的禁用行焦点修复，W18 交接 40）都留在宿主，契约不涉及。
- 图标用 React 组件而不是 SVG 字符串：桌面菜单本来就渲染 phosphor 组件，也避免把社区字符串写进 `innerHTML`。
- `run` 拿 ProseMirror `EditorView`，和移动端宿主手里的对象一致；桌面宿主从 `editorViewCtx` 取同一个 view。

## 3. diff 视图（`purpose`）

AI 修改审阅用的是另一个一次性 Crepe 实例（`officialDiffAdapter.ts` 76–77 行），插件栈写死：callout、toggle、
diff、diffComponent、wikilink、columns、blockIdentity。社区的 `editor.extensions` 今天不进这个实例。

```ts
export type EditorPurpose = 'editor' | 'diff';

export interface EditorInstanceContext {
  options: Readonly<CrepePluginsOptions>;
  /** 实例用途；省略 = 'editor'。审阅投影传 'diff'。 */
  purpose?: EditorPurpose;
}

export interface EditorExtensionContribution {
  create(editor: EditorInstanceContext): MilkdownPlugin | readonly MilkdownPlugin[] | null;
  /** 参与哪些实例；省略 = ['editor']。 */
  purposes?: readonly EditorPurpose[];
}
```

- 进 diff 实例要显式写 `purposes: ['editor', 'diff']`。只看 `purpose` 不够：现有社区条目没写过这个判断，
  默认放进来就会在只读审阅视图里装上为可编辑编辑器写的插件，这是行为变化。
- diff 适配器在写死的栈之后，按 order 应用 `purposes` 含 `'diff'` 的条目，`editor` 传 `{ purpose: 'diff', options }`。
  `options` 用冻结的审阅专用对象，由 W18 定（审阅视图不需要 wikilink 的 getNotes、mention 等宿主回调）。
- 官方栈暂不搬进槽位：搬进去会改变它和 diff、diffComponent 的相对顺序，审阅 golden 有风险。以后要搬，单独提交并对 golden。
- `CrepeEditor` 里的 `applyCrepePlugins` 对没写 `purposes` 的条目行为不变；写了但不含 `'editor'` 的条目在普通编辑器里跳过。

## 落地顺序与接线位置

1. **W17（契约，一次提交）**：上面三段类型追加到 `src/ui-kernel/contracts/editor.ts`（41 行之后）和 SlotMap（45–46 行之后
   加 `'editor.selectionToolbar'`、`'editor.blockMenu'`）；`src/ui-sdk/index.ts` 导出新类型；README §2 列出新槽位；
   类型测试覆盖：浮条项省略 `active`、块菜单行形状、`purposes` 省略与显式。只有类型，没有运行时代码。
   *（已完成：类型、SDK 导出、README 与 `typetests/w17-contracts.typetest.ts`；槽位未加入 `BUILTIN_SLOTS`，槽位快照不变。）*
2. **W18（宿主与官方条目，同一批进 INT）**：
   - `src/ui-plugins/official/editor/editorSlots.ts`：`EDITOR_SLOTS` 加两个定义，`EditorAnnouncement` 加两个分支，
     新增 `buildEditorSelectionToolbar` / `collectEditorBlockMenuRows`（照 `buildEditorSlashMenu` 隔离社区条目）；
     `editor/index.ts` 的 meta 写 `slots: [...]`（可选，写了要列全四个槽位）。
   - `src/components/crepe/CrepeEditor.tsx`：约 1946 行 `buildToolbar` 改调 `buildEditorSelectionToolbar`；
     123、542、553、563、2885 行改用 `rows({ surface: 'desktop-handle', … })` 的结果。
   - `src/components/crepe/blockCommandMenu.ts` 86–128 行：两段循环改为按 `rows({ surface: actions ? 'mobile-block' : 'mobile-insert', … })` 生成按钮。
   - `src/components/crepe/officialDiffAdapter.ts` 76–77 行之后应用 `purposes` 含 `'diff'` 的条目。
3. 两步之间如果隔了批次：类型先进 INT 没有害处，但宿主声明槽位之前，社区往新槽位贡献会报 `slot "…" is not declared`。
   README 要写明槽位从哪一批起可用。

验证（W18 接线后）：

```sh
DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts \
  src/ui-plugins/official/editor/__tests__/editorSlots.test.ts \
  src/ui-plugins/official/editor/__tests__/blockMenus.golden.test.tsx \
  src/components/crepe/__tests__/officialDiffAdapter.test.ts --maxWorkers=2
node scripts/plugins/slot-snapshot.mjs --check   # 新增两个槽位定义，快照更新单独提交并贴差异
```
