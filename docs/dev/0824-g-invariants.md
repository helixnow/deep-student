# 0824 G 不变量总审

## 审计基线与结论

- 基线：`cursor/0824-rehearse-step6-fg-cde6` tip `1b2b50c5f`（当前最新且明确包含 G 的 0824 tip）。
- 修复分支：`cursor/0824-g-fix-invariants-cde6`。
- 基线初审发现第 10 项 FAIL：G tip 未包含 `leftovers-safe` 的 HPIAS 会话隔离、Rust 18 block allowlist 与完整 URL 消毒链。
- 已合入经验证的 `cursor/0824-leftovers-safe-cde6` tip `0aab5fd71`，修复提交为 `c61762077a`。最终 12 项均为 PASS。

## 逐项源码证据

1. **PASS — pipeline hooks / `GenerativeUiExecutor` 注册 / H prefix freeze**
   - `src-tauri/src/chat_v2/pipeline.rs:220-244` 在 pipeline 构造时安装 `default_pipeline_hooks()`；`pipeline.rs:299-348` 将 `GenerativeUiExecutor` 放入生产 executor registry。
   - `src-tauri/src/chat_v2/pipeline/hooks.rs:91-144` 定义四个真实切点，并默认注册 `ApprovalGateHook`、`TaskAuditHook`。
   - `src-tauri/src/chat_v2/pipeline/tool_loop.rs:30-130` 保留 H 的工具 schema 顺序 append-only freeze 与窗口内字节 freeze；`tool_loop.rs:320-347`、`3170-3274` 是生产调用点。
   - `src-tauri/src/chat_v2/pipeline/helpers.rs:1009-1080` 保留会话级 freeze 的加载、单调合并与持久化恢复。

2. **PASS — `utf8_stream` 有生产调用方，未被 hygiene 删除**
   - `src-tauri/src/llm_manager/utf8_stream.rs:1-104` 定义增量 `Utf8StreamDecoder`。
   - `src-tauri/src/utils/sse_buffer.rs:1` 导入该类型，`sse_buffer.rs:116-182` 在 `SseEventBuffer` 的字节入口实例化并调用 decoder。
   - `SseEventBuffer` 的生产调用方仍包括 `src-tauri/src/providers/mod.rs`、`src-tauri/src/llm_manager/model2_pipeline.rs`、`src-tauri/src/llm_manager/mod.rs`、`src-tauri/src/streaming_anki_service.rs`、`src-tauri/src/translation/pipeline.rs`、`src-tauri/src/qbank_grading/pipeline.rs`、`src-tauri/src/essay_grading/pipeline.rs` 与 `src-tauri/src/vlm_grounding_service.rs`。

3. **PASS — `model_special_tokens` 在，#200 旧实现未回流**
   - `src-tauri/src/utils/model_special_tokens.rs:1-180` 是当前保守、Markdown-aware、按 provider/model 启用的 `ModelWrapTokenPolicy` + `ModelWrapTokenStreamFilter` 实现。
   - `src-tauri/src/chat_v2/pipeline/llm_adapter.rs:198-257,1118-1147` 与 `variant_adapter.rs:23-55,419-438` 在两条生产流入口接入该过滤器。
   - #200 旧实现的标识 `SpecialTokenStreamStripper` 在 `src-tauri/src/chat_v2/**` 无定义、无引用；当前实现不会做无条件全局 token 替换。

4. **PASS — Generative UI 闪卡只读，无 save-to-library**
   - `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:7-55` 只渲染 front/back/tags/deckName，无按钮、handler 或持久化调用。
   - `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:1-37` 明确声明“只读闪卡预览”，持久化归 anki_cards 管线。
   - `src/features/generative-ui/blocks/index.ts:89-94` 仅注册 preview block；`src/features/generative-ui/**` 与两份 `generativeUi.json` 均无 `save_to_library` / `saveToLibrary`。

5. **PASS — 生产制卡走 `cardAgent.startGeneration`，无 `ChatV2AnkiAdapter` 生产引用**
   - `src/features/chat/services/selectionCardGeneration.ts:93-131` 的聊天划词入口直接调用 `cardAgent.startGeneration`。
   - `src/features/anki/generateCardsFromText.ts:38-57` 的共享入口同样直调该方法。
   - `src/components/anki/cardforge/engines/CardAgent.ts:399-440` 通过 `start_enhanced_document_processing` 非阻塞启动。
   - `src/**` 不存在 `ChatV2AnkiAdapter` 文件，也无 import/new/方法调用；现存字符串只在迁移说明或负向测试中描述已退役路径。

6. **PASS — 通用附件 200MB / 图片 50MB，未回流 #198**
   - `src/features/chat/core/constants.ts:173-191` 定义 `ATTACHMENT_MAX_SIZE=200MB`、`ATTACHMENT_IMAGE_MAX_SIZE=50MB`，并按媒体类型选限额。
   - `src/features/chat/resources/types.ts:257-271` 保持 `FILE_SIZE_LIMIT=200MB`、`IMAGE_SIZE_LIMIT=50MB`。
   - `src/features/chat/components/input-bar/InputBarUI.tsx:450-480` 与 `src/features/chat/components/AttachmentUploader.tsx:152-207` 在读入/上传前对图片收紧至 50MB，其他附件保持 200MB。
   - `src-tauri/src/vfs/repos/attachment_repo.rs:136-144` 后端同样为 50MB/200MB。不存在 #198 的“把图片入口也统一到 200MB”赋值。

