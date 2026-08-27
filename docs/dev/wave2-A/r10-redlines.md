# r10 红线 grep 自证（Wave2-A 第 10 轮 #5）

- 席位：#5（claude-fable-5-thinking-xhigh）
- 工作区：`/workspace`，分支 `cursor/0824-wave2-agent-cache-a875`（HEAD `659b8c54`）
- 基线：`origin/cursor/0824-cde6`（`061b4815`）
- 约束遵守：本轮零 npm/cargo/安装/测试/commit；本机 rustc 1.83，未运行任何构建或测试；以下全部为静态 grep / git 证据。
- 独占可写面：仅本文件。

## 结论总表

| # | 红线 | 判定 |
|---|------|------|
| 1 | `default_pipeline_hooks`：`ApprovalGateHook` vec 首元素，其后 `TaskAuditHook` | PASS |
| 2 | 测试 `default_hooks_keep_approval_gate_first` 仍在 | PASS |
| 3 | 测试 `preserves_literal_tokens_in_prose` 仍在且未被删 | PASS |
| 4 | `data_governance/migration/coordinator.rs` 对基线 diff 为空 | PASS |
| 5 | 无生产 `ChatV2AnkiAdapter`（测试/注释除外） | PASS |
| 6 | 无 `mythos-5` / `haiku-5` 真模型目录条目 | PASS |
| 7 | utf8_stream 探针在，且不声称修 #122 | PASS |
| 8 | `apply_openai_prompt_cache_retention` 函数不存在 | PASS |
| 9 | NOTICES 仍在 `legal/` | PASS |
| 10 | `cardAgent.startGeneration` 两入口仍在 | PASS |

---

## 1. `default_pipeline_hooks` 顺序 — PASS

```text
$ rg -n -A 5 'fn default_pipeline_hooks' src-tauri/src/chat_v2/pipeline/hooks.rs
159:pub(crate) fn default_pipeline_hooks() -> Arc<Vec<Arc<dyn PipelineHook>>> {
160:    Arc::new(vec![
161:        Arc::new(ApprovalGateHook) as Arc<dyn PipelineHook>,
162:        Arc::new(TaskAuditHook) as Arc<dyn PipelineHook>,
163:    ])
164:}
```

`ApprovalGateHook` 仍是 vec 首元素（:161），`TaskAuditHook` 紧随其后（:162）。

## 2. `default_hooks_keep_approval_gate_first` 测试仍在 — PASS

```text
$ rg -n -A 6 'fn default_hooks_keep_approval_gate_first' src-tauri/src/chat_v2/pipeline/hooks.rs
1517:    fn default_hooks_keep_approval_gate_first() {
1518:        let names = default_pipeline_hooks()
1519:            .iter()
1520:            .map(|hook| hook.name())
1521:            .collect::<Vec<_>>();
1522:
1523:        assert_eq!(names, ["approval_gate", "task_audit"]);
```

顺序守卫测试源码原样在位（:1517-1523），断言仍是对完整钩子名向量的精确相等。

## 3. `preserves_literal_tokens_in_prose` 仍在 — PASS

```text
$ rg -n -A 7 'fn preserves_literal_tokens_in_prose' src-tauri/src/utils/model_special_tokens.rs
691:    fn preserves_literal_tokens_in_prose() {
692:        let prose = "请解释 <|im_end|> 的含义；<|begin_of_box|> 也可能是用户正文。";
693:        assert_eq!(filter_chunks(&[prose]), prose);
694:        assert_eq!(
695:            filter_chunks(&["这一行以字面量 <|im_end|> 结尾"]),
696:            "这一行以字面量 <|im_end|> 结尾"
697:        );
698:    }
```

负例测试在 `model_special_tokens.rs:691`，正文两条断言均未改动。

## 4. `coordinator.rs` 对基线 diff 为空 — PASS

```text
$ git fetch origin cursor/0824-cde6   # 已拉到 061b4815
$ git diff origin/cursor/0824-cde6 -- src-tauri/src/data_governance/migration/coordinator.rs | wc -l
0
$ git diff --stat origin/cursor/0824-cde6 -- src-tauri/src/data_governance/migration/coordinator.rs
（无输出，exit=0）
```

该文件全会话零触碰，对基线 `061b4815` 的 diff 为空。

## 5. 无生产 `ChatV2AnkiAdapter` — PASS

```text
$ rg -n --glob '!__tests__' --glob '!*.test.*' \
    "(import[^;]*ChatV2AnkiAdapter|new\s+ChatV2AnkiAdapter|ChatV2AnkiAdapter\()" src/ src-tauri/src/
（零命中，rg exit=1）
```

同时用 glob 全仓搜 `*ChatV2AnkiAdapter*` 文件名：0 个文件——不存在同名模块文件（防改名/复制回潜）。
剩余字符串命中全部为注释或负向测试，例如：

