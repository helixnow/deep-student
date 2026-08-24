# R3-tsgo-spike：WI-7 tsgo（TypeScript 原生编译器）typecheck 可行性验证

> 子代理：SA-R3-04（模型 `claude-fable-5-thinking-xhigh`）  
> 日期：2026-08-24  
> 分支：`cursor/optimization0824-5575`  
> 状态：⚠️ docs-only——tsgo 检查保真度极佳（错误输出与 stock tsc 5.9 **逐字节一致**）且
> **~7.8× 提速（51.2s → 6.6s）**，但当前 `tsconfig.json`（`baseUrl`）会让
> `typecheck:native` 开箱即挂，且 TS7 lib 下有 3 处真实 TS2322 需先修——两者都超出本任务
> 允许改动集（仅 package.json/lock/报告），故依赖与 script 已 revert，仅留本报告。
> **强烈建议 R4 按三步落地，typecheck 从 ~1 分钟降到 <10s。**

## 结论（TL;DR）

- `@typescript/native-preview`（tsgo，Go 移植的 TS 7 编译器）版本 `7.0.0-dev.20260707.2`
  （npm 最新），全量 typecheck **6.5–6.9s**，对比项目锁定的 tsc 5.6.3 的 44–53s，
  wall 提速 **~7.8×**（4 vCPU VM；核越多收益越大，上游宣称 ~10×）。
- **保真度**：修掉 config 障碍后，tsgo 的错误输出与 stock `tsc 5.9.3` **diff 为空**——
  全部差异来自 TS 5.6→5.7+ 的版本代差（泛型 TypedArray），**不是 tsgo 移植缺陷**。
- 两个落地阻碍（都小，但涉及 tsconfig.json 与 src，超出本任务只准动
  package.json/lock/报告 的约束）：
  1. **TS7 移除 `baseUrl`**：tsgo 对现 `tsconfig.json` 直接报 config error
     （TS5102 + TS5090），0.9s 内退出、不做任何检查。修复 = 删 `baseUrl` +
     `paths` 相对化（`"@/*": ["./src/*"]`），该写法 TS 4.1+ 支持，
     **已实测 tsc 5.6 下 0 error、语义等价**。
  2. **TS 5.7+ 泛型 TypedArray**：3 处 `new Blob([Uint8Array<ArrayBufferLike>])`
     触发 TS2322（升级 tsc ≥5.7 时同样会暴露，属真实前瞻性问题，非误报）。
- 按任务预案「错误与 tsc 不一致 → 只留报告」执行 docs-only；若现在提交
  `typecheck:native` script 会开箱即败，价值为负。

## 基线（tsc 5.6.3，项目锁定版本）

环境：Linux x86_64（Cloud Agent VM），4 vCPU / 15GiB RAM，Node v22.14.0，npm 10.9.7。
命令 `./node_modules/.bin/tsc --noEmit -p tsconfig.json`，工作树未预热缓存（tsc 无增量缓存，
`incremental` 未开启）。

| 运行 | wall | user | 结果 |
| --- | ---: | ---: | --- |
| run 1 | 44.1s | 55.9s | 0 error，exit 0 |
| run 2 | 51.2s | 58.3s | 0 error，exit 0 |
| run 3 | 52.8s | 57.4s | 0 error，exit 0 |

检查规模（`--extendedDiagnostics`）：7,211 files / 1,004,777 lines
（TS 源 625,751 行 + d.ts 292,959 行 + JSON 30,301 行）。

## spike 过程

1. `npm install -D @typescript/native-preview` → `^7.0.0-dev.20260707.2`
   （+2 packages，2s；`tsgo --version` = 7.0.0-dev.20260707.2，为 registry 最新版）。
2. 计划 script：`"typecheck:native": "tsgo --noEmit -p tsconfig.json"`。
3. 直接运行 tsgo → **0.9s 内 config error 退出（exit 1），未做任何类型检查**：

```text
tsconfig.json(10,5): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
  Use '"paths": {"*": ["./*"]}' instead.
tsconfig.json(12,15): error TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
```

4. 临时 patch `tsconfig.json`（删 `"baseUrl": "./"`；`"@/*": ["src/*"]` →
   `"@/*": ["./src/*"]`），先验证 patch 对 tsc 5.6 无行为变化：0 error（58.6s）。
5. patch 后 tsgo 三连跑 + 交叉验证 `npx -p typescript@5.9 tsc`（同 patch config）。
6. 全部 revert：`tsconfig.json` git checkout 还原；`npm uninstall @typescript/native-preview`
   还原 package.json/lock（同分支并行任务 SA-R3-03 的 `@vitejs/plugin-react-swc`
   依赖改动已确认不受影响）。

## 耗时与错误对比（patch config 后）

