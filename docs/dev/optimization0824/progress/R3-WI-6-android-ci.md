# R3-WI-6：Android CI 接入 mobile-slim + 收紧 release profile

> 子代理：SA-R3-02  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-6（Android mobile-slim；R2 已完成编译门控前置，本轮为 CI 落地）

## 任务范围

修改 `.github/workflows/reusable-build-android.yml`（release / rebuild-release /
rebuild-android 共用的唯一 Android 构建实现）：

1. 构建命令切换为 `--no-default-features --features mobile-slim`；
2. 在编译时间可控的前提下，release profile 由 `opt-level=1, cgu=128` 收紧为
   `opt-level=z, cgu=16`；
3. 保留 Sign APK 步骤的 250MB `.so` 体积守卫。

## feature 选择：mobile-slim（非 android-release 回退）

任务允许在 mobile-slim 未就绪时回退 `android-release`。读取 `Cargo.toml` 与
R2 报告（`progress/R2-WI-6-mobile-slim.md`）确认：R2（commit `64d60e81`）已修复
全部 50 个编译错误，`cargo check --no-default-features --features mobile-slim`
0 error 通过，且当前 HEAD 相对该 commit 仅叠加了文档改动。**mobile-slim 已就绪，
直接采用**。

相对 default 裁掉：`lance`（lancedb + arrow 系列，最大编译负担）、`mcp`、
`tokenizer_tiktoken`、`cloud_storage_s3`（aws-sdk-s3 + aws-config）。保留
`sqlite` / `builtin_free_models` / `data_governance`。

## 改动明细（仅 1 个 workflow 文件）

### 1. 构建命令统一为 mobile-slim（含 lean_recovery 路径）

原实现按 `lean_recovery` 分叉：正常路径 default features、恢复路径
`android-release`。现两条路径统一为：

```bash
npx tauri android build --target aarch64 --apk --ci "${CONFIG_ARGS[@]}" \
  -- --locked --no-default-features --features mobile-slim
```

lean_recovery 不再切换 feature 集的理由：应急重建只该改 cargo profile，
不该静默产出功能集不同的 APK——否则恢复构建会带回正常发布已裁掉的
lance/mcp/tiktoken，与「重建 = 同一产品、更快编译」的语义相悖。分叉消除后
if/else 收敛为单条命令，`lean_recovery` 仅剩 profile env 一处作用点。
`--locked` 保留（Cargo.lock 解析与 feature 选择无关，R2 的 check 已验证）。

### 2. release profile：opt-level=z / codegen-units=16

```yaml
CARGO_PROFILE_RELEASE_OPT_LEVEL: ${{ inputs.lean_recovery && '0' || 'z' }}
CARGO_PROFILE_RELEASE_CODEGEN_UNITS: ${{ inputs.lean_recovery && '256' || '16' }}
```

「编译时间可控」判断依据：cgu 128→16 与 opt-level 1→z 会增加单 crate 编译与
优化时间，但同轮切换的 mobile-slim 把 lance/arrow（此前最重的依赖树）、
aws-sdk、tiktoken 整体移出编译图，节省量级远大于 profile 收紧的开销；
120 分钟构建 timeout / 180 分钟 job timeout 的既有余量不变。收益侧：
opt-level=z 直接压 `.so` 体积——这正是 250MB 守卫要防的低内存设备
dlopen/重定位 OOM 风险面（v0.9.43 线上事故）；cgu=16 提升跨单元优化质量，
进一步利好体积。`LTO=false` / `DEBUG=0` / lean_recovery 的 `0/256` 快速
profile 均维持不变。`Print build tool manifest` 步骤直接回显这些 env，
无需另改。

### 3. rust-cache shared-key 更名

`release-android-aarch64` → `release-android-aarch64-mobile-slim`。旧缓存内
数百 MB 的 lance/arrow/aws 编译产物在新 feature 集 + 新 profile 下永远不会
命中 fingerprint，只会拖慢每次的缓存恢复与保存；换 key 从空白重建。

### 4. 保留项与注释同步

- **250MB 守卫原样保留**（`unzip -l` 提取 `libdeep_student_lib.so` 尺寸，
  超 262144000 字节拒绝签名发布），阈值与逻辑未动；
- `lean_recovery` input 描述更新（原文「禁用可选 S3」已过时——S3 现在
  两条路径都不编译）；文件头与相关步骤补 WI-6 (R3) 说明注释。

## 验证

| 检查 | 结果 |
| --- | --- |
| YAML 语法（`python3 -c yaml.safe_load`） | ✅ |
| `actionlint v1.7.10` 改动前后对比 | ✅ findings 完全一致（9 条存量 info/style 级 shellcheck 提示，均在本次未触碰的步骤中，归 SA-R3-10 的全 workflow 复审） |
| mobile-slim 可编译性 | ✅ 引用 R2 验证（`cargo check --no-default-features --features mobile-slim` 0 error，HEAD 相对已验证 commit 仅有文档改动）；Android target 全量构建需 NDK + 签名 secrets，本环境不可复现，由首次真实 CI run 验收 |

## 风险与后续

1. **首次真实 run 需记录两项数字**：总墙钟时间（对比此前 opt-level=1/cgu=128 +
   全 feature 基线）与签名 APK 内 `libdeep_student_lib.so` 尺寸（对比 ~116MB
   基线）。若 cgu=16 意外顶到 120 分钟 timeout，回退旋钮是先升 cgu（16→64），
   opt-level=z 保留。
2. **运行时语义**（R2 报告已列，非本轮范围）：mobile-slim 下语义搜索
   embedding 写入路径显式失败（`INDEX_STATE_FAILED`，不静默丢数据）；发布前
   建议补前端「语义搜索未启用」的提示与索引入口禁用。
3. `android-release` feature 定义保留在 `Cargo.toml`（不再被任何 workflow
   引用），待 mobile-slim 跑通若干版本后可评估删除。

## 提交

- commit：`ci(android): enable mobile-slim and tighten release profile`
- 变更：`.github/workflows/reusable-build-android.yml` + 本报告