7. **PASS — Finder 每宿主分桶，无 wrapup 共桶测试复活**
   - `src/features/learning-hub/stores/finderStore.ts:367-425` 声明全部 host id 与 bucket key；除兼容 `files -> default` 外，每个声明宿主解析到不同 bucket。
   - `finderStore.ts:1213-1245` 以 `Map<bucketId, store>` 注册，同宿主稳定、不同宿主隔离。
   - `tests/vitest/learning-hub/finder-host-buckets.test.ts:43-128` 锁定 page/page-mobile/canvas 等路径、搜索、选择与视图隔离；没有断言这些宿主共用全局 store 的 wrapup 回流测试。

8. **PASS — qbank-tools 描述压缩与 `daily_target` 并存**
   - `src/features/chat/skills/builtin-tools/qbank-tools.ts:159-838` 保留压缩后的 embedded tool descriptions 与完整 schema 约束。
   - `tests/vitest/chat-v2/token-budget.test.ts:128-210` 将精简后的单组预算锁在 6800 tokens（chars/4），防止描述膨胀回吃。
   - `qbank-tools.ts:737-750` 的打卡日历 schema 保留 `daily_target: 1..=50`；`src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3608` 校验并转发；`src-tauri/src/question_bank_service.rs:2837-2852` 以缺省 10 计算达标。

9. **PASS — cloud tombstone / WebDAV decode / S3 normalize / FTP 550 门槛**
   - `src-tauri/src/data_governance/sync/mod.rs:11120-11233` 提供 tombstone 前的 manifest 读取；`11792-11903` 先解析物理 `object_key`、保留共享引用，再传播删除。
   - `src-tauri/src/cloud_storage/webdav.rs:175-208,595-653` 对 base segment 与 PROPFIND href 在同一解码空间比较，避免双重编码和非 ASCII 路径丢失。
   - `src-tauri/src/cloud_storage/s3.rs:59-145` 仅对已知 provider 的 bucket-prefixed endpoint 做保守 normalize，自建/path-style 不猜改。
   - `src-tauri/src/cloud_storage/ftp.rs:239-314` 先解析 4xx/5xx 状态码，再要求 550/501 与明确 missing 语义同时满足；`ftp.rs:1300-1375` 锁定无状态码、权限型和歧义 550 均 fail-closed。

10. **PASS（修复后）— `leftovers-safe` HPIAS 隔离 / 18 block allowlist / URL sanitize**
    - `src/stores/researchStore.ts:100-185,241-264` 保留多 session slices；外会话事件只更新对应 slice，不覆盖活跃顶层状态。
    - `src/stores/hpiasSessionSlice.ts:1-219` 提供按 session 折叠、外会话拒绝与有界 slice 淘汰。
    - `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:19-119` 明列并校验 18 种允许 block，未知 type 在 Rust ingress 拒绝。
    - `src/features/generative-ui/utils/sanitizeGenerativeUrl.ts:1-58` 对 scheme、协议相对 URL、混淆控制字符与 data URI 做 allowlist；`sanitizeGenerativeMarkdown.ts:19-141` 删除 script/style/srcdoc/event handler，并覆盖 `href/src/srcset/ping/background` 等 URL 属性。

11. **PASS — 无 mythos-5 / haiku-5 虚构模型**
    - `src-tauri/src/llm_manager/builtin_vendors.rs:923-944` 内置 Anthropic 目录使用已核验型号；`1645-1692` 明确锁定 Haiku 4.5 并负向断言虚构 Haiku 5 / Mythos 不进入 catalog。
    - `src/utils/__tests__/apiCapabilityEngine.test.ts:105-128` 锁定 `claude-haiku-5` 无 registry 解析，官方 `claude-haiku-4-5` 可解析。
    - 生产 `src/**` 无 mythos-5 / haiku-5 模型条目；命中仅为负向守卫、注释或审计文档。

12. **PASS — `public/legal` NOTICES 保持删除，权威路径为 `legal/`**
    - `legal/THIRD_PARTY_NOTICES.txt` 是唯一跟踪的 NOTICES 文件；`public/legal/THIRD_PARTY_NOTICES.txt` 不存在。
    - `scripts/generate-third-party-notices.mjs:16` 与 `scripts/check-license-compliance.mjs:9-39` 均指向根目录 `legal/`。
    - `src-tauri/tauri.conf.json:62` 从 `../legal/THIRD_PARTY_NOTICES.txt` 打包到 resources；`vite.config.ts:75-88` 的 dev middleware 也读取同一权威文件。

## 验证

- `npm run version:generate && npm run typecheck`：PASS（`tsc --noEmit -p tsconfig.json`，0 error）。
- 定向 Vitest：PASS，11 files / 131 tests。覆盖 token budget、附件 200/50MB、Finder host buckets、HPIAS session slices、Generative UI Rust mapping/URL sanitize/SOTA 门禁、制卡生产路由与模型 registry 负向守卫。
