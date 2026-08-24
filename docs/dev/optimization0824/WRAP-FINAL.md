# optimization0824 最终验收报告

> 验收代理：SA-WRAP-ACCEPT2
> 分支：`cursor/optimization0824-5575`
> 验收树：`e8051faf`（2026-08-24，报告提交前最新远端树）
> 结论：**可以停止持续轮次；13 个 WI 为 12 个 ✅ + 1 个部分（WI-7 rolldown）。**

## 1. 验收摘要

- P0（WI-1～WI-5）全部落地；P1 主体全部落地，WI-7 的 rolldown 部分因
  Vite 6 上游兼容问题延期；P2 中 WI-11 Phase 1、WI-12 与 WI-13 本轮范围
  均已落地。
- 13 个 WI 最终口径为：**12 个 ✅、1 个部分（WI-7 rolldown）**。
- 最新树的 build、license、tsc/tsgo、bundle、定向 Vitest、WI-12/WI-13
  Rust 测试均有成功记录；Rust 定向结果为 pipeline 250、session export 11、
  provider quirks 4、reasoning policy 33，合计 298 passed、0 failed；
  workflow 终检为 17 个文件、actionlint 0 诊断。
- 未发现需在本报告前修复的阻断级代码问题。合并前仍需一轮不被新 push
  取消的 GitHub CI 终态结果，并处理 PR #213 的 CLA 外部门禁。

状态定义：`✅` = 本轮定义的可验收范围完整落地；`部分` = 已有可用收益，但原
目标仍有明确未落地部分；`❌` = 没有实现产物。调研、计划或 spike 不计为实现。

## 2. R1～R4 轮次验收

| 轮次 | 状态 | 已落地 WI / 能力 | 验收判断 |
| --- | --- | --- | --- |
| R1 | ✅ | WI-1/2/3/5；WI-8 bundle 基线；WI-10 token 基线；provider-contract 路径过滤与 apt 缓存 | P0 快速收益均有代码或 workflow 产物 |
| R2 | ✅ | WI-4；WI-6 编译门控；WI-8 DnD/资产；WI-9 PDF 子集；WI-10 Top 5；macOS/Windows sccache | 计划范围完成；rolldown spike 的失败结论有效但不算落地 |
| R3 | ✅ | WI-6 CI；WI-7 SWC + tsgo spike；WI-8 依赖/门禁；WI-10 Top 6～15；WI-11 计划；WI-12 spec/stub；前端 CI 并行 | R3 交付完成；stub/计划只按中间产物计 |
| R4/WRAP | ✅ | WI-7 tsgo；WI-8/9/10；WI-11 Phase 1；WI-12；WI-13 第一阶段；CI/依赖/合并卫生 | 10/10 R4 工作包完成，收尾验收通过 |

## 3. WI 最终对照表

| WI | 落地轮次 | 状态 | 最终证据与边界 |
| --- | --- | --- | --- |
| WI-1 移除 Claude Code 依赖 | R1 | ✅ | `@anthropic-ai/claude-code` 从 manifest、lockfile、安装树移除；许可证组件同步减少 |
| WI-2 Windows release profile | R1 | ✅ | Windows 与 macOS/Linux 对齐为 `LTO=false`、`codegen-units=16` |
| WI-3 CI sccache | R1～R2/R4 | ✅ | 5 个 CI Rust 编译 job + Linux/macOS/Windows release，共 8 个安装点；均有 stats |
| WI-4 Release 前端只构建一次 | R2 | ✅ | 5 平台各自构建改为 1 个 `frontend-dist` artifact，4 个平台 job 复用 |
| WI-5 PDF worker 去重 | R1/R4 | ✅ | 删除旧 v3 `.js`；当前 worker payload 从 `pdfjs-dist/build` 构建期复制，仓库只保留 wrapper |
| WI-6 Android mobile-slim | R2/R3 | ✅ | host compile 通过；release/recovery workflow 均启用 `mobile-slim`，profile 为 `z/16` |
| WI-7 rolldown + SWC + tsgo | R2～R4 | **部分** | SWC 与 tsgo 已落地；rolldown 在 Vite 6 内部 panic，待 Vite 7 后重试 |
| WI-8 依赖收敛 + bundle 门禁 | R1～R4 | ✅ | 移除 DnD 旧栈及 R4 19 个直接生产依赖；FlowToken 懒加载；7 项 gzip 预算通过 |
| WI-9 pdfjs 按需化 | R2/R4 | ✅ | 本地 CMap/WASM 子集、三级 fallback、缺字日志、worker/legal 单源及 19 个新增测试 |
| WI-10 Token 预算治理 | R1～R4 | ✅ | 43 个 skill 组全部处理；schema 估算 token 累计下降 13.7%，护栏收紧至约 10% 余量 |
| WI-11 Provider 协议归一 | R3/R4 | ✅ Phase 1 | `provider_quirks.rs` 已集中 Phase 1 quirks；旧 `is_mimo_config`/`is_mistral_config`/`is_qwen_config`/`is_mimo_endpoint` 已迁移并删除；quirks 4 + reasoning 33 tests 通过 |
| WI-12 Session JSONL | R3/R4/WRAP | ✅ | 流式导出、默认脱敏、variant/state/compaction、Tauri command/ACL；11 个 Rust 测试通过 |
| WI-13 Pipeline hooks | R4/WRAP | ✅ | 4 个切点、审批/审计默认 hook、安全封装与顺序守卫；hooks 复查发现均已修复，pipeline 250 tests 通过 |

