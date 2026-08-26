model=gpt-5.6-sol

# 模型注册表防虚构条目审计

审计基准：`origin/cursor/0824-cde6`（本地远端跟踪引用 `362dd2df`）。本报告把结构化 `model_id`、`provider_model_id` 及 `BuiltinModel.id/model` 视为真实条目；说明文字、负向断言和测试输入不算真实条目。

## 证据

- `scripts/model-capability-registry.json:4` 明确说明 `claude-haiku-5` 因官方未发布而不收录；全文件结构化 Haiku 条目只有 `scripts/model-capability-registry.json:837-838` 的 `claude-haiku-4-5` / `claude-haiku-4-5-20251001`。`scripts/model-capability-registry.json:861` 对 `claude-haiku-5` 的命中只是未发布说明，不是模型记录。
- `scripts/model-capability-registry.json` 没有任何 `mythos` 命中，因此不存在 `mythos-5` 真实条目。
- `src-tauri/src/llm_manager/builtin_vendors.rs:202` 的 Anthropic 供应商说明列出的 Haiku 型号是 `claude-haiku-4-5`；实际内置模型位于 `src-tauri/src/llm_manager/builtin_vendors.rs:959-969`，其 `id` 为 `builtin-claude-haiku-4-5`，`model` 为 `claude-haiku-4-5`。
- `src-tauri/src/llm_manager/builtin_vendors.rs:1681-1692` 对 `claude-haiku-5` 和 `mythos` 仅作负向目录断言，并正向锁定 `claude-haiku-4-5`；这些字符串不构成被下发的模型条目。

## 结论

**PASS**：模型能力注册表和内置模型目录均无 `mythos-5`、`claude-haiku-5` 真实条目；`builtin_vendors` 实际 Haiku 型号为 `claude-haiku-4-5`。现状无需产品修复，本轮不改代码。
