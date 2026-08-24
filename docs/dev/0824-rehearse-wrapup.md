# 0824 Theme A wrapup 合并预演

## 预演范围

- 基线：`origin/cursor/0824-cde6` @ `8361e6b7644df4bfa5374c2c51a3ff7251b60562`
- wrapup：`origin/cursor/0824-theme-wrapup-cde6` @ `1f8d9850d19262341c7804a7a226989b5c047262`
- tests：`origin/cursor/0824-theme-tests-cde6` @ `02a1d03a560a0c3b55982b4b7124641a00fbaaa3`
- 预演分支：`cursor/0824-rehearse-wrapup-cde6`
- 合并提交：wrapup 为 `19ff6bf2`，tests 为 `ae2ab047`

未改动、未推送 `cursor/0824-cde6`。

## 分支关系与合并策略

wrapup 与 tests 的 merge-base 是 `1306b85a`。从该点起，wrapup 有 20
个独有提交，tests 有 12 个独有提交；tests 不是当前 wrapup tip 的完整超集，
而是在 #268 底座上继续完成测试、文档和清理对齐。因此先完整合入 wrapup，
再合入 tests 分支；Git 实际只补入 tests 的 12 个缺失提交，没有重复引入
wrapup 历史，也没有另行 cherry-pick。

`.github/workflows/ci.yml`、`.github/workflows/migration-nightly.yml`、
`package.json`、`eslint.config.js` 和 `vitest.config.ts` 均自动合并。最终结构保留
#213 已拆分的 pipeline；wrapup 对 `llm_adapter.rs`、`multi_variant.rs`、
`tool_loop.rs`、`variant_adapter.rs` 以及 tools 层的修补在该结构上自动落入。
wrapup 的 i18n、a11y、UTF-8/流式处理、模型注册与 special-token 修复均保留。

## 冲突与解决

### 合入 wrapup

- `tests/vitest/question-bank-editor-ai-markdown.test.tsx`
  - 双方都把 grading hook 的 mock 回调提升到工厂作用域，以避免 effect 因
    `resetState` 身份变化无限重渲染。
  - 保留 0824 侧更完整的稳定 mock（含 `retryGrading`），合并双方注释表达的
    回归原因。

### 合入 tests

- `tests/vitest/chat-v2/context/fileDefinitionPdf.test.ts`
  - 保留 0824 当前 `FormatOptions` 的类型安全调用，不恢复过时的 `as any`。
  - 保留 tests 对显式 `text + image`、OCR 仍为 opt-in 的契约说明。
- `tests/vitest/settings/settingsQuietHoverContract.test.ts`
  - 接受 tests 新增的负向断言，确保已下线的
    `settingsMobileSheetCloseButtonClassName` 不再回流。
- `tests/vitest/ui-shell/smokeRender.test.tsx`
  - 保留 0824 从 `zh-CN/common.json` 读取 label 的写法，避免把“最小化”“返回”
    硬编码到测试；语义与 tests 分支一致。

## 验证结果

1. `npm ci`：通过；安装 1192 个包。npm 报告 12 个既有审计项
   （1 low、5 moderate、6 high），未运行会改锁文件的自动修复。
2. `npm run typecheck`：首次因 gitignored 的生成文件 `src/version.ts` 不存在而
   失败；按仓库/CI 既定流程运行 `npm run version:generate` 后重跑通过。
3. `npx vite build`：通过，19732 个模块完成转换。输出保留现有循环 chunk 与
   静态/动态重复导入警告，无构建错误。
