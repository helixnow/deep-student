# WRAP-workflows：optimization0824 GitHub workflows 终检

> 子代理：SA-WRAP-WF
> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 状态：✅ 完成 —— actionlint 全量 **0 条诊断**

## 范围与工具

- 范围：仓库根目录 `.github/workflows/*.yml` 共 17 个有效 GitHub Actions
  workflow。vendor 目录内嵌的上游 `.github/workflows` 不会被本仓库 GitHub
  Actions 加载，不计入本仓库 workflow 集合。
- actionlint：v1.7.12（latest，源码构建，Go 1.26.7）。
- shellcheck：v0.9.0，已被 actionlint 调用。
- workflow 中没有 `shell: python` 步骤，因此未安装 pyflakes 不造成覆盖缺口。

## 全量 actionlint

执行：

```bash
actionlint -no-color .github/workflows/*.yml
```

结果：exit 0，诊断 0 条。YAML 解析、GitHub Actions 表达式、`needs`/outputs
引用、reusable workflow 输入以及内嵌 shellcheck 均无告警。终检开始时即为
零基线，因此本轮没有需要修改的 workflow，代码变更仅为本报告。

## 四项专项核对

### sccache

- 共 8 个安装点：`ci.yml` 5 个 Rust 编译 job，以及 Linux/macOS/Windows
  三个 release reusable workflow。
- 8 处均同时配置 `RUSTC_WRAPPER=sccache` 与 `SCCACHE_GHA_ENABLED=true`，
  且 setup 位于 cargo 编译前。
- 8 处均有 `if: always()` 的 stats 收尾；Windows 使用显式 bash。
- action 固定到同一完整 SHA（mozilla-actions/sccache-action v0.0.11）。

### apt 缓存

- 共 9 个 `cache-apt-pkgs-action` 安装点：`ci.yml` 5 个、
  `migration-nightly.yml` 2 个、`reusable-migration-gate.yml` 1 个、
  `reusable-build-linux.yml` 1 个。
- 每个安装点前均有 `ImageOS-ImageVersion` 的 `APT_CACHE_SCOPE` 解析步骤，
  并启用 `execute_install_scripts: true`。
- action 全部固定为 v1.6.3 的同一完整 SHA；Linux release 的额外打包依赖
  与 CI/迁移 job 的包集合保持有意隔离。

### frontend dist artifact

- `reusable-build-frontend.yml` 负责唯一一次构建、校验
  `dist/index.html`/无 sourcemap 泄漏，并以 `if-no-files-found: error`
  上传 `frontend-dist`。
- `release.yml` 与 `rebuild-release.yml` 均让四个平台 job 显式
  `needs: build-frontend`，共 8 个调用传入 `frontend_dist_artifact:
  frontend-dist`。
- Linux/macOS/Windows/Android reusable workflow 均条件下载并校验
  `dist/index.html`，随后覆盖 `beforeBuildCommand` 避免重复前端构建；
  Android 保留生成版本信息的 hook。
- `hotfix-linux-release.yml` 与 `rebuild-android.yml` 不存在同 run 的
  frontend artifact，故有意不传该输入并走就地构建回退路径。

### tsc + tsgo 双跑

- `ci.yml` 的 typecheck matrix leg 同时后台启动 `npx tsc` 与 `npx tsgo`。
- 两个 PID 都被独立 `wait`，退出码分别采集；任一非零都会使步骤退出 1，
  不存在 tsgo 失败被 tsc 成功掩盖的路径。
- 两份日志独立输出，YAML、bash 与 shellcheck 均通过 actionlint。

## 结论

- workflow 告警修复：无（终检初始即 0）。
- 剩余 actionlint 告警：**0**。
