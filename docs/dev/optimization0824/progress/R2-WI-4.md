# R2-WI-4：Release 前端 dist 一次构建、多平台复用

> 子代理：SA-R2-01  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-4（P0 · Release 前端一次构建）

## 问题

release / rebuild 的 5 个平台构建 job（macOS aarch64、macOS x86_64、Windows、
Linux、Android）各自执行 `npx tauri build`，其 `beforeBuildCommand`
（`npm run build` = `version:generate` + `licenses:check` + `typecheck` +
`vite build`）把同一份纯 Web 前端重复构建 5 遍。dist 与目标平台无关
（vite `base: './'`、无平台条件编译），本地实测一遍完整 `npm run build`
约 2 分钟（vite 构建 72s + typecheck/licenses），即每次发版浪费约 10
分钟计费机时，且在最慢的 macOS Intel / Android 关键路径上各占约 2 分钟。

## 方案

### 新增 `reusable-build-frontend.yml`

- release.yml / rebuild-release.yml 共用（沿用本仓库"构建实现只写一份"的
  reusable 约定，避免两处 job 定义漂移）
- ubuntu-22.04：checkout tag（`fetch-depth: 0`，`generate-version.mjs` 需从
  `BUILD_NUMBER_BASE_COMMIT` 计数提交）→ `npm ci` → `npm run build` →
  校验 dist（index.html 存在 + **零 .map 泄漏**，fail-closed）→ 上传
  artifact `frontend-dist`（upload-artifact v7.0.1，`if-no-files-found: error`）
- 门禁不减：`prebuild`（version:generate + licenses:check + typecheck）照常
  执行一次，等价于原先每平台各跑一遍；`licenses:check` 为纯 Node 校验
  （lockfile 哈希 + 已安装包许可证），无需 Rust 工具链

### 调用方（release.yml / rebuild-release.yml）

- 新增 `build-frontend` job，`needs: [verify]` —— 与迁移兼容性门禁
  （~20 分钟）**并行**，不增加关键路径
- 四个 build job 增加 `needs: build-frontend` 并传
  `frontend_dist_artifact: frontend-dist`
- fail-closed 语义保持：build-frontend 失败 → 平台 build 全部 skipped →
  publish 的 `needs.build-*.result == 'success'` 条件不满足 → 不发布

### 各 `reusable-build-*`（4 个平台）

- 新增可选输入 `frontend_dist_artifact`（默认 `''`）。**留空走原路径**
  （hook 内构建前端），`hotfix-linux-release.yml` / `rebuild-android.yml`
  两个未传参的调用方行为完全不变
- 传入时：download-artifact v8.0.1 下载到 `dist/` → 校验 `dist/index.html`
  → 构建命令追加 `--config '{"build":{"beforeBuildCommand":""}}'`
- 空字符串 hook 的语义已核对 tauri-cli 2.11.2 源码
  （`helpers::run_hook`：`HookCommand::Script(s) if s.is_empty() => (None, None)`），
  即直接跳过，不会 spawn 空命令；`--config` 内联 JSON 合并同样支持
  `tauri build` 与 `tauri android build`
- Windows 的 Build 步骤显式 `shell: bash`（数组安全展开 CONFIG_ARGS；该
  workflow 已有 `npx tauri signer sign` 在 bash 下运行的先例）

### Android 特殊处理（versionCode 保真）

`tauri android build` 在运行 beforeBuildCommand **之前**会先调用
`generate_tauri_properties` 用 `tauri.conf.json` 的静态
`bundle.android.versionCode` 重写 `gen/android/app/tauri.properties`；
原流程靠 hook 里 `npm run build` 的 prebuild（`version:generate`）把
生成器计算的稳定 versionCode（`ANDROID_VERSION_CODE + 版本序号差`）写回
——release-please 只 bump 版本号、不 bump 生成器常量，两者在跨版本时会
不一致，该回写是**承重的**。因此 Android 的覆盖不是置空，而是
`--config '{"build":{"beforeBuildCommand":"node scripts/generate-version.mjs"}}'`：
保留生成器在同一 hook 时机执行（行为与原先逐字节一致），只跳过昂贵的
licenses:check + typecheck + vite build。

### SENTRY_UPLOAD_SOURCEMAPS / SENTRY_RELEASE（任务项 4）

