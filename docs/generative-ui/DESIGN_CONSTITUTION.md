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

不暴露任意 spacing token 给模型。

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

## 6. 待注册 primitive（Roadmap）

| type | 优先级 | 说明 |
|------|--------|------|
| `markdown` | P1 | 复用 chat markdown 链，schema 失败 fallback |
| `chart` | P2 | recharts 包装，限定 bar/line/pie |
| `steps` | P2 | 学习计划步骤 |
| `table` | P2 | shad Table + 列 schema |

已落地：`stat-card`, `alert`, `list`, `progress`, `action-bar`, `text`, `key-value-grid`, `flashcard-preview`, `review-calendar`, `mistake-analysis`

## 7. Token 单一来源

- 原始/语义 token：`src/styles/shadcn-variables.css`、`theme-colors.css`
- Tailwind 映射：`tailwind.config.js`
- 断点/z-index：`src/config/breakpoints.ts`、`src/config/zIndex.ts`

生成式 UI 不得引入独立色板或字号体系。
