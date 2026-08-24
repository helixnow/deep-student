# Generative UI 架构方案（DeepStudent）

> 分支：`Generative-UI-0824` · 持续迭代中

## 1. 核心结论

DeepStudent 最适合的生成式 UI 模式是 **结构化意图 + 组件注册表**：

- 模型只输出 JSON（`blocks[]`），描述 `type` + `props`
- 应用侧 `generativeUIRegistry` 映射到已验证的 shadcn/设计系统组件
- Zod schema 校验，不合法拒绝或降级
- 副作用（提交、删除、导出）由确定性 `actionHandlers` 执行，模型不直接执行

这与现有 **Chat V2 blockRegistry** 哲学一致，但面向「动态仪表盘 / Copilot 面板」而非聊天流块。

## 2. 模块结构

```
src/features/generative-ui/
├── schema.ts          # Zod 意图 + props schema
├── registry.ts        # 组件注册表
├── parser.ts          # 流式 JSON 增量解析
├── GenerativeUIRenderer.tsx
├── GenerativeUIChrome.tsx   # AI 标记 + 接受/忽略/重生成
├── prompts.ts         # 系统 prompt 模板
├── blocks/index.ts    # 内置 7 种块（import 即注册）
└── components/        # stat-card, list, alert, ...
```

## 3. 设计系统约束

- 仅允许注册表内组件，禁止模型输出 HTML/CSS/JS
- 复用 `src/components/ui/shad/*` 与 CSS 变量 token
- 间距 8px 倍数；字号 2–3 级；主色 + 中性色 + 状态色

## 4. Human-in-the-loop

- `GenerativeUIChrome`：角标「AI 生成」+ 接受 / 重新生成 / 忽略
- `action-bar` 块：`riskLevel: high` 需二次点击确认
- 高风险 action 由应用注册 handler，不经 LLM

## 5. 集成路线图

| 阶段 | 场景 | 状态 |
|------|------|------|
| P0 | 核心 registry + renderer + 测试 | ✅ Round 1 |
| P1 | Chat 侧边 Copilot 面板 | 待 Round 2+ |
| P2 | 学习 Hub / 复习计划动态仪表盘 | 待 Round 3+ |
| P3 | Notes 摘要卡片 / 调研报告 UI | 待 Round 4+ |
| P4 | 与 blockRegistry 桥接 | 待 Round 5+ |

## 6. 示例意图

```json
{
  "version": "1",
  "meta": { "title": "本周学习概览" },
  "blocks": [
    { "type": "stat-card", "props": { "title": "完成练习", "value": 24, "trend": "up" } },
    { "type": "list", "props": { "title": "待巩固", "items": [{ "label": "线性代数" }] } }
  ]
}
```

## 7. 子代理迭代

- 每轮 10 × `claude-fable-5-thinking-xhigh` 子代理并行调研/实现
- 目标 ≥20 轮，覆盖 chat、notes、question-bank、workbench、research 等模块
- 进度见 [PROGRESS.md](./PROGRESS.md)