## 4. 构建、体积与 CI 量化收益

### 4.1 构建与开发反馈

| 项目 | 基线 → 当前/落地值 | 收益 | 证据性质 |
| --- | ---: | ---: | --- |
| Vite React 转换 | 1m27s → 1m10s | **-17s，约 -20%** | 同机同树 SWC A/B |
| TypeScript 原生检查 | 47.3s → 6.0s | **约 7.9×** | R4 三次中位数；tsc 保留为 CI 硬门禁 |
| 最新生产构建 | 19,597 modules，Vite 约 1m6s | 成功 | 最新 WRAP 本地验证 |
| Skill schema token | 54,050 → 46,671 | **-7,379，-13.7%** | 固定 `chars/4` 回归口径 |
| schema + content | 75,689 → 68,310 | **-9.7%** | 同上 |
| `tool_loop.rs` | 5,507 → 4,171 行 | **-24.3%** | 横切逻辑迁入 hooks；不是总代码删除 |

rolldown 的约 11～12s transform 仅来自失败 spike，不计入已实现收益。

### 4.2 安装包/前端体积

| 项目 | 基线 → 当前 | 直接变化 |
| --- | ---: | ---: |
| 4 张壁纸 | 5,051,372 B → 1,410,396 B | **-3,640,976 B（-72.1%）** |
| 冗余 PDF worker v3 | 1,087,212 B → 0 | **-1,087,212 B** |
| pdfjs CMap/WASM/字体 | 2,750,161 B → 1,754,030 B | **-996,131 B（-36.2%）** |
| NOTICES 安装包 payload | 2 × 2,585,108 B → 1 × 1,250,120 B | **-3,920,096 B（-75.8%）** |
| `init-*.js` gzip | 1,396.9 KiB → 336.8 KiB | **-75.9%** |
| entry gzip | 1,189.3 KiB → 1,178.0 KiB | **约 -1.0%** |
| total JS gzip | 8,344.1 KiB → 8,285.2 KiB | **约 -0.7%** |

前四项按未压缩安装包输入字节相加，较初始树每个平台包减少
**9,644,415 B（约 9.20 MiB）**；实际 DMG/MSI/AppImage/APK 的压缩后差值需
由一次完整 release 实测。`init` 的大幅下降主要是 FlowToken 转为异步 chunk，
因此 total JS 只小幅下降，不能把 75.9% 解释为总代码删除。

当前本地 `dist/` 为约 36.74 MB；bundle 7 项预算全部通过。

### 4.3 CI

| 项目 | 结构变化 | 量化结论 |
| --- | --- | --- |
| Release 前端 | 5 次重复构建 → 1 次 artifact 构建 | **预期**每次 release 少 4 次构建，省 8～10 runner-min；macOS Intel/Android 关键路径各约 -2min |
| Frontend CI | 串行 lint/typecheck/build → 3 leg 并行 + fail-closed 聚合 | **预期**反馈 wall time -40%～-60%；代价是 `npm ci` 从 1 次增至 3 次 |
| apt 缓存 | 9 个安装点 | CI 全 run **预期**省 12～18 Linux runner-min；Linux release 关键路径约 -1～2min |
| sccache | 8 个 Rust 编译点 | 结构已完整；真实命中率/墙钟尚无未取消 run 可取数 |
| workflow 卫生 | actionlint 36 条 → 0 条 | **实测** v1.7.12 + shellcheck v0.9.0，17 workflows，exit 0 |
| provider-contract | 所有 PR 无条件跑 → path-filter | 无关 PR 可跳过 120min timeout-budget job；真实均值尚未回填 |

以上 CI 时长中标记“预期”的数字不能当作线上实测。该分支在收尾阶段连续 push，
近期 CI 均被 `concurrency.cancel-in-progress` 取消；报告提交后的最新 SHA 必须再
取得一次完整终态结果。

## 5. 已知限制与剩余风险

1. **WI-11 验收边界**：Phase 1 已完整落地并验收；Phase 2～4 仍保留在
   `WI-11-provider-refactor-plan.md`，不属于本轮承诺范围，也不影响停止结论。
2. **rolldown 待 Vite 7**：Vite 6 的 `rolldown-vite` spike 在 chunk 生成阶段
   内部 panic；依赖改动已回退。升级 Vite 7 后再做同树 A/B。
3. **CI 尚无最终样本**：sccache 命中率、release 141min 基线改善、Android
   构建墙钟及 APK/`.so` 体积均未取得有效新 run；当前收益只能分为结构实证和预期。
