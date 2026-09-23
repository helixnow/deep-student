# 2026-09-23 用户决策记录

> 上下文见 [2026-09-23-model-adaptation-and-mcp-analysis.md](./2026-09-23-model-adaptation-and-mcp-analysis.md)

## 用户选择

- **问题 1（MCP）**：选项 ①——全局开关 `mcp.stdio.allowUnapproved`
  - 默认 `false`，走严格批准门
  - `true` 时跳过 `validate_stdio_start_against_entries`，任何 `(command, args, env, cwd, framing)` 直接 spawn
  - 配套防护：设置 UI 红色危险区、持久化 secure store、`log::warn!` 记录每次 spawn 完整参数、应用启动时若开关为 true 打警告横幅（可选）
- **问题 2（Qwen 思考强度）**：组合 2A + 2B + 2C
  - 2A：前端新增 `qwen-effort` kind，暴露 enable_thinking toggle + thinking_budget 三档预设（低/中/高）
  - 2B：内置 Qwen 模型补默认 `thinking_budget` / `enable_thinking`
  - 2C：`ApiConfig` 加 `extra_body` 通用自定义参数逃生口，UI 提供 key-value 编辑器

## 同时附加实施

- 1A：环境白名单扩充（SYSTEMDRIVE / ProgramData / NVM_* / VOLTA_HOME / FNM_DIR / NODE_PATH / 代理变量等）
- 1C：诊断日志增强（spawn 前打完整 cmd、spawn 失败打 OS errno、stdout 前 1KB 预览）

## 构建要求

- 串行构建 Windows + Android 包，不并发
- 安卓版本必须完整（不用 mobile-slim 裁剪），保留全部功能
- 每次功能改动跑测试验证后再进入下一步，避免问题累积

---

## 实施结果（2026-09-23 完成）

### 交付物

| 包 | 路径 | 大小 | SHA256 |
|---|---|---|---|
| Windows NSIS | `build-windows/Deep Student_0.9.64_x64-setup.exe` | 51M | `62fda543…d3970` |
| Android APK (完整版) | `build-android/DeepStudent-v0.9.64-arm64-full-dev.apk` | 152M | `4d3c655a…5ce25` |

### 测试结果（每个功能均验证通过后进入下一步）

| 功能 | 测试 | 结果 |
|---|---|---|
| 1C MCP 诊断日志 | `mcp::global::tests::test_spawn_failure_error_contains_diagnostics` | ✅ |
| 1A 环境白名单 | `test_minimal_child_env_keys_includes_dev_toolchain_and_proxy` | ✅ |
| 选项① 开关 | `read_mcp_allow_unapproved_defaults_false_and_parses_true_case_insensitive` | ✅ |
| 2C extra_body | `test_extra_body_merges_without_overwriting_existing_fields` + `test_extra_body_none_is_noop` | ✅ |
| 2A Qwen 思考强度 | `deepseekReasoningControls.test.ts` 95/95（含 12 个新 Qwen 用例） | ✅ |
| 2B 内置 Qwen 默认 | `modelCapabilities.test.ts` 33/33（含 15 个新 Qwen 用例） | ✅ |
| 受影响模块联合回归 | 26 个测试跨 mcp/llm_manager/cmd 全通过 | ✅ |
| 前端 utils vitest | 274/274 | ✅ |

### Android 完整版 feature 集（与官方 mobile-slim 差异）

- 官方 mobile-slim：`sqlite + builtin_free_models + data_governance`（裁 lance/mcp/tokenizer/s3）
- 本版完整版：`sqlite + lance + mcp + tokenizer_tiktoken + builtin_free_models + data_governance`
- 仅裁 `cloud_storage_s3`（官方文档明确 Android 不支持，运行时返回 `E_S3_UNSUPPORTED_IN_BUILD`）
- `lib/arm64-v8a/libdeep_student_lib.so` 151MB（对比官方 ~120MB），证明 lance/arrow/tokenizer/mcp 都打包进去了

### 踩坑记录（RULES.txt 第 7 条）

1. **`npm run build` 在 Android 构建的 beforeBuildCommand 阶段 heap OOM** —— 必须 `export NODE_OPTIONS="--max-old-space-size=8192"`（命令行 `node …` 方式不会传给子进程）
2. **`cargo tauri` 子命令未安装** —— 用 `npx tauri build`（或 `npx @tauri-apps/cli android build`），不要用 `cargo tauri …`
3. **`scripts/build_windows.sh` 是 macOS 交叉编译脚本**，不能在 Windows 主机用；Windows 原生构建直接 `npx tauri build --config '{"bundle":{"targets":["nsis"]}}'`
4. **`generate-version.mjs` 需要 `DEEP_STUDENT_BUILD_NUMBER=14639` 显式设置**，否则报"HEAD must descend from build baseline"
5. **`build-env.sh` 里 `CARGO_HOME`/`RUSTUP_HOME` 路径过时**，指向 `/e/yysls/tools/`，实际在 `/e/yysls/deepstudent/tools/`，构建前需手动覆盖
6. **Android 构建结束后 APK 未签名**，需要手动用 `apksigner.bat sign --ks dev-release.keystore --ks-key-alias deepstudent-debug --ks-pass pass:android --key-pass pass:android` 签名
7. **Qwen 分支优先级**：在 `resolveDeepSeekRuntimeReasoningControl` 里 Qwen 混合思考必须放在 SiliconFlow 分支**之前**，否则 vendor 前缀（Qwen/Qwen3-…）会被 SiliconFlow 错误地分到 `v32-budget-effort`
8. **`GenericOpenAIAdapter::apply_common_params` 覆盖默认实现** —— 给 trait 默认实现加 `extra_body` 不够，必须同步改 `generic_openai.rs` / `ernie.rs` / `grok.rs` / `minimax.rs` / `mistral.rs` 五个 override；最干净的做法是抽出 `merge_extra_body` helper 让所有 override 末尾调用一次