- 原先前端 sourcemap 只由 **Linux** job 上传（唯一设置
  `SENTRY_UPLOAD_SOURCEMAPS=1` 的平台）。现收敛到 build-frontend：安装
  pinned sentry-cli 2.58.6，`SENTRY_UPLOAD_SOURCEMAPS=1` 时
  `vite.config.ts` 的 `sentrySourceMapUploadPlugin` 生成 hidden sourcemap
  → inject/upload → 无论成败删除 `.map`；仍然**只上传一次**
- `SENTRY_RELEASE` 命名（`scripts/generate-version.mjs`）：
  `${appVersion}+${buildNumber}.${gitRevision}`，三个分量全部由 tag commit
  推导（package.json 版本、baseline 起提交计数、HEAD 完整 SHA）。
  build-frontend 与各平台 job checkout 同一 tag（`fetch-depth: 0`），故与
  Rust 侧 `build.rs` 注入产物的 `SENTRY_RELEASE` 及
  `upload-sentry-symbols.sh`（native symbols，仍留在各平台）逐字节一致，
  无需跨 job 传递
- Linux job 保留 `SENTRY_UPLOAD_SOURCEMAPS` 环境变量：预构建 dist 路径下
  vite 不运行、天然 inert；hotfix 回退路径（hook 内构建）沿用原上传行为
- `VITE_SENTRY_DSN`（前端运行时 DSN，`src/main.tsx` 经 `import.meta.env`
  读取）随 vite 构建移入 build-frontend；`SILICONFLOW_BUILTIN_*` /
  `SENTRY_DSN` 为 Rust 侧 `option_env!`/`build.rs` 消费，留在平台 job

### publish 防污染

`reusable-publish.yml` 的 Download all artifacts 会拉取本 run 全部
artifact，随后 Collect release files 按扩展名 glob 收集 —— 新增一步
`rm -rf artifacts/frontend-dist`，确保中间产物永远不可能混入发布资产。

## 修改清单

| 文件 | 变更 |
| --- | --- |
| `.github/workflows/reusable-build-frontend.yml` | 新增：前端一次构建 + Sentry sourcemap 上传 + dist artifact |
| `.github/workflows/release.yml` | 新增 build-frontend job；4 个 build job 接线 |
| `.github/workflows/rebuild-release.yml` | 同上 |
| `.github/workflows/reusable-build-linux.yml` | 输入 + 下载/校验 dist + `--config` 置空 hook + Sentry 注释 |
| `.github/workflows/reusable-build-macos.yml` | 输入 + 下载/校验 dist + `--config` 置空 hook |
| `.github/workflows/reusable-build-windows.yml` | 输入 + 下载/校验 dist + `--config` 置空 hook + Build 步骤 `shell: bash` |
| `.github/workflows/reusable-build-android.yml` | 输入 + 下载/校验 dist + `--config` 覆盖 hook 为 `node scripts/generate-version.mjs` |
| `.github/workflows/reusable-publish.yml` | 丢弃 frontend-dist 中间 artifact |

## 验收结果

| 检查 | 结果 |
| --- | --- |
| YAML 解析（全部 17 个 workflow） | 通过 |
| `actionlint`（8 个改动文件） | 通过（shellcheck 报告项均为既有代码的 info/style 级，非本次改动） |
| 本地 `npm run build`（= build-frontend job 主体） | 通过：prebuild 门禁 + vite 72s，dist 1214 文件 / 40MB |
| dist 校验 | `index.html` 存在；`.map` 0 个；隐藏文件 0 个 |
| `generate-version.mjs --print-sentry-release` | `0.9.44+14656.4092c761…`（命名链路正常） |
| tauri-cli 2.11.2 行为核对 | 空 hook 跳过（`run_hook` 源码）；`tauri build`/`tauri android build` 均支持 `--config` 内联 JSON；`generate_tauri_properties` 先于 hook 执行（Android 覆盖方案的依据） |

## 预期收益

- 每次 release：省去 4 次重复的 `npm run build`（macOS×2 / Windows /
  Android；Linux 的一遍移到更便宜且并行的 ubuntu job），约 8-10 分钟
  计费机时；macOS Intel / Android 关键路径各缩短约 2 分钟
- 五个平台安装包内嵌**同一份字节级一致**的前端资产（此前各平台独立
  构建，chunk hash 可能因环境差异漂移）

## 兼容性说明

- `hotfix-linux-release.yml`、`rebuild-android.yml` 未传新输入 → 完全走
  原路径，零行为变化
- `frontend_dist_artifact` 输入为可选，reusable workflow 的既有调用方
  无需同步升级
