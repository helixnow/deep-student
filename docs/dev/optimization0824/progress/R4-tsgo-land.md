# R4-tsgo-land：WI-7 tsgo typecheck 正式落地（tsconfig + BlobPart 修复 + 双门禁）

> 子代理：SA-R4-01（模型 `claude-fable-5-thinking-xhigh`）
> 日期：2026-08-24
> 分支：`cursor/optimization0824-5575`
> 前置：`R3-tsgo-spike.md`（可行性验证，docs-only）
> 状态：✅ 已落地 —— R3 报告识别的两个落地阻碍（tsconfig `baseUrl`、3 处 TS2322）
> 全部修复，`typecheck`（tsc 5.6）与 `typecheck:native`（tsgo）双双 0 error 通过，
> CI frontend typecheck 腿并行双跑、均为硬门禁。

## 结论（TL;DR）

- 本地全量 typecheck 从 **~47s（tsc 5.6.3）降到 ~6s（tsgo）**，wall 提速 **~7.9×**
  （4 vCPU VM，中位对比 47.3s → 6.0s；核越多收益越大）。
- 两个编译器对同一份 `tsconfig.json` 均 **0 error / exit 0**，R3 发现的
  3 处 TS2322 前瞻性类型问题已按建议修掉（未来升级 typescript ≥5.7 不再暴雷）。
- CI 的 frontend typecheck 腿改为 **同 leg 内并行双跑 tsc + tsgo，任一非零即红**
  （硬门禁）。tsgo ~7s 完全被 tsc ~50s 遮蔽，**CI 时长与成本零增加**，
  白赚一路 TS7 一致性信号。

## 变更清单

| 文件 | 变更 |
| --- | --- |
| `tsconfig.json` | 删 `"baseUrl": "./"`；`paths` 相对化 `"@/*": ["src/*"]` → `["./src/*"]`（TS7 移除 `baseUrl`，相对 `paths` 写法 TS 4.1+ 支持，对 tsc 5.6 语义等价——本轮实测 0 error） |
| `src/utils/base64FileUtils.ts` | `base64ToUint8Array` 去掉显式返回注解 `Uint8Array \| null`，交给推断：TS 5.7+/tsgo 推出 `Uint8Array<ArrayBuffer> \| null`（满足 `BlobPart`），TS 5.6 下仍为 `Uint8Array \| null`，双版本兼容。`base64ToFile`（原 :99）与 `base64ToBlob`（原 :125）两处 TS2322 随源头修复自然消除 |
| `src/features/learning-hub/apps/views/epubReaderModel.ts` | `resourceUrl` 中 JSZip 的 `file.async('uint8array')` 返回裸 `Uint8Array`，局部收窄 `as BlobPart`（运行时值为 `ArrayBuffer` 背书，满足新 lib.dom 约束；等 `jszip` 类型升级后可移除） |
| `package.json` / `package-lock.json` | `devDependencies` 新增 `@typescript/native-preview@^7.0.0-dev.20260707.2`；scripts 新增 `"typecheck:native": "tsgo --noEmit -p tsconfig.json"`，原 `typecheck`（tsc）保留不动 |
| `.github/workflows/ci.yml` | frontend-checks 的 typecheck 腿由 `npx tsc --noEmit` 改为同 leg 内后台并行跑 `tsc` + `tsgo`（各自独立日志与 exit code），两者任一失败即 `exit 1` —— 都是硬门禁，经既有 `frontend` 聚合 job 收敛进 required check |

未触碰：`model2_pipeline` / `tool_loop` / `session_export`（按任务约束）。

## 验证：双 script 全部通过

环境：Linux x86_64（Cloud Agent VM），4 vCPU / 15GiB RAM，Node v22.14.0，npm 10.9.7。
`npm ci --legacy-peer-deps` 干净安装后、`node scripts/generate-version.mjs` 生成版本文件后各跑 3 次。

| script | 编译器 | 运行 1 | 运行 2 | 运行 3 | 中位 | 结果 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `npm run typecheck` | tsc 5.6.3 | 50.2s | 47.3s | 47.1s | **47.3s** | 0 error，exit 0 |
| `npm run typecheck:native` | tsgo 7.0.0-dev.20260707.2 | 6.07s | 6.01s | 5.99s | **6.01s** | 0 error，exit 0 |

- **提速 ~7.9×**（47.3s → 6.0s）。与 R3 spike 数据（51.2s → 6.6s，~7.8×）一致。
- tsgo 三次运行输出完全一致，无 flakiness；对修复后的代码与 tsc 结论一致（均 0 error）。
- `tsconfig.strict.json` 通过 `extends: "./tsconfig.json"` 继承根配置；`extends` 语义下
  相对 `paths` 按声明文件（根 config）解析，行为不变。

## CI 门禁设计说明

- **为什么同 leg 并行而不是加第 4 个 matrix leg**：tsgo 全量只要 ~7s，单开一个
  leg 要额外付一次 checkout + `npm ci`（缓存命中也要 1-2 分钟），信噪比极差。
  放进现有 typecheck 腿用 shell 后台任务并行，tsc（~50s）是关键路径，
  tsgo 完全被遮蔽，leg 时长不变。
- **硬门禁语义**：两个编译器各自输出独立日志段（`== tsc ==` / `== tsgo ==`，
  含各自 exit code 与耗时），任一非零则步骤 `exit 1` → matrix leg 红 →
  `frontend` 聚合 job（required check，fail-closed）红。
- **双跑期定位**：tsgo 仍是 preview（dev 版号），双跑期以 tsc 5.6 为权威信号、
  tsgo 提供 TS7 前瞻一致性 + 未来切换的信心积累。TS 7.0 正式发布后直接升级
  `typescript` 依赖并收敛为单跑（届时 typecheck 关键路径 ~50s → ~7s）。

## 后续建议（不在本任务范围）

1. 开发侧：`prebuild` 里的 typecheck 仍走 tsc（权威门禁语义不变）；开发者日常可用
   `npm run typecheck:native` 拿 6s 级反馈，或装 VS Code「TypeScript (Native Preview)」
   插件吃 LSP 提速。
2. 观察 2-4 周 CI 双跑一致性后，可把 `prebuild` 的 typecheck 切到 tsgo，
   每次 `vite build` 启动延迟减 ~40s。
3. `jszip` 类型若发布泛型 TypedArray 适配版本，移除 `epubReaderModel.ts` 的
   `as BlobPart` 局部收窄。