4. **外部门禁**：PR #213 的 CLA Assistant 已报告部分提交者未签署 CLA；
   代码无法修复，合并前必须由对应提交者处理。
5. **bundle gate 仍是 warn 模式**：计划在约 2026-09-07 无误报后去掉
   `--warn-only`。当前超限不会阻塞 CI。
6. **Android 运行时未完整验收**：`mobile-slim` 的 host compile 与 workflow
   接线已验收，但尚缺签名 APK 真机/CI 数据；语义搜索相关能力在 slim feature
   下会显式不可用。
7. **PDF 远程恢复默认关闭**：未配置自有稳定镜像时，子集外旧式非 GB CMap
   仍会记录缺字并降级；fallback 代码与缓存已就绪。Android 个别资源布局下
   设置页读取 NOTICES 也可能退到错误态，但包内合规文件仍存在。
8. **WI-12 范围是导出**：import、真正的 replay executor 与前端菜单入口仍在
   后续列表，不应从“JSONL export 已完成”推导为双向迁移完成。
9. **WI-13 是第一阶段**：live workspace injection、variant/hook 组合与可否决
   compaction hook 未做；当前审批/审计四切点已经完成本轮验收。
10. **构建告警未清零**：Vite 仍报告 renderer barrel circular chunk，以及若干
    静态/动态重复 import；当前不阻塞 build，但应在独立拆包工作中处理。
11. **生产依赖安全债**：`npm audit --omit=dev` 当前为 2 high、3 moderate、
    0 critical（含 `nanoid`、`dompurify`、`mermaid`、`postcss` 和传递
    `brace-expansion`），CI 仍为 informational。需做定向升级和回归，不建议
    用无审查的 `npm audit fix --force`。
12. `framer-motion` LazyMotion 迁移仍可能再移出约 100 KiB gzip，但涉及 51 个
    动画文件和视觉回归，不适合作为本轮尾部机械修改。

## 6. 是否停止持续轮次

**结论：可以停止持续轮次。**

理由：

- 13 个 WI 已达到 12 个 ✅ + 1 个部分，P0 全部完成，主要构建/体积/依赖/
  Agent 基础设施收益已经落地；
- 继续按“大轮次 × 多代理”推进会增加热点文件冲突和 CI 取消，边际收益已低于
  集成成本；
- 剩余事项都有清晰前置或边界，适合独立 issue/PR，而不是继续泛化清扫。

停止持续轮次不等于 rolldown 已落地。本轮只剩以下三个有界收尾事项：

1. 等 Vite 7 后重试 rolldown；
2. 取得一次未被新 push 取消的完整 CI 样本，回填 sccache、墙钟和产物体积；
3. 由对应提交者人工签署 CLA，解除外部门禁。

合并当前 PR 的最低条件是：最新报告 SHA 的 required CI 终态通过，且 CLA 门禁
解除。WI-7 rolldown 已明确延期到 Vite 7，不阻塞本轮收尾。

## 7. 验证命令

### 前端、许可证与 bundle

```bash
npm ci --legacy-peer-deps
npm run version:generate
npm run licenses:check
npm run typecheck
npm run typecheck:native
npm run lint
npm run build
npm run check:bundle-size

npx vitest run \
  tests/vitest/chat-v2/token-budget.test.ts \
  tests/vitest/pdf \
  src/utils/__tests__/pdfAssets.test.ts \
  src/features/chat/components/renderers/__tests__/MarkdownRenderer.flowtoken.test.tsx \
  tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx
```

### Rust 关键路径

Linux 首次运行需准备与 CI 相同的工具链/系统依赖及 PDFium：

```bash
rustup update stable
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf protobuf-compiler lld
bash scripts/download-pdfium.sh linux-x64

cd src-tauri
cargo check --lib
cargo test --lib chat_v2::pipeline
cargo test --lib chat_v2::session_export
cargo test --lib llm_manager::provider_quirks
cargo test --lib reasoning_policy
```

预期关键结果：pipeline 250 passed；session export 11 passed；
provider quirks 4 passed；reasoning policy 33 passed，合计 298 passed、0 failed。

### Workflows 与遗留项

```bash
python3 - <<'PY'
from pathlib import Path
import yaml
paths = list(Path(".github/workflows").glob("*.yml"))
for path in paths:
    yaml.safe_load(path.read_text())
print(f"parsed {len(paths)} workflow files")
PY

actionlint -no-color .github/workflows/*.yml

test -f src-tauri/src/llm_manager/provider_quirks.rs
! rg 'fn is_(mimo|mistral|qwen)_config|fn is_mimo_endpoint' \
  src-tauri/src/llm_manager/model2_pipeline.rs

gh pr checks 213 --repo helixnow/deep-student
gh run list --repo helixnow/deep-student \
  --branch cursor/optimization0824-5575 --limit 10
```

两条 WI-11 命令应确认 quirks 文件存在，且旧 MiMo/Mistral/Qwen 判定函数已从
pipeline 迁移并删除。
