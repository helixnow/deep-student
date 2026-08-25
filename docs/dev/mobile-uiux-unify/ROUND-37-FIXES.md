# Round 37 落地（claude-fable-5-thinking-xhigh）

## 已修

- PlaygroundControlPanel 预设/模式/阻塞注入/折叠头
- MatchingEditor / OrderingEditor 40→44；行与输入补 coarse min-h
- FinderToolbar 视觉 40 保留（标题栏约束），伪元素 inset-0.5→1（命中 48）
- ExamSheetUploader 去文件钮 40→44
- 导图 Emoji 分类、NodeRefCard、Embed 控制、画布色板/清色
- Wallpaper 关闭/删除/导入 coarse 44；删除钮触屏常显
- 模板编辑器示例/字段 Input 压过 md:!h-7；必填与上下删除
- TagNavigation 搜索清除 40→44，去掉贴边 inset

## 仍开（Round 38+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- question-types 其余编辑器已是 44，勿重做
