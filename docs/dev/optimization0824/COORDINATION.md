# optimization0824 协调文档

> 分支：`cursor/optimization0824-5575`  
> 启动：2026-08-24  
> 目标：多轮持久优化 deep-student 至 SOTA 级别  
> 初始约定：≥20 轮 × 10 子代理/轮；R4 收尾验收完成后已停止持续轮次。
> **任务粒度（2026-08-24 补充）**：每个子代理必须被分配**足够大的可落地工作包**（多文件实现 + 测试 + 报告），禁止只给单点小改。一轮 10 个子代理结束后必须出现**巨大且可靠**的进展。

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
| R2 | ✅ | 10 | P0 WI-4 + P1 静态资源/前端/Agent schema | 本 PR |
| R3 | ✅ | 10 | deps/CI/Agent schema/P2 前置 | 本 PR |
| R4 | ✅ 收尾完成 | 10 | 10/10 工作包已合入；WI-11 Phase 1 与合并卫生收尾完成 | 本 PR |
| 后续持续轮次 | 已停止 | — | 仅保留 Vite 7/rolldown、完整 CI 样本与 CLA 人工签署 | — |

## Work Item 总表（来源：初始调研 WI-1..13）

| ID | 优先级 | 标题 | 状态 |
| --- | --- | --- | --- |
| WI-1 | P0 | 移除 `@anthropic-ai/claude-code` | ✅ R1 `d86ef7b5` |
| WI-2 | P0 | Windows release profile 对齐 | ✅ R1 `edc626be` |
| WI-3 | P0 | CI 启用 sccache | ✅ R1 `841eb06a`+`6bf5e0e3` |
| WI-4 | P0 | Release 前端一次构建 | ✅ R2 `2ee0039d` |
| WI-5 | P0 | PDF worker 冗余清理 | ✅ R1 删 v3 副本；R4 改为 `pdfjs-dist` 构建单源 |
| WI-6 | P1 | Android mobile-slim | ✅ R2 编译门控 + R3 release/recovery CI 落地 |
| WI-7 | P1 | rolldown-vite + swc + tsgo | ✅ R4 tsgo 落地（rolldown 留待 Vite 7） |
| WI-8 | P1 | 依赖收敛 + bundle 门禁 | ✅ R4 再删 19 个生产依赖，FlowToken 改懒加载 |
| WI-9 | P1 | pdfjs 按需化 | ✅ R4 运行时 fallback + legal 去重 |
| WI-10 | P1 | Token 预算治理 | ✅ R4 43 个 skill 组全部精简，护栏收紧 |
| WI-11 | P2 | Provider 协议归一 | ✅ R4 Phase 1：quirks 归一 + 请求快照（`72fed933`）；Phase 2～4 待后续 |
| WI-12 | P2 | Session JSONL replay | ✅ R4 JSONL export + 测试 + Tauri command（`ae714af9`） |
| WI-13 | P2 | Tool loop hooks | ✅ R4 第一阶段：4 切点 + 审批/审计 hooks（`728472b4`） |

## R1 成果摘要（2026-08-24）

- 移除未使用 claude-code 依赖；Windows release profile 对齐；ci.yml + linux release 启用 sccache
- provider-contract PR 路径过滤；apt 包缓存；bundle 体积门禁（warn 模式）
- PDF worker 统一 .mjs；token 预算基线测试；静态资源审计报告
- 并发提交竞态：部分 WI 落在 `39579e63` 混合 commit，R2 起要求子代理 `git add <own-files>` 禁止 `git commit -am`

## R2 成果摘要（2026-08-24）

- WI-4 前端 dist 一次构建；sccache macOS/Windows；apt nightly 缓存
- wallpapers -72%；NOTICES -51%；pdfjs cmaps -544KB；DnD 全量迁移；mobile-slim compile 通过
- rolldown-vite @ vite6 失败（文档化），待 vite7

## R3 成果摘要（2026-08-24）

- 移除 hello-pangea/dnd；Android mobile-slim CI + opt-level=z；plugin-react-swc（build -20%）
- tsgo spike：7.8× 提速，待 R4 落地；schema batch2 -11.4%；bundle 基线收紧
- WI-12 spec+stub；WI-11 四阶段计划；frontend CI 并行；actionlint 复审无新增告警

