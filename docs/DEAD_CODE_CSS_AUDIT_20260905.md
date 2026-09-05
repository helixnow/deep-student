# 死代码、CSS 与图标依赖审计（2026-09-05）

本次审计针对 `refs/remotes/newmanyouning/main@3c134a71c` 提到的旧 PromptKit、旧聊天输入、workspace/subagent UI、Notes、模板编辑器、Anki 面板、debug plugins、重复 CSS 和 lucide-react 残留。删除前同时检查静态 import、动态 import、registry/lazy、路由导航、移动端入口、demo 入口、测试与字符串路径。

## 结果

| 对象 | 证据 | 结论 |
|---|---|---|
| Anki PromptKit | `src/components/anki/cardforge/index.ts` 导出；`CardAgent.ts` 使用 | 保留 |
| 模板编辑器 | `TemplateManagementApp.tsx` 静态导入 `MinimalTemplateEditor`；其子组件和 CSS 互相导入 | 保留 |
| 旧 Chat InputBar | `src/features/chat/components/index.ts` 与 `AttachmentPreview/Uploader/InputBar.tsx` 仍有 legacy 入口说明；需继续追踪 registry 后再删 | 暂不删除 |
| lucide-react | 生产源码未发现 import；仅 `style-lab/scan-data.json` 与迁移约束测试命中 | 无生产清理项 |
| 重复 CSS | 现有 CSS 由组件静态 import、demo、移动端和 shared styles 共同使用；未发现可仅凭文件名判定的孤立文件 | 暂不删除 |

## 方法

- `rg` 检查静态和字符串引用。
- 检查 `features/chat/components/index.ts`、模板管理入口和 style-lab 扫描数据。
- 对候选文件保留删除前的 import/registry/lazy/路由/测试复核要求。

## 后续门槛

只有发现候选对象在所有上述入口均无引用后，才分批删除，并运行 `npm run typecheck`、相关 Vitest 与构建验证。当前审计没有证明任何候选满足删除条件，因此本轮不删除文件。
