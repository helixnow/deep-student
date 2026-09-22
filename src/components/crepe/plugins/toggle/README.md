# WP07 toggle 接线契约

正式 PM 结构：`toggle(toggleTitle, toggleBody)`。

- `TOGGLE_TYPE = 'toggle'`：唯一外层 block，`content: 'toggleTitle toggleBody'`。
- `TOGGLE_TITLE_TYPE = 'toggleTitle'`：`text*`、`marks: ''`，不属于通用 `block` group。
- `TOGGLE_BODY_TYPE = 'toggleBody'`：`block+`，不属于通用 `block` group。
- 唯一标题来源为 `toggle.child(0).textContent`；不存在 `attrs.title`。
- `attrs.open` 继续作为作者的 **defaultOpen** 使用，保留既有属性名。
  `data-open` 是该值；`data-view-open` 是当前视图有效展开值。
  点击箭头与搜索临时展开都不写 doc、dirty、Markdown 或 history。

## 构造与转换

`togglePlugin()` 已完整包含两个新 schema、NodeView、输入/粘贴/键盘规则。
现有 `applyCrepePlugins → togglePlugin()` 注册链无需额外逐节点注册。
`createEmptyToggleNode(ctx)` 保持原接口，已有 slash 菜单因此自动创建新结构。

从本目录入口导出：

```ts
createToggleNode(schema, title = '', body?, attrs = {})
// body: Fragment | Node | readonly Node[]；省略时填一个空 paragraph。
// attrs 传外层属性；open 默认为 true。没有预设 block-ID 插件 API。
unwrapToggle(view, togglePos): boolean
// 标题转换为 paragraph，正文保留原节点、marks 和嵌套结构。
```

主 agent 需要修改 `blockMenuCommands.ts` 中的 toggle 构造分支：
原来的 `wrapper.createChecked(null, Fragment.fromArray(blocks))` 不满足新 schema；
toggle 分支使用 `createToggleNode(schema, '', blocks)`。标题/正文结构节点不应作为
独立的可删除/拖动块，标题的块菜单目标应提升为包含它的 `toggle`；正文内普通块
仍按原规则定位。宿主接线文件由主 agent 所有，本任务没有修改。

## 搜索与定位（纯 view API）

```ts
const release = revealToggleAtPosition(view, match.from)
// 定位/滚动可在这里执行；包括嵌套 toggle 的所有祖先均已临时展开。
release() // 切换/关闭命中、编辑器销毁前调用。
```

临时展开支持多个调用者；最后一个调用者释放后恢复本地展开偏好或作者默认值。
期间用户点击产生的本地偏好会保留。清理函数可重复调用，节点已销毁时安全无副作用。
编辑导致节点替换时，搜索插件应针对新的有效匹配位置重新调用。接口不 dispatch，
readOnly 可用。`openToggleView(view, togglePos)` 则将本地偏好设为展开，供键盘导航。

## 编辑规则

- 标题通过 PM 的普通 selection、文本输入、DOM observer、IME、Undo/Redo 编辑，
  只继承编辑器根元素的 editable 状态，没有独立 editable、blur 提交或标题草稿。
- 标题 Enter / Shift-Enter / Tab：保留标题并进入正文；必要时仅本地展开。
- 标题 Shift-Tab：消耗按键，结构标题不缩进/提升。
- 标题开头 Backspace：无损解除外层 toggle；末尾 Delete：进入正文。
- 正文首块开头 Backspace / Shift-Tab：回到标题末尾；仅一个空正文段落时
  Backspace 将整个 toggle 还原为标题段落。
- 正文最后一个空段落 Enter：正文至少还有一个块时，删除空段落并在 toggle 后插入段落。
  嵌套列表的 Enter 使用原生列表逻辑。
- 标题的 Markdown 快捷输入与富文本粘贴保持纯文本，多行粘贴折为单行。
  跨标题/正文选区删除使用 PM 默认文本块合并语义，Undo 恢复原结构。

## 格式升级依据

持久化仍使用 `> [!toggle]- 标题` / `> [!toggle] 标题`，接受旧 `+` 后缀和无空格标题。
复杂旧标题按可见纯文本导入（marks 去掉、链接保留文字、图片保留 alt）；正文 AST
在 marker 首行之后完整保留。写回仅转义标题，marker 自身不加反斜杠，避免字面标点
被二次解释为 Markdown。空白、反斜杠、实体和 Markdown 符号有 roundtrip 测试。

应用 `CrepeEditor` / `types.ts` 的输入是 Markdown 字符串；搜索 `src` 未发现生产
`nodeFromJSON` / `Node.fromJSON` / `defaultValue: {type: 'json'}` 加载链。因此没有
拦截全局 JSON 解析或保留旧 `attrs.title`。新 JSON 正常往返；旧形状的任意 PM JSON
不声称兼容。如果主 agent 新增 JSON 存储入口，需要在该入口一次性迁移为上述结构。
已实现实际可达的旧复制 HTML 导入：`data-title + data-toggle-body` 转为正式子节点，
新 HTML 不再写 `data-title`。

## 验证

`__tests__/fixture.ts` 创建真实 Crepe + automd + callout + toggle；只补 jsdom 缺失的
Range 几何 API，不 mock schema、PM state、history、输入规则或剪贴板链。

```sh
npx vitest run src/components/crepe/plugins/toggle/__tests__ \
  src/components/crepe/plugins/__tests__/calloutToggle.coexist.test.ts \
  src/components/crepe/plugins/__tests__/slashMenuExtras.test.ts
```

覆盖旧 Markdown 与 HTML、新 JSON/DOM/Markdown 往返、嵌套内容、原生复制/粘贴、
删除/解除/转换、真实输入规则、DOM observer 中文组合输入、IME Enter 防护、Undo/Redo、
readOnly、多个实例与搜索临时展开隔离。jsdom 测试不等同于操作系统输入法实机验收。
