# Round 51 落地（claude-fable-5-thinking-xhigh）

## 已修

- ankiCardsBlock 编辑取消/保存与悬停图标
- TodoAutomationWorkspace 刷新 / 新建 / 空态
- InputBarUI 附件面板添加 / 资源库 / 相机 / 清空 / 关闭
- QuestionBankEditor 计时 / 设置 / 裁剪 / 笔记保存
- OpenAICodexAccountSection 刷新 / 登出 / 登录
- ParallelVariantView 复制 / 重试 / 取消 / 更多
- ToolApprovalCard 拒绝 / 允许 / 展开
- RecoveryCenter 打开目录 / 导出
- OpenSourceAcknowledgementsSection 许可证入口
- SyncTab 配置与冲突决议

## 仍开（Round 52+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:` 把 DsButton 压到 30–32