| 编译器 | 版本 | wall（3 runs） | 中位 | 错误 |
| --- | --- | --- | ---: | --- |
| tsc | 5.6.3（项目锁定） | 44.1 / 51.2 / 52.8s | 51.2s | 0 |
| tsc | 5.9.3（npx，参照组） | 61.5s（1 run） | — | 3 × TS2322 |
| **tsgo** | **7.0.0-dev.20260707.2** | **6.9 / 6.6 / 6.5s** | **6.6s** | **3 × TS2322（与 tsc 5.9 输出逐字节一致）** |

- 提速 **~7.8×**（中位 51.2s → 6.6s）。tsgo 多线程并行：user 17.4s / wall 6.6s ≈ 2.6×
  并行度（4 vCPU 上限），多核 CI runner / 开发机上绝对收益更大。
- tsgo 三次运行输出完全一致（diff 为空），无 flakiness。
- `diff <(tsc5.9 errors) <(tsgo errors)` 为空 ⇒ 3 个错误是 **TS 版本代差**而非 tsgo 缺陷。

`--extendedDiagnostics` 摘录（时间为含测量开销/跨线程累计值，只供相对参考，
不可与上表 wall time 直接比）：

| 指标 | tsc 5.6.3 | tsgo |
| --- | ---: | ---: |
| Types | 828,316 | 1,074,189 |
| Instantiations | 3,579,106 | 4,062,951 |
| Memory used | ~2.52 GB | ~2.19 GB |
| Check time | 112.5s | 23.3s |

## 错误 diff 分析（3 × TS2322，同一类）

`Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'`——TS 5.7 起
TypedArray 变为泛型 `Uint8Array<TArrayBuffer>`，且新 lib.dom 的 `BlobPart` 要求
`ArrayBufferView<ArrayBuffer>`（排除 `SharedArrayBuffer` 背书的视图）。三处位置与修法：

| 位置 | 现状 | 修复建议（tsc 5.6 双兼容） |
| --- | --- | --- |
| `src/utils/base64FileUtils.ts:99` | `new Blob([bytes])`，`bytes` 来自 `base64ToUint8Array` | 该函数显式注解返回 `Uint8Array \| null`，而运行时值是 `new Uint8Array(len)`（`ArrayBuffer` 背书）。**去掉显式返回注解**让推断在 5.7+ 给出 `Uint8Array<ArrayBuffer>`（5.6 下仍为 `Uint8Array`），两版本都过 |
| `src/utils/base64FileUtils.ts:125` | 同上（`base64ToBlob`） | 同上，随源头修复自然消除 |
| `src/features/learning-hub/apps/views/epubReaderModel.ts:305` | `new Blob([await file.async('uint8array')])`，JSZip 类型返回裸 `Uint8Array` | 局部 `as BlobPart`（或等 `jszip` 类型升级）|

定性：均为真实的前瞻性类型问题，未来升级 typescript ≥5.7 时同样会报，早修早受益。

## 建议（落地路径 → R4）

1. **tsconfig 微调**（仅根 `tsconfig.json` 含 `baseUrl`，strict/node 两个 config 不含）：
   删 `baseUrl`、`paths` 相对化。对 tsc 5.6 零行为变化（本次已实测），对编辑器无感。
2. **修 3 处 TS2322**（见上表，改动 ~3 行）。
3. **双 script 落地**：`npm i -D @typescript/native-preview` +
   `"typecheck:native": "tsgo --noEmit -p tsconfig.json"`。先在 CI 并行非阻塞跑一段时间
   观察一致性；稳定后把 PR gate/`prebuild` 的 typecheck 切到 tsgo，
   单次 typecheck 从 ~1 分钟降到 <10s（`prebuild` 里 typecheck 是纯前置串行项，直接缩短
   每次 `vite build` 的启动延迟）。
4. 长线：TS 7.0 正式发布后直接升级 `typescript` 依赖收编；开发侧可先用 VS Code
   「TypeScript (Native Preview)」插件提前吃到 LSP 提速。
5. 风险备忘：tsgo 仍是 preview（dev 版号），个别 checker/`--build` 边界仍在补齐——
   本项目 7,211 文件全量检查未触发任何与 tsc 5.9 的不一致，`-p` 单项目模式不涉及
   `--build`；建议双 script 并行期保留 tsc 作为权威 gate。

## 变更清单

| 文件 | 状态 |
| --- | --- |
| `package.json` / `package-lock.json` | spike 后已 revert（`npm uninstall`，并行任务 SA-R3-03 的 swc 依赖不受影响），无净变更 |
| `tsconfig.json` | 临时 patch 已 revert，无净变更 |
| `docs/dev/optimization0824/progress/R3-tsgo-spike.md` | 新增（本报告，唯一交付物） |
