# R4-ci-hygiene：R1–R3 CI 卫生债一次清完

> 子代理：SA-R4-07（模型 `claude-fable-5-thinking-xhigh`）
> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 前置：R1-apt-cache（ci.yml 模式）、R2-apt-nightly（nightly/gate 扩展）、
> R2-sccache-macos-windows（三平台 sccache）、R3-actionlint-review（36 条存量清单）、
> R3-bundle-baseline（+3% 新阈值）
> 状态：✅ 完成 —— **actionlint 全量 36 → 0 条**

## 0. TL;DR

一次提交清完五类 CI 卫生债：

1. `reusable-build-linux.yml` 的 apt 安装切到 `cache-apt-pkgs-action`
   （R1 清单最后一个未覆盖项，release 关键路径每次省 1–2 分钟）；
2. R3 存量清单的 **36 条 actionlint/shellcheck 全部修复**（不是"至少
   SC2086/SC2012"——SC2129、SC2002 也一并清了），复跑 actionlint **0 条**；
3. 过时注释改成现状（bundle 门禁 +5% → +3%、rebuild-android 的
   opt-level=1 → z）；
4. 三平台 release 构建的 sccache stats 步骤对齐 ci.yml 模式
   （`if: always()` + job summary + 日志双写）；
5. hotfix-linux / rebuild-android 与 frontend-dist artifact 的兼容性
   在调用点显式注释（为何有意走回退路径）。

## 1. apt 缓存补齐（reusable-build-linux.yml）

