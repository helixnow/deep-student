# Chat视觉与授权接入研究 — 2026-11-03

来源只读Explore agent_c167bdf2-70c4-4499-88fd-7e1fe74086b6。主agent归档；未经实际改动/验证，不视为完成。以下为推荐接口，Task6–8前需根据现状选择最小实现。

## 可信视觉产物

建议类型InkVisualArtifactRef固定artifact/render/session/tool_call/document/page/revision、source/source_annotation/conversion版本、crop、像素尺寸/MIME、resource_id/blob/content_hash。round_last_tool_call_id（或等效完整tool轮边界）用于确保跟随视觉消息在完整assistant+tool轮之后，不夹入并行工具结果中。

推荐独立类型字段而非从任意tool output JSON解析URL：`ToolResultInfo`/`MessageBlock`默认空ink_artifacts，持久化nullable ink_artifacts_json，前端Block带只读引用。只可信ink executor填充；上下文编译核对session/call/block/render、本地blob身份/内容hash。普通output/log不放base64，物质化仅请求组装。

实际路径：
- `dstu-core/src/agent.rs:131–173,293–359`；`dstu-agent/src/chat_v2/context.rs:850–875`结果转block。
- `repo.rs:1771–1827,1842–1904,1972–2059,2319–2362`及`tools/executor.rs:490–562`普通与crash-safe写入；新字段必须两路覆盖。
- 前端`chat/core/types/block.ts:21–55`、`core/store/restoreActions.ts:170–196`。

## live/history/variant与预算

复用检索图的本地解析/合法user image part/完整tool轮插入，不复制瞬态缓存作为历史机制。历史和live同一可信引用解析器。retrieval当前只有count和单图4MiB，不应虚称已有累计字节上限。

实际位置：retrieval_images.rs:141–183,332–365；tool_loop.rs:519–525,792–793,2281–2318；multi_variant.rs:1170–1217,1943–1960；history.rs:926–1044；multi_variant.rs:2460–2469复用history helper。

共享总image预算（含已组装历史/当前图片，见context_compiler/images.rs:11–57），ink/retrieval不能各发4图。2048长边、最多4图、每图4MiB及累计硬限，dedup按不可变artifact+revision。round anchor丢失/伪造必须fail closed，不能拆tool对。非视觉VISION_MODEL_REQUIRED，解析/注入IMAGE_DELIVERY_FAILED。

## 真实审批

仅sensitivity Medium不足。approval_scope.rs:210–223,289–357、tool_approval_policy.rs:117–142已有参数感知防宽泛bypass。ink update/remove对象按document_id+expected_revision+有序ops hash精确scope，never-remember。

authority_mode.rs:97–137的FullAccess/DangerFullAccess可绕普通审批；需ApprovalGateHook初始和执行前门（hooks.rs:679–736,757–767,932–949）显式must_confirm，并防Plan-binding/trusted automation绕过。保留approval_manager.rs:815–847的一次性批准约束。所有写入仍受明确意图限制，资料不能授予权限。

## 桥

canvas_executor.rs:66–118,130–220,1352–1516仅编辑器probe/apply参考，不是离屏ink renderer。canvas_handlers.rs:24–60只校非空request id，不能照抄为安全桥。新桥要可信主WebView回执、session/call/render/revision绑定、过期/重复拒绝、超时/取消清理、输入版本重验、RENDER_UNAVAILABLE。

## 必增测试

- approval_scope与tool policy具体精确范围；gate证明FullAccess/Plan/trusted automation仍要求破坏性一次审批。
- repo真实迁移DB字段往返（含crash-safe路径）、history live字节对齐、多variant恢复固定图、完整tool轮位置。
- 本地HTTP capture真实Provider请求，复用compaction.rs:2707–2794捕获模式，不以JSON URL证明视觉。adapter body参考providers/wave2_a_prefix_snapshot_tests.rs:116–128。
- count/bytes/dedup共享预算、伪造session/URL/引用拒绝，文本模型/缺blob失败。

尚未逐一读完Provider adapter；必须由主agent实测支持的Provider请求体，不以研究结论代替。
