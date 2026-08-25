# Round 59 落地（claude-fable-5-thinking-xhigh）

## 已修

- PluginsTab 详情返回（iPad 横屏桌面分支）/ QR 取消扫码 / 解绑 / 列表配置
- PdfReader 顶栏上传图标 / 错误条选择与关闭 / 空态选择
- FilterBuilder 关闭 / 移除筛选 / 添加 / 取消 / 应用
- AgentStrip 操作钮 CSS：细指针保持 22px，coarse 44px
- MessageItem 多变体底栏复制 / 分支 / 全量重试 / 删除图标
- SOTADashboardLite 页内返回 / 导出（`!isSmallScreen` 仍覆盖 iPad 横屏）
- ComponentCompareTab DEV 演示 DsButton
- FilePreview 工具栏 / 搜索条 coarse 40/36 → 44
- StatisticsScreen 刷新 / 错误重试
- TodayScreen 刷新图标 / 错误重试 / 开始复习 / 空态跳转
- ReviewSessionScreen 错误重试 / 批次提示关闭 / 准备失败 / 编辑保存取消

## 仍开（Round 60+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0`/`max-md:` 把 DsButton 压到 30–32
