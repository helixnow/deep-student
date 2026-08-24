# optimization0824 协调文档

> 分支：`cursor/optimization0824-5575`  
> 启动：2026-08-24  
> 目标：多轮持久优化 deep-student 至 SOTA 级别  
> 约定：≥20 轮 × 10 子代理/轮，模型 `claude-fable-5-thinking-xhigh`（修复/落地），父代理只做 ≤10 行文档/配置措辞直改

## 模型分工（§11.2）

| 场景 | 模型 slug |
| --- | --- |
| 日常分析、规划、只读调研 | `claude-fable-5-thinking-xhigh` |
| 修复、落地代码、补测试 | `claude-fable-5-thinking-xhigh` |
| 复审、复查修复结果 | `claude-fable-5-thinking-xhigh` |

## 轮次进度

| 轮次 | 状态 | 子代理数 | 主题 | 合并 PR |
| --- | --- | --- | --- | --- |
| R0 | ✅ | — | 初始化分支、Goal、协调文档 | — |
| R1 | ✅ | 10 | P0 构建快速 wins（WI-1/2/3/5/8/10 + CI 降频） | 本 PR |
| R2 | 🔄 | 10 | P0 收口 WI-4 + P1 静态资源/前端 | — |
| … | ⏳ | … | 持续至 ≥R20 | — |

## Work Item 总表（来源：初始调研 WI-1..13）

| ID | 优先级 | 标题 | 状态 |
| --- | --- | --- | --- |
| WI-1 | P0 | 移除 `@anthropic-ai/claude-code` | ✅ R1 `d86ef7b5` |
| WI-2 | P0 | Windows release profile 对齐 | ✅ R1 `edc626be` |
| WI-3 | P0 | CI 启用 sccache | ✅ R1 `841eb06a`+`6bf5e0e3` |
| WI-4 | P0 | Release 前端一次构建 | R2 |
| WI-5 | P0 | PDF worker 冗余清理 | ✅ R1 `39579e63` |
| WI-6 | P1 | Android mobile-slim | R3+ |
| WI-7 | P1 | rolldown-vite + swc + tsgo | R4+ |
| WI-8 | P1 | 依赖收敛 + bundle 门禁 | 🔄 R1 脚本 `f3f96557` / R2 迁移 |
| WI-9 | P1 | pdfjs 按需化 | R5+ |
| WI-10 | P1 | Token 预算治理 | 🔄 R1 基线 `97b2a5ff` / R2 瘦身 |
| WI-11 | P2 | Provider 协议归一 | R10+ |
| WI-12 | P2 | Session JSONL replay | R12+ |
| WI-13 | P2 | Tool loop hooks | R15+ |

## R1 成果摘要（2026-08-24）

- 移除未使用 claude-code 依赖；Windows release profile 对齐；ci.yml + linux release 启用 sccache
- provider-contract PR 路径过滤；apt 包缓存；bundle 体积门禁（warn 模式）
- PDF worker 统一 .mjs；token 预算基线测试；静态资源审计报告
- 并发提交竞态：部分 WI 落在 `39579e63` 混合 commit，R2 起要求子代理 `git add <own-files>` 禁止 `git commit -am`

## R2 子代理分配（进行中）

| # | WI | 任务 | 子代理 |
| --- | --- | --- | --- |
| 1 | WI-4 | Release 前端 dist 一次构建 | SA-R2-01 |
| 2 | WI-3 | sccache macOS/Windows release | SA-R2-02 |
| 3 | — | migration-nightly apt 缓存 | SA-R2-03 |
| 4 | — | wallpapers WebP 重压缩 | SA-R2-04 |
| 5 | — | THIRD_PARTY_NOTICES 生成瘦身 | SA-R2-05 |
| 6 | WI-10 | qbank-tools schema 描述精简 Top 5 | SA-R2-06 |
| 7 | WI-8 | @hello-pangea/dnd → @dnd-kit 迁移（首批） | SA-R2-07 |
| 8 | WI-6 | mobile-slim cargo check 修复 | SA-R2-08 |
| 9 | WI-7 | rolldown-vite spike | SA-R2-09 |
| 10 | — | pdfjs cmaps 子集裁剪（保守） | SA-R2-10 |

## R1 子代理分配（已完成）

| # | WI | 任务 | 子代理 |
| --- | --- | --- | --- |
| 1 | WI-1 | 移除 claude-code 依赖 | SA-R1-01 |
| 2 | WI-2 | Windows release profile | SA-R1-02 |
| 3 | WI-3 | sccache ci.yml | SA-R1-03 |
| 4 | WI-3 | sccache reusable-build-linux | SA-R1-04 |
| 5 | WI-5 | PDF worker 清理 | SA-R1-05 |
| 6 | — | provider-contract paths 过滤 | SA-R1-06 |
| 7 | — | apt 缓存 CI | SA-R1-07 |
| 8 | WI-8 | check-bundle-size 脚本 | SA-R1-08 |
| 9 | WI-10 | token-budget 基准测试 | SA-R1-09 |
| 10 | — | wallpapers/legal 静态资源量化报告 | SA-R1-10 |

## 合并策略

- 每轮结束后：审查子代理 diff → 解决冲突 → 单轮 squash merge 或逐 WI cherry-pick
- 多 PR 并存时：P0 构建类优先合并到 `cursor/optimization0824-5575`，Agent 架构类可开子分支
- 冲突文件热点：`.github/workflows/*`、`package.json`、`vite.config.ts`

## 成果记录

- 每轮子代理报告：`docs/dev/optimization0824/progress/R{n}-*.md`
- 本文件每轮更新轮次表与 WI 状态