R1 报告"未覆盖（后续候选）"清单的第三项，也是最后一项。原状：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf rpm
```

替换为 R1/R2 已验证的两步模式（`awalsh128/cache-apt-pkgs-action`
v1.6.3，SHA pin `553a35bb…` 与 ci.yml / nightly / gate 完全一致，
`execute_install_scripts: true` + `ImageOS-ImageVersion` 镜像作用域）。
包列表逐字保留（**按文件实际内容**，与 ci.yml 的 5 包列表不同：release
打包额外需要 `libgtk-3-dev` / `libayatana-appindicator3-dev` / `rpm`，
不需要 `protobuf-compiler`——该 job 用 setup-protoc）。

两点与 ci.yml 不同、已在注释中写明：

- 本 job 跑在 **ubuntu-22.04**（非 ubuntu-latest），缓存 key = 包列表 +
  镜像标识 ⇒ 拥有**独立缓存条目**，不与 ci.yml 的 24.04 快照互相污染；
  首次 release/rebuild/hotfix run 冷装并保存，此后整周命中。
- fail-closed 语义与 migration gate 的论证一致：未命中时 action 内部
  执行真实安装，任何失败都让 step 红掉，不存在静默降级。

附带把 `Print build tool manifest` 的 actions 清单补上
`cache-apt-pkgs v1.6.3`（与 R2 对 migration gate 的诚实性修正同类）。

## 2. actionlint/shellcheck 36 条全部修复

环境：actionlint v1.7.12 + shellcheck v0.9.0（与 R3 复审完全一致，
基线复跑确认逐条相同的 36 条后再动手）。

| 规则 | 条数 | 修复方式 |
| --- | --- | --- |
| SC2086（变量未加引号） | 17 | `>> $GITHUB_OUTPUT`/`$GITHUB_ENV` 全部加引号；`${ANDROID_HOME}/…/sdkmanager` 调用加引号。release.yml ×7、reusable-build-android ×6（其中 4 条随重定向合并一起消除）、rebuild-android ×3（同）、upload-r2 ×1 |
| SC2012（用 find 替代 ls） | 16 | 两类：① `ls -lh … \| awk '{print $5}'` 打印体积 → `du -h --apparent-size … \| cut -f1`（6 处 pdfium：ci.yml ×4、linux、migration-gate；+1 处 android jniLibs）；② `ls dir/*.apk \| head -1` 选文件 / `ls \| wc -l` 计数 / `ls -d … \| sort -V` 选 build-tools → `find -maxdepth 1 … \| sort \| head -1` 等价物（rebuild-android ×4、reusable-publish ×2、upload-r2 ×2、reusable-build-android ×1） |
| SC2129（合并重定向） | 2 | rebuild-android 的 3 行 `GITHUB_OUTPUT`、reusable-build-android 的 4 行 `GITHUB_ENV` 改为 `{ …; } >> "$FILE"` 分组（同时消除其中 7 条 SC2086） |
| SC2002（无用 cat） | 1 | hotfix-linux-release 的 `cat file \| while read` → `while read … done < file` |

语义保持逐点核对过：

- `find … \| sort \| head -1` 保留了 `ls` 的排序确定性；无匹配时输出
  空串，与原 `\|\| echo ""` 兜底等价（本地空目录/有文件两个 case 实测）。
- `reusable-publish.yml` 的 `expected-assets.txt`（fail-closed 资产核对
  的期望清单）两侧本就都经 `sort`，改用 `find -printf '%f\n'` 后比较
  语义不变。
- `du -h --apparent-size` 与 `ls -lh` 同为 apparent size，仅用于日志。

## 3. 过时注释 → 现状

| 位置 | 原文 | 现状修正 |
| --- | --- | --- |
| `ci.yml` Bundle size check | "阈值 = 2026-08-24 基线 gzip +5%" | R3（SA-R3-06）已收紧：基线刷新至 commit `1bf03a24` 且 HEADROOM 1.05 → 1.03，注释改为 "+3%"，并写明阈值唯一事实源是 `scripts/check-bundle-size.mjs` 的 BUDGETS + HEADROOM。warn 模式时间表（~2026-09-07 转阻塞）不变 |
| `rebuild-android.yml` lean_recovery 注释 | "恢复构建改为始终使用正常 release profile（opt-level=1）" | WI-6 (R3) 起正常 profile 为 **opt-level=z / codegen-units=16**，注释已同步并指向 reusable-build-android.yml |

（顺带核查：workflow 内无 Babel 等其它已知过时提法。）

## 4. 三平台 sccache stats 一致性

原状：linux/macos/windows 三个 reusable-build 的 `Show sccache stats`
均为裸 `run: sccache --show-stats`——无 `if: always()`（编译失败时
恰恰最需要命中率诊断，却拿不到），也不进 job summary（与 ci.yml 的
5 个 Rust job 不一致）。

三平台统一升级为同一结构：`if: always()` + 输出同时写日志与
`GITHUB_STEP_SUMMARY`（标题分别为 `release linux-x86_64` /
`release ${{ matrix.target }}` / `release windows-x86_64`），失败时
显示 "sccache unavailable" 而非步骤红掉。Windows 步骤显式
`shell: bash`（默认 pwsh 跑不了该 heredoc 块，与 ci.yml
windows-shell-sandbox 同名步骤的做法一致）。

## 5. frontend-dist artifact 兼容性注释

`reusable-build-linux.yml` / `reusable-build-android.yml` 的
`frontend_dist_artifact` 输入描述早已写明回退路径，但两个独立
workflow 的**调用点**没有解释为何不传。现已在
`hotfix-linux-release.yml` (build-linux) 与 `rebuild-android.yml`
(build-android) 的 job 上方注明：GitHub Actions artifact 只在同一
workflow run 内可见，这两个 workflow 没有 build-frontend job，无法
引用 release.yml 那次 run 的 frontend-dist ⇒ 有意留空走回退路径
（beforeBuildCommand 在构建 job 内构建前端，门禁等价，只是慢一些），
防止后人"顺手补上 frontend_dist_artifact: frontend-dist" 造成
下载失败。

## 6. 验证

- `python3 yaml.safe_load`：11 个改动 workflow 全部解析通过。
- **actionlint v1.7.12（shellcheck v0.9.0 集成）全量：36 → 0 条，
  exit 0**。修复前先复跑基线，与 R3 报告清单逐条一致后才动手。
- shell 语义 smoke test：`find`/`du` 替换物在有匹配、无匹配、多文件
  三种情况下与原 `ls` 管道输出一致（含空串兜底）。
- 约束遵守：未动 frontend-checks matrix 结构、未动 typecheck/tsgo
  相关步骤（SA-R4-01 工作区）。

## 7. 边界与回滚

- apt 缓存改动完全局部于 1 个 step（替换回原 `run:` 两行即可回滚）；
  首个 release run 建议观察 `Install Linux dependencies (cached)` 的
  cache-hit 输出与后续 tauri build 是否正常链接（webkit2gtk 系）。
- 其余修复均为 shell 写法等价替换与注释，无行为变化。
- 剩余 actionlint 债：**0 条**。后续新 workflow 改动可直接以
  `/tmp/actionlint -no-color .github/workflows/*.yml` 零基线自证。
