# Generative UI 设计宪法

> 源自设计系统审计（Round 1）。模型与 schema **不得**绕过本约束。

## 1. 组件来源

- 仅允许 `generativeUIRegistry` 已注册 type
- 底层只能使用 `src/components/ui/shad/*`、`DsButton`、`DsDialog` 等已验证 primitive
- **禁止** props 透传 `className`、裸 hex 色、裸 px 字号

## 2. 间距（4/8/12/16/24）

生成块内部 gap/padding 限定五档 Tailwind 语义：

| 档位 | 用途 |
|------|------|
| 4 (`gap-1`, `p-1`) | 图标与文字微间距 |
| 8 (`gap-2`, `p-2`) | 控件内、列表项 |
| 12 (`gap-3`, `p-3`) | 块之间默认 |
| 16 (`gap-4`, `p-4`) | Card 内边距（与 shad Card 一致） |
| 24 (`gap-6`) | 区块分隔 |

不暴露任意 spacing token 给模型。窄屏（< `sm` / 640px）强制 stack 单列（根节点 `data-compact` + `.generative-ui-compact`），间距仅用 4/8/12 档（`--generative-ui-space-1/2/3`，见 `src/features/generative-ui/generative-ui.css`）；桌面端 v1.1 grid token（`sm:grid-cols-*`）不受影响。

## 3. 字号（三级）

| 层级 | Token / 类 | 用途 |
|------|------------|------|
| 标题 | `text-base` / `text-lg` | 块标题、指标数值 |
| 正文 | `text-sm` | 默认内容 |
| 辅助 | `text-xs` / `text-caption`（移动端） | 说明、趋势、时间戳 |

模型 schema 不提供 `fontSize` 字段。

## 4. 颜色（语义枚举）

props 中颜色/状态仅允许：

- `default` / `info` / `success` / `warning` / `destructive`（与 shad Alert/Badge 对齐）
- 渲染时使用 `bg-*` / `text-*` 语义类，自动兼容 9 palette × 明暗

## 5. 副作用与风险

- 所有副作用经 `action-bar` + 应用侧 `actionHandlers`
- `riskLevel: high` → `DsDialog` 二次确认（非模型执行）
- `riskLevel: medium` → 内联确认或轻量 dialog

## 6. 已注册 primitive（Round 40 补齐 Roadmap）

| type | 优先级 | 说明 |
|------|--------|------|
| `markdown` | P1 ✅ | 复用 chat markdown 链，schema 失败 fallback |
| `chart` | P2 ✅ | recharts 包装，限定 bar/line/pie |
| `steps` | P2 ✅ | 学习计划步骤 |
| `table` | P2 ✅ | shad Table + 列 schema |
| `mindmap-embed` | P3 ✅ | `MindMapEmbed` 引用式嵌入 |

已落地 18 种：`stat-card`, `alert`, `list`, `progress`, `action-bar`, `text`, `key-value-grid`, `flashcard-preview`, `review-calendar`, `mistake-analysis`, `mindmap-embed`, `paper-digest`, `research-plan`, `research-report`, `markdown`, `chart`, `steps`, `table`

## 7. Token 单一来源

- 原始/语义 token：`src/styles/shadcn-variables.css`、`theme-colors.css`
- Tailwind 映射：`tailwind.config.js`
- 断点/z-index：`src/config/breakpoints.ts`、`src/config/zIndex.ts`

生成式 UI 不得引入独立色板或字号体系。

## 8. Accessibility

- 根节点 `role="region"` + `aria-label`（i18n `a11y.region_label`）；流式时 `aria-busy`，状态用 `aria-live="polite"`
- 尊重 `prefers-reduced-motion`：根节点标记 `data-reduced-motion`，流式指示与进度过渡改为静态，禁止持续动画
- 进度用 `role="progressbar"` 与 `aria-valuenow` / `min` / `max`；状态、趋势、严重级别禁止只靠颜色传达
- 块标题用 heading 或 `aria-labelledby`；装饰图标 `aria-hidden`；列表用 `ul` / `ol` / `li` 或 grid
- 操作栏为 `toolbar` 或 `group`，执行中按钮 `disabled`；确认对话框须可键盘到达并接收焦点
- 闪卡：`region` + 正反面 aria；复习日历：table 或 list，日期可读；研究报告：`article`，引用可键盘到达
- Markdown：`article`/`region` + heading；图表：`role="img"` + `aria-label`（含空态）；步骤：`ol`/`li` + `aria-current` 与 sr-only 状态；表格：`caption` + `th scope="col"`
