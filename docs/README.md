# docs/ 目录索引

> 用户指南在线版：https://deepstudent.cn/docs/

## 开发必读

| 文档 | 说明 |
|------|------|
| [CODE_STYLE.md](./CODE_STYLE.md) | 代码风格规范（React/Rust/i18n/拖拽上传/日志） |
| [BUILD-CONFIG.md](./BUILD-CONFIG.md) | 跨平台构建环境配置（签名、证书、环境变量） |
| [README-BUILD.md](./README-BUILD.md) | 构建脚本快速参考 |

## 架构与设计

| 文档 | 说明 |
|------|------|
| [design-tokens-and-color-semantics.md](./design-tokens-and-color-semantics.md) | 设计令牌与颜色语义体系 |
| [DEEPSEEK-V4-V32-RELEASE-NOTES.md](./DEEPSEEK-V4-V32-RELEASE-NOTES.md) | DeepSeek 系列适配器设计说明 |
| `src/features/chat/BLOCK_RENDERING_GUIDE.md` | Chat V2 块渲染开发者手册（就地文档） |
| `src-tauri/migrations/README.md` | 数据库迁移规范（就地文档） |

## 专项进行中

| 文档 | 说明 |
|------|------|
| [FABLE_SOTA_GOAL.md](./FABLE_SOTA_GOAL.md) | Fable SOTA 目标与进度 |
| [cloud-sync-remediation-plan.md](./cloud-sync-remediation-plan.md) | 云同步整治计划 |
| [cloud-sync-compatibility-analysis-2026-05-23.md](./cloud-sync-compatibility-analysis-2026-05-23.md) | 云同步兼容性分析（上文依据） |

## 评审记录

`reviews/` — 按日期命名的评审与修复记录（如 `docs-distribution-review-2026-06-11.md`）。

## 法务

| 文档 | 说明 |
|------|------|
| [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) | 第三方许可证清单 |

## 内部目录（不随仓库发布）

- `archive/` — 已完结的历史评审/计划/报告归档（git 忽略）
- `design/` — 内部设计契约文档（git 忽略）：learning-hub-core-contracts、chat-v2-model-protocol
- `RELEASE-WORKFLOW.md` — 发布流程（git 忽略）

## 文档放置约定

1. 公开技术文档放 `docs/` 根层，评审记录放 `docs/reviews/`
2. 内部一次性产物完结后移入 `docs/archive/`
3. 内部设计契约放 `docs/design/`
4. 组件级文档随代码就地存放（如 `src/features/chat/`）
5. 引用代码一律用仓库相对路径，禁止本机绝对路径