## R4 成果摘要与遗留（2026-08-24）

- 已合入 tsgo、WI-12 JSONL export、WI-10 收口、WI-13 hooks 第一阶段、CI/质量债、
  PDF 运行时 fallback、Rust 大文件拆分，以及 R4-04 依赖清扫（`e31ace7b`）。
- R4-04 从生产依赖再移除 19 项，FlowToken 改为懒加载；`THIRD_PARTY_NOTICES`
  冲突按最终 lockfile 重新对齐，保留依赖清扫后的 1847 个组件清单。
- WI-11 Phase 1（11-1a～11-1d）已由 `72fed933` 合入：新增
  `llm_manager/provider_quirks.rs`，迁移 S1～S4、B1～B4、B9、B13 与 S7，
  删除 pipeline 内 MiMo/Mistral/Qwen 判定函数，并新增两组 16 场景请求快照。
- WI-11 Phase 2～4 仍按 `WI-11-provider-refactor-plan.md` 作为后续工作。
- WRAP hygiene 已确认无合并冲突标记、`public/` 无重复 worker，并移除
  `vite.config.ts` 中已卸载的 `react-hotkeys-hook` optimizeDeps 条目；许可证与
  worker 文档路径已对齐当前构建链。
- 依赖清扫遗留：framer-motion LazyMotion 迁移需动画回归，仍应作为独立工作包。

## R4 子代理分配（收尾）

| # | 工作包 | 子代理 | 收尾状态 |
| --- | --- | --- | --- |
| 1 | tsgo 全量落地：tsconfig + Blob 修复 + CI 双跑 | SA-R4-01 | ✅ `bd145465` |
| 2 | WI-12 JSONL 导出完整实现 + 测试 + Tauri command | SA-R4-02 | ✅ `ae714af9` |
| 3 | WI-11 Phase1 全部 11-1a~1d（quirks + 快照） | SA-R4-03 / SA-WRAP-WI11 | ✅ `72fed933`（WRAP 合入） |
| 4 | 前端未用依赖清扫 + licenses + 低频库评估落地 | SA-R4-04 | ✅ `e31ace7b`（WRAP 合入） |
| 5 | WI-10 剩余全部 skill 组精简 + 首轮 token CI 报告 | SA-R4-05 | ✅ `2b98a42f` |
| 6 | WI-13：tool_loop 横切抽 PipelineHook（审批+审计） | SA-R4-06 | ✅ `728472b4` + `8454faf9` |
| 7 | CI 剩余：linux apt、36 条 actionlint、注释与门禁 | SA-R4-07 | ✅ `82bbc874` |
| 8 | WI-9：pdfjs 运行时下载 + legal 去重 + 静态资产 | SA-R4-08 | ✅ `d248cbab` + `53057822` |
| 9 | Rust 编译卫生：大文件拆分非 pipeline 热点 + 测试 | SA-R4-09 | ✅ `83e344e6` |
| 10 | 复审 R1–R3 遗漏并落地修复（质量债清扫） | SA-R4-10 | ✅ `f881b4b7` + `94d4e69d` |

## R3 子代理分配（已完成）

| # | WI | 任务 | 子代理 |
| --- | --- | --- | --- |
| 1 | WI-8 | 移除 @hello-pangea/dnd 依赖 | SA-R3-01 |
| 2 | WI-6 | Android workflow mobile-slim + opt-level | SA-R3-02 |
| 3 | WI-7 | plugin-react-swc 替换 Babel | SA-R3-03 |
| 4 | WI-7 | tsgo typecheck spike | SA-R3-04 |
| 5 | WI-10 | 第二批 schema 精简 Top 6-15 | SA-R3-05 |
| 6 | WI-8 | 收紧 bundle-size 基线 | SA-R3-06 |
| 7 | WI-12 | session JSONL export 设计+stub | SA-R3-07 |
| 8 | WI-11 | model2_pipeline 分支归属分析 | SA-R3-08 |
| 9 | — | frontend CI eslint/build 并行化 | SA-R3-09 |
| 10 | — | actionlint 全 workflow 复审 | SA-R3-10 |

## R2 子代理分配（已完成）

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
