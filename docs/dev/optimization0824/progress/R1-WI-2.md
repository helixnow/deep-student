# R1-WI-2：Windows release profile 对齐 macOS/Linux

> 子代理：SA-R1-02  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-2（P0 · Windows release profile 对齐）

## 问题

仓库 `src-tauri/Cargo.toml` 的 `[profile.release]` 为 `lto = "thin"` + `codegen-units = 1`，
是编译最慢的组合。macOS（`reusable-build-macos.yml`）与 Linux（`reusable-build-linux.yml`）
的 build job 均已用 env 覆盖为 `lto=false` + `codegen-units=16` 以缩短 hosted runner 上的
最终 rustc 阶段，唯独 Windows（`reusable-build-windows.yml`）没有任何覆盖，仍在用
Cargo.toml 的原始 profile 构建。

## 修改

文件：`.github/workflows/reusable-build-windows.yml`

1. **build job env 增加覆盖**（与 macOS/Linux 完全一致的两项）：

   ```yaml
   CARGO_PROFILE_RELEASE_LTO: 'false'
   CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16'
   ```

   附与 macOS 相同措辞风格的注释说明动机（bounded, reproducible release build）。

2. **manifest 打印步骤输出实际生效值**（照抄 macOS/Linux 模式，插在 `tauri-cli`
   与 `sentry-cli` 行之间）：

   ```bash
   echo "release profile : lto=${CARGO_PROFILE_RELEASE_LTO}, codegen-units=${CARGO_PROFILE_RELEASE_CODEGEN_UNITS}"
   ```

## 范围说明

- 仅覆盖 LTO 与 codegen-units 两项（任务指定范围）。macOS/Linux 另有随 Sentry secrets
  条件化的 `CARGO_PROFILE_RELEASE_DEBUG`（macOS 还有 `SPLIT_DEBUGINFO`）覆盖，Windows
  未加：Windows job 有无条件的 Sentry 符号上传步骤，保留 Cargo.toml 的
  `debug = 1` + `split-debuginfo = "packed"` 才能持续产出 PDB 供上传，行为不变。
- 产物语义影响：关闭 ThinLTO、拆成 16 个 codegen units 会略微增大二进制/降低微优化，
  与 macOS/Linux 发布产物的取舍一致（三平台 release 构建配置从此对齐）。

## 验证

- `python3 -c "import yaml; yaml.safe_load(...)"` — YAML 解析通过。
- 与 `reusable-build-linux.yml`（42-43 行）、`reusable-build-macos.yml`（61-62 行）
  逐行核对，覆盖键名与取值一致。
- CI 实际提速需在下次 release 构建观察（预期最终 rustc/link 阶段显著缩短）。

## 提交

- commit：`ci(windows): align release profile with macOS/Linux (no LTO, cgu=16)`
