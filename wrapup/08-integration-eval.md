# Anki integration / eval 收尾检查（子代理 #8）

日期：2026-08-24

## 修复

- 补齐 `LLMManager` 的 Anki critic 角色路由适配层。critic 使用当前角色决策对应的已启用文本模型；配置在探测后失效时回退既有 Model2 路径，不阻断制卡收尾。
- 更新 Rust integration fixture 以匹配现行 fallible API：
  - `apply_transform_ops` 显式校验 `Result`；
  - `consolidate` 按切片契约传参。
- 修正 QA 重复卡 fixture 使用稳定规则码 `duplicate_in_document`。
- 为多模板 schema fixture 补齐 `AnkiGenerationOptions` 必填字段。
- 未修改生产切卡主逻辑。

## 验证

Rust 命令需在 `src-tauri` crate 目录执行。先按锁文件补齐 Cargo 缓存，并按 CI 流程准备未入库的 Linux PDFium 运行库；最终指定离线命令通过：

```bash
cargo test --test anki_ai_native_integration \
  --test anki_fsrs_feedback \
  --test anki_export_integration \
  --offline
```

结果：3 个 test targets、37 项测试全部通过（29 + 5 + 3），0 失败。

```bash
node scripts/anki-eval/run-eval.mjs
```

结果：33 个坏输出 fixture、11 个好卡 fixture、5 个金标修正对全部符合基线。

```bash
npx vitest run tests/vitest/anki/eval
```

结果：3 个测试文件、32 项测试全部通过，0 失败。

## 结论

指定 Rust integration、eval harness 与 eval Vitest 均为绿色；没有已知 integration/eval blocker。