- `src/features/chat/services/selectionCardGeneration.ts:10`（历史版本说明注释）
- `src/features/anki/generateCardsFromText.ts:49`（"不依赖已退役的 ChatV2AnkiAdapter" 注释）
- `src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts:49`（`describe('ChatV2AnkiAdapter stays retired', ...)` 负向测试）
- `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`（`not.toContain('ChatV2AnkiAdapter')`）

## 6. 无 `mythos-5` / `haiku-5` 真模型目录条目 — PASS

```text
$ rg -n -i 'mythos-5|haiku-5' src-tauri/src/
src-tauri/src/llm_manager/builtin_vendors.rs:925:    // 注意：官方最新 Haiku 仍为 4.5，不存在 claude-haiku-5。
src-tauri/src/llm_manager/builtin_vendors.rs:1686:  .any(|m| m.model.contains("claude-haiku-5") || m.id.contains("claude-haiku-5")),
src-tauri/src/llm_manager/builtin_vendors.rs:1687:  "fabricated `claude-haiku-5` must not enter the builtin catalog"
src-tauri/src/llm_manager/adapters/anthropic.rs:60:   （代际判定容错的 doc 注释）
src-tauri/src/llm_manager/adapters/anthropic.rs:509,592,763,778:（均在 :483 起的 #[cfg(test)] mod tests 内）
```

- `builtin_vendors.rs` 中两处命中：一处注释（:925）、一处**负向守卫测试**（:1682-1687，断言编造 ID 不得进入内置目录）——目录本体无条目。
- `anthropic.rs` 的 `claude-mythos-5` 命中：:60 是代际判定函数的 doc 注释（说明对未来/未知 ID 的容错行为），:509/:592/:763/:778 全部位于 `#[cfg(test)] mod tests`（:483 起）内部，属代际判定容错测试，非目录条目。
- 前端 `src/` 命中仅 3 个测试文件，其中 `src/utils/__tests__/apiCapabilityEngine.test.ts:121-123` 是负向断言：`findModelRecordById('claude-haiku-5')` 必须为 `undefined`。

## 7. utf8_stream 探针在、不声称修 #122 — PASS

```text
$ rg -n 'utf8_stream' src-tauri/src/
src-tauri/src/utils/sse_buffer.rs:6:use crate::llm_manager::utf8_stream::Utf8StreamDecoder;
src-tauri/src/llm_manager/utf8_stream.rs:81:  "[utf8_stream][issue#122 探针] 遇到非法 UTF-8 字节序列，已替换为 U+FFFD：..."
src-tauri/src/llm_manager/utf8_stream.rs:114: "[utf8_stream][issue#122 探针] flush 时仍有不完整多字节序列，按 lossy 语义替换为 U+FFFD：..."
src-tauri/src/llm_manager/mod.rs:9:pub mod utf8_stream;
```

模块文档原文（`utf8_stream.rs:3-4`）：

```3:4:src-tauri/src/llm_manager/utf8_stream.rs
//! 注：本文件包含 issue #122 定位探针（invalid 分支的 log::warn，仅记录长度类
//! 元数据，不记录任何 chunk/用户文本内容），不声称修复 #122。
```

两处探针（:81、:114）均为仅记长度元数据的 `log::warn`，措辞明确为「定位探针」且文件头明写「不声称修复 #122」。

## 8. `apply_openai_prompt_cache_retention` 不存在 — PASS

```text
$ rg -n 'fn (apply_openai_prompt_cache_retention|provider_accepts_prompt_cache_retention)' src-tauri/src/
（零命中，rg exit=1）
$ rg -n 'apply_openai_prompt_cache_retention' src-tauri/src/
src-tauri/src/llm_manager/model2_pipeline.rs:3588:// P6 裁决（R5 #1）：`apply_openai_prompt_cache_retention` /
```

函数定义全仓不存在；唯一命中是 `model2_pipeline.rs:3588-3597` 的 P6 裁决留痕注释（记录删除原因与未来接线硬约束：仅官方 OpenAI 端点、仅 `ttl:"30m"`、禁 24h），非代码。

## 9. NOTICES 仍在 `legal/` — PASS

`legal/THIRD_PARTY_NOTICES.txt` 在位（glob `legal/*` 命中）。

## 10. `cardAgent.startGeneration` 两入口仍在 — PASS

```text
$ rg -n 'cardAgent\.startGeneration' src/
src/features/chat/services/selectionCardGeneration.ts:121:    const result = await cardAgent.startGeneration({
src/features/anki/generateCardsFromText.ts:50:    const result = await cardAgent.startGeneration({
```

两个生产入口：聊天划词制卡 `selectionCardGeneration.ts:121`、共享文本入口 `generateCardsFromText.ts:50`；均由 `cardGenerationSurfaces.source.test.ts`（:25-:34）的源码级测试锁定。