4. `cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过。
   - 本机原 Cargo 1.83 无法解析锁定的 edition-2024 依赖
     `base64ct 1.8.3`，改用与 CI 一致的 stable（本次为 Cargo 1.98）。
   - 按 CI 安装 Linux Tauri 系统依赖，并运行
     `bash scripts/download-pdfium.sh linux-x64` 准备 gitignored 的
     `libpdfium.so` 后通过。
   - 最终有 22 个 Rust warning，无 error。
5. 冲突覆盖测试：
   `npx vitest run tests/vitest/question-bank-editor-ai-markdown.test.tsx tests/vitest/chat-v2/context/fileDefinitionPdf.test.ts tests/vitest/settings/settingsQuietHoverContract.test.ts tests/vitest/ui-shell/smokeRender.test.tsx`
   通过（4 files、9 tests）。

## 第四轮复查（0824，基于 fe71256a）

### 门禁复跑

在 `fe71256a` 上重新执行四项门禁与冲突覆盖测试，全部通过：
`npm run version:generate` + `npm run typecheck`、`npx vite build`（19732 模块）、
`cargo check --lib`（stable 1.98，22 warning / 0 error）、四个冲突覆盖测试
（4 files / 9 tests）以及 `useAIEditState.i18n.test.ts` + `notesEditHitl.test.tsx`。

### 0824 已推进，fast-forward 不再成立

`origin/cursor/0824-cde6` 已从预演基线 `8361e6b7` 推进到 `e54603a0`
（合入 theme-cache：#175+#183）。正式合入必须走 merge，不能 fast-forward。

### 预演分支已预对齐 useAIEditState（本轮新增提交）

模拟 `e54603a0` + 预演分支的合并，唯一内容冲突是
`src/features/notes/hooks/useAIEditState.ts`：双方把同一批硬编码错误文案
接到了不同 i18n 契约（0824 侧 `guardText` → `notes:aiDiff.errors.*`，
wrapup 侧 `i18n.t('learningHub:ai_edit.*')`）。0824 侧更优：keys 与 aiDiff UI
文案同域、en-US 有真实英文翻译（wrapup 侧 en 包注册的是中文），且带
延迟命名空间窗口期兜底。本轮已在预演分支上：

1. 将 `useAIEditState.ts` 对齐为 `e54603a0` 版本（逐字节一致，消除冲突）；
2. 把 `notes.json`（zh/en）的 `aiDiff.errors` 段补成与 0824 侧一致
   （保留 wrapup 的 `aiDiff.summary` 段）；
3. 把 `useAIEditState.i18n.test.ts` 源码契约断言改为
   `guardText → notes:aiDiff.errors.*`（行为守卫不变，中文文案逐字保留）；
4. 删除 `learningHub.json`（zh/en）中仅为旧契约服务的 `ai_edit` 死键段。

对齐后重新模拟合并：零冲突。

### ⚠️ 阻塞项：`e54603a0`（0824 当前 tip）自身编译不过

纯 `e54603a0` 的 `cargo check --lib` 失败（3 error），与预演分支无关，
是 theme-cache 合并（`e54603a0`）解 `model2_pipeline.rs` 冲突时引入：

- `server_side_web_search_enabled` 的签名取了 0824 侧
  `(quirks: &ProviderQuirks, llm_context)`，函数体却保留 cache 侧的
  `deepseek_model_supports_server_side_web_search(&config.model)`，
  `config` 不在作用域（E0423）；
- `use super::{...}` 导入块取了 0824 侧，丢了 cache 侧的
  `is_official_deepseek_config`，导致 `provider_accepts_prompt_cache_key` /
  `provider_accepts_prompt_cache_retention` 两处 E0425；
- `#[cfg(test)]` 内混用两侧传参风格（`resolve_quirks(&cfg)` 与直接
  `&ApiConfig`），`cargo test` / `--all-targets` 下还会再炸。

修复方向（须在 0824 上做，本分支未动）：函数签名并为
`(config: &ApiConfig, quirks: &ProviderQuirks, llm_context)`，函数体按
`e54603a0` 现有合并意图（quirks 门控 + DeepSeek 型号白名单 +
`web_search_enabled` 开关）；生产调用点（原 `(&quirks, context)` 两处）补传
config；`use super::{}` 补回 `is_official_deepseek_config`；tests 统一按新
签名重写。cache 侧原实现见 `e54603a0^2`（`9101aa0b`）:522-572 可对照。

## 正式合入注意事项

1. 正式分支应再次 fetch 并核对三个远端 tip；若 0824、wrapup 或 tests 已推进，
   先重新计算 merge-base 和独有提交，不能假设本次冲突集合仍完整。
2. chat_v2 冲突应以 #213 的 pipeline 拆分结构为骨架，逐块移植 wrapup 修补，
   不要用整文件 `ours`/`theirs` 覆盖；重点复核流结束、variant、tool loop 和
   模型 special-token 路径。
3. i18n locale 对、a11y label/role、流式 UTF-8、模型目录与 reasoning tier
   必须成组保留；测试冲突优先对齐当前实现，不恢复 `as any` 或硬编码文案。
4. 前端门禁前先运行 `npm run version:generate`。Linux Rust 门禁需使用 stable、
   CI 列出的 Tauri dev packages，并预下载目标平台 PDFium。
5. 正式合并后至少重跑本文四项编译门禁和四个冲突覆盖测试；对 Vite/Rust warning
   单独建后续清理，不应在正式合并时扩大改动面。
